import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GATEWAY_ID = "mossboard-aigateway-dev-user-p7r7kdrf5hopvudk";
const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const DEFAULT_PROMPT = `The reference images are photographs of the same private garden from different positions. Reconstruct one coherent, approximate top-down view of the existing property for use as the background of a garden-planning canvas.

Use a directly overhead orthographic camera. Show no horizon, sky, people, labels, compass, property lines, or perspective view. Preserve the relative arrangement visible across the references: the house with yellow walls and tiled roof, its attached red glazed veranda, the gravel drive or path beside it, the central lawn, perimeter shrubs and hedges, and the mature deciduous and conifer trees. Treat repeated objects in different photographs as the same objects, not duplicates.

Do not add paths, patios, pools, furniture, flower beds, buildings, or other features that are not supported by the photographs. Where the boundary or geometry is hidden, make a conservative natural transition instead of inventing detail. Aim for a realistic aerial garden photograph with enough visual clarity to draw editable planning shapes over it.`;

export const MODEL_DEFINITIONS = [
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    slug: "flux-2-dev",
    maxReferences: 4,
    transport: "multipart",
  },
  {
    id: "black-forest-labs/flux-2-max",
    slug: "flux-2-max",
    maxReferences: 8,
    transport: "json",
    imageField: "input_images",
  },
  {
    id: "openai/gpt-image-1.5",
    slug: "gpt-image-1-5",
    maxReferences: 16,
    transport: "json",
    imageField: "images",
  },
  {
    id: "bytedance/seedream-5-pro",
    slug: "seedream-5-pro",
    maxReferences: 10,
    transport: "json",
    imageField: "image",
  },
  {
    id: "xai/grok-imagine-image-quality",
    slug: "grok-imagine-image-quality",
    maxReferences: 10,
    transport: "json",
    maskedEdit: true,
  },
];

function parseArguments(argv) {
  const options = {
    input: undefined,
    output: join(".amp", "evals", new Date().toISOString().replaceAll(":", "-")),
    models: MODEL_DEFINITIONS.filter(({ maskedEdit }) => !maskedEdit).map(({ id }) => id),
    prompt: DEFAULT_PROMPT,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    else if (argument === "--input") options.input = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--layout") options.layout = argv[++index];
    else if (argument === "--base-image") options.baseImage = argv[++index];
    else if (argument === "--guide-image") options.guideImage = argv[++index];
    else if (argument === "--mask-image") options.maskImage = argv[++index];
    else if (argument === "--models") options.models = argv[++index].split(",");
    else if (argument === "--prompt-file") options.promptFile = argv[++index];
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: pnpm eval:images -- --input <photo-directory> [options]

Options:
  --output <directory>     Output directory under .amp/evals by default
  --layout <layout.json>   Camera layout saved by the eval layout editor
  --base-image <path>      Previous generated image to refine
  --guide-image <path>     Annotated image that locates a correction
  --mask-image <path>      Black-preserve, white-edit inpainting mask
  --models <id,id>        Comma-separated Cloudflare model IDs
  --prompt-file <path>    Replace the built-in evaluation prompt
  --dry-run               Prepare inputs and review files without inference
  --help                  Show this help`);
}

async function imageFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(directory, entry.name))
    .sort();
}

async function prepareImages(sourceFiles, outputDirectory) {
  const preparedDirectory = join(outputDirectory, "inputs");
  await mkdir(preparedDirectory, { recursive: true });

  const prepared = [];
  for (const [index, source] of sourceFiles.entries()) {
    const destination = join(preparedDirectory, `${String(index + 1).padStart(2, "0")}-${basename(source, extname(source))}.jpg`);
    await execFileAsync("magick", [
      source,
      "-auto-orient",
      "-resize",
      "1600x1600>",
      "-strip",
      "-quality",
      "88",
      destination,
    ]);
    const contents = await readFile(destination);
    prepared.push({
      source: basename(source),
      path: destination,
      dataUri: `data:image/jpeg;base64,${contents.toString("base64")}`,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return prepared;
}

async function prepareReferenceImage(source, outputDirectory, outputName, role) {
  if (!source) return undefined;
  const destination = join(outputDirectory, "inputs", outputName);
  await execFileAsync("magick", [
    resolve(source),
    "-auto-orient",
    "-resize",
    "1600x1600>",
    "-strip",
    "-quality",
    "88",
    destination,
  ]);
  const contents = await readFile(destination);
  return {
    source: basename(source),
    role,
    path: destination,
    dataUri: `data:image/jpeg;base64,${contents.toString("base64")}`,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function prepareMaskImage(source) {
  if (!source) return undefined;
  const path = resolve(source);
  const contents = await readFile(path);
  return {
    path,
    dataUri: `data:image/png;base64,${contents.toString("base64")}`,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function prepareFluxReferences(images, outputDirectory, layoutImage) {
  const selectedNames = ["IMG_1054", "IMG_1057", "IMG_1066", "IMG_1068"];
  const selected = selectedNames
    .map((name) => images.find((image) => image.source.startsWith(name)))
    .filter(Boolean);
  const preferred = selected.length === 4 ? selected : images.slice(0, 4);
  const references = layoutImage
    ? [layoutImage, ...preferred.filter(({ source }) => !source.startsWith("IMG_1057")).slice(0, 3)]
    : preferred;
  const fluxDirectory = join(outputDirectory, "inputs", "flux-512");
  await mkdir(fluxDirectory, { recursive: true });

  return Promise.all(
    references.map(async (image, index) => {
      const destination = join(
        fluxDirectory,
        `${index + 1}-${basename(image.path, extname(image.path))}.jpg`,
      );
      await execFileAsync("magick", [
        image.path,
        "-resize",
        "510x510",
        "-background",
        "#808080",
        "-gravity",
        "center",
        "-extent",
        "510x510",
        "-depth",
        "8",
        destination,
      ]);
      return { ...image, path: destination };
    }),
  );
}

async function prepareLayout(layoutPath) {
  if (!layoutPath) return undefined;
  const absoluteLayoutPath = resolve(layoutPath);
  const layout = JSON.parse(await readFile(absoluteLayoutPath, "utf8"));
  const imagePath = join(resolve(absoluteLayoutPath, ".."), "layout.png");
  const contents = await readFile(imagePath);
  const includedCameras = layout.cameras.filter((camera) => camera.included !== false);
  const cameraSummary = includedCameras
    .map((camera) => `${camera.label} is ${camera.source}, taken at (${Math.round(camera.x)}, ${Math.round(camera.y)}) facing ${Math.round(camera.angle)} degrees with an approximate ${Math.round(camera.fieldOfView)} degree field of view`)
    .join("; ");
  const landmarkSummary = layout.landmarks?.length
    ? ` Named landmarks: ${layout.landmarks.map((landmark) => landmark.name).join(", ")}.`
    : "";
  return {
    layout,
    includedSources: new Set(includedCameras.map(({ source }) => basename(source, extname(source)))),
    prompt: `The first reference image is a user-drawn spatial diagram, not an appearance reference. Its garden outline, structure footprints, camera positions, arrows, and named landmarks are geometry constraints. Camera labels map to photographs as follows: ${cameraSummary}.${landmarkSummary}`,
    image: {
      source: "layout.png",
      path: imagePath,
      dataUri: `data:image/png;base64,${contents.toString("base64")}`,
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
  };
}

function requestHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "cf-aig-gateway-id": GATEWAY_ID,
    "cf-aig-collect-log": "false",
    "cf-aig-skip-cache": "true",
    "cf-aig-request-timeout": "300000",
  };
}

function promptWithReferenceOrder(prompt, layout, references) {
  if (!layout) return prompt;
  const mappings = references.slice(1).map((image, index) => {
    if (image.role === "draft") {
      return `reference image ${index + 2} is the previous generated draft to correct`;
    }
    if (image.role === "guide") {
      return `reference image ${index + 2} is an annotated correction guide`;
    }
    const sourceStem = basename(image.source, extname(image.source));
    const camera = layout.cameras.find(({ source }) => basename(source, extname(source)) === sourceStem);
    return `reference image ${index + 2} is Camera ${camera?.label ?? "unknown"} (${image.source})`;
  });
  return `${prompt}\n\nReference order for this request: reference image 1 is the spatial diagram; ${mappings.join("; ")}.`;
}

async function callModel(model, prompt, images, fluxImages, preparedLayout, preparedBaseImage, preparedGuideImage, preparedMaskImage, accountId, token) {
  const startedAt = new Date();
  const started = performance.now();
  let response;

  if (model.transport === "multipart") {
    const form = new FormData();
    form.append("prompt", promptWithReferenceOrder(prompt, preparedLayout?.layout, fluxImages));
    form.append("width", "1024");
    form.append("height", "1024");
    form.append("steps", "25");
    form.append("seed", "1055");
    for (const [index, image] of fluxImages.entries()) {
      const contents = await readFile(image.path);
      form.append(`input_image_${index}`, new Blob([contents], { type: "image/jpeg" }), basename(image.path));
    }
    response = await fetch(`${API_BASE}/${accountId}/ai/run/${model.id}`, {
      method: "POST",
      headers: requestHeaders(token),
      body: form,
      signal: AbortSignal.timeout(360_000),
    });
  } else {
    const references = [...(preparedLayout ? [preparedLayout.image] : []), ...(preparedBaseImage ? [preparedBaseImage] : []), ...(preparedGuideImage ? [preparedGuideImage] : []), ...images]
      .slice(0, model.maxReferences);
    const input = { prompt: promptWithReferenceOrder(prompt, preparedLayout?.layout, references) };
    if (model.maskedEdit) {
      if (!preparedBaseImage || !preparedMaskImage) throw new Error(`${model.id} requires --base-image and --mask-image`);
      input.images = [preparedBaseImage, ...images.slice(0, model.maxReferences - 1)]
        .map(({ dataUri }) => ({ url: dataUri, type: "image_url" }));
      input.mask = { url: preparedMaskImage.dataUri };
      Object.assign(input, { aspect_ratio: "1:1", quality: "high", resolution: "1k", response_format: "b64_json" });
    } else {
      input[model.imageField] = references.map(({ dataUri }) => dataUri);
    }
    if (model.id === "black-forest-labs/flux-2-max") {
      Object.assign(input, { width: 1024, height: 1024, seed: 1055, output_format: "jpeg" });
    } else if (model.id === "openai/gpt-image-1.5") {
      Object.assign(input, { size: "1024x1024", quality: "medium" });
    } else if (model.id === "bytedance/seedream-5-pro") {
      input.size = "1K";
    }
    response = await fetch(`${API_BASE}/${accountId}/ai/run`, {
      method: "POST",
      headers: { ...requestHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.id, input }),
      signal: AbortSignal.timeout(360_000),
    });
  }

  const responseText = await response.text();
  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    body = { raw: responseText };
  }
  if (!response.ok || body.success === false || body.state === "Failed") {
    throw new Error(`${model.id} failed (${response.status}): ${JSON.stringify(body.errors ?? body.error ?? body)}`);
  }

  const inference = body.success === true && body.result?.state
    ? body.result
    : body;

  return {
    body: inference,
    elapsedMilliseconds: Math.round(performance.now() - started),
    startedAt: startedAt.toISOString(),
  };
}

function findOutput(body) {
  const result = body.result ?? body;
  if (typeof result.image === "string") return result.image;
  if (Array.isArray(result.images) && typeof result.images[0] === "string") return result.images[0];
  throw new Error(`Response did not contain an image: ${JSON.stringify(body)}`);
}

async function saveOutput(value, destination, token) {
  if (/^https:\/\//.test(value)) {
    const response = await fetch(value, {
      headers: value.includes("cloudflare.com") ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!response.ok) throw new Error(`Could not download generated image (${response.status})`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return;
  }

  const encoded = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  await writeFile(destination, Buffer.from(encoded, "base64"));
}

function shuffledLabels(results) {
  const shuffled = [...results];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomBytes(4).readUInt32BE() % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.map((result, index) => ({ ...result, label: String.fromCharCode(65 + index) }));
}

function reviewHtml(results, runId) {
  const cards = results.map((result) => `
    <article data-label="${result.label}">
      <h2>Candidate ${result.label}</h2>
      <img src="outputs/${result.file}" alt="Generated top-down garden candidate ${result.label}">
      <div class="scores">
        ${["Object presence", "Relative placement", "Overhead viewpoint", "No hallucinations"].map((criterion) => `<label>${criterion}<input type="number" min="1" max="5" name="${criterion}" value="3"></label>`).join("")}
      </div>
      <label>Notes<textarea name="notes" rows="3"></textarea></label>
    </article>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Mossboard image evaluation ${runId}</title>
<style>body{font:16px system-ui;margin:0;background:#eee;color:#172019}header{padding:1rem 2vw;background:#fff;position:sticky;top:0;z-index:1;box-shadow:0 1px 5px #999}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:1rem;padding:1rem}article{background:#fff;padding:1rem;border-radius:8px}img{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:#ddd}.scores{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin:1rem 0}label{display:grid;gap:.25rem}input,textarea,button{font:inherit;padding:.5rem}textarea{width:100%;box-sizing:border-box}button{cursor:pointer}</style></head>
<body><header><strong>Photos-only pilot ${runId}</strong> <button id="download">Download scores</button></header><main>${cards}</main>
<script>const key=${JSON.stringify(`mossboard-eval-${runId}`)};const fields=[...document.querySelectorAll('input,textarea')];const saved=JSON.parse(localStorage.getItem(key)||'{}');for(const field of fields){const card=field.closest('article').dataset.label;const id=card+'|'+field.name;if(saved[id]!==undefined)field.value=saved[id];field.addEventListener('input',()=>{saved[id]=field.value;localStorage.setItem(key,JSON.stringify(saved))})}document.querySelector('#download').onclick=()=>{const blob=new Blob([JSON.stringify(saved,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='scores.json';link.click();URL.revokeObjectURL(link.href)}</script>
</body></html>`;
}

export async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (!options.input) throw new Error("Missing --input <photo-directory>");

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AI_GATEWAY_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!options.dryRun && (!accountId || !token)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_GATEWAY_TOKEN are required");
  }

  const unknownModels = options.models.filter((id) => !MODEL_DEFINITIONS.some((model) => model.id === id));
  if (unknownModels.length > 0) throw new Error(`Unknown models: ${unknownModels.join(", ")}`);

  const outputDirectory = resolve(options.output);
  let files = await imageFiles(resolve(options.input));
  if (files.length === 0) throw new Error("The input directory contains no supported images");
  await mkdir(join(outputDirectory, "outputs"), { recursive: true });
  if (options.promptFile) options.prompt = await readFile(options.promptFile, "utf8");

  const preparedLayout = await prepareLayout(options.layout);
  if (preparedLayout) {
    files = files.filter((file) => preparedLayout.includedSources.has(basename(file, extname(file))));
    if (files.length === 0) throw new Error("The saved layout excludes every reference photo");
  }
  console.log(`Preparing ${files.length} included reference photos...`);
  const images = await prepareImages(files, outputDirectory);
  const preparedBaseImage = await prepareReferenceImage(options.baseImage, outputDirectory, "previous-draft.jpg", "draft");
  const preparedGuideImage = await prepareReferenceImage(options.guideImage, outputDirectory, "correction-guide.jpg", "guide");
  const preparedMaskImage = await prepareMaskImage(options.maskImage);
  if (preparedLayout) options.prompt = `${options.prompt}\n\n${preparedLayout.prompt}`;
  const fluxImages = await prepareFluxReferences(images, outputDirectory, preparedLayout?.image);
  const runId = basename(outputDirectory);
  const manifest = {
    runId,
    createdAt: new Date().toISOString(),
    gatewayId: GATEWAY_ID,
    prompt: options.prompt,
    inputs: images.map(({ source, sha256 }) => ({ source, sha256 })),
    baseImage: preparedBaseImage ? { path: resolve(options.baseImage), sha256: preparedBaseImage.sha256 } : null,
    guideImage: preparedGuideImage ? { path: resolve(options.guideImage), sha256: preparedGuideImage.sha256 } : null,
    maskImage: preparedMaskImage ? { path: preparedMaskImage.path, sha256: preparedMaskImage.sha256 } : null,
    layout: preparedLayout ? { path: resolve(options.layout), sha256: preparedLayout.image.sha256 } : null,
    fluxReferences: fluxImages.map(({ source }) => source),
    results: [],
  };

  if (!options.dryRun) {
    for (const model of MODEL_DEFINITIONS.filter(({ id }) => options.models.includes(id))) {
      console.log(`Running ${model.id}...`);
      try {
        const response = await callModel(model, options.prompt, images, fluxImages, preparedLayout, preparedBaseImage, preparedGuideImage, preparedMaskImage, accountId, token);
        const outputFile = `${model.slug}.jpg`;
        await saveOutput(findOutput(response.body), join(outputDirectory, "outputs", outputFile), token);
        const rawResponseFile = `${model.slug}.response.json`;
        await writeFile(join(outputDirectory, rawResponseFile), JSON.stringify(response.body, null, 2));
        manifest.results.push({
          model: model.id,
          file: outputFile,
          rawResponseFile,
          startedAt: response.startedAt,
          elapsedMilliseconds: response.elapsedMilliseconds,
          keySource: response.body.gatewayMetadata?.keySource ?? null,
          status: "completed",
        });
        console.log(`Saved ${outputFile} in ${(response.elapsedMilliseconds / 1000).toFixed(1)}s`);
      } catch (error) {
        manifest.results.push({ model: model.id, status: "failed", error: String(error) });
        console.error(String(error));
      }
      await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2));
    }
  }

  const completed = manifest.results.filter(({ status }) => status === "completed");
  const blindResults = shuffledLabels(completed);
  await writeFile(join(outputDirectory, "blind-map.json"), JSON.stringify(blindResults.map(({ label, model }) => ({ label, model })), null, 2));
  await writeFile(join(outputDirectory, "review.html"), reviewHtml(blindResults, runId));
  await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`${options.dryRun ? "Dry run" : "Evaluation"} complete: ${outputDirectory}`);
  if (!options.dryRun && manifest.results.some(({ status }) => status === "failed")) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
