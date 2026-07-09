# Kelta × React benchmark result

> A local observation, not a universal ranking. Read [the methodology](../../../docs/react-comparison.md) before interpreting these numbers.

- Generated: 2026-07-09T20:14:34.503Z
- Rows: 10,000
- Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36
- Host: Apple M5 Max; arm64; 18 logical cores; 128 GiB memory
- React: 19.2.7 / React DOM 19.2.7
- React Compiler: 1.0.0 (compiler runtime import verified)
- Node: v24.18.0
- Git revision: 0caf5adffd0937f2536a112f47343e85db042eb4 (working tree had changes)
- Measured-source SHA-256: a41ea53bb1f76e6bae2ec9497fdcf5ba8ca0fc26cbd5ddf361acc8065a435986
- Samples: 3 activation; 10 per targeted interaction; 10 broad-filter samples; 2 warmups

Exact command:

```sh
node benchmarks/react-comparison/run.mjs --rows 10000 --activation-samples 3 --warmups 2 --samples 10 --broad-samples 10 --output benchmarks/react-comparison/results
```

All cells are **median / p95 milliseconds**.

| Workload | Kelta DOM-ready | React DOM-ready | Kelta next frame | React next frame |
| --- | ---: | ---: | ---: | ---: |
| server-rendered activation (HTML insertion and JS parse excluded) | 1637.90 / 1783.30 | 156.20 / 161.40 | 1719.40 / 1898.50 | 161.50 / 161.90 |
| one row label | 5.80 / 6.80 | 3.20 / 3.80 | 14.70 / 24.80 | 11.90 / 17.40 |
| one row boolean + aggregate | 5.70 / 6.10 | 3.20 / 3.40 | 7.00 / 25.50 | 4.50 / 4.70 |
| keyed midpoint → front | 6.60 / 7.30 | 41.20 / 45.20 | 70.00 / 136.80 | 101.30 / 129.60 |
| global search → one row | 17.50 / 20.30 | 14.50 / 17.50 | 19.50 / 22.70 | 15.60 / 20.40 |

## Transferred artifact model

Shared CSS is excluded. HTML includes serialized initial data; client JavaScript is a minified production bundle.

| Artifact | Kelta raw / gzip / Brotli | React raw / gzip / Brotli |
| --- | ---: | ---: |
| Server HTML + data | 3644.8 KiB / 296.7 KiB / 103.1 KiB | 2662.6 KiB / 198.0 KiB / 83.0 KiB |
| Client JavaScript | 491.3 KiB / 88.5 KiB / 34.3 KiB | 194.0 KiB / 60.5 KiB / 51.9 KiB |
| Total | 4136.1 KiB / 385.2 KiB / 137.3 KiB | 2856.6 KiB / 258.5 KiB / 134.9 KiB |

## Boundaries

- Kelta and React start from their own equivalent server-rendered DOM and the same row data.
- React uses an idiomatic immutable reducer, stable numeric keys, and stable React Compiler 1.0.
- Interactions dispatch real click events and end only after the expected DOM state is observed.
- “Next frame” is a requestAnimationFrame boundary, not a guaranteed presentation timestamp.
- Activation excludes HTML insertion and JavaScript parsing/evaluation; artifact sizes are reported separately.
- MutationObserver does not observe property-only writes, so DOM mutation telemetry is diagnostic rather than a complete operation count.
- The workload is a synchronous, non-virtualized list with derived filter/order/count state. It does not represent all frontend applications.

Raw per-sample timing, DOM mutation records, and Kelta transaction journals are in [latest.json](./latest.json).
