import assert from "node:assert/strict";
import test from "node:test";

import { compileApp, validateApp } from "../src/compiler.js";
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
} from "../src/ir.js";

function makeApp() {
  return defineApp({
    name: "Escaped </script> app",
    state: {
      cells: {
        filter: cell("", { type: "string" }),
        heading: cell('Todos <unsafe> & "quoted"', { type: "string" }),
      },
      tables: {
        todos: table({
          key: "id",
          fields: {
            id: "string",
            title: "string",
            done: "boolean",
          },
          initial: [
            { id: "a", title: "Write <compiler>", done: false },
            { id: "b", title: "Ship & verify", done: true },
          ],
        }),
      },
    },
    queries: {
      visible: collection("todos", {
        where: calc.contains(
          calc.lower(ref.field("title")),
          calc.lower(ref.cell("filter")),
        ),
        orderBy: [{ by: ref.field("id"), direction: "ascending" }],
      }),
      remaining: aggregate("visible", {
        operation: "count",
        where: calc.not(ref.field("done")),
      }),
    },
    actions: {
      setFilter: transaction({
        params: { next: "string" },
        do: [mutate.setCell("filter", ref.param("next"))],
      }),
      toggle: transaction({
        params: { id: "string" },
        do: [mutate.toggleField("todos", ref.param("id"), "done")],
      }),
    },
    view: element(
      "main",
      {
        attrs: { id: "app", "data-note": 'a&b"c' },
        props: { "aria-label": ref.cell("heading") },
        classes: { filtered: calc.notEquals(ref.cell("filter"), "") },
      },
      [
        element("h1", {}, [text(ref.cell("heading"))]),
        element("input", {
          props: { value: ref.cell("filter") },
          on: {
            input: handle("setFilter", { next: fromEvent.value() }),
          },
        }),
        each(
          "visible",
          element(
            "article",
            { classes: { done: ref.field("done") } },
            [
              element(
                "button",
                {
                  on: {
                    click: handle("toggle", { id: fromEvent.rowKey() }),
                  },
                },
                [text(ref.field("title"))],
              ),
            ],
          ),
        ),
        element("p", {}, ["Remaining: ", text(ref.aggregate("remaining"))]),
      ],
    ),
  });
}

test("validateApp accepts the constrained serializable IR", () => {
  const app = makeApp();
  assert.equal(validateApp(app), app);
});

test("compileApp emits deterministic bindings, routes, row templates, and dependencies", () => {
  const { plan, snapshot } = compileApp(makeApp());

  assert.deepEqual(
    plan.bindings.map(({ id, scope, kind, name }) => ({ id, scope, kind, name })),
    [
      { id: "b0", scope: null, kind: "prop", name: "aria-label" },
      { id: "b1", scope: null, kind: "class", name: "filtered" },
      { id: "b2", scope: null, kind: "text", name: undefined },
      { id: "b3", scope: null, kind: "prop", name: "value" },
      { id: "b4", scope: "visible", kind: "class", name: "done" },
      { id: "b5", scope: "visible", kind: "text", name: undefined },
      { id: "b6", scope: null, kind: "text", name: undefined },
    ],
  );
  assert.deepEqual(plan.bindings[0].deps, [{ kind: "cell", name: "heading" }]);
  assert.deepEqual(plan.bindings[4].deps, [{ kind: "field", name: "done" }]);
  assert.deepEqual(plan.bindings[6].deps, [
    { kind: "aggregate", name: "remaining" },
  ]);

  assert.deepEqual(Object.keys(plan.eventRoutes), ["e0", "e1"]);
  assert.deepEqual(
    { ...plan.eventRoutes.e0, args: undefined, deps: undefined },
    {
      id: "e0",
      event: "input",
      scope: null,
      action: "setFilter",
      args: undefined,
      preventDefault: false,
      deps: undefined,
    },
  );
  assert.equal(plan.eventRoutes.e1.scope, "visible");
  assert.equal(plan.eventRoutes.e1.action, "toggle");
  assert.deepEqual(plan.rowTemplates.visible.bindingIds, ["b4", "b5"]);
  assert.deepEqual(plan.rowTemplates.visible.routeIds, ["e1"]);
  assert.equal(plan.rowTemplates.visible.root.kind, "element");
  assert.equal(plan.rowTemplates.visible.root.tag, "article");
  assert.deepEqual(snapshot.collections.visible, ["a", "b"]);
  assert.equal(snapshot.aggregates.remaining, 1);
});

test("SSR emits semantic initial HTML and exact resumability markers", () => {
  const { html } = compileApp(makeApp());

  assert.match(
    html,
    /<meta name="viewport" content="width=device-width, initial-scale=1">/,
  );
  assert.match(html, /<title>Escaped &lt;\/script&gt; app<\/title>/);
  assert.match(
    html,
    /<main id="app" data-note="a&amp;b&quot;c" aria-label="Todos &lt;unsafe&gt; &amp; &quot;quoted&quot;" data-delta-bind="b0 b1">/,
  );
  assert.match(
    html,
    /<h1><!--d:b2-->Todos &lt;unsafe&gt; &amp; "quoted"<\/h1>/,
  );
  assert.match(
    html,
    /<input value="" data-delta-bind="b3" data-delta-on="input:e0">/,
  );
  assert.match(html, /<!--r:visible:start-->/);
  assert.match(
    html,
    /<article class="done" data-delta-bind="b4" data-delta-row="%22b%22">/,
  );
  assert.match(
    html,
    /<button data-delta-on="click:e1"><!--d:b5:%22a%22-->Write &lt;compiler&gt;<\/button>/,
  );
  assert.match(html, /<!--r:visible:end-->/);
  assert.match(html, /<p>Remaining: <!--d:b6-->1<\/p>/);
});

test("resume capsule, inline module, styles, and import strings are injection-safe", () => {
  const styles = 'body::before { content: "</style><script>bad()</script>"; }';
  const runtimeImport = './runtime/<browser>&".js';
  const { html, module, snapshot } = compileApp(makeApp(), {
    styles,
    runtimeImport,
  });

  assert.ok(!html.includes("</style><script>bad()"));
  assert.match(html, /\\3C \/style>\\3C script>bad\(\)\\3C \/script>/);
  assert.ok(!module.includes(runtimeImport));
  assert.match(module, /import \{ resume \} from "\.\/runtime\/\\u003cbrowser\\u003e\\u0026\\\"\.js";/);
  assert.match(
    module,
    /document\.querySelector\("script#delta-resume\[type=\\"application\/json\\"\]"\)/,
  );
  assert.match(module, /resume\(plan, document, snapshot\);/);

  const capsule = html.match(
    /<script id="delta-resume" type="application\/json">([\s\S]*?)<\/script>/,
  );
  assert.ok(capsule);
  assert.ok(!capsule[1].includes("<"));
  assert.deepEqual(JSON.parse(capsule[1]), snapshot);
});

test("SSR evaluates lookup bindings and keeps encoded row keys comment-safe", () => {
  const app = makeApp();
  app.state.tables.todos.initial[0].id = "a--unsafe-";
  app.view.children.push(
    element("aside", {}, [text(ref.lookup("todos", "a--unsafe-", "title"))]),
  );

  const { plan, html } = compileApp(app);
  assert.deepEqual(plan.bindings.at(-1).deps, [
    { kind: "tableField", table: "todos", name: "title" },
  ]);
  assert.match(html, /<aside><!--d:b7-->Write &lt;compiler&gt;<\/aside>/);
  assert.match(html, /data-delta-row="%22a--unsafe-%22"/);
  assert.match(
    html,
    /<!--d:b5:%22a%2D%2Dunsafe%2D%22-->Write &lt;compiler&gt;/,
  );
  assert.ok(!html.includes("<!--d:b5:%22a--unsafe-%22-->"));
});

test("SSR maps DOM properties to semantic textarea and boolean markup", () => {
  const app = makeApp();
  app.view.children.push(
    element("textarea", { props: { value: ref.cell("heading") } }),
    element("input", { props: { disabled: true, checked: false } }),
  );

  const { html } = compileApp(app);
  assert.match(
    html,
    /<textarea data-delta-bind="b7">Todos &lt;unsafe&gt; &amp; "quoted"<\/textarea>/,
  );
  assert.match(html, /<input disabled data-delta-bind="b8 b9">/);
  assert.ok(!/<textarea[^>]* value=/.test(html));
  assert.ok(!/<input[^>]* checked/.test(html));
});

test("validateApp rejects non-serializable values and circular structures", () => {
  const withFunction = makeApp();
  withFunction.state.cells.bad = cell(() => 1, { type: "any" });
  assert.throws(() => validateApp(withFunction), /non-serializable function/);

  const circular = makeApp();
  circular.state.cells.bad = { kind: "cell", type: "object", initial: {} };
  circular.state.cells.bad.initial.self = circular.state.cells.bad.initial;
  assert.throws(() => validateApp(circular), /circular reference/);
});

test("validateApp rejects dangling state, query, field, and action references", () => {
  const badCell = makeApp();
  badCell.view.children[0] = element("h1", {}, [text(ref.cell("missing"))]);
  assert.throws(() => validateApp(badCell), /unknown cell "missing"/);

  const badField = makeApp();
  badField.queries.visible.where = ref.field("missing");
  assert.throws(() => validateApp(badField), /unknown field "missing"/);

  const badQuery = makeApp();
  badQuery.view.children[2].query = "missing";
  assert.throws(() => validateApp(badQuery), /unknown query "missing"/);

  const badAction = makeApp();
  badAction.view.children[1].on.input.action = "missing";
  assert.throws(() => validateApp(badAction), /unknown action "missing"/);
});

test("validateApp enforces types, route parameters, unique keys, and element template roots", () => {
  const badType = makeApp();
  badType.state.tables.todos.initial[0].done = "no";
  assert.throws(() => validateApp(badType), /expected boolean, received string/);

  const missingParam = makeApp();
  missingParam.view.children[1].on.input.args = {};
  assert.throws(() => validateApp(missingParam), /missing action parameter "next"/);

  const duplicateKey = makeApp();
  duplicateKey.state.tables.todos.initial[1].id = "a";
  assert.throws(() => validateApp(duplicateKey), /duplicates another table key/);

  const badTemplate = makeApp();
  badTemplate.view.children[2].template = text(ref.field("title"));
  assert.throws(() => validateApp(badTemplate), /exactly one element root/);

  const badRoot = makeApp();
  badRoot.view = badRoot.view.children[2];
  assert.throws(() => validateApp(badRoot), /exactly one element root/);
});

test("validateApp rejects unsupported aggregates and compiler-reserved markup", () => {
  const badAggregate = makeApp();
  badAggregate.queries.remaining.operation = "average";
  assert.throws(() => validateApp(badAggregate), /must be "count" or "sum"/);

  const missingSelect = makeApp();
  missingSelect.queries.remaining.operation = "sum";
  assert.throws(() => validateApp(missingSelect), /select.*required/);

  const reservedAttribute = makeApp();
  reservedAttribute.view.attrs["data-delta-bind"] = "spoofed";
  assert.throws(() => validateApp(reservedAttribute), /compiler-reserved attribute/);
});

test("validateApp protects keyed plans and DOM binding structure", () => {
  const prototypeQuery = makeApp();
  Object.defineProperty(prototypeQuery.queries, "__proto__", {
    value: collection("todos"),
    enumerable: true,
  });
  assert.throws(() => validateApp(prototypeQuery), /prototype-reserved key/);

  const primaryKeyMutation = makeApp();
  primaryKeyMutation.actions.toggle.operations = [
    mutate.setField("todos", ref.param("id"), "id", ref.param("id")),
  ];
  assert.throws(() => validateApp(primaryKeyMutation), /primary key fields cannot be changed/);

  const invalidInsert = makeApp();
  invalidInsert.state.tables.todos.fields.id = "any";
  invalidInsert.actions.insert = transaction({
    do: [mutate.insert("todos", { id: {}, title: "bad", done: false })],
  });
  assert.throws(() => validateApp(invalidInsert), /table keys must be JSON-compatible/);

  const structuralProperty = makeApp();
  structuralProperty.view.props.innerHTML = ref.cell("heading");
  assert.throws(() => validateApp(structuralProperty), /DOM-structural properties/);
});
