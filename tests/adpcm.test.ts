import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeAdpcm,
  decodeAdpcmToFloat,
  encodeAdpcm,
} from "@/lib/speech/offline/adpcm";

const RATE = 24000;

function sine(seconds: number, amp = 0.6, hz = 440): Int16Array {
  const n = Math.round(seconds * RATE);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / RATE));
  }
  return s;
}

function snrDb(a: Int16Array, b: Int16Array): number {
  let sig = 0;
  let err = 0;
  for (let i = 0; i < a.length; i++) {
    sig += a[i] * a[i];
    err += (a[i] - b[i]) ** 2;
  }
  return 10 * Math.log10(sig / err);
}

test("silence round-trips to zeros", () => {
  const out = decodeAdpcm(encodeAdpcm(new Int16Array(1000)), 1000);
  assert.equal(out.length, 1000);
  assert.ok(out.every((v) => v === 0));
});

test("a sine round-trips above 25 dB SNR", () => {
  const src = sine(0.5);
  const snr = snrDb(src, decodeAdpcm(encodeAdpcm(src), src.length));
  console.log(`SNR ${snr.toFixed(1)} dB`);
  assert.ok(snr > 25, `snr ${snr}`);
});

test("odd lengths keep their length", () => {
  const src = sine(0.01).subarray(0, 101);
  const out = decodeAdpcm(encodeAdpcm(src), 101);
  assert.equal(out.length, 101);
});

test("encoded size is ceil(n/2) bytes", () => {
  for (const n of [0, 1, 2, 7, 100, 101]) {
    assert.equal(encodeAdpcm(new Int16Array(n)).length, Math.ceil(n / 2));
  }
});

test("float decode matches int decode scaled", () => {
  const src = sine(0.1);
  const bytes = encodeAdpcm(src);
  const ints = decodeAdpcm(bytes, src.length);
  const f = new Float32Array(src.length + 5);
  decodeAdpcmToFloat(bytes, src.length, f, 5);
  for (let i = 0; i < src.length; i++) {
    assert.ok(Math.abs(f[i + 5] - ints[i] / 32768) < 1e-6);
  }
  assert.equal(f[0], 0);
});

test("a sudden loud onset stays finite and in range", () => {
  const src = new Int16Array(4000);
  for (let i = 2000; i < 4000; i++) src[i] = i % 2 ? 32767 : -32768;
  const out = decodeAdpcm(encodeAdpcm(src), src.length);
  const f = new Float32Array(src.length);
  decodeAdpcmToFloat(encodeAdpcm(src), src.length, f, 0);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i] >= -32768 && out[i] <= 32767);
    assert.ok(Number.isFinite(f[i]) && Math.abs(f[i]) <= 1);
  }
});
