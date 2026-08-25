import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function parseArguments(argv) {
  const options = { port: Number(process.env.PORT ?? 4175) };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    else if (argument === "--base") options.base = argv[++index];
    else if (argument === "--input") options.input = argv[++index];
    else if (argument === "--workspace") options.workspace = argv[++index];
    else if (argument === "--port") options.port = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.base || !options.input || !options.workspace) {
    throw new Error("Usage: pnpm eval:refine -- --base <image> --input <photos> --workspace <directory>");
  }
  return options;
}

function validNumber(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validateState(value, photoNames) {
  const region = value?.region;
  if (value?.version !== 1 || !region || !Array.isArray(value.overlays)) throw new Error("Invalid refinement document");
  if (!validNumber(region.x, 0, 1024) || !validNumber(region.y, 0, 1024) || !validNumber(region.width, 20, 1024) || !validNumber(region.height, 20, 1024) || region.x + region.width > 1024 || region.y + region.height > 1024) {
    throw new Error("Invalid correction area");
  }
  for (const overlay of value.overlays) {
    if (!photoNames.includes(overlay.source) || !validNumber(overlay.x, -1024, 2048) || !validNumber(overlay.y, -1024, 2048) || !validNumber(overlay.width, 20, 2048) || !validNumber(overlay.height, 20, 2048) || !validNumber(overlay.rotation, -180, 180) || !validNumber(overlay.opacity, 0.1, 1)) {
      throw new Error("Invalid photo overlay");
    }
  }
  if (typeof value.guideDataUrl !== "string" || !value.guideDataUrl.startsWith("data:image/png;base64,")) throw new Error("Missing guide image");
  const guide = Buffer.from(value.guideDataUrl.slice("data:image/png;base64,".length), "base64");
  if (guide.length === 0 || guide.length > 12_000_000) throw new Error("Invalid guide image");
  return { document: { version: 1, region, overlays: value.overlays }, guide };
}

async function readRequestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 17_000_000) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const basePath = resolve(options.base);
  const inputDirectory = resolve(options.input);
  const workspace = resolve(options.workspace);
  await mkdir(workspace, { recursive: true });
  const entries = await readdir(inputDirectory, { withFileTypes: true });
  const photoNames = entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())).map(({ name }) => name).sort();
  if (photoNames.length === 0) throw new Error("No supported photos found");

  let savedState;
  try {
    savedState = JSON.parse(await readFile(join(workspace, "refinement.json"), "utf8"));
  } catch {}
  const editorHtml = await readFile(new URL("./refinement-guide-editor.html", import.meta.url));

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" });
        return response.end(editorHtml);
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return response.end(JSON.stringify({ photos: photoNames, refinement: savedState ?? null }));
      }
      if (request.method === "GET" && url.pathname === "/base") {
        response.writeHead(200, { "Content-Type": MIME_TYPES[extname(basePath).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" });
        return response.end(await readFile(basePath));
      }
      if (request.method === "GET" && url.pathname.startsWith("/photos/")) {
        const name = decodeURIComponent(url.pathname.slice("/photos/".length));
        if (!photoNames.includes(name)) throw new Error("Photo not found");
        response.writeHead(200, { "Content-Type": MIME_TYPES[extname(name).toLowerCase()], "Cache-Control": "private, max-age=3600" });
        return response.end(await readFile(join(inputDirectory, name)));
      }
      if (request.method === "POST" && url.pathname === "/api/refinement") {
        const { document, guide } = validateState(await readRequestJson(request), photoNames);
        await writeFile(join(workspace, "refinement.json"), JSON.stringify(document, null, 2));
        await writeFile(join(workspace, "refinement-guide.png"), guide);
        const { x, y, width, height } = document.region;
        await execFileAsync("magick", [
          "-size", "1024x1024", "xc:black", "-fill", "white",
          "-draw", `rectangle ${Math.round(x)},${Math.round(y)} ${Math.round(x + width)},${Math.round(y + height)}`,
          join(workspace, "refinement-mask.png"),
        ]);
        savedState = document;
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ saved: true }));
      }
      response.writeHead(404).end("Not found");
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(options.port, "0.0.0.0", () => console.log(`Refinement guide editor listening on port ${options.port}`));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
