import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "_site");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

export function startPagesServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 4174);
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const safePath = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(output, safePath);

    if (!file.startsWith(output) || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Kelta Pages preview: http://127.0.0.1:${port}`);
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!existsSync(join(output, "index.html"))) {
    console.error("No Pages build found. Run `npm run pages:build` first.");
    process.exitCode = 1;
  } else {
    startPagesServer();
  }
}
