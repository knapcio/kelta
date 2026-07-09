# Kelta × React comparison

This is a benchmark design document, not a victory page. The harness exists to find where Kelta's model helps, where the prototype loses, and which claims are not yet justified.

Latest checked-in results:

- [human-readable report](../benchmarks/react-comparison/results/latest.md)
- [raw samples and telemetry](../benchmarks/react-comparison/results/latest.json)

## Baseline

| Dimension | Kelta | React |
| --- | --- | --- |
| Version | repository `0.1.x` | exact `react@19.2.7` and `react-dom@19.2.7` |
| Optimization | compiled bindings and query routes | stable React Compiler `1.0.0` |
| Build | minified production ESM | minified production ESM |
| Delivery | prerendered HTML + resume capsule + plan | static prerendered HTML + serialized rows + hydration |
| State update | typed transaction over a normalized keyed table | idiomatic immutable reducer with stable numeric keys |
| Development checks | off | production mode; no StrictMode |
| List | non-virtualized | non-virtualized |

React is intentionally not a naive straw man. The source is compiled with React Compiler, and the build fails unless the compiler emits its `react/compiler-runtime` cache import. React's documentation says performance measurements should use production mode, and React Compiler automatically memoizes eligible component work.

The React markup is generated with `prerenderToNodeStream` and activated with `hydrateRoot`, matching Kelta's static HTML/resumption delivery model. A `createRoot` client-render benchmark would answer a different question.

## Workloads

The two applications contain the same rows and equivalent DOM structure. The default cardinality is 10,000.

1. **Server-rendered activation.** Markup insertion and JavaScript parse/evaluation happen before the timer. The result isolates Kelta's marker scan and engine creation versus React hydration.
2. **One row label.** Change the midpoint row's text and ARIA label.
3. **One row boolean + aggregate.** Toggle the midpoint row's checkbox/class and update the active count.
4. **Keyed reorder.** Change the midpoint row's rank to `-1`, moving that same keyed node to the front.
5. **Global filter.** Change a query cell so only the final row remains. This deliberately exercises broad invalidation in both implementations.

Each interaction:

- starts from its asserted baseline;
- dispatches a real bubbling `click` event;
- ends `domReadyMs` only after the expected DOM state is observable;
- records a following `requestAnimationFrame` boundary as `nextFrameMs`;
- alternates which framework runs first;
- publishes every raw sample, not only a best result.

`nextFrameMs` is not a guaranteed presentation timestamp. Browser tracing is required to separate style, layout, paint and compositor work precisely.

## Profiles

```sh
# 3 activation samples, 2 warmups, 10 targeted samples, 3 broad-filter samples
npm run bench:react

# 30 activation samples, 10 warmups, 200 targeted samples, 30 broad-filter samples
npm run bench:react:publication
```

Override any count directly:

```sh
node benchmarks/react-comparison/run.mjs \
  --rows 10000 \
  --activation-samples 10 \
  --warmups 5 \
  --samples 100 \
  --broad-samples 20
```

The CLI runner records the browser user agent, OS/architecture, CPU model, logical core count, memory, viewport, Node version, Git/dirty state, dependency-lock hash, measured-source hash, exact package versions and run command alongside raw samples. The standalone browser runner records only browser-visible environment fields and its selected sample configuration; it cannot truthfully infer host, Git or Node metadata.

The measured-source fingerprint covers Kelta's `src/` tree, both benchmark fixtures, the shared benchmark stylesheet, the browser harness, CLI launcher, runner markup, production build harness and `package.json`. The exact path list is stored with the hash, and the lockfile is hashed separately. The exact command for every checked-in CLI result appears in both JSON and the human-readable report.

## Artifact accounting

The build reports raw, gzip and Brotli sizes for:

- server HTML plus serialized initial data;
- minified production client JavaScript;
- their sum.

Shared CSS is excluded because both fixtures use the same stylesheet. These are harness artifacts, not npm package sizes. Kelta's current plan repeats initial rows that also exist in its resume capsule; that is a real prototype cost and is intentionally counted. A future liveness/serialization pass may change it.

## Telemetry and correctness

The timed run also stores MutationObserver records. Those records see text, attribute and child-list mutations, but not all property assignments, so they are diagnostic rather than a complete cross-framework operation count.

Kelta additionally exposes its transaction journal: changed cells/rows/aggregates, binding patches, structural operations and whether a collection used broad reconciliation. React-specific internal instrumentation is omitted from the timed path so it does not add asymmetric profiling overhead.

The run fails on:

- a missing expected DOM state;
- a reset that does not restore baseline state;
- a React recoverable hydration error;
- a browser console/page error;
- React Compiler output without its compiler-runtime import.

## What the result can and cannot say

It can compare these implementations for synchronous, non-virtualized, derived-list updates on the disclosed browser and machine. It can expose algorithmic and startup weaknesses that the Node-only Kelta engine proof cannot.

It cannot establish that either framework is universally faster. In particular:

- Kelta is a small research runtime; React is a general UI runtime with transitions, Suspense, async integration, error boundaries and a mature ecosystem.
- A Kelta advantage includes its incremental state/query model, not merely DOM patching.
- The React fixture uses an immutable row array. A future `React + incremental external store` fixture is needed to isolate renderer cost from derived-data cost.
- The suite does not yet capture true cold navigation, JS parse/evaluation time, FCP/LCP, retained heap, long tasks or a browser trace split across scripting/style/layout/paint.
- A 10,000-node live DOM is intentionally stressful and can be dominated by browser rendering work. Real products should virtualize large lists when the UX permits.
- Results vary with browser version, thermal state, background load and sample order. Compare distributions and rerun locally.

## Why `flushSync` is not used

The harness observes a real event and waits for the correct DOM instead of timing only a state setter. React batches updates, and its documentation warns that `flushSync` is uncommon and can itself hurt performance or flush unrelated work. Adding it solely for benchmark convenience would change the system being measured.

## Primary references

- [React versions](https://react.dev/versions)
- [React Compiler 1.0](https://react.dev/blog/2025/10/07/react-compiler-1)
- [Installing React Compiler](https://react.dev/learn/react-compiler/installation)
- [`prerenderToNodeStream`](https://react.dev/reference/react-dom/static/prerenderToNodeStream)
- [`hydrateRoot`](https://react.dev/reference/react-dom/client/hydrateRoot)
- [React batching](https://react.dev/learn/queueing-a-series-of-state-updates)
- [`flushSync` caveats](https://react.dev/reference/react-dom/flushSync)
- [`memo` and production measurements](https://react.dev/reference/react/memo)
