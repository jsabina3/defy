// Sistema de cuentas + programa de recompensas "Pasaporte Defy".
//
// Sin base de datos ni dependencias externas: persistimos las cuentas en un
// único fichero JSON (data/accounts.json por defecto) y usamos solo módulos
// nativos de Node (crypto para hashing scrypt y tokens de sesión). Pensado para
// escala pequeña/demo; toda la operativa de lectura es en memoria y las
// escrituras se serializan para evitar corrupción del fichero.
//
// Persistencia en Railway: define ACCOUNTS_DIR apuntando a un volumen (NO uses
// la carpeta public/assets/gen del volumen de imágenes: ese contenido se sirve
// por HTTP y expondría las cuentas). Si no hay volumen, el fichero vive en
// ./data y es efímero entre deploys.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  if (process.env.ACCOUNTS_DIR) return path.resolve(process.env.ACCOUNTS_DIR);
  return path.join(__dirname, "..", "data");
}
const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, "accounts.json");

/* ------------------------------------------------------------------ */
/* Programa de recompensas: niveles, ganancia y catálogo de canje      */
/* ------------------------------------------------------------------ */
// Filosofía (alineada con buenas prácticas de loyalty 2026): progreso visible,
// pocos niveles claros, "quick win" de bienvenida, recompensas sorpresa (que
// encajan con la marca de viajes sorpresa), reglas transparentes y canje simple.
//
//  - Ganas 1 milla por cada 1 € de valor del viaje pre-reservado.
//  - El NIVEL depende de las millas GANADAS de por vida (milesEarned), no del
//    saldo: canjear recompensas nunca te baja de nivel.
//  - El SALDO (miles) es lo que puedes canjear en el catálogo.

export const WELCOME_BONUS = 500;          // millas de bienvenida (quick win)
export const MILES_PER_EURO = 1;           // millas por € de viaje
export const REFERRAL_BONUS = 750;         // millas por invitar a alguien (futuro)

// Niveles como un arco narrativo: curiosidad → competencia → estatus → maestría.
export const LEVELS = [
  {
    id: "curioso",
    name: "Curioso",
    icon: "🧭",
    minMiles: 0,
    multiplier: 1.0,
    freeDiscards: 1,
    perks: [
      "500 millas de bienvenida",
      "1 descarte de destino gratis por viaje",
      "Calendario de precios reales por fecha",
    ],
  },
  {
    id: "explorador",
    name: "Explorador",
    icon: "🗺️",
    minMiles: 1500,
    multiplier: 1.05,
    freeDiscards: 2,
    perks: [
      "+5 % de millas en cada viaje",
      "2 descartes de destino gratis",
      "Acceso anticipado a nuevos destinos",
    ],
  },
  {
    id: "aventurero",
    name: "Aventurero",
    icon: "⛰️",
    minMiles: 5000,
    multiplier: 1.1,
    freeDiscards: 2,
    perks: [
      "+10 % de millas en cada viaje",
      "Upgrade de alojamiento sorpresa ocasional",
      "Atención prioritaria 24/7 en destino",
    ],
  },
  {
    id: "leyenda",
    name: "Leyenda",
    icon: "👑",
    minMiles: 12000,
    multiplier: 1.15,
    freeDiscards: 3,
    perks: [
      "+15 % de millas en cada viaje",
      "Una experiencia sorpresa de regalo al año",
      "Concierge de viaje dedicado",
    ],
  },
];

// Catálogo de canje (flexible y transparente). value: pista de valor en €.
export const REWARDS_CATALOG = [
  {
    id: "discard",
    name: "Descarte extra gratis",
    icon: "✕",
    cost: 800,
    blurb: "Cambia un destino más sin pagar la tarifa de cambio.",
  },
  {
    id: "disc30",
    name: "30 € de descuento",
    icon: "🏷️",
    cost: 2500,
    blurb: "Aplícalo a tu próxima escapada sorpresa.",
  },
  {
    id: "upgrade",
    name: "Upgrade de alojamiento",
    icon: "🛎️",
    cost: 4000,
    blurb: "Sube un nivel de estancia (p. ej. Boutique → Villa) en tu próximo viaje.",
  },
  {
    id: "surprise",
    name: "Experiencia sorpresa",
    icon: "🎁",
    cost: 6000,
    blurb: "Te regalamos una experiencia local sorpresa en destino.",
  },
];

export function levelForMiles(milesEarned) {
  let current = LEVELS[0];
  for (const lvl of LEVELS) if (milesEarned >= lvl.minMiles) current = lvl;
  return current;
}

// Devuelve nivel actual, siguiente y progreso (goal-gradient) hacia el siguiente.
export function levelProgress(milesEarned) {
  const current = levelForMiles(milesEarned);
  const idx = LEVELS.findIndex((l) => l.id === current.id);
  const next = LEVELS[idx + 1] || null;
  const floor = current.minMiles;
  const ceil = next ? next.minMiles : current.minMiles;
  const pct = next
    ? Math.min(100, Math.round(((milesEarned - floor) / (ceil - floor)) * 100))
    : 100;
  return {
    current,
    next,
    pct,
    milesToNext: next ? Math.max(0, ceil - milesEarned) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Estado en memoria + persistencia                                    */
/* ------------------------------------------------------------------ */
let db = { users: {} };            // email(lowercase) -> user
const tokenIndex = new Map();      // token -> email

function loadSync() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.users) db = parsed;
    }
  } catch (err) {
    console.error("accounts: no se pudo leer", DATA_FILE, err.message);
  }
  // Reconstruye el índice de tokens en memoria.
  tokenIndex.clear();
  for (const user of Object.values(db.users)) {
    for (const t of user.sessions || []) tokenIndex.set(t.token, user.email);
  }
}

// Serializa las escrituras para no pisar el fichero entre peticiones concurrentes.
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DATA_FILE);
  }).catch((err) => console.error("accounts: error al guardar", err.message));
  return writeChain;
}

export async function initAccounts() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  loadSync();
  const n = Object.keys(db.users).length;
  console.log(`Cuentas: ${DATA_FILE} (${n} ${n === 1 ? "cuenta" : "cuentas"})`);
}

/* ------------------------------------------------------------------ */
/* Hashing de contraseñas (scrypt) y tokens                            */
/* ------------------------------------------------------------------ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 64);
    const ref = Buffer.from(hash, "hex");
    return ref.length === test.length && crypto.timingSafeEqual(ref, test);
  } catch {
    return false;
  }
}
const newToken = () => crypto.randomBytes(32).toString("hex");
const genCode = (prefix) =>
  `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

/* ------------------------------------------------------------------ */
/* Vista pública del usuario (lo que ve el front, sin secretos)        */
/* ------------------------------------------------------------------ */
export function publicUser(user) {
  if (!user) return null;
  const prog = levelProgress(user.milesEarned || 0);
  return {
    email: user.email,
    name: user.name,
    miles: user.miles || 0,
    milesEarned: user.milesEarned || 0,
    trips: (user.trips || []).length,
    level: {
      id: prog.current.id,
      name: prog.current.name,
      icon: prog.current.icon,
      multiplier: prog.current.multiplier,
      freeDiscards: prog.current.freeDiscards,
      perks: prog.current.perks,
    },
    nextLevel: prog.next
      ? { id: prog.next.id, name: prog.next.name, icon: prog.next.icon, minMiles: prog.next.minMiles }
      : null,
    progressPct: prog.pct,
    milesToNext: prog.milesToNext,
    history: (user.history || []).slice(-30).reverse(),
    vouchers: (user.vouchers || []).filter((v) => !v.used),
    createdAt: user.createdAt,
  };
}

function addHistory(user, type, label, miles) {
  user.history = user.history || [];
  user.history.push({ ts: Date.now(), type, label, miles });
  if (user.history.length > 200) user.history = user.history.slice(-200);
}

/* ------------------------------------------------------------------ */
/* Operaciones de cuenta                                               */
/* ------------------------------------------------------------------ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerUser({ email, password, name }) {
  email = String(email || "").trim().toLowerCase();
  name = String(name || "").trim().slice(0, 60);
  password = String(password || "");

  if (!EMAIL_RE.test(email)) return { error: "Introduce un email válido." };
  if (password.length < 6) return { error: "La contraseña debe tener al menos 6 caracteres." };
  if (!name) return { error: "Dinos cómo te llamas." };
  if (db.users[email]) return { error: "Ya existe una cuenta con ese email." };

  const token = newToken();
  const user = {
    email,
    name,
    password: hashPassword(password),
    miles: WELCOME_BONUS,
    milesEarned: WELCOME_BONUS,
    trips: [],
    history: [],
    vouchers: [],
    sessions: [{ token, ts: Date.now() }],
    createdAt: Date.now(),
  };
  addHistory(user, "bonus", "Bienvenida a Pasaporte Defy", WELCOME_BONUS);
  db.users[email] = user;
  tokenIndex.set(token, email);
  await persist();
  return { token, user: publicUser(user) };
}

export async function loginUser({ email, password }) {
  email = String(email || "").trim().toLowerCase();
  const user = db.users[email];
  if (!user || !verifyPassword(password, user.password)) {
    return { error: "Email o contraseña incorrectos." };
  }
  const token = newToken();
  user.sessions = (user.sessions || []).filter((s) => Date.now() - s.ts < 1000 * 60 * 60 * 24 * 45);
  user.sessions.push({ token, ts: Date.now() });
  tokenIndex.set(token, email);
  await persist();
  return { token, user: publicUser(user) };
}

export async function logout(token) {
  const email = tokenIndex.get(token);
  tokenIndex.delete(token);
  if (email && db.users[email]) {
    db.users[email].sessions = (db.users[email].sessions || []).filter((s) => s.token !== token);
    await persist();
  }
}

export function userByToken(token) {
  if (!token) return null;
  const email = tokenIndex.get(token);
  return email ? db.users[email] || null : null;
}

// Otorga millas por un viaje pre-reservado. Aplica el multiplicador del nivel
// actual y registra el viaje + el movimiento en el historial.
export async function awardTrip(token, { amount, destination, date }) {
  const user = userByToken(token);
  if (!user) return { error: "Sesión no válida." };

  const lvl = levelForMiles(user.milesEarned || 0);
  const base = Math.max(0, Math.round((Number(amount) || 0) * MILES_PER_EURO));
  const earned = Math.round(base * lvl.multiplier);

  user.miles = (user.miles || 0) + earned;
  user.milesEarned = (user.milesEarned || 0) + earned;
  user.trips = user.trips || [];
  user.trips.push({ ts: Date.now(), amount: Number(amount) || 0, destination: destination || null, date: date || null });
  addHistory(user, "earn", destination ? `Viaje a ${destination}` : "Viaje pre-reservado", earned);

  // Detecta si el viaje le ha hecho subir de nivel (para celebrarlo en el front).
  const beforeLevel = lvl.id;
  const afterLevel = levelForMiles(user.milesEarned).id;
  await persist();
  return { earned, leveledUp: beforeLevel !== afterLevel, user: publicUser(user) };
}

export async function redeemReward(token, rewardId) {
  const user = userByToken(token);
  if (!user) return { error: "Sesión no válida." };
  const reward = REWARDS_CATALOG.find((r) => r.id === rewardId);
  if (!reward) return { error: "Recompensa no encontrada." };
  if ((user.miles || 0) < reward.cost) return { error: "No tienes millas suficientes." };

  user.miles -= reward.cost;
  const voucher = {
    id: genCode("DEFY"),
    rewardId: reward.id,
    name: reward.name,
    icon: reward.icon,
    cost: reward.cost,
    ts: Date.now(),
    used: false,
  };
  user.vouchers = user.vouchers || [];
  user.vouchers.push(voucher);
  addHistory(user, "redeem", `Canje: ${reward.name}`, -reward.cost);
  await persist();
  return { voucher, user: publicUser(user) };
}
