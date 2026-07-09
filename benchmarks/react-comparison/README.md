# Kelta × React browser comparison

This suite compares equivalent server-rendered list applications using Kelta and stable production React with React Compiler. It is deliberately separate from `benchmarks/engine.mjs`: the engine benchmark asserts Kelta's internal work, while this suite runs both systems against real DOM in Chrome.

## Run it

```sh
npm ci
npm run bench:react
```

The default quick profile builds 10,000-row server markup, launches the installed Chrome channel, warms each interaction twice, records 10 targeted-update samples and 3 broad-filter samples. The filter count is lower because every reset reconstructs almost 10,000 real DOM rows. Results are written to `results/latest.json` and `results/latest.md`.

The checked-in observation intentionally used 10 broad-filter samples. Its human-readable report includes the exact command; use that command—not the quicker default—when reproducing that specific result.

For a longer run:

```sh
npm run bench:react:publication
```

Useful options:

```sh
node benchmarks/react-comparison/run.mjs \
  --rows 1000 \
  --activation-samples 10 \
  --warmups 5 \
  --samples 50 \
  --broad-samples 10 \
  --browser chrome
```

Use `--browser chromium` when a Playwright Chromium is installed, `--browser msedge` for Edge, or `--executable-path` for an explicit executable. `npm run bench:react:build` produces a standalone visual runner in `benchmarks/react-comparison/dist/` without launching a browser.

## What it measures

- activation of already-inserted server HTML: Kelta `resume` versus React `hydrateRoot`;
- one row label update;
- one row boolean/class/property update plus an aggregate;
- a keyed midpoint-to-front move;
- a global filter that leaves one row;
- raw and gzip/Brotli artifact bytes for HTML/data and minified client JavaScript.

Every interaction dispatches a real click, waits for an asserted DOM result, alternates framework order and records raw samples. See [`docs/react-comparison.md`](../../docs/react-comparison.md) for the full interpretation boundary.
