import {
  createEngine,
  decodeKey,
  encodeKey,
  evaluate,
} from "./engine.js";

const GLOBAL_KEY = Symbol("global binding");
const COMMENT_NODE = 8;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CAPTURED_EVENTS = new Set([
  "abort",
  "blur",
  "error",
  "focus",
  "invalid",
  "load",
  "mouseenter",
  "mouseleave",
  "pointerenter",
  "pointerleave",
  "scroll",
]);

/**
 * Resume a server-rendered Kelta plan without rendering the view again.
 *
 * The canonical call is `resume(plan, root, snapshot)`. For generated modules,
 * `resume(plan, snapshot)` and `resume(plan, snapshot, root)` are also accepted.
 */
export function resume(plan, root = document, snapshot) {
  const resolved = resolveArguments(root, snapshot);
  const initialSnapshot =
    resolved.snapshot === undefined
      ? readResumeSnapshot(resolved.root)
      : unwrapSnapshot(resolved.snapshot);

  let engine;
  const adapter = createBrowserAdapter(plan, resolved.root, () => engine);
  engine = createEngine(plan, {
    snapshot: initialSnapshot,
    adapter,
  });
  adapter.connect(engine);

  const removeListeners = installEventDelegation(
    plan,
    resolved.root,
    engine,
    adapter,
  );

  // Keep disposal optional so the browser layer remains compatible with a
  // frozen/minimal engine object.
  adapter.removeListeners = removeListeners;
  globalThis.__KELTA__ = engine;
  // Temporary compatibility alias for plans produced under the prototype name.
  globalThis.__DELTAUI__ = engine;
  return engine;
}

/**
 * DOM adapter used by the transactional runtime. Exported primarily for small
 * host integrations and dependency-free tests; applications normally use
 * `resume`.
 */
export function createBrowserAdapter(plan, root, getEngine = () => undefined) {
  const document = ownerDocument(root);
  const bindings = new Map(
    (plan.bindings ?? []).map((binding) => [binding.id, binding]),
  );
  const targets = new Map();
  const regions = new Map();
  const rowRecords = new WeakMap();
  let connectedEngine;

  scanExistingDOM();

  const adapter = {
    begin() {},

    patch(binding, key, nextValue) {
      const byKey = targets.get(binding.id);
      const bindingTargets = byKey?.get(keyToken(key));
      if (!bindingTargets) return;

      for (const target of [...bindingTargets]) {
        const nodeIsOwned = isOwnedNode(root, target.node);
        const anchorIsOwned = isOwnedNode(root, target.anchor);
        if (!nodeIsOwned && !anchorIsOwned) {
          unregisterTarget(target);
          continue;
        }
        applyBinding(
          nodeIsOwned ? target.node : target.anchor,
          binding,
          nextValue,
          target.anchor,
        );
      }
    },

    insert(query, key, beforeKey) {
      for (const region of regions.get(query) ?? []) {
        insertIntoRegion(region, query, key, beforeKey);
      }
    },

    remove(query, key) {
      for (const region of regions.get(query) ?? []) {
        removeFromRegion(region, key);
      }
    },

    move(query, key, beforeKey) {
      for (const region of regions.get(query) ?? []) {
        moveInRegion(region, key, beforeKey);
      }
    },

    reconcile(query, _oldKeys, newKeys) {
      for (const region of regions.get(query) ?? []) {
        reconcileRegion(region, query, newKeys);
      }
    },

    end() {},

    connect(nextEngine) {
      connectedEngine = nextEngine;
    },

    get regions() {
      return regions;
    },

    get targets() {
      return targets;
    },
  };

  function engine() {
    return connectedEngine ?? getEngine();
  }

  function scanExistingDOM() {
    const comments = collectComments(root, document);
    const openRegions = new Map();

    for (const comment of comments) {
      const marker = parseCommentMarker(comment.data);
      if (!marker) continue;

      if (marker.kind === "regionStart") {
        const region = {
          query: marker.query,
          container: comment.parentNode,
          start: comment,
          end: undefined,
          rows: new Map(),
        };
        addRegion(region);
        const stack = openRegions.get(marker.query) ?? [];
        stack.push(region);
        openRegions.set(marker.query, stack);
      } else if (marker.kind === "regionEnd") {
        const stack = openRegions.get(marker.query);
        const region = stack?.pop();
        if (region && region.container === comment.parentNode) {
          region.end = comment;
        }
      }
    }

    // Attribute regions are accepted as a small host-integration convenience,
    // although the compiler emits comment-delimited regions.
    for (const element of queryAllIncludingRoot(root, "[data-delta-region]")) {
      addRegion({
        query: element.getAttribute("data-delta-region"),
        container: element,
        start: undefined,
        end: undefined,
        rows: new Map(),
      });
    }

    for (const element of queryAllIncludingRoot(root, "[data-delta-row]")) {
      const encoded = element.getAttribute("data-delta-row");
      const key = safeDecodeKey(encoded);
      const query =
        element.getAttribute("data-delta-query") ??
        findContainingRegion(element)?.query ??
        inferRowQuery(element);
      if (!query) continue;

      const region = findContainingRegion(element, query);
      if (!region) continue;
      registerRow(region, query, key, element);
    }

    for (const element of queryAllIncludingRoot(root, "[data-delta-bind]")) {
      const ids = splitMarkerList(element.getAttribute("data-delta-bind"));
      for (const id of ids) {
        const binding = bindings.get(id);
        if (!binding) continue;
        const context = bindingContext(element, binding);
        registerTarget(binding, context.key, element, undefined, context.rowNode);
      }
    }

    for (const comment of comments) {
      const marker = parseCommentMarker(comment.data);
      if (marker?.kind !== "binding") continue;
      const binding = bindings.get(marker.bindingId);
      if (!binding) continue;

      const key =
        marker.encodedKey === undefined
          ? bindingContext(comment, binding).key
          : safeDecodeKey(marker.encodedKey);
      const rowNode = closestRow(comment);
      const textNode =
        comment.nextSibling?.nodeType === TEXT_NODE
          ? comment.nextSibling
          : undefined;
      registerTarget(binding, key, textNode ?? comment, comment, rowNode);
    }
  }

  function addRegion(region) {
    if (!region.query) return;
    const list = regions.get(region.query) ?? [];
    list.push(region);
    regions.set(region.query, list);
  }

  function findContainingRegion(node, requestedQuery) {
    for (const [query, candidates] of regions) {
      if (requestedQuery && requestedQuery !== query) continue;
      for (const region of candidates) {
        if (isInsideRegion(node, region)) return region;
      }
    }
    return undefined;
  }

  function inferRowQuery(rowNode) {
    const marked = rowNode.matches?.("[data-delta-bind]")
      ? rowNode
      : rowNode.querySelector?.("[data-delta-bind]");
    if (marked) {
      for (const id of splitMarkerList(marked.getAttribute("data-delta-bind"))) {
        const scope = bindings.get(id)?.scope;
        if (scope) return scope;
      }
    }

    for (const comment of collectComments(rowNode, document)) {
      const marker = parseCommentMarker(comment.data);
      const scope =
        marker?.kind === "binding"
          ? bindings.get(marker.bindingId)?.scope
          : undefined;
      if (scope) return scope;
    }
    return undefined;
  }

  function bindingContext(node, binding) {
    if (!binding.scope) {
      return { key: null, rowNode: undefined };
    }

    const rowNode = closestRow(node);
    if (!rowNode) return { key: null, rowNode: undefined };
    return {
      key: safeDecodeKey(rowNode.getAttribute("data-delta-row")),
      rowNode,
    };
  }

  function registerRow(region, query, key, node) {
    const token = encodeKey(key);
    const existing = region.rows.get(token);
    if (existing?.node === node) return existing;

    const record = {
      query,
      key,
      node,
      region,
      targets: new Set(),
    };
    region.rows.set(token, record);
    rowRecords.set(node, record);
    return record;
  }

  function registerTarget(binding, key, node, anchor, rowNode) {
    const token = keyToken(key);
    let byKey = targets.get(binding.id);
    if (!byKey) {
      byKey = new Map();
      targets.set(binding.id, byKey);
    }
    let entries = byKey.get(token);
    if (!entries) {
      entries = new Set();
      byKey.set(token, entries);
    }

    const target = { binding, key, node, anchor, rowNode, entries, byKey, token };
    entries.add(target);
    const record = rowNode ? rowRecords.get(rowNode) : undefined;
    record?.targets.add(target);
    return target;
  }

  function unregisterTarget(target) {
    target.entries.delete(target);
    if (target.entries.size === 0) target.byKey.delete(target.token);
    if (target.byKey.size === 0) targets.delete(target.binding.id);
  }

  function insertIntoRegion(region, query, key, beforeKey) {
    const token = encodeKey(key);
    if (region.rows.has(token)) {
      moveInRegion(region, key, beforeKey);
      return region.rows.get(token);
    }

    const template = plan.rowTemplates?.[query];
    if (!template?.root) return undefined;
    const row = rowForQuery(query, key);
    const record = {
      query,
      key,
      node: undefined,
      region,
      targets: new Set(),
    };
    const node = createTemplateNode(template.root, {
      query,
      key,
      row,
      record,
    });
    if (!node) return undefined;

    record.node = node;
    if (node.nodeType === ELEMENT_NODE) {
      node.setAttribute("data-delta-row", encodeKey(key));
    }
    rowRecords.set(node, record);
    region.rows.set(token, record);

    const before = rowNode(region, beforeKey) ?? region.end ?? null;
    region.container.insertBefore(node, before);
    return record;
  }

  function removeFromRegion(region, key) {
    const token = encodeKey(key);
    const record = region.rows.get(token);
    if (!record) return;
    for (const target of [...record.targets]) unregisterTarget(target);
    record.targets.clear();
    record.node.remove();
    region.rows.delete(token);
  }

  function moveInRegion(region, key, beforeKey) {
    const record = region.rows.get(encodeKey(key));
    if (!record) return;
    const before = rowNode(region, beforeKey) ?? region.end ?? null;
    if (before === record.node || record.node.nextSibling === before) return;
    moveNode(region.container, record.node, before);
  }

  function reconcileRegion(region, query, newKeys) {
    const wanted = new Set(newKeys.map(encodeKey));
    for (const [token, record] of [...region.rows]) {
      if (!wanted.has(token)) removeFromRegion(region, record.key);
    }

    let beforeKey = null;
    for (let index = newKeys.length - 1; index >= 0; index -= 1) {
      const key = newKeys[index];
      if (!region.rows.has(encodeKey(key))) {
        insertIntoRegion(region, query, key, beforeKey);
      } else {
        moveInRegion(region, key, beforeKey);
      }
      beforeKey = key;
    }
  }

  function rowNode(region, key) {
    return key === null ? undefined : region.rows.get(encodeKey(key))?.node;
  }

  function rowForQuery(query, key) {
    const activeEngine = engine();
    const tableName = plan.queries?.[query]?.from;
    if (activeEngine?.getRow && tableName) {
      return activeEngine.getRow(tableName, key);
    }

    const snapshot = activeEngine?.snapshot?.();
    const table = snapshot?.tables?.[tableName];
    if (Array.isArray(table)) {
      const keyField = plan.state?.tables?.[tableName]?.key;
      return table.find((candidate) => Object.is(candidate?.[keyField], key));
    }
    if (table instanceof Map) return table.get(key);
    return table?.[key];
  }

  function createTemplateNode(compiledNode, context) {
    if (!compiledNode) return undefined;

    if (compiledNode.kind === "staticText") {
      return document.createTextNode(String(compiledNode.value ?? ""));
    }

    if (compiledNode.kind === "text") {
      const binding = bindings.get(compiledNode.bindingId);
      const value = binding ? evaluateBinding(binding, context) : "";
      const textNode = document.createTextNode(value == null ? "" : String(value));
      if (binding) {
        const target = registerTarget(
          binding,
          context.key,
          textNode,
          undefined,
          context.record.node,
        );
        // The row root is assigned only after its subtree has been built. Keep
        // the target on the pending record so row removal still unregisters it.
        context.record.targets.add(target);
      }
      return textNode;
    }

    if (compiledNode.kind === "each") {
      const fragment = document.createDocumentFragment();
      const start = document.createComment(`r:${compiledNode.query}:start`);
      const end = document.createComment(`r:${compiledNode.query}:end`);
      fragment.append(start, end);
      // The fragment has no stable parent until insertion, so nested regions
      // are discovered on the next explicit resume. The core compiler avoids
      // nested collections in row templates for now.
      return fragment;
    }

    if (compiledNode.kind !== "element") return undefined;

    const element = createElement(document, compiledNode);
    for (const [name, value] of Object.entries(compiledNode.attrs ?? {})) {
      if (compiledNode.tag.toLowerCase() === "textarea" && name === "value") {
        element.value = value == null ? "" : String(value);
        element.defaultValue = element.value;
      } else {
        setStaticAttribute(element, name, value);
      }
    }

    const eventMarker = compileEventMarker(compiledNode.events);
    if (eventMarker) element.setAttribute("data-delta-on", eventMarker);

    for (const id of compiledNode.bindingIds ?? compiledNode.bindings ?? []) {
      const binding = bindings.get(id);
      if (!binding) continue;
      const target = registerTarget(
        binding,
        context.key,
        element,
        undefined,
        context.record.node,
      );
      context.record.targets.add(target);
      applyBinding(element, binding, evaluateBinding(binding, context));
    }

    if ((compiledNode.bindingIds ?? []).length > 0) {
      element.setAttribute(
        "data-delta-bind",
        compiledNode.bindingIds.join(" "),
      );
    }

    for (const child of compiledNode.children ?? []) {
      const childNode = createTemplateNode(child, context);
      if (childNode) element.appendChild(childNode);
    }
    return element;
  }

  function evaluateBinding(binding, context) {
    const snapshot = engine()?.snapshot?.() ?? {};
    return evaluate(binding.expr, {
      plan,
      cells: snapshot.cells ?? {},
      tables: snapshot.tables ?? {},
      aggregates: snapshot.aggregates ?? {},
      row: context.row,
      key: context.key,
      params: {},
    });
  }

  return adapter;
}

/** Parse compiler-emitted comment markers without needing a DOM implementation. */
export function parseCommentMarker(input) {
  const marker = String(input ?? "").trim();
  if (marker.startsWith("d:")) {
    const separator = marker.indexOf(":", 2);
    return separator === -1
      ? { kind: "binding", bindingId: marker.slice(2) }
      : {
          kind: "binding",
          bindingId: marker.slice(2, separator),
          encodedKey: marker.slice(separator + 1),
        };
  }

  if (marker.startsWith("r:") && marker.endsWith(":start")) {
    return {
      kind: "regionStart",
      query: marker.slice(2, -":start".length),
    };
  }
  if (marker.startsWith("r:") && marker.endsWith(":end")) {
    return {
      kind: "regionEnd",
      query: marker.slice(2, -":end".length),
    };
  }
  return undefined;
}

/** Parse `data-delta-on="click:e0 input:e1"`. */
export function parseEventMarker(input) {
  return splitMarkerList(input).flatMap((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) return [];
    return [
      {
        event: entry.slice(0, separator),
        routeId: entry.slice(separator + 1),
      },
    ];
  });
}

function installEventDelegation(plan, root, engine, adapter) {
  const routes = normalizeRoutes(plan.eventRoutes);
  const eventTypes = new Set(routes.map((route) => route.event).filter(Boolean));
  const listeners = [];

  for (const eventType of eventTypes) {
    const listener = (event) => {
      for (const match of matchingRoutes(event, root, eventType, routes)) {
        const route = match.route;
        if (route.preventDefault) event.preventDefault();

        const rowNode = closestRow(match.element);
        const key = rowNode
          ? safeDecodeKey(rowNode.getAttribute("data-delta-row"))
          : null;
        const query = route.scope ?? inferRouteScope(plan, route);
        const table = plan.queries?.[query]?.from;
        const row = rowNode && table ? engine.getRow?.(table, key) : undefined;
        const valueSource =
          "value" in match.element ? match.element : event.target;
        const checkedSource =
          "checked" in match.element ? match.element : event.target;
        const eventContext = {
          target: event.target,
          currentTarget: match.element,
          value: valueSource?.value,
          checked: checkedSource?.checked,
        };
        const snapshot = engine.snapshot?.() ?? {};
        const context = {
          plan,
          cells: snapshot.cells ?? {},
          tables: snapshot.tables ?? {},
          aggregates: snapshot.aggregates ?? {},
          row,
          key,
          params: {},
          event: eventContext,
        };
        const params = Object.fromEntries(
          Object.entries(route.args ?? {}).map(([name, expression]) => [
            name,
            evaluate(expression, context),
          ]),
        );
        engine.dispatch(route.action, params);
      }
    };

    const capture = CAPTURED_EVENTS.has(eventType);
    root.addEventListener(eventType, listener, capture);
    listeners.push([eventType, listener, capture]);
  }

  return () => {
    for (const [eventType, listener, capture] of listeners) {
      root.removeEventListener(eventType, listener, capture);
    }
    adapter.removeListeners = undefined;
  };
}

function matchingRoutes(event, root, eventType, routes) {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const matches = [];
  for (const node of eventPath(event, root)) {
    if (node?.nodeType !== ELEMENT_NODE) continue;
    for (const marker of parseEventMarker(node.getAttribute("data-delta-on"))) {
      if (marker.event !== eventType) continue;
      const route = routeById.get(marker.routeId);
      if (route) matches.push({ route, element: node });
    }
    if (node === root) break;
  }
  return matches;
}

function eventPath(event, root) {
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    const boundary = path.indexOf(root);
    return boundary === -1 ? path : path.slice(0, boundary + 1);
  }

  const path = [];
  let node = event.target;
  while (node) {
    path.push(node);
    if (node === root) break;
    node = node.parentNode;
  }
  return path;
}

function normalizeRoutes(eventRoutes = {}) {
  return Array.isArray(eventRoutes)
    ? eventRoutes
    : Object.entries(eventRoutes).map(([id, route]) => ({ id, ...route }));
}

function inferRouteScope(plan, route) {
  if (route.scope) return route.scope;
  for (const binding of plan.bindings ?? []) {
    if (binding.routeIds?.includes?.(route.id) && binding.scope) {
      return binding.scope;
    }
  }
  return undefined;
}

function applyBinding(node, binding, nextValue, anchor) {
  if (binding.kind === "text") {
    let textNode = node?.nodeType === TEXT_NODE ? node : undefined;
    if (!textNode && node?.nodeType === COMMENT_NODE) {
      textNode =
        node.nextSibling?.nodeType === TEXT_NODE ? node.nextSibling : undefined;
      if (!textNode) {
        textNode = node.ownerDocument.createTextNode("");
        node.parentNode?.insertBefore(textNode, node.nextSibling);
      }
    }
    if (!textNode && anchor?.nextSibling?.nodeType === TEXT_NODE) {
      textNode = anchor.nextSibling;
    }
    if (textNode) textNode.nodeValue = nextValue == null ? "" : String(nextValue);
    else if (node) node.textContent = nextValue == null ? "" : String(nextValue);
    return;
  }

  if (binding.kind === "prop") {
    // ARIA/data names are attributes even though the compact authoring IR
    // groups all dynamic element values under `props`.
    if (/^(?:aria|data)-/u.test(binding.name)) {
      if (nextValue === null || nextValue === undefined) {
        node.removeAttribute(binding.name);
      } else {
        node.setAttribute(binding.name, String(nextValue));
      }
    } else {
      node[binding.name] = nextValue;
    }
    return;
  }

  if (binding.kind === "class") {
    node.classList.toggle(binding.name, Boolean(nextValue));
    return;
  }

  if (binding.kind === "attr") {
    if (nextValue === false || nextValue === null || nextValue === undefined) {
      node.removeAttribute(binding.name);
    } else {
      node.setAttribute(binding.name, nextValue === true ? "" : String(nextValue));
    }
  }
}

function compileEventMarker(events = {}) {
  if (Array.isArray(events)) return events.join(" ");
  return Object.entries(events)
    .map(([event, routeId]) => `${event}:${routeId}`)
    .join(" ");
}

function createElement(document, compiledNode) {
  const namespace = compiledNode.namespace;
  if (namespace) return document.createElementNS(namespace, compiledNode.tag);
  if (compiledNode.tag === "svg") {
    return document.createElementNS("http://www.w3.org/2000/svg", "svg");
  }
  return document.createElement(compiledNode.tag);
}

function setStaticAttribute(element, name, value) {
  if (value === false || value === null || value === undefined) return;
  element.setAttribute(name, value === true ? "" : String(value));
}

function moveNode(container, node, before) {
  // ParentNode.moveBefore preserves focus, selection, iframe state, and
  // animations where browsers implement it. insertBefore still preserves node
  // identity; restore the focused descendant explicitly on older browsers.
  if (typeof container.moveBefore === "function") {
    container.moveBefore(node, before);
    return;
  }

  const active = node.ownerDocument?.activeElement;
  const restoreFocus = Boolean(active && (active === node || node.contains(active)));
  const selection = restoreFocus ? readControlSelection(active) : undefined;
  container.insertBefore(node, before);
  if (restoreFocus && active.isConnected && typeof active.focus === "function") {
    active.focus({ preventScroll: true });
    restoreControlSelection(active, selection);
  }
}

function readControlSelection(element) {
  try {
    if (typeof element.selectionStart !== "number") return undefined;
    return {
      start: element.selectionStart,
      end: element.selectionEnd,
      direction: element.selectionDirection,
    };
  } catch {
    return undefined;
  }
}

function restoreControlSelection(element, selection) {
  if (!selection || typeof element.setSelectionRange !== "function") return;
  try {
    element.setSelectionRange(
      selection.start,
      selection.end,
      selection.direction ?? undefined,
    );
  } catch {
    // Some input types expose selection properties but reject selection calls.
  }
}

function collectComments(root, document) {
  if (!root || !document?.createTreeWalker) return [];
  const showComment = document.defaultView?.NodeFilter?.SHOW_COMMENT ?? 128;
  const walker = document.createTreeWalker(root, showComment);
  const comments = [];
  if (root.nodeType === COMMENT_NODE) comments.push(root);
  while (walker.nextNode()) comments.push(walker.currentNode);
  return comments;
}

function queryAllIncludingRoot(root, selector) {
  const matches = [];
  if (root?.matches?.(selector)) matches.push(root);
  if (root?.querySelectorAll) matches.push(...root.querySelectorAll(selector));
  return matches;
}

function isInsideRegion(node, region) {
  if (!node || !region.container) return false;
  if (!region.start) return node === region.container || region.container.contains(node);
  if (node.parentNode === region.container) {
    for (let cursor = region.start.nextSibling; cursor && cursor !== region.end; ) {
      if (cursor === node || cursor.contains?.(node)) return true;
      cursor = cursor.nextSibling;
    }
    return false;
  }

  let ancestor = node;
  while (ancestor && ancestor.parentNode !== region.container) {
    ancestor = ancestor.parentNode;
  }
  if (!ancestor) return false;
  for (let cursor = region.start.nextSibling; cursor && cursor !== region.end; ) {
    if (cursor === ancestor) return true;
    cursor = cursor.nextSibling;
  }
  return false;
}

function closestRow(node) {
  if (!node) return undefined;
  if (node.nodeType === ELEMENT_NODE && node.matches?.("[data-delta-row]")) {
    return node;
  }
  const element =
    node.nodeType === ELEMENT_NODE ? node : node.parentElement ?? node.parentNode;
  return element?.closest?.("[data-delta-row]") ?? undefined;
}

function isOwnedNode(root, node) {
  if (!root || !node) return false;
  if (root === node) return true;
  if (typeof root.contains === "function") return root.contains(node);
  return node.isConnected !== false;
}

function safeDecodeKey(encoded) {
  try {
    return decodeKey(encoded);
  } catch {
    return encoded;
  }
}

function keyToken(key) {
  return key === null ? GLOBAL_KEY : encodeKey(key);
}

function splitMarkerList(input) {
  return String(input ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function ownerDocument(root) {
  return root?.nodeType === 9 ? root : root?.ownerDocument ?? globalThis.document;
}

function readResumeSnapshot(root) {
  const script =
    root?.matches?.("#delta-resume")
      ? root
      : root?.querySelector?.("#delta-resume") ??
        ownerDocument(root)?.querySelector?.("#delta-resume");
  if (!script) {
    throw new Error("Kelta could not find #delta-resume");
  }
  try {
    return unwrapSnapshot(JSON.parse(script.textContent ?? "null"));
  } catch (error) {
    throw new Error("Kelta could not parse #delta-resume", { cause: error });
  }
}

function unwrapSnapshot(input) {
  return input?.snapshot ?? input;
}

function resolveArguments(root, snapshot) {
  if (isDOMRoot(root)) return { root, snapshot };
  if (isDOMRoot(snapshot)) return { root: snapshot, snapshot: root };
  return { root: globalThis.document, snapshot: root ?? snapshot };
}

function isDOMRoot(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.addEventListener === "function" &&
      (typeof value.querySelector === "function" || value.nodeType),
  );
}
