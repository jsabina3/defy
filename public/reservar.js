/* ===================== Estado ===================== */
const state = {
  step: 0,
  prefs: {
    departureCity: "Madrid",
    travelers: 2,
    nights: 2,
    vibes: [],          // ordenadas por prioridad (la 1ª es la que más pesa)
    climate: "any",
    pace: "balanced",
    profile: null,      // con quién viaja: solo · pareja · amigos · familia
    ages: [],           // edad de CADA viajero (una por viajero)
    budget: null,       // presupuesto aproximado por persona (lo fija el cliente)
    stayTier: "boutique", // nivel de viaje: comodo · boutique · villa
    hiddenGems: true,
  },
  quote: null,        // respuesta de /api/quote
  minBudget: null,    // mínimo por persona que calcula el servidor (precios + config)
  discarded: new Set(),
  selectedDate: null, // 'YYYY-MM-DD'
  selectedTier: "none", // arranca en "solo vuelo + hotel"; el nivel se elige en el paso 3
  calMonth: null,     // Date (día 1 del mes mostrado)
  resultStep: 0,      // 0 calendario · 1 destinos · 2 experiencia
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const euro = (n) => new Intl.NumberFormat("es-ES").format(Math.round(n)) + " €";
const roundUpTo = (n, step) => Math.ceil(n / step) * step;

/* Reglas de descarte: hasta 2 destinos; el 1º gratis, el 2º +10 €/persona. */
const MAX_DISCARDS = 2;
const DISCARD_FEE_PP = 10;
function discardFeeTotal() {
  return Math.max(0, state.discarded.size - 1) * DISCARD_FEE_PP * state.prefs.travelers;
}

/* Caché de precios en firme (clave: fecha|tier|descartes|destinos activos) */
const priceCache = {};
let priceReqSeq = 0;
function priceKey() {
  return [
    state.selectedDate, state.selectedTier, state.discarded.size,
    activeDestinations().map((d) => d.id).join(","),
  ].join("|");
}

/* ===================== Animaciones de entrada ===================== */
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
}, { threshold: 0.15 });
$$(".reveal").forEach((el) => io.observe(el));

/* ===================== Quiz ===================== */
const STEPS = 4;
const quizBar = $("#quizBar");
const prevBtn = $("#quizPrev");
const nextBtn = $("#quizNext");

function showStep(n) {
  state.step = n;
  $$(".quiz-step").forEach((s) => s.classList.toggle("is-active", +s.dataset.step === n));
  quizBar.style.width = ((n + 1) / STEPS) * 100 + "%";
  prevBtn.disabled = n === 0;
  nextBtn.textContent = n === STEPS - 1 ? "Ver mis destinos y precios" : "Siguiente";
}
prevBtn.addEventListener("click", () => state.step > 0 && showStep(state.step - 1));
nextBtn.addEventListener("click", () => {
  if (state.step < STEPS - 1) showStep(state.step + 1);
  else submitQuiz();
});

// Stepper viajeros
$$("[data-step-btn]").forEach((b) => b.addEventListener("click", () => {
  const input = $("#travelers");
  let v = +input.value + (b.dataset.stepBtn === "inc" ? 1 : -1);
  v = Math.max(1, Math.min(8, v));
  input.value = v; state.prefs.travelers = v;
  renderAges();
}));

// Duración
$$("#nightsChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#nightsChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected"); state.prefs.nights = +c.dataset.nights;
}));

// Ciudad
$("#departureCity").addEventListener("change", (e) => state.prefs.departureCity = e.target.value);

// Perfil del viajero (con quién viaja)
$$("#profileChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#profileChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.profile = c.dataset.profile;
}));

// Edad de cada viajero: un campo por viajero. Se regenera al cambiar el número
// de viajeros, conservando las edades ya introducidas.
function renderAges() {
  const grid = $("#agesGrid");
  if (!grid) return;
  const n = state.prefs.travelers;
  const prev = state.prefs.ages || [];
  state.prefs.ages = Array.from({ length: n }, (_, i) => prev[i] ?? null);
  grid.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const cell = document.createElement("label");
    cell.className = "age-cell";
    const val = state.prefs.ages[i];
    cell.innerHTML = `<span>Viajero ${i + 1}</span>
      <input type="number" min="0" max="99" inputmode="numeric" placeholder="edad" data-age-idx="${i}" value="${val ?? ""}" />`;
    grid.appendChild(cell);
  }
  $$("#agesGrid input").forEach((inp) => inp.addEventListener("input", (e) => {
    const idx = +e.target.dataset.ageIdx;
    const v = parseInt(e.target.value, 10);
    state.prefs.ages[idx] = Number.isFinite(v) && v >= 0 ? Math.max(0, Math.min(99, v)) : null;
  }));
}

// Vibes por ORDEN de prioridad: el orden de click es la prioridad.
const VIBE_LABELS = {
  beach: "Costa & playa", culture: "Ciudad & cultura", nature: "Naturaleza & lagos",
  food: "Gastronomía", nightlife: "Fiesta & noche", romantic: "Romántico",
};
function renderVibesPriority() {
  $$("#vibes .chip").forEach((chip) => {
    const v = chip.dataset.vibe;
    const idx = state.prefs.vibes.indexOf(v);
    const rank = chip.querySelector(".chip-rank");
    if (idx >= 0) {
      chip.classList.add("is-selected");
      if (rank) rank.textContent = idx + 1;
    } else {
      chip.classList.remove("is-selected");
      if (rank) rank.textContent = "";
    }
  });
  const order = $("#vibesOrder");
  if (order) {
    if (state.prefs.vibes.length) {
      order.hidden = false;
      order.innerHTML = "Tu orden de prioridad: " +
        state.prefs.vibes.map((v, i) => `<b>${i + 1}. ${VIBE_LABELS[v] || v}</b>`).join(" › ");
    } else {
      order.hidden = true;
    }
  }
}
$$("#vibes .chip").forEach((c) => c.addEventListener("click", () => {
  const v = c.dataset.vibe;
  const i = state.prefs.vibes.indexOf(v);
  if (i >= 0) state.prefs.vibes.splice(i, 1);
  else state.prefs.vibes.push(v);
  renderVibesPriority();
}));

// Nivel de viaje (destino + alojamiento)
$$("#stayTiers .stay-tier").forEach((b) => b.addEventListener("click", () => {
  $$("#stayTiers .stay-tier").forEach((x) => x.classList.remove("is-selected"));
  b.classList.add("is-selected");
  state.prefs.stayTier = b.dataset.stay;
}));

// Clima / ritmo
$$("#climateChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#climateChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected"); state.prefs.climate = c.dataset.climate;
}));
// Ritmo del viaje + explicación de qué implica cada opción.
const PACE_EXPLAIN = {
  relax: "<b>Relax total:</b> días sin agenda. Priorizamos destinos para desconectar (playa, naturaleza, spa) y dejamos las experiencias al mínimo para que mandes tú.",
  balanced: "<b>Equilibrado:</b> lo mejor del destino sin agobios. Mezclamos un par de planes al día (cultura, gastronomía) con tiempo libre para perderte a tu aire.",
  adventure: "<b>Aventura:</b> exprimir el destino. Más actividades, rutas y vida (cultura, deporte al aire libre, noche) para no parar de un sitio a otro.",
};
function updatePaceExplain() {
  const el = $("#paceExplain");
  if (el) el.innerHTML = PACE_EXPLAIN[state.prefs.pace] || "";
}
$$("#paceChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#paceChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected"); state.prefs.pace = c.dataset.pace;
  updatePaceExplain();
}));
updatePaceExplain();

// Joyas escondidas
$("#hiddenGems").addEventListener("change", (e) => state.prefs.hiddenGems = e.target.checked);

/* ===================== Cotización ===================== */
async function submitQuiz() {
  $("#quiz").hidden = true;
  $("#loading").hidden = false;
  $("#results").hidden = true;
  $("#budgetGate").hidden = true;
  try {
    const res = await fetch("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.prefs),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error");
    state.quote = data;
    state.prefs = data.prefs; // normalizado por el servidor
    state.minBudget = Number.isFinite(data.minBudgetPerPerson) ? data.minBudgetPerPerson : null;
    state.discarded = new Set();
    state.selectedDate = null;
    Object.keys(priceCache).forEach((k) => delete priceCache[k]);
    state.selectedTier = "none";
    state.calMonth = startMonth(minDate());
    $("#loading").hidden = true;
    // Antes de mostrar calendario y destinos, pedimos un presupuesto por persona
    // (con el mínimo que el servidor ha calculado según precios y configuración).
    showBudgetGate();
  } catch (err) {
    $("#loading").hidden = true;
    $("#quiz").hidden = false;
    alert("No hemos podido generar tu viaje. Inténtalo de nuevo en un momento.");
    console.error(err);
  }
}

/* ===================== Presupuesto por persona ===================== */
function showBudgetGate() {
  const gate = $("#budgetGate");
  const minEl = $("#budgetMin");
  const input = $("#budgetInput");
  const err = $("#budgetError");
  const min = state.minBudget;
  const stay = (state.quote.stayTiers || []).find((t) => t.id === state.prefs.stayTier);
  const stayName = stay ? stay.name : "";
  const cfg = `${state.prefs.travelers} ${state.prefs.travelers > 1 ? "viajeros" : "viajero"} · ${state.prefs.nights + 1} días${stayName ? " · " + stayName : ""} · salida desde ${state.prefs.departureCity}`;

  if (Number.isFinite(min)) {
    minEl.innerHTML = `<span class="budget-min-ic">▼</span> Mínimo para tu configuración: <b>${euro(min)}/persona</b>
      <small>${cfg}. Es lo más bajo que hemos encontrado (vuelo + hotel) con tus opciones.</small>`;
    minEl.hidden = false;
    input.min = min;
    input.placeholder = `mínimo ${Math.round(min)}`;
    // Sugerimos un valor cómodo por encima del mínimo si aún no hay uno.
    if (!Number.isFinite(state.prefs.budget) || state.prefs.budget < min) {
      input.value = Math.round(min * 1.25 / 10) * 10;
    } else {
      input.value = state.prefs.budget;
    }
  } else {
    minEl.hidden = true;
    input.min = 0;
    input.placeholder = "p. ej. 400";
    if (Number.isFinite(state.prefs.budget)) input.value = state.prefs.budget;
  }
  if (err) err.hidden = true;
  $("#summaryBar").hidden = true;
  gate.hidden = false;
  gate.scrollIntoView({ behavior: "smooth", block: "center" });
}

$("#budgetContinue").addEventListener("click", () => {
  const input = $("#budgetInput");
  const err = $("#budgetError");
  const min = state.minBudget;
  const val = parseInt(input.value, 10);
  if (!Number.isFinite(val) || val <= 0) {
    err.textContent = "Indica un presupuesto aproximado por persona.";
    err.hidden = false;
    return;
  }
  if (Number.isFinite(min) && val < min) {
    err.textContent = `Con tu configuración el mínimo es ${euro(min)}/persona. Sube el presupuesto o cambia tus preferencias.`;
    err.hidden = false;
    return;
  }
  err.hidden = true;
  state.prefs.budget = val;
  $("#budgetGate").hidden = true;
  renderResults();
  $("#results").hidden = false;
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#budgetBack").addEventListener("click", () => {
  $("#budgetGate").hidden = true;
  $("#quiz").hidden = false;
  $("#summaryBar").hidden = true;
  $("#quiz").scrollIntoView({ behavior: "smooth", block: "center" });
});

$("#editPrefs").addEventListener("click", () => {
  $("#results").hidden = true;
  $("#budgetGate").hidden = true;
  $("#quiz").hidden = false;
  $("#summaryBar").hidden = true;
  $("#quiz").scrollIntoView({ behavior: "smooth", block: "center" });
});

/* ===================== Render destinos ===================== */
function gradientFor(seed) {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const a = Math.abs(h) % 360, b = (Math.abs(h) >> 3) % 360;
  return `linear-gradient(145deg, hsl(${a} 55% 32%), hsl(${b} 60% 22%))`;
}
function imgSrc(image) {
  if (!image) return null;
  // El servidor ya resuelve la mejor fuente (local > Unsplash > LoremFlickr).
  if (image.url) return image.url;
  // Compatibilidad con el formato antiguo del catálogo.
  if (image.kind === "local") return image.path;
  if (image.query) return `https://loremflickr.com/1200/800/${encodeURIComponent(image.query)}/all?lock=${image.lock}`;
  return null;
}

function renderResults() {
  $("#resultSource").textContent = state.quote.source === "openai"
    ? "Seleccionado para ti con IA" : "Seleccionado para ti";
  renderDestinations();
  renderTiers();
  renderCalendar();
  showResultStep(0);
  updateSummary();
}

/* ===================== Navegación del carrito (3 páginas) ===================== */
const RSTEPS = 3;
function showResultStep(n) {
  state.resultStep = n;
  $$(".result-step").forEach((s) => s.classList.toggle("is-active", +s.dataset.rstep === n));
  $$(".rstep-pill").forEach((p) => p.classList.toggle("is-on", +p.dataset.pill <= n));
  updateResultNav();
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}
function updateResultNav() {
  const prev = $("#rPrev"), next = $("#rNext");
  if (!prev || !next) return;
  prev.disabled = state.resultStep === 0;
  if (state.resultStep === RSTEPS - 1) {
    next.textContent = "Reservar a ciegas";
    next.disabled = !state.selectedDate;
  } else {
    next.textContent = "Siguiente →";
    next.disabled = state.resultStep === 0 && !state.selectedDate;
  }
}
$("#rPrev").addEventListener("click", () => { if (state.resultStep > 0) showResultStep(state.resultStep - 1); });
$("#rNext").addEventListener("click", () => {
  if (state.resultStep < RSTEPS - 1) showResultStep(state.resultStep + 1);
  else checkout();
});

function renderDestinations() {
  const grid = $("#destGrid");
  grid.innerHTML = "";
  const limitReached = state.discarded.size >= MAX_DISCARDS;
  const onlyOneLeft = activeDestinations().length <= 1;

  state.quote.destinations.forEach((d) => {
    const isDiscarded = state.discarded.has(d.id);
    const el = document.createElement("article");
    el.className = "dest" + (isDiscarded ? " is-discarded" : "");
    el.style.background = gradientFor(d.name);

    const src = imgSrc(d.image);
    const img = src ? `<img class="dest-bg" data-id="${d.id}" src="${src}" alt="${d.name}" loading="lazy"
      onerror="this.style.display='none'">` : "";
    const gem = d.isHiddenGem ? `<span class="dest-badge">◈ Joya escondida</span>` : "";
    const transfer = d.transfer ? `<div class="dest-transfer">🚆 ${d.transfer}</div>` : "";

    // Coste de descartar este destino: gratis si sería el 1º, +10 €/p si sería el 2º.
    const wouldBeFee = !isDiscarded && state.discarded.size === 1;
    const feeTag = wouldBeFee ? `<span class="dest-feetag">+${euro(DISCARD_FEE_PP)}/persona</span>` : "";
    // Deshabilitamos descartar más si ya hay 2 o si solo queda 1 activo.
    const disabled = !isDiscarded && (limitReached || onlyOneLeft);

    el.innerHTML = `
      ${img}
      ${gem}
      <button class="dest-discard${disabled ? " is-disabled" : ""}" title="${isDiscarded ? "Recuperar destino" : disabled ? "Máximo 2 descartes" : "Descartar destino"}" data-id="${d.id}"${disabled ? " disabled" : ""}>${isDiscarded ? "↺" : "✕"}</button>
      ${feeTag}
      <div class="dest-body">
        <div class="dest-name">${d.name}</div>
        <div class="dest-country">${d.region ? d.region + " · " : ""}${d.country}</div>
        <div class="dest-reason">${d.matchReason || d.blurb || ""}</div>
        ${transfer}
      </div>`;
    grid.appendChild(el);
  });

  pollGeneratedImages();

  $$(".dest-discard").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.id;
    if (state.discarded.has(id)) {
      state.discarded.delete(id);
    } else {
      if (state.discarded.size >= MAX_DISCARDS) return; // no más de 2
      if (activeDestinations().length <= 1) return;      // no descartar el último
      state.discarded.add(id);
    }
    renderDestinations();
    renderCalendar();
    updateSummary();
    refreshPrice();
  }));
}

function activeDestinations() {
  return state.quote.destinations.filter((d) => !state.discarded.has(d.id));
}

/* Mejora progresiva de imágenes: las tarjetas muestran al instante un placeholder
   ilustrado; mientras, el servidor genera la foto real con IA. Aquí preguntamos
   periódicamente qué fotos ya están listas y sustituimos el placeholder. */
let imgPollTimer = null;
function pollGeneratedImages() {
  clearTimeout(imgPollTimer);
  if (!state.quote || !state.quote.destinations) return;
  const allIds = state.quote.destinations.map((d) => d.id);
  let tries = 0;
  const tick = async () => {
    tries += 1;
    const pending = allIds.filter(
      (id) => !document.querySelector(`.dest-bg[data-id="${id}"][data-generated="1"]`)
    );
    if (!pending.length || tries > 40) return; // ~2 min máx.
    try {
      const res = await fetch(`/api/destimg/status?ids=${encodeURIComponent(pending.join(","))}`);
      const data = await res.json();
      if (data.ok) {
        Object.entries(data.ready).forEach(([id, url]) => {
          document.querySelectorAll(`.dest-bg[data-id="${id}"]`).forEach((img) => {
            if (img.dataset.generated === "1") return;
            img.dataset.generated = "1";
            img.src = `${url}?v=${Date.now()}`;
            img.style.display = "";
          });
        });
      }
    } catch (e) { /* reintentamos en el siguiente tick */ }
    imgPollTimer = setTimeout(tick, 3500);
  };
  imgPollTimer = setTimeout(tick, 2500);
}

/* ===================== Tiers ===================== */
function renderTiers() {
  const wrap = $("#tiers");
  wrap.innerHTML = "";

  // opción "sin actividades"
  const none = document.createElement("div");
  none.className = "tier" + (state.selectedTier === "none" ? " is-selected" : "");
  none.dataset.tier = "none";
  none.innerHTML = `<div class="tier-top"><span class="tier-name">Solo vuelo + hotel</span>
    <span class="tier-price">Incluido</span></div>
    <p class="tier-tag tier-none">Sin actividades sorpresa. Tú decides sobre la marcha.</p>`;
  wrap.appendChild(none);

  state.quote.tiers.forEach((t) => {
    const charged = t.pricePerPerson ?? t.perPersonCost;
    const el = document.createElement("div");
    el.className = "tier" + (state.selectedTier === t.id ? " is-selected" : "");
    el.dataset.tier = t.id;
    el.innerHTML = `
      <div class="tier-top">
        <span class="tier-name">${t.name}</span>
        <span class="tier-price">+${euro(charged)} <small>/persona</small></span>
      </div>
      <p class="tier-tag">${t.tagline}</p>
      <ul class="tier-items">${t.items.map((i) => `<li>${i}</li>`).join("")}</ul>
      ${t.valuePerPerson ? `<p class="tier-value">Reservado por tu cuenta ≈ <b>${euro(t.valuePerPerson)}</b>/persona · <span class="tier-save">ahorras ${euro(t.valuePerPerson - charged)}</span></p>` : ""}`;
    wrap.appendChild(el);
  });

  $$("#tiers .tier").forEach((el) => el.addEventListener("click", () => {
    state.selectedTier = el.dataset.tier;
    renderTiers(); renderCalendar(); updateSummary(); refreshPrice();
  }));
}

function currentTier() {
  if (state.selectedTier === "none") return { perPersonCost: 0 };
  return state.quote.tiers.find((t) => t.id === state.selectedTier) || { perPersonCost: 0 };
}

/* ===================== Motor de precios (idéntico al servidor) ===================== */
function isWeekend(dateStr) { const d = new Date(dateStr + "T12:00:00").getDay(); return d === 5 || d === 6; }
function monthIndex(dateStr) { return new Date(dateStr + "T12:00:00").getMonth(); }

// Factor del nivel de viaje elegido (escala el hotel). Llega del servidor en
// state.quote.stayTiers; por defecto "boutique" (factor 1).
function stayFactor() {
  const tiers = state.quote?.stayTiers || [];
  const t = tiers.find((x) => x.id === state.prefs.stayTier)
    || tiers.find((x) => x.recommended) || tiers[0];
  return t ? t.hotelFactor : 1;
}

// Coste-con-margen de PROVEEDOR (vuelo + hotel + traslado) de un destino para una
// fecha. NO incluye actividades (uniformes, se suman al ancla).
function providerCharged(dest, dateStr) {
  const p = state.quote.pricing;
  const m = monthIndex(dateStr);
  const season = dest.seasonality[m];
  const weekend = isWeekend(dateStr) ? 1 + p.weekendPremium : 1;
  const nights = state.prefs.nights;
  const travelers = state.prefs.travelers;
  const rooms = Math.ceil(travelers / p.peoplePerRoom);

  const flight = dest.flightPerPerson * season * weekend * travelers * p.markups.flight;
  const hotel = dest.hotelPerNight * stayFactor() * season * nights * rooms * p.markups.hotel;
  const transfer = dest.transferCost * travelers * p.markups.transfer;
  return flight + hotel + transfer;
}

// Percentil con interpolación lineal (idéntico al servidor).
function percentile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// Precio sorpresa (ancla): percentil del precio de TODOS los destinos ofertados
// (no solo los activos) + actividades. Es estable: descartar destinos NO cambia
// el precio, así que nunca revela cuál era el barato.
function surpriseCharged(dateStr, tier) {
  const p = state.quote.pricing;
  const all = state.quote.destinations.map((d) => providerCharged(d, dateStr));
  const base = percentile(all, p.anchorPercentile ?? 0.5);
  const activity = (tier.pricePerPerson ?? (tier.perPersonCost || 0)) * state.prefs.travelers;
  return roundUpTo(base + activity, 10);
}

/* ===================== Calendario ===================== */
function fmt(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function startMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function minDate() { const d = new Date(); d.setDate(d.getDate() + 10); return d; }
function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00"); d.setDate(d.getDate() + days); return fmt(d);
}

// Conjunto de días que abarca el viaje (salida + noches) a partir de una salida.
function tripRange(startStr) {
  const nights = state.prefs.nights;
  const set = new Set();
  for (let i = 0; i <= nights; i++) set.add(addDaysStr(startStr, i));
  return { start: startStr, end: addDaysStr(startStr, nights), set };
}

// Muestra bajo el calendario todos los días que incluiría el viaje.
function updateTripCaption() {
  const cap = $("#calTrip");
  if (!cap) return;
  if (!state.selectedDate) { cap.hidden = true; return; }
  const r = tripRange(state.selectedDate);
  const opts = { weekday: "short", day: "numeric", month: "short" };
  const start = new Date(r.start + "T12:00:00").toLocaleDateString("es-ES", opts);
  const end = new Date(r.end + "T12:00:00").toLocaleDateString("es-ES", opts);
  const nights = state.prefs.nights;
  cap.hidden = false;
  cap.innerHTML = `🧳 Tu viaje: <b>${start}</b> → <b>${end}</b> · ${nights + 1} días, ${nights} ${nights === 1 ? "noche" : "noches"} (resaltados en el calendario)`;
}

function renderCalendar() {
  const grid = $("#calGrid");
  grid.innerHTML = "";
  const month = state.calMonth;
  $("#calMonth").textContent = month.toLocaleDateString("es-ES", { month: "long", year: "numeric" });

  // Banner del presupuesto elegido: los días por encima se atenúan en gris.
  const budgetEl = $("#calBudget");
  if (budgetEl) {
    if (Number.isFinite(state.prefs.budget)) {
      budgetEl.hidden = false;
      budgetEl.innerHTML = `💶 Tu presupuesto: <b>${euro(state.prefs.budget)}/persona</b> · <button type="button" class="cal-budget-edit" id="calBudgetEdit">cambiar</button> · los días por encima aparecen atenuados.`;
      const editBtn = $("#calBudgetEdit");
      if (editBtn) editBtn.addEventListener("click", () => { $("#results").hidden = true; showBudgetGate(); });
    } else {
      budgetEl.hidden = true;
    }
  }

  // El calendario muestra SIEMPRE el precio base "vuelo + hotel" (sin actividades).
  // El nivel de experiencia se elige en el paso 3 y se suma en el resumen/total.
  const tier = { perPersonCost: 0, pricePerPerson: 0 };
  const min = minDate(); min.setHours(0, 0, 0, 0);
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // lunes primero
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  for (let i = 0; i < offset; i++) {
    const e = document.createElement("div"); e.className = "cal-cell empty"; grid.appendChild(e);
  }

  // Precios del mes para clasificar low/mid/high
  const monthPrices = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    if (date >= min) monthPrices.push(surpriseCharged(fmt(date), tier) / state.prefs.travelers);
  }
  monthPrices.sort((a, b) => a - b);
  const q1 = monthPrices[Math.floor(monthPrices.length * 0.33)] || 0;
  const q2 = monthPrices[Math.floor(monthPrices.length * 0.66)] || 0;

  // Días que abarca el viaje según la salida elegida (para resaltar el rango).
  const range = state.selectedDate ? tripRange(state.selectedDate) : null;

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    const ds = fmt(date);
    const cell = document.createElement("button");
    cell.type = "button";
    if (date < min) {
      cell.className = "cal-cell disabled";
      cell.innerHTML = `<span class="cal-day">${day}</span>`;
    } else {
      const per = surpriseCharged(ds, tier) / state.prefs.travelers;
      const level = per <= q1 ? "low" : per <= q2 ? "mid" : "high";
      let cls = `cal-cell avail ${level}`;
      if (Number.isFinite(state.prefs.budget) && roundUpTo(per, 5) > state.prefs.budget) cls += " over-budget";
      if (range && range.set.has(ds)) {
        cls += " in-range";
        if (ds === range.start) cls += " range-start";
        if (ds === range.end) cls += " range-end";
      }
      if (state.selectedDate === ds) cls += " selected";
      cell.className = cls;
      cell.innerHTML = `<span class="cal-day">${day}</span><span class="cal-price">${euro(roundUpTo(per, 5))}</span>`;
      cell.addEventListener("click", () => {
        state.selectedDate = ds;
        renderCalendar(); updateSummary(); refreshPrice();
      });
    }
    grid.appendChild(cell);
  }
  updateTripCaption();
}

$("#calPrev").addEventListener("click", () => {
  const m = new Date(state.calMonth); m.setMonth(m.getMonth() - 1);
  if (m >= startMonth(minDate())) { state.calMonth = m; renderCalendar(); }
});
$("#calNext").addEventListener("click", () => {
  const m = new Date(state.calMonth); m.setMonth(m.getMonth() + 1);
  const limit = startMonth(minDate()); limit.setMonth(limit.getMonth() + 11);
  if (m <= limit) { state.calMonth = m; renderCalendar(); }
});

/* ===================== Resumen ===================== */
function updateSummary() {
  const bar = $("#summaryBar");
  bar.hidden = false;
  const tier = currentTier();
  const tierName = state.selectedTier === "none" ? "Solo vuelo + hotel"
    : state.quote.tiers.find((t) => t.id === state.selectedTier).name;
  const stay = (state.quote.stayTiers || []).find((t) => t.id === state.prefs.stayTier);
  const stayName = stay ? stay.name : "";

  if (!state.selectedDate) {
    $("#summaryLine").textContent = `${state.prefs.travelers} viajeros · ${state.prefs.nights + 1} días · ${stayName ? stayName + " · " : ""}${tierName}`;
    $("#summaryTotal").textContent = "Elige fecha";
    $("#summaryPer").textContent = "";
    updateResultNav();
    return;
  }
  const fee = discardFeeTotal();
  const total = surpriseCharged(state.selectedDate, tier) + fee;
  const per = roundUpTo(total / state.prefs.travelers, 5);
  const d = new Date(state.selectedDate + "T12:00:00");
  const dateLabel = d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "long" });
  const feeNote = fee > 0 ? ` · cambio de destino +${euro(fee)}` : "";
  const overBudget = Number.isFinite(state.prefs.budget) && per > state.prefs.budget;
  const budgetNote = overBudget ? ` · ⚠️ sobre tu presupuesto (${euro(state.prefs.budget)}/p)` : "";
  $("#summaryLine").textContent = `${dateLabel} · ${state.prefs.travelers} viajeros · ${stayName ? stayName + " · " : ""}${tierName}${feeNote}${budgetNote}`;
  $("#summaryTotal").textContent = euro(total);
  $("#summaryPer").textContent = `· ${euro(per)}/persona`;
  updateResultNav();
}

// Recalcula el precio EN FIRME para la fecha elegida (vuelo + hotel reales si
// hay Amadeus). Muestra primero la estimación del calendario y la sustituye por
// el precio definitivo cuando llega del servidor (puede variar ligeramente).
async function refreshPrice() {
  if (!state.selectedDate) return;
  const key = priceKey();
  if (priceCache[key]) { applyLivePrice(priceCache[key]); return; }

  const totalEl = $("#summaryTotal");
  const perEl = $("#summaryPer");
  if (totalEl) totalEl.classList.add("is-checking");
  if (perEl) perEl.textContent = "· comprobando precio…";

  const seq = ++priceReqSeq;
  try {
    const res = await fetch("/api/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefs: state.prefs,
        date: state.selectedDate,
        tierId: state.selectedTier === "none" ? "none" : state.selectedTier,
        discards: state.discarded.size,
        // Enviamos la ficha COMPLETA del destino (la IA puede haberlo inventado,
        // así el servidor lo cotiza aunque no esté en su catálogo).
        destinations: state.quote.destinations.map((d) => ({
          ...d, discarded: state.discarded.has(d.id),
        })),
      }),
    });
    const data = await res.json();
    if (seq !== priceReqSeq) return; // respuesta obsoleta (cambió la selección)
    if (data.ok) {
      priceCache[key] = data;
      applyLivePrice(data);
    } else {
      updateSummary();
    }
  } catch (err) {
    console.error(err);
    if (seq === priceReqSeq) updateSummary();
  } finally {
    if (seq === priceReqSeq && totalEl) totalEl.classList.remove("is-checking");
  }
}

function applyLivePrice(data) {
  if (!state.selectedDate) return;
  const totalEl = $("#summaryTotal");
  const perEl = $("#summaryPer");
  if (totalEl) { totalEl.textContent = euro(data.total); totalEl.classList.remove("is-checking"); }
  if (perEl) {
    const per = data.perPerson ?? roundUpTo(data.total / state.prefs.travelers, 5);
    perEl.textContent = `· ${euro(per)}/persona${data.live ? " · precio en firme" : ""}`;
  }
}

/* ===================== Checkout ===================== */
async function checkout() {
  if (!state.selectedDate) { showResultStep(0); return; }
  const btn = $("#rNext");
  btn.disabled = true; btn.textContent = "Reservando…";
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefs: state.prefs,
        date: state.selectedDate,
        tierId: state.selectedTier === "none" ? "none" : state.selectedTier,
        discards: state.discarded.size,
        // Ficha completa del destino (ver nota en refreshPrice).
        destinations: state.quote.destinations.map((d) => ({
          ...d, discarded: state.discarded.has(d.id),
        })),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error");
    renderOverlay(data);
  } catch (err) {
    alert("No se pudo completar la reserva. Inténtalo de nuevo.");
    console.error(err);
  } finally {
    btn.disabled = false; updateResultNav();
  }
}

function stars(n) { return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n)); }

function renderOverlay(data) {
  const b = data.booking, f = data.finance;
  const heroImg = imgSrc(b.destination.image);
  const gem = b.destination.isHiddenGem
    ? `<span class="reveal-gem">◈ Joya escondida · ${b.destination.transfer || ""}</span>` : "";
  const date = new Date(b.date + "T12:00:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const returnDate = new Date(b.returnDate + "T12:00:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const ch = f.breakdown.charged, co = f.breakdown.cost;

  const perPerson = Math.round(f.chargedTotal / b.travelers);
  const actPer = Math.round((ch.activity || 0) / b.travelers);
  const isNone = b.tier.id === "none";
  const actsHtml = isNone
    ? `<p class="cart-none">Solo vuelo + hotel. Tú decides el plan sobre la marcha.</p>`
    : `<ul class="cart-acts">${(b.tier.items || []).map((i) => `<li>${i}</li>`).join("")}</ul>`;

  $("#overlayBody").innerHTML = `
    <div class="reveal-hero" style="background:${gradientFor(b.destination.name)}">
      ${heroImg ? `<img src="${heroImg}" alt="${b.destination.name}" onerror="this.style.display='none'">` : ""}
      <div>
        <p class="reveal-kicker">Tu destino sorpresa sería…</p>
        <div class="reveal-dest">${b.destination.name}</div>
        <p class="reveal-sub">${b.destination.region ? b.destination.region + " · " : ""}${b.destination.country}</p>
      </div>
      ${gem ? `<div class="reveal-gem-wrap">${gem}</div>` : ""}
    </div>
    <div class="reveal-body">
      <p class="reveal-blurb">${b.destination.blurb || ""}</p>

      <div class="cart-summary">
        <div class="cart-total">
          <span class="cart-total-label">Precio total · ${b.travelers} ${b.travelers > 1 ? "viajeros" : "viajero"}</span>
          <span class="cart-total-value">${euro(f.chargedTotal)}</span>
          <span class="cart-total-per">${euro(perPerson)} / persona · todo incluido</span>
        </div>
        <div class="cart-dates">
          <div><span>Salida</span><b>${date}</b></div>
          <div><span>Vuelta</span><b>${returnDate}</b></div>
          <div><span>Noches</span><b>${b.nights}</b></div>
        </div>
      </div>

      <div class="book-grid">
        <div class="book-box">
          <h5>✈️ Vuelos · ${b.travelers} pax</h5>
          <div class="flight-leg">
            <div><b>${b.flightHotel.outbound.dep}</b> → ${b.flightHotel.outbound.arr}
              <div class="flight-route">${b.flightHotel.outbound.from} → ${b.flightHotel.outbound.to}</div></div>
            <div style="text-align:right">${b.flightHotel.outbound.airline}<br><small>${b.flightHotel.outbound.flightNo}</small></div>
          </div>
          <div class="flight-leg">
            <div><b>${b.flightHotel.inbound.dep}</b> → ${b.flightHotel.inbound.arr}
              <div class="flight-route">${b.flightHotel.inbound.from} → ${b.flightHotel.inbound.to}</div></div>
            <div style="text-align:right">${b.flightHotel.inbound.airline}<br><small>${b.flightHotel.inbound.flightNo}</small></div>
          </div>
          <div class="price-chip">Vuelo para esta fecha · <b>${euro(ch.flight)}</b></div>
        </div>
        <div class="book-box">
          <h5>🏨 Hotel · ${b.nights} noches${b.stay ? ` · ${b.stay.name}` : ""}</h5>
          <div class="hotel-name">${b.flightHotel.hotel.name}</div>
          <div class="hotel-meta"><span class="stars">${stars(b.flightHotel.hotel.stars)}</span> · ${b.flightHotel.hotel.neighborhood}</div>
          ${b.flightHotel.hotel.stayType ? `<div class="hotel-meta">${b.flightHotel.hotel.stayType}</div>` : ""}
          <div class="hotel-meta">Valoración ${b.flightHotel.hotel.rating}/10</div>
          <div class="price-chip">Hotel ${b.nights} noches · <b>${euro(ch.hotel)}</b></div>
        </div>
      </div>

      <div class="cart-includes">
        <div class="cart-includes-head">
          <h5>🎁 Experiencias incluidas · <b>${b.tier.name}</b></h5>
          ${isNone ? "" : `<span class="cart-acts-price">+${euro(actPer)} / persona</span>`}
        </div>
        ${isNone ? "" : `<p class="cart-acts-hint">Esto es lo que vivirías en ${b.destination.name} (ejemplos para que te hagas una idea):</p>`}
        ${actsHtml}
        ${(!isNone && b.tier.valuePerPerson) ? `<p class="tier-value">Reservado por tu cuenta ≈ <b>${euro(b.tier.valuePerPerson)}</b>/persona · <span class="tier-save">ahorras ${euro(b.tier.valuePerPerson - (b.tier.pricePerPerson || 0))}</span></p>` : ""}
      </div>

      <details class="finance-wrap">
        <summary>Ver desglose interno (coste y margen)</summary>
        <div class="finance">
          <div class="finance-head">🔒 Precio y margen ${f.live ? "en firme" : "estimados"} para estas fechas</div>
          <div class="fin-row"><span>Precio cobrado al cliente</span><b>${euro(f.chargedTotal)}</b></div>
          ${f.swapFee ? `<div class="fin-row"><span class="muted">Incluye cambio de destino (${f.discards}º descarte)</span><span class="muted">${euro(f.swapFee)}</span></div>` : ""}
          <div class="fin-row"><span class="muted">Coste real vuelos</span><span class="muted">${euro(co.flight)}</span></div>
          <div class="fin-row"><span class="muted">Coste real hotel</span><span class="muted">${euro(co.hotel)}</span></div>
          <div class="fin-row"><span class="muted">Coste real traslado</span><span class="muted">${euro(co.transfer)}</span></div>
          <div class="fin-row"><span class="muted">Coste real actividades</span><span class="muted">${euro(co.activity)}</span></div>
          <div class="fin-row"><span>Coste total proveedor</span><b>${euro(f.costTotal)}</b></div>
          <div class="fin-row total">
            <span>Margen estimado</span>
            <span class="fin-margin">${euro(f.margin)} <span class="fin-pill">${f.marginPct}%</span></span>
          </div>
          ${f.activities ? `
          <div class="fin-acts">
            <div class="finance-head">🎁 Margen solo de las experiencias · ${b.tier.name}</div>
            <div class="fin-row"><span>Valor de mercado (reservado suelto)</span><b>${euro(f.activities.valueTotal)}</b></div>
            <div class="fin-row"><span>Precio que asume el cliente</span><b>${euro(f.activities.priceTotal)}</b></div>
            <div class="fin-row"><span class="muted">Coste real proveedor</span><span class="muted">${euro(f.activities.costTotal)}</span></div>
            <div class="fin-row total">
              <span>Margen actividades</span>
              <span class="fin-margin">${euro(f.activities.marginTotal)} <span class="fin-pill">${f.activities.marginPct}%</span></span>
            </div>
          </div>` : ""}
          <p class="fin-note">El cálculo usa la fecha elegida, las noches, viajeros, temporada del destino y prima de salida en viernes/sábado. El precio sorpresa cobrado es la mediana de los destinos activos; el margen varía según el destino finalmente asignado.</p>
        </div>
      </details>

      <div class="miles-teaser" id="milesTeaser"></div>

      <div class="reveal-actions">
        <button class="btn btn-primary btn-lg" id="overlayConfirm">Confirmar pre-reserva</button>
        <button class="btn btn-ghost" id="overlayBack">Volver</button>
      </div>
    </div>`;

  $("#overlay").hidden = false;
  document.body.style.overflow = "hidden";
  renderMilesTeaser(f.chargedTotal);
  $("#overlayBack").addEventListener("click", closeOverlay);
  $("#overlayConfirm").addEventListener("click", () => confirmBooking(b, f));
}

/* Millas que sumaría esta reserva (con el multiplicador del nivel del usuario). */
function milesForBooking(amount) {
  const u = window.DefyAuth?.user;
  const mult = u?.level?.multiplier || 1;
  return Math.round((Number(amount) || 0) * mult);
}

function renderMilesTeaser(amount) {
  const el = $("#milesTeaser");
  if (!el || !window.DefyAuth) return;
  const u = DefyAuth.user;
  const miles = milesForBooking(amount);
  if (u) {
    el.innerHTML = `<span class="miles-teaser-ic">✦</span> Esta escapada te sumará <b>${DefyAuth.fmtMiles(miles)} millas</b> en tu Pasaporte Defy (nivel ${u.level.icon} ${u.level.name}).`;
  } else {
    el.innerHTML = `<span class="miles-teaser-ic">✦</span> Crea tu <b>Pasaporte Defy</b> gratis y gana <b>${DefyAuth.fmtMiles(amount)} millas</b> con esta reserva + 500 de bienvenida. <button class="miles-teaser-link" id="milesJoin">Unirme</button>`;
    const join = $("#milesJoin");
    if (join) join.addEventListener("click", () => DefyAuth.openModal("register").then(() => renderMilesTeaser(amount)));
  }
}

async function confirmBooking(b, f) {
  const btn = $("#overlayConfirm");
  btn.disabled = true;
  const original = btn.textContent;
  try {
    // Aseguramos sesión para que la reserva sume millas al Pasaporte Defy.
    if (!DefyAuth.user) {
      btn.textContent = "Necesitamos tu cuenta…";
      await DefyAuth.requireAuth("register");
      btn.disabled = true;
    }
    btn.textContent = "Registrando…";
    const res = await fetch("/api/rewards/earn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: f.chargedTotal,
        destination: b.destination.name,
        date: b.date,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "No se pudo registrar.");
    await DefyAuth.refresh();
    btn.textContent = `✓ Pre-reserva registrada · +${DefyAuth.fmtMiles(data.earned)} millas`;
    const teaser = $("#milesTeaser");
    if (teaser) {
      teaser.classList.add("earned");
      teaser.innerHTML = data.leveledUp
        ? `🎉 <b>¡Has subido a nivel ${data.user.level.icon} ${data.user.level.name}!</b> +${DefyAuth.fmtMiles(data.earned)} millas. <a href="/cuenta">Ver mi pasaporte →</a>`
        : `✦ <b>+${DefyAuth.fmtMiles(data.earned)} millas</b> sumadas. Ya tienes ${DefyAuth.fmtMiles(data.user.miles)}. <a href="/cuenta">Ver mi pasaporte →</a>`;
    }
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    btn.textContent = original;
    alert(e.message || "No se pudo registrar la pre-reserva.");
  }
}

function closeOverlay() { $("#overlay").hidden = true; document.body.style.overflow = ""; }
$("#overlayClose").addEventListener("click", closeOverlay);
$("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeOverlay(); });

/* ===================== Init ===================== */
renderAges();
showStep(0);
