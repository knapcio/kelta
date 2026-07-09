# Architecture

## Thesis

Kelta models a page as a continuously maintained query:

```text
DOM = View(State)
DeltaDOM = derivative(View, DeltaState)
```

The source artifact is a typed data graph. Components may eventually exist as authoring macros, but there is no component tree at runtime.

## Compilation

The compiler validates that the graph is serializable and that state, fields, queries, actions and view references exist. It then:

1. assigns stable binding and event-route identifiers;
2. extracts cell, field and aggregate dependencies from every expression;
3. builds query-sensitive update routes;
4. evaluates initial collection indexes and aggregates;
5. renders initial semantic HTML with sparse binding markers;
6. emits the state/query resume capsule and browser plan.

Dynamic text uses adjacent comment markers so compilation does not introduce wrapper elements. Properties, attributes and classes use temporary `data-delta-bind` markers. Events are represented by route identifiers, never serialized closures.

## Resumption

The browser scans sparse markers and retains direct references to dynamic text nodes and elements. It installs one delegated listener per event type found in the plan. It does not execute the view or rebuild an ownership tree.

The resume capsule contains:

- scalar cell values;
- normalized table rows;
- materialized collection key order;
- materialized aggregate values.

This is intentionally more state than an optimizing production compiler should serialize. A later liveness pass should remove values that are neither read by client transactions nor required by client-live queries.

## Transactions

A transaction applies writes to a versioned in-memory state and records their first old value and final new value. Repeated writes are coalesced. If an operation or invariant throws, all writes roll back and no adapter callback runs.

On commit, propagation occurs as one batch:

1. update affected collection memberships and order;
2. update aggregate values from old/new row contributions;
3. route changed cells, fields and aggregates to exact bindings;
4. commit structural and scalar DOM operations.

Async work is intentionally absent. The intended rule is that `await` cannot keep a transaction open: a resource completion begins a new transaction with an epoch so stale completions can be rejected deterministically.

## Incremental collections

For one row delta, a collection tests old and new membership:

| Before | After | Operation |
| --- | --- | --- |
| absent | absent | none |
| absent | present | keyed insert |
| present | absent | keyed remove |
| present | present, same position | scalar patches only |
| present | present, new order key | keyed move |

A cell used by a filter can affect every row. The prototype recomputes the key projection and performs a keyed reconciliation in that case. A production compiler should choose among recomputation, indexing and worker execution from cardinality and update-rate estimates.

## DOM ownership

The adapter owns only compiler-declared slots and keyed regions. It updates text through `Text.data`, properties directly, attributes with `setAttribute`/`removeAttribute`, and classes with `classList.toggle`.

Keyed moves reuse the existing element. This preserves form state, focus, selection and other browser-owned state better than subtree replacement.

Future escape hatches should include:

- foreign DOM regions that Kelta never mutates below their root;
- phase-declared measurement and DOM effects;
- custom render targets such as canvas or WebGPU;
- opaque pure operators that opt into broad invalidation.

## Security direction

The optimizable graph contains no `eval`, executable strings or HTML interpolation. Dynamic values flow to text, typed properties, explicit attributes and class toggles. Raw HTML should require a separate sanitizer capability and Trusted Types policy.

Server placement must be explicit. A compiler must never infer that a value containing a secret is safe to serialize into the resume capsule.

## Performance contract

The intended update cost is:

```text
changed facts + affected query deltas + actual DOM mutations
```

It is not proportional to the size of an ancestor component tree. That does not remove browser layout, style and paint costs; it minimizes framework work before those unavoidable phases.
