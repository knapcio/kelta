const expression = (kind, fields = {}) => Object.freeze({ kind, ...fields });

export const value = (input) =>
  input && typeof input === "object" && typeof input.kind === "string"
    ? input
    : expression("literal", { value: input });

export const ref = Object.freeze({
  cell: (name) => expression("cell", { name }),
  field: (name) => expression("field", { name }),
  aggregate: (name) => expression("aggregate", { name }),
  param: (name) => expression("param", { name }),
  lookup: (table, key, field) =>
    expression("lookup", { table, key: value(key), field }),
});

const operation = (operator, operands) =>
  expression("operation", {
    operator,
    operands: operands.map(value),
  });

export const calc = Object.freeze({
  not: (input) => operation("not", [input]),
  equals: (left, right) => operation("equals", [left, right]),
  notEquals: (left, right) => operation("notEquals", [left, right]),
  and: (...inputs) => operation("and", inputs),
  or: (...inputs) => operation("or", inputs),
  contains: (haystack, needle) => operation("contains", [haystack, needle]),
  lower: (input) => operation("lower", [input]),
  add: (...inputs) => operation("add", inputs),
  subtract: (left, right) => operation("subtract", [left, right]),
  multiply: (...inputs) => operation("multiply", inputs),
  coalesce: (...inputs) => operation("coalesce", inputs),
  choose: (condition, whenTrue, whenFalse) =>
    operation("choose", [condition, whenTrue, whenFalse]),
});

export const fromEvent = Object.freeze({
  value: () => expression("eventValue"),
  checked: () => expression("eventChecked"),
  rowKey: () => expression("rowKey"),
  rowField: (name) => expression("rowField", { name }),
});

export const cell = (initial, options = {}) => ({
  kind: "cell",
  type: options.type ?? inferType(initial),
  initial,
});

export const table = ({ key, fields, initial = [] }) => ({
  kind: "table",
  key,
  fields: { ...fields },
  initial: initial.map((row) => ({ ...row })),
});

export const collection = (from, options = {}) => ({
  kind: "collection",
  from,
  where: value(options.where ?? true),
  orderBy: normalizeOrder(options.orderBy),
});

export const aggregate = (from, options = {}) => ({
  kind: "aggregate",
  from,
  operation: options.operation ?? "count",
  where: value(options.where ?? true),
  select: options.select === undefined ? undefined : value(options.select),
});

export const transaction = ({ params = {}, do: operations = [], require = [] }) => ({
  kind: "transaction",
  params: { ...params },
  operations: [...operations],
  invariants: require.map(value),
});

export const mutate = Object.freeze({
  setCell: (name, nextValue) => ({
    kind: "setCell",
    name,
    value: value(nextValue),
  }),
  setField: (tableName, key, field, nextValue) => ({
    kind: "setField",
    table: tableName,
    key: value(key),
    field,
    value: value(nextValue),
  }),
  toggleField: (tableName, key, field) => ({
    kind: "toggleField",
    table: tableName,
    key: value(key),
    field,
  }),
  insert: (tableName, row) => ({
    kind: "insert",
    table: tableName,
    row: value(row),
  }),
  remove: (tableName, key) => ({
    kind: "remove",
    table: tableName,
    key: value(key),
  }),
});

export const text = (input) => ({ kind: "text", value: value(input) });

export const each = (query, template) => ({
  kind: "each",
  query,
  template,
});

export const handle = (action, args = {}, options = {}) => ({
  kind: "eventRoute",
  action,
  args: Object.fromEntries(
    Object.entries(args).map(([name, input]) => [name, value(input)]),
  ),
  preventDefault: options.preventDefault ?? false,
});

export const element = (tag, options = {}, children = []) => ({
  kind: "element",
  tag,
  attrs: { ...(options.attrs ?? {}) },
  props: normalizeExpressionMap(options.props),
  classes: normalizeExpressionMap(options.classes),
  on: { ...(options.on ?? {}) },
  children: normalizeChildren(children),
});

export const defineApp = (definition) => ({
  kind: "app",
  name: definition.name ?? "Kelta App",
  state: {
    cells: { ...(definition.state?.cells ?? {}) },
    tables: { ...(definition.state?.tables ?? {}) },
  },
  queries: { ...(definition.queries ?? {}) },
  actions: { ...(definition.actions ?? {}) },
  view: definition.view,
});

export function collectDependencies(input, output = []) {
  if (!input || typeof input !== "object") return output;

  switch (input.kind) {
    case "cell":
      pushUnique(output, { kind: "cell", name: input.name });
      break;
    case "field":
      pushUnique(output, { kind: "field", name: input.name });
      break;
    case "aggregate":
      pushUnique(output, { kind: "aggregate", name: input.name });
      break;
    case "lookup":
      collectDependencies(input.key, output);
      pushUnique(output, {
        kind: "tableField",
        table: input.table,
        name: input.field,
      });
      break;
    case "operation":
      for (const operand of input.operands) collectDependencies(operand, output);
      break;
    default:
      break;
  }

  return output;
}

export function isExpression(input) {
  return Boolean(
    input &&
      typeof input === "object" &&
      [
        "literal",
        "cell",
        "field",
        "aggregate",
        "param",
        "lookup",
        "operation",
        "eventValue",
        "eventChecked",
        "rowKey",
        "rowField",
      ].includes(input.kind),
  );
}

function normalizeOrder(orderBy = []) {
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  return items.filter(Boolean).map((item) => {
    if (typeof item === "string") {
      return { by: ref.field(item), direction: "ascending" };
    }

    return {
      by: value(item.by),
      direction: item.direction ?? "ascending",
    };
  });
}

function normalizeChildren(children) {
  const list = Array.isArray(children) ? children : [children];
  return list
    .flat(Infinity)
    .filter((child) => child !== undefined && child !== null && child !== false)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? { kind: "staticText", value: String(child) }
        : child,
    );
}

function normalizeExpressionMap(input = {}) {
  return Object.fromEntries(
    Object.entries(input).map(([name, mapValue]) => [name, value(mapValue)]),
  );
}

function inferType(input) {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  return typeof input;
}

function pushUnique(output, dependency) {
  const serialized = JSON.stringify(dependency);
  if (!output.some((candidate) => JSON.stringify(candidate) === serialized)) {
    output.push(dependency);
  }
}
