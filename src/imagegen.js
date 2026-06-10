// Generación de imágenes de destino con OpenAI (gpt-image-1-mini) y caché en disco.
//
// ¿Por qué gpt-image-1-mini? Es el modelo con mejor relación coste/rendimiento de
// OpenAI para imágenes (DevDay 2025): misma familia de calidad que gpt-image-1
// pero ~80 % más barato. Para tarjetas de viaje en landscape (1536x1024):
//   low ≈ $0.006 · medium ≈ $0.015 · high ≈ $0.052 por imagen.
//
// El catálogo es FIJO, así que cada destino se genera UNA sola vez y se guarda en
// public/assets/gen/<id>.png. A partir de ahí se sirve en local (gratis e
// instantáneo, también en redes que bloquean internet salvo la API de OpenAI).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEN_DIR = path.join(__dirname, "..", "public", "assets", "gen");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1-mini";
// Calidad/medida configurables. "low" es el óptimo coste/rendimiento.
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || "low"; // low | medium | high
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1536x1024"; // landscape

export const imageGenEnabled = () => !!OPENAI_API_KEY;

try { fs.mkdirSync(GEN_DIR, { recursive: true }); } catch { /* noop */ }

const fileFor = (id) => path.join(GEN_DIR, `${id}.png`);
const publicUrlFor = (id) => `/assets/gen/${id}.png`;

// URL pública de la imagen ya generada y cacheada, o null si aún no existe.
export function cachedGeneratedUrl(id) {
  if (!id) return null;
  try {
    return fs.existsSync(fileFor(id)) ? publicUrlFor(id) : null;
  } catch {
    return null;
  }
}

// Limitador de concurrencia: evita golpear los límites de la API generando
// demasiadas imágenes a la vez.
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

// Prompt para una fotografía de viaje realista y sin texto.
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

// Evita generar dos veces el mismo destino en paralelo.
const inflight = new Map();

// Garantiza que exista la imagen del destino. Devuelve su URL pública o null.
// Si ya está cacheada en disco, no llama a la API. La generación es idempotente
// y segura ante llamadas concurrentes.
export function ensureImage(dest) {
  if (!dest || !dest.id) return Promise.resolve(null);
  const cached = cachedGeneratedUrl(dest.id);
  if (cached) return Promise.resolve(cached);
  if (!imageGenEnabled()) return Promise.resolve(null);
  if (inflight.has(dest.id)) return inflight.get(dest.id);

  const job = schedule(async () => {
    // Re-chequeo por si se generó mientras esperaba en la cola.
    if (fs.existsSync(fileFor(dest.id))) return publicUrlFor(dest.id);
    const buf = await callOpenAIImage(buildPrompt(dest));
    if (!buf) return null;
    const tmp = fileFor(dest.id) + ".tmp";
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, fileFor(dest.id)); // publicación atómica
    return publicUrlFor(dest.id);
  }).finally(() => inflight.delete(dest.id));

  inflight.set(dest.id, job);
  return job;
}
