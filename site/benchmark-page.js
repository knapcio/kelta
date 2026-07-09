const meta = document.getElementById("result-meta");
const timingBody = document.getElementById("timing-body");
const artifactBody = document.getElementById("artifact-body");

loadResult().catch((error) => {
  meta.textContent = "Checked-in result unavailable";
  timingBody.replaceChildren(messageRow(error.message, 5));
  artifactBody.replaceChildren(messageRow("See the GitHub result artifact.", 3));
});

async function loadResult() {
  const response = await fetch("./results/react-comparison.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Result failed to load (HTTP ${response.status})`);
  const result = await response.json();
  const date = new Date(result.generatedAt);
  meta.textContent = `${result.configuration.rows.toLocaleString()} rows · React ${result.versions.react} + Compiler ${result.versions.reactCompiler} · ${date.toLocaleDateString()}`;

  const comparisons = [result.activation, ...Object.values(result.interactions)];
  timingBody.replaceChildren(...comparisons.map((comparison) => {
    const row = document.createElement("tr");
    appendCell(row, comparison.label, "th");
    appendCell(row, metric(comparison.kelta.domReadyMs));
    appendCell(row, metric(comparison.react.domReadyMs));
    appendCell(row, metric(comparison.kelta.nextFrameMs));
    appendCell(row, metric(comparison.react.nextFrameMs));
    return row;
  }));

  const artifacts = [
    ["Server HTML + data", result.artifacts.kelta.html, result.artifacts.react.html],
    ["Client JavaScript", result.artifacts.kelta.clientJavaScript, result.artifacts.react.clientJavaScript],
    ["Total", result.artifacts.kelta.total, result.artifacts.react.total],
  ];
  artifactBody.replaceChildren(...artifacts.map(([label, kelta, react]) => {
    const row = document.createElement("tr");
    appendCell(row, label, "th"); appendCell(row, sizes(kelta)); appendCell(row, sizes(react));
    return row;
  }));
}

function appendCell(row, value, tag = "td") {
  const cell = document.createElement(tag);
  if (tag === "th") cell.scope = "row";
  cell.textContent = value; row.append(cell);
}

function messageRow(message, span) {
  const row = document.createElement("tr"); const cell = document.createElement("td");
  cell.colSpan = span; cell.textContent = message; row.append(cell); return row;
}

function metric(value) { return `${value.median.toFixed(2)} / ${value.p95.toFixed(2)}`; }
function sizes(value) { return `${bytes(value.raw)} / ${bytes(value.gzip)} / ${bytes(value.brotli)}`; }
function bytes(value) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`; }
