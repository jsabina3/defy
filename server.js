import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, CATALOG_BY_ID, SEASONS, PRICING, TIERS } from "./src/catalog.js";
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
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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

/* ------------------------------------------------------------------ */
/* Selección de destinos (fallback determinista)                      */
/* ------------------------------------------------------------------ */
function scoreDestination(dest, prefs) {
  let score = 0;
  const vibes = prefs.vibes || [];
  for (const v of vibes) if (dest.tags.includes(v)) score += 3;
  // clima
  if (prefs.climate && prefs.climate !== "any") {
    if (dest.climate === prefs.climate) score += 2;
    else if (prefs.climate === "warm" && dest.climate === "temperate") score += 1;
  }
  // ritmo: relax favorece naturaleza/romántico/playa, aventura cultura/nature/nightlife
  if (prefs.pace === "relax" && (dest.tags.includes("nature") || dest.tags.includes("romantic"))) score += 1;
  if (prefs.pace === "adventure" && (dest.tags.includes("culture") || dest.tags.includes("nightlife"))) score += 1;
  // joyas escondidas
  if (dest.isHiddenGem) score += prefs.hiddenGems ? 2.5 : -100;
  // presupuesto: ahora es TOTAL del paquete (todos los viajeros y noches)
  if (prefs.budget) {
    const t = prefs.travelers || 2;
    const n = prefs.nights || 2;
    const approxTotal =
      dest.baseFlight * t +
      dest.baseHotelNight * n * Math.ceil(t / 2) +
      (dest.isHiddenGem ? dest.transferCost * t : 0);
    if (approxTotal > prefs.budget * 1.25) score -= 3;
    else if (approxTotal <= prefs.budget) score += 1.5;
  }
  return score + Math.random() * 0.4; // pequeño desempate
}

function selectFallback(prefs, n = 7) {
  const discarded = new Set(prefs.discarded || []);
  const origin = originCountryOf(prefs.departureCity);
  return CATALOG
    .filter((d) => !discarded.has(d.id))
    .filter((d) => (origin ? d.country !== origin : true))
    .filter((d) => (prefs.hiddenGems ? true : !d.isHiddenGem))
    .map((d) => ({ d, s: scoreDestination(d, prefs) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(({ d }) => ({ id: d.id, matchReason: null, flightPerPerson: null, hotelPerNight: null }));
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

async function aiSelectDestinations(prefs) {
  const discarded = new Set(prefs.discarded || []);
  const origin = originCountryOf(prefs.departureCity);
  const candidates = CATALOG
    .filter((d) => !discarded.has(d.id))
    .filter((d) => (origin ? d.country !== origin : true))
    .filter((d) => (prefs.hiddenGems ? true : !d.isHiddenGem))
    .map((d) => ({
      id: d.id, name: d.name, country: d.country, gateway: d.gateway,
      isHiddenGem: d.isHiddenGem, tags: d.tags, climate: d.climate,
      baseFlight: d.baseFlight, baseHotelNight: d.baseHotelNight,
    }));

  const system =
    "Eres el motor de recomendación de una agencia de viajes sorpresa premium. " +
    "Seleccionas destinos y estimas precios realistas de mercado en EUR. " +
    "Respondes SIEMPRE en JSON válido y en español.";

  const user = `Preferencias del viajero:
- Ciudad de salida: ${prefs.departureCity || "Madrid"}
- Intereses (vibes): ${(prefs.vibes || []).join(", ") || "ninguno"}
- Clima preferido: ${prefs.climate || "any"}
- Ritmo: ${prefs.pace || "balanced"}
- Viajeros: ${prefs.travelers || 2}
- Noches: ${prefs.nights || 2}
- Presupuesto TOTAL del paquete (todos los viajeros y noches, EUR): ${prefs.budget || "flexible"}
- Abierto a joyas escondidas (volar + 1-2h en coche/tren/bus): ${prefs.hiddenGems ? "SÍ" : "NO"}
${origin ? `- País de origen: ${origin}. NO propongas destinos dentro de ${origin}.` : ""}

Candidatos (elige y ordena de mejor a peor encaje):
${JSON.stringify(candidates)}

Devuelve JSON EXACTO con esta forma:
{"picks":[{"id":"<id del candidato>","matchReason":"<1 frase en español, personalizada, max 90 caracteres>","flightPerPerson":<entero EUR ida y vuelta económica desde la ciudad de salida hasta el aeropuerto del destino>,"hotelPerNight":<entero EUR habitación doble céntrica 3-4*>}]}
Reglas: elige entre 6 y 8 destinos; usa SOLO ids de la lista; precios realistas 2026; si el viajero NO quiere joyas escondidas no incluyas ninguna; prioriza el encaje con vibes y clima.`;

  const out = await openaiJSON(system, user);
  if (!out || !Array.isArray(out.picks)) return null;
  const picks = out.picks
    .filter((p) => p && CATALOG_BY_ID[p.id] && !discarded.has(p.id))
    .filter((p) => (origin ? CATALOG_BY_ID[p.id].country !== origin : true))
    .filter((p) => (prefs.hiddenGems ? true : !CATALOG_BY_ID[p.id].isHiddenGem))
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      matchReason: typeof p.matchReason === "string" ? p.matchReason.slice(0, 120) : null,
      flightPerPerson: Number.isFinite(p.flightPerPerson) ? clamp(p.flightPerPerson, 40, 600) : null,
      hotelPerNight: Number.isFinite(p.hotelPerNight) ? clamp(p.hotelPerNight, 50, 600) : null,
    }));
  return picks.length ? picks : null;
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

// Resuelve la mejor URL de imagen (local > Unsplash > LoremFlickr) por destino.
async function attachImages(destinations) {
  await Promise.allSettled(
    destinations.map(async (d) => {
      const url = await resolveImageUrl(d.image, `${d.name} ${d.country}`);
      d.image = { url };
    })
  );
}

app.post("/api/quote", async (req, res) => {
  try {
    const prefs = normalizePrefs(req.body || {});
    let picks = await aiSelectDestinations(prefs);
    let usedAI = !!picks;
    if (!picks) picks = selectFallback(prefs);

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

async function priceForDestination(dest, dateStr, prefs, tier, { live = false } = {}) {
  const m = monthIndex(dateStr);
  const season = dest.seasonality[m];
  const weekend = isWeekend(dateStr) ? 1 + PRICING.weekendPremium : 1;
  const nights = prefs.nights;
  const travelers = prefs.travelers;
  const rooms = Math.ceil(travelers / PRICING.peoplePerRoom);

  // En modo "live" consultamos Amadeus para LAS FECHAS EXACTAS elegidas. Si hay
  // precio real, no aplicamos estacionalidad/finde (el precio real ya refleja la
  // demanda de esas fechas); si no, caemos al modelo base × estacionalidad.
  let realFlightPP = null, realHotelNight = null;
  if (live && amadeusEnabled()) {
    const ret = addDays(dateStr, nights);
    [realFlightPP, realHotelNight] = await Promise.all([
      cheapestFlightPP(prefs.departureCity || "Madrid", dest.gateway, dateStr, ret),
      cheapestHotelNight(dest.gateway, dateStr, ret),
    ]);
  }

  // costes de proveedor (sin margen)
  const flightCost = Number.isFinite(realFlightPP)
    ? realFlightPP * travelers
    : dest.flightPerPerson * season * weekend * travelers;
  const hotelCost = Number.isFinite(realHotelNight)
    ? realHotelNight * nights * rooms
    : dest.hotelPerNight * season * nights * rooms;
  const transferCost = dest.transferCost * travelers;
  const activityCost = (tier?.perPersonCost || 0) * travelers;

  // precio cobrado (con markup por componente)
  const flightCharged = flightCost * PRICING.markups.flight;
  const hotelCharged = hotelCost * PRICING.markups.hotel;
  const transferCharged = transferCost * PRICING.markups.transfer;
  // actividades: precio redondo por persona fijado en el tier (margen = precio - coste)
  const activityCharged = (tier?.pricePerPerson ?? (tier?.perPersonCost || 0)) * travelers;

  const cost = flightCost + hotelCost + transferCost + activityCost;
  const charged = flightCharged + hotelCharged + transferCharged + activityCharged;

  return {
    cost: round(cost),
    charged: round(charged),
    live: Number.isFinite(realFlightPP) || Number.isFinite(realHotelNight),
    components: {
      cost: { flight: round(flightCost), hotel: round(hotelCost), transfer: round(transferCost), activity: round(activityCost) },
      charged: { flight: round(flightCharged), hotel: round(hotelCharged), transfer: round(transferCharged), activity: round(activityCharged) },
    },
  };
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
  const adjs = ["Boutique", "Grand", "Casa", "Palazzo", "Suites", "Maison"];
  const stars = dest.hotelPerNight > 200 ? 5 : dest.hotelPerNight > 150 ? 4 : 3;
  return {
    outbound: { airline, flightNo, from: prefs.departureCity || "Madrid", to: dest.gateway, dep: `${pad(depH)}:00`, arr: addMinutes(depH, 0, dur), durationMin: dur },
    inbound: { airline, flightNo: retNo, from: dest.gateway, to: prefs.departureCity || "Madrid", dep: `${pad(retH)}:30`, arr: addMinutes(retH, 30, dur), durationMin: dur },
    hotel: {
      name: `${adjs[h % adjs.length]} ${dest.name.split(" ").slice(-1)[0]} ${h % 2 ? "Resort" : "Hotel"}`,
      stars,
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
- Categoría hotel orientativa: ${dest.hotelPerNight > 200 ? "5*" : dest.hotelPerNight > 150 ? "4*" : "3-4*"}

Devuelve JSON EXACTO:
{"outbound":{"airline":"","flightNo":"","from":"","to":"","dep":"HH:MM","arr":"HH:MM","durationMin":0},
"inbound":{"airline":"","flightNo":"","from":"","to":"","dep":"HH:MM","arr":"HH:MM","durationMin":0},
"hotel":{"name":"","stars":4,"neighborhood":"","rating":"8.9"}}`;
  const out = await openaiJSON(system, user, { temperature: 0.8, timeoutMs: 20000 });
  if (out && out.outbound && out.inbound && out.hotel) return out;
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

    // Reconstruimos los destinos activos
    const active = picks
      .filter((p) => CATALOG_BY_ID[p.id])
      .map((p) => buildDestination(p, prefs));
    if (!active.length) return res.status(400).json({ ok: false, error: "No hay destinos activos" });

    // Recalculamos precios EN FIRME para las fechas exactas (Amadeus si está activo).
    const priced = await Promise.all(
      active.map(async (d) => ({ dest: d, price: await priceForDestination(d, dateStr, prefs, tier, { live: true }) }))
    );

    // Precio cobrado = precio sorpresa = mediana de lo cobrado entre destinos activos
    // Se redondea SIEMPRE hacia arriba al múltiplo de 10 más cercano (precio "redondo").
    const chargedList = priced.map((x) => x.price.charged);
    let chargedTotal = Math.ceil(median(chargedList) / 10) * 10;

    // Tarifa por cambiar destinos: 1º descarte gratis, 2º = 10 €/persona (máx. 2).
    const discards = clamp(parseInt(body.discards, 10) || 0, 0, 2);
    const swapFee = Math.max(0, discards - 1) * 10 * prefs.travelers;
    chargedTotal += swapFee;

    // Asignamos el destino que maximiza margen (menor coste real) — así opera el modelo sorpresa
    let best = null;
    for (const x of priced) {
      if (!best || x.price.cost < best.price.cost) best = x;
    }

    const [fh, tierItems] = await Promise.all([
      aiFlightHotel(best.dest, prefs, dateStr),
      tier.id === "none" ? Promise.resolve(tier.items) : aiActivities(best.dest, tier),
    ]);
    const heroImage = await resolveImageUrl(best.dest.image, `${best.dest.name} ${best.dest.country}`);
    const margin = chargedTotal - best.price.cost;
    const marginPct = chargedTotal > 0 ? margin / chargedTotal : 0;

    // Margen que aportan SOLO las actividades: precio que asume el cliente
    // (pricePerPerson) frente a nuestro coste real (perPersonCost). El valor de
    // mercado (valuePerPerson) muestra cuánto ahorra el cliente vs reservarlo solo.
    const travelers = prefs.travelers;
    const actCostPP = tier.perPersonCost || 0;
    const actPricePP = tier.id === "none" ? 0 : (tier.pricePerPerson ?? actCostPP);
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
        costTotal: best.price.cost,
        margin: round(margin),
        marginPct: Math.round(marginPct * 1000) / 10,
        breakdown: best.price.components,
        activities,
        swapFee,
        discards,
        live: priced.some((x) => x.price.live),
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
    const active = picks.filter((p) => CATALOG_BY_ID[p.id]).map((p) => buildDestination(p, prefs));
    if (!active.length) return res.status(400).json({ ok: false, error: "No hay destinos activos" });

    const priced = await Promise.all(
      active.map((d) => priceForDestination(d, dateStr, prefs, tier, { live: true }))
    );
    let total = Math.ceil(median(priced.map((p) => p.charged)) / 10) * 10;

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
  return {
    departureCity: typeof p.departureCity === "string" ? p.departureCity.slice(0, 60) : "Madrid",
    vibes: Array.isArray(p.vibes) ? p.vibes.filter((v) => allowedVibes.includes(v)).slice(0, 6) : [],
    climate: ["warm", "temperate", "cool", "any"].includes(p.climate) ? p.climate : "any",
    pace: ["relax", "balanced", "adventure"].includes(p.pace) ? p.pace : "balanced",
    travelers: clamp(parseInt(p.travelers, 10) || 2, 1, 8),
    nights: clamp(parseInt(p.nights, 10) || 2, 1, 6),
    budget: Number.isFinite(+p.budget) && +p.budget > 0 ? clamp(+p.budget, 150, 20000) : null,
    hiddenGems: p.hiddenGems !== false,
    discarded: Array.isArray(p.discarded) ? p.discarded.slice(0, 30) : [],
  };
}

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
