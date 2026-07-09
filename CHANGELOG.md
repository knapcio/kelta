# Changelog

All notable changes will be documented here. Kelta follows semantic versioning once a public API is declared stable.

## Unreleased

- Added a matched production React 19.2.7 + React Compiler 1.0 browser comparison with raw samples, DOM assertions and compressed artifact accounting.
- Added a GitHub Pages documentation site, dedicated benchmark report and live compiled demo.
- Documented the benchmark's unfavorable results and interpretation limits, including Kelta's current resumption-scan bottleneck.

## 0.1.0 — 2026-07-09

Initial architecture prototype.

- Serializable authoring IR for cells, keyed tables, queries, transactions and views.
- Atomic runtime with rollback and write coalescing.
- Incremental filtered/ordered collections and `count`/`sum` aggregates.
- Exact text, property, class and keyed structural patch routing.
- Server rendering with a query/state resume capsule.
- Browser resumption without replaying the view.
- Delegated event routes without serialized closures.
- Example application, 10,000-row benchmark and dependency-free test suite.
