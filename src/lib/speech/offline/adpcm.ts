// IMA ADPCM, 4 bits a sample: 12 KB per second of speech against 48 KB for
// 16-bit PCM, which is the difference between a book fitting in storage and
// not. It is a few dozen lines, needs no browser codec (WebCodecs audio is
// not reliably there on iOS), and is plenty for speech.
//
// The one thing that breaks it: the stream is stateful. Each sample is coded
// as a step from the last, and the decoder starts from predictor 0, index 0
// with no headers stored, so a clip must be decoded from its first byte.
// That is fine because a clip is a whole sentence and is only ever played whole.

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_DELTA = [-1, -1, -1, -1, 2, 4, 6, 8];

// Shared by both directions so the encoder's predictor can never drift from
// the decoder's; the clamps are what keep a sudden loud onset from wrapping.
function advance(pred: number, index: number, nibble: number): [number, number] {
  const step = STEPS[index];
  let diff = step >> 3;
  if (nibble & 4) diff += step;
  if (nibble & 2) diff += step >> 1;
  if (nibble & 1) diff += step >> 2;
  pred += nibble & 8 ? -diff : diff;
  if (pred > 32767) pred = 32767;
  else if (pred < -32768) pred = -32768;
  index += INDEX_DELTA[nibble & 7];
  if (index < 0) index = 0;
  else if (index > 88) index = 88;
  return [pred, index];
}

export function encodeAdpcm(samples: Int16Array): Uint8Array {
  const out = new Uint8Array((samples.length + 1) >> 1);
  let pred = 0;
  let index = 0;
  for (let i = 0; i < out.length * 2; i++) {
    const s = i < samples.length ? samples[i] : 0;
    const step = STEPS[index];
    let diff = s - pred;
    let nibble = 0;
    if (diff < 0) {
      nibble = 8;
      diff = -diff;
    }
    if (diff >= step) {
      nibble |= 4;
      diff -= step;
    }
    if (diff >= step >> 1) {
      nibble |= 2;
      diff -= step >> 1;
    }
    if (diff >= step >> 2) nibble |= 1;
    [pred, index] = advance(pred, index, nibble);
    if (i & 1) out[i >> 1] |= nibble << 4;
    else out[i >> 1] = nibble;
  }
  return out;
}

export function decodeAdpcm(bytes: Uint8Array, sampleCount: number): Int16Array {
  const out = new Int16Array(sampleCount);
  let pred = 0;
  let index = 0;
  for (let i = 0; i < sampleCount; i++) {
    const b = bytes[i >> 1];
    [pred, index] = advance(pred, index, i & 1 ? b >> 4 : b & 15);
    out[i] = pred;
  }
  return out;
}

export function decodeAdpcmToFloat(
  bytes: Uint8Array,
  sampleCount: number,
  out: Float32Array,
  offset: number,
): void {
  let pred = 0;
  let index = 0;
  for (let i = 0; i < sampleCount; i++) {
    const b = bytes[i >> 1];
    [pred, index] = advance(pred, index, i & 1 ? b >> 4 : b & 15);
    out[offset + i] = pred / 32768;
  }
}
