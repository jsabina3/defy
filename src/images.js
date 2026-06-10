// Resolución de imágenes de destino con la mejor fuente disponible:
//   1) Unsplash (si hay UNSPLASH_ACCESS_KEY) — fotos de alta calidad por destino.
//   2) Wikipedia REST (sin clave, gratis y fiable) — foto principal del artículo
//      del destino. Es el camino por defecto y no necesita configurar nada.
//   3) Imagen local curada (assets) si existiera.
//   4) LoremFlickr por palabra clave — último recurso.
//
// Clave opcional (mejor calidad): https://unsplash.com/developers -> UNSPLASH_ACCESS_KEY

const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
export const unsplashEnabled = () => !!UNSPLASH_KEY;

const unsplashCache = new Map();
const wikiCache = new Map();

// fetch con timeout para no bloquear la petición si la fuente tarda.
async function fetchJSON(url, { timeoutMs = 6000, headers = {} } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function flickrUrl(query, lock, w = 1200, h = 800) {
  return `https://loremflickr.com/${w}/${h}/${encodeURIComponent(query)}/all?lock=${lock}`;
}

async function unsplashImage(query) {
  if (!UNSPLASH_KEY) return null;
  if (unsplashCache.has(query)) return unsplashCache.get(query);
  const data = await fetchJSON(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}` +
      `&per_page=1&orientation=landscape&content_filter=high`,
    { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` } }
  );
  const photo = data?.results?.[0];
  const url = photo?.urls?.raw
    ? `${photo.urls.raw}&w=1200&q=80&auto=format&fit=crop`
    : photo?.urls?.regular || null;
  unsplashCache.set(query, url);
  return url;
}

// Foto principal del artículo de Wikipedia. Sin clave, gratis y muy fiable para
// lugares (ciudades, lagos, pueblos). `title` es el título del artículo en inglés
// (p. ej. "Lake Como", "Santorini"). Devuelve una URL lista para <img>.
async function wikipediaImage(title, lang = "en") {
  if (!title) return null;
  const key = `${lang}:${title}`;
  if (wikiCache.has(key)) return wikiCache.get(key);
  const data = await fetchJSON(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { accept: "application/json", "User-Agent": "AI-Travel-Agent/1.0" } }
  );
  let url = data?.thumbnail?.source || data?.originalimage?.source || null;
  // Las miniaturas de Wikimedia traen el ancho en la URL (".../320px-..."); lo
  // subimos a 1200px para que se vean nítidas sin descargar el original enorme.
  if (url && /\/thumb\//.test(url)) url = url.replace(/\/\d+px-/, "/1200px-");
  wikiCache.set(key, url);
  return url;
}

// Devuelve una URL final lista para <img src>.
//  - `hint`: texto de búsqueda preferido para Unsplash (p. ej. "Santorini Grecia").
//  - `wiki`: título del artículo de Wikipedia del destino (fuente por defecto).
export async function resolveImageUrl(image, hint, wiki) {
  // 1) Unsplash (solo si hay clave configurada): máxima calidad.
  if (unsplashEnabled()) {
    const query = hint || (image?.query || "").replace(/[,-]/g, " ");
    const u = await unsplashImage(query);
    if (u) return u;
  }
  // 2) Wikipedia (sin clave): foto real del destino.
  const wikiTitle = wiki || image?.wiki;
  if (wikiTitle) {
    const w = await wikipediaImage(wikiTitle);
    if (w) return w;
  }
  // 3) Imagen local curada, si el proyecto la tuviera.
  if (image?.kind === "local" && image.path) return image.path;
  // 4) Último recurso: LoremFlickr por palabra clave.
  if (image?.query) return flickrUrl(image.query, image.lock ?? 1);
  return image?.path || null;
}
