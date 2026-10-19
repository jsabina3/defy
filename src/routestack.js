// Cliente de RouteStack (MCP) para precios reales y referencias de inventario.
// Auth: POST /mcp/auth/partner-token con HMAC-SHA256 del API secret.
// Luego JSON-RPC en https://mcp.routestack.ai/mcp (Streamable HTTP).
// Si la red local intercepta TLS, se reintenta solo este host sin verificar
// el certificado. El resto de llamadas del servidor no se ven afectadas.
//
// Docs y ejemplos: https://github.com/RouteStackAI/routestack-starters

import crypto from "node:crypto";
import https from "node:https";
import { iataFor, registerIata } from "./catalog.js";

const API_KEY = process.env.ROUTESTACK_API_KEY || "";
const API_SECRET = process.env.ROUTESTACK_API_SECRET || "";
const MCP_URL = process.env.ROUTESTACK_MCP_URL || "https://mcp.routestack.ai/mcp";

export const routestackEnabled = () => !!(API_KEY && API_SECRET);

const QUOTE_TTL_MS = 30 * 60 * 1000;
const REF_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;

const memory = new Map();
const inflight = new Map();

function memo(key, ttlMs, fn) {
  const hit = memory.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const value = await fn();
    const ttl = value == null ? Math.min(ttlMs, MISS_TTL_MS) : ttlMs;
    memory.set(key, { value, exp: Date.now() + ttl });
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function strip(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o").replace(/å/g, "a").replace(/æ/g, "ae");
}

function ttlFromExpires(expiresIn) {
  if (typeof expiresIn === "number" && expiresIn > 0) return expiresIn * 1000;
  const m = String(expiresIn || "").trim().match(/^(\d+)\s*([dhms])?/i);
  if (!m) return 23 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = (m[2] || "s").toLowerCase();
  const mult = unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000;
  return n * mult;
}

/* --------------------------------- HTTP ---------------------------------- */
let tlsWarned = false;

function rawRequest(url, { method, headers, body, insecure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        rejectUnauthorized: !insecure,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 20_000_000) {
            req.destroy(new Error("respuesta RouteStack demasiado grande"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function isCertError(err) {
  const blob = `${err?.code || ""} ${err?.message || ""}`;
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(blob);
}

async function request(url, opts) {
  try {
    return await rawRequest(url, opts);
  } catch (err) {
    if (!opts.insecure && isCertError(err)) {
      if (!tlsWarned) {
        tlsWarned = true;
        console.warn("RouteStack: certificado no verificable en esta red; reintento solo contra el host MCP.");
      }
      return rawRequest(url, { ...opts, insecure: true });
    }
    throw err;
  }
}

function parseBody(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const events = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const joined = buf.join("\n").trim();
    if (joined && joined !== "[DONE]") events.push(joined);
    buf = [];
  };
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) buf.push(line.slice(5).trim());
    else if (line === "") flush();
  }
  flush();
  const last = events[events.length - 1];
  return last ? JSON.parse(last) : null;
}

/* --------------------------------- Auth ---------------------------------- */
let partnerToken = null;
let session = null;
let opening = null;

async function getPartnerToken() {
  if (partnerToken && Date.now() < partnerToken.exp - 5 * 60 * 1000) return partnerToken.token;
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const hmac = crypto.createHmac("sha256", API_SECRET).update(`${API_KEY}:${ts}:${nonce}`).digest("base64url");
  const tokenUrl = new URL("/mcp/auth/partner-token", MCP_URL);
  const res = await request(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ apiKey: API_KEY, hmac, timestamp: ts, nonce }),
    timeoutMs: 15000,
  });
  const data = parseBody(res.text);
  if (res.status < 200 || res.status >= 300 || !data?.token) {
    throw new Error(`partner-token ${res.status}`);
  }
  partnerToken = {
    token: data.token,
    exp: Date.now() + ttlFromExpires(data.expiresIn),
  };
  return partnerToken.token;
}

async function openSession() {
  const token = await getPartnerToken();
  const init = await request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "incognito", version: "1.0.0" },
      },
    }),
    timeoutMs: 20000,
  });
  const sessionId = init.headers["mcp-session-id"];
  if (init.status < 200 || init.status >= 300 || !sessionId) {
    throw new Error(`initialize ${init.status}`);
  }
  session = { id: Array.isArray(sessionId) ? sessionId[0] : sessionId, token };
  await request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-session-id": session.id,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    timeoutMs: 15000,
  }).catch(() => {});
  return session;
}

async function ensureSession() {
  if (session?.id && partnerToken && Date.now() < partnerToken.exp - 5 * 60 * 1000) return session;
  session = null;
  if (!opening) opening = openSession().finally(() => { opening = null; });
  return opening;
}

let rpcId = 10;

async function callTool(name, args, timeoutMs = 35000) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await ensureSession();
    try {
      const res = await request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${current.token}`,
          "mcp-session-id": current.id,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        timeoutMs,
      });
      if (res.status === 404 || res.status === 400) {
        throw new Error(`session ${res.status}`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`tools/call ${res.status}`);
      }
      const rpc = parseBody(res.text);
      if (rpc?.error) throw new Error(rpc.error.message || "MCP error");
      const result = rpc?.result;
      if (result?.isError) {
        const msg = (result.content || []).map((c) => c.text).filter(Boolean).join(" ").slice(0, 240);
        throw new Error(msg || "tool error");
      }
      const text = (result?.content || []).map((c) => c.text).filter(Boolean).join("\n");
      if (!text) return null;
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      session = null;
      if (attempt === 1 || !/session|timeout|ECONNRESET|fetch failed/i.test(err.message || "")) break;
    }
  }
  throw lastErr || new Error("tools/call failed");
}

function okPayload(data, label) {
  if (!data || data.success === false) {
    if (data?.message) console.error(`RouteStack ${label}: ${String(data.message).slice(0, 180)}`);
    return null;
  }
  return data;
}

/* ------------------------------ Referencias ------------------------------ */
function pickAirport(rows, term) {
  const list = Array.isArray(rows) ? rows : [];
  const t = strip(term);
  const code = String(term || "").trim().toUpperCase();
  return (
    list.find((r) => strip(r.city) === t) ||
    list.find((r) => String(r.code || "").toUpperCase() === code) ||
    list.find((r) => strip(r.fullname || r.name).includes(t)) ||
    list[0] ||
    null
  );
}

function pickDestination(rows, city) {
  const list = Array.isArray(rows) ? rows : [];
  const places = list.filter((r) => String(r.type || "City").toLowerCase() !== "hotel");
  const pool = places.length ? places : list;
  const t = strip(city);
  return (
    pool.find((r) => {
      const name = strip(r.fullName || r.city || "");
      return name === t || name.startsWith(`${t},`);
    }) || pool[0] || null
  );
}

async function airportRef(city) {
  const known = iataFor(city);
  if (known) return { code: known, city, name: city };
  return memo(`apt:${strip(city)}`, REF_TTL_MS, async () => {
    const data = okPayload(await callTool("flight_locations", { term: city }, 12000), "flight_locations");
    const row = pickAirport(data?.result, city);
    if (!row?.code) return null;
    registerIata(city, row.code);
    return { code: row.code, city: row.city || city, name: row.name || row.fullname || city };
  });
}

async function destinationRef(city) {
  return memo(`dest:${strip(city)}`, REF_TTL_MS, async () => {
    const data = okPayload(
      await callTool("hotel_search_destinations", { query: city, type: "DESTINATION" }, 12000),
      "hotel_search_destinations"
    );
    const row = pickDestination(data?.result, city);
    if (!row?.id) return null;
    return {
      id: row.id,
      name: row.fullName || city,
      type: row.type || "City",
      lat: row.coordinates?.lat ?? row.lat ?? null,
      long: row.coordinates?.long ?? row.coordinates?.lng ?? row.long ?? null,
    };
  });
}

/* -------------------------------- Precios -------------------------------- */
function toEur(amount, currency, rate) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cur = String(currency || "EUR").toUpperCase();
  if (cur === "EUR") return Math.round(n * 100) / 100;
  const r = Number(rate);
  if (cur === "USD" && r > 0.7 && r < 1.5) return Math.round((n / r) * 100) / 100;
  return Math.round(n * 100) / 100;
}

function hhmm(iso) {
  const m = String(iso || "").match(/T(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

function summarizeLeg(segments) {
  if (!segments?.length) return null;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const durationMin = segments.reduce((sum, seg) => sum + (Number(seg.triptime) || 0), 0);
  return {
    airline: first.airline || "",
    flightNo: segments.map((seg) => `${seg.flightCode || ""}${seg.flightNumber || ""}`).filter(Boolean).join(" / "),
    from: first.departurelocation || first.departure || "",
    to: last.arrivallocation || last.arrival || "",
    fromCode: first.departure || "",
    toCode: last.arrival || "",
    fromAirport: first.departairport || "",
    toAirport: last.arrivalairport || "",
    dep: hhmm(first.departureTime),
    arr: hhmm(last.arrivalTime),
    durationMin,
    stops: Math.max(0, segments.length - 1),
  };
}

function cheapestFlight(data, adults) {
  const payload = okPayload(data, "flight_search");
  const offers = Array.isArray(payload?.result) ? payload.result : [];
  let best = null;
  for (const offer of offers) {
    const total = toEur(offer.ourprice ?? offer.showOurprice ?? offer.totalFare, payload.currency, payload.currencyrate);
    if (total == null) continue;
    if (!best || total < best.total) best = { total, offer };
  }
  if (!best) return null;
  const flights = best.offer.flights || [];
  const outboundSegs = flights.filter((f) => f.legindicator === 0);
  const inboundSegs = flights.filter((f) => f.legindicator === 1);
  const pax = Math.max(1, adults);
  return {
    total: best.total,
    perPerson: Math.round((best.total / pax) * 100) / 100,
    correlationId: payload.correlationId || null,
    outbound: summarizeLeg(outboundSegs.length ? outboundSegs : flights),
    inbound: summarizeLeg(inboundSegs),
  };
}

function hotelList(payload) {
  if (Array.isArray(payload?.result?.result)) return payload.result.result;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
}

function chooseHotel(list, { stars, strict, currency, rate }) {
  const priced = [];
  for (const hotel of list) {
    const total = toEur(hotel.ourprice || hotel.publishedRate, currency, rate);
    if (total == null) continue;
    const hotelStars = Number(hotel.starRating);
    const km = Number(hotel.distancekm);
    priced.push({
      total,
      stars: Number.isFinite(hotelStars) ? hotelStars : 0,
      km: Number.isFinite(km) ? km : null,
      hotel,
    });
  }
  if (!priced.length) return null;

  let pool = priced;
  if (stars) {
    const exact = priced.filter((h) => Math.round(h.stars) === stars);
    if (exact.length) pool = exact;
    else if (strict) return null;
    else {
      const nearest = Math.min(...priced.map((h) => Math.abs(Math.round(h.stars) - stars)));
      pool = priced.filter((h) => Math.abs(Math.round(h.stars) - stars) === nearest);
    }
  }

  const central = pool.filter((h) => h.km == null || h.km <= 12);
  const pickFrom = central.length ? central : pool;
  pickFrom.sort((a, b) => a.total - b.total);
  return pickFrom[0];
}

function cheapestHotel(data, { nights, stars, strict = false }) {
  const payload = okPayload(data, "hotel_search");
  if (!payload) return null;
  const currency = payload.result?.currency || payload.currency;
  const rate = payload.currencyrate;
  const best = chooseHotel(hotelList(payload), { stars, strict, currency, rate });
  if (!best) return null;
  const nightCount = Math.max(1, nights);
  const km = best.km;
  return {
    total: best.total,
    perNight: Math.round((best.total / nightCount) * 100) / 100,
    id: best.hotel.id ? String(best.hotel.id) : null,
    name: best.hotel.name || "",
    stars: best.stars || stars || null,
    neighborhood: Number.isFinite(km) ? `a ${km.toFixed(1)} km del centro` : "",
    correlationId: payload.result?.correlationId || payload.correlationId || null,
  };
}

function roomPlan(travelers, peoplePerRoom) {
  const pax = Math.max(1, travelers);
  const per = Math.max(1, peoplePerRoom || 2);
  const roomCount = Math.max(1, Math.ceil(pax / per));
  const base = Math.floor(pax / roomCount);
  const extra = pax % roomCount;
  const rooms = Array.from({ length: roomCount }, (_, i) => ({ adults: base + (i < extra ? 1 : 0) }));
  return { roomCount, rooms, adults: rooms[0].adults };
}

async function searchFlight(originCode, destCode, input, adults) {
  const data = await callTool("flight_search", {
    filter: {
      origin: originCode,
      destination: destCode,
      departureDate: input.departureDate,
      returnDate: input.returnDate,
      adults,
      cabinClass: "Economy",
      type: "RoundTrip",
    },
  }, 40000);
  return cheapestFlight(data, adults);
}

async function searchHotel(city, destRow, input, plan, stars) {
  const args = {
    destination: destRow?.name || city,
    checkIn: input.departureDate,
    checkOut: input.returnDate,
    roomCount: plan.roomCount,
    adults: plan.adults,
    rooms: plan.rooms,
    currency: "EUR",
    limit: 50,
  };
  if (destRow?.id) args.destinationId = destRow.id;
  if (destRow?.type) args.destinationType = destRow.type;
  if (Number.isFinite(destRow?.lat) && Number.isFinite(destRow?.long)) {
    args.lat = destRow.lat;
    args.long = destRow.long;
  }
  if (stars) args.filters = { star_rating: [stars] };
  let found = cheapestHotel(
    await callTool("hotel_search", args, 25000),
    { nights: input.nights, stars, strict: true }
  );
  if (!found && stars) {
    delete args.filters;
    found = cheapestHotel(await callTool("hotel_search", args, 25000), { nights: input.nights, stars, strict: false });
  }
  return found;
}

// Cotización de una estancia. party "reference" busca 1 adulto y 1 habitación
// (precio base para el calendario). party "actual" usa los viajeros reales.
export async function stayQuote(input) {
  if (!routestackEnabled()) return null;
  const originCity = input.originCity || "Madrid";
  const destinationCity = input.destinationCity;
  if (!destinationCity || !input.departureDate || !input.returnDate) return null;
  const party = input.party === "actual" ? "actual" : "reference";
  const travelers = Math.max(1, Number(input.travelers) || 1);
  const nights = Math.max(1, Number(input.nights) || 1);
  const stars = Number(input.stars) || null;
  const key = [
    party, strip(originCity), strip(destinationCity), input.departureDate, input.returnDate,
    party === "actual" ? travelers : 1, stars || 0,
  ].join("|");

  return memo(key, QUOTE_TTL_MS, async () => {
    try {
      const [origin, destination, destRow] = await Promise.all([
        airportRef(originCity),
        airportRef(destinationCity),
        destinationRef(destinationCity),
      ]);
      const originCode = origin?.code || originCity;
      const destCode = destination?.code || destinationCity;
      if (strip(originCode) === strip(destCode)) return null;

      const flightAdults = party === "actual" ? travelers : 1;
      const plan = party === "actual"
        ? roomPlan(travelers, input.peoplePerRoom)
        : { roomCount: 1, rooms: [{ adults: 2 }], adults: 2 };

      const [flight, hotel] = await Promise.all([
        searchFlight(originCode, destCode, input, flightAdults).catch((err) => {
          console.error("RouteStack flight:", err.message);
          return null;
        }),
        searchHotel(destinationCity, destRow, { ...input, nights }, plan, stars).catch((err) => {
          console.error("RouteStack hotel:", err.message);
          return null;
        }),
      ]);
      if (!flight && !hotel) return null;

      return {
        flightTotal: flight ? (party === "actual" ? flight.total : null) : null,
        flightPerPerson: flight?.perPerson ?? null,
        hotelTotal: hotel ? (party === "actual" ? hotel.total : null) : null,
        hotelPerNight: hotel?.perNight ?? null,
        outbound: flight?.outbound || null,
        inbound: flight?.inbound || null,
        hotel: hotel
          ? {
            id: hotel.id,
            name: hotel.name,
            stars: hotel.stars,
            neighborhood: hotel.neighborhood,
          }
          : null,
        references: {
          provider: "routestack",
          originAirport: origin?.code || flight?.outbound?.fromCode || null,
          destinationAirport: destination?.code || flight?.outbound?.toCode || null,
          originAirportName: flight?.outbound?.fromAirport || origin?.name || null,
          destinationAirportName: flight?.outbound?.toAirport || destination?.name || null,
          destinationId: destRow?.id || null,
          destinationName: destRow?.name || destinationCity,
          flightCorrelationId: flight?.correlationId || null,
          hotelId: hotel?.id || null,
          hotelCorrelationId: hotel?.correlationId || null,
        },
      };
    } catch (err) {
      console.error("RouteStack quote:", err.message);
      return null;
    }
  });
}
