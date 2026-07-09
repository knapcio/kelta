import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildComparison } from "../benchmarks/react-comparison/build.mjs";
import { build } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildPages(options = {}) {
  const output = join(root, "_site");
  const demo = await build();
  const comparison = await buildComparison({
    rows: options.rows ?? process.env.BENCH_ROWS ?? 10_000,
  });
  const resultPath = join(
    root,
    "benchmarks/react-comparison/results/latest.json",
  );

  // Fail before deleting an existing preview if the checked-in data is absent.
  await readFile(resultPath);
  await rm(output, { recursive: true, force: true });
  await cp(join(root, "site"), output, { recursive: true });
  await Promise.all([
    cp(demo.output, join(output, "demo"), { recursive: true }),
    cp(comparison.output, join(output, "benchmark-runner"), {
      recursive: true,
    }),
    mkdir(join(output, "results"), { recursive: true }),
    writeFile(join(output, ".nojekyll"), ""),
  ]);
  await cp(resultPath, join(output, "results/react-comparison.json"));

  return { output, demo, comparison };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await buildPages();
  console.log(
    `Built GitHub Pages artifact at ${result.output} · docs + demo + ${result.comparison.rowCount.toLocaleString()}-row benchmark runner`,
  );
}
