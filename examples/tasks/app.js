import {
  aggregate,
  calc,
  cell,
  collection,
  defineApp,
  each,
  element,
  fromEvent,
  handle,
  mutate,
  ref,
  table,
  text,
  transaction,
} from "../../src/ir.js";

const initialTasks = [
  {
    id: 1,
    title: "Define the typed UI intermediate representation",
    done: true,
    rank: 10,
  },
  {
    id: 2,
    title: "Compile dependencies into exact patch routes",
    done: true,
    rank: 20,
  },
  {
    id: 3,
    title: "Propagate collection deltas instead of diffing trees",
    done: false,
    rank: 30,
  },
  {
    id: 4,
    title: "Resume server HTML without replaying the view",
    done: false,
    rank: 40,
  },
  {
    id: 5,
    title: "Move compute-heavy operators into workers only when useful",
    done: false,
    rank: 50,
  },
  {
    id: 6,
    title: "Build a transaction-to-DOM debugger",
    done: false,
    rank: 60,
  },
];

const visibleFilter = calc.contains(
  calc.lower(ref.field("title")),
  calc.lower(ref.cell("search")),
);

export default defineApp({
  name: "Kelta Task Graph",
  state: {
    cells: {
      search: cell("", { type: "string" }),
    },
    tables: {
      tasks: table({
        key: "id",
        fields: {
          id: "number",
          title: "string",
          done: "boolean",
          rank: "number",
        },
        initial: initialTasks,
      }),
    },
  },
  queries: {
    visibleTasks: collection("tasks", {
      where: visibleFilter,
      orderBy: [{ by: ref.field("rank"), direction: "ascending" }],
    }),
    remaining: aggregate("tasks", {
      operation: "count",
      where: calc.not(ref.field("done")),
    }),
    completed: aggregate("tasks", {
      operation: "count",
      where: ref.field("done"),
    }),
    total: aggregate("tasks", { operation: "count" }),
  },
  actions: {
    setSearch: transaction({
      params: { value: "string" },
      do: [mutate.setCell("search", ref.param("value"))],
    }),
    toggle: transaction({
      params: { id: "number" },
      do: [mutate.toggleField("tasks", ref.param("id"), "done")],
    }),
    promote: transaction({
      params: { id: "number" },
      do: [
        mutate.setField(
          "tasks",
          ref.param("id"),
          "rank",
          calc.subtract(
            ref.lookup("tasks", ref.param("id"), "rank"),
            100,
          ),
        ),
      ],
    }),
    remove: transaction({
      params: { id: "number" },
      do: [mutate.remove("tasks", ref.param("id"))],
    }),
  },
  view: element("main", { attrs: { class: "shell" } }, [
    element("section", { attrs: { class: "hero" } }, [
      element("div", { attrs: { class: "eyebrow" } }, [
        "TRANSACTIONAL UI COMPILER / PROTOTYPE 01",
      ]),
      element("h1", {}, ["The DOM is a materialized view."]),
      element("p", { attrs: { class: "lede" } }, [
        "Events commit typed deltas. The runtime touches only bindings and keyed regions that actually changed.",
      ]),
      element("div", { attrs: { class: "pipeline", "aria-label": "Update pipeline" } }, [
        element("span", {}, ["EVENT"]),
        element("b", {}, ["→"]),
        element("span", {}, ["TRANSACTION"]),
        element("b", {}, ["→"]),
        element("span", {}, ["Δ STATE"]),
        element("b", {}, ["→"]),
        element("span", {}, ["EXACT DOM PATCH"]),
      ]),
    ]),
    element("section", { attrs: { class: "workspace" } }, [
      element("div", { attrs: { class: "toolbar" } }, [
        element("label", { attrs: { class: "search" } }, [
          element("span", {}, ["Filter task graph"]),
          element(
            "input",
            {
              attrs: {
                type: "search",
                placeholder: "Type to update the indexed view…",
                autocomplete: "off",
              },
              props: { value: ref.cell("search") },
              on: {
                input: handle("setSearch", { value: fromEvent.value() }),
              },
            },
            [],
          ),
        ]),
        element("div", { attrs: { class: "stats" } }, [
          element("div", {}, [
            text(ref.aggregate("remaining")),
            element("small", {}, ["OPEN"]),
          ]),
          element("div", {}, [
            text(ref.aggregate("completed")),
            element("small", {}, ["DONE"]),
          ]),
          element("div", {}, [
            text(ref.aggregate("total")),
            element("small", {}, ["TOTAL"]),
          ]),
        ]),
      ]),
      element("ol", { attrs: { class: "task-list" } }, [
        each(
          "visibleTasks",
          element(
            "li",
            {
              attrs: { class: "task" },
              classes: { completed: ref.field("done") },
            },
            [
              element("label", { attrs: { class: "check" } }, [
                element(
                  "input",
                  {
                    attrs: { type: "checkbox" },
                    props: {
                      checked: ref.field("done"),
                      "aria-label": calc.add("Toggle ", ref.field("title")),
                    },
                    on: {
                      change: handle("toggle", { id: fromEvent.rowKey() }),
                    },
                  },
                  [],
                ),
                element("span", { attrs: { "aria-hidden": "true" } }, []),
              ]),
              element("div", { attrs: { class: "task-copy" } }, [
                element("strong", {}, [text(ref.field("title"))]),
                element("small", {}, [
                  "stable key ",
                  text(ref.field("id")),
                  " · rank ",
                  text(ref.field("rank")),
                ]),
              ]),
              element("div", { attrs: { class: "task-actions" } }, [
                element(
                  "button",
                  {
                    attrs: {
                      type: "button",
                      class: "promote",
                      title: "Change the sort key and move this exact DOM node",
                    },
                    props: {
                      "aria-label": calc.add(
                        "Move ",
                        ref.field("title"),
                        " to the front",
                      ),
                    },
                    on: {
                      click: handle("promote", { id: fromEvent.rowKey() }),
                    },
                  },
                  ["↑"],
                ),
                element(
                  "button",
                  {
                    attrs: {
                      type: "button",
                      class: "remove",
                      title: "Delete this keyed row",
                    },
                    props: {
                      "aria-label": calc.add("Remove ", ref.field("title")),
                    },
                    on: {
                      click: handle("remove", { id: fromEvent.rowKey() }),
                    },
                  },
                  ["×"],
                ),
              ]),
            ],
          ),
        ),
      ]),
      element("footer", {}, [
        element("span", {}, ["NO VIRTUAL DOM"]),
        element("span", {}, ["NO COMPONENT RERUNS"]),
        element("span", {}, ["NO HYDRATION REPLAY"]),
        element("span", {}, ["INSPECT: window.__KELTA__"]),
      ]),
    ]),
  ]),
});
