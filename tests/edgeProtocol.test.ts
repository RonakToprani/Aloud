import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import {
  SEC_MS_GEC_VERSION,
  TRUSTED_CLIENT_TOKEN,
  edgeEndpoints,
  secMsGec,
  synthesisUrl,
  voicesUrl,
} from "@/lib/speech/edge/protocol";

test("the host that synthesises goes first, each with its own socket path", () => {
  const [first, second] = edgeEndpoints();
  assert.equal(first.base, "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud");
  assert.equal(first.socketPath, "/edge/v1");
  assert.equal(second.base, "https://api.msedgeservices.com/tts/cognitiveservices");
  assert.equal(second.socketPath, "/websocket/v1");
});

test("an endpoint from the environment goes in front, without a trailing slash", () => {
  process.env.EDGE_TTS_ENDPOINT = "https://example.test/tts/";
  try {
    assert.deepEqual(edgeEndpoints()[0], { base: "https://example.test/tts", socketPath: "/websocket/v1" });
    assert.equal(edgeEndpoints().length, 3);
    process.env.EDGE_TTS_SOCKET_PATH = "edge/v1/";
    assert.equal(edgeEndpoints()[0].socketPath, "/edge/v1");
  } finally {
    delete process.env.EDGE_TTS_ENDPOINT;
    delete process.env.EDGE_TTS_SOCKET_PATH;
  }
});

test("one query carries the token under both names, so either host reads it", () => {
  for (const endpoint of edgeEndpoints()) {
    const synthesis = new URL(synthesisUrl(endpoint));
    assert.equal(synthesis.protocol, "wss:");
    assert.equal(synthesis.pathname, new URL(endpoint.base).pathname + endpoint.socketPath);
    assert.equal(synthesis.searchParams.get("TrustedClientToken"), TRUSTED_CLIENT_TOKEN);
    assert.equal(synthesis.searchParams.get("Ocp-Apim-Subscription-Key"), TRUSTED_CLIENT_TOKEN);
    assert.match(synthesis.searchParams.get("Sec-MS-GEC") ?? "", /^[0-9A-F]{16}-[0-9A-F]{64}$/);
    assert.equal(synthesis.searchParams.get("Sec-MS-GEC-Version"), SEC_MS_GEC_VERSION);
    assert.match(synthesis.searchParams.get("ConnectionId") ?? "", /^[0-9a-f]{32}$/);

    const voices = new URL(voicesUrl(endpoint));
    assert.equal(voices.protocol, "https:");
    assert.equal(voices.pathname, new URL(endpoint.base).pathname + "/voices/list");
    assert.equal(voices.searchParams.get("Ocp-Apim-Subscription-Key"), TRUSTED_CLIENT_TOKEN);
  }
});

test("the token is version 2, which is what the version prefix tells the server to expect", () => {
  assert.match(SEC_MS_GEC_VERSION, /^2-\d+\.\d+\.\d+\.\d+$/);
});

test("the signed token matches one Edge itself produced", () => {
  // Captured for the window starting 2026-10-13T10:40:00Z (rany2/edge-tts#492).
  assert.equal(
    secMsGec(1791888000_000),
    "492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876",
  );
});

test("the signed token is stable inside a five minute window and changes across one", () => {
  const window = 300_000;
  const at = Math.floor(Date.now() / window) * window;
  assert.equal(secMsGec(at), secMsGec(at + window - 1));
  assert.notEqual(secMsGec(at), secMsGec(at + window));
});
