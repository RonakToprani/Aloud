import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import {
  TRUSTED_CLIENT_TOKEN,
  edgeEndpoints,
  secMsGec,
  synthesisUrl,
  voicesUrl,
} from "@/lib/speech/edge/protocol";

test("the new host is tried first and the retired one kept as a fallback", () => {
  const bases = edgeEndpoints().map((endpoint) => endpoint.base);
  assert.equal(bases[0], "https://api.msedgeservices.com/tts/cognitiveservices");
  assert.ok(bases.includes("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud"));
});

test("an endpoint from the environment goes in front, without a trailing slash", () => {
  process.env.EDGE_TTS_ENDPOINT = "https://example.test/tts/";
  try {
    assert.equal(edgeEndpoints()[0].base, "https://example.test/tts");
    assert.equal(edgeEndpoints().length, 3);
  } finally {
    delete process.env.EDGE_TTS_ENDPOINT;
  }
});

test("one query carries the token under both names, so either host reads it", () => {
  const endpoint = edgeEndpoints()[0];
  const synthesis = new URL(synthesisUrl(endpoint));
  assert.equal(synthesis.protocol, "wss:");
  assert.equal(synthesis.pathname, "/tts/cognitiveservices/websocket/v1");
  assert.equal(synthesis.searchParams.get("TrustedClientToken"), TRUSTED_CLIENT_TOKEN);
  assert.equal(synthesis.searchParams.get("Ocp-Apim-Subscription-Key"), TRUSTED_CLIENT_TOKEN);
  assert.match(synthesis.searchParams.get("Sec-MS-GEC") ?? "", /^[0-9A-F]{64}$/);
  assert.match(synthesis.searchParams.get("ConnectionId") ?? "", /^[0-9a-f]{32}$/);

  const voices = new URL(voicesUrl(endpoint));
  assert.equal(voices.protocol, "https:");
  assert.equal(voices.pathname, "/tts/cognitiveservices/voices/list");
  assert.equal(voices.searchParams.get("Ocp-Apim-Subscription-Key"), TRUSTED_CLIENT_TOKEN);
});

test("the signed token is stable inside a five minute window and changes across one", () => {
  const window = 300_000;
  const at = Math.floor(Date.now() / window) * window;
  assert.equal(secMsGec(at), secMsGec(at + window - 1));
  assert.notEqual(secMsGec(at), secMsGec(at + window));
});
