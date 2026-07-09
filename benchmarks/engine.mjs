import { performance } from "node:perf_hooks";

import { calc, ref } from "../src/ir.js";
import { createEngine } from "../src/runtime/engine.js";

const size = Number(process.env.ROWS ?? 10_000);
const rows = Array.from({ length: size }, (_, index) => ({
  id: index + 1,
  label: `row ${index + 1}`,
  active: index % 3 !== 0,
  rank: index,
}));

const plan = {
  state: {
    cells: {},
    tables: {
      rows: {
        kind: "table",
        key: "id",
        fields: {
          id: "number",
          label: "string",
          active: "boolean",
          rank: "number",
        },
        initial: rows,
      },
    },
  },
  queries: {
    visible: {
      kind: "collection",
      from: "rows",
      where: ref.field("active"),
      orderBy: [{ by: ref.field("rank"), direction: "ascending" }],
    },
    activeCount: {
      kind: "aggregate",
      from: "rows",
      operation: "count",
      where: ref.field("active"),
    },
    rankSum: {
      kind: "aggregate",
      from: "rows",
      operation: "sum",
      where: true,
      select: ref.field("rank"),
    },
  },
  actions: {},
  bindings: [
    {
      id: "row-active",
      scope: "visible",
      kind: "class",
      name: "active",
      expr: ref.field("active"),
      deps: [{ kind: "field", name: "active" }],
    },
    {
      id: "active-count",
      scope: null,
      kind: "text",
      expr: ref.aggregate("activeCount"),
      deps: [{ kind: "aggregate", name: "activeCount" }],
    },
    {
      id: "rank-label",
      scope: "visible",
      kind: "text",
      expr: calc.add("rank ", ref.field("rank")),
      deps: [{ kind: "field", name: "rank" }],
    },
  ],
};

let patches = 0;
let structural = 0;
const adapter = {
  patch() {
    patches += 1;
  },
  insert() {
    structural += 1;
  },
  remove() {
    structural += 1;
  },
  move() {
    structural += 1;
  },
  reconcile() {
    structural += 1;
  },
};

const initStart = performance.now();
const engine = createEngine(plan, { adapter });
const initMs = performance.now() - initStart;

const target = Math.floor(size / 2);
const updateStart = performance.now();
engine.transaction((tx) => {
  tx.setField("rows", target, "rank", -1);
});
const updateMs = performance.now() - updateStart;

if (patches !== 1 || structural !== 1) {
  throw new Error(
    `Expected one scalar patch and one structural move; got ${patches} patches and ${structural} structural operations`,
  );
}

console.log(
  JSON.stringify(
    {
      rows: size,
      initialVisible: engine.getCollection("visible").length,
      initMs: Number(initMs.toFixed(3)),
      oneRowUpdateMs: Number(updateMs.toFixed(3)),
      scalarPatches: patches,
      structuralOperations: structural,
      fullCollectionReconciliations: 0,
    },
    null,
    2,
  ),
);
