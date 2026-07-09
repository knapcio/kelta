import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

import { buildComparison } from "./build.mjs";

const benchmarkDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(benchmarkDir, "../..");

export async function runComparison(options = {}) {
  const configuration = normalizeOptions(options);
  const build = await buildComparison({ rows: configuration.rows });
  const server = await startServer(build.output);
  let browser;

  try {
    browser = await launchBrowser(configuration);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);

    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error?.stack ?? error)));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(server.url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__KELTA_REACT_BENCH_READY__ === true);
    const result = await page.evaluate(
      (browserOptions) => globalThis.runKeltaReactBenchmark(browserOptions),
      {
        activationSamples: configuration.activationSamples,
        warmups: configuration.warmups,
        samples: configuration.samples,
        broadSamples: configuration.broadSamples,
      },
    );

    if (pageErrors.length > 0) {
      throw new Error(`Browser console/page error: ${pageErrors[0]}`);
    }

    result.environment.browserChannel = configuration.browser;
    result.environment.headless = !configuration.headed;
    result.environment.viewport = "1280x900";
    result.host = hostMetadata();
    result.source = await sourceMetadata();
    result.runCommand = configuration.command;

    const resultDirectory = resolve(configuration.output);
    await mkdir(resultDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(resultDirectory, "latest.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      ),
      writeFile(join(resultDirectory, "latest.md"), markdownReport(result)),
    ]);

    return result;
  } finally {
    await browser?.close();
    await server.close();
  }
}

async function launchBrowser(configuration) {
  const options = {
    headless: !configuration.headed,
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  };
  if (configuration.executablePath) {
    options.executablePath = configuration.executablePath;
  } else if (configuration.browser !== "chromium") {
    options.channel = configuration.browser;
  }

  try {
    return await chromium.launch(options);
  } catch (error) {
    throw new Error(
      `Could not launch ${configuration.browser}. Pass --browser chrome/msedge/chromium or --executable-path /path/to/browser. Original error: ${error.message}`,
      { cause: error },
    );
  }
}

function normalizeOptions(options) {
  const profile = options.profile ?? "quick";
  if (!new Set(["quick", "publication"]).has(profile)) {
    throw new TypeError(`Unknown profile ${profile}; use quick or publication`);
  }
  const defaults =
    profile === "publication"
      ? { activationSamples: 30, warmups: 10, samples: 200, broadSamples: 30 }
      : { activationSamples: 3, warmups: 2, samples: 10, broadSamples: 3 };

  return {
    rows: positiveInteger(options.rows ?? 10_000, "rows"),
    activationSamples: positiveInteger(
      options.activationSamples ?? defaults.activationSamples,
      "activation-samples",
    ),
    warmups: nonNegativeInteger(options.warmups ?? defaults.warmups, "warmups"),
    samples: positiveInteger(options.samples ?? defaults.samples, "samples"),
    broadSamples: positiveInteger(
      options.broadSamples ?? defaults.broadSamples,
      "broad-samples",
    ),
    browser: options.browser ?? process.env.BENCH_BROWSER ?? "chrome",
    executablePath: options.executablePath ?? process.env.BENCH_BROWSER_PATH,
    headed: Boolean(options.headed),
    profile,
    output: options.output ?? join(benchmarkDir, "results"),
    command: options.command ?? "npm run bench:react",
  };
}

function markdownReport(result) {
  const comparisons = [
    result.activation,
    ...Object.values(result.interactions),
  ];
  const rows = comparisons
    .map(
      (comparison) =>
        `| ${comparison.label} | ${metric(comparison.kelta.domReadyMs)} | ${metric(comparison.react.domReadyMs)} | ${metric(comparison.kelta.nextFrameMs)} | ${metric(comparison.react.nextFrameMs)} |`,
    )
    .join("\n");

  return `# Kelta × React benchmark result

> A local observation, not a universal ranking. Read [the methodology](../../../docs/react-comparison.md) before interpreting these numbers.

- Generated: ${result.generatedAt}
- Rows: ${result.configuration.rows.toLocaleString("en-US")}
- Browser: ${result.environment.userAgent}
- Host: ${result.host?.cpuModel ?? result.environment.platform}; ${result.host?.arch ?? "unknown architecture"}; ${result.host?.logicalCores ?? result.environment.hardwareConcurrency ?? "unknown"} logical cores; ${result.host?.totalMemoryGiB ?? "unknown"} GiB memory
- React: ${result.versions.react} / React DOM ${result.versions.reactDom}
- React Compiler: ${result.versions.reactCompiler} (compiler runtime import verified)
- Node: ${result.source?.nodeVersion ?? "not recorded"}
- Git revision: ${result.source?.gitRevision ?? "not recorded"}${result.source?.gitDirty ? " (working tree had changes)" : ""}
- Measured-source SHA-256: ${result.source?.measuredSourceSha256 ?? "not recorded"}
- Samples: ${result.configuration.activationSamples} activation; ${result.configuration.samples} per targeted interaction; ${result.configuration.broadSamples ?? result.configuration.samples} broad-filter samples; ${result.configuration.warmups} warmups

Exact command:

\`\`\`sh
${result.runCommand ?? "not recorded"}
\`\`\`

All cells are **median / p95 milliseconds**.

| Workload | Kelta DOM-ready | React DOM-ready | Kelta next frame | React next frame |
| --- | ---: | ---: | ---: | ---: |
${rows}

## Transferred artifact model

Shared CSS is excluded. HTML includes serialized initial data; client JavaScript is a minified production bundle.

| Artifact | Kelta raw / gzip / Brotli | React raw / gzip / Brotli |
| --- | ---: | ---: |
| Server HTML + data | ${sizes(result.artifacts.kelta.html)} | ${sizes(result.artifacts.react.html)} |
| Client JavaScript | ${sizes(result.artifacts.kelta.clientJavaScript)} | ${sizes(result.artifacts.react.clientJavaScript)} |
| Total | ${sizes(result.artifacts.kelta.total)} | ${sizes(result.artifacts.react.total)} |

## Boundaries

- Kelta and React start from their own equivalent server-rendered DOM and the same row data.
- React uses an idiomatic immutable reducer, stable numeric keys, and stable React Compiler 1.0.
- Interactions dispatch real click events and end only after the expected DOM state is observed.
- “Next frame” is a requestAnimationFrame boundary, not a guaranteed presentation timestamp.
- Activation excludes HTML insertion and JavaScript parsing/evaluation; artifact sizes are reported separately.
- MutationObserver does not observe property-only writes, so DOM mutation telemetry is diagnostic rather than a complete operation count.
- The workload is a synchronous, non-virtualized list with derived filter/order/count state. It does not represent all frontend applications.

Raw per-sample timing, DOM mutation records, and Kelta transaction journals are in [latest.json](./latest.json).
`;
}

function metric(stats) {
  return `${stats.median.toFixed(2)} / ${stats.p95.toFixed(2)}`;
}

function sizes(value) {
  return `${formatBytes(value.raw)} / ${formatBytes(value.gzip)} / ${formatBytes(value.brotli)}`;
}

function hostMetadata() {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    totalMemoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
  };
}

export async function sourceMetadata() {
  const measuredFiles = [
    ...(await filesBelow("src")),
    "benchmarks/react-comparison/browser.mjs",
    "benchmarks/react-comparison/build.mjs",
    "benchmarks/react-comparison/kelta-app.mjs",
    "benchmarks/react-comparison/react-app.jsx",
    "benchmarks/react-comparison/run.mjs",
    "benchmarks/react-comparison/runner.html",
    "benchmarks/react-comparison/style.css",
    "package.json",
  ].sort();
  const measuredHash = createHash("sha256");
  for (const relative of measuredFiles) {
    measuredHash.update(relative.replaceAll("\\", "/"));
    measuredHash.update("\0");
    measuredHash.update(await readFile(join(repositoryRoot, relative)));
    measuredHash.update("\0");
  }
  const lockfile = await readFile(join(repositoryRoot, "package-lock.json"));

  const gitStatus = gitOutput(["status", "--porcelain", "--untracked-files=all"]);
  return {
    gitRevision: gitOutput(["rev-parse", "HEAD"]),
    gitDirty: gitStatus === null ? null : gitStatus !== "",
    nodeVersion: process.version,
    packageLockSha256: createHash("sha256").update(lockfile).digest("hex"),
    measuredSourceSha256: measuredHash.digest("hex"),
    measuredFileCount: measuredFiles.length,
    measuredFiles: measuredFiles.map((relative) => relative.replaceAll("\\", "/")),
  };
}

async function filesBelow(relativeDirectory) {
  const directory = join(repositoryRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function gitOutput(arguments_) {
  try {
    return execFileSync("git", arguments_, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function startServer(root) {
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
    let filename = join(root, safe);
    if (!filename.startsWith(root) || !existsSync(filename)) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (statSync(filename).isDirectory()) filename = join(filename, "index.html");
    const stream = createReadStream(filename);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes[extname(filename)] ?? "application/octet-stream",
    });
    stream.pipe(response);
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--headed") {
      result.headed = true;
      continue;
    }
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument ${token}`);
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    const name = rawName.replaceAll("-", "_");
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new TypeError(`Missing value for --${rawName}`);
    result[name] = value;
  }
  return {
    rows: result.rows,
    activationSamples: result.activation_samples,
    warmups: result.warmups,
    samples: result.samples,
    broadSamples: result.broad_samples,
    browser: result.browser,
    executablePath: result.executable_path,
    profile: result.profile,
    output: result.output,
    headed: result.headed,
    command: `node benchmarks/react-comparison/run.mjs ${argv.join(" ")}`.trim(),
  };
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await runComparison(parseArguments(process.argv.slice(2)));
  console.log(markdownReport(result));
}
