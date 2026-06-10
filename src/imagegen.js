// Generación de imágenes de destino con OpenAI (gpt-image-1-mini) y caché en disco.
//
// ¿Por qué gpt-image-1-mini? Es el modelo con mejor relación coste/rendimiento de
// OpenAI para imágenes (DevDay 2025): misma familia de calidad que gpt-image-1
// pero ~80 % más barato. Para tarjetas de viaje en landscape (1536x1024):
//   low ≈ $0.006 · medium ≈ $0.015 · high ≈ $0.052 por imagen.
//
// El catálogo es FIJO: cada destino se genera UNA vez y se guarda como
// <id>.png. A partir de ahí se sirve en local (gratis e instantáneo).
//
// Railway (persistencia entre deploys):
//   1) En el dashboard: Service → Volumes → Add Volume.
//   2) Mount path recomendado: /app/public/assets/gen
//      (Railway inyecta RAILWAY_VOLUME_MOUNT_PATH con esa ruta en runtime).
//   3) No montes en /app (borra el código). Cualquier subcarpeta de /app vale.
//   Alternativa: monta en /app/data/img-gen y define IMAGE_GEN_DIR igual.
//   Si el contenedor corre como no-root y falla al escribir: RAILWAY_RUN_UID=0.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GEN_DIR = path.join(__dirname, "..", "public", "assets", "gen");

function resolveGenDir() {
  if (process.env.IMAGE_GEN_DIR) return path.resolve(process.env.IMAGE_GEN_DIR);
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  return DEFAULT_GEN_DIR;
}

export const genDir = resolveGenDir();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1-mini";
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || "low";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1536x1024";

export const imageGenEnabled = () => !!OPENAI_API_KEY;

export function imageStoreInfo() {
  const onVolume = !!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.IMAGE_GEN_DIR);
  return {
    dir: genDir,
    persistent: onVolume,
    railwayVolume: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
    volumeName: process.env.RAILWAY_VOLUME_NAME || null,
  };
}

const fileFor = (id) => path.join(genDir, `${id}.png`);
const publicUrlFor = (id) => `/assets/gen/${id}.png`;

export function cachedGeneratedUrl(id) {
  if (!id) return null;
  try {
    return fs.existsSync(fileFor(id)) ? publicUrlFor(id) : null;
  } catch {
    return null;
  }
}

// Si antes se generaron imágenes en el disco efímero (public/assets/gen) y ahora
// hay volumen, copiamos las que falten para no regenerarlas ni pagar de nuevo.
async function migrateFromDefaultIfNeeded() {
  if (path.resolve(genDir) === path.resolve(DEFAULT_GEN_DIR)) return;
  try {
    if (!fs.existsSync(DEFAULT_GEN_DIR)) return;
    const files = await fsp.readdir(DEFAULT_GEN_DIR);
    let copied = 0;
    for (const f of files) {
      if (!f.endsWith(".png")) continue;
      const dest = path.join(genDir, f);
      if (!fs.existsSync(dest)) {
        await fsp.copyFile(path.join(DEFAULT_GEN_DIR, f), dest);
        copied++;
      }
    }
    if (copied) console.log(`Image cache: migradas ${copied} imágenes al volumen persistente`);
  } catch (err) {
    console.warn("Image cache migration skipped:", err.message);
  }
}

export async function initImageStore() {
  await fsp.mkdir(genDir, { recursive: true });
  await migrateFromDefaultIfNeeded();
  const info = imageStoreInfo();
  const tag = info.railwayVolume
    ? `Railway volume${info.volumeName ? ` "${info.volumeName}"` : ""}`
    : info.persistent ? "IMAGE_GEN_DIR" : "disco local (efímero en PaaS)";
  console.log(`Image cache: ${info.dir} (${tag})`);
}

const MAX_CONCURRENT = Number(process.env.IMAGE_CONCURRENCY) || 4;
let active = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  if (active >= MAX_CONCURRENT || !queue.length) return;
  const { fn, resolve, reject } = queue.shift();
  active++;
  Promise.resolve()
    .then(fn)
    .then(resolve, reject)
    .finally(() => { active--; pump(); });
}

function buildPrompt(dest) {
  const place = [dest.name, dest.region, dest.country].filter(Boolean).join(", ");
  const flavor = dest.blurb ? ` ${dest.blurb}` : "";
  return (
    `Ultra-realistic professional travel photograph of ${place}.${flavor} ` +
    `Iconic, recognizable view of the destination. Cinematic golden-hour light, ` +
    `vivid natural colors, sharp focus, wide scenic landscape composition. ` +
    `No text, no captions, no watermark, no logos, no people in the foreground.`
  );
}

async function callOpenAIImage(prompt) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        n: 1,
      }),
    });
    if (!res.ok) {
      console.error("OpenAI image error", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    return b64 ? Buffer.from(b64, "base64") : null;
  } catch (err) {
    console.error("OpenAI image request failed:", err.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

const inflight = new Map();

export function ensureImage(dest) {
  if (!dest || !dest.id) return Promise.resolve(null);
  const cached = cachedGeneratedUrl(dest.id);
  if (cached) return Promise.resolve(cached);
  if (!imageGenEnabled()) return Promise.resolve(null);
  if (inflight.has(dest.id)) return inflight.get(dest.id);

  const job = schedule(async () => {
    if (fs.existsSync(fileFor(dest.id))) return publicUrlFor(dest.id);
    const buf = await callOpenAIImage(buildPrompt(dest));
    if (!buf) return null;
    await fsp.mkdir(genDir, { recursive: true });
    const tmp = fileFor(dest.id) + ".tmp";
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, fileFor(dest.id));
    return publicUrlFor(dest.id);
  }).finally(() => inflight.delete(dest.id));

  inflight.set(dest.id, job);
  return job;
}
