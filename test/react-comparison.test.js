import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildComparison } from "../benchmarks/react-comparison/build.mjs";
import { sourceMetadata } from "../benchmarks/react-comparison/run.mjs";

test("React comparison builds matched production fixtures with Compiler enabled", async () => {
  const result = await buildComparison({ rows: 20 });
  const [keltaMarkup, reactMarkup, metadata] = await Promise.all([
    readFile(join(result.output, "kelta-markup.html"), "utf8"),
    readFile(join(result.output, "react-markup.html"), "utf8"),
    readFile(join(result.output, "metadata.json"), "utf8").then(JSON.parse),
  ]);

  assert.equal(metadata.rowCount, 20);
  assert.equal(metadata.reactCompilerVerified, true);
  assert.equal(metadata.versions.react, "19.2.7");
  assert.equal(metadata.versions.reactCompiler, "1.0.0");
  assert.equal(countRows(keltaMarkup), 20);
  assert.equal(countRows(reactMarkup), 20);
  assert.match(keltaMarkup, /data-delta-row=/);
  assert.match(reactMarkup, /data-row-id="20"/);
  assert.match(keltaMarkup, /type="checkbox" tabindex="-1" readonly/);
  assert.match(reactMarkup, /type="checkbox" tabindex="-1" readOnly=""/);
  assert.ok(metadata.artifacts.kelta.total.brotli > 0);
  assert.ok(metadata.artifacts.react.total.brotli > 0);
});

test("React comparison records reproducibility provenance", async () => {
  const source = await sourceMetadata();
  assert.equal(source.nodeVersion, process.version);
  assert.match(source.packageLockSha256, /^[a-f0-9]{64}$/);
  assert.match(source.measuredSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(source.measuredFileCount, source.measuredFiles.length);
  assert.ok(source.measuredFiles.includes("benchmarks/react-comparison/run.mjs"));
  assert.ok(source.measuredFiles.includes("benchmarks/react-comparison/runner.html"));
  assert.ok(source.measuredFiles.includes("benchmarks/react-comparison/browser.mjs"));
  assert.ok(source.measuredFiles.some((file) => file.startsWith("src/runtime/")));
  if (source.gitRevision !== null) assert.match(source.gitRevision, /^[a-f0-9]{40}$/);
  assert.ok(source.gitDirty === null || typeof source.gitDirty === "boolean");
});

function countRows(markup) {
  return [...markup.matchAll(/class="bench-row(?: active)?"/g)].length;
}
