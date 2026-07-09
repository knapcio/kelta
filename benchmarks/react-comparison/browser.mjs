import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";

import { resume } from "../../src/runtime/browser.js";
import { ReactBenchmarkApp } from "./dist/.generated/react-app.compiled.jsx";
import {
  artifacts,
  constants,
  keltaPlan,
  keltaSnapshot,
  rows,
  versions,
} from "./dist/.generated/data.mjs";

const sandbox = document.querySelector("#benchmark-sandbox");
const statusNode = document.querySelector("#benchmark-status");
const outputNode = document.querySelector("#benchmark-output");
const runButton = document.querySelector("#run-benchmark");
const downloadButton = document.querySelector("#download-results");

let latestResult;
let running = false;
const recoverableErrors = [];

const markup = {
  kelta: await fetch("./kelta-markup.html").then(assertResponse).then((value) =>
    value.text(),
  ),
  react: await fetch("./react-markup.html").then(assertResponse).then((value) =>
    value.text(),
  ),
};

const initialActiveCount = rows.reduce(
  (count, candidate) => count + Number(candidate.active),
  0,
);
const targetInitiallyActive = rows[constants.targetId - 1].active;
const toggledActiveCount =
  initialActiveCount + (targetInitiallyActive ? -1 : 1);

const workloads = [
  {
    id: "label",
    label: "one row label",
    action: "label",
    resetAction: "label-reset",
    assertForward: (root) => {
      const target = row(root, constants.targetId);
      return (
        target?.querySelector(".bench-label")?.textContent ===
          constants.changedLabel &&
        target?.querySelector("input")?.getAttribute("aria-label") ===
          `Active ${constants.changedLabel}`
      );
    },
    assertBaseline: (root) => {
      const target = row(root, constants.targetId);
      return (
        target?.querySelector(".bench-label")?.textContent ===
          constants.originalLabel &&
        target?.querySelector("input")?.getAttribute("aria-label") ===
          `Active ${constants.originalLabel}`
      );
    },
  },
  {
    id: "toggle",
    label: "one row boolean + aggregate",
    action: "toggle",
    resetAction: "toggle",
    assertForward: (root) => {
      const target = row(root, constants.targetId);
      const expected = !rows[constants.targetId - 1].active;
      return (
        target?.classList.contains("active") === expected &&
        target?.querySelector("input")?.checked === expected &&
        aggregateCount(root) === toggledActiveCount
      );
    },
    assertBaseline: (root) => {
      const target = row(root, constants.targetId);
      const expected = rows[constants.targetId - 1].active;
      return (
        target?.classList.contains("active") === expected &&
        target?.querySelector("input")?.checked === expected &&
        aggregateCount(root) === initialActiveCount
      );
    },
  },
  {
    id: "reorder",
    label: "keyed midpoint → front",
    action: "promote",
    resetAction: "promote-reset",
    assertForward: (root) =>
      Number(root.querySelector(".bench-row")?.getAttribute("data-row-id")) ===
        constants.targetId &&
      row(root, constants.targetId)?.querySelector(".bench-rank")?.textContent ===
        String(constants.promotedRank),
    assertBaseline: (root) =>
      Number(root.querySelector(".bench-row")?.getAttribute("data-row-id")) === 1 &&
      row(root, constants.targetId)?.querySelector(".bench-rank")?.textContent ===
        String(constants.originalRank),
  },
  {
    id: "filter",
    label: "global search → one row",
    action: "filter",
    resetAction: "filter-reset",
    assertForward: (root) => {
      const visible = root.querySelectorAll(".bench-row");
      return (
        visible.length === 1 &&
        Number(visible[0].getAttribute("data-row-id")) === rows.length
      );
    },
    assertBaseline: (root) =>
      root.querySelectorAll(".bench-row").length === rows.length,
  },
];

runButton?.addEventListener("click", () => {
  runComparison().catch(showFailure);
});

downloadButton?.addEventListener("click", () => {
  if (!latestResult) return;
  const blob = new Blob([`${JSON.stringify(latestResult, null, 2)}\n`], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `kelta-react-${rows.length}-rows.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

window.runKeltaReactBenchmark = runComparison;
window.__KELTA_REACT_BENCH_READY__ = true;

async function runComparison(options = {}) {
  if (running) throw new Error("A comparison run is already in progress");
  running = true;
  runButton?.setAttribute("disabled", "");
  downloadButton?.setAttribute("disabled", "");
  outputNode?.replaceChildren();
  recoverableErrors.length = 0;

  const configuration = {
    rows: rows.length,
    activationSamples: positiveInteger(options.activationSamples, 3),
    warmups: nonNegativeInteger(options.warmups, 2),
    samples: positiveInteger(options.samples, 10),
    broadSamples: positiveInteger(options.broadSamples, 3),
  };

  try {
    setStatus("Measuring server-rendered activation…");
    const activationRaw = { kelta: [], react: [] };
    for (let index = 0; index < configuration.activationSamples; index += 1) {
      const order = index % 2 === 0 ? ["kelta", "react"] : ["react", "kelta"];
      for (const framework of order) {
        setStatus(
          `Activation ${index + 1}/${configuration.activationSamples}: ${framework}`,
        );
        const measured =
          framework === "kelta"
            ? await activateKelta()
            : await activateReact();
        activationRaw[framework].push(measured.sample);
        await measured.instance.dispose();
      }
    }

    setStatus("Preparing interaction fixtures…");
    const instances = {
      kelta: (await activateKelta()).instance,
      react: (await activateReact()).instance,
    };
    const interactions = {};

    try {
      for (const workload of workloads) {
        setStatus(`Warming ${workload.label}…`);
        for (let index = 0; index < configuration.warmups; index += 1) {
          for (const framework of ["kelta", "react"]) {
            await runUnmeasured(instances[framework], workload);
          }
        }

        const raw = { kelta: [], react: [] };
        const sampleCount =
          workload.id === "filter"
            ? configuration.broadSamples
            : configuration.samples;
        for (let index = 0; index < sampleCount; index += 1) {
          const order =
            index % 2 === 0 ? ["kelta", "react"] : ["react", "kelta"];
          for (const framework of order) {
            setStatus(
              `${workload.label}: ${index + 1}/${sampleCount} · ${framework}`,
            );
            raw[framework].push(
              await measureInteraction(instances[framework], workload),
            );
          }
        }
        interactions[workload.id] = summarizePair(raw, workload.label);
        for (const framework of ["kelta", "react"]) {
          await reset(instances[framework], workload);
        }
      }
    } finally {
      await Promise.all(Object.values(instances).map((instance) => instance.dispose()));
    }

    if (recoverableErrors.length > 0) {
      throw new Error(
        `React reported ${recoverableErrors.length} recoverable hydration error(s): ${recoverableErrors[0]}`,
      );
    }

    latestResult = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      suite: "Kelta vs React — matched SSG activation and browser interactions",
      configuration,
      versions,
      environment: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        deviceMemoryGiB: navigator.deviceMemory ?? null,
        crossOriginIsolated: globalThis.crossOriginIsolated,
      },
      artifacts,
      activation: summarizePair(
        activationRaw,
        "server-rendered activation (HTML insertion and JS parse excluded)",
      ),
      interactions,
      correctness: {
        matchedRows: rows.length,
        hydrationRecoverableErrors: 0,
        everyMeasuredMutationAsserted: true,
        secondaryBindingsAsserted: true,
        keyedNodeIdentityAsserted: true,
        realClickEvents: true,
      },
      notes: [
        "Production bundles; React StrictMode and development diagnostics are disabled.",
        "React uses React Compiler 1.0 and an idiomatic immutable reducer with stable numeric keys.",
        "DOM-ready ends when the expected DOM state is observable; next-frame ends at the next requestAnimationFrame callback.",
        "HTML insertion and JavaScript parse/evaluation are excluded from activation timing and reported separately as artifact sizes.",
        "MutationObserver cannot see property-only assignments; framework-specific telemetry is kept separate from DOM mutation records.",
        "This is a synchronous non-virtualized list/query workload, not a universal frontend score.",
      ],
    };

    renderResult(latestResult);
    setStatus("Complete. Inspect the raw samples before drawing conclusions.");
    downloadButton?.removeAttribute("disabled");
    window.__KELTA_REACT_BENCH_RESULT__ = latestResult;
    return latestResult;
  } finally {
    running = false;
    runButton?.removeAttribute("disabled");
  }
}

async function activateKelta() {
  const host = createHost("kelta", markup.kelta);
  const mutations = trackMutations(host);
  const started = performance.now();
  const engine = resume(keltaPlan, host, keltaSnapshot);
  const domReadyMs = performance.now() - started;
  await nextFrame();
  const nextFrameMs = performance.now() - started;
  const sample = {
    domReadyMs,
    nextFrameMs,
    domMutations: mutations.finish(),
    frameworkWork: journalSummary(engine.lastJournal),
  };

  return {
    sample,
    instance: {
      framework: "kelta",
      host,
      engine,
      async dispose() {
        host.remove();
      },
    },
  };
}

async function activateReact() {
  const host = createHost("react", markup.react);
  const mutations = trackMutations(host);
  let ready;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const started = performance.now();
  const root = hydrateRoot(
    host,
    createElement(ReactBenchmarkApp, {
      initialRows: rows,
      constants,
      readyRef(node) {
        if (node) ready(node);
      },
    }),
    {
      onRecoverableError(error) {
        recoverableErrors.push(String(error?.message ?? error));
      },
    },
  );
  await withTimeout(readyPromise, 30_000, "React hydration did not commit");
  const domReadyMs = performance.now() - started;
  await nextFrame();
  const nextFrameMs = performance.now() - started;
  const sample = {
    domReadyMs,
    nextFrameMs,
    domMutations: mutations.finish(),
    frameworkWork: null,
  };

  return {
    sample,
    instance: {
      framework: "react",
      host,
      root,
      async dispose() {
        root.unmount();
        host.remove();
        await Promise.resolve();
      },
    },
  };
}

async function measureInteraction(instance, workload) {
  await reset(instance, workload);
  const keyedNodeBefore =
    workload.id === "reorder" ? row(instance.host, constants.targetId) : null;
  const mutations = trackMutations(instance.host);
  const started = performance.now();
  click(instance.host, workload.action);
  await waitForAssertion(
    () => workload.assertForward(instance.host),
    `${instance.framework}/${workload.id} did not reach its expected DOM state`,
  );
  if (
    keyedNodeBefore &&
    row(instance.host, constants.targetId) !== keyedNodeBefore
  ) {
    mutations.finish();
    throw new Error(
      `${instance.framework}/${workload.id} replaced the keyed row instead of moving it`,
    );
  }
  const domReadyMs = performance.now() - started;
  await nextFrame();
  const nextFrameMs = performance.now() - started;

  return {
    domReadyMs,
    nextFrameMs,
    domMutations: mutations.finish(),
    frameworkWork:
      instance.framework === "kelta"
        ? journalSummary(instance.engine.lastJournal)
        : null,
  };
}

async function runUnmeasured(instance, workload) {
  await reset(instance, workload);
  click(instance.host, workload.action);
  await waitForAssertion(
    () => workload.assertForward(instance.host),
    `Warmup failed for ${instance.framework}/${workload.id}`,
  );
}

async function reset(instance, workload) {
  if (workload.assertBaseline(instance.host)) return;
  click(instance.host, workload.resetAction);
  await waitForAssertion(
    () => workload.assertBaseline(instance.host),
    `Reset failed for ${instance.framework}/${workload.id}`,
  );
  await Promise.resolve();
}

function click(root, action) {
  const button = root.querySelector(`[data-bench-action="${action}"]`);
  if (!button) throw new Error(`Missing benchmark action ${action}`);
  button.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
  );
}

function row(root, id) {
  return root.querySelector(`[data-row-id="${id}"]`);
}

function aggregateCount(root) {
  return Number(root.querySelector("[data-bench-count]")?.textContent);
}

function createHost(framework, html) {
  const host = document.createElement("div");
  host.className = "benchmark-host";
  host.dataset.framework = framework;
  host.innerHTML = html;
  sandbox.append(host);
  return host;
}

function trackMutations(root) {
  const records = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  return {
    finish() {
      records.push(...observer.takeRecords());
      observer.disconnect();
      return summarizeMutations(records);
    },
  };
}

function summarizeMutations(records) {
  const summary = {
    records: records.length,
    attributes: 0,
    characterData: 0,
    childList: 0,
    addedNodes: 0,
    removedNodes: 0,
  };
  for (const record of records) {
    summary[record.type] += 1;
    if (record.type === "childList") {
      summary.addedNodes += record.addedNodes.length;
      summary.removedNodes += record.removedNodes.length;
    }
  }
  return summary;
}

function journalSummary(journal) {
  return {
    patches: journal.patches.length,
    collectionOperations: journal.collections.reduce(
      (count, change) => count + change.operations.length,
      0,
    ),
    reconciliations: journal.collections.filter(
      (change) => change.mode === "reconcile",
    ).length,
    changedRows: journal.tables.length,
    changedCells: journal.cells.length,
    changedAggregates: journal.aggregates.length,
  };
}

function summarizePair(raw, label) {
  return {
    label,
    kelta: summarizeSamples(raw.kelta),
    react: summarizeSamples(raw.react),
  };
}

function summarizeSamples(samples) {
  return {
    domReadyMs: statistics(samples.map((sample) => sample.domReadyMs)),
    nextFrameMs: statistics(samples.map((sample) => sample.nextFrameMs)),
    raw: samples,
  };
}

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    min: round(sorted[0]),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)),
    mean: round(total / sorted.length),
  };
}

function percentile(sorted, fraction) {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function renderResult(result) {
  const heading = document.createElement("h2");
  heading.textContent = `${result.configuration.rows.toLocaleString()} rows · median / p95 milliseconds`;
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>Workload</th><th>Kelta DOM-ready</th><th>React DOM-ready</th><th>Kelta next frame</th><th>React next frame</th></tr></thead>";
  const body = document.createElement("tbody");
  const entries = [
    ["activation", result.activation],
    ...Object.entries(result.interactions),
  ];
  for (const [name, comparison] of entries) {
    const tr = document.createElement("tr");
    const values = [
      comparison.label || name,
      formatStats(comparison.kelta.domReadyMs),
      formatStats(comparison.react.domReadyMs),
      formatStats(comparison.kelta.nextFrameMs),
      formatStats(comparison.react.nextFrameMs),
    ];
    for (let index = 0; index < values.length; index += 1) {
      const cell = document.createElement(index === 0 ? "th" : "td");
      const value = values[index];
      cell.textContent = value;
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body);

  const caveat = document.createElement("p");
  caveat.className = "benchmark-caveat";
  caveat.textContent =
    "One machine, one workload, no universal winner. Raw samples include DOM mutation telemetry; artifact sizes are reported separately.";
  outputNode.replaceChildren(heading, table, caveat);
}

function formatStats(stats) {
  return `${stats.median.toFixed(2)} / ${stats.p95.toFixed(2)}`;
}

async function waitForAssertion(predicate, message) {
  if (predicate()) return;
  const started = performance.now();
  while (performance.now() - started < 30_000) {
    await Promise.resolve();
    if (predicate()) return;
    await nextFrame();
    if (predicate()) return;
  }
  throw new Error(message);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), milliseconds),
    ),
  ]);
}

function setStatus(message) {
  if (statusNode) statusNode.textContent = message;
}

function showFailure(error) {
  setStatus(`Failed: ${error.message}`);
  console.error(error);
}

function assertResponse(response) {
  if (!response.ok) {
    throw new Error(`Failed to load ${response.url}: HTTP ${response.status}`);
  }
  return response;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`Expected a positive integer, got ${String(value)}`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`Expected a non-negative integer, got ${String(value)}`);
  }
  return parsed;
}

function round(value) {
  return Number(value.toFixed(4));
}
