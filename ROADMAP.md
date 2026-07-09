# Roadmap

Kelta should earn complexity only by proving that it improves startup cost, update work, correctness or operability.

## 0.2 — Reference semantics

- Independent slow interpreter for the entire IR.
- Differential tests comparing interpreter state/HTML with optimized patches.
- Property-based transaction, collection and key-order tests.
- Stable plan schema with versioned migrations.

## 0.3 — Async graph

- Resources with request identity, cancellation and stale-result epochs.
- Explicit effect capabilities and cleanup.
- Optimistic overlays and deterministic acknowledgement/rejection.
- Streaming server resources.

## 0.4 — Cost-based compiler

- Choose recomputation or maintained indexes from cardinality/update profiles.
- Fuse scalar operators and generate monomorphic hot paths.
- Event-level chunking and prefetch policies.
- Client-state liveness analysis for smaller resume capsules.

## 0.5 — Tooling and interop

- Transaction-to-DOM graph inspector.
- Foreign DOM and Web Component ownership boundaries.
- Source maps from generated plans back to authoring IR.
- Accessibility and performance budget diagnostics.

## Research tracks

- Worker placement for expensive pure queries.
- WebAssembly kernels for compute-heavy operators, never as the default DOM layer.
- Incremental joins, groups and windowed aggregates.
- Multi-user intent logs and local-first replication.
