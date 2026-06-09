// Resolución de imágenes de destino con la mejor fuente disponible:
//   1) Imagen local curada (assets) — máxima calidad, instantánea.
//   2) Unsplash (si hay UNSPLASH_ACCESS_KEY) — fotos de alta calidad por destino.
//   3) LoremFlickr en alta resolución — fallback gratis y sin clave.
//
// Clave gratuita: https://unsplash.com/developers  ->  UNSPLASH_ACCESS_KEY

const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
export const unsplashEnabled = () => !!UNSPLASH_KEY;

const unsplashCache = new Map();

export function flickrUrl(query, lock, w = 1200, h = 800) {
  return `https://loremflickr.com/${w}/${h}/${encodeURIComponent(query)}/all?lock=${lock}`;
}

async function unsplashImage(query) {
  if (!UNSPLASH_KEY) return null;
  if (unsplashCache.has(query)) return unsplashCache.get(query);
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}` +
        `&per_page=1&orientation=landscape&content_filter=high`,
      { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` } }
    );
    if (!res.ok) {
      console.error("Unsplash error", res.status);
      unsplashCache.set(query, null);
      return null;
    }
    const data = await res.json();
    const photo = data?.results?.[0];
    const url = photo?.urls?.raw
      ? `${photo.urls.raw}&w=1200&q=80&auto=format&fit=crop`
      : photo?.urls?.regular || null;
    unsplashCache.set(query, url);
    return url;
  } catch (err) {
    console.error("Unsplash request failed:", err.message);
    unsplashCache.set(query, null);
    return null;
  }
}

// Devuelve una URL final lista para <img src>. `hint` es el texto de búsqueda
// preferido para Unsplash (p. ej. "Santorini Grecia").
export async function resolveImageUrl(image, hint) {
  if (!image) return null;
  if (image.kind === "local") return image.path; // foto curada local
  if (unsplashEnabled()) {
    const query = hint || (image.query || "").replace(/[,-]/g, " ");
    const u = await unsplashImage(query);
    if (u) return u;
  }
  if (image.kind === "flickr") return flickrUrl(image.query, image.lock);
  return image.path || null;
}
