import {
  aggregate,
  calc,
  cell,
  collection,
  defineApp,
  each,
  element,
  handle,
  mutate,
  ref,
  table,
  text,
  transaction,
} from "../../src/ir.js";

export function createRows(size) {
  return Array.from({ length: size }, (_, index) => ({
    id: index + 1,
    label: `row ${index + 1}`,
    active: index % 3 !== 0,
    rank: index,
  }));
}

export function benchmarkConstants(size) {
  const targetId = Math.max(1, Math.floor(size / 2));
  return {
    targetId,
    originalLabel: `row ${targetId}`,
    changedLabel: `row ${targetId} updated`,
    originalRank: targetId - 1,
    promotedRank: -1,
    filterValue: `row ${size}`,
  };
}

export function createKeltaBenchmarkApp(rows) {
  const constants = benchmarkConstants(rows.length);

  return defineApp({
    name: "Kelta React comparison",
    state: {
      cells: {
        search: cell("", { type: "string" }),
      },
      tables: {
        rows: table({
          key: "id",
          fields: {
            id: "number",
            label: "string",
            active: "boolean",
            rank: "number",
          },
          initial: rows,
        }),
      },
    },
    queries: {
      visibleRows: collection("rows", {
        where: calc.contains(
          calc.lower(ref.field("label")),
          calc.lower(ref.cell("search")),
        ),
        orderBy: [{ by: ref.field("rank"), direction: "ascending" }],
      }),
      activeCount: aggregate("rows", {
        operation: "count",
        where: ref.field("active"),
      }),
    },
    actions: {
      changeLabel: transaction({
        do: [
          mutate.setField(
            "rows",
            constants.targetId,
            "label",
            constants.changedLabel,
          ),
        ],
      }),
      resetLabel: transaction({
        do: [
          mutate.setField(
            "rows",
            constants.targetId,
            "label",
            constants.originalLabel,
          ),
        ],
      }),
      toggleActive: transaction({
        do: [mutate.toggleField("rows", constants.targetId, "active")],
      }),
      promote: transaction({
        do: [
          mutate.setField(
            "rows",
            constants.targetId,
            "rank",
            constants.promotedRank,
          ),
        ],
      }),
      resetRank: transaction({
        do: [
          mutate.setField(
            "rows",
            constants.targetId,
            "rank",
            constants.originalRank,
          ),
        ],
      }),
      filter: transaction({
        do: [mutate.setCell("search", constants.filterValue)],
      }),
      resetFilter: transaction({
        do: [mutate.setCell("search", "")],
      }),
    },
    view: element("section", { attrs: { class: "bench-app" } }, [
      element("header", { attrs: { class: "bench-controls" } }, [
        element("output", { attrs: { "data-bench-count": "" } }, [
          text(ref.aggregate("activeCount")),
        ]),
        controlButton("label", "changeLabel"),
        controlButton("label-reset", "resetLabel"),
        controlButton("toggle", "toggleActive"),
        controlButton("promote", "promote"),
        controlButton("promote-reset", "resetRank"),
        controlButton("filter", "filter"),
        controlButton("filter-reset", "resetFilter"),
      ]),
      element("ul", { attrs: { class: "bench-rows" } }, [
        each(
          "visibleRows",
          element(
            "li",
            {
              attrs: { class: "bench-row" },
              props: { "data-row-id": ref.field("id") },
              classes: { active: ref.field("active") },
            },
            [
              element("input", {
                attrs: { type: "checkbox", tabindex: "-1", readonly: true },
                props: {
                  checked: ref.field("active"),
                  "aria-label": calc.add("Active ", ref.field("label")),
                },
              }),
              element("span", { attrs: { class: "bench-label" } }, [
                text(ref.field("label")),
              ]),
              element("small", { attrs: { class: "bench-rank" } }, [
                text(ref.field("rank")),
              ]),
            ],
          ),
        ),
      ]),
    ]),
  });
}

function controlButton(action, transactionName) {
  return element(
    "button",
    {
      attrs: {
        type: "button",
        "data-bench-action": action,
        tabindex: "-1",
      },
      on: { click: handle(transactionName) },
    },
    [action],
  );
}
