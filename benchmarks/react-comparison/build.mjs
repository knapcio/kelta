import { transformAsync } from "@babel/core";
import { build as bundle } from "esbuild";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";

import { compileApp } from "../../src/compiler.js";
import {
  benchmarkConstants,
  createKeltaBenchmarkApp,
  createRows,
} from "./kelta-app.mjs";

const benchmarkDir = resolve(dirname(fileURLToPath(import.meta.url)));
const root = resolve(benchmarkDir, "../..");
const output = join(benchmarkDir, "dist");
const generated = join(output, ".generated");

export async function buildComparison(options = {}) {
  const rowCount = positiveInteger(options.rows ?? process.env.ROWS ?? 10_000);
  const rows = createRows(rowCount);
  const constants = benchmarkConstants(rowCount);
  const kelta = compileApp(createKeltaBenchmarkApp(rows));
  const keltaMarkup = extractKeltaMarkup(kelta.html);

  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, "size"), { recursive: true });
  await mkdir(generated, { recursive: true });

  const compiledReact = await compileReactSource();
  const compiledReactPath = join(generated, "react-app.compiled.jsx");
  await writeFile(compiledReactPath, compiledReact);
  if (!compiledReact.includes("react/compiler-runtime")) {
    throw new Error(
      "React Compiler did not emit its runtime cache import; refusing to label this as a compiler-enabled result",
    );
  }

  const ssrModulePath = join(generated, "react-app.ssr.mjs");
  await bundle({
    entryPoints: [compiledReactPath],
    outfile: ssrModulePath,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
  });
  const { ReactBenchmarkApp } = await import(
    `${pathToFileURL(ssrModulePath).href}?build=${Date.now()}`
  );
  const reactDocument = createElement(
    "html",
    null,
    createElement("head", null),
    createElement(
      "body",
      null,
      createElement(
        "div",
        { id: "react-root" },
        createElement(ReactBenchmarkApp, {
          initialRows: rows,
          constants,
          readyRef: undefined,
        }),
      ),
    ),
  );
  const { prelude } = await prerenderToNodeStream(reactDocument);
  const reactDocumentHtml = await streamToString(prelude);
  const reactMarkup = extractReactRoot(reactDocumentHtml);

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const versions = {
    kelta: packageJson.version,
    react: packageJson.devDependencies.react,
    reactDom: packageJson.devDependencies["react-dom"],
    reactCompiler: packageJson.devDependencies["babel-plugin-react-compiler"],
    esbuild: packageJson.devDependencies.esbuild,
    playwrightCore: packageJson.devDependencies["playwright-core"],
  };

  const dataBasePath = join(generated, "data-base.mjs");
  await writeFile(
    dataBasePath,
    serializeModule({ rows, constants, keltaPlan: kelta.plan, keltaSnapshot: kelta.snapshot }),
  );
  await writeSizeEntries();
  await Promise.all([
    buildSizeBundle("kelta-client"),
    buildSizeBundle("react-client"),
  ]);

  const keltaCapsule = `<script id="delta-resume" type="application/json">${safeJson(kelta.snapshot)}</script>`;
  const reactData = `<script id="react-data" type="application/json">${safeJson({ rows, constants })}</script>`;
  const artifacts = {
    sharedCssExcluded: true,
    kelta: {
      html: byteSizes(`${keltaMarkup}${keltaCapsule}`),
      clientJavaScript: await fileSizes(join(output, "size/kelta-client.js")),
    },
    react: {
      html: byteSizes(`${reactMarkup}${reactData}`),
      clientJavaScript: await fileSizes(join(output, "size/react-client.js")),
    },
  };
  for (const framework of ["kelta", "react"]) {
    artifacts[framework].total = sumSizes(
      artifacts[framework].html,
      artifacts[framework].clientJavaScript,
    );
  }

  await writeFile(
    join(generated, "data.mjs"),
    serializeModule({
      rows,
      constants,
      keltaPlan: kelta.plan,
      keltaSnapshot: kelta.snapshot,
      versions,
      artifacts,
    }),
  );

  await Promise.all([
    writeFile(join(output, "kelta-markup.html"), keltaMarkup),
    writeFile(join(output, "react-markup.html"), reactMarkup),
    writeFile(
      join(output, "metadata.json"),
      `${JSON.stringify({ rowCount, versions, artifacts, reactCompilerVerified: true }, null, 2)}\n`,
    ),
    copyFile(join(benchmarkDir, "runner.html"), join(output, "index.html")),
    copyFile(join(benchmarkDir, "style.css"), join(output, "style.css")),
  ]);

  await bundle({
    entryPoints: [join(benchmarkDir, "browser.mjs")],
    outfile: join(output, "benchmark.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["chrome120"],
    jsx: "automatic",
    minify: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    logLevel: "silent",
  });

  return {
    output,
    rowCount,
    versions,
    artifacts,
    reactCompilerVerified: true,
  };
}

async function compileReactSource() {
  const filename = join(benchmarkDir, "react-app.jsx");
  const source = await readFile(filename, "utf8");
  const result = await transformAsync(source, {
    filename,
    sourceType: "module",
    parserOpts: { plugins: ["jsx"] },
    plugins: [["babel-plugin-react-compiler", { target: "19" }]],
    configFile: false,
    babelrc: false,
    comments: false,
    compact: false,
  });
  if (!result?.code) throw new Error("React Compiler returned no code");
  return `${result.code}\n`;
}

async function writeSizeEntries() {
  const browserRuntime = join(root, "src/runtime/browser.js");
  await Promise.all([
    writeFile(
      join(generated, "kelta-client.mjs"),
      [
        `import { resume } from ${JSON.stringify(browserRuntime)};`,
        'import { keltaPlan } from "./data-base.mjs";',
        "export function startKelta(root, snapshot) {",
        "  return resume(keltaPlan, root, snapshot);",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(generated, "react-client.mjs"),
      [
        'import { createElement } from "react";',
        'import { hydrateRoot } from "react-dom/client";',
        'import { ReactBenchmarkApp } from "./react-app.compiled.jsx";',
        "export function startReact(root, initialRows, constants, readyRef) {",
        "  return hydrateRoot(root, createElement(ReactBenchmarkApp, { initialRows, constants, readyRef }));",
        "}",
        "",
      ].join("\n"),
    ),
  ]);
}

async function buildSizeBundle(name) {
  await bundle({
    entryPoints: [join(generated, `${name}.mjs`)],
    outfile: join(output, `size/${name}.js`),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["chrome120"],
    jsx: "automatic",
    minify: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    logLevel: "silent",
  });
}

function extractKeltaMarkup(html) {
  const bodyStart = html.indexOf("<body>");
  const capsuleStart = html.indexOf('<script id="delta-resume"');
  if (bodyStart === -1 || capsuleStart === -1) {
    throw new Error("Could not extract Kelta server markup");
  }
  return html.slice(bodyStart + "<body>".length, capsuleStart);
}

function extractReactRoot(html) {
  const marker = '<div id="react-root">';
  const start = html.indexOf(marker);
  const end = html.lastIndexOf("</div></body>");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not extract React prerendered root");
  }
  return html.slice(start + marker.length, end);
}

function serializeModule(values) {
  return `${Object.entries(values)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join("\n")}\n`;
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function byteSizes(value) {
  const bytes = Buffer.from(value);
  return {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes).byteLength,
  };
}

async function fileSizes(filename) {
  const value = await readFile(filename);
  const file = await stat(filename);
  return {
    raw: file.size,
    gzip: gzipSync(value, { level: 9 }).byteLength,
    brotli: brotliCompressSync(value).byteLength,
  };
}

function sumSizes(left, right) {
  return {
    raw: left.raw + right.raw,
    gzip: left.gzip + right.gzip,
    brotli: left.brotli + right.brotli,
  };
}

function streamToString(stream) {
  return new Promise((resolveStream, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
    });
    stream.on("end", () => resolveStream(output));
    stream.on("error", reject);
  });
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`ROWS must be a positive integer; received ${String(value)}`);
  }
  return parsed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await buildComparison();
  console.log(
    `Built matched ${result.rowCount.toLocaleString()}-row comparison · React ${result.versions.react} + Compiler ${result.versions.reactCompiler}`,
  );
}
