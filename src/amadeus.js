// Cliente mínimo de la API Amadeus Self-Service (vuelos + hoteles).
// Diseñado para "activar rápido": en cuanto hay credenciales en .env funciona,
// y si faltan (o el entorno de test no tiene datos para una ruta) devuelve null
// para que el servidor caiga con elegancia a sus estimaciones de siempre.
//
// Credenciales: https://developers.amadeus.com  (My Self-Service Workspace)
//   AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET, AMADEUS_ENV=test|production

import { iataFor } from "./catalog.js";

const ENV = (process.env.AMADEUS_ENV || "test").toLowerCase();
const BASE = ENV === "production"
  ? "https://api.amadeus.com"
  : "https://test.api.amadeus.com";
const CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;

export const amadeusEnabled = () => !!(CLIENT_ID && CLIENT_SECRET);

/* ------------------------------- Token OAuth2 ------------------------------ */
let tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (!amadeusEnabled()) return null;
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  try {
    const res = await fetch(`${BASE}/v1/security/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    if (!res.ok) {
      console.error("Amadeus token error", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    tokenCache = {
      token: data.access_token,
      exp: Date.now() + (data.expires_in || 1799) * 1000,
    };
    return tokenCache.token;
  } catch (err) {
    console.error("Amadeus token request failed:", err.message);
    return null;
  }
}

async function amadeusGET(pathAndQuery, timeoutMs = 9000) {
  const token = await getToken();
  if (!token) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("Amadeus GET error", res.status, pathAndQuery.split("?")[0]);
      return null;
    }
    return await res.json();
  } catch (err) {
    if (err.name !== "AbortError") console.error("Amadeus GET failed:", err.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* --------------------------------- Vuelos --------------------------------- */
// Cacheamos por ruta (origen-destino); incluso los null, para no reintentar en bucle.
const flightCache = new Map();

export async function cheapestFlightPP(originCity, destCity, departureDate, returnDate) {
  if (!amadeusEnabled()) return null;
  const origin = iataFor(originCity);
  const dest = iataFor(destCity);
  if (!origin || !dest || origin === dest) return null;

  const key = `${origin}-${dest}-${departureDate}-${returnDate}`;
  if (flightCache.has(key)) return flightCache.get(key);

  const q =
    `/v2/shopping/flight-offers?originLocationCode=${origin}` +
    `&destinationLocationCode=${dest}&departureDate=${departureDate}` +
    `&returnDate=${returnDate}&adults=1&currencyCode=EUR&max=20&nonStop=false`;
  const data = await amadeusGET(q, 9000);

  let price = null;
  const offers = data?.data || [];
  if (offers.length) {
    const prices = offers
      .map((o) => parseFloat(o?.price?.grandTotal ?? o?.price?.total))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length) price = Math.round(Math.min(...prices));
  }
  flightCache.set(key, price);
  return price;
}

/* --------------------------------- Hoteles -------------------------------- */
const hotelCache = new Map();

export async function cheapestHotelNight(destCity, checkInDate, checkOutDate) {
  if (!amadeusEnabled()) return null;
  const cityCode = iataFor(destCity);
  if (!cityCode) return null;
  const cacheKey = `${cityCode}-${checkInDate}-${checkOutDate}`;
  if (hotelCache.has(cacheKey)) return hotelCache.get(cacheKey);

  // 1) Lista de hoteles de la ciudad.
  const list = await amadeusGET(
    `/v1/reference-data/locations/hotels/by-city?cityCode=${cityCode}` +
      `&radius=25&radiusUnit=KM&hotelSource=ALL`,
    8000
  );
  const ids = (list?.data || [])
    .map((h) => h.hotelId)
    .filter(Boolean)
    .slice(0, 25);

  let perNight = null;
  if (ids.length) {
    // 2) Ofertas con precio para las fechas (la mejor tarifa por hotel).
    const offers = await amadeusGET(
      `/v3/shopping/hotel-offers?hotelIds=${ids.join(",")}` +
        `&checkInDate=${checkInDate}&checkOutDate=${checkOutDate}` +
        `&adults=2&roomQuantity=1&currency=EUR&bestRateOnly=true`,
      9000
    );
    const nights = Math.max(1, daysBetween(checkInDate, checkOutDate));
    const totals = (offers?.data || [])
      .map((d) => parseFloat(d?.offers?.[0]?.price?.total))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (totals.length) perNight = Math.round(Math.min(...totals) / nights);
  }
  hotelCache.set(cacheKey, perNight);
  return perNight;
}

function daysBetween(a, b) {
  const ms = new Date(b + "T12:00:00") - new Date(a + "T12:00:00");
  return Math.round(ms / 86_400_000);
}
