import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, CATALOG_BY_ID, SEASONS, PRICING, TIERS, STAY_TIERS, stayTierFactor, registerIata } from "./src/catalog.js";
import { amadeusEnabled, cheapestFlightPP, cheapestHotelNight } from "./src/amadeus.js";
import { unsplashEnabled } from "./src/images.js";
import { imageGenEnabled, ensureImage, cachedGeneratedUrl, genDir, imageStoreInfo, initImageStore } from "./src/imagegen.js";
import {
  initAccounts, registerUser, loginUser, logout, userByToken, publicUser,
  awardTrip, redeemReward, REWARDS_CATALOG, LEVELS,
} from "./src/accounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

/* ------------------------------------------------------------------ */
/* Sesión por cookie httpOnly (sin dependencias: parser propio)        */
/* ------------------------------------------------------------------ */
const SESSION_COOKIE = "defy_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 45; // 45 días en segundos

app.use((req, _res, next) => {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  req.cookies = cookies;
  req.sessionToken = cookies[SESSION_COOKIE] || null;
  next();
});

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append("Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`);
}
function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}
// Caché de fotos IA (local o Railway Volume). Va antes que public/ para que el
// volumen persistente tenga prioridad sobre el disco efímero del contenedor.
app.use("/assets/gen", express.static(genDir, { maxAge: "7d", immutable: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const ESTIMATE_MODEL = process.env.ESTIMATE_MODEL || "gpt-5.4-nano";
// Los modelos GPT-5.x no admiten temperature personalizada y usan reasoning_effort.
const isGpt5Model = (model) => /^gpt-5/.test(model);

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n);
// Percentil con interpolación lineal (idéntico en front y back para que el
// precio anclado coincida). p en [0,1]; p=0.5 => mediana.
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
};

const CITY_FLIGHT_FACTOR = {
  madrid: 1.0, barcelona: 1.0, valencia: 1.05, sevilla: 1.1, "san sebastian": 1.1,
  bilbao: 1.1, malaga: 1.08, palma: 1.15, alicante: 1.06, zaragoza: 1.08,
  "santiago de compostela": 1.12, asturias: 1.12, vigo: 1.12, granada: 1.12,
};
const cityFactor = (city) => {
  const k = (city || "").trim().toLowerCase();
  return CITY_FLIGHT_FACTOR[k] ?? 1.05;
};

// País de origen (para excluir destinos del mismo país). Todas las salidas son españolas.
const SPANISH_CITIES = new Set([
  "madrid", "barcelona", "valencia", "sevilla", "malaga", "bilbao", "palma",
  "alicante", "zaragoza", "santiago de compostela", "granada", "vigo", "asturias", "san sebastian",
]);
const originCountryOf = (city) =>
  SPANISH_CITIES.has((city || "").trim().toLowerCase()) ? "España" : null;

// Etiqueta legible del perfil del viajero para los prompts de IA.
const PROFILE_LABELS = {
  solo: "viaja solo/a",
  pareja: "viaja en pareja",
  amigos: "grupo de amigos",
  familia: "familia (con niños)",
};
const profileLabel = (p) => PROFILE_LABELS[p] || "sin especificar";

const BUDGET_LABELS = { budget: "económico", mid: "medio", premium: "premium", luxury: "lujo" };
const TRIP_LABELS = { weekend: "escapada 2–3 días", short: "4–7 días", medium: "1–2 semanas", long: "2+ semanas" };
const RANGE_LABELS = { short: "vuelo corto", medium: "media distancia", long: "largo recorrido", anywhere: "cualquier sitio" };
const EXPLORER_LABELS = { highlights: "lugares icónicos", hidden: "joyas escondidas", balanced: "mezcla equilibrada" };
const COMFORT_LABELS = { comfort: "comodidad ante todo", balanced: "equilibrado", authentic: "experiencias auténticas" };
const ACCOM_LABELS = { hotel: "hotel", boutique: "boutique", resort: "resort", apartment: "apartamento", rural: "rural", any: "indiferente" };
const FOOD_LABELS = { local: "cocina local", street: "street food", fine: "alta cocina", wine: "vino y viñedos", beer: "cerveza artesanal", markets: "mercados", cooking: "experiencias culinarias" };
const DIET_LABELS = { none: "sin restricciones", vegetarian: "vegetariano", vegan: "vegano", glutenfree: "sin gluten", halal: "halal", kosher: "kosher" };
const PACE_LABELS = { relax: "relax", balanced: "equilibrado", adventure: "aventura" };

const BUDGET_TO_STAY = { budget: "comodo", mid: "boutique", premium: "boutique", luxury: "villa" };
const ACCOM_TO_STAY = { hotel: "comodo", boutique: "boutique", resort: "villa", apartment: "comodo", rural: "comodo" };
const TRIP_NIGHTS_RANGE = {
  weekend: { min: 1, max: 2, default: 1 },
  short: { min: 3, max: 6, default: 4 },
  medium: { min: 7, max: 13, default: 10 },
  long: { min: 14, max: 21, default: 14 },
};
const BUDGET_ESTIMATE = { budget: 350, mid: 550, premium: 850, luxury: 1400 };

function resolveStayTier(p) {
  const budgetTier = ["budget", "mid", "premium", "luxury"].includes(p.budgetTier) ? p.budgetTier : "mid";
  let stay = BUDGET_TO_STAY[budgetTier] || "boutique";
  const accom = p.accommodation || "any";
  if (accom !== "any" && ACCOM_TO_STAY[accom]) stay = ACCOM_TO_STAY[accom];
  const comfort = p.comfortLevel || "balanced";
  if (comfort === "comfort") stay = "villa";
  else if (comfort === "authentic") stay = "comodo";
  return stay;
}

function tripNightsRange(tripLength) {
  return TRIP_NIGHTS_RANGE[tripLength] || TRIP_NIGHTS_RANGE.short;
}

// Texto legible de las edades del grupo para los prompts de IA. Prefiere la
// lista de edades por viajero; si no hay, cae a la media.
const agesLabel = (prefs) => {
  const ages = (prefs.ages || []).filter((a) => Number.isFinite(a));
  if (ages.length) return `edades de los viajeros: ${ages.join(", ")}`;
  if (Number.isFinite(prefs.age)) return `edad media ${prefs.age}`;
  return null;
};

// Devuelve la ficha del nivel de viaje elegido (Cómodo / Boutique / Villa).
const stayInfo = (id) => {
  const t = STAY_TIERS.find((s) => s.id === id) || STAY_TIERS.find((s) => s.recommended) || STAY_TIERS[0];
  return { id: t.id, name: t.name, stars: t.stars, stayType: t.stayType, tagline: t.tagline };
};

/* ------------------------------------------------------------------ */
/* Registro de destinos en runtime (catálogo curado + propuestas IA)   */
/* ------------------------------------------------------------------ */
// La IA puede proponer destinos de cualquier parte del mundo, no solo los del
// catálogo. Los guardamos en memoria (clave: id) para que el resto del flujo
// (precio, imagen, checkout) los resuelva igual que a los curados. El catálogo
// sigue siendo el fallback determinista cuando no hay IA disponible.
const AI_DEST_STORE = new Map();
const AI_STORE_MAX = 4000;
function registerDest(d) {
  if (!d || !d.id) return;
  if (AI_DEST_STORE.size > AI_STORE_MAX) AI_DEST_STORE.clear();
  AI_DEST_STORE.set(d.id, d);
}
// Resuelve un destino por id: primero el catálogo curado, luego lo propuesto por
// la IA en esta sesión del proceso.
const destById = (id) => CATALOG_BY_ID[id] || AI_DEST_STORE.get(id) || null;

const ALLOWED_TAGS = new Set(["beach", "culture", "nature", "food", "nightlife", "romantic", "adventure"]);
const ALLOWED_SEASON = new Set(["beach", "city", "nature", "alpine"]);
const ALLOWED_CLIMATE = new Set(["warm", "temperate", "cool"]);

function slugify(s) {
  return (String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)) || "dest";
}

const countryKey = (s) => String(s || "")
  .trim()
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "");

// Suelos para corregir cuando la IA infravalora vuelos a destinos que son
// físicamente lejanos desde España. Así la regla de duración no se rompe.
const COUNTRY_FLIGHT_FLOOR = {
  georgia: 260, armenia: 270, azerbaiyan: 280, azerbaijan: 280,
  turquia: 230, turkey: 230, chipre: 220, cyprus: 220,
  egipto: 260, egypt: 260, jordania: 285, jordan: 285,
  islandia: 240, iceland: 240, noruega: 210, norway: 210,
  suecia: 190, sweden: 190, finlandia: 210, finland: 210,
  estonia: 190, letonia: 185, lituania: 185,
};
const countryFlightFloor = (country) => COUNTRY_FLIGHT_FLOOR[countryKey(country)] || 0;

// Valida y normaliza un destino propuesto por la IA a la forma que usa el motor.
function normalizeDest(raw, seen) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim().slice(0, 60);
  if (!name) return null;
  const country = String(raw.country || "").trim().slice(0, 40) || "—";
  let id = slugify(raw.id || name);
  while (seen.has(id)) id = `${id}-${seen.size + 1}`;
  const numIn = (v, lo, hi, dflt) => {
    const n = Math.round(+v);
    return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
  };
  const isGem = !!raw.isHiddenGem;
  const d = {
    id,
    name,
    country,
    region: String(raw.region || "").trim().slice(0, 60),
    gateway: String(raw.gateway || name).trim().slice(0, 40),
    isHiddenGem: isGem,
    transfer: raw.transfer ? String(raw.transfer).slice(0, 120) : null,
    tags: Array.isArray(raw.tags)
      ? [...new Set(raw.tags.filter((t) => ALLOWED_TAGS.has(t)))].slice(0, 6)
      : [],
    climate: ALLOWED_CLIMATE.has(raw.climate) ? raw.climate : "temperate",
    season: ALLOWED_SEASON.has(raw.season) ? raw.season : "city",
    baseFlight: Math.max(numIn(raw.baseFlight, 30, 1200, 150), countryFlightFloor(country)),
    baseHotelNight: numIn(raw.baseHotelNight, 40, 1200, 150),
    transferCost: numIn(raw.transferCost, 0, 300, isGem ? 30 : 0),
    appeal: numIn(raw.appeal, 1, 5, 3),
    novelty: numIn(raw.novelty, 1, 5, 3),
    blurb: String(raw.blurb || "").trim().slice(0, 160),
    why: raw.why ? String(raw.why).trim().slice(0, 120) : null,
    image: null, // se asigna vía /api/destimg (generación IA + placeholder)
    gatewayIata:
      typeof raw.gatewayIata === "string" && /^[A-Za-z]{3}$/.test(raw.gatewayIata.trim())
        ? raw.gatewayIata.trim().toUpperCase()
        : null,
  };
  seen.add(id);
  return d;
}

/* ------------------------------------------------------------------ */
/* Selección de destinos                                              */
/* ------------------------------------------------------------------ */
// Puntuación ANTI-BAJONA: premia destinos que "merecen el viaje" según los tres
// ejes que pide el negocio, para que ninguna opción decepcione:
//   (1) DISTANCIA: cuanto más lejos del origen, más se siente como una escapada
//       real (usamos baseFlight como proxy de distancia desde España).
//   (2) ATRACTIVO: el factor "wow" intrínseco del destino (appeal 1..5).
//   (3) DESCONOCIMIENTO: lo poco trillado/sorprendente que resulta (novelty 1..5).
// Ejemplo: Oporto (cerca, muy conocido, appeal medio) puntúa bajo frente a un
// destino más lejano y diferente; así no se cuelan opciones "bajona".
function antiBajonaScore(dest) {
  const distance = clamp((dest.baseFlight - 90) / 50, 0, 4); // 0 (cerca) .. 4 (lejos)
  const appeal = (dest.appeal ?? 3) - 3;   // -2 .. 2
  const novelty = (dest.novelty ?? 3) - 3; // -2 .. 2 (más alto = más sorprendente)
  return distance * 0.7 + appeal * 0.9 + novelty * 0.8;
}

// La duración y la tolerancia a desplazamiento mandan la distancia razonable.
function distanceBoundsForTrip(prefs) {
  const tripLength = ["weekend", "short", "medium", "long"].includes(prefs.tripLength) ? prefs.tripLength : "short";
  const tripRange = tripNightsRange(tripLength);
  const nights = clamp(parseInt(prefs.nights, 10) || tripRange.default, tripRange.min, tripRange.max);
  let min = 0;
  let max = 340;
  let label = "media distancia";
  if (nights <= 1) { min = 0; max = 135; label = "vuelos cortos"; }
  else if (nights <= 3) { min = 0; max = 165; label = "vuelos cortos o medios"; }
  else if (nights <= 5) { min = 85; max = 205; label = "media distancia"; }
  else if (nights <= 7) { min = 100; max = 245; label = "media distancia amplia"; }
  else if (nights <= 10) { min = 125; max = 290; label = "destinos más especiales"; }
  else if (nights <= 14) { min = 160; max = 380; label = "destinos lejanos"; }
  else { min = 200; max = 500; label = "destinos muy lejanos"; }

  const range = prefs.travelRange || "medium";
  const rangeBounds = {
    short: { min: 0, max: 165, label: "vuelo corto" },
    medium: { min: 85, max: 290, label: "media distancia" },
    long: { min: 160, max: 450, label: "largo recorrido" },
    anywhere: { min: 0, max: 999, label: "cualquier distancia" },
  };
  const rb = rangeBounds[range] || rangeBounds.medium;
  return {
    min: Math.max(min, rb.min),
    max: Math.min(max, rb.max),
    label: rb.label !== "cualquier distancia" ? `${label}, ${rb.label}` : label,
  };
}

function matchesTripDistance(dest, prefs, relax = 1) {
  const { min, max } = distanceBoundsForTrip(prefs);
  const flight = Number.isFinite(dest.baseFlight) ? dest.baseFlight : 150;
  return flight >= min * (2 - relax) && flight <= max * relax;
}

// Ajuste por demografía: el perfil del grupo (solo/pareja/amigos/familia) y la
// edad media cambian qué destinos encajan mejor (p. ej. fiesta para amigos
// jóvenes, romántico para parejas, naturaleza/playa para familias).
function demographicAdjust(dest, prefs) {
  let s = 0;
  const t = dest.tags || [];
  switch (prefs.profile) {
    case "familia":
      if (t.includes("nightlife")) s -= 2.5;
      if (t.includes("nature") || t.includes("beach")) s += 1.2;
      if (dest.isHiddenGem) s -= 0.6; // traslados largos cansan más en familia
      break;
    case "amigos":
      if (t.includes("nightlife")) s += 2;
      if (t.includes("beach")) s += 0.8;
      if (t.includes("romantic")) s -= 0.8;
      break;
    case "pareja":
      if (t.includes("romantic")) s += 2;
      if (t.includes("nightlife")) s -= 0.4;
      break;
    case "solo":
      if (t.includes("culture")) s += 1.2;
      if (t.includes("nightlife")) s += 0.6; // más fácil socializar
      break;
  }
  // Edades de cada viajero: ajustamos según la composición real del grupo, no
  // solo la media (p. ej. un grupo con un niño y dos adultos, o mixto joven/sénior).
  const ages = (prefs.ages || []).filter((a) => Number.isFinite(a));
  if (ages.length) {
    const hasChild = ages.some((a) => a < 13);
    const youngShare = ages.filter((a) => a >= 16 && a <= 30).length / ages.length;
    const seniorShare = ages.filter((a) => a >= 60).length / ages.length;
    if (hasChild) {
      if (t.includes("nightlife")) s -= 2.5;
      if (t.includes("nature") || t.includes("beach")) s += 1.2;
      if (dest.isHiddenGem) s -= 0.6; // traslados largos cansan más con niños
    }
    if (youngShare >= 0.5) {
      if (t.includes("nightlife")) s += 1.2;
      if (t.includes("beach")) s += 0.4;
    }
    if (seniorShare >= 0.5) {
      if (t.includes("nightlife")) s -= 1.4;
      if (t.includes("culture") || t.includes("nature")) s += 0.8;
    }
  } else if (Number.isFinite(prefs.age)) {
    // Sin edades por viajero: usamos la media como antes.
    if (prefs.age <= 30) {
      if (t.includes("nightlife")) s += 1.2;
      if (t.includes("beach")) s += 0.4;
    } else if (prefs.age >= 55) {
      if (t.includes("nightlife")) s -= 1.4;
      if (t.includes("culture") || t.includes("nature")) s += 0.8;
    }
  }
  return s;
}

// Puntúa el encaje con las preferencias. Los intereses (vibes) se reciben YA
// ordenados por prioridad: el primero pesa más que el segundo, etc.
function scoreDestination(dest, prefs) {
  let score = 0;
  const vibes = prefs.vibes || [];
  const n = vibes.length;
  vibes.forEach((v, i) => {
    if (dest.tags.includes(v)) score += (n - i) * 2; // 1ª prioridad pesa más
  });
  // clima
  if (prefs.climate && prefs.climate !== "any") {
    if (prefs.climate === "seasonal") {
      if (dest.season === "alpine" || dest.tags.includes("nature")) score += 2;
      if (dest.climate === "cool") score += 1;
    } else if (dest.climate === prefs.climate) score += 2;
    else if (prefs.climate === "warm" && dest.climate === "temperate") score += 1;
  }
  // ritmo
  if (prefs.pace === "relax" && (dest.tags.includes("nature") || dest.tags.includes("romantic"))) score += 1;
  if (prefs.pace === "adventure" && (dest.tags.includes("culture") || dest.tags.includes("nightlife"))) score += 1;
  // estilo explorador
  const explorer = prefs.explorerStyle || (prefs.hiddenGems ? "balanced" : "highlights");
  if (dest.isHiddenGem) {
    if (explorer === "hidden") score += 3;
    else if (explorer === "balanced") score += 1.5;
    else score -= 100;
  } else if (explorer === "highlights") {
    score += (dest.appeal ?? 3) >= 4 ? 1.5 : 0.5;
  }
  // presupuesto (tier)
  const tier = prefs.budgetTier || "mid";
  const refPrice = dest.baseFlight + dest.baseHotelNight * (prefs.nights || 4);
  if (tier === "budget" && refPrice > 280) score -= 1.5;
  if (tier === "luxury" && refPrice < 200) score -= 0.8;
  if (tier === "premium" || tier === "luxury") {
    if ((dest.appeal ?? 3) >= 4) score += 0.8;
  }
  // anti-bajona (distancia + atractivo + desconocimiento) y demografía
  score += antiBajonaScore(dest);
  score += demographicAdjust(dest, prefs);
  return score + Math.random() * 0.3; // pequeño desempate
}

// Precio de referencia (temporada neutra, sin finde) usado para comparar
// destinos entre sí y formar la banda "sin destinos mucho más baratos".
function referenceCharged(dest, prefs, stayFactor) {
  const f = cityFactor(prefs.departureCity);
  const travelers = prefs.travelers || 2;
  const nights = prefs.nights || 2;
  const rooms = Math.ceil(travelers / PRICING.peoplePerRoom);
  const flight = (dest.baseFlight * f) * travelers * PRICING.markups.flight;
  const hotel = dest.baseHotelNight * stayFactor * nights * rooms * PRICING.markups.hotel;
  const transfer = dest.transferCost * travelers * PRICING.markups.transfer;
  return flight + hotel + transfer;
}

// ¿El destino encaja con alguno de los intereses marcados? Sin intereses, todo
// encaja. Con intereses, el destino DEBE compartir al menos uno de sus tags.
function matchesVibes(dest, vibes) {
  if (!vibes || !vibes.length) return true;
  return vibes.some((v) => dest.tags.includes(v));
}
// ¿Encaja con las dos máximas prioridades? Con dos intereses marcados, el destino
// debe tener AMBOS en tags; con uno solo, ese; sin intereses, todo encaja.
function matchesTopVibes(dest, vibes) {
  const top = (vibes || []).slice(0, 2).filter(Boolean);
  if (!top.length) return true;
  return top.every((v) => dest.tags.includes(v));
}
// ¿Encaja con el clima pedido? "any" no filtra. Permitimos adyacencias suaves
// (templado sirve para quien pide cálido o fresco) para no excluir de más.
function matchesClimate(dest, climate) {
  if (!climate || climate === "any") return true;
  if (climate === "seasonal") {
    return dest.season === "alpine" || dest.climate === "cool" || dest.tags.includes("nature");
  }
  if (dest.climate === climate) return true;
  if (dest.climate === "temperate" && (climate === "warm" || climate === "cool")) return true;
  return false;
}

// Selecciona SIEMPRE N destinos (por defecto 6). Todos deben encajar con las dos
// máximas prioridades (ambas en tags). Si no hay suficientes, solo relajamos clima;
// nunca metemos destinos que no cumplan las dos primeras prioridades.
function selectDestinations(prefs, sourcePool = CATALOG, n = PRICING.destinationsShown) {
  const discarded = new Set(prefs.discarded || []);
  const origin = originCountryOf(prefs.departureCity);
  const stayFactor = stayTierFactor(prefs.stayTier);
  const vibes = prefs.vibes || [];
  const topVibes = vibes.slice(0, 2).filter(Boolean);

  const explorer = prefs.explorerStyle || (prefs.hiddenGems !== false ? "balanced" : "highlights");
  const allowGems = explorer !== "highlights";
  const basePool = sourcePool
    .filter((d) => !discarded.has(d.id))
    .filter((d) => (origin ? d.country !== origin : true))
    .filter((d) => (allowGems ? true : !d.isHiddenGem));
  let pool = basePool.filter((d) => matchesTripDistance(d, prefs));
  if (pool.length < Math.min(PRICING.destinationsMin || n, basePool.length)) {
    pool = basePool.filter((d) => matchesTripDistance(d, prefs, 1.18));
  }
  if (!pool.length) pool = basePool;

  const scored = pool
    .map((d) => ({ d, s: scoreDestination(d, prefs), ref: referenceCharged(d, prefs, stayFactor) }))
    .sort((a, b) => b.s - a.s);

  const onTopic = scored.filter((x) => matchesTopVibes(x.d, vibes));

  const chosen = [];
  const ids = new Set();
  const add = (x) => { if (!ids.has(x.d.id)) { chosen.push(x); ids.add(x.d.id); } };
  const fill = (layer, cap) => {
    if (!layer.length) return;
    const med = percentile(layer.map((x) => x.ref), 0.5) || 0;
    const lo = med * PRICING.bandLow;
    const hi = med * PRICING.bandHigh;
    for (const x of layer.filter((x) => x.ref >= lo && x.ref <= hi)) {
      if (chosen.length >= cap) break;
      add(x);
    }
    for (const x of layer) {
      if (chosen.length >= cap) break;
      add(x);
    }
  };

  const matchLayers = [
    onTopic.filter((x) => matchesClimate(x.d, prefs.climate)),
    onTopic,
  ];
  for (const layer of matchLayers) {
    if (chosen.length >= n) break;
    fill(layer, n);
  }

  const min = Math.min(PRICING.destinationsMin || 0, scored.length);
  if (chosen.length < min) {
    if (topVibes.length >= 2) fill(onTopic, min);
    else fill(scored, min);
  }

  return chosen.slice(0, n).map(({ d }) => ({ id: d.id, matchReason: null, flightPerPerson: null, hotelPerNight: null }));
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */
async function openaiJSON(system, user, { timeoutMs = 28000, temperature = 0.7, model = OPENAI_MODEL } = {}) {
  if (!OPENAI_API_KEY) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = {
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (isGpt5Model(model)) payload.reasoning_effort = "low";
    else payload.temperature = temperature;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("OpenAI error", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return content ? JSON.parse(content) : null;
  } catch (err) {
    console.error("OpenAI request failed:", err.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// La IA DECIDE los destinos (de cualquier parte del mundo, sin acotarlos a un
// catálogo). Devuelve fichas completas con los datos que necesita el motor de
// precios (vuelo/hotel base, traslado, estacionalidad, IATA…) y la filosofía
// "que no dé bajona" (lejano + atractivo + poco trillado para el origen). El
// servidor sigue siendo la fuente de verdad del PRECIO: solo aplica sus markups
// y el ancla sobre las cifras base que propone la IA.
async function aiDestinations(prefs, n = 14) {
  if (!OPENAI_API_KEY) return null;
  const origin = prefs.departureCity || "Madrid";
  const originCountry = originCountryOf(origin) || "—";
  const distance = distanceBoundsForTrip(prefs);
  const vibesOrdered = (prefs.vibes || []).length
    ? (prefs.vibes || []).map((v, i) => `${i + 1}º ${v}`).join(", ")
    : "sin preferencias marcadas";
  const explorer = prefs.explorerStyle || (prefs.hiddenGems !== false ? "balanced" : "highlights");
  const system =
    "Eres un planificador de viajes experto y creativo. Propones destinos de " +
    "CUALQUIER parte del mundo (sin limitarte a ninguna lista cerrada) para " +
    "escapadas en avión. Respondes SIEMPRE en JSON válido y en español.";
  const user = `Propón ${n} destinos para un viaje sorpresa, ORDENADOS del que más encaja al que menos.

Viajero:
- Sale de: ${origin} (país: ${originCountry})
- Intereses por prioridad (máx. 3, el 1º pesa más): ${vibesOrdered}
- Clima: ${prefs.climate || "any"} · Ritmo: ${prefs.pace || "balanced"}
- Perfil: ${profileLabel(prefs.profile)}${agesLabel(prefs) ? ` · ${agesLabel(prefs)}` : ""}
- Presupuesto: ${BUDGET_LABELS[prefs.budgetTier] || "medio"} · Duración: ${TRIP_LABELS[prefs.tripLength] || prefs.nights + " noches"} (${prefs.days || prefs.nights + 1} días)
- Distancia aceptable: ${RANGE_LABELS[prefs.travelRange] || "media distancia"}
- Estilo explorador: ${EXPLORER_LABELS[explorer] || "mezcla equilibrada"}
- Alojamiento preferido: ${ACCOM_LABELS[prefs.accommodation] || "indiferente"} · Comodidad: ${COMFORT_LABELS[prefs.comfortLevel] || "equilibrada"}
- Noches: ${prefs.nights} · Viajeros: ${prefs.travelers}
- Distancia adecuada para esta duración: ${distance.label}; baseFlight entre ${distance.min} y ${distance.max} € aprox.

Reglas IMPORTANTES (filosofía "que no dé bajona"):
- NO repitas el país de origen (${originCountry}).
- Prioriza destinos que MEREZCAN el viaje por tres ejes: (1) DISTANCIA: que se sienta una escapada de verdad, no algo a un paso; (2) ATRACTIVO: factor "wow"; (3) DESCONOCIMIENTO: poco trillado/sorprendente para alguien de ${originCountry}. Ejemplo: para alguien de Madrid, Oporto resulta cercano y muy trillado: penalízalo frente a destinos más lejanos y diferentes.
- Respeta la distancia adecuada a la duración y la tolerancia del viajero.
- Respeta clima e intereses y adapta al perfil/edad (familia: evita fiesta, favorece naturaleza/playa; pareja: romántico; amigos: animado; sénior: cultura/naturaleza).
- Cada destino debe incluir en "tags" las DOS primeras prioridades de interés (ambas obligatorias en cada destino).
- ${explorer === "hidden" ? "Prioriza joyas escondidas (isHiddenGem=true y describe el traslado en 'transfer')." : explorer === "highlights" ? "NO incluyas joyas escondidas: destinos icónicos y accesibles, todas isHiddenGem=false." : "Puedes mezclar destinos icónicos y joyas escondidas (isHiddenGem=true con traslado descrito)."}
- ${prefs.climate === "seasonal" ? "Prioriza destinos con experiencias estacionales marcadas (nieve, otoño, auroras, etc.)." : ""}
- ${prefs.budgetTier === "budget" ? "Prioriza destinos económicos." : prefs.budgetTier === "luxury" ? "Prioriza destinos premium y exclusivos." : "Mezcla precios pero sin opciones desproporcionadamente baratas respecto al resto."}

Para CADA destino devuelve EXACTAMENTE estos campos:
- id: slug en minúsculas con guiones
- name, country, region
- gateway: ciudad del aeropuerto principal
- gatewayIata: código IATA de 3 letras del aeropuerto de destino
- isHiddenGem: booleano
- transfer: si es joya escondida, texto del trayecto desde el aeropuerto; si no, null
- tags: subconjunto de ["beach","culture","nature","food","nightlife","romantic","adventure"]
- climate: "warm" | "temperate" | "cool"
- season: "beach" | "city" | "nature" | "alpine" (perfil de estacionalidad de precios)
- baseFlight: estimación realista del vuelo ida y vuelta por persona en € desde ${origin}
- baseHotelNight: precio neto realista por noche y habitación doble (categoría base 3-4★) en €
- transferCost: coste del traslado por persona en € (0 si no aplica)
- appeal: 1-5 (atractivo intrínseco)
- novelty: 1-5 (1 = muy trillado/cercano, 5 = casi ignoto para alguien de ${originCountry})
- blurb: frase evocadora (máx. 120 caracteres)
- why: por qué encaja con ESTE viajero (máx. 90 caracteres)

Devuelve JSON EXACTO: {"destinations":[ { ...campos... }, ... ]}`;
  const out = await openaiJSON(system, user, { timeoutMs: 30000, temperature: 0.9 });
  const arr = out?.destinations;
  if (!Array.isArray(arr) || !arr.length) return null;
  const seen = new Set();
  const list = [];
  for (const raw of arr) {
    const d = normalizeDest(raw, seen);
    if (d) list.push(d);
  }
  return list.length ? list : null;
}

// La selección y el precio son deterministas (servidor = fuente de verdad). La
// IA solo personaliza el texto de "por qué encaja" de cada destino ya elegido,
// teniendo en cuenta el ORDEN de prioridad de los intereses del viajero.
async function aiMatchReasons(picks, prefs) {
  if (!OPENAI_API_KEY || !picks.length) return picks;
  const list = picks
    .map((p) => destById(p.id))
    .filter(Boolean)
    .map((d) => ({ id: d.id, name: d.name, country: d.country, tags: d.tags, climate: d.climate, isHiddenGem: d.isHiddenGem }));
  const system =
    "Eres el motor de recomendación de una agencia de viajes sorpresa premium. " +
    "Escribes una frase breve y personalizada de por qué cada destino encaja con el viajero. " +
    "Respondes SIEMPRE en JSON válido y en español.";
  const vibesOrdered = (prefs.vibes || []).length
    ? (prefs.vibes || []).map((v, i) => `${i + 1}º ${v}`).join(", ")
    : "sin preferencias marcadas";
  const foodNote = (prefs.foodInterests || []).length
    ? ` · Gastronomía: ${prefs.foodInterests.map((f) => FOOD_LABELS[f] || f).join(", ")}`
    : "";
  const dietNote = prefs.dietary && prefs.dietary !== "none"
    ? ` · Dieta: ${DIET_LABELS[prefs.dietary]}`
    : "";
  const user = `Preferencias del viajero (intereses por ORDEN de prioridad, el 1º es el que más importa):
- Intereses: ${vibesOrdered}
- Clima: ${prefs.climate || "any"} · Ritmo: ${prefs.pace || "balanced"}
- Presupuesto: ${BUDGET_LABELS[prefs.budgetTier] || "medio"} · Estilo: ${EXPLORER_LABELS[prefs.explorerStyle] || "equilibrado"}
- Perfil: ${profileLabel(prefs.profile)}${agesLabel(prefs) ? ` · ${agesLabel(prefs)}` : ""}${foodNote}${dietNote}

Destinos ya seleccionados:
${JSON.stringify(list)}

Devuelve JSON EXACTO: {"reasons":{"<id>":"<frase personalizada, max 90 caracteres, en español>"}}
Para CADA id de la lista. Da más peso a la 1ª prioridad del viajero y al perfil/edad del grupo al justificar el encaje.`;
  const out = await openaiJSON(system, user, { timeoutMs: 18000 });
  const reasons = out?.reasons;
  if (!reasons || typeof reasons !== "object") return picks;
  return picks.map((p) => ({
    ...p,
    matchReason: typeof reasons[p.id] === "string" ? reasons[p.id].slice(0, 120) : p.matchReason,
  }));
}

/* ------------------------------------------------------------------ */
/* Construcción de la cotización                                      */
/* ------------------------------------------------------------------ */
// Construye la ficha de destino. Resuelve los datos base por id (catálogo curado
// o propuesta de la IA registrada). Si el destino no estuviera en memoria (p. ej.
// el proceso se reinició entre la cotización y el checkout), reconstruye con los
// campos que el propio cliente devuelve en el pick (rehidratación).
function buildDestination(pick, prefs) {
  const d = destById(pick.id) || {};
  const f = cityFactor(prefs.departureCity);
  const flightPerPerson = pick.flightPerPerson
    ?? (Number.isFinite(d.baseFlight) ? round(d.baseFlight * f) : 120);
  const hotelPerNight = pick.hotelPerNight
    ?? (Number.isFinite(d.baseHotelNight) ? d.baseHotelNight : 140);
  const seasonality = d.season
    ? SEASONS[d.season]
    : (Array.isArray(pick.seasonality) && pick.seasonality.length === 12 ? pick.seasonality : SEASONS.city);
  const transferCost = Number.isFinite(d.transferCost)
    ? d.transferCost
    : (Number.isFinite(+pick.transferCost) ? +pick.transferCost : 0);
  return {
    id: pick.id,
    name: d.name ?? pick.name ?? "Destino",
    country: d.country ?? pick.country ?? "",
    region: d.region ?? pick.region ?? "",
    gateway: d.gateway ?? pick.gateway ?? (d.name ?? pick.name ?? ""),
    isHiddenGem: d.isHiddenGem ?? !!pick.isHiddenGem,
    transfer: d.transfer ?? pick.transfer ?? null,
    tags: d.tags ?? pick.tags ?? [],
    blurb: d.blurb ?? pick.blurb ?? "",
    image: pick.image ?? d.image ?? null,
    matchReason: pick.matchReason || d.why || d.blurb || pick.blurb || "",
    // costes base de proveedor (sin margen)
    flightPerPerson,
    hotelPerNight,
    transferCost,
    seasonality,
    // de dónde sale el precio base ("amadeus" = real, null = estimado)
    flightSource: pick.flightSource || null,
    hotelSource: pick.hotelSource || null,
  };
}

// ¿Podemos construir/cotizar este pick? Sí si lo resolvemos por id, o si el
// cliente nos devuelve sus propios precios base (rehidratación tras reinicio).
const usableDest = (p) =>
  !!destById(p.id) || (Number.isFinite(+p.flightPerPerson) && Number.isFinite(+p.hotelPerNight));

/* ------------------------------------------------------------------ */
/* Enriquecimiento con datos reales (Amadeus + Unsplash)              */
/* ------------------------------------------------------------------ */
const todayStr = () => new Date().toISOString().slice(0, 10);

// Sustituye los precios estimados por precios reales de Amadeus cuando existan.
// Usa una fecha de referencia (~30 días) y cachea por ruta/destino; el motor de
// estacionalidad sigue modulando el precio por fecha en el calendario.
async function enrichPrices(picks, prefs) {
  if (!amadeusEnabled()) return;
  const dep = addDays(todayStr(), 30);
  const ret = addDays(dep, prefs.nights || 2);
  await Promise.allSettled(
    picks.map(async (p) => {
      const d = destById(p.id);
      if (!d) return;
      const [flight, hotel] = await Promise.all([
        cheapestFlightPP(prefs.departureCity || "Madrid", d.gateway, dep, ret),
        cheapestHotelNight(d.gateway, dep, ret),
      ]);
      if (Number.isFinite(flight)) { p.flightPerPerson = clamp(flight, 30, 1500); p.flightSource = "amadeus"; }
      if (Number.isFinite(hotel)) { p.hotelPerNight = clamp(hotel, 40, 1500); p.hotelSource = "amadeus"; }
    })
  );
}

// URL del placeholder local (SVG generado por la app). SIEMPRE carga, también en
// redes que bloquean CDNs externos (el navegador lo pide al propio servidor).
function sceneKindFor(d) {
  const t = d.tags || [];
  if (t.includes("beach")) return "beach";
  if (d.season === "alpine" || d.season === "nature" || t.includes("nature")) return "nature";
  return "city";
}

// Asigna la imagen de cada destino. Si ya hay una foto generada por IA en caché,
// se usa directamente; si no, se apunta al endpoint inteligente /api/destimg
// (que sirve el placeholder ilustrado al instante y dispara la generación con
// OpenAI en segundo plano). El front luego sustituye el placeholder por la foto
// real cuando esté lista (mejora progresiva).
function attachImages(destinations) {
  for (const d of destinations) {
    // d ya es la ficha construida (tiene name/region/country/blurb), así que sirve
    // para generar la imagen aunque el destino lo haya inventado la IA.
    ensureImage(d).catch(() => {}); // arranca la generación cuanto antes
    const cached = cachedGeneratedUrl(d.id);
    const fallback =
      `/api/destimg?id=${encodeURIComponent(d.id)}` +
      `&name=${encodeURIComponent(d.name || "Destino")}` +
      `&kind=${encodeURIComponent(sceneKindFor(d))}`;
    d.image = { url: cached || fallback };
  }
}

function roundUpTo(n, step) {
  return Math.ceil(n / step) * step;
}

// Extrae el precio "≈XX €" de un texto de actividad (0 si no lo encuentra).
function priceOf(s) {
  const m = (s || "").match(/≈\s*(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : 0;
}

function priceActivityPack(pack, baseTier) {
  const items = Array.isArray(pack.items) ? pack.items.filter(Boolean).slice(0, 5) : [];
  const rawValue = items.reduce((a, it) => a + priceOf(it), 0);
  const fallbackValue = baseTier.valuePerPerson || baseTier.items.reduce((a, it) => a + priceOf(it), 0);
  const valuePerPerson = Math.max(round(rawValue || fallbackValue), baseTier.pricePerPerson || 0);
  // El pack cobra menos que reservar suelto, pero deja margen sobre coste neto.
  const pricePerPerson = roundUpTo(Math.max(valuePerPerson * 0.72, (baseTier.pricePerPerson || 0) * 0.75), 10);
  const perPersonCost = round(Math.max(pricePerPerson * 0.62, baseTier.perPersonCost || 0));
  return {
    id: baseTier.id,
    name: baseTier.name,
    tagline: String(pack.tagline || baseTier.tagline).slice(0, 90),
    perPersonCost,
    pricePerPerson,
    valuePerPerson,
    items: items.length ? items : baseTier.items,
  };
}

function fallbackActivityPacks(destinations, prefs) {
  const tags = new Set(destinations.flatMap((d) => d.tags || []));
  const family = prefs.profile === "familia" || (prefs.ages || []).some((a) => Number.isFinite(a) && a < 13);
  const foods = new Set(prefs.foodInterests || []);
  const foodie = tags.has("food") || (prefs.vibes || []).includes("food") || foods.size > 0;
  const nature = tags.has("nature") || (prefs.vibes || []).includes("nature");
  const beach = tags.has("beach") || (prefs.vibes || []).includes("beach");
  const culture = tags.has("culture") || (prefs.vibes || []).includes("culture");
  const lively = tags.has("nightlife") && !family;
  const diet = prefs.dietary && prefs.dietary !== "none" ? DIET_LABELS[prefs.dietary] : null;

  const foodEssence = foods.has("street") ? "Ruta de street food local"
    : foods.has("fine") ? "Degustación en restaurante con estrella"
    : foods.has("wine") ? "Visita a bodega o viñedo"
    : foods.has("markets") ? "Tour por mercado gastronómico"
    : foods.has("cooking") ? "Taller de cocina con anfitrión"
    : foods.has("beer") ? "Ruta de cervezas artesanales"
    : foodie ? "Ruta de sabores locales" : culture ? "Paseo cultural guiado" : "Tour de bienvenida con guía local";
  const foodImmersion = foods.has("fine") ? "Experiencia gastronómica premium con chef"
    : foods.has("cooking") ? "Clase de cocina privada con chef local"
    : foods.has("wine") ? "Cata privada en bodega de la región"
    : foodie ? "Experiencia gastronómica con chef o mercado" : "Experiencia privada con anfitrión local";
  const dietNote = diet ? ` (${diet})` : "";

  const essenceItems = [
    `${foodEssence}${dietNote} adaptado al destino · ≈${family ? 58 : 68} €`,
    `${beach ? "Plan al atardecer junto al mar" : nature ? "Mirador o ruta suave de naturaleza" : "Cata o taller local de temporada"} · ≈${family ? 42 : 55} €`,
    "Reserva prioritaria + mapa personalizado de rincones secretos · ≈25 €",
  ];
  const immersionItems = [
    `${foodImmersion}${dietNote} · ≈${family ? 95 : 115} €`,
    `${culture ? "Guía privado de medio día" : nature ? "Actividad outdoor guiada" : "Ruta curada por barrios con carácter"} · ≈${family ? 105 : 130} €`,
    `${beach ? "Actividad de costa o barco compartido" : nature ? "E-bike, kayak o senderismo guiado" : lively ? "Plan nocturno seguro con entrada incluida" : "Taller artesanal o creativo local"} · ≈${family ? 62 : 76} €`,
    "Asistente de viaje por chat 24/7 · ≈20 €",
  ];
  return [
    priceActivityPack({ tagline: "Lo esencial del destino sin cargar la agenda", items: essenceItems }, TIERS[0]),
    priceActivityPack({ tagline: "Más profundidad, planes privados y ritmo más completo", items: immersionItems }, TIERS[1]),
  ];
}

async function aiActivityPacks(destinations, prefs) {
  if (!OPENAI_API_KEY || !destinations.length) return fallbackActivityPacks(destinations, prefs);
  const list = destinations.map((d) => ({
    name: d.name, country: d.country, region: d.region, tags: d.tags,
    hiddenGem: d.isHiddenGem, transfer: d.transfer,
  }));
  const system =
    "Eres diseñador de experiencias para una agencia de viajes sorpresa premium. " +
    "Creas packs de actividades que funcionan para cualquiera de los destinos posibles, " +
    "adaptados al perfil del grupo. Respondes SIEMPRE en JSON válido y en español.";
  const foodNote = (prefs.foodInterests || []).length
    ? ` · Gastronomía: ${prefs.foodInterests.map((f) => FOOD_LABELS[f] || f).join(", ")}`
    : "";
  const dietNote = prefs.dietary && prefs.dietary !== "none"
    ? ` · Dieta: ${DIET_LABELS[prefs.dietary] || prefs.dietary}`
    : "";
  const user = `Crea 2 packs de actividades para este viaje sorpresa.

Viajero:
- Perfil: ${profileLabel(prefs.profile)}${agesLabel(prefs) ? ` · ${agesLabel(prefs)}` : ""}
- Viajeros: ${prefs.travelers} · Noches: ${prefs.nights}
- Intereses por prioridad: ${(prefs.vibes || []).join(", ") || "sin marcar"}
- Ritmo: ${prefs.pace || "balanced"} · Clima: ${prefs.climate || "any"}${foodNote}${dietNote}
- Comodidad: ${COMFORT_LABELS[prefs.comfortLevel] || "equilibrada"} · Alojamiento: ${ACCOM_LABELS[prefs.accommodation] || "indiferente"}

Destinos posibles:
${JSON.stringify(list)}

Reglas:
- Pack 1 id "esencia": 3 actividades, ligeras, universales y con buen valor.
- Pack 2 id "inmersion": 4 actividades, más privadas/profundas y de mayor valor.
- Las actividades deben encajar con los POSIBLES destinos, características del viaje y viajeros.
- Si hay niños, evita noche/fiesta y usa planes family-friendly.
- Cada actividad termina con precio de mercado por persona: " · ≈XX €".
- Los precios deben ser realistas y distintos entre packs; no copies los ejemplos base.
- Máximo 95 caracteres por actividad sin contar precio.

Devuelve JSON EXACTO:
{"packs":[
  {"id":"esencia","tagline":"","items":["... · ≈XX €","... · ≈XX €","... · ≈XX €"]},
  {"id":"inmersion","tagline":"","items":["... · ≈XX €","...","...","..."]}
]}`;
  const out = await openaiJSON(system, user, { temperature: 0.75, timeoutMs: 18000 });
  const packs = out?.packs;
  if (!Array.isArray(packs) || packs.length < 2) return fallbackActivityPacks(destinations, prefs);
  return TIERS.slice(0, 2).map((base, i) => {
    const pack = packs.find((p) => p?.id === base.id) || packs[i] || {};
    const expected = base.id === "esencia" ? 3 : 4;
    const items = Array.isArray(pack.items) ? pack.items.filter((it) => typeof it === "string").slice(0, expected) : [];
    if (items.length !== expected || items.some((it) => !/≈\s*\d/.test(it))) {
      return fallbackActivityPacks(destinations, prefs)[i];
    }
    return priceActivityPack({ ...pack, items }, base);
  });
}

app.post("/api/quote", async (req, res) => {
  try {
    const prefs = normalizePrefs(req.body || {});

    // La IA decide los destinos (mundo entero, sin acotar). Si no hay IA o falla,
    // usamos el catálogo curado como fallback determinista.
    let pool = CATALOG;
    let aiDestins = false;
    if (OPENAI_API_KEY) {
      const ai = await aiDestinations(prefs, 10);
      if (ai && ai.length >= 6) {
        pool = ai;
        aiDestins = true;
        for (const d of pool) {
          registerDest(d);
          if (d.gatewayIata) registerIata(d.gateway, d.gatewayIata);
        }
      }
    }

    let picks = selectDestinations(prefs, pool); // banda de precio comparable
    // Razón de encaje: la IA ya la trae por destino ("why"); si no, la pedimos aparte.
    picks = picks.map((p) => ({ ...p, matchReason: destById(p.id)?.why || p.matchReason }));
    if (!aiDestins) picks = await aiMatchReasons(picks, prefs);
    const usedAI = !!OPENAI_API_KEY;

    await enrichPrices(picks, prefs);
    const destinations = picks.map((p) => buildDestination(p, prefs));
    await attachImages(destinations);
    const activityPacks = await aiActivityPacks(destinations, prefs);

    // Mínimo por persona (suelo) según los precios encontrados y la configuración
    // elegida: el cliente fijará su presupuesto por encima de este valor.
    const minBudget = minBudgetPerPerson(destinations, prefs);

    res.json({
      ok: true,
      source: usedAI ? "openai" : "fallback",
      providers: { amadeus: amadeusEnabled(), unsplash: unsplashEnabled(), imagegen: imageGenEnabled() },
      currency: PRICING.currency,
      pricing: PRICING,
      tiers: activityPacks,
      stayTiers: STAY_TIERS,
      prefs,
      destinations,
      minBudgetPerPerson: minBudget,
    });
  } catch (err) {
    console.error("/api/quote failed", err);
    res.status(500).json({ ok: false, error: "No se pudo generar la cotización" });
  }
});

// Recalcula packs de experiencia cuando el viajero ajusta gastronomía, dieta,
// alojamiento o comodidad tras ver los destinos posibles.
app.post("/api/refine-tiers", async (req, res) => {
  try {
    const body = req.body || {};
    const prefs = normalizePrefs(body.prefs || {});
    const destinations = Array.isArray(body.destinations) ? body.destinations.slice(0, 12) : [];
    if (!destinations.length) {
      return res.status(400).json({ ok: false, error: "Faltan destinos" });
    }
    const tiers = await aiActivityPacks(destinations, prefs);
    res.json({ ok: true, tiers, prefs });
  } catch (err) {
    console.error("/api/refine-tiers failed", err);
    res.status(500).json({ ok: false, error: "No se pudieron actualizar las experiencias" });
  }
});

// Vista previa del impacto de ajustar presupuesto, duración, hotel, etc.
app.post("/api/adjust-preview", async (req, res) => {
  try {
    const body = req.body || {};
    const prefs = normalizePrefs(body.prefs || {});
    const baseline = body.baseline ? normalizePrefs(body.baseline) : null;
    const requiresNewQuote = detectMajorAdjustChange(baseline, prefs);

    let destinations = Array.isArray(body.destinations) ? body.destinations.slice(0, 12) : [];
    if (requiresNewQuote || !destinations.length) {
      const picks = selectDestinations(prefs, CATALOG, PRICING.destinationsShown);
      destinations = picks.map((p) => buildDestination(p, prefs));
    }

    const calMin = calendarMinPerPerson(destinations, prefs);
    const impacts = describeAdjustImpacts(baseline, prefs);

    res.json({
      ok: true,
      prefs,
      calendarMinPerPerson: calMin?.min ?? null,
      calendarMinDate: calMin?.minDate ?? null,
      minBudgetPerPerson: calMin?.min ?? null,
      requiresNewQuote,
      impacts,
    });
  } catch (err) {
    console.error("/api/adjust-preview failed", err);
    res.status(500).json({ ok: false, error: "No se pudo previsualizar el ajuste" });
  }
});

/* ------------------------------------------------------------------ */
/* Precios (mismas fórmulas que el front, fuente de verdad)           */
/* ------------------------------------------------------------------ */
function isWeekend(dateStr) {
  const day = new Date(dateStr + "T12:00:00").getDay(); // 0 dom ... 6 sab
  return day === 5 || day === 6;
}
function monthIndex(dateStr) {
  return new Date(dateStr + "T12:00:00").getMonth();
}

// Coste y precio de PROVEEDOR (vuelo + hotel + traslado) de un destino para una
// fecha. NO incluye actividades (son uniformes y se suman aparte, al ancla).
// stayFactor escala el hotel según el nivel de viaje elegido (Cómodo/Boutique/Villa).
async function destProvider(dest, dateStr, prefs, stayFactor, { live = false } = {}) {
  const m = monthIndex(dateStr);
  const season = dest.seasonality[m];
  const weekend = isWeekend(dateStr) ? 1 + PRICING.weekendPremium : 1;
  const nights = prefs.nights;
  const travelers = prefs.travelers;
  const rooms = Math.ceil(travelers / PRICING.peoplePerRoom);

  // En modo "live" consultamos Amadeus para LAS FECHAS EXACTAS elegidas.
  let realFlightPP = null, realHotelNight = null;
  if (live && amadeusEnabled()) {
    const ret = addDays(dateStr, nights);
    [realFlightPP, realHotelNight] = await Promise.all([
      cheapestFlightPP(prefs.departureCity || "Madrid", dest.gateway, dateStr, ret),
      cheapestHotelNight(dest.gateway, dateStr, ret),
    ]);
  }

  const flightCost = Number.isFinite(realFlightPP)
    ? realFlightPP * travelers
    : dest.flightPerPerson * season * weekend * travelers;
  const hotelCost = Number.isFinite(realHotelNight)
    ? realHotelNight * stayFactor * nights * rooms
    : dest.hotelPerNight * stayFactor * season * nights * rooms;
  const transferCost = dest.transferCost * travelers;

  const flightCharged = flightCost * PRICING.markups.flight;
  const hotelCharged = hotelCost * PRICING.markups.hotel;
  const transferCharged = transferCost * PRICING.markups.transfer;

  return {
    cost: flightCost + hotelCost + transferCost,
    charged: flightCharged + hotelCharged + transferCharged,
    live: Number.isFinite(realFlightPP) || Number.isFinite(realHotelNight),
    components: {
      cost: { flight: round(flightCost), hotel: round(hotelCost), transfer: round(transferCost) },
      charged: { flight: round(flightCharged), hotel: round(hotelCharged), transfer: round(transferCharged) },
    },
  };
}

// Precio sorpresa (ancla) para una fecha: percentil del precio-con-margen de
// TODO el pool ofertado + actividades. Es estable: NO depende de qué destinos
// descarte el cliente, así que descartar nunca revela cuál era el barato.
function anchorCharged(providerChargedList, activityChargedTotal) {
  const base = percentile(providerChargedList, PRICING.anchorPercentile);
  return Math.ceil((base + activityChargedTotal) / 10) * 10;
}

// Versión síncrona del coste-con-margen de proveedor (vuelo + hotel + traslado),
// idéntica a la del front y a destProvider en modo estimado. Se usa para escanear
// muchas fechas rápidamente al calcular el presupuesto mínimo.
function providerChargedSync(dest, dateStr, prefs, stayFactor) {
  const m = monthIndex(dateStr);
  const season = dest.seasonality[m];
  const weekend = isWeekend(dateStr) ? 1 + PRICING.weekendPremium : 1;
  const nights = prefs.nights;
  const travelers = prefs.travelers;
  const rooms = Math.ceil(travelers / PRICING.peoplePerRoom);
  const flight = dest.flightPerPerson * season * weekend * travelers * PRICING.markups.flight;
  const hotel = dest.hotelPerNight * stayFactor * season * nights * rooms * PRICING.markups.hotel;
  const transfer = dest.transferCost * travelers * PRICING.markups.transfer;
  return flight + hotel + transfer;
}

// Presupuesto MÍNIMO del calendario: mismo cálculo que cada celda del calendario
// (percentil anchorPercentile, redondeo a 10 € total y a 5 €/persona).
function calendarPricePerPerson(destinations, dateStr, prefs) {
  if (!destinations.length) return null;
  const stayFactor = stayTierFactor(prefs.stayTier);
  const travelers = prefs.travelers || 1;
  const all = destinations.map((d) => providerChargedSync(d, dateStr, prefs, stayFactor));
  const total = Math.ceil(percentile(all, PRICING.anchorPercentile) / 10) * 10;
  return Math.ceil((total / travelers) / 5) * 5;
}

function calendarMinPerPerson(destinations, prefs) {
  if (!destinations.length) return null;
  const startStr = addDays(todayStr(), 10);
  let min = Infinity;
  let minDate = null;
  for (let i = 0; i < 365; i++) {
    const ds = addDays(startStr, i);
    const per = calendarPricePerPerson(destinations, ds, prefs);
    if (per != null && per < min) { min = per; minDate = ds; }
  }
  return Number.isFinite(min) ? { min, minDate } : null;
}

function minBudgetPerPerson(destinations, prefs) {
  const r = calendarMinPerPerson(destinations, prefs);
  return r ? r.min : null;
}

function estimateRangePerPerson(destinations, prefs) {
  if (!destinations.length) return null;
  const stayFactor = stayTierFactor(prefs.stayTier);
  const travelers = prefs.travelers || 1;
  const startStr = addDays(todayStr(), 10);
  const prices = [];
  for (let i = 0; i < 180; i++) {
    const ds = addDays(startStr, i);
    const all = destinations.map((d) => providerChargedSync(d, ds, prefs, stayFactor));
    const total = anchorCharged(all, 0);
    prices.push(Math.ceil((total / travelers) / 5) * 5);
  }
  prices.sort((a, b) => a - b);
  const at = (q) => prices[Math.min(prices.length - 1, Math.max(0, Math.floor((prices.length - 1) * q)))] || 0;
  return {
    low: at(0.18),
    typical: at(0.50),
    high: at(0.78),
  };
}

function detectMajorAdjustChange(baseline, adjusted) {
  if (!baseline) return true;
  const keys = ["tripLength", "nights", "budgetTier", "travelRange", "explorerStyle", "pace", "climate"];
  if (keys.some((k) => baseline[k] !== adjusted[k])) return true;
  if (JSON.stringify(baseline.vibes || []) !== JSON.stringify(adjusted.vibes || [])) return true;
  return false;
}

function describeAdjustImpacts(baseline, adjusted) {
  if (!baseline) return [];
  const impacts = [];
  if (baseline.budgetTier !== adjusted.budgetTier) {
    impacts.push(`Presupuesto: ${BUDGET_LABELS[baseline.budgetTier] || baseline.budgetTier} → ${BUDGET_LABELS[adjusted.budgetTier] || adjusted.budgetTier}`);
  }
  if (baseline.nights !== adjusted.nights) {
    impacts.push(`Duración: ${baseline.days || baseline.nights + 1} → ${adjusted.days} días`);
  }
  if (baseline.stayTier !== adjusted.stayTier) {
    impacts.push(`Hotel: ${stayInfo(baseline.stayTier).name} → ${stayInfo(adjusted.stayTier).name}`);
  }
  if (baseline.travelRange !== adjusted.travelRange) {
    impacts.push(`Distancia: ${RANGE_LABELS[baseline.travelRange]} → ${RANGE_LABELS[adjusted.travelRange]}`);
  }
  if (baseline.explorerStyle !== adjusted.explorerStyle) {
    impacts.push(`Destinos: ${EXPLORER_LABELS[baseline.explorerStyle]} → ${EXPLORER_LABELS[adjusted.explorerStyle]}`);
  }
  if (baseline.pace !== adjusted.pace) {
    impacts.push(`Ritmo: ${PACE_LABELS?.[baseline.pace] || baseline.pace} → ${PACE_LABELS?.[adjusted.pace] || adjusted.pace}`);
  }
  if (Number.isFinite(baseline.budget) && Number.isFinite(adjusted.budget) && baseline.budget !== adjusted.budget) {
    impacts.push(`Tope: ${baseline.budget} → ${adjusted.budget} €/persona`);
  }
  const foodNew = (adjusted.foodInterests || []).filter((f) => !(baseline.foodInterests || []).includes(f));
  if (foodNew.length) {
    impacts.push(`Gastronomía: +${foodNew.map((f) => FOOD_LABELS[f] || f).join(", ")}`);
  }
  if (baseline.dietary !== adjusted.dietary && adjusted.dietary !== "none") {
    impacts.push(`Dieta: ${DIET_LABELS[adjusted.dietary] || adjusted.dietary}`);
  }
  if (baseline.comfortLevel !== adjusted.comfortLevel) {
    impacts.push(`Comodidad: ${COMFORT_LABELS[baseline.comfortLevel]} → ${COMFORT_LABELS[adjusted.comfortLevel]}`);
  }
  return impacts;
}

function estimatePrefsCompleteness(prefs) {
  let score = 0;
  if (prefs.departureCity) score += 1;
  if (prefs.travelers) score += 1;
  if (prefs.tripLength || prefs.nights) score += 1;
  if (prefs.profile) score += 1;
  if ((prefs.ages || []).some((a) => Number.isFinite(a))) score += 0.5;
  if ((prefs.vibes || []).length) score += 1;
  if (prefs.budgetTier) score += 1;
  if (prefs.climate && prefs.climate !== "any") score += 0.5;
  if (prefs.pace) score += 0.5;
  if (prefs.explorerStyle) score += 0.5;
  if (prefs.travelRange) score += 0.5;
  return Math.min(1, score / 8);
}

async function aiEstimateCopy(prefs, range, step) {
  const fallback = {
    headline: `Entre ${range.low} y ${range.high} €/persona`,
    note: "La cifra se afinará al elegir destinos y fecha.",
    drivers: [],
    confidence: estimatePrefsCompleteness(prefs) > 0.65 ? "media" : "baja",
  };
  if (!OPENAI_API_KEY) return fallback;

  const stay = stayInfo(prefs.stayTier);
  const system =
    "Eres un estimador de precio para un configurador de viajes sorpresa. " +
    "Explicas rangos de precio de forma breve, clara y honesta. Respondes SIEMPRE en JSON válido.";
  const user = `Genera una micro-estimación en español para el paso ${step + 1} del configurador.

Datos:
- Salida: ${prefs.departureCity}
- Viajeros: ${prefs.travelers}
- Noches: ${prefs.nights}
- Perfil: ${profileLabel(prefs.profile)}${agesLabel(prefs) ? ` · ${agesLabel(prefs)}` : ""}
- Intereses por prioridad: ${(prefs.vibes || []).join(", ") || "sin marcar"}
- Clima: ${prefs.climate || "any"} · Ritmo: ${prefs.pace || "balanced"}
- Alojamiento: ${stay.name} (${stay.stayType})
- Rango calculado por el motor: bajo ${range.low} €/persona, típico ${range.typical} €/persona, alto ${range.high} €/persona.

Reglas:
- No inventes precios fuera del rango calculado.
- No pidas presupuesto.
- No menciones un destino concreto: aún es sorpresa.
- Si mencionas ${prefs.departureCity}, debe quedar claro que es la ciudad de salida, no el destino.
- Máximo 1 frase en headline, 1 frase en note y 2 drivers.
- Tono de producto premium, directo.

Devuelve JSON EXACTO:
{"headline":"","note":"","drivers":["",""],"confidence":"baja|media|alta"}`;
  const out = await openaiJSON(system, user, { timeoutMs: 9000, temperature: 0.4, model: ESTIMATE_MODEL });
  if (!out || typeof out !== "object") return fallback;
  return {
    headline: fallback.headline,
    note: typeof out.note === "string" ? out.note.slice(0, 180) : fallback.note,
    drivers: Array.isArray(out.drivers) ? out.drivers.filter((d) => typeof d === "string").slice(0, 2) : [],
    confidence: ["baja", "media", "alta"].includes(out.confidence) ? out.confidence : fallback.confidence,
  };
}

app.post("/api/estimate", async (req, res) => {
  try {
    const body = req.body || {};
    const prefs = normalizePrefs(body.prefs || {});
    const step = clamp(parseInt(body.step, 10) || 0, 0, 3);
    const picks = selectDestinations(prefs, CATALOG, PRICING.destinationsShown);
    const destinations = picks.map((p) => buildDestination(p, prefs));
    const range = estimateRangePerPerson(destinations, prefs);
    if (!range) return res.status(400).json({ ok: false, error: "No hay datos para estimar" });
    const copy = await aiEstimateCopy(prefs, range, step);
    res.json({
      ok: true,
      currency: PRICING.currency,
      model: OPENAI_API_KEY ? ESTIMATE_MODEL : "fallback",
      range,
      copy,
    });
  } catch (err) {
    console.error("/api/estimate failed", err);
    res.status(500).json({ ok: false, error: "No se pudo estimar el precio" });
  }
});

/* ------------------------------------------------------------------ */
/* Checkout: revela vuelo + hotel asignados y el margen               */
/* ------------------------------------------------------------------ */
const AIRLINES = ["Vueling", "Ryanair", "Iberia", "ITA Airways", "Air France", "TAP Air Portugal", "Wizz Air", "Lufthansa", "easyJet"];

function pad(n) { return String(n).padStart(2, "0"); }
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMinutes(h, m, add) {
  let total = h * 60 + m + add;
  total = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

function fallbackFlightHotel(dest, prefs, dateStr) {
  const h = hashStr(dest.id + dateStr + (prefs.departureCity || ""));
  const airline = AIRLINES[h % AIRLINES.length];
  const depH = 6 + (h % 8);
  const dur = 90 + ((h >> 3) % 150);
  const flightNo = `${airline.slice(0, 2).toUpperCase()}${1000 + (h % 8999)}`;
  const retH = 17 + ((h >> 5) % 5);
  const retNo = `${airline.slice(0, 2).toUpperCase()}${1000 + ((h >> 7) % 8999)}`;
  const hoods = ["centro histórico", "casco antiguo", "barrio de moda", "junto al paseo marítimo", "zona monumental"];
  // El tipo de alojamiento depende del nivel de viaje elegido.
  const stay = stayInfo(prefs.stayTier);
  const adjsByTier = {
    comodo: ["Casa", "Aparthotel", "Guesthouse", "Lofts", "B&B"],
    boutique: ["Boutique", "Grand", "Palazzo", "Suites", "Maison"],
    villa: ["Villa", "Suite", "Relais", "Residenza", "Château"],
  };
  const suffixByTier = { comodo: ["", "& Co", "Stay"], boutique: ["Hotel", "Resort"], villa: ["Private", "& Spa", "Retreat"] };
  const adjs = adjsByTier[stay.id] || adjsByTier.boutique;
  const sfx = suffixByTier[stay.id] || ["Hotel"];
  const lastName = dest.name.split(" ").slice(-1)[0];
  return {
    outbound: { airline, flightNo, from: prefs.departureCity || "Madrid", to: dest.gateway, dep: `${pad(depH)}:00`, arr: addMinutes(depH, 0, dur), durationMin: dur },
    inbound: { airline, flightNo: retNo, from: dest.gateway, to: prefs.departureCity || "Madrid", dep: `${pad(retH)}:30`, arr: addMinutes(retH, 30, dur), durationMin: dur },
    hotel: {
      name: `${adjs[h % adjs.length]} ${lastName} ${sfx[h % sfx.length]}`.trim(),
      stars: stay.stars,
      stayType: stay.stayType,
      neighborhood: hoods[h % hoods.length],
      rating: (8.2 + (h % 16) / 10).toFixed(1),
    },
  };
}

async function aiFlightHotel(dest, prefs, dateStr) {
  const returnDate = addDays(dateStr, prefs.nights);
  const system =
    "Eres un sistema de reservas de viajes. Inventas detalles realistas de vuelos y hoteles " +
    "coherentes con el mercado europeo. Respondes en JSON válido y en español.";
  const user = `Genera un vuelo de ida y vuelta y un hotel realistas para esta reserva sorpresa:
- Origen: ${prefs.departureCity || "Madrid"}
- Aeropuerto destino: ${dest.gateway} (${dest.name}, ${dest.country})
- Fecha de salida: ${dateStr}
- Fecha de vuelta: ${returnDate}
- Noches: ${prefs.nights}
- Nivel de viaje elegido: ${stayInfo(prefs.stayTier).name} → ${stayInfo(prefs.stayTier).stayType} (${stayInfo(prefs.stayTier).stars}★)

Devuelve JSON EXACTO (el hotel DEBE ser coherente con el nivel/categoría indicado):
{"outbound":{"airline":"","flightNo":"","from":"","to":"","dep":"HH:MM","arr":"HH:MM","durationMin":0},
"inbound":{"airline":"","flightNo":"","from":"","to":"","dep":"HH:MM","arr":"HH:MM","durationMin":0},
"hotel":{"name":"","stars":4,"neighborhood":"","rating":"8.9"}}`;
  const out = await openaiJSON(system, user, { temperature: 0.8, timeoutMs: 20000 });
  if (out && out.outbound && out.inbound && out.hotel) {
    const stay = stayInfo(prefs.stayTier);
    out.hotel.stars = stay.stars; // categoría coherente con el nivel elegido
    out.hotel.stayType = stay.stayType;
    return out;
  }
  return fallbackFlightHotel(dest, prefs, dateStr);
}

// Adapta las actividades genéricas del tier a experiencias CONCRETAS del destino
// Y al perfil/edad del viajero (familia, pareja, amigos, solo), buscando con IA
// planes realistas para ese destino. El PRECIO de cada actividad se ajusta al
// TIPO de experiencia (un tour a pie cuesta menos que una privada de chef), pero
// la SUMA se mantiene cerca del valor de mercado original para no romper la
// economía del pack. Devuelve { items, valuePerPerson } (valor de mercado real).
async function aiActivities(dest, tier, prefs = {}) {
  const generic = tier.items || [];
  const baseValue = tier.valuePerPerson || generic.reduce((a, it) => a + priceOf(it), 0);
  if (!generic.length || !OPENAI_API_KEY) return { items: generic, valuePerPerson: baseValue };

  const vibes = (prefs.vibes || []).map((v) => v).join(", ") || "variados";
  const system =
    "Eres diseñador de experiencias de viaje. Adaptas actividades a un destino " +
    "concreto y al perfil del viajero de forma realista y evocadora, mencionando " +
    "lugares, platos o detalles típicos. Respondes SIEMPRE en JSON válido y en español.";
  const user = `Destino: ${dest.name}, ${dest.region}, ${dest.country}.
Viajero: ${profileLabel(prefs.profile)}${agesLabel(prefs) ? `, ${agesLabel(prefs)}` : ""}. Intereses: ${vibes}.
Reescribe cada actividad como una experiencia CONCRETA y realista en ${dest.name}, adaptada a ese perfil (p. ej. apta para niños si es familia, romántica si es pareja, animada si son amigos).
Reglas:
- Mantén EXACTAMENTE el mismo número de actividades y el mismo orden.
- Cada actividad termina con su precio de mercado por persona con el formato " · ≈XX €".
- Ajusta ese precio para que sea REALISTA según el TIPO de experiencia (un tour a pie cuesta menos que una experiencia privada con chef o un guía privado).
- La SUMA de los precios debe quedar cercana a ${Math.round(baseValue)} € (±20 %).
- Máximo ~90 caracteres por actividad (sin contar el precio).

Actividades base:
${generic.map((it, i) => `${i + 1}. ${it}`).join("\n")}

Devuelve JSON EXACTO: {"items":["... · ≈XX €", "..."]} con la misma cantidad y orden.`;
  const out = await openaiJSON(system, user, { temperature: 0.8, timeoutMs: 16000 });
  const items = out?.items;
  if (!Array.isArray(items) || items.length !== generic.length) {
    return { items: generic, valuePerPerson: baseValue };
  }
  // Si la IA perdió el sufijo de precio en algún item, recuperamos el original.
  const fixed = items.map((it, i) => {
    if (typeof it !== "string" || !it.trim()) return generic[i];
    if (/≈\s*\d/.test(it)) return it.slice(0, 140);
    const priceMatch = generic[i].match(/·\s*≈.*$/);
    return (priceMatch ? `${it.trim()} ${priceMatch[0]}` : it.trim()).slice(0, 140);
  });
  // Valor de mercado adaptado = suma de los precios de las experiencias propuestas.
  // Nunca por debajo del precio del pack (para que el "ahorras" no sea negativo).
  const sum = fixed.reduce((a, it) => a + priceOf(it), 0) || baseValue;
  const valuePerPerson = Math.max(round(sum), tier.pricePerPerson || 0, round(baseValue * 0.8));
  return { items: fixed, valuePerPerson };
}

function selectedTierFromBody(body = {}) {
  const tierId = body.tierId || body.tier?.id || "none";
  if (tierId === "none") {
    return { id: "none", name: "Solo vuelo + hotel", items: ["Sin actividades sorpresa"], perPersonCost: 0, pricePerPerson: 0, valuePerPerson: 0 };
  }
  const base = TIERS.find((t) => t.id === tierId) || TIERS[0];
  const incoming = body.tier && body.tier.id === tierId ? body.tier : null;
  const items = Array.isArray(incoming?.items) && incoming.items.length
    ? incoming.items.filter((it) => typeof it === "string").slice(0, 6)
    : base.items;
  const valuePerPerson = Number.isFinite(+incoming?.valuePerPerson)
    ? clamp(round(+incoming.valuePerPerson), 40, 1200)
    : Math.max(base.valuePerPerson || 0, items.reduce((a, it) => a + priceOf(it), 0));
  const pricePerPerson = Number.isFinite(+incoming?.pricePerPerson)
    ? clamp(round(+incoming.pricePerPerson), 20, 1000)
    : base.pricePerPerson;
  const perPersonCost = Number.isFinite(+incoming?.perPersonCost)
    ? clamp(round(+incoming.perPersonCost), 10, 900)
    : base.perPersonCost;
  return {
    id: base.id,
    name: base.name,
    tagline: String(incoming?.tagline || base.tagline).slice(0, 100),
    items,
    perPersonCost,
    pricePerPerson,
    valuePerPerson,
  };
}

app.post("/api/checkout", async (req, res) => {
  try {
    const body = req.body || {};
    const prefs = normalizePrefs(body.prefs || {});
    const dateStr = body.date;
    const tier = selectedTierFromBody(body);
    const picks = Array.isArray(body.destinations) ? body.destinations : [];

    if (!dateStr || !picks.length) {
      return res.status(400).json({ ok: false, error: "Faltan datos de la reserva" });
    }

    const travelers = prefs.travelers;
    const stayFactor = stayTierFactor(prefs.stayTier);
    const actCostPP = tier.perPersonCost || 0;
    const actPricePP = tier.id === "none" ? 0 : (tier.pricePerPerson ?? actCostPP);
    const activityChargedTotal = actPricePP * travelers;

    // TODO el pool ofertado (el ancla de precio se calcula sobre todos, descartados
    // incluidos, para que el precio no cambie ni revele nada al descartar).
    const poolDest = picks
      .filter(usableDest)
      .map((p) => ({ raw: p, dest: buildDestination(p, prefs) }));
    if (!poolDest.length) return res.status(400).json({ ok: false, error: "No hay destinos activos" });

    const pricedPool = await Promise.all(
      poolDest.map(async (x) => ({ ...x, price: await destProvider(x.dest, dateStr, prefs, stayFactor, { live: true }) }))
    );

    // Precio sorpresa = ancla sobre el pool completo + actividades.
    let chargedTotal = anchorCharged(pricedPool.map((x) => x.price.charged), activityChargedTotal);

    // Tarifa por cambiar destinos: 1 descarte gratis por viaje (máx. 1).
    const discards = clamp(parseInt(body.discards, 10) || 0, 0, 1);
    const swapFee = Math.max(0, discards - 1) * 10 * prefs.travelers;
    chargedTotal += swapFee;

    // Asignamos, entre los destinos ACTIVOS (no descartados), el de menor coste
    // real (mayor margen) — así opera el modelo sorpresa, sin alterar el precio.
    const activePriced = pricedPool.filter((x) => !x.raw.discarded);
    const pickFrom = activePriced.length ? activePriced : pricedPool;
    let best = null;
    for (const x of pickFrom) {
      if (!best || x.price.cost < best.price.cost) best = x;
    }

    const [fh, actData] = await Promise.all([
      aiFlightHotel(best.dest, prefs, dateStr),
      tier.id === "none"
        ? Promise.resolve({ items: tier.items, valuePerPerson: 0 })
        : aiActivities(best.dest, tier, prefs),
    ]);
    const tierItems = actData.items;
    // Valor de mercado de las experiencias adaptado al destino y al perfil.
    const valuePerPersonAdapted = tier.id === "none" ? 0 : actData.valuePerPerson;
    ensureImage(best.dest).catch(() => {});
    const heroImage = cachedGeneratedUrl(best.dest.id)
      || `/api/destimg?id=${encodeURIComponent(best.dest.id)}` +
         `&name=${encodeURIComponent(best.dest.name || "Destino")}` +
         `&kind=${encodeURIComponent(sceneKindFor(best.dest))}`;
    const costTotal = best.price.cost + actCostPP * travelers;
    const margin = chargedTotal - costTotal;
    const marginPct = chargedTotal > 0 ? margin / chargedTotal : 0;
    const breakdown = {
      cost: { ...best.price.components.cost, activity: round(actCostPP * travelers) },
      charged: { ...best.price.components.charged, activity: round(activityChargedTotal) },
    };

    // Margen que aportan SOLO las actividades: precio que asume el cliente
    // (pricePerPerson) frente a nuestro coste real (perPersonCost). El valor de
    // mercado (valuePerPerson) muestra cuánto ahorra el cliente vs reservarlo solo.
    const actValuePP = valuePerPersonAdapted || 0;
    const activities = tier.id === "none" ? null : {
      travelers,
      valuePerPerson: actValuePP,
      pricePerPerson: actPricePP,
      costPerPerson: actCostPP,
      marginPerPerson: actPricePP - actCostPP,
      marginPct: actPricePP ? Math.round(((actPricePP - actCostPP) / actPricePP) * 1000) / 10 : 0,
      savingPerPerson: Math.max(0, actValuePP - actPricePP),
      valueTotal: actValuePP * travelers,
      priceTotal: actPricePP * travelers,
      costTotal: actCostPP * travelers,
      marginTotal: (actPricePP - actCostPP) * travelers,
    };

    res.json({
      ok: true,
      booking: {
        date: dateStr,
        returnDate: addDays(dateStr, prefs.nights),
        nights: prefs.nights,
        travelers: prefs.travelers,
        departureCity: prefs.departureCity || "Madrid",
        tier: {
          id: tier.id, name: tier.name, items: tierItems,
          valuePerPerson: valuePerPersonAdapted,
          pricePerPerson: tier.id === "none" ? 0 : (tier.pricePerPerson ?? tier.perPersonCost),
          perPersonCost: tier.perPersonCost || 0,
        },
        stay: stayInfo(prefs.stayTier),
        destination: {
          name: best.dest.name, country: best.dest.country, region: best.dest.region,
          gateway: best.dest.gateway, isHiddenGem: best.dest.isHiddenGem,
          transfer: best.dest.transfer, image: { url: heroImage }, blurb: best.dest.blurb,
        },
        flightHotel: fh,
      },
      finance: {
        currency: PRICING.currency,
        chargedTotal,
        costTotal: round(costTotal),
        margin: round(margin),
        marginPct: Math.round(marginPct * 1000) / 10,
        breakdown,
        activities,
        swapFee,
        discards,
        live: pricedPool.some((x) => x.price.live),
      },
    });
  } catch (err) {
    console.error("/api/checkout failed", err);
    res.status(500).json({ ok: false, error: "No se pudo cerrar la reserva" });
  }
});

/* ------------------------------------------------------------------ */
/* Precio en firme para una fecha concreta (recalcula vuelo + hotel)  */
/* ------------------------------------------------------------------ */
app.post("/api/price", async (req, res) => {
  try {
    const body = req.body || {};
    const prefs = normalizePrefs(body.prefs || {});
    const dateStr = body.date;
    const tier = selectedTierFromBody(body);
    const picks = Array.isArray(body.destinations) ? body.destinations : [];
    if (!dateStr || !picks.length) {
      return res.status(400).json({ ok: false, error: "Faltan datos para el precio" });
    }
    const pool = picks.filter(usableDest).map((p) => buildDestination(p, prefs));
    if (!pool.length) return res.status(400).json({ ok: false, error: "No hay destinos activos" });

    const stayFactor = stayTierFactor(prefs.stayTier);
    const activityChargedTotal = (tier.pricePerPerson ?? tier.perPersonCost ?? 0) * prefs.travelers;

    // Ancla sobre el pool COMPLETO ofertado: el precio no cambia al descartar.
    const priced = await Promise.all(
      pool.map((d) => destProvider(d, dateStr, prefs, stayFactor, { live: true }))
    );
    let total = anchorCharged(priced.map((p) => p.charged), activityChargedTotal);

    const discards = clamp(parseInt(body.discards, 10) || 0, 0, 1);
    const swapFee = Math.max(0, discards - 1) * 10 * prefs.travelers;
    total += swapFee;

    res.json({
      ok: true,
      total,
      perPerson: Math.ceil((total / prefs.travelers) / 5) * 5,
      swapFee,
      live: priced.some((p) => p.live),
    });
  } catch (err) {
    console.error("/api/price failed", err);
    res.status(500).json({ ok: false, error: "No se pudo calcular el precio" });
  }
});

/* ------------------------------------------------------------------ */
function normalizePrefs(p) {
  const allowedVibes = ["beach", "culture", "nature", "food", "nightlife", "romantic"];
  const allowedStay = STAY_TIERS.map((t) => t.id);
  const allowedFood = ["local", "street", "fine", "wine", "beer", "markets", "cooking"];
  const vibes = Array.isArray(p.vibes)
    ? [...new Set(p.vibes.filter((v) => allowedVibes.includes(v)))].slice(0, 3)
    : [];
  const travelers = clamp(parseInt(p.travelers, 10) || 2, 1, 8);
  const rawAges = Array.isArray(p.ages) ? p.ages : [];
  const ages = Array.from({ length: travelers }, (_, i) => {
    const n = parseInt(rawAges[i], 10);
    return Number.isFinite(n) && n >= 0 ? clamp(n, 0, 99) : null;
  });
  const validAges = ages.filter((a) => Number.isFinite(a));
  const avgAge = validAges.length
    ? Math.round(validAges.reduce((a, b) => a + b, 0) / validAges.length)
    : (Number.isFinite(+p.age) && +p.age > 0 ? clamp(parseInt(p.age, 10), 1, 99) : null);

  const tripLength = ["weekend", "short", "medium", "long"].includes(p.tripLength) ? p.tripLength : "short";
  const tripRange = tripNightsRange(tripLength);
  const nights = clamp(parseInt(p.nights, 10) || tripRange.default, tripRange.min, tripRange.max);
  const days = nights + 1;

  const budgetTier = ["budget", "mid", "premium", "luxury"].includes(p.budgetTier) ? p.budgetTier : "mid";
  const explorerStyle = ["highlights", "hidden", "balanced"].includes(p.explorerStyle) ? p.explorerStyle : "balanced";
  const hiddenGems = explorerStyle !== "highlights" && p.hiddenGems !== false;

  const accommodation = ["hotel", "boutique", "resort", "apartment", "rural", "any"].includes(p.accommodation) ? p.accommodation : "any";
  const comfort = ["comfort", "balanced", "authentic"].includes(p.comfortLevel) ? p.comfortLevel : "balanced";
  const stayTier = resolveStayTier({ budgetTier, accommodation, comfortLevel: comfort, stayTier: p.stayTier });

  const foodInterests = Array.isArray(p.foodInterests)
    ? [...new Set(p.foodInterests.filter((f) => allowedFood.includes(f)))].slice(0, 7)
    : [];

  const budgetEstimate = BUDGET_ESTIMATE[budgetTier] ?? 550;
  const budget = Number.isFinite(+p.budget) && +p.budget > 0
    ? clamp(+p.budget, 50, 20000)
    : budgetEstimate;

  return {
    departureCity: typeof p.departureCity === "string" ? p.departureCity.slice(0, 60) : "Madrid",
    vibes,
    climate: ["warm", "temperate", "cool", "seasonal", "any"].includes(p.climate) ? p.climate : "any",
    pace: ["relax", "balanced", "adventure"].includes(p.pace) ? p.pace : "balanced",
    profile: ["solo", "pareja", "amigos", "familia"].includes(p.profile) ? p.profile : null,
    ages,
    age: avgAge,
    stayTier,
    travelers,
    tripLength,
    days,
    nights,
    budgetTier,
    budget,
    travelRange: ["short", "medium", "long", "anywhere"].includes(p.travelRange) ? p.travelRange : "medium",
    explorerStyle,
    hiddenGems,
    foodInterests,
    dietary: ["none", "vegetarian", "vegan", "glutenfree", "halal", "kosher"].includes(p.dietary) ? p.dietary : "none",
    accommodation,
    comfortLevel: comfort,
    discarded: Array.isArray(p.discarded) ? p.discarded.slice(0, 30) : [],
  };
}

// Placeholder de destino generado en el servidor: una ILUSTRACIÓN tipo postal
// (playa / montaña / ciudad según el destino), determinista (mismo nombre =>
// mismos colores). No lleva el nombre dentro (la tarjeta ya lo superpone). Se
// sirve localmente, así que carga siempre aunque la red bloquee CDNs externos.
function destImgSvg(name = "Destino", kind = "city") {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const a = Math.abs(h) % 360, b = (Math.abs(h) >> 3) % 360;
  const c1 = `hsl(${a} 62% 48%)`, c2 = `hsl(${b} 64% 15%)`, sun = `hsl(${(a + 28) % 360} 92% 72%)`;
  const dark = "rgba(0,0,0,0.24)", mid = "rgba(0,0,0,0.15)", snow = "rgba(255,255,255,0.85)";

  let scene;
  if (kind === "beach") {
    scene = `
    <circle cx="930" cy="235" r="98" fill="${sun}" opacity="0.92"/>
    <circle cx="930" cy="235" r="150" fill="${sun}" opacity="0.16"/>
    <path d="M0 560 Q 300 520 600 558 T 1200 556 L1200 800 0 800 Z" fill="${mid}"/>
    <path d="M0 642 Q 300 602 600 642 T 1200 640 L1200 800 0 800 Z" fill="${dark}"/>
    <path d="M0 720 Q 300 686 600 720 T 1200 718 L1200 800 0 800 Z" fill="rgba(255,255,255,0.10)"/>`;
  } else if (kind === "nature") {
    scene = `
    <circle cx="955" cy="205" r="80" fill="${sun}" opacity="0.88"/>
    <polygon points="90,800 470,360 850,800" fill="${dark}"/>
    <polygon points="470,360 528,432 412,432" fill="${snow}"/>
    <polygon points="520,800 905,415 1290,800" fill="${mid}"/>
    <polygon points="905,415 962,488 848,488" fill="${snow}"/>`;
  } else {
    scene = `
    <circle cx="955" cy="205" r="78" fill="${sun}" opacity="0.88"/>
    <g fill="${dark}">
      <rect x="110" y="520" width="92" height="280"/><rect x="222" y="448" width="80" height="352"/>
      <rect x="322" y="560" width="70" height="240"/><rect x="412" y="398" width="96" height="402"/>
      <rect x="528" y="500" width="80" height="300"/><rect x="628" y="560" width="72" height="240"/>
    </g>
    <g fill="${mid}">
      <rect x="724" y="470" width="92" height="330"/><rect x="836" y="540" width="76" height="260"/>
      <rect x="932" y="430" width="100" height="370"/><rect x="1052" y="520" width="86" height="280"/>
    </g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  ${scene}
  <text x="80" y="110" fill="#fff" opacity="0.55" font-family="Georgia,'Times New Roman',serif" font-size="24" letter-spacing="7">INCÓGNITO</text>
</svg>`;
}
const SCENE_KINDS = new Set(["beach", "nature", "city"]);
// Endpoint inteligente de imagen de destino:
//  - si la foto generada por IA ya está en caché => redirige a ella.
//  - si no => dispara la generación en segundo plano y devuelve YA el SVG
//    ilustrado, para que la tarjeta nunca quede sin imagen.
app.get("/api/destimg", (req, res) => {
  const id = String(req.query.id || "");
  const dest = destById(id);

  const cached = cachedGeneratedUrl(id);
  if (cached) return res.redirect(302, cached);

  if (dest) ensureImage(dest).catch(() => {});

  const name = dest ? dest.name : String(req.query.name || "Destino").slice(0, 40);
  const kind = dest ? sceneKindFor(dest) : (SCENE_KINDS.has(req.query.kind) ? req.query.kind : "city");
  res.set("Content-Type", "image/svg+xml; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(destImgSvg(name, kind));
});

// Estado de generación: devuelve qué destinos ya tienen foto IA lista (URL).
// El front lo consulta para sustituir el placeholder por la foto real.
app.get("/api/destimg/status", (req, res) => {
  const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
  const ready = {};
  for (const id of ids) {
    const url = cachedGeneratedUrl(id);
    if (url) ready[id] = url;
  }
  res.json({ ok: true, ready });
});

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  ai: !!OPENAI_API_KEY,
  model: OPENAI_MODEL,
  amadeus: amadeusEnabled(),
  unsplash: unsplashEnabled(),
  imagegen: imageGenEnabled(),
  imageStore: imageStoreInfo(),
}));

/* ------------------------------------------------------------------ */
/* Cuentas + programa de recompensas "Pasaporte Defy"                  */
/* ------------------------------------------------------------------ */
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    const out = await registerUser({ email, password, name });
    if (out.error) return res.status(400).json({ ok: false, error: out.error });
    setSessionCookie(res, out.token);
    res.json({ ok: true, user: out.user });
  } catch (err) {
    console.error("/api/auth/register failed", err);
    res.status(500).json({ ok: false, error: "No se pudo crear la cuenta" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const out = await loginUser({ email, password });
    if (out.error) return res.status(401).json({ ok: false, error: out.error });
    setSessionCookie(res, out.token);
    res.json({ ok: true, user: out.user });
  } catch (err) {
    console.error("/api/auth/login failed", err);
    res.status(500).json({ ok: false, error: "No se pudo iniciar sesión" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    if (req.sessionToken) await logout(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    console.error("/api/auth/logout failed", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/api/auth/me", (req, res) => {
  const user = userByToken(req.sessionToken);
  res.json({
    ok: true,
    user: user ? publicUser(user) : null,
    rewards: REWARDS_CATALOG,
    levels: LEVELS.map((l) => ({ id: l.id, name: l.name, icon: l.icon, minMiles: l.minMiles, multiplier: l.multiplier, perks: l.perks })),
  });
});

app.post("/api/rewards/redeem", async (req, res) => {
  try {
    if (!req.sessionToken) return res.status(401).json({ ok: false, error: "Inicia sesión para canjear." });
    const out = await redeemReward(req.sessionToken, (req.body || {}).rewardId);
    if (out.error) return res.status(400).json({ ok: false, error: out.error });
    res.json({ ok: true, voucher: out.voucher, user: out.user });
  } catch (err) {
    console.error("/api/rewards/redeem failed", err);
    res.status(500).json({ ok: false, error: "No se pudo canjear la recompensa" });
  }
});

// Otorga millas al confirmar una pre-reserva. Solo cuenta si hay sesión activa.
app.post("/api/rewards/earn", async (req, res) => {
  try {
    if (!req.sessionToken) return res.status(401).json({ ok: false, error: "Inicia sesión para sumar millas." });
    const { amount, destination, date } = req.body || {};
    const out = await awardTrip(req.sessionToken, { amount, destination, date });
    if (out.error) return res.status(400).json({ ok: false, error: out.error });
    res.json({ ok: true, earned: out.earned, leveledUp: out.leveledUp, user: out.user });
  } catch (err) {
    console.error("/api/rewards/earn failed", err);
    res.status(500).json({ ok: false, error: "No se pudieron sumar las millas" });
  }
});

// Página de cuenta / Pasaporte Defy (URL limpia)
app.get("/cuenta", (_req, res) => res.sendFile(path.join(__dirname, "public", "cuenta.html")));

// Página de reserva (URL limpia) servida como página independiente
app.get("/reservar", (_req, res) => res.sendFile(path.join(__dirname, "public", "reservar.html")));

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

Promise.all([initImageStore(), initAccounts()]).then(() => {
  app.listen(PORT, () => {
    const flag = (on) => (on ? "activa" : "off");
    const store = imageStoreInfo();
    console.log(
      `Incógnito en http://localhost:${PORT}  ` +
      `(IA: ${flag(!!OPENAI_API_KEY)} · Amadeus: ${flag(amadeusEnabled())} · Imágenes IA: ${flag(imageGenEnabled())}` +
      `${store.persistent ? " · caché persistente" : ""})`
    );
  });
}).catch((err) => {
  console.error("No se pudo inicializar la caché de imágenes:", err);
  process.exit(1);
});
