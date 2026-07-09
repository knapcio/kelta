import assert from "node:assert/strict";
import test from "node:test";

import {
  calc,
  collectDependencies,
  collection,
  ref,
  value,
} from "../src/ir.js";

test("expressions are plain serializable data", () => {
  const expression = calc.and(
    ref.field("enabled"),
    calc.contains(calc.lower(ref.field("title")), calc.lower(ref.cell("search"))),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(expression)), expression);
  assert.deepEqual(collectDependencies(expression), [
    { kind: "field", name: "enabled" },
    { kind: "field", name: "title" },
    { kind: "cell", name: "search" },
  ]);
});

test("collection normalizes order expressions", () => {
  assert.deepEqual(collection("tasks", { orderBy: "rank" }), {
    kind: "collection",
    from: "tasks",
    where: value(true),
    orderBy: [{ by: ref.field("rank"), direction: "ascending" }],
  });
});
