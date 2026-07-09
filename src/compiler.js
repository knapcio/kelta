import { collectDependencies, isExpression } from "./ir.js";
import {
  createInitialSnapshot,
  encodeKey,
  evaluate,
} from "./runtime/engine.js";

const APP_KEYS = new Set(["kind", "name", "state", "queries", "actions", "view"]);
const CELL_KEYS = new Set(["kind", "type", "initial"]);
const TABLE_KEYS = new Set(["kind", "key", "fields", "initial"]);
const COLLECTION_KEYS = new Set(["kind", "from", "where", "orderBy"]);
const AGGREGATE_KEYS = new Set(["kind", "from", "operation", "where", "select"]);
const TRANSACTION_KEYS = new Set(["kind", "params", "operations", "invariants"]);
const ELEMENT_KEYS = new Set([
  "kind",
  "tag",
  "attrs",
  "props",
  "classes",
  "on",
  "children",
]);
const EACH_KEYS = new Set(["kind", "query", "template"]);
const TEXT_KEYS = new Set(["kind", "value"]);
const EVENT_ROUTE_KEYS = new Set([
  "kind",
  "action",
  "args",
  "preventDefault",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9:.-]*$/;
const ATTRIBUTE_NAME = /^[^\s"'<>/=]+$/;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const UNSAFE_IDENTIFIER_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STRUCTURAL_PROPERTIES = new Set([
  "childNodes",
  "children",
  "innerHTML",
  "innerText",
  "outerHTML",
  "textContent",
]);
const SUPPORTED_TYPES = new Set([
  "any",
  "array",
  "boolean",
  "null",
  "number",
  "object",
  "string",
]);
const SUPPORTED_OPERATIONS = new Map([
  ["not", [1, 1]],
  ["equals", [2, 2]],
  ["notEquals", [2, 2]],
  ["and", [1, Infinity]],
  ["or", [1, Infinity]],
  ["contains", [2, 2]],
  ["lower", [1, 1]],
  ["add", [1, Infinity]],
  ["subtract", [2, 2]],
  ["multiply", [1, Infinity]],
  ["coalesce", [1, Infinity]],
  ["choose", [3, 3]],
]);
const RESERVED_ATTRIBUTES = new Set([
  "data-delta-bind",
  "data-delta-on",
  "data-delta-row",
]);
const DOCUMENT_ELEMENTS = new Set(["body", "head", "html"]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);

/**
 * Validate a Kelta application and return it unchanged.
 *
 * Validation is intentionally strict. The compiler output crosses a JSON
 * server/browser boundary, so accepting functions, cycles, class instances,
 * unknown IR nodes, or dangling references would make resumption ambiguous.
 */
export function validateApp(app) {
  assertSerializable(app, "app");
  assertPlainObject(app, "app");
  assertKeys(app, APP_KEYS, "app");
  assert(app.kind === "app", "app.kind", 'must be "app"');
  assert(typeof app.name === "string" && app.name.length > 0, "app.name", "must be a non-empty string");

  assertPlainObject(app.state, "app.state");
  assertKeys(app.state, new Set(["cells", "tables"]), "app.state");
  assertPlainObject(app.state.cells, "app.state.cells");
  assertPlainObject(app.state.tables, "app.state.tables");
  assertPlainObject(app.queries, "app.queries");
  assertPlainObject(app.actions, "app.actions");

  const context = createValidationContext(app);
  validateState(context);
  validateQueries(context);
  validateActions(context);

  assert(app.view?.kind === "element", "app.view", "must have exactly one element root");
  validateViewNode(app.view, "app.view", context, null);

  return app;
}

/**
 * Compile an app into a resumable plan, its initial snapshot, server-rendered
 * HTML, and the browser module used to resume it.
 */
export function compileApp(
  app,
  { styles = "", runtimeImport = "./runtime/browser.js" } = {},
) {
  validateApp(app);
  assert(typeof styles === "string", "options.styles", "must be a string");
  assert(
    typeof runtimeImport === "string" && runtimeImport.length > 0,
    "options.runtimeImport",
    "must be a non-empty string",
  );

  const compiler = createPlanCompiler(app);
  const view = compiler.compileNode(app.view, null);
  const plan = {
    version: 1,
    name: app.name,
    state: app.state,
    queries: app.queries,
    actions: app.actions,
    view,
    bindings: compiler.bindings,
    rowTemplates: compiler.rowTemplates,
    eventRoutes: compiler.eventRoutes,
  };

  const snapshot = createInitialSnapshot(plan);
  assertSerializable(snapshot, "snapshot");

  const renderedView = renderNode(
    view,
    plan,
    snapshot,
    createRenderContext(snapshot, plan),
  );
  const module = createBrowserModule(plan, runtimeImport);
  const capsule = serializeJsonForHtml(snapshot);
  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(plan.name)}</title>`,
    `<style>${escapeStyle(styles)}</style>`,
    "</head>",
    "<body>",
    renderedView,
    `<script id="delta-resume" type="application/json">${capsule}</script>`,
    `<script type="module">${module}</script>`,
    "</body>",
    "</html>",
  ].join("");

  return { plan, snapshot, html, module };
}

function createValidationContext(app) {
  return {
    app,
    cells: app.state.cells,
    tables: app.state.tables,
    queries: app.queries,
    actions: app.actions,
    tableSchemas: new Map(),
    templateQueries: new Set(),
  };
}

function validateState(context) {
  for (const [name, definition] of Object.entries(context.cells)) {
    validateIdentifier(name, `app.state.cells.${name}`);
    assertPlainObject(definition, `app.state.cells.${name}`);
    assertKeys(definition, CELL_KEYS, `app.state.cells.${name}`);
    assert(definition.kind === "cell", `app.state.cells.${name}.kind`, 'must be "cell"');
    validateType(definition.type, `app.state.cells.${name}.type`);
    assertType(definition.initial, definition.type, `app.state.cells.${name}.initial`);
  }

  for (const [name, definition] of Object.entries(context.tables)) {
    const path = `app.state.tables.${name}`;
    validateIdentifier(name, path);
    assertPlainObject(definition, path);
    assertKeys(definition, TABLE_KEYS, path);
    assert(definition.kind === "table", `${path}.kind`, 'must be "table"');
    assertPlainObject(definition.fields, `${path}.fields`);
    assert(Object.keys(definition.fields).length > 0, `${path}.fields`, "must define at least one field");

    for (const [field, type] of Object.entries(definition.fields)) {
      validateIdentifier(field, `${path}.fields.${field}`);
      validateType(type, `${path}.fields.${field}`);
    }

    assert(typeof definition.key === "string", `${path}.key`, "must be a field name");
    assert(
      Object.hasOwn(definition.fields, definition.key),
      `${path}.key`,
      `references unknown field ${JSON.stringify(definition.key)}`,
    );
    assert(
      ["any", "number", "string"].includes(definition.fields[definition.key]),
      `${path}.key`,
      "table key fields must have type string, number, or any",
    );
    assert(Array.isArray(definition.initial), `${path}.initial`, "must be an array");

    const keys = new Set();
    for (let index = 0; index < definition.initial.length; index += 1) {
      const row = definition.initial[index];
      const rowPath = `${path}.initial[${index}]`;
      assertPlainObject(row, rowPath);

      for (const field of Object.keys(row)) {
        assert(
          Object.hasOwn(definition.fields, field),
          `${rowPath}.${field}`,
          "is not declared in table.fields",
        );
      }
      for (const [field, type] of Object.entries(definition.fields)) {
        assert(Object.hasOwn(row, field), rowPath, `is missing required field ${JSON.stringify(field)}`);
        assertType(row[field], type, `${rowPath}.${field}`);
      }

      const key = row[definition.key];
      assert(
        typeof key === "string" || (typeof key === "number" && Number.isFinite(key)),
        `${rowPath}.${definition.key}`,
        "table keys must be JSON-compatible strings or finite numbers",
      );
      const encoded = encodeKey(key);
      assert(!keys.has(encoded), `${rowPath}.${definition.key}`, "duplicates another table key");
      keys.add(encoded);
    }

    context.tableSchemas.set(name, new Set(Object.keys(definition.fields)));
  }
}

function validateQueries(context) {
  for (const name of Object.keys(context.queries)) {
    validateIdentifier(name, `app.queries.${name}`);
  }

  for (const [name, definition] of Object.entries(context.queries)) {
    const path = `app.queries.${name}`;
    assertPlainObject(definition, path);

    if (definition.kind === "collection") {
      assertKeys(definition, COLLECTION_KEYS, path);
      assert(
        Object.hasOwn(context.tables, definition.from),
        `${path}.from`,
        `references unknown table ${JSON.stringify(definition.from)}`,
      );
      const fields = context.tableSchemas.get(definition.from);
      const expressionContext = expressionScope(context, {
        fields,
        fieldTypes: context.tables[definition.from].fields,
        allowAggregates: false,
      });
      validateExpression(definition.where, `${path}.where`, expressionContext);
      assertExpressionType(definition.where, "boolean", `${path}.where`, expressionContext);
      assert(Array.isArray(definition.orderBy), `${path}.orderBy`, "must be an array");
      for (let index = 0; index < definition.orderBy.length; index += 1) {
        const order = definition.orderBy[index];
        const orderPath = `${path}.orderBy[${index}]`;
        assertPlainObject(order, orderPath);
        assertKeys(order, new Set(["by", "direction"]), orderPath);
        validateExpression(order.by, `${orderPath}.by`, expressionContext);
        assert(
          order.direction === "ascending" || order.direction === "descending",
          `${orderPath}.direction`,
          'must be "ascending" or "descending"',
        );
      }
      continue;
    }

    if (definition.kind === "aggregate") {
      assertKeys(definition, AGGREGATE_KEYS, path);
      const source = resolveAggregateSource(definition.from, context, `${path}.from`);
      const fields = context.tableSchemas.get(source.table);
      const expressionContext = expressionScope(context, {
        fields,
        fieldTypes: context.tables[source.table].fields,
        allowAggregates: false,
      });
      assert(
        definition.operation === "count" || definition.operation === "sum",
        `${path}.operation`,
        'must be "count" or "sum"',
      );
      validateExpression(definition.where, `${path}.where`, expressionContext);
      assertExpressionType(definition.where, "boolean", `${path}.where`, expressionContext);
      if (definition.operation === "sum") {
        assert(definition.select !== undefined, `${path}.select`, "is required for sum aggregates");
      }
      if (definition.select !== undefined) {
        validateExpression(definition.select, `${path}.select`, expressionContext);
        if (definition.operation === "sum") {
          assertExpressionType(definition.select, "number", `${path}.select`, expressionContext);
        }
      }
      continue;
    }

    fail(`${path}.kind`, `unknown query kind ${JSON.stringify(definition.kind)}`);
  }
}

function resolveAggregateSource(name, context, path) {
  if (Object.hasOwn(context.tables, name)) return { table: name };
  const query = context.queries[name];
  assert(query, path, `references unknown table or collection ${JSON.stringify(name)}`);
  assert(query.kind === "collection", path, "aggregate sources may only be tables or collections");
  return { table: query.from, collection: name };
}

function validateActions(context) {
  for (const name of Object.keys(context.actions)) {
    validateIdentifier(name, `app.actions.${name}`);
  }

  for (const [name, definition] of Object.entries(context.actions)) {
    const path = `app.actions.${name}`;
    assertPlainObject(definition, path);
    assertKeys(definition, TRANSACTION_KEYS, path);
    assert(definition.kind === "transaction", `${path}.kind`, 'must be "transaction"');
    assertPlainObject(definition.params, `${path}.params`);

    for (const [param, type] of Object.entries(definition.params)) {
      validateIdentifier(param, `${path}.params.${param}`);
      validateType(type, `${path}.params.${param}`);
    }

    const scope = expressionScope(context, {
      params: new Set(Object.keys(definition.params)),
      paramTypes: definition.params,
      allowAggregates: true,
    });
    assert(Array.isArray(definition.operations), `${path}.operations`, "must be an array");
    for (let index = 0; index < definition.operations.length; index += 1) {
      validateMutation(definition.operations[index], `${path}.operations[${index}]`, context, scope);
    }
    assert(Array.isArray(definition.invariants), `${path}.invariants`, "must be an array");
    for (let index = 0; index < definition.invariants.length; index += 1) {
      validateExpression(definition.invariants[index], `${path}.invariants[${index}]`, scope);
      assertExpressionType(
        definition.invariants[index],
        "boolean",
        `${path}.invariants[${index}]`,
        scope,
      );
    }
  }
}

function validateMutation(mutation, path, context, scope) {
  assertPlainObject(mutation, path);
  switch (mutation.kind) {
    case "setCell": {
      assertKeys(mutation, new Set(["kind", "name", "value"]), path);
      const cell = context.cells[mutation.name];
      assert(cell, `${path}.name`, `references unknown cell ${JSON.stringify(mutation.name)}`);
      validateExpression(mutation.value, `${path}.value`, scope);
      assertExpressionType(mutation.value, cell.type, `${path}.value`, scope);
      return;
    }
    case "setField": {
      assertKeys(mutation, new Set(["kind", "table", "key", "field", "value"]), path);
      const fieldType = validateTableField(mutation.table, mutation.field, path, context);
      assert(
        mutation.field !== context.tables[mutation.table].key,
        `${path}.field`,
        "primary key fields cannot be changed",
      );
      validateExpression(mutation.key, `${path}.key`, scope);
      validateExpression(mutation.value, `${path}.value`, scope);
      assertExpressionType(
        mutation.key,
        context.tables[mutation.table].fields[context.tables[mutation.table].key],
        `${path}.key`,
        scope,
      );
      assertExpressionType(mutation.value, fieldType, `${path}.value`, scope);
      return;
    }
    case "toggleField": {
      assertKeys(mutation, new Set(["kind", "table", "key", "field"]), path);
      const fieldType = validateTableField(mutation.table, mutation.field, path, context);
      assert(fieldType === "boolean" || fieldType === "any", `${path}.field`, "toggleField requires a boolean field");
      validateExpression(mutation.key, `${path}.key`, scope);
      assertExpressionType(
        mutation.key,
        context.tables[mutation.table].fields[context.tables[mutation.table].key],
        `${path}.key`,
        scope,
      );
      return;
    }
    case "insert": {
      assertKeys(mutation, new Set(["kind", "table", "row"]), path);
      assert(
        Object.hasOwn(context.tables, mutation.table),
        `${path}.table`,
        `references unknown table ${JSON.stringify(mutation.table)}`,
      );
      validateExpression(mutation.row, `${path}.row`, scope);
      assertExpressionType(mutation.row, "object", `${path}.row`, scope);
      if (mutation.row.kind === "literal") {
        validateInsertedRow(mutation.row.value, mutation.table, `${path}.row.value`, context);
      }
      return;
    }
    case "remove":
      assertKeys(mutation, new Set(["kind", "table", "key"]), path);
      assert(
        Object.hasOwn(context.tables, mutation.table),
        `${path}.table`,
        `references unknown table ${JSON.stringify(mutation.table)}`,
      );
      validateExpression(mutation.key, `${path}.key`, scope);
      assertExpressionType(
        mutation.key,
        context.tables[mutation.table].fields[context.tables[mutation.table].key],
        `${path}.key`,
        scope,
      );
      return;
    default:
      fail(`${path}.kind`, `unknown mutation kind ${JSON.stringify(mutation.kind)}`);
  }
}

function validateInsertedRow(row, tableName, path, context) {
  assertPlainObject(row, path);
  const definition = context.tables[tableName];
  for (const field of Object.keys(row)) {
    assert(Object.hasOwn(definition.fields, field), `${path}.${field}`, "is not declared in table.fields");
  }
  for (const [field, type] of Object.entries(definition.fields)) {
    assert(Object.hasOwn(row, field), path, `is missing required field ${JSON.stringify(field)}`);
    assertType(row[field], type, `${path}.${field}`);
  }
  const key = row[definition.key];
  assert(
    typeof key === "string" || (typeof key === "number" && Number.isFinite(key)),
    `${path}.${definition.key}`,
    "table keys must be JSON-compatible strings or finite numbers",
  );
}

function validateTableField(tableName, field, path, context) {
  const table = context.tables[tableName];
  assert(table, `${path}.table`, `references unknown table ${JSON.stringify(tableName)}`);
  assert(
    Object.hasOwn(table.fields, field),
    `${path}.field`,
    `references unknown field ${JSON.stringify(field)} on table ${JSON.stringify(tableName)}`,
  );
  return table.fields[field];
}

function validateViewNode(node, path, context, rowScope) {
  assertPlainObject(node, path);
  switch (node.kind) {
    case "element":
      validateElement(node, path, context, rowScope);
      return;
    case "staticText":
      assertKeys(node, TEXT_KEYS, path);
      assert(typeof node.value === "string", `${path}.value`, "must be a string");
      return;
    case "text":
      assertKeys(node, TEXT_KEYS, path);
      validateExpression(
        node.value,
        `${path}.value`,
        viewExpressionScope(context, rowScope),
      );
      return;
    case "each":
      validateEach(node, path, context, rowScope);
      return;
    default:
      fail(`${path}.kind`, `unknown view node kind ${JSON.stringify(node.kind)}`);
  }
}

function validateElement(node, path, context, rowScope) {
  assertKeys(node, ELEMENT_KEYS, path);
  assert(typeof node.tag === "string" && TAG_NAME.test(node.tag), `${path}.tag`, "is not a safe element tag");
  assert(!["script", "style"].includes(node.tag.toLowerCase()), `${path}.tag`, "script and style elements are not allowed in app views");
  assert(!DOCUMENT_ELEMENTS.has(node.tag.toLowerCase()), `${path}.tag`, "document shell elements are emitted by the compiler");
  assertPlainObject(node.attrs, `${path}.attrs`);
  assertPlainObject(node.props, `${path}.props`);
  assertPlainObject(node.classes, `${path}.classes`);
  assertPlainObject(node.on, `${path}.on`);
  assert(Array.isArray(node.children), `${path}.children`, "must be an array");

  for (const [name, value] of Object.entries(node.attrs)) {
    validateAttributeName(name, `${path}.attrs.${name}`);
    assert(!RESERVED_ATTRIBUTES.has(name.toLowerCase()), `${path}.attrs.${name}`, "uses a compiler-reserved attribute");
    assert(!/^on/i.test(name), `${path}.attrs.${name}`, "inline event attributes are not allowed; use element.on");
    assert(
      value === null || ["string", "number", "boolean"].includes(typeof value),
      `${path}.attrs.${name}`,
      "must be a string, finite number, boolean, or null",
    );
    if (typeof value === "number") {
      assert(Number.isFinite(value), `${path}.attrs.${name}`, "must be finite");
    }
  }

  const scope = viewExpressionScope(context, rowScope);
  for (const [name, expression] of Object.entries(node.props)) {
    validateAttributeName(name, `${path}.props.${name}`);
    assert(!RESERVED_ATTRIBUTES.has(name.toLowerCase()), `${path}.props.${name}`, "uses a compiler-reserved property");
    assert(!/^on/i.test(name), `${path}.props.${name}`, "event handlers must use element.on");
    assert(
      !STRUCTURAL_PROPERTIES.has(name),
      `${path}.props.${name}`,
      "DOM-structural properties would invalidate compiled binding targets; use view children",
    );
    validateExpression(expression, `${path}.props.${name}`, scope);
  }

  for (const [name, expression] of Object.entries(node.classes)) {
    assert(typeof name === "string" && name.length > 0 && !/\s/.test(name), `${path}.classes.${name}`, "must be one non-empty class token");
    validateExpression(expression, `${path}.classes.${name}`, scope);
    assertExpressionType(expression, "boolean", `${path}.classes.${name}`, scope);
  }

  for (const [event, route] of Object.entries(node.on)) {
    assert(EVENT_NAME.test(event), `${path}.on.${event}`, "is not a safe event name");
    assert(event === event.toLowerCase(), `${path}.on.${event}`, "event names must be lowercase");
    validateEventRoute(route, `${path}.on.${event}`, context, rowScope);
  }

  if (VOID_ELEMENTS.has(node.tag.toLowerCase())) {
    assert(node.children.length === 0, `${path}.children`, `${node.tag} is a void element and cannot have children`);
  }
  if (node.tag.toLowerCase() === "textarea") {
    const hasValue = Object.hasOwn(node.attrs, "value") || Object.hasOwn(node.props, "value");
    if (hasValue) {
      assert(node.children.length === 0, `${path}.children`, "textarea value and child content cannot both be specified");
    } else {
      assert(
        node.children.every((child) => child.kind === "staticText"),
        `${path}.children`,
        "textarea children must be static text; use a value property for dynamic content",
      );
    }
  }
  for (let index = 0; index < node.children.length; index += 1) {
    validateViewNode(node.children[index], `${path}.children[${index}]`, context, rowScope);
  }
}

function validateEach(node, path, context, rowScope) {
  assertKeys(node, EACH_KEYS, path);
  assert(!rowScope, path, "nested collections inside row templates are not supported");
  const query = context.queries[node.query];
  assert(query, `${path}.query`, `references unknown query ${JSON.stringify(node.query)}`);
  assert(query.kind === "collection", `${path}.query`, "each requires a collection query");
  assert(node.template?.kind === "element", `${path}.template`, "must have exactly one element root");
  assert(
    !context.templateQueries.has(node.query),
    `${path}.query`,
    "a collection may only have one row template in a compiled view",
  );
  context.templateQueries.add(node.query);
  validateElement(node.template, `${path}.template`, context, node.query);
}

function validateEventRoute(route, path, context, rowScope) {
  assertPlainObject(route, path);
  assertKeys(route, EVENT_ROUTE_KEYS, path);
  assert(route.kind === "eventRoute", `${path}.kind`, 'must be "eventRoute"');
  const action = context.actions[route.action];
  assert(action, `${path}.action`, `references unknown action ${JSON.stringify(route.action)}`);
  assertPlainObject(route.args, `${path}.args`);
  assert(typeof route.preventDefault === "boolean", `${path}.preventDefault`, "must be boolean");

  const expected = Object.keys(action.params);
  const actual = Object.keys(route.args);
  for (const param of expected) {
    assert(Object.hasOwn(route.args, param), `${path}.args`, `is missing action parameter ${JSON.stringify(param)}`);
  }
  for (const param of actual) {
    assert(Object.hasOwn(action.params, param), `${path}.args.${param}`, "is not declared by the action");
  }

  const scope = viewExpressionScope(context, rowScope, true);
  for (const [name, expression] of Object.entries(route.args)) {
    validateExpression(expression, `${path}.args.${name}`, scope);
    assertExpressionType(expression, action.params[name], `${path}.args.${name}`, scope);
  }
}

function expressionScope(
  context,
  {
    fields = null,
    fieldTypes = null,
    params = null,
    paramTypes = null,
    row = false,
    rowKeyType = null,
    event = false,
    allowAggregates = false,
  } = {},
) {
  return {
    context,
    fields,
    fieldTypes,
    params,
    paramTypes,
    row,
    rowKeyType,
    event,
    allowAggregates,
  };
}

function viewExpressionScope(context, rowScope, event = false) {
  if (!rowScope) {
    return expressionScope(context, { event, allowAggregates: true });
  }
  const table = context.queries[rowScope].from;
  return expressionScope(context, {
    fields: context.tableSchemas.get(table),
    fieldTypes: context.tables[table].fields,
    row: true,
    rowKeyType: context.tables[table].fields[context.tables[table].key],
    event,
    allowAggregates: true,
  });
}

function validateExpression(expression, path, scope) {
  assert(isExpression(expression), path, "must be a supported expression node");
  const { context } = scope;

  switch (expression.kind) {
    case "literal":
      assertKeys(expression, new Set(["kind", "value"]), path);
      return;
    case "cell":
      assertKeys(expression, new Set(["kind", "name"]), path);
      assert(
        Object.hasOwn(context.cells, expression.name),
        `${path}.name`,
        `references unknown cell ${JSON.stringify(expression.name)}`,
      );
      return;
    case "field":
      assertKeys(expression, new Set(["kind", "name"]), path);
      assert(scope.fields, path, "field references are only valid in row/query scopes");
      assert(scope.fields.has(expression.name), `${path}.name`, `references unknown field ${JSON.stringify(expression.name)}`);
      return;
    case "aggregate": {
      assertKeys(expression, new Set(["kind", "name"]), path);
      assert(scope.allowAggregates, path, "aggregate references are not valid in this scope");
      const query = context.queries[expression.name];
      assert(query?.kind === "aggregate", `${path}.name`, `references unknown aggregate ${JSON.stringify(expression.name)}`);
      return;
    }
    case "param":
      assertKeys(expression, new Set(["kind", "name"]), path);
      assert(scope.params, path, "parameter references are only valid inside actions");
      assert(scope.params.has(expression.name), `${path}.name`, `references unknown parameter ${JSON.stringify(expression.name)}`);
      return;
    case "lookup": {
      assertKeys(expression, new Set(["kind", "table", "key", "field"]), path);
      validateTableField(expression.table, expression.field, path, context);
      validateExpression(expression.key, `${path}.key`, scope);
      assertExpressionType(
        expression.key,
        context.tables[expression.table].fields[context.tables[expression.table].key],
        `${path}.key`,
        scope,
      );
      return;
    }
    case "operation": {
      assertKeys(expression, new Set(["kind", "operator", "operands"]), path);
      const arity = SUPPORTED_OPERATIONS.get(expression.operator);
      assert(arity, `${path}.operator`, `unknown operator ${JSON.stringify(expression.operator)}`);
      assert(Array.isArray(expression.operands), `${path}.operands`, "must be an array");
      assert(
        expression.operands.length >= arity[0] && expression.operands.length <= arity[1],
        `${path}.operands`,
        `operator ${expression.operator} expects ${formatArity(arity)} operand(s)`,
      );
      for (let index = 0; index < expression.operands.length; index += 1) {
        validateExpression(expression.operands[index], `${path}.operands[${index}]`, scope);
      }
      return;
    }
    case "eventValue":
    case "eventChecked":
      assertKeys(expression, new Set(["kind"]), path);
      assert(scope.event, path, `${expression.kind} is only valid in event route arguments`);
      return;
    case "rowKey":
      assertKeys(expression, new Set(["kind"]), path);
      assert(scope.row && scope.event, path, "rowKey is only valid inside a row template event route");
      return;
    case "rowField":
      assertKeys(expression, new Set(["kind", "name"]), path);
      assert(scope.row && scope.event && scope.fields, path, "rowField is only valid inside a row template event route");
      assert(scope.fields.has(expression.name), `${path}.name`, `references unknown row field ${JSON.stringify(expression.name)}`);
      return;
    default:
      fail(`${path}.kind`, `unknown expression kind ${JSON.stringify(expression.kind)}`);
  }
}

function createPlanCompiler(app) {
  let bindingSequence = 0;
  let eventSequence = 0;
  const bindings = [];
  const rowTemplates = {};
  const eventRoutes = {};

  function addBinding(kind, expression, scope, name) {
    const id = `b${bindingSequence++}`;
    const binding = {
      id,
      scope,
      kind,
      ...(name === undefined ? {} : { name }),
      expr: expression,
      deps: collectDependencies(expression),
    };
    bindings.push(binding);
    return id;
  }

  function addEventRoute(event, route, scope) {
    const id = `e${eventSequence++}`;
    const deps = [];
    for (const expression of Object.values(route.args)) {
      collectDependencies(expression, deps);
    }
    eventRoutes[id] = {
      id,
      event,
      scope,
      action: route.action,
      args: route.args,
      preventDefault: route.preventDefault,
      deps,
    };
    return id;
  }

  function compileElement(node, scope) {
    const bindingIds = [];
    for (const [name, expression] of Object.entries(node.props)) {
      bindingIds.push(addBinding("prop", expression, scope, name));
    }
    for (const [name, expression] of Object.entries(node.classes)) {
      bindingIds.push(addBinding("class", expression, scope, name));
    }

    const events = {};
    for (const [event, route] of Object.entries(node.on)) {
      events[event] = addEventRoute(event, route, scope);
    }

    return {
      kind: "element",
      tag: node.tag,
      attrs: node.attrs,
      bindingIds,
      events,
      children: node.children.map((child) => compileNode(child, scope)),
    };
  }

  function compileEach(node) {
    const bindingStart = bindings.length;
    const routesBefore = new Set(Object.keys(eventRoutes));
    const root = compileElement(node.template, node.query);
    const bindingIds = bindings
      .slice(bindingStart)
      .filter((binding) => binding.scope === node.query)
      .map((binding) => binding.id);
    const routeIds = Object.keys(eventRoutes).filter(
      (id) => !routesBefore.has(id) && eventRoutes[id].scope === node.query,
    );
    rowTemplates[node.query] = {
      id: node.query,
      query: node.query,
      root,
      bindingIds,
      routeIds,
    };
    return { kind: "each", query: node.query, templateId: node.query };
  }

  function compileNode(node, scope) {
    switch (node.kind) {
      case "element":
        return compileElement(node, scope);
      case "staticText":
        return { kind: "staticText", value: node.value };
      case "text":
        return {
          kind: "text",
          bindingId: addBinding("text", node.value, scope),
        };
      case "each":
        return compileEach(node);
      default:
        throw new Error(`Compiler invariant violated: unknown node ${node.kind}`);
    }
  }

  return { bindings, rowTemplates, eventRoutes, compileNode };
}

function createRenderContext(snapshot, plan, overrides = {}) {
  return {
    cells: snapshot.cells,
    tables: snapshot.tables,
    aggregates: snapshot.aggregates,
    plan,
    tableKeys: Object.fromEntries(
      Object.entries(plan.state.tables).map(([name, table]) => [name, table.key]),
    ),
    row: null,
    key: undefined,
    params: {},
    event: null,
    ...overrides,
  };
}

function renderNode(node, plan, snapshot, context, options = {}) {
  switch (node.kind) {
    case "element":
      return renderElement(node, plan, snapshot, context, options);
    case "staticText":
      return escapeText(node.value);
    case "text": {
      const binding = findBinding(plan, node.bindingId);
      const marker = context.key === undefined
        ? `<!--d:${binding.id}-->`
        : `<!--d:${binding.id}:${encodeCommentKey(context.key)}-->`;
      return marker + escapeText(toText(evaluate(binding.expr, context)));
    }
    case "each":
      return renderCollection(node, plan, snapshot, context);
    default:
      throw new Error(`Renderer invariant violated: unknown node ${node.kind}`);
  }
}

function renderElement(node, plan, snapshot, context, { rowKey } = {}) {
  const attributes = new Map();
  let textareaValue;
  for (const [name, value] of Object.entries(node.attrs)) {
    if (node.tag.toLowerCase() === "textarea" && name === "value") {
      textareaValue = value;
    } else {
      attributes.set(name, value);
    }
  }

  const classNames = new Set(
    String(attributes.get("class") ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );

  for (const bindingId of node.bindingIds) {
    const binding = findBinding(plan, bindingId);
    const value = evaluate(binding.expr, context);
    if (binding.kind === "class") {
      if (value) classNames.add(binding.name);
      else classNames.delete(binding.name);
    } else if (binding.kind === "prop") {
      if (node.tag.toLowerCase() === "textarea" && binding.name === "value") {
        textareaValue = value;
      } else {
        const attribute = propertyToAttribute(binding.name);
        if (attribute === "class") {
          classNames.clear();
          for (const className of String(value ?? "").split(/\s+/).filter(Boolean)) {
            classNames.add(className);
          }
        } else {
          attributes.set(attribute, value);
        }
      }
    }
  }

  if (classNames.size > 0) attributes.set("class", [...classNames].join(" "));
  else attributes.delete("class");
  if (node.bindingIds.length > 0) attributes.set("data-delta-bind", node.bindingIds.join(" "));
  if (rowKey !== undefined) attributes.set("data-delta-row", encodeKey(rowKey));

  const eventMarkers = Object.entries(node.events).map(([event, route]) => `${event}:${route}`);
  if (eventMarkers.length > 0) attributes.set("data-delta-on", eventMarkers.join(" "));

  let output = `<${node.tag}${renderAttributes(attributes)}>`;
  if (VOID_ELEMENTS.has(node.tag.toLowerCase())) return output;
  if (textareaValue !== undefined) {
    return `${output}${escapeText(toText(textareaValue))}</${node.tag}>`;
  }
  for (const child of node.children) {
    output += renderNode(child, plan, snapshot, context);
  }
  return `${output}</${node.tag}>`;
}

function renderCollection(node, plan, snapshot, parentContext) {
  const template = plan.rowTemplates[node.templateId];
  const query = plan.queries[node.query];
  const table = plan.state.tables[query.from];
  const keys = snapshot.collections[node.query] ?? [];
  const rows = snapshot.tables[query.from] ?? [];
  let output = `<!--r:${node.query}:start-->`;

  for (const key of keys) {
    const row = rows.find((candidate) => Object.is(candidate[table.key], key));
    if (!row) {
      throw new Error(`Snapshot collection ${node.query} references missing row key ${JSON.stringify(key)}`);
    }
    const context = createRenderContext(snapshot, plan, {
      ...parentContext,
      row,
      key,
    });
    output += renderElement(template.root, plan, snapshot, context, { rowKey: key });
  }

  return `${output}<!--r:${node.query}:end-->`;
}

function findBinding(plan, id) {
  const binding = plan.bindings.find((candidate) => candidate.id === id);
  if (!binding) throw new Error(`Compiler invariant violated: unknown binding ${id}`);
  return binding;
}

function renderAttributes(attributes) {
  let output = "";
  for (const [name, value] of attributes) {
    if (value === null || value === undefined) continue;
    const normalized = name.toLowerCase();
    if (BOOLEAN_ATTRIBUTES.has(normalized)) {
      if (value) output += ` ${name}`;
      continue;
    }
    output += ` ${name}="${escapeAttribute(String(value))}"`;
  }
  return output;
}

function propertyToAttribute(name) {
  switch (name) {
    case "className":
      return "class";
    case "htmlFor":
      return "for";
    case "readOnly":
      return "readonly";
    case "tabIndex":
      return "tabindex";
    default:
      return name;
  }
}

function encodeCommentKey(key) {
  // encodeURIComponent intentionally leaves '-' untouched, but a double
  // hyphen is forbidden inside HTML comments. Percent-encoding it again is
  // decodeURIComponent-compatible with the runtime's decodeKey helper.
  return encodeKey(key).replace(/-/g, "%2D");
}

function createBrowserModule(plan, runtimeImport) {
  const runtime = serializeJsonForScript(runtimeImport);
  const serializedPlan = serializeJsonForScript(plan);
  return [
    `import { resume } from ${runtime};`,
    `const plan = ${serializedPlan};`,
    'const capsule = document.querySelector("script#delta-resume[type=\\"application/json\\"]");',
    'if (!capsule) throw new Error("Missing #delta-resume capsule");',
    'const snapshot = JSON.parse(capsule.textContent || "null");',
    "resume(plan, document, snapshot);",
  ].join("\n");
}

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function serializeJsonForHtml(value) {
  return serializeJsonForScript(value);
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeStyle(value) {
  // CSS escapes reconstruct '<' for the CSS parser while ensuring the HTML
  // raw-text parser can never encounter a literal closing style tag.
  return value.replace(/</g, "\\3C ");
}

function toText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function validateIdentifier(value, path) {
  assert(typeof value === "string" && IDENTIFIER.test(value), path, "must be a safe identifier");
  assert(!UNSAFE_IDENTIFIER_KEYS.has(value), path, "must not be a prototype-reserved key");
}

function validateAttributeName(value, path) {
  assert(typeof value === "string" && ATTRIBUTE_NAME.test(value), path, "is not a safe attribute name");
}

function validateType(type, path) {
  assert(typeof type === "string" && SUPPORTED_TYPES.has(type), path, `unsupported type ${JSON.stringify(type)}`);
}

function assertType(value, type, path) {
  if (type === "any") return;
  const actual = inferSerializableType(value);
  assert(actual === type, path, `expected ${type}, received ${actual}`);
}

function inferSerializableType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function assertExpressionType(expression, expected, path, scope) {
  if (expected === "any") return;
  const actual = inferExpressionType(expression, scope);
  assert(
    actual === "any" || actual === expected,
    path,
    `expected expression of type ${expected}, received ${actual}`,
  );
}

function inferExpressionType(expression, scope) {
  switch (expression.kind) {
    case "literal":
      return inferSerializableType(expression.value);
    case "cell":
      return scope.context.cells[expression.name]?.type ?? "any";
    case "field":
    case "rowField":
      return scope.fieldTypes?.[expression.name] ?? "any";
    case "aggregate":
      return "number";
    case "param":
      return scope.paramTypes?.[expression.name] ?? "any";
    case "lookup":
      return scope.context.tables[expression.table]?.fields?.[expression.field] ?? "any";
    case "eventValue":
      return "string";
    case "eventChecked":
      return "boolean";
    case "rowKey":
      return scope.rowKeyType ?? "any";
    case "operation": {
      switch (expression.operator) {
        case "not":
        case "equals":
        case "notEquals":
        case "and":
        case "or":
        case "contains":
          return "boolean";
        case "lower":
          return "string";
        case "subtract":
        case "multiply":
          return "number";
        case "add": {
          const types = expression.operands.map((operand) =>
            inferExpressionType(operand, scope),
          );
          if (types.every((type) => type === "number")) return "number";
          if (types.some((type) => type === "string")) return "string";
          return "any";
        }
        case "coalesce": {
          const types = expression.operands
            .map((operand) => inferExpressionType(operand, scope))
            .filter((type) => type !== "null");
          return types.length > 0 && types.every((type) => type === types[0])
            ? types[0]
            : "any";
        }
        case "choose": {
          const whenTrue = inferExpressionType(expression.operands[1], scope);
          const whenFalse = inferExpressionType(expression.operands[2], scope);
          return whenTrue === whenFalse ? whenTrue : "any";
        }
        default:
          return "any";
      }
    }
    default:
      return "any";
  }
}

function formatArity([minimum, maximum]) {
  if (minimum === maximum) return String(minimum);
  return maximum === Infinity ? `at least ${minimum}` : `${minimum}-${maximum}`;
}

function assertPlainObject(value, path) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value) &&
      (prototype === Object.prototype || prototype === null),
    path,
    "must be a plain object",
  );
}

function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${path}.${key}`, "is not part of the constrained IR schema");
  }
}

function assertSerializable(value, path, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), path, "must be a finite JSON number");
    assert(!Object.is(value, -0), path, "must not be negative zero because JSON cannot preserve it");
    return;
  }
  if (["undefined", "function", "symbol", "bigint"].includes(typeof value)) {
    fail(path, `contains non-serializable ${typeof value}`);
  }
  assert(typeof value === "object", path, "is not JSON serializable");
  assert(!ancestors.has(value), path, "contains a circular reference");
  const prototype = Object.getPrototypeOf(value);
  assert(
    Array.isArray(value) || prototype === Object.prototype || prototype === null,
    path,
    "contains a non-plain object",
  );
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      assert(typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key), path, "contains a non-JSON array property");
      assert(Number(key) < value.length, `${path}.${key}`, "is outside the JSON array length");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert(descriptor?.enumerable && !descriptor.get && !descriptor.set, `${path}[${key}]`, "must be an enumerable data property");
    }
    for (let index = 0; index < value.length; index += 1) {
      assert(Object.hasOwn(value, index), `${path}[${index}]`, "contains an array hole");
      assertSerializable(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      assert(typeof key === "string", path, "contains a symbol-keyed property");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert(descriptor?.enumerable && !descriptor.get && !descriptor.set, `${path}.${key}`, "must be an enumerable data property");
    }
    for (const [key, child] of Object.entries(value)) {
      // `aggregate()` in the public IR intentionally materializes its optional
      // `select` field as undefined. JSON omits that one optional field, which
      // is equivalent to it not being present; no other undefined value is
      // accepted.
      if (child === undefined && value.kind === "aggregate" && key === "select") {
        continue;
      }
      assertSerializable(child, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assert(condition, path, message) {
  if (!condition) fail(path, message);
}

function fail(path, message) {
  throw new TypeError(`Invalid Kelta app at ${path}: ${message}`);
}
