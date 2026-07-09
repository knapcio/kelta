import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCommentMarker,
  parseEventMarker,
} from "../src/runtime/browser.js";
import { decodeKey, encodeKey } from "../src/runtime/engine.js";

test("browser marker parser preserves typed JSON row keys", () => {
  for (const key of ["7", 7, "a:b", -12.5]) {
    const marker = parseCommentMarker(`d:b4:${encodeKey(key)}`);
    assert.equal(marker.kind, "binding");
    assert.equal(marker.bindingId, "b4");
    assert.deepEqual(decodeKey(marker.encodedKey), key);
  }
  assert.deepEqual(parseCommentMarker("d:b0"), {
    kind: "binding",
    bindingId: "b0",
  });
});

test("browser marker parser recognizes collection region boundaries", () => {
  assert.deepEqual(parseCommentMarker(" r:visible:start "), {
    kind: "regionStart",
    query: "visible",
  });
  assert.deepEqual(parseCommentMarker("r:visible:end"), {
    kind: "regionEnd",
    query: "visible",
  });
  assert.equal(parseCommentMarker("ordinary comment"), undefined);
});

test("delegated event markers are parsed without CSS selector interpolation", () => {
  assert.deepEqual(parseEventMarker("click:e0 input:e1"), [
    { event: "click", routeId: "e0" },
    { event: "input", routeId: "e1" },
  ]);
  assert.deepEqual(parseEventMarker(" malformed :bad keydown:e2 "), [
    { event: "keydown", routeId: "e2" },
  ]);
});
