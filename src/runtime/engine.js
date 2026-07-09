export function encodeKey(key) {
  assertKey(key);
  return encodeURIComponent(JSON.stringify(key));
}

export function decodeKey(encoded) {
  if (typeof encoded !== "string") {
    throw new TypeError("Encoded keys must be strings");
  }

  const key = JSON.parse(decodeURIComponent(encoded));
  assertKey(key);
  return key;
}

export function evaluate(expr, context = {}) {
  if (expr === null || expr === undefined || typeof expr !== "object") {
    return expr;
  }

  switch (expr.kind) {
    case "literal":
      return expr.value;

    case "cell":
      return readNamed(context, "cell", expr.name);

    case "field":
    case "rowField":
      return context.row?.[expr.name];

    case "aggregate":
      return readNamed(context, "aggregate", expr.name);

    case "param":
      return context.params?.[expr.name];

    case "lookup": {
      const key = evaluate(expr.key, context);
      const row = readTableRow(context, expr.table, key);
      return row?.[expr.field];
    }

    case "eventValue":
      return context.event?.value ?? context.event?.target?.value;

    case "eventChecked":
      return context.event?.checked ?? context.event?.target?.checked;

    case "rowKey":
      return context.key;

    case "operation":
      return evaluateOperation(expr.operator, expr.operands ?? [], context);

    default:
      throw new TypeError(`Unknown expression kind: ${String(expr.kind)}`);
  }
}

export function createInitialSnapshot(plan) {
  const base = loadBaseState(plan);
  const derived = computeAllDerived(plan, base.cells, base.tables);
  return serializeState({ ...base, ...derived });
}

export function createEngine(plan, options = {}) {
  validatePlan(plan);

  const base = loadBaseState(plan, options.snapshot);
  const derived =
    loadDerivedSnapshot(plan, options.snapshot, base) ??
    computeAllDerived(plan, base.cells, base.tables);
  let state = { ...base, ...derived };
  let activeTransaction = false;
  let lastJournal = emptyJournal();

  const adapter = options.adapter ?? {};
  const queryOrder = getQueryOrder(plan);
  const queryMeta = buildQueryMetadata(plan, queryOrder);
  const bindingMeta = (plan.bindings ?? []).map((binding) => ({
    binding,
    deps: normalizeDependencies(binding.deps ?? collectDependencies(binding.expr)),
  }));

  const engine = {
    get lastJournal() {
      return cloneJournal(lastJournal);
    },

    getCell(name) {
      requireCell(plan, name);
      return cloneData(state.cells[name]);
    },

    getRow(tableName, key) {
      requireTable(plan, tableName);
      const row = state.tables.get(tableName).get(key);
      return row === undefined ? undefined : cloneData(row);
    },

    getCollection(name) {
      requireCollection(plan, name);
      return [...state.collections[name]];
    },

    getAggregate(name) {
      requireAggregate(plan, name);
      return state.aggregates[name];
    },

    snapshot() {
      return serializeState(state);
    },

    transaction(fn) {
      return runTransaction(fn);
    },

    dispatch(actionName, params = {}) {
      const action =
        typeof actionName === "string" ? plan.actions?.[actionName] : actionName;
      if (!action || action.kind !== "transaction") {
        throw new TypeError(`Unknown action: ${String(actionName)}`);
      }

      const label = typeof actionName === "string" ? actionName : "<anonymous>";
      validateActionParams(action, params, label);

      return runTransaction(
        (tx, draft) => {
          for (const operation of action.operations ?? []) {
            applyMutation(operation, tx, makeContext(draft, { params }));
          }
        },
        (draft) => {
          const nextDerived = computeAllDerived(plan, draft.cells, draft.tables);
          draft.collections = nextDerived.collections;
          draft.aggregates = nextDerived.aggregates;
          const context = makeContext(draft, { params });
          for (const invariant of action.invariants ?? []) {
            if (!evaluate(invariant, context)) {
              throw new Error(`Invariant failed for action "${label}"`);
            }
          }
        },
      );
    },
  };

  return engine;

  function runTransaction(fn, validateDraft) {
    if (typeof fn !== "function") {
      throw new TypeError("transaction() expects a function");
    }
    if (activeTransaction) {
      throw new Error("Nested transactions are not supported");
    }

    activeTransaction = true;
    const previous = state;
    const draft = createDraft(previous);
    const touchedCells = new Set();
    const touchedRows = new Map();
    const copiedTables = new Set();
    const tx = createTransactionApi(
      plan,
      draft,
      touchedCells,
      touchedRows,
      copiedTables,
    );

    let result;
    try {
      result = fn(tx, draft);
      if (result && typeof result.then === "function") {
        throw new TypeError("Transactions must be synchronous");
      }
      validateDraft?.(draft);
    } catch (error) {
      activeTransaction = false;
      throw error;
    }

    const baseChanges = collectBaseChanges(
      previous,
      draft,
      touchedCells,
      touchedRows,
    );

    if (baseChanges.cells.length === 0 && baseChanges.tables.length === 0) {
      activeTransaction = false;
      lastJournal = emptyJournal();
      return result;
    }

    let propagation;
    try {
      propagation = propagateDerived(
        plan,
        previous,
        draft,
        baseChanges,
        queryOrder,
        queryMeta,
      );
    } catch (error) {
      activeTransaction = false;
      throw error;
    }

    state = propagation.state;
    const collectionChanges = propagation.collections;
    const aggregateChanges = propagation.aggregates;
    const patches = computeBindingPatches(
      plan,
      bindingMeta,
      previous,
      state,
      baseChanges,
      collectionChanges,
      aggregateChanges,
    );

    const collectionJournal = collectionChanges.map((change) => ({
      query: change.query,
      oldKeys: [...change.oldKeys],
      newKeys: [...change.newKeys],
      mode: change.mode,
      operations: createCollectionOperations(change.oldKeys, change.newKeys),
    }));

    lastJournal = {
      cells: baseChanges.cells.map(cloneChange),
      tables: baseChanges.tables.map(cloneChange),
      collections: collectionJournal.map(cloneChange),
      aggregates: aggregateChanges.map(cloneChange),
      patches: patches.map(({ binding, key, value }) => ({
        binding: binding.id,
        key,
        value: cloneData(value),
      })),
    };

    activeTransaction = false;
    emitAdapterChanges(
      adapter,
      collectionChanges,
      collectionJournal,
      patches,
      lastJournal,
    );
    return result;
  }
}

function evaluateOperation(operator, operands, context) {
  switch (operator) {
    case "not":
      return !evaluate(operands[0], context);

    case "equals":
      return Object.is(
        evaluate(operands[0], context),
        evaluate(operands[1], context),
      );

    case "notEquals":
      return !Object.is(
        evaluate(operands[0], context),
        evaluate(operands[1], context),
      );

    case "and":
      for (const operand of operands) {
        if (!evaluate(operand, context)) return false;
      }
      return true;

    case "or":
      for (const operand of operands) {
        if (evaluate(operand, context)) return true;
      }
      return false;

    case "contains": {
      const haystack = evaluate(operands[0], context);
      const needle = evaluate(operands[1], context);
      if (haystack === null || haystack === undefined) return false;
      if (typeof haystack.includes === "function") return haystack.includes(needle);
      if (typeof haystack.has === "function") return haystack.has(needle);
      return false;
    }

    case "lower": {
      const value = evaluate(operands[0], context);
      return String(value ?? "").toLowerCase();
    }

    case "add": {
      if (operands.length === 0) return 0;
      let result = evaluate(operands[0], context);
      for (let index = 1; index < operands.length; index += 1) {
        result += evaluate(operands[index], context);
      }
      return result;
    }

    case "subtract":
      return evaluate(operands[0], context) - evaluate(operands[1], context);

    case "multiply": {
      let result = 1;
      for (const operand of operands) result *= evaluate(operand, context);
      return result;
    }

    case "coalesce":
      for (const operand of operands) {
        const value = evaluate(operand, context);
        if (value !== null && value !== undefined) return value;
      }
      return undefined;

    case "choose":
      return evaluate(operands[0], context)
        ? evaluate(operands[1], context)
        : evaluate(operands[2], context);

    default:
      throw new TypeError(`Unknown operation: ${String(operator)}`);
  }
}

function readNamed(context, kind, name) {
  const getterName = kind === "cell" ? "getCell" : "getAggregate";
  if (typeof context[getterName] === "function") return context[getterName](name);

  const source = kind === "cell" ? context.cells : context.aggregates;
  if (source instanceof Map) return source.get(name);
  return source?.[name];
}

function readTableRow(context, tableName, key) {
  if (typeof context.getRow === "function") return context.getRow(tableName, key);

  const table =
    context.tables instanceof Map
      ? context.tables.get(tableName)
      : context.tables?.[tableName];
  if (table instanceof Map) return table.get(key);
  if (!Array.isArray(table)) return table?.[key];

  const configuredKey =
    context.tableKeys?.[tableName] ??
    context.plan?.state?.tables?.[tableName]?.key ??
    "id";
  return table.find((row) => Object.is(row?.[configuredKey], key));
}

function loadBaseState(plan, snapshot) {
  validatePlan(plan);
  const cells = Object.create(null);
  const tables = new Map();

  for (const [name, definition] of Object.entries(plan.state?.cells ?? {})) {
    const initial = hasOwn(snapshot?.cells, name)
      ? snapshot.cells[name]
      : definition.initial;
    cells[name] = cloneData(initial);
  }

  for (const [name, definition] of Object.entries(plan.state?.tables ?? {})) {
    const source = hasOwn(snapshot?.tables, name)
      ? snapshot.tables[name]
      : definition.initial ?? [];
    const rows = source instanceof Map ? [...source.values()] : source;
    if (!Array.isArray(rows)) {
      throw new TypeError(`Snapshot table "${name}" must be an array`);
    }

    const table = new Map();
    for (const input of rows) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError(`Rows in table "${name}" must be objects`);
      }
      const row = cloneData(input);
      const key = row[definition.key];
      assertKey(key, `Invalid key in table "${name}"`);
      if (table.has(key)) {
        throw new Error(`Duplicate key ${JSON.stringify(key)} in table "${name}"`);
      }
      table.set(key, row);
    }
    tables.set(name, table);
  }

  return { cells, tables };
}

function computeAllDerived(plan, cells, tables) {
  const collections = Object.create(null);
  const aggregates = Object.create(null);
  const state = { cells, tables, collections, aggregates };

  for (const name of getQueryOrder(plan)) {
    const query = plan.queries[name];
    if (query.kind === "collection") {
      collections[name] = computeCollection(plan, name, query, state);
    } else {
      aggregates[name] = computeAggregate(plan, name, query, state);
    }
  }
  return { collections, aggregates };
}

function loadDerivedSnapshot(plan, snapshot, base) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !snapshot.collections ||
    !snapshot.aggregates
  ) {
    return undefined;
  }

  const collections = Object.create(null);
  const aggregates = Object.create(null);

  for (const name of getQueryOrder(plan)) {
    const query = plan.queries[name];
    if (query.kind === "collection") {
      if (!hasOwn(snapshot.collections, name)) return undefined;
      const keys = snapshot.collections[name];
      if (!Array.isArray(keys)) {
        throw new TypeError(`Snapshot collection "${name}" must be an array`);
      }

      const sourceTable = base.tables.get(sourceTableForQuery(plan, name));
      const sourceCollection = plan.queries?.[query.from]?.kind === "collection"
        ? new Set(collections[query.from])
        : undefined;
      const seen = new Set();

      collections[name] = keys.map((key) => {
        assertKey(key, `Invalid key in snapshot collection "${name}"`);
        if (seen.has(key)) {
          throw new Error(
            `Duplicate key ${JSON.stringify(key)} in snapshot collection "${name}"`,
          );
        }
        if (!sourceTable?.has(key) || (sourceCollection && !sourceCollection.has(key))) {
          throw new Error(
            `Unknown key ${JSON.stringify(key)} in snapshot collection "${name}"`,
          );
        }
        seen.add(key);
        return key;
      });
    } else {
      if (!hasOwn(snapshot.aggregates, name)) return undefined;
      const aggregateValue = snapshot.aggregates[name];
      if (typeof aggregateValue !== "number" || !Number.isFinite(aggregateValue)) {
        throw new TypeError(`Snapshot aggregate "${name}" must be a finite number`);
      }
      aggregates[name] = aggregateValue;
    }
  }

  return { collections, aggregates };
}

function computeCollection(plan, name, query, state) {
  const entries = getQuerySourceEntries(plan, name, query, state);
  const result = [];
  for (const [key, row] of entries) {
    if (evaluate(query.where, makeContext(state, { row, key }))) result.push(key);
  }

  if ((query.orderBy ?? []).length > 0) {
    result.sort((left, right) => compareCollectionKeys(query, left, right, state));
  }
  return result;
}

function computeAggregate(plan, name, query, state) {
  let total = 0;
  for (const [key, row] of getQuerySourceEntries(plan, name, query, state)) {
    total += aggregateContribution(query, state, row, key, true);
  }
  return total;
}

function getQuerySourceEntries(plan, name, query, state) {
  if (state.tables.has(query.from)) return [...state.tables.get(query.from).entries()];

  const source = plan.queries?.[query.from];
  if (!source || source.kind !== "collection") {
    throw new TypeError(`Query "${name}" has invalid source "${query.from}"`);
  }
  const tableName = sourceTableForQuery(plan, query.from);
  const table = state.tables.get(tableName);
  return (state.collections[query.from] ?? [])
    .map((key) => [key, table.get(key)])
    .filter((entry) => entry[1] !== undefined);
}

function compareCollectionKeys(query, leftKey, rightKey, state) {
  const tableName = sourceTableForQueryFromState(query, state);
  const table = state.tables.get(tableName);
  const leftRow = table.get(leftKey);
  const rightRow = table.get(rightKey);

  for (const order of query.orderBy ?? []) {
    const left = evaluate(order.by, makeContext(state, { row: leftRow, key: leftKey }));
    const right = evaluate(
      order.by,
      makeContext(state, { row: rightRow, key: rightKey }),
    );
    const compared = compareValues(left, right);
    if (compared !== 0) {
      return order.direction === "descending" ? -compared : compared;
    }
  }

  return tableIndex(table, leftKey) - tableIndex(table, rightKey);
}

function sourceTableForQueryFromState(query, state) {
  if (state.tables.has(query.from)) return query.from;
  // Nested collections are normalized to one base table by metadata in normal
  // engine paths. This fallback is only used by direct collection computation.
  for (const [tableName, table] of state.tables) {
    const keys = [...table.keys()];
    if (keys.length === 0 || keys.some((key) => table.has(key))) return tableName;
  }
  throw new Error(`Cannot resolve source table for "${query.from}"`);
}

function aggregateContribution(query, state, row, key, isMember) {
  if (!isMember || row === undefined) return 0;
  const context = makeContext(state, { row, key });
  if (!evaluate(query.where, context)) return 0;
  if (query.operation === "count") return 1;

  const value = evaluate(query.select, context);
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number") {
    throw new TypeError("sum aggregate values must be numbers");
  }
  return value;
}

function makeContext(state, extra = {}) {
  return {
    cells: state.cells,
    tables: state.tables,
    aggregates: state.aggregates,
    getCell: (name) => state.cells[name],
    getRow: (table, key) => state.tables.get(table)?.get(key),
    getAggregate: (name) => state.aggregates[name],
    ...extra,
  };
}

function serializeState(state) {
  const tables = {};
  for (const [name, rows] of state.tables) {
    tables[name] = [...rows.values()].map((row) => cloneData(row));
  }
  return {
    cells: copyRecord(state.cells, cloneData),
    tables,
    collections: copyRecord(state.collections, (keys) => [...keys]),
    aggregates: copyRecord(state.aggregates, (value) => cloneData(value)),
  };
}

function createDraft(state) {
  return {
    cells: Object.assign(Object.create(null), state.cells),
    tables: new Map(state.tables),
    collections: Object.assign(Object.create(null), state.collections),
    aggregates: Object.assign(Object.create(null), state.aggregates),
  };
}

function createTransactionApi(
  plan,
  draft,
  touchedCells,
  touchedRows,
  copiedTables,
) {
  const writableTable = (tableName) => {
    requireTable(plan, tableName);
    if (!copiedTables.has(tableName)) {
      draft.tables.set(tableName, new Map(draft.tables.get(tableName)));
      copiedTables.add(tableName);
    }
    return draft.tables.get(tableName);
  };

  const touchRow = (tableName, key) => {
    let keys = touchedRows.get(tableName);
    if (!keys) touchedRows.set(tableName, (keys = new Set()));
    keys.add(key);
  };

  const setCell = (name, value) => {
      requireCell(plan, name);
      draft.cells[name] = cloneData(value);
      touchedCells.add(name);
      return value;
  };

  const setField = (tableName, key, field, value) => {
      const definition = requireTable(plan, tableName);
      if (field === definition.key) {
        throw new Error(`Primary key "${field}" cannot be changed`);
      }
      if (!hasOwn(definition.fields, field)) {
        throw new Error(`Unknown field "${field}" in table "${tableName}"`);
      }
      const table = writableTable(tableName);
      const previous = table.get(key);
      if (previous === undefined) {
        throw new Error(`Unknown row ${JSON.stringify(key)} in table "${tableName}"`);
      }
      table.set(key, { ...previous, [field]: cloneData(value) });
      touchRow(tableName, key);
      return value;
  };

  const toggleField = (tableName, key, field) => {
      const row = draft.tables.get(tableName)?.get(key);
      if (row === undefined) {
        throw new Error(`Unknown row ${JSON.stringify(key)} in table "${tableName}"`);
      }
      const value = !row[field];
      setField(tableName, key, field, value);
      return value;
  };

  const insert = (tableName, input) => {
      const definition = requireTable(plan, tableName);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError(`Inserted rows in table "${tableName}" must be objects`);
      }
      const row = cloneData(input);
      const key = row[definition.key];
      assertKey(key, `Invalid key in table "${tableName}"`);
      const table = writableTable(tableName);
      if (table.has(key)) {
        throw new Error(`Duplicate key ${JSON.stringify(key)} in table "${tableName}"`);
      }
      table.set(key, row);
      touchRow(tableName, key);
      return key;
  };

  const remove = (tableName, key) => {
      const table = writableTable(tableName);
      if (!table.has(key)) return false;
      table.delete(key);
      touchRow(tableName, key);
      return true;
  };

  return Object.freeze({ setCell, setField, toggleField, insert, remove });
}

function collectBaseChanges(previous, draft, touchedCells, touchedRows) {
  const cells = [];
  const tables = [];

  for (const name of touchedCells) {
    const oldValue = previous.cells[name];
    const newValue = draft.cells[name];
    if (!Object.is(oldValue, newValue)) {
      cells.push({ name, oldValue: cloneData(oldValue), newValue: cloneData(newValue) });
    }
  }

  for (const [tableName, keys] of touchedRows) {
    for (const key of keys) {
      const oldRow = previous.tables.get(tableName).get(key);
      const newRow = draft.tables.get(tableName).get(key);
      if (!rowsEqual(oldRow, newRow)) {
        tables.push({
          table: tableName,
          key,
          oldRow: oldRow === undefined ? undefined : cloneData(oldRow),
          newRow: newRow === undefined ? undefined : cloneData(newRow),
          fields: changedFields(oldRow, newRow),
        });
      }
    }
  }
  return { cells, tables };
}

function propagateDerived(plan, previous, draft, changes, queryOrder, metadata) {
  const collections = Object.assign(Object.create(null), previous.collections);
  const aggregates = Object.assign(Object.create(null), previous.aggregates);
  const next = { cells: draft.cells, tables: draft.tables, collections, aggregates };
  const collectionChanges = [];
  const aggregateChanges = [];
  const changedCells = new Set(changes.cells.map((change) => change.name));
  const changedAggregates = new Set();
  const rowChangesByTable = groupRowChanges(changes.tables);
  const changedCollections = new Map();

  for (const name of queryOrder) {
    const query = plan.queries[name];
    const meta = metadata.get(name);
    const cellWide = intersects(meta.cellDeps, changedCells);
    const aggregateWide = intersects(meta.aggregateDeps, changedAggregates);
    const lookupWide = hasChangedLookup(meta, rowChangesByTable);
    const sourceRows = rowChangesByTable.get(meta.sourceTable) ?? [];
    const sourceCollectionChange = meta.sourceQuery
      ? changedCollections.get(meta.sourceQuery)
      : undefined;

    if (query.kind === "collection") {
      const oldKeys = previous.collections[name] ?? [];
      let newKeys = oldKeys;
      let mode = "incremental";

      if (
        cellWide ||
        aggregateWide ||
        lookupWide ||
        (meta.sourceQuery && (sourceCollectionChange || sourceRows.length > 0))
      ) {
        newKeys = computeCollection(plan, name, query, next);
        mode = "reconcile";
      } else if (sourceRows.length > 0) {
        newKeys = updateCollectionIncrementally(
          plan,
          query,
          meta,
          oldKeys,
          next,
          sourceRows,
        );
      }

      collections[name] = newKeys;
      if (!keysEqual(oldKeys, newKeys)) {
        const change = { query: name, oldKeys, newKeys, mode };
        collectionChanges.push(change);
        changedCollections.set(name, change);
      }
      continue;
    }

    const oldValue = previous.aggregates[name];
    let newValue = oldValue;
    if (cellWide || aggregateWide || lookupWide) {
      newValue = computeAggregate(plan, name, query, next);
    } else if (meta.sourceQuery) {
      if (sourceCollectionChange || sourceRows.length > 0) {
        newValue = updateAggregateFromCollection(
          query,
          meta,
          previous,
          next,
          oldValue,
          sourceRows,
        );
      }
    } else if (sourceRows.length > 0) {
      newValue = updateAggregateIncrementally(
        query,
        meta,
        previous,
        next,
        oldValue,
        sourceRows,
      );
    }

    aggregates[name] = newValue;
    if (!Object.is(oldValue, newValue)) {
      aggregateChanges.push({ query: name, oldValue, newValue });
      changedAggregates.add(name);
    }
  }

  return { state: next, collections: collectionChanges, aggregates: aggregateChanges };
}

function updateCollectionIncrementally(
  plan,
  query,
  meta,
  oldKeys,
  state,
  rowChanges,
) {
  const keys = [...oldKeys];
  const ordered = (query.orderBy ?? []).length > 0;

  for (const change of rowChanges) {
    const oldIndex = keys.findIndex((key) => sameKey(key, change.key));
    const wasMember = oldIndex !== -1;
    const relevant =
      change.oldRow === undefined ||
      change.newRow === undefined ||
      intersects(meta.fieldDeps, new Set(change.fields));
    if (!relevant) continue;

    const isMember =
      change.newRow !== undefined &&
      Boolean(
        evaluate(
          query.where,
          makeContext(state, { row: change.newRow, key: change.key }),
        ),
      );

    if (wasMember && (!isMember || ordered)) keys.splice(oldIndex, 1);
    if (isMember && (!wasMember || ordered)) {
      insertCollectionKey(plan, query, keys, change.key, state);
    }
  }
  return keys;
}

function insertCollectionKey(plan, query, keys, key, state) {
  if ((query.orderBy ?? []).length > 0) {
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareCollectionKeys(query, key, keys[middle], state) < 0) high = middle;
      else low = middle + 1;
    }
    keys.splice(low, 0, key);
    return;
  }

  const tableName = state.tables.has(query.from)
    ? query.from
    : sourceTableForQuery(plan, query.from);
  const sourceKeys = [...state.tables.get(tableName).keys()];
  const sourceIndex = sourceKeys.findIndex((candidate) => sameKey(candidate, key));
  let insertionIndex = keys.length;
  for (let index = 0; index < keys.length; index += 1) {
    const candidateIndex = sourceKeys.findIndex((candidate) =>
      sameKey(candidate, keys[index]),
    );
    if (candidateIndex > sourceIndex) {
      insertionIndex = index;
      break;
    }
  }
  keys.splice(insertionIndex, 0, key);
}

function updateAggregateIncrementally(
  query,
  meta,
  previous,
  next,
  oldValue,
  rowChanges,
) {
  let value = oldValue;
  for (const change of rowChanges) {
    const relevant =
      change.oldRow === undefined ||
      change.newRow === undefined ||
      intersects(meta.fieldDeps, new Set(change.fields));
    if (!relevant) continue;
    value -= aggregateContribution(query, previous, change.oldRow, change.key, true);
    value += aggregateContribution(query, next, change.newRow, change.key, true);
  }
  return value;
}

function updateAggregateFromCollection(
  query,
  meta,
  previous,
  next,
  oldValue,
  rowChanges,
) {
  const oldMembers = new Set(previous.collections[meta.sourceQuery] ?? []);
  const newMembers = new Set(next.collections[meta.sourceQuery] ?? []);
  const table = next.tables.get(meta.sourceTable);
  const previousTable = previous.tables.get(meta.sourceTable);
  const candidates = new Set([...oldMembers, ...newMembers]);

  for (const change of rowChanges) {
    if (oldMembers.has(change.key) || newMembers.has(change.key)) {
      candidates.add(change.key);
    }
  }

  let value = oldValue;
  for (const key of candidates) {
    const rowChange = rowChanges.find((change) => sameKey(change.key, key));
    const membershipChanged = oldMembers.has(key) !== newMembers.has(key);
    const fieldsRelevant =
      rowChange && intersects(meta.fieldDeps, new Set(rowChange.fields));
    if (!membershipChanged && !fieldsRelevant) continue;
    value -= aggregateContribution(
      query,
      previous,
      previousTable.get(key),
      key,
      oldMembers.has(key),
    );
    value += aggregateContribution(
      query,
      next,
      table.get(key),
      key,
      newMembers.has(key),
    );
  }
  return value;
}

function computeBindingPatches(
  plan,
  bindingMetadata,
  previous,
  next,
  baseChanges,
  collectionChanges,
  aggregateChanges,
) {
  const patches = [];
  const changedCells = new Set(baseChanges.cells.map((change) => change.name));
  const changedAggregates = new Set(
    aggregateChanges.map((change) => change.query),
  );
  const rowChangesByTable = groupRowChanges(baseChanges.tables);
  const collectionChangeMap = new Map(
    collectionChanges.map((change) => [change.query, change]),
  );

  for (const { binding, deps } of bindingMetadata) {
    if (binding.scope === null || binding.scope === undefined) {
      if (!dependenciesChanged(deps, changedCells, changedAggregates, rowChangesByTable)) {
        continue;
      }
      const oldValue = evaluate(binding.expr, makeContext(previous));
      const newValue = evaluate(binding.expr, makeContext(next));
      if (!Object.is(oldValue, newValue)) patches.push({ binding, key: null, value: newValue });
      continue;
    }

    const query = plan.queries[binding.scope];
    if (!query || query.kind !== "collection") continue;
    const tableName = sourceTableForQuery(plan, binding.scope);
    const oldKeys = previous.collections[binding.scope] ?? [];
    const newKeys = next.collections[binding.scope] ?? [];
    const oldSet = new Set(oldKeys);
    const newSet = new Set(newKeys);
    const candidates = new Set();
    const collectionChange = collectionChangeMap.get(binding.scope);

    if (collectionChange) {
      for (const key of newKeys) if (!oldSet.has(key)) candidates.add(key);
    }

    if (intersects(deps.cellDeps, changedCells) || intersects(deps.aggregateDeps, changedAggregates)) {
      for (const key of newKeys) candidates.add(key);
    }

    const ownRows = rowChangesByTable.get(tableName) ?? [];
    for (const change of ownRows) {
      if (newSet.has(change.key) && intersects(deps.fieldDeps, new Set(change.fields))) {
        candidates.add(change.key);
      }
    }

    if (hasChangedLookup(deps, rowChangesByTable)) {
      for (const key of newKeys) candidates.add(key);
    }

    for (const key of candidates) {
      const newRow = next.tables.get(tableName).get(key);
      const newValue = evaluate(binding.expr, makeContext(next, { row: newRow, key }));
      if (!oldSet.has(key)) {
        patches.push({ binding, key, value: newValue });
        continue;
      }
      const oldRow = previous.tables.get(tableName).get(key);
      const oldValue = evaluate(
        binding.expr,
        makeContext(previous, { row: oldRow, key }),
      );
      if (!Object.is(oldValue, newValue)) patches.push({ binding, key, value: newValue });
    }
  }
  return patches;
}

function emitAdapterChanges(
  adapter,
  collectionChanges,
  collectionJournal,
  patches,
  journal,
) {
  const hasCallbacks = [
    "begin",
    "patch",
    "insert",
    "remove",
    "move",
    "reconcile",
    "end",
  ].some((name) => typeof adapter[name] === "function");
  if (!hasCallbacks) return;

  adapter.begin?.();
  try {
    for (let index = 0; index < collectionChanges.length; index += 1) {
      const change = collectionChanges[index];
      const operations = collectionJournal[index].operations;
      if (change.mode === "reconcile" && typeof adapter.reconcile === "function") {
        adapter.reconcile(change.query, [...change.oldKeys], [...change.newKeys]);
      } else {
        for (const operation of operations) {
          if (operation.type === "remove") {
            adapter.remove?.(change.query, operation.key);
          } else {
            adapter[operation.type]?.(
              change.query,
              operation.key,
              operation.beforeKey,
            );
          }
        }
      }
    }

    for (const patch of patches) {
      adapter.patch?.(patch.binding, patch.key, cloneData(patch.value));
    }
  } finally {
    adapter.end?.(cloneJournal(journal));
  }
}

function createCollectionOperations(oldKeys, newKeys) {
  const operations = [];
  const newSet = new Set(newKeys);
  const current = [...oldKeys];

  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (!newSet.has(current[index])) {
      operations.push({ type: "remove", key: current[index] });
      current.splice(index, 1);
    }
  }

  for (let index = 0; index < newKeys.length; index += 1) {
    const key = newKeys[index];
    if (sameKey(current[index], key)) continue;
    const beforeKey = current[index] ?? null;
    const existing = current.findIndex((candidate) => sameKey(candidate, key));
    if (existing === -1) {
      operations.push({ type: "insert", key, beforeKey });
      current.splice(index, 0, key);
    } else {
      operations.push({ type: "move", key, beforeKey });
      current.splice(existing, 1);
      current.splice(index, 0, key);
    }
  }
  return operations;
}

function buildQueryMetadata(plan, queryOrder) {
  const metadata = new Map();
  for (const name of queryOrder) {
    const query = plan.queries[name];
    const expressions = [query.where];
    if (query.kind === "collection") {
      for (const order of query.orderBy ?? []) expressions.push(order.by);
    } else if (query.select) {
      expressions.push(query.select);
    }
    const deps = normalizeDependencies(
      expressions.flatMap((expr) => collectDependencies(expr)),
    );
    metadata.set(name, {
      ...deps,
      sourceQuery: plan.queries?.[query.from]?.kind === "collection" ? query.from : null,
      sourceTable: plan.state.tables?.[query.from]
        ? query.from
        : sourceTableForQuery(plan, query.from),
    });
  }
  return metadata;
}

function normalizeDependencies(dependencies) {
  const result = {
    cellDeps: new Set(),
    fieldDeps: new Set(),
    aggregateDeps: new Set(),
    tableFieldDeps: new Map(),
  };

  for (const dependency of dependencies ?? []) {
    if (!dependency) continue;
    if (dependency.kind === "cell") result.cellDeps.add(dependency.name);
    else if (dependency.kind === "field") result.fieldDeps.add(dependency.name);
    else if (dependency.kind === "aggregate") {
      result.aggregateDeps.add(dependency.name);
    } else if (dependency.kind === "tableField") {
      let fields = result.tableFieldDeps.get(dependency.table);
      if (!fields) result.tableFieldDeps.set(dependency.table, (fields = new Set()));
      fields.add(dependency.name);
    }
  }
  return result;
}

function collectDependencies(expr, output = []) {
  if (!expr || typeof expr !== "object") return output;
  if (expr.kind === "cell") output.push({ kind: "cell", name: expr.name });
  else if (expr.kind === "field") output.push({ kind: "field", name: expr.name });
  else if (expr.kind === "aggregate") {
    output.push({ kind: "aggregate", name: expr.name });
  } else if (expr.kind === "lookup") {
    collectDependencies(expr.key, output);
    output.push({ kind: "tableField", table: expr.table, name: expr.field });
  } else if (expr.kind === "operation") {
    for (const operand of expr.operands ?? []) collectDependencies(operand, output);
  }
  return output;
}

function getQueryOrder(plan) {
  const order = [];
  const visiting = new Set();
  const visited = new Set();

  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Cyclic query dependency at "${name}"`);
    const query = plan.queries?.[name];
    if (!query) throw new Error(`Unknown query "${name}"`);
    visiting.add(name);

    if (plan.queries?.[query.from]) visit(query.from);
    const expressions = [query.where, query.select];
    for (const item of query.orderBy ?? []) expressions.push(item.by);
    for (const expression of expressions) {
      for (const dependency of collectDependencies(expression)) {
        if (dependency.kind === "aggregate" && plan.queries?.[dependency.name]) {
          visit(dependency.name);
        }
      }
    }

    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  for (const name of Object.keys(plan.queries ?? {})) visit(name);
  return order;
}

function sourceTableForQuery(plan, name) {
  const seen = new Set();
  let source = name;
  while (!plan.state.tables?.[source]) {
    if (seen.has(source)) throw new Error(`Cyclic collection source at "${name}"`);
    seen.add(source);
    const query = plan.queries?.[source];
    if (!query || query.kind !== "collection") {
      throw new Error(`Query "${name}" does not resolve to a table`);
    }
    source = query.from;
  }
  return source;
}

function groupRowChanges(changes) {
  const grouped = new Map();
  for (const change of changes) {
    let list = grouped.get(change.table);
    if (!list) grouped.set(change.table, (list = []));
    list.push(change);
  }
  return grouped;
}

function hasChangedLookup(metadata, rowChangesByTable) {
  for (const [table, fields] of metadata.tableFieldDeps) {
    for (const change of rowChangesByTable.get(table) ?? []) {
      if (
        change.oldRow === undefined ||
        change.newRow === undefined ||
        intersects(fields, new Set(change.fields))
      ) {
        return true;
      }
    }
  }
  return false;
}

function dependenciesChanged(deps, cells, aggregates, rowsByTable) {
  return (
    intersects(deps.cellDeps, cells) ||
    intersects(deps.aggregateDeps, aggregates) ||
    hasChangedLookup(deps, rowsByTable)
  );
}

function applyMutation(operation, tx, context) {
  switch (operation.kind) {
    case "setCell":
      return tx.setCell(operation.name, evaluate(operation.value, context));
    case "setField":
      return tx.setField(
        operation.table,
        evaluate(operation.key, context),
        operation.field,
        evaluate(operation.value, context),
      );
    case "toggleField":
      return tx.toggleField(
        operation.table,
        evaluate(operation.key, context),
        operation.field,
      );
    case "insert":
      return tx.insert(operation.table, evaluate(operation.row, context));
    case "remove":
      return tx.remove(operation.table, evaluate(operation.key, context));
    default:
      throw new TypeError(`Unknown mutation kind: ${String(operation.kind)}`);
  }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") throw new TypeError("Plan must be an object");
  if (!plan.state || typeof plan.state !== "object") {
    throw new TypeError("Plan state is required");
  }

  for (const [name, definition] of Object.entries(plan.state.cells ?? {})) {
    if (!definition || (definition.kind !== undefined && definition.kind !== "cell")) {
      throw new TypeError(`Invalid cell definition "${name}"`);
    }
  }
  for (const [name, definition] of Object.entries(plan.state.tables ?? {})) {
    if (
      !definition ||
      (definition.kind !== undefined && definition.kind !== "table") ||
      !definition.key
    ) {
      throw new TypeError(`Invalid table definition "${name}"`);
    }
  }
  for (const [name, query] of Object.entries(plan.queries ?? {})) {
    if (!query || !["collection", "aggregate"].includes(query.kind)) {
      throw new TypeError(`Invalid query "${name}"`);
    }
    if (!plan.state.tables?.[query.from] && !plan.queries?.[query.from]) {
      throw new Error(`Unknown source "${query.from}" for query "${name}"`);
    }
    if (query.kind === "aggregate") {
      if (!["count", "sum"].includes(query.operation)) {
        throw new TypeError(`Unsupported aggregate operation "${query.operation}"`);
      }
      if (query.operation === "sum" && query.select === undefined) {
        throw new TypeError(`Sum aggregate "${name}" requires select`);
      }
    }
  }
  for (const binding of plan.bindings ?? []) {
    if (!binding || typeof binding.id !== "string" || !binding.expr) {
      throw new TypeError("Invalid binding");
    }
    if (binding.scope != null && plan.queries?.[binding.scope]?.kind !== "collection") {
      throw new Error(`Unknown collection scope "${binding.scope}"`);
    }
  }
  getQueryOrder(plan);
}

function validateActionParams(action, params, label) {
  if (!params || typeof params !== "object") {
    throw new TypeError(`Parameters for action "${label}" must be an object`);
  }
  for (const name of Object.keys(action.params ?? {})) {
    if (!hasOwn(params, name)) {
      throw new Error(`Missing parameter "${name}" for action "${label}"`);
    }
  }
}

function requireCell(plan, name) {
  const definition = plan.state.cells?.[name];
  if (!definition) throw new Error(`Unknown cell "${name}"`);
  return definition;
}

function requireTable(plan, name) {
  const definition = plan.state.tables?.[name];
  if (!definition) throw new Error(`Unknown table "${name}"`);
  return definition;
}

function requireCollection(plan, name) {
  const query = plan.queries?.[name];
  if (!query || query.kind !== "collection") throw new Error(`Unknown collection "${name}"`);
  return query;
}

function requireAggregate(plan, name) {
  const query = plan.queries?.[name];
  if (!query || query.kind !== "aggregate") throw new Error(`Unknown aggregate "${name}"`);
  return query;
}

function emptyJournal() {
  return { cells: [], tables: [], collections: [], aggregates: [], patches: [] };
}

function cloneJournal(journal) {
  return {
    cells: journal.cells.map(cloneChange),
    tables: journal.tables.map(cloneChange),
    collections: journal.collections.map(cloneChange),
    aggregates: journal.aggregates.map(cloneChange),
    patches: journal.patches.map(cloneChange),
  };
}

function cloneChange(change) {
  return cloneData(change);
}

function copyRecord(record, map) {
  return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, map(value)]));
}

function cloneData(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneData(item, seen));
    return clone;
  }
  const clone = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) clone[key] = cloneData(item, seen);
  return clone;
}

function changedFields(oldRow, newRow) {
  const names = new Set([...Object.keys(oldRow ?? {}), ...Object.keys(newRow ?? {})]);
  return [...names].filter((name) => !Object.is(oldRow?.[name], newRow?.[name]));
}

function rowsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const name of names) if (!Object.is(left[name], right[name])) return false;
  return true;
}

function compareValues(left, right) {
  if (Object.is(left, right)) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return left < right ? -1 : 1;
}

function tableIndex(table, key) {
  let index = 0;
  for (const candidate of table.keys()) {
    if (sameKey(candidate, key)) return index;
    index += 1;
  }
  return Number.MAX_SAFE_INTEGER;
}

function keysEqual(left, right) {
  return left.length === right.length && left.every((key, index) => sameKey(key, right[index]));
}

function sameKey(left, right) {
  return Object.is(left, right) || left === right;
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function hasOwn(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function assertKey(key, prefix = "Invalid key") {
  const valid =
    key === null ||
    typeof key === "string" ||
    typeof key === "boolean" ||
    (typeof key === "number" && Number.isFinite(key));
  if (!valid) {
    throw new TypeError(`${prefix}: expected a JSON primitive`);
  }
}
