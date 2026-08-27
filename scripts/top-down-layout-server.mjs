import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MODEL_DEFINITIONS } from "./evaluate-top-down-images.mjs";

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const AVAILABLE_MODELS = MODEL_DEFINITIONS.filter(({ maskedEdit }) => !maskedEdit);

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
  if (!options.workspace) {
    throw new Error("Usage: pnpm eval:layout -- --workspace <directory> [--input <photos>] [--port 4174]");
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

async function readRequestBuffer(request, maximumSize) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumSize) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readRequestJson(request) {
  return JSON.parse((await readRequestBuffer(request, 1_000_000)).toString("utf8"));
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function photoNames(photoDirectory) {
  const entries = await readdir(photoDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())).map(({ name }) => name).sort((a, b) => a.localeCompare(b));
}

async function saveLayout(workspace, layout) {
  const svg = renderLayoutSvg(layout);
  await writeFile(join(workspace, "layout.json"), JSON.stringify(layout, null, 2));
  await writeFile(join(workspace, "layout.svg"), svg);
  await execFileAsync("magick", ["-background", "white", join(workspace, "layout.svg"), join(workspace, "layout.png")]);
}

function safeUploadName(originalName, existingNames) {
  const extension = extname(originalName).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error("Supported image types are JPEG, PNG, and WebP");
  const stem = basename(originalName, extension).replaceAll(/[^a-zA-Z0-9._-]/g, "-").replaceAll(/-+/g, "-").slice(0, 80) || "photo";
  let name = `${stem}.jpg`;
  for (let suffix = 2; existingNames.includes(name); suffix += 1) name = `${stem}-${suffix}.jpg`;
  return name;
}

async function latestRun(workspace) {
  const runsDirectory = join(workspace, "runs");
  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort().reverse();
  for (const runId of names) {
    const manifest = await readJson(join(runsDirectory, runId, "manifest.json"));
    if (!manifest) continue;
    const blindMap = await readJson(join(runsDirectory, runId, "blind-map.json"), []);
    const scores = await readJson(join(runsDirectory, runId, "scores.json"), {});
    const completedByModel = new Map(manifest.results.filter(({ status }) => status === "completed").map((result) => [result.model, result]));
    return {
      runId,
      createdAt: manifest.createdAt,
      results: blindMap.flatMap(({ label, model }) => {
        const result = completedByModel.get(model);
        return result ? [{ label, file: result.file, elapsedMilliseconds: result.elapsedMilliseconds }] : [];
      }),
      failures: manifest.results.filter(({ status }) => status === "failed").map(({ model, error }) => ({ model, error })),
      scores,
    };
  }
  return null;
}

function validateScores(value, labels) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scores");
  const criteria = ["objectPresence", "relativePlacement", "overheadViewpoint", "noHallucinations"];
  const result = {};
  for (const label of labels) {
    const score = value[label];
    if (!score) continue;
    if (criteria.some((criterion) => !Number.isInteger(score[criterion]) || score[criterion] < 1 || score[criterion] > 5) || typeof score.notes !== "string" || score.notes.length > 4000) {
      throw new Error(`Invalid score for candidate ${label}`);
    }
    result[label] = Object.fromEntries([...criteria.map((criterion) => [criterion, score[criterion]]), ["notes", score.notes]]);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspace = resolve(options.workspace);
  const photoDirectory = join(workspace, "photos");
  const runsDirectory = join(workspace, "runs");
  await mkdir(photoDirectory, { recursive: true });
  await mkdir(runsDirectory, { recursive: true });

  if (options.input) {
    const inputDirectory = resolve(options.input);
    const sources = (await readdir(inputDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const source of sources) {
      const outputName = `${basename(source.name, extname(source.name))}.jpg`;
      await execFileAsync("magick", [join(inputDirectory, source.name), "-auto-orient", "-resize", "1600x1600>", "-strip", "-quality", "88", join(photoDirectory, outputName)]);
    }
  }

  let savedLayout = await readJson(join(workspace, "layout.json"));
  let generation = { status: "idle" };
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
        return response.end(JSON.stringify({
          photos: await photoNames(photoDirectory),
          layout: savedLayout,
          models: AVAILABLE_MODELS.map(({ id, slug }) => ({ id, name: slug.replaceAll("-", " ") })),
          generation,
          latestRun: await latestRun(workspace),
        }));
      }
      if (request.method === "GET" && url.pathname.startsWith("/photos/")) {
        const name = decodeURIComponent(url.pathname.slice("/photos/".length));
        if (!(await photoNames(photoDirectory)).includes(name)) throw new Error("Photo not found");
        response.writeHead(200, { "Content-Type": MIME_TYPES[extname(name)], "Cache-Control": "private, max-age=3600" });
        return response.end(await readFile(join(photoDirectory, name)));
      }
      if (request.method === "POST" && url.pathname === "/api/photos") {
        const originalName = decodeURIComponent(String(request.headers["x-file-name"] ?? ""));
        const names = await photoNames(photoDirectory);
        const outputName = safeUploadName(originalName, names);
        const temporaryPath = join(workspace, `.upload-${randomUUID()}${extname(originalName).toLowerCase()}`);
        try {
          await writeFile(temporaryPath, await readRequestBuffer(request, 30_000_000));
          await execFileAsync("magick", [temporaryPath, "-auto-orient", "-resize", "1600x1600>", "-strip", "-quality", "88", join(photoDirectory, outputName)]);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        response.writeHead(201, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ name: outputName }));
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/photos/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/photos/".length));
        if (!(await photoNames(photoDirectory)).includes(name)) throw new Error("Photo not found");
        await rm(join(photoDirectory, name));
        if (savedLayout) {
          savedLayout.cameras = savedLayout.cameras.filter((camera) => camera.source !== name).map((camera, index) => ({ ...camera, label: String(index + 1) }));
          await saveLayout(workspace, savedLayout);
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ deleted: true }));
      }
      if (request.method === "POST" && url.pathname === "/api/layout") {
        const layout = validateLayout(await readRequestJson(request), await photoNames(photoDirectory));
        await saveLayout(workspace, layout);
        savedLayout = layout;
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ saved: true }));
      }
      if (request.method === "POST" && url.pathname === "/api/generate") {
        if (generation.status === "running") throw new Error("A generation is already running");
        if (!savedLayout) throw new Error("Save the layout before generating");
        if (!savedLayout.cameras.some((camera) => camera.included !== false)) throw new Error("Include at least one photo before generating");
        const body = await readRequestJson(request);
        const models = Array.isArray(body.models) ? body.models : [];
        if (models.length === 0 || models.some((id) => !AVAILABLE_MODELS.some((model) => model.id === id))) throw new Error("Select at least one valid model");
        const runId = `run-${new Date().toISOString().replaceAll(":", "-")}`;
        const outputDirectory = join(runsDirectory, runId);
        const evaluator = fileURLToPath(new URL("./evaluate-top-down-images.mjs", import.meta.url));
        const child = spawn(process.execPath, [evaluator, "--input", photoDirectory, "--layout", join(workspace, "layout.json"), "--output", outputDirectory, "--models", models.join(",")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        generation = { status: "running", runId, startedAt: new Date().toISOString(), log: "Starting generation…" };
        const output = [];
        const capture = (chunk) => {
          output.push(chunk.toString());
          generation.log = output.join("").trim().split("\n").slice(-4).join("\n");
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.on("error", (error) => { generation = { ...generation, status: "failed", error: error.message }; });
        child.on("close", (code) => {
          generation = code === 0
            ? { ...generation, status: "completed", completedAt: new Date().toISOString() }
            : { ...generation, status: "failed", completedAt: new Date().toISOString(), error: generation.log || `Evaluator exited with code ${code}` };
        });
        response.writeHead(202, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ runId }));
      }
      if (request.method === "GET" && /^\/runs\/[^/]+\/outputs\/[^/]+$/.test(url.pathname)) {
        const [, , runId, , file] = url.pathname.split("/").map(decodeURIComponent);
        const manifest = await readJson(join(runsDirectory, runId, "manifest.json"));
        if (!manifest?.results.some((result) => result.status === "completed" && result.file === file)) throw new Error("Result not found");
        response.writeHead(200, { "Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" });
        return response.end(await readFile(join(runsDirectory, runId, "outputs", file)));
      }
      if (request.method === "POST" && /^\/api\/runs\/[^/]+\/scores$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.split("/")[3]);
        const run = await latestRun(workspace);
        if (!run || run.runId !== runId) throw new Error("Run not found");
        const scores = validateScores(await readRequestJson(request), run.results.map(({ label }) => label));
        await writeFile(join(runsDirectory, runId, "scores.json"), JSON.stringify(scores, null, 2));
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
    console.log(`Garden evaluation editor listening on port ${options.port}`);
    console.log(`Workspace: ${workspace}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
