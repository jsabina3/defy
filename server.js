import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, CATALOG_BY_ID, WIKI_BY_ID, SEASONS, PRICING, TIERS, STAY_TIERS, stayTierFactor } from "./src/catalog.js";
import { amadeusEnabled, cheapestFlightPP, cheapestHotelNight } from "./src/amadeus.js";
import { unsplashEnabled, resolveImageUrl } from "./src/images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
// Los modelos GPT-5.x no admiten temperature personalizada y usan reasoning_effort.
const IS_GPT5 = /^gpt-5/.test(OPENAI_MODEL);

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

// Devuelve la ficha del nivel de viaje elegido (Cómodo / Boutique / Villa).
const stayInfo = (id) => {
  const t = STAY_TIERS.find((s) => s.id === id) || STAY_TIERS.find((s) => s.recommended) || STAY_TIERS[0];
  return { id: t.id, name: t.name, stars: t.stars, stayType: t.stayType, tagline: t.tagline };
};

/* ------------------------------------------------------------------ */
/* Selección de destinos                                              */
/* ------------------------------------------------------------------ */
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
    if (dest.climate === prefs.climate) score += 2;
    else if (prefs.climate === "warm" && dest.climate === "temperate") score += 1;
  }
  // ritmo
  if (prefs.pace === "relax" && (dest.tags.includes("nature") || dest.tags.includes("romantic"))) score += 1;
  if (prefs.pace === "adventure" && (dest.tags.includes("culture") || dest.tags.includes("nightlife"))) score += 1;
  // joyas escondidas
  if (dest.isHiddenGem) score += prefs.hiddenGems ? 2.5 : -100;
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
// ¿Encaja con el clima pedido? "any" no filtra. Permitimos adyacencias suaves
// (templado sirve para quien pide cálido o fresco) para no excluir de más.
function matchesClimate(dest, climate) {
  if (!climate || climate === "any") return true;
  if (dest.climate === climate) return true;
  if (dest.climate === "temperate" && (climate === "warm" || climate === "cool")) return true;
  return false;
}

// Selecciona SIEMPRE N destinos (por defecto 10). Los destinos DEBEN encajar con
// las preferencias del viajero: trabajamos por capas de exigencia, de la más
// estricta a la más laxa, y solo bajamos de capa cuando no hay suficientes
// destinos que cumplan (es decir, cuando las preferencias son incompatibles
// entre sí). Dentro de cada capa priorizamos una banda de precio comparable
// para que no haya destinos mucho más baratos que otros.
function selectDestinations(prefs, n = PRICING.destinationsShown) {
  const discarded = new Set(prefs.discarded || []);
  const origin = originCountryOf(prefs.departureCity);
  const stayFactor = stayTierFactor(prefs.stayTier);
  const vibes = prefs.vibes || [];
  const topVibe = vibes[0];

  const pool = CATALOG
    .filter((d) => !discarded.has(d.id))
    .filter((d) => (origin ? d.country !== origin : true))
    .filter((d) => (prefs.hiddenGems ? true : !d.isHiddenGem));

  const scored = pool
    .map((d) => ({ d, s: scoreDestination(d, prefs), ref: referenceCharged(d, prefs, stayFactor) }))
    .sort((a, b) => b.s - a.s);

  // Capas que SÍ encajan con las preferencias, de la más estricta a la más laxa:
  //  1) Interés PRINCIPAL (1ª prioridad) + clima.
  //  2) Cualquier interés marcado + clima.
  //  3) Cualquier interés marcado (clima relajado, p. ej. playa en clima fresco).
  // Todas exigen compartir al menos un interés: ningún destino de estas capas
  // "no matchea". Solo si entre las tres no llegamos al mínimo (preferencias muy
  // estrechas o incompatibles) recurrimos al comodín de relleno más abajo.
  const matchLayers = [
    scored.filter((x) => (!topVibe || x.d.tags.includes(topVibe)) && matchesClimate(x.d, prefs.climate)),
    scored.filter((x) => matchesVibes(x.d, vibes) && matchesClimate(x.d, prefs.climate)),
    scored.filter((x) => matchesVibes(x.d, vibes)),
  ];

  const chosen = [];
  const ids = new Set();
  const add = (x) => { if (!ids.has(x.d.id)) { chosen.push(x); ids.add(x.d.id); } };
  const fill = (layer, cap) => {
    if (!layer.length) return;
    // Dentro de la capa, primero los que caen en la banda de precio comparable.
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

  // Mostramos TODOS los destinos que encajan (hasta el tope), sin rellenar con
  // destinos que no encajen.
  for (const layer of matchLayers) {
    if (chosen.length >= n) break;
    fill(layer, n);
  }

  // Suelo de seguridad: si las preferencias dejan muy pocos destinos válidos,
  // completamos con los mejores aunque no encajen, para que la experiencia
  // (calendario, precio sorpresa, descartes) siga funcionando.
  const min = Math.min(PRICING.destinationsMin || 0, scored.length);
  if (chosen.length < min) fill(scored, min);

  return chosen.slice(0, n).map(({ d }) => ({ id: d.id, matchReason: null, flightPerPerson: null, hotelPerNight: null }));
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */
async function openaiJSON(system, user, { timeoutMs = 28000, temperature = 0.7 } = {}) {
  if (!OPENAI_API_KEY) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = {
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (IS_GPT5) payload.reasoning_effort = "low";
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

// La selección y el precio son deterministas (servidor = fuente de verdad). La
// IA solo personaliza el texto de "por qué encaja" de cada destino ya elegido,
// teniendo en cuenta el ORDEN de prioridad de los intereses del viajero.
async function aiMatchReasons(picks, prefs) {
  if (!OPENAI_API_KEY || !picks.length) return picks;
  const list = picks.map((p) => {
    const d = CATALOG_BY_ID[p.id];
    return { id: d.id, name: d.name, country: d.country, tags: d.tags, climate: d.climate, isHiddenGem: d.isHiddenGem };
  });
  const system =
    "Eres el motor de recomendación de una agencia de viajes sorpresa premium. " +
    "Escribes una frase breve y personalizada de por qué cada destino encaja con el viajero. " +
    "Respondes SIEMPRE en JSON válido y en español.";
  const vibesOrdered = (prefs.vibes || []).length
    ? (prefs.vibes || []).map((v, i) => `${i + 1}º ${v}`).join(", ")
    : "sin preferencias marcadas";
  const user = `Preferencias del viajero (intereses por ORDEN de prioridad, el 1º es el que más importa):
- Intereses: ${vibesOrdered}
- Clima: ${prefs.climate || "any"} · Ritmo: ${prefs.pace || "balanced"} · Nivel: ${prefs.stayTier || "boutique"}

Destinos ya seleccionados:
${JSON.stringify(list)}

Devuelve JSON EXACTO: {"reasons":{"<id>":"<frase personalizada, max 90 caracteres, en español>"}}
Para CADA id de la lista. Da más peso a la 1ª prioridad del viajero al justificar el encaje.`;
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
function buildDestination(pick, prefs) {
  const d = CATALOG_BY_ID[pick.id];
  const f = cityFactor(prefs.departureCity);
  const flightPerPerson = pick.flightPerPerson ?? round(d.baseFlight * f);
  const hotelPerNight = pick.hotelPerNight ?? d.baseHotelNight;
  return {
    id: d.id,
    name: d.name,
    country: d.country,
    region: d.region,
    gateway: d.gateway,
    isHiddenGem: d.isHiddenGem,
    transfer: d.transfer,
    tags: d.tags,
    blurb: d.blurb,
    image: d.image,
    matchReason: pick.matchReason || d.blurb,
    // costes base de proveedor (sin margen)
    flightPerPerson,
    hotelPerNight,
    transferCost: d.transferCost,
    seasonality: SEASONS[d.season],
    // de dónde sale el precio base ("amadeus" = real, null = estimado)
    flightSource: pick.flightSource || null,
    hotelSource: pick.hotelSource || null,
  };
}

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
      const d = CATALOG_BY_ID[p.id];
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
function placeholderFor(d) {
  return `/api/destimg?name=${encodeURIComponent(d.name)}&kind=${sceneKindFor(d)}`;
}

// Resuelve la mejor URL de imagen (Unsplash > Wikipedia > local) por destino y,
// si no hay foto externa disponible, cae en el placeholder local garantizado.
async function attachImages(destinations) {
  await Promise.allSettled(
    destinations.map(async (d) => {
      const url = await resolveImageUrl(d.image, `${d.name} ${d.country}`, WIKI_BY_ID[d.id]);
      d.image = { url: url || placeholderFor(d) };
    })
  );
}

app.post("/api/quote", async (req, res) => {
  try {
    const prefs = normalizePrefs(req.body || {});
    let picks = selectDestinations(prefs); // siempre 10, banda de precio comparable
    picks = await aiMatchReasons(picks, prefs);
    const usedAI = !!OPENAI_API_KEY;

    await enrichPrices(picks, prefs);
    const destinations = picks.map((p) => buildDestination(p, prefs));
    await attachImages(destinations);

    res.json({
      ok: true,
      source: usedAI ? "openai" : "fallback",
      providers: { amadeus: amadeusEnabled(), unsplash: unsplashEnabled() },
      currency: PRICING.currency,
      pricing: PRICING,
      tiers: TIERS,
      stayTiers: STAY_TIERS,
      prefs,
      destinations,
    });
  } catch (err) {
    console.error("/api/quote failed", err);
    res.status(500).json({ ok: false, error: "No se pudo generar la cotización" });
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
// (para que en la tarjeta de revelación el viajero se haga una idea real).
// Conserva el sufijo de precio "· ≈XX €". Si falla, devuelve las genéricas.
async function aiActivities(dest, tier) {
  const generic = tier.items || [];
  if (!generic.length || !OPENAI_API_KEY) return generic;
  const system =
    "Eres diseñador de experiencias de viaje. Adaptas actividades genéricas a un " +
    "destino concreto de forma realista y evocadora, mencionando lugares, platos o " +
    "detalles típicos. Respondes SIEMPRE en JSON válido y en español.";
  const user = `Destino: ${dest.name}, ${dest.region}, ${dest.country}.
Reescribe cada actividad como una experiencia CONCRETA y realista en ${dest.name}.
Reglas:
- Mantén EXACTAMENTE el mismo número de actividades y el mismo orden.
- Conserva tal cual el sufijo de precio que aparece al final (" · ≈XX €").
- Máximo ~90 caracteres por actividad (sin contar el precio).
- Nada de inventar precios nuevos ni cambiar los existentes.

Actividades genéricas:
${generic.map((it, i) => `${i + 1}. ${it}`).join("\n")}

Devuelve JSON EXACTO: {"items":["...", "..."]} con la misma cantidad y orden.`;
  const out = await openaiJSON(system, user, { temperature: 0.8, timeoutMs: 16000 });
  const items = out?.items;
  if (!Array.isArray(items) || items.length !== generic.length) return generic;
  // Si la IA perdió el sufijo de precio, recuperamos el del original.
  return items.map((it, i) => {
    if (typeof it !== "string" || !it.trim()) return generic[i];
    if (/≈\s*\d/.test(it)) return it.slice(0, 140);
    const priceMatch = generic[i].match(/·\s*≈.*$/);
    return (priceMatch ? `${it.trim()} ${priceMatch[0]}` : it.trim()).slice(0, 140);
  });
}

app.post("/api/checkout", async (req, res) => {
  try {
    const body = req.body || {};
    const prefs = normalizePrefs(body.prefs || {});
    const dateStr = body.date;
    const tierId = body.tierId || "esencia";
    const tier = tierId === "none"
      ? { id: "none", name: "Solo vuelo + hotel", items: ["Sin actividades sorpresa"], perPersonCost: 0 }
      : (TIERS.find((t) => t.id === tierId) || TIERS[0]);
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
      .filter((p) => CATALOG_BY_ID[p.id])
      .map((p) => ({ raw: p, dest: buildDestination(p, prefs) }));
    if (!poolDest.length) return res.status(400).json({ ok: false, error: "No hay destinos activos" });

    const pricedPool = await Promise.all(
      poolDest.map(async (x) => ({ ...x, price: await destProvider(x.dest, dateStr, prefs, stayFactor, { live: true }) }))
    );

    // Precio sorpresa = ancla sobre el pool completo + actividades.
    let chargedTotal = anchorCharged(pricedPool.map((x) => x.price.charged), activityChargedTotal);

    // Tarifa por cambiar destinos: 1º descarte gratis, 2º = 10 €/persona (máx. 2).
    const discards = clamp(parseInt(body.discards, 10) || 0, 0, 2);
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

    const [fh, tierItems] = await Promise.all([
      aiFlightHotel(best.dest, prefs, dateStr),
      tier.id === "none" ? Promise.resolve(tier.items) : aiActivities(best.dest, tier),
    ]);
    const heroImage = (await resolveImageUrl(best.dest.image, `${best.dest.name} ${best.dest.country}`, WIKI_BY_ID[best.dest.id])) || placeholderFor(best.dest);
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
    const actValuePP = tier.valuePerPerson || 0;
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
          valuePerPerson: tier.valuePerPerson,
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
    const tierId = body.tierId || "none";
    const tier = tierId === "none"
      ? { id: "none", perPersonCost: 0, pricePerPerson: 0 }
      : (TIERS.find((t) => t.id === tierId) || { perPersonCost: 0, pricePerPerson: 0 });
    const picks = Array.isArray(body.destinations) ? body.destinations : [];
    if (!dateStr || !picks.length) {
      return res.status(400).json({ ok: false, error: "Faltan datos para el precio" });
    }
    const pool = picks.filter((p) => CATALOG_BY_ID[p.id]).map((p) => buildDestination(p, prefs));
    if (!pool.length) return res.status(400).json({ ok: false, error: "No hay destinos activos" });

    const stayFactor = stayTierFactor(prefs.stayTier);
    const activityChargedTotal = (tier.pricePerPerson ?? tier.perPersonCost ?? 0) * prefs.travelers;

    // Ancla sobre el pool COMPLETO ofertado: el precio no cambia al descartar.
    const priced = await Promise.all(
      pool.map((d) => destProvider(d, dateStr, prefs, stayFactor, { live: true }))
    );
    let total = anchorCharged(priced.map((p) => p.charged), activityChargedTotal);

    const discards = clamp(parseInt(body.discards, 10) || 0, 0, 2);
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
  // vibes llegan YA en orden de prioridad (el 1º es el más importante);
  // conservamos ese orden y solo deduplicamos.
  const vibes = Array.isArray(p.vibes)
    ? [...new Set(p.vibes.filter((v) => allowedVibes.includes(v)))].slice(0, 6)
    : [];
  return {
    departureCity: typeof p.departureCity === "string" ? p.departureCity.slice(0, 60) : "Madrid",
    vibes,
    climate: ["warm", "temperate", "cool", "any"].includes(p.climate) ? p.climate : "any",
    pace: ["relax", "balanced", "adventure"].includes(p.pace) ? p.pace : "balanced",
    stayTier: allowedStay.includes(p.stayTier) ? p.stayTier : "boutique",
    travelers: clamp(parseInt(p.travelers, 10) || 2, 1, 8),
    nights: clamp(parseInt(p.nights, 10) || 2, 1, 6),
    budget: Number.isFinite(+p.budget) && +p.budget > 0 ? clamp(+p.budget, 150, 20000) : null,
    hiddenGems: p.hiddenGems !== false,
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
app.get("/api/destimg", (req, res) => {
  const name = String(req.query.name || "Destino").slice(0, 40);
  const kind = SCENE_KINDS.has(req.query.kind) ? req.query.kind : "city";
  res.set("Content-Type", "image/svg+xml; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(destImgSvg(name, kind));
});

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  ai: !!OPENAI_API_KEY,
  model: OPENAI_MODEL,
  amadeus: amadeusEnabled(),
  unsplash: unsplashEnabled(),
}));

// Página de reserva (URL limpia) servida como página independiente
app.get("/reservar", (_req, res) => res.sendFile(path.join(__dirname, "public", "reservar.html")));

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  const flag = (on) => (on ? "activa" : "off");
  console.log(
    `Incógnito en http://localhost:${PORT}  ` +
    `(IA: ${flag(!!OPENAI_API_KEY)} · Amadeus: ${flag(amadeusEnabled())} · Unsplash: ${flag(unsplashEnabled())})`
  );
});
