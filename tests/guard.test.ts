import assert from "node:assert/strict";
import test from "node:test";
import { allowedExtensionIds, isSameOrigin } from "@/lib/speech/edge/guard";

const ID = "dhglbgdemfffpnacaoancigdcgiiecln";

function request(headers: Record<string, string>): Request {
  return new Request("https://www.aloudreader.org/api/speech/edge/voices", { headers });
}

test("the reader's own pages are allowed and other sites are not", () => {
  assert.equal(isSameOrigin(request({ host: "www.aloudreader.org", origin: "https://www.aloudreader.org" }), new Set()), true);
  assert.equal(isSameOrigin(request({ host: "www.aloudreader.org", origin: "https://example.com" }), new Set()), false);
  assert.equal(isSameOrigin(request({ host: "www.aloudreader.org" }), new Set()), false);
});

test("an admitted extension build is allowed and any other extension is not", () => {
  const ids = new Set([ID]);
  assert.equal(isSameOrigin(request({ host: "www.aloudreader.org", origin: `chrome-extension://${ID}` }), ids), true);
  assert.equal(isSameOrigin(request({ host: "www.aloudreader.org", origin: `chrome-extension://${ID.toUpperCase()}` }), ids), true);
  assert.equal(isSameOrigin(request({ host: "www.aloudreader.org", origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), ids), false);
  // With nothing admitted, an extension origin never passes, however it is spelt.
  assert.equal(isSameOrigin(request({ host: "www.aloudreader.org", origin: `chrome-extension://${ID}` }), new Set()), false);
});

test("the id list tolerates spacing and drops anything that is not an id", () => {
  const ids = allowedExtensionIds(` ${ID}, not-an-id ,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  assert.deepEqual([...ids].sort(), ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ID]);
  assert.equal(allowedExtensionIds(undefined).size, 0);
});
