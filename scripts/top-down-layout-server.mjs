import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png" };

function parseArguments(argv) {
  const options = { port: Number(process.env.PORT ?? 4174) };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    else if (argument === "--input") options.input = argv[++index];
    else if (argument === "--workspace") options.workspace = argv[++index];
    else if (argument === "--port") options.port = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.input || !options.workspace) {
    throw new Error("Usage: pnpm eval:layout -- --input <photos> --workspace <directory> [--port 4174]");
  }
  return options;
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function pointsAttribute(points) {
  return points.map(({ x, y }) => `${x},${y}`).join(" ");
}

function renderLayoutSvg(layout) {
  const boundary = layout.boundary.length >= 3
    ? `<polygon points="${pointsAttribute(layout.boundary)}" fill="#dce8c7" stroke="#3c5a36" stroke-width="8"/>`
    : "";
  const structures = layout.structures.map((structure) =>
    `<g><polygon points="${pointsAttribute(structure.points)}" fill="#e8d6b8" stroke="#5f4935" stroke-width="6"/><text x="${structure.points[0]?.x ?? 0}" y="${(structure.points[0]?.y ?? 0) - 10}" font-size="24" font-weight="700">${escapeXml(structure.name)}</text></g>`).join("");
  const landmarks = layout.landmarks.map((landmark) =>
    `<g><circle cx="${landmark.x}" cy="${landmark.y}" r="11" fill="#714c8c"/><text x="${landmark.x + 16}" y="${landmark.y + 8}" font-size="22">${escapeXml(landmark.name)}</text></g>`).join("");
  const cameras = layout.cameras.filter((camera) => camera.included !== false).map((camera) => {
    const radians = camera.angle * Math.PI / 180;
    const length = 95;
    const halfFov = camera.fieldOfView * Math.PI / 360;
    const leftX = camera.x + Math.cos(radians - halfFov) * length;
    const leftY = camera.y + Math.sin(radians - halfFov) * length;
    const rightX = camera.x + Math.cos(radians + halfFov) * length;
    const rightY = camera.y + Math.sin(radians + halfFov) * length;
    const endX = camera.x + Math.cos(radians) * length;
    const endY = camera.y + Math.sin(radians) * length;
    return `<g><path d="M${camera.x} ${camera.y}L${leftX} ${leftY}A${length} ${length} 0 0 1 ${rightX} ${rightY}Z" fill="#c7505433"/><line x1="${camera.x}" y1="${camera.y}" x2="${endX}" y2="${endY}" stroke="#b52a32" stroke-width="8" marker-end="url(#arrow)"/><circle cx="${camera.x}" cy="${camera.y}" r="24" fill="#fff" stroke="#b52a32" stroke-width="7"/><text x="${camera.x}" y="${camera.y + 8}" text-anchor="middle" font-size="22" font-weight="800">${escapeXml(camera.label)}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700"><defs><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#d7d7d2" stroke-width="1"/></pattern><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#b52a32"/></marker></defs><rect width="1000" height="700" fill="#f6f5ef"/><rect width="1000" height="700" fill="url(#grid)"/>${boundary}${structures}${landmarks}${cameras}<text x="25" y="675" font-family="sans-serif" font-size="18" fill="#555">Approximate user layout. Not to scale.</text></svg>`;
}

function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1000 && point.y >= 0 && point.y <= 700;
}

function validateLayout(value, photoNames) {
  if (!value || value.version !== 1 || !Array.isArray(value.cameras) || !Array.isArray(value.boundary) || !Array.isArray(value.structures) || !Array.isArray(value.landmarks)) {
    throw new Error("Invalid layout document");
  }
  if (value.cameras.length !== photoNames.length || value.cameras.some((camera) => !photoNames.includes(camera.source) || !validPoint(camera) || !Number.isFinite(camera.angle) || !Number.isFinite(camera.fieldOfView) || (camera.included !== undefined && typeof camera.included !== "boolean"))) {
    throw new Error("Invalid camera data");
  }
  if (value.boundary.some((point) => !validPoint(point)) || value.structures.some((structure) => !structure.name || structure.points.length < 3 || structure.points.some((point) => !validPoint(point))) || value.landmarks.some((landmark) => !landmark.name || !validPoint(landmark))) {
    throw new Error("Invalid plan geometry");
  }
  return value;
}

async function readRequestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inputDirectory = resolve(options.input);
  const workspace = resolve(options.workspace);
  const photoDirectory = join(workspace, "photos");
  await mkdir(photoDirectory, { recursive: true });

  const sourceEntries = await readdir(inputDirectory, { withFileTypes: true });
  const sources = sourceEntries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  if (sources.length === 0) throw new Error("No supported photos found");
  const photoNames = [];
  for (const source of sources) {
    const outputName = `${basename(source.name, extname(source.name))}.jpg`;
    await execFileAsync("magick", [join(inputDirectory, source.name), "-auto-orient", "-resize", "1200x1200>", "-strip", "-quality", "86", join(photoDirectory, outputName)]);
    photoNames.push(outputName);
  }

  let savedLayout;
  try {
    savedLayout = JSON.parse(await readFile(join(workspace, "layout.json"), "utf8"));
  } catch {}
  const editorHtml = await readFile(new URL("./top-down-layout-editor.html", import.meta.url));

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" });
        return response.end(editorHtml);
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return response.end(JSON.stringify({ photos: photoNames, layout: savedLayout ?? null }));
      }
      if (request.method === "GET" && url.pathname.startsWith("/photos/")) {
        const name = decodeURIComponent(url.pathname.slice("/photos/".length));
        if (!photoNames.includes(name)) throw new Error("Photo not found");
        response.writeHead(200, { "Content-Type": MIME_TYPES[extname(name)], "Cache-Control": "private, max-age=3600" });
        return response.end(await readFile(join(photoDirectory, name)));
      }
      if (request.method === "POST" && url.pathname === "/api/layout") {
        const layout = validateLayout(await readRequestJson(request), photoNames);
        const svg = renderLayoutSvg(layout);
        await writeFile(join(workspace, "layout.json"), JSON.stringify(layout, null, 2));
        await writeFile(join(workspace, "layout.svg"), svg);
        await execFileAsync("magick", ["-background", "white", join(workspace, "layout.svg"), join(workspace, "layout.png")]);
        savedLayout = layout;
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ saved: true }));
      }
      response.writeHead(404).end("Not found");
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(options.port, "0.0.0.0", () => {
    console.log(`Garden layout editor listening on port ${options.port}`);
    console.log(`Workspace: ${workspace}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
