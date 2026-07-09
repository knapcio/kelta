import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregate,
  calc,
  cell,
  collection,
  mutate,
  ref,
  table,
  transaction,
} from "../src/ir.js";
import {
  createEngine,
  createInitialSnapshot,
  decodeKey,
  encodeKey,
  evaluate,
} from "../src/runtime/engine.js";

function makePlan() {
  return {
    state: {
      cells: {
        filter: cell("", { type: "string" }),
        status: cell("ready", { type: "string" }),
      },
      tables: {
        tasks: table({
          key: "id",
          fields: {
            id: "string",
            title: "string",
            done: "boolean",
            rank: "number",
            points: "number",
          },
          initial: [
            { id: "a", title: "Alpha", done: false, rank: 10, points: 2 },
            { id: "b", title: "Beta", done: true, rank: 20, points: 3 },
            { id: "c", title: "Gamma", done: false, rank: 30, points: 5 },
          ],
        }),
      },
    },
    queries: {
      visible: collection("tasks", {
        where: calc.contains(
          calc.lower(ref.field("title")),
          calc.lower(ref.cell("filter")),
        ),
        orderBy: [{ by: ref.field("rank"), direction: "ascending" }],
      }),
      remaining: aggregate("tasks", {
        operation: "count",
        where: calc.not(ref.field("done")),
      }),
      points: aggregate("visible", {
        operation: "sum",
        select: ref.field("points"),
      }),
    },
    actions: {
      setFilter: transaction({
        params: { value: "string" },
        do: [mutate.setCell("filter", ref.param("value"))],
      }),
      toggle: transaction({
        params: { id: "string" },
        do: [mutate.toggleField("tasks", ref.param("id"), "done")],
      }),
      rejectBlocked: transaction({
        params: { value: "string" },
        do: [mutate.setCell("status", ref.param("value"))],
        require: [calc.notEquals(ref.cell("status"), "blocked")],
      }),
    },
    bindings: [
      {
        id: "filter",
        scope: null,
        kind: "prop",
        name: "value",
        expr: ref.cell("filter"),
        deps: [{ kind: "cell", name: "filter" }],
      },
      {
        id: "remaining",
        scope: null,
        kind: "text",
        expr: ref.aggregate("remaining"),
        deps: [{ kind: "aggregate", name: "remaining" }],
      },
      {
        id: "title",
        scope: "visible",
        kind: "text",
        expr: ref.field("title"),
        deps: [{ kind: "field", name: "title" }],
      },
      {
        id: "done",
        scope: "visible",
        kind: "class",
        name: "done",
        expr: ref.field("done"),
        deps: [{ kind: "field", name: "done" }],
      },
      {
        id: "rank",
        scope: "visible",
        kind: "text",
        expr: ref.field("rank"),
        deps: [{ kind: "field", name: "rank" }],
      },
    ],
  };
}

function recordingAdapter() {
  const calls = [];
  return {
    calls,
    begin() {
      calls.push(["begin"]);
    },
    patch(binding, key, value) {
      calls.push(["patch", binding.id, key, value]);
    },
    insert(query, key, beforeKey) {
      calls.push(["insert", query, key, beforeKey]);
    },
    remove(query, key) {
      calls.push(["remove", query, key]);
    },
    move(query, key, beforeKey) {
      calls.push(["move", query, key, beforeKey]);
    },
    reconcile(query, oldKeys, newKeys) {
      calls.push(["reconcile", query, oldKeys, newKeys]);
    },
    end(journal) {
      calls.push(["end", journal]);
    },
  };
}

test("evaluate covers state, row, event, lookup, and short-circuit expressions", () => {
  const context = {
    cells: { prefix: "HELLO", unused: "x" },
    tables: { users: [{ id: 7, name: "Ada" }] },
    tableKeys: { users: "id" },
    aggregates: { total: 3 },
    row: { id: "row-1", label: "World", enabled: true },
    key: "row-1",
    params: { suffix: "!" },
    event: { value: "typed", checked: false },
  };

  assert.equal(evaluate(ref.cell("prefix"), context), "HELLO");
  assert.equal(evaluate(ref.field("label"), context), "World");
  assert.equal(evaluate(ref.aggregate("total"), context), 3);
  assert.equal(evaluate(ref.param("suffix"), context), "!");
  assert.equal(evaluate(ref.lookup("users", 7, "name"), context), "Ada");
  assert.equal(evaluate({ kind: "eventValue" }, context), "typed");
  assert.equal(evaluate({ kind: "eventChecked" }, context), false);
  assert.equal(evaluate({ kind: "rowKey" }, context), "row-1");
  assert.equal(
    evaluate(calc.add(calc.lower(ref.cell("prefix")), " ", ref.field("label")), context),
    "hello World",
  );
  assert.equal(evaluate(calc.choose(ref.field("enabled"), "yes", "no"), context), "yes");
  assert.equal(evaluate(calc.coalesce(null, undefined, "fallback"), context), "fallback");
});

test("initial snapshots are serializable and derive collections and aggregates", () => {
  const snapshot = createInitialSnapshot(makePlan());

  assert.deepEqual(snapshot.cells, { filter: "", status: "ready" });
  assert.deepEqual(snapshot.collections, { visible: ["a", "b", "c"] });
  assert.deepEqual(snapshot.aggregates, { remaining: 2, points: 10 });
  assert.ok(Array.isArray(snapshot.tables.tasks));
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);

  for (const key of ["a--unsafe-", 42, true, false, null]) {
    assert.deepEqual(decodeKey(encodeKey(key)), key);
  }
});

test("row transactions incrementally emit one move and only the changed binding", () => {
  const adapter = recordingAdapter();
  const engine = createEngine(makePlan(), { adapter });

  const result = engine.transaction(({ setField }) => {
    setField("tasks", "c", "rank", 25);
    setField("tasks", "c", "rank", 5);
    return "committed";
  });

  assert.equal(result, "committed");
  assert.deepEqual(engine.getCollection("visible"), ["c", "a", "b"]);
  assert.equal(engine.getRow("tasks", "c").rank, 5);
  assert.deepEqual(
    adapter.calls.slice(0, -1),
    [
      ["begin"],
      ["move", "visible", "c", "a"],
      ["patch", "rank", "c", 5],
    ],
  );

  const journal = engine.lastJournal;
  assert.equal(journal.tables.length, 1);
  assert.deepEqual(journal.tables[0].fields, ["rank"]);
  assert.equal(journal.collections[0].mode, "incremental");
  assert.equal(journal.patches.length, 1);
});

test("cell-wide invalidation reconciles a collection and patches exact scalar values", () => {
  const adapter = recordingAdapter();
  const engine = createEngine(makePlan(), { adapter });

  engine.dispatch("setFilter", { value: "beta" });

  assert.equal(engine.getCell("filter"), "beta");
  assert.deepEqual(engine.getCollection("visible"), ["b"]);
  assert.equal(engine.getAggregate("points"), 3);
  assert.deepEqual(
    adapter.calls.slice(0, -1),
    [
      ["begin"],
      ["reconcile", "visible", ["a", "b", "c"], ["b"]],
      ["patch", "filter", null, "beta"],
    ],
  );
  assert.deepEqual(
    engine.lastJournal.aggregates,
    [{ query: "points", oldValue: 10, newValue: 3 }],
  );
});

test("actions update aggregates and scoped/global bindings without collection work", () => {
  const adapter = recordingAdapter();
  const engine = createEngine(makePlan(), { adapter });

  engine.dispatch("toggle", { id: "a" });

  assert.equal(engine.getRow("tasks", "a").done, true);
  assert.equal(engine.getAggregate("remaining"), 1);
  assert.deepEqual(engine.getCollection("visible"), ["a", "b", "c"]);
  assert.deepEqual(
    adapter.calls.slice(0, -1),
    [
      ["begin"],
      ["patch", "remaining", null, 1],
      ["patch", "done", "a", true],
    ],
  );
});

test("transactions coalesce no-ops and roll back throws and invariant failures", () => {
  const adapter = recordingAdapter();
  const engine = createEngine(makePlan(), { adapter });
  const initial = engine.snapshot();

  engine.transaction(({ setCell, setField }) => {
    setCell("status", "busy");
    setCell("status", "ready");
    setField("tasks", "a", "rank", 99);
    setField("tasks", "a", "rank", 10);
  });
  assert.deepEqual(engine.snapshot(), initial);
  assert.deepEqual(adapter.calls, []);

  assert.throws(
    () =>
      engine.transaction(({ setCell, remove }) => {
        setCell("status", "partial");
        remove("tasks", "a");
        throw new Error("abort");
      }),
    /abort/,
  );
  assert.deepEqual(engine.snapshot(), initial);
  assert.deepEqual(adapter.calls, []);

  assert.throws(
    () => engine.dispatch("rejectBlocked", { value: "blocked" }),
    /Invariant failed/,
  );
  assert.deepEqual(engine.snapshot(), initial);
  assert.deepEqual(adapter.calls, []);
});

test("insert/remove deltas and snapshot resumption preserve typed state", () => {
  const adapter = recordingAdapter();
  const plan = makePlan();
  const engine = createEngine(plan, { adapter });

  engine.transaction(({ insert, remove }) => {
    insert("tasks", {
      id: "d",
      title: "Delta",
      done: false,
      rank: 15,
      points: 7,
    });
    remove("tasks", "b");
  });

  assert.deepEqual(engine.getCollection("visible"), ["a", "d", "c"]);
  assert.equal(engine.getAggregate("remaining"), 3);
  assert.equal(engine.getAggregate("points"), 14);
  assert.ok(adapter.calls.some((call) => call[0] === "remove" && call[2] === "b"));
  assert.ok(adapter.calls.some((call) => call[0] === "insert" && call[2] === "d"));

  const resumed = createEngine(plan, { snapshot: engine.snapshot() });
  assert.deepEqual(resumed.snapshot(), engine.snapshot());
  assert.deepEqual(resumed.getCollection("visible"), ["a", "d", "c"]);
  assert.equal(resumed.getAggregate("points"), 14);
});

test("resumption consumes materialized query state and rejects invalid capsules", () => {
  const plan = makePlan();
  const snapshot = createInitialSnapshot(plan);

  const resumeOnlyPlan = structuredClone(plan);
  resumeOnlyPlan.queries.visible.where = {
    kind: "operation",
    operator: "wouldRecompute",
    operands: [],
  };

  const resumed = createEngine(resumeOnlyPlan, { snapshot });
  assert.deepEqual(resumed.getCollection("visible"), ["a", "b", "c"]);
  assert.equal(resumed.getAggregate("remaining"), 2);

  const invalid = structuredClone(snapshot);
  invalid.collections.visible.push("missing");
  assert.throws(
    () => createEngine(plan, { snapshot: invalid }),
    /Unknown key "missing" in snapshot collection "visible"/,
  );
});
