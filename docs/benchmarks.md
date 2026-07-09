# Benchmarking Kelta

Framework benchmarks are easy to game. Kelta separates semantic assertions from timing observations.

## Current engine benchmark

`npm run bench` creates 10,000 normalized rows, materializes a filtered and ordered collection plus two aggregates, and changes one row's sort key.

The hard assertions are:

- exactly one scalar binding patch;
- exactly one keyed structural move;
- zero full collection reconciliations.

The reported milliseconds are diagnostic and are not a release gate. CI hardware, JavaScript engines and tracing can change timing without changing algorithmic work.

Run a different cardinality with:

```sh
ROWS=100000 npm run bench
```

## Required future workloads

1. A 10,000-row editable/filterable/sortable grid.
2. A streaming dashboard with incremental groups and optimistic mutations.
3. A large conditional form with async validation and cancellation.
4. SSR startup on a throttled mobile-class CPU and network.

Comparisons should report generated and transferred bytes, parse/evaluation time, initial main-thread work, interaction latency, heap usage, long tasks, DOM operations and layout/paint separately. React Compiler, Solid, Svelte, Qwik, Marko and a direct DOM implementation are the relevant baselines.
