/* ===================== Estado ===================== */
const MAX_VIBES = 3;
const TRIP_DAYS_RANGE = {
  weekend: { minDays: 2, maxDays: 3, defaultDays: 2 },
  short: { minDays: 4, maxDays: 7, defaultDays: 5 },
  medium: { minDays: 8, maxDays: 14, defaultDays: 11 },
  long: { minDays: 15, maxDays: 22, defaultDays: 15 },
};
const BUDGET_STAY = { budget: "comodo", mid: "boutique", premium: "boutique", luxury: "villa" };
const ACCOM_STAY = { hotel: "comodo", boutique: "boutique", resort: "villa", apartment: "comodo", rural: "comodo" };
const BUDGET_ESTIMATE = { budget: 350, mid: 550, premium: 850, luxury: 1400 };

const state = {
  step: 0,
  prefs: {
    departureCity: "Madrid",
    travelers: 2,
    days: 5,
    nights: 4,
    tripLength: "short",
    vibes: [],          // hasta 3, ordenadas por prioridad
    climate: "any",
    pace: "balanced",
    profile: null,
    ages: [],
    budgetTier: "mid",
    budget: null,
    travelRange: "medium",
    explorerStyle: "balanced",
    stayTier: "boutique",
    foodInterests: [],
    dietary: "none",
    accommodation: "boutique",
    comfortLevel: "balanced",
    hiddenGems: true,   // derivado de explorerStyle (compat. servidor)
  },
  quote: null,        // respuesta de /api/quote
  minBudget: null,    // mínimo por persona que calcula el servidor (precios + config)
  discarded: new Set(),
  selectedDate: null, // 'YYYY-MM-DD'
  selectedTier: "none", // arranca en "solo vuelo + hotel"; el nivel se elige en el paso 3
  calMonth: null,     // Date (día 1 del mes mostrado)
  resultStep: 0,      // 0 calendario · 1 destinos · 2 experiencia
  livePrice: null,    // precio confirmado por /api/price para la selección actual
  livePriceKey: null,
  priceLoading: false,
  adjustDraft: null,
  adjustBaseline: null,
  adjustPreview: null,
  adjustPreviewTimer: null,
  adjustApplying: false,
  stayTierLocked: false,
  calendarMin: null,
  calendarMinDate: null,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const euro = (n) => new Intl.NumberFormat("es-ES").format(Math.round(n)) + " €";
const roundUpTo = (n, step) => Math.ceil(n / step) * step;

/* Reglas de descarte: 1 destino gratis por viaje. */
const MAX_DISCARDS = 1;
function discardFeeTotal() {
  return 0;
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
const STEPS = 5;
const quizBar = $("#quizBar");
const prevBtn = $("#quizPrev");
const nextBtn = $("#quizNext");
const quizError = $("#quizError");

function tripDaysRange(trip = state.prefs.tripLength) {
  return TRIP_DAYS_RANGE[trip] || TRIP_DAYS_RANGE.short;
}

function clampTripDays(days, trip = state.prefs.tripLength) {
  const r = tripDaysRange(trip);
  return Math.max(r.minDays, Math.min(r.maxDays, days));
}

function setTripDays(days, trip = state.prefs.tripLength) {
  const d = clampTripDays(days, trip);
  state.prefs.days = d;
  state.prefs.nights = d - 1;
  return d;
}

function applyStayTier() {
  let stay = BUDGET_STAY[state.prefs.budgetTier] ?? "boutique";
  if (state.prefs.accommodation && state.prefs.accommodation !== "any") {
    stay = ACCOM_STAY[state.prefs.accommodation] ?? stay;
  }
  if (state.prefs.comfortLevel === "comfort") stay = "villa";
  else if (state.prefs.comfortLevel === "authentic") stay = "comodo";
  state.prefs.stayTier = stay;
}

function syncDerivedPrefs() {
  setTripDays(state.prefs.days ?? tripDaysRange().defaultDays);
  applyStayTier();
  state.prefs.hiddenGems = state.prefs.explorerStyle !== "highlights";
  if (!state.prefs.budget) state.prefs.budget = BUDGET_ESTIMATE[state.prefs.budgetTier] ?? 550;
}

function renderTripDays() {
  const r = tripDaysRange();
  const days = setTripDays(state.prefs.days ?? r.defaultDays);
  const input = $("#tripDays");
  const hint = $("#tripDaysHint");
  const dec = $("#tripDaysDec");
  const inc = $("#tripDaysInc");
  if (input) input.value = days;
  if (hint) {
    hint.textContent = `${r.minDays}–${r.maxDays} días en esta categoría · ${days - 1} ${days - 1 === 1 ? "noche" : "noches"}`;
  }
  if (dec) dec.disabled = days <= r.minDays;
  if (inc) inc.disabled = days >= r.maxDays;
}

function validateStep(n) {
  const err = quizError;
  if (err) { err.hidden = true; err.textContent = ""; }
  if (n === 0 && !state.prefs.profile) {
    if (err) { err.textContent = "Indica con quién viajas para continuar."; err.hidden = false; }
    return false;
  }
  if (n === 1 && !state.prefs.vibes.length) {
    if (err) { err.textContent = "Elige al menos un interés principal."; err.hidden = false; }
    return false;
  }
  return true;
}

function showStep(n) {
  state.step = n;
  $$(".quiz-step").forEach((s) => s.classList.toggle("is-active", +s.dataset.step === n));
  quizBar.style.width = ((n + 1) / STEPS) * 100 + "%";
  prevBtn.disabled = n === 0;
  nextBtn.textContent = n === STEPS - 1 ? "Ver mis destinos y precios" : "Siguiente";
  if (quizError) quizError.hidden = true;
}
prevBtn.addEventListener("click", () => state.step > 0 && showStep(state.step - 1));
nextBtn.addEventListener("click", () => {
  if (!validateStep(state.step)) return;
  if (state.step < STEPS - 1) showStep(state.step + 1);
  else { syncDerivedPrefs(); submitQuiz(); }
});

// Stepper viajeros
$$("[data-step-btn]").forEach((b) => b.addEventListener("click", () => {
  const input = $("#travelers");
  let v = +input.value + (b.dataset.stepBtn === "inc" ? 1 : -1);
  v = Math.max(1, Math.min(8, v));
  input.value = v; state.prefs.travelers = v;
  renderAges();
}));

// Ciudad
$("#departureCity").addEventListener("change", (e) => {
  state.prefs.departureCity = e.target.value;
});

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

// Vibes por ORDEN de prioridad (máx. 3).
const VIBE_LABELS = {
  beach: "Costa & playa", culture: "Ciudad & cultura", nature: "Naturaleza & lagos",
  food: "Gastronomía", nightlife: "Fiesta & noche", romantic: "Romántico",
};
const PRIORITY_LABELS = ["Principal", "Segundo", "Tercero"];
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
  $$("#prioritySlots .priority-slot").forEach((slot) => {
    const i = +slot.dataset.slot;
    const v = state.prefs.vibes[i];
    slot.classList.toggle("is-filled", !!v);
    slot.textContent = v ? `${i + 1}.º ${PRIORITY_LABELS[i]}: ${VIBE_LABELS[v]}` : `${i + 1}.º ${PRIORITY_LABELS[i]}`;
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
  else if (state.prefs.vibes.length < MAX_VIBES) state.prefs.vibes.push(v);
  renderVibesPriority();
}));

// Clima
$$("#climateChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#climateChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.climate = c.dataset.climate;
  const hint = $("#climateSeasonalHint");
  if (hint) hint.hidden = state.prefs.climate !== "seasonal";
}));

// Estilo explorador
$$("#explorerChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#explorerChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.explorerStyle = c.dataset.explorer;
  state.prefs.hiddenGems = state.prefs.explorerStyle !== "highlights";
}));

// Presupuesto, duración y distancia
$$("#budgetChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#budgetChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.budgetTier = c.dataset.budget;
  state.prefs.budget = BUDGET_ESTIMATE[state.prefs.budgetTier] ?? 550;
  applyStayTier();
}));
$$("#tripLengthChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#tripLengthChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.tripLength = c.dataset.trip;
  setTripDays(tripDaysRange(c.dataset.trip).defaultDays, c.dataset.trip);
  renderTripDays();
}));
$("#tripDaysDec")?.addEventListener("click", () => { setTripDays((state.prefs.days || 2) - 1); renderTripDays(); });
$("#tripDaysInc")?.addEventListener("click", () => { setTripDays((state.prefs.days || 2) + 1); renderTripDays(); });
$$("#travelRangeChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#travelRangeChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.travelRange = c.dataset.range;
}));

// Clima / ritmo
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

// Refinamiento post-destino (paso experiencia) — recalcula packs y precio
let refineTimer = null;
function scheduleRefineRefresh() {
  applyStayTier();
  clearTimeout(refineTimer);
  refineTimer = setTimeout(refreshExperienceTiers, 500);
}

async function refreshExperienceTiers() {
  if (!state.quote?.destinations?.length) return;
  try {
    const res = await fetch("/api/refine-tiers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefs: state.prefs,
        destinations: state.quote.destinations,
      }),
    });
    const data = await res.json();
    if (data.ok && Array.isArray(data.tiers)) {
      state.quote.tiers = data.tiers;
      if (data.prefs) state.prefs = { ...state.prefs, ...data.prefs };
      renderTiers();
      invalidateLivePrice();
      updateCalendarMin();
      renderCalendar();
      updateSummary();
      renderConfigStrip();
      if (state.selectedDate) refreshPrice();
    }
  } catch (err) {
    console.error("refine-tiers failed", err);
  }
}

function renderFoodInterests() {
  $$("#foodInterests .chip").forEach((chip) => {
    chip.classList.toggle("is-selected", state.prefs.foodInterests.includes(chip.dataset.food));
  });
}
$$("#foodInterests .chip").forEach((c) => c.addEventListener("click", () => {
  const f = c.dataset.food;
  const i = state.prefs.foodInterests.indexOf(f);
  if (i >= 0) state.prefs.foodInterests.splice(i, 1);
  else state.prefs.foodInterests.push(f);
  renderFoodInterests();
  scheduleRefineRefresh();
}));
$$("#dietaryChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#dietaryChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.dietary = c.dataset.diet;
  scheduleRefineRefresh();
}));
$$("#accommodationChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#accommodationChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.accommodation = c.dataset.accom;
  scheduleRefineRefresh();
}));
$$("#comfortChoice .choice").forEach((c) => c.addEventListener("click", () => {
  $$("#comfortChoice .choice").forEach((x) => x.classList.remove("is-selected"));
  c.classList.add("is-selected");
  state.prefs.comfortLevel = c.dataset.comfort;
  scheduleRefineRefresh();
}));

const BUDGET_LABELS_UI = { budget: "Económico", mid: "Medio", premium: "Premium", luxury: "Lujo" };
const STAY_LABELS = { comodo: "Cómodo", boutique: "Boutique", villa: "Villa & Lujo" };
const RANGE_LABELS_UI = { short: "Vuelo corto", medium: "Media distancia", long: "Largo recorrido", anywhere: "Cualquier sitio" };
const EXPLORER_LABELS_UI = { highlights: "Icónicos", hidden: "Joyas escondidas", balanced: "Equilibrado" };
const PACE_LABELS_UI = { relax: "Relax", balanced: "Equilibrado", adventure: "Aventura" };

function clonePrefs(p = state.prefs) {
  return JSON.parse(JSON.stringify(p));
}

function syncDraftDerived(draft) {
  const r = TRIP_DAYS_RANGE[draft.tripLength] || TRIP_DAYS_RANGE.short;
  const days = Math.max(r.minDays, Math.min(r.maxDays, draft.days ?? r.defaultDays));
  draft.days = days;
  draft.nights = days - 1;
  if (!state.stayTierLocked) {
    draft.stayTier = BUDGET_STAY[draft.budgetTier] ?? "boutique";
  }
  draft.hiddenGems = draft.explorerStyle !== "highlights";
  applyStayTierToDraft(draft);
}

function applyStayTierToDraft(draft) {
  if (state.stayTierLocked && draft.stayTier) return;
  let stay = BUDGET_STAY[draft.budgetTier] ?? "boutique";
  if (draft.accommodation && draft.accommodation !== "any") {
    stay = ACCOM_STAY[draft.accommodation] ?? stay;
  }
  if (draft.comfortLevel === "comfort") stay = "villa";
  else if (draft.comfortLevel === "authentic") stay = "comodo";
  draft.stayTier = stay;
}

function setDraftDays(days, draft = state.adjustDraft) {
  if (!draft) return days;
  const r = TRIP_DAYS_RANGE[draft.tripLength] || TRIP_DAYS_RANGE.short;
  draft.days = Math.max(r.minDays, Math.min(r.maxDays, days));
  draft.nights = draft.days - 1;
  return draft.days;
}

/* ===================== Ajustar propuesta ===================== */
function openAdjustPanel() {
  if (!state.quote) return;
  state.adjustBaseline = clonePrefs(state.prefs);
  state.adjustDraft = clonePrefs(state.prefs);
  state.adjustDraft.budgetManual = true;
  state.stayTierLocked = false;
  state.adjustPreview = null;
  renderAdjustPanel();
  const drawer = $("#adjustDrawer");
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  scheduleAdjustPreview();
}

function closeAdjustPanel() {
  const drawer = $("#adjustDrawer");
  if (drawer) { drawer.hidden = true; drawer.setAttribute("aria-hidden", "true"); }
  document.body.style.overflow = "";
  state.adjustDraft = null;
  state.adjustBaseline = null;
  const err = $("#adjustError");
  if (err) err.hidden = true;
}

function renderAdjustStayTiers() {
  const wrap = $("#adjStayTiers");
  if (!wrap || !state.adjustDraft) return;
  const tiers = state.quote?.stayTiers || [];
  wrap.innerHTML = tiers.map((t) => `
    <button type="button" class="stay-tier${state.adjustDraft.stayTier === t.id ? " is-selected" : ""}" data-stay="${t.id}">
      <span class="stay-stars">${"★".repeat(t.stars)}</span>
      <span class="stay-name">${t.name}</span>
      <span class="stay-price"><b>${t.priceLevel || "€"}</b> factor hotel ×${t.hotelFactor ?? 1}</span>
      <span class="stay-desc">${t.stayType || t.tagline || ""}</span>
    </button>`).join("");
  $$("#adjStayTiers .stay-tier").forEach((b) => b.addEventListener("click", () => {
    state.stayTierLocked = true;
    state.adjustDraft.stayTier = b.dataset.stay;
    const map = { comodo: ["hotel", "authentic"], boutique: ["boutique", "balanced"], villa: ["resort", "comfort"] };
    const [accom, comfort] = map[b.dataset.stay] || ["any", "balanced"];
    state.adjustDraft.accommodation = accom;
    state.adjustDraft.comfortLevel = comfort;
    renderAdjustPanel();
    onAdjustChange();
  }));
}

function renderAdjustPanel() {
  const d = state.adjustDraft;
  if (!d) return;
  syncDraftDerived(d);

  $$("#adjBudgetChoice .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.budget === d.budgetTier));
  const budgetIn = $("#adjBudgetInput");
  if (budgetIn) budgetIn.value = d.budget ?? "";

  $$("#adjTripLength .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.trip === d.tripLength));
  const daysIn = $("#adjTripDays");
  const daysHint = $("#adjDaysHint");
  const r = TRIP_DAYS_RANGE[d.tripLength] || TRIP_DAYS_RANGE.short;
  if (daysIn) daysIn.value = d.days;
  if (daysHint) daysHint.textContent = `${r.minDays}–${r.maxDays} días · ${d.nights} ${d.nights === 1 ? "noche" : "noches"}`;
  $("#adjDaysDec") && ($("#adjDaysDec").disabled = d.days <= r.minDays);
  $("#adjDaysInc") && ($("#adjDaysInc").disabled = d.days >= r.maxDays);

  renderAdjustStayTiers();

  $$("#adjTravelRange .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.range === d.travelRange));
  $$("#adjExplorer .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.explorer === d.explorerStyle));
  $$("#adjPace .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.pace === d.pace));

  $$("#adjFoodInterests .chip").forEach((c) => c.classList.toggle("is-selected", (d.foodInterests || []).includes(c.dataset.food)));
  $$("#adjDietary .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.diet === d.dietary));
  $$("#adjComfort .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.comfort === d.comfortLevel));
}

function onAdjustChange() {
  renderAdjustPanel();
  scheduleAdjustPreview();
}

function scheduleAdjustPreview() {
  clearTimeout(state.adjustPreviewTimer);
  const loading = $("#adjustPreviewLoading");
  if (loading) loading.hidden = false;
  state.adjustPreviewTimer = setTimeout(refreshAdjustPreview, 400);
}

async function refreshAdjustPreview() {
  if (!state.adjustDraft || !state.quote) return;
  const loading = $("#adjustPreviewLoading");
  try {
    syncDraftDerived(state.adjustDraft);
    const res = await fetch("/api/adjust-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefs: state.adjustDraft,
        baseline: state.adjustBaseline,
        destinations: state.quote.destinations,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      state.adjustPreview = data;
      renderAdjustPreview(data);
    }
  } catch (err) {
    console.error("adjust-preview failed", err);
  } finally {
    if (loading) loading.hidden = true;
  }
}

function renderAdjustPreview(data) {
  const body = $("#adjustPreviewBody");
  const minEl = $("#adjBudgetMin");
  const calMin = data.calendarMinPerPerson ?? data.minBudgetPerPerson;
  const calMinDate = data.calendarMinDate;

  $("#adjCalMinValue").textContent = Number.isFinite(calMin) ? `${euro(calMin)}/persona` : "—";
  const dateEl = $("#adjCalMinDate");
  if (dateEl) {
    dateEl.textContent = calMinDate
      ? ` · salida ${new Date(calMinDate + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })}`
      : "";
  }

  const budgetIn = $("#adjBudgetInput");
  const dec = $("#adjBudgetDec");
  const inc = $("#adjBudgetInc");
  if (state.adjustDraft && Number.isFinite(calMin)) {
    budgetIn.min = calMin;
    if (!state.adjustDraft.budgetManual) {
      state.adjustDraft.budget = Math.max(calMin, state.adjustDraft.budget || calMin);
    } else if (state.adjustDraft.budget < calMin) {
      state.adjustDraft.budget = calMin;
    }
    if (budgetIn) budgetIn.value = state.adjustDraft.budget;
    if (dec) dec.disabled = state.adjustDraft.budget <= calMin;
  }
  if (minEl) {
    minEl.innerHTML = Number.isFinite(calMin)
      ? `No puedes bajar de <b>${euro(calMin)}/persona</b> — es el mínimo del calendario con esta configuración.`
      : "";
  }

  if (!body) return;
  let html = "";
  if (data.impacts?.length) {
    html += `<ul class="adjust-impacts">${data.impacts.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  }
  if (data.requiresNewQuote) {
    html += `<span class="adjust-badge-new">Generará destinos y precios nuevos</span>`;
  } else if (Number.isFinite(calMin)) {
    html += `<span class="adjust-preview-note">Los destinos se mantienen; el calendario se recalculará con tu nuevo tope.</span>`;
  }
  body.innerHTML = html;
}

function renderConfigStrip() {
  const strip = $("#configStrip");
  if (!strip || !state.quote) return;
  const p = state.prefs;
  const stay = (state.quote.stayTiers || []).find((t) => t.id === p.stayTier);
  const calMin = state.calendarMin;
  strip.hidden = false;
  strip.innerHTML = `
    <span class="config-chip">📅 <b>${p.days || p.nights + 1}</b> días</span>
    <span class="config-chip">🏨 <b>${stay?.name || STAY_LABELS[p.stayTier] || "Boutique"}</b></span>
    <span class="config-chip">💶 desde <b>${Number.isFinite(calMin) ? euro(calMin) : "—"}</b>/p</span>
    ${Number.isFinite(p.budget) ? `<span class="config-chip">tope <b>${euro(p.budget)}</b>/p</span>` : ""}
    <span class="config-chip">✈️ ${RANGE_LABELS_UI[p.travelRange] || "Media distancia"}</span>
    <button type="button" class="config-strip-edit" id="configStripEdit">Ajustar →</button>`;
  $("#configStripEdit")?.addEventListener("click", openAdjustPanel);
}

function syncRefineUIFromPrefs() {
  renderFoodInterests();
  $$("#dietaryChoice .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.diet === state.prefs.dietary));
  $$("#accommodationChoice .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.accom === state.prefs.accommodation));
  $$("#comfortChoice .choice").forEach((c) => c.classList.toggle("is-selected", c.dataset.comfort === state.prefs.comfortLevel));
}

async function applyAdjustDraft() {
  if (!state.adjustDraft || state.adjustApplying) return;
  const err = $("#adjustError");
  const btn = $("#adjustApply");
  syncDraftDerived(state.adjustDraft);

  const min = state.adjustPreview?.calendarMinPerPerson ?? state.adjustPreview?.minBudgetPerPerson;
  const budgetVal = parseInt($("#adjBudgetInput")?.value, 10);
  if (Number.isFinite(budgetVal) && budgetVal > 0) state.adjustDraft.budget = budgetVal;
  if (Number.isFinite(min) && state.adjustDraft.budget < min) {
    if (err) {
      err.textContent = `El presupuesto mínimo con esta configuración es ${euro(min)}/persona. Súbelo o reduce la calidad/duración.`;
      err.hidden = false;
    }
    return;
  }
  if (err) err.hidden = true;

  state.adjustApplying = true;
  if (btn) { btn.disabled = true; btn.textContent = "Generando propuesta…"; }

  Object.assign(state.prefs, state.adjustDraft);
  const savedBudget = state.adjustDraft.budget;
  syncDerivedPrefs();
  closeAdjustPanel();

  $("#loading").hidden = false;
  $("#results").hidden = true;
  $("#summaryBar").hidden = true;

  try {
    const res = await fetch("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.prefs),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error");
    state.quote = data;
    state.prefs = data.prefs;
    if (Number.isFinite(savedBudget)) state.prefs.budget = savedBudget;
    state.minBudget = Number.isFinite(data.minBudgetPerPerson) ? data.minBudgetPerPerson : null;
    state.discarded = new Set();
    state.selectedDate = null;
    state.livePrice = null;
    state.livePriceKey = null;
    state.priceLoading = false;
    Object.keys(priceCache).forEach((k) => delete priceCache[k]);
    state.selectedTier = "none";
    state.calMonth = startMonth(minDate());
    $("#loading").hidden = true;
    updateCalendarMin();
    syncRefineUIFromPrefs();
    renderResults();
    $("#results").hidden = false;
    $("#summaryBar").hidden = false;
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    $("#loading").hidden = true;
    $("#results").hidden = false;
    alert("No hemos podido generar la nueva propuesta. Inténtalo de nuevo.");
    console.error(e);
  } finally {
    state.adjustApplying = false;
    if (btn) { btn.disabled = false; btn.textContent = "Generar nueva propuesta"; }
  }
}

// Eventos del drawer de ajuste
$("#openAdjust")?.addEventListener("click", openAdjustPanel);
$("#adjustClose")?.addEventListener("click", closeAdjustPanel);
$("#adjustCancel")?.addEventListener("click", closeAdjustPanel);
$("#adjustBackdrop")?.addEventListener("click", closeAdjustPanel);
$("#adjustApply")?.addEventListener("click", applyAdjustDraft);

$$("#adjBudgetChoice .choice").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  state.stayTierLocked = false;
  state.adjustDraft.budgetTier = c.dataset.budget;
  state.adjustDraft.budgetManual = false;
  onAdjustChange();
}));
function setAdjustBudget(val, manual = true) {
  if (!state.adjustDraft) return;
  const min = state.adjustPreview?.calendarMinPerPerson ?? state.adjustPreview?.minBudgetPerPerson ?? 50;
  const v = Math.max(min, Math.round(val / 5) * 5);
  state.adjustDraft.budget = v;
  if (manual) state.adjustDraft.budgetManual = true;
  const budgetIn = $("#adjBudgetInput");
  if (budgetIn) budgetIn.value = v;
  $("#adjBudgetDec") && ($("#adjBudgetDec").disabled = v <= min);
  scheduleAdjustPreview();
}
$("#adjBudgetInput")?.addEventListener("input", (e) => {
  if (!state.adjustDraft) return;
  const v = parseInt(e.target.value, 10);
  if (Number.isFinite(v) && v > 0) {
    state.adjustDraft.budget = v;
    state.adjustDraft.budgetManual = true;
  }
  scheduleAdjustPreview();
});
$("#adjBudgetDec")?.addEventListener("click", () => {
  setAdjustBudget((state.adjustDraft?.budget || 0) - 5);
});
$("#adjBudgetInc")?.addEventListener("click", () => {
  setAdjustBudget((state.adjustDraft?.budget || 0) + 5);
});
$$("#adjTripLength .choice").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  state.adjustDraft.tripLength = c.dataset.trip;
  setDraftDays(TRIP_DAYS_RANGE[c.dataset.trip].defaultDays);
  onAdjustChange();
}));
$("#adjDaysDec")?.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  setDraftDays(state.adjustDraft.days - 1);
  onAdjustChange();
});
$("#adjDaysInc")?.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  setDraftDays(state.adjustDraft.days + 1);
  onAdjustChange();
});
$$("#adjTravelRange .choice").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  state.adjustDraft.travelRange = c.dataset.range;
  onAdjustChange();
}));
$$("#adjExplorer .choice").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  state.adjustDraft.explorerStyle = c.dataset.explorer;
  onAdjustChange();
}));
$$("#adjPace .choice").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  state.adjustDraft.pace = c.dataset.pace;
  onAdjustChange();
}));
$$("#adjFoodInterests .chip").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  const f = c.dataset.food;
  const arr = state.adjustDraft.foodInterests || (state.adjustDraft.foodInterests = []);
  const i = arr.indexOf(f);
  if (i >= 0) arr.splice(i, 1); else arr.push(f);
  onAdjustChange();
}));
$$("#adjDietary .choice").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  state.adjustDraft.dietary = c.dataset.diet;
  onAdjustChange();
}));
$$("#adjComfort .choice").forEach((c) => c.addEventListener("click", () => {
  if (!state.adjustDraft) return;
  state.stayTierLocked = false;
  state.adjustDraft.comfortLevel = c.dataset.comfort;
  onAdjustChange();
}));

/* ===================== Cotización ===================== */
async function submitQuiz() {
  syncDerivedPrefs();
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
    state.livePrice = null;
    state.livePriceKey = null;
    state.priceLoading = false;
    Object.keys(priceCache).forEach((k) => delete priceCache[k]);
    state.selectedTier = "none";
    state.calMonth = startMonth(minDate());
    $("#loading").hidden = true;
    renderResults();
    $("#results").hidden = false;
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
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
  updateCalendarMin();
  renderConfigStrip();
  syncRefineUIFromPrefs();
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
  const needsPrice = !!state.selectedDate && state.livePriceKey !== priceKey();
  if (state.priceLoading) {
    next.textContent = "Comprobando precio…";
    next.disabled = true;
    return;
  }
  if (state.resultStep === RSTEPS - 1) {
    next.textContent = "Reservar a ciegas";
    next.disabled = !state.selectedDate || needsPrice;
  } else {
    next.textContent = "Siguiente →";
    next.disabled = (state.resultStep === 0 && !state.selectedDate) || needsPrice;
  }
}
$("#rPrev").addEventListener("click", () => { if (state.resultStep > 0) showResultStep(state.resultStep - 1); });
$("#rNext").addEventListener("click", async () => {
  if (!state.selectedDate) { showResultStep(0); return; }
  const ok = await ensureFreshPrice();
  if (!ok) return;
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

    const disabled = !isDiscarded && (limitReached || onlyOneLeft);

    el.innerHTML = `
      ${img}
      ${gem}
      <button class="dest-discard${disabled ? " is-disabled" : ""}" title="${isDiscarded ? "Recuperar destino" : disabled ? "Ya has descartado un destino" : "Descartar destino"}" data-id="${d.id}"${disabled ? " disabled" : ""}>${isDiscarded ? "↺" : "✕"}</button>
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
      if (state.discarded.size >= MAX_DISCARDS) return;
      if (activeDestinations().length <= 1) return;      // no descartar el último
      state.discarded.add(id);
    }
    renderDestinations();
    renderCalendar();
    invalidateLivePrice();
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
    invalidateLivePrice();
    renderTiers(); renderCalendar(); updateSummary(); refreshPrice();
  }));
}

function currentTier() {
  if (state.selectedTier === "none") return { id: "none", name: "Solo vuelo + hotel", perPersonCost: 0, pricePerPerson: 0 };
  return state.quote.tiers.find((t) => t.id === state.selectedTier) || { id: "none", perPersonCost: 0, pricePerPerson: 0 };
}

/* ===================== Motor de precios (idéntico al servidor) ===================== */
function isWeekend(dateStr) { const d = new Date(dateStr + "T12:00:00").getDay(); return d === 5 || d === 6; }
function monthIndex(dateStr) { return new Date(dateStr + "T12:00:00").getMonth(); }

// Factor del nivel de alojamiento para unos prefs concretos.
function stayFactorFor(prefs = state.prefs) {
  const tiers = state.quote?.stayTiers || [];
  const t = tiers.find((x) => x.id === prefs.stayTier)
    || tiers.find((x) => x.recommended) || tiers[0];
  return t ? t.hotelFactor : 1;
}

function providerCharged(dest, dateStr, prefs = state.prefs) {
  const p = state.quote.pricing;
  const m = monthIndex(dateStr);
  const season = dest.seasonality[m];
  const weekend = isWeekend(dateStr) ? 1 + p.weekendPremium : 1;
  const nights = prefs.nights;
  const travelers = prefs.travelers;
  const rooms = Math.ceil(travelers / p.peoplePerRoom);
  const sf = stayFactorFor(prefs);

  const flight = dest.flightPerPerson * season * weekend * travelers * p.markups.flight;
  const hotel = dest.hotelPerNight * sf * season * nights * rooms * p.markups.hotel;
  const transfer = dest.transferCost * travelers * p.markups.transfer;
  return flight + hotel + transfer;
}

// Precio sorpresa (ancla) idéntico al calendario.
function surpriseCharged(dateStr, tier, prefs = state.prefs, destinations = state.quote?.destinations) {
  const p = state.quote.pricing;
  const dests = destinations || [];
  const all = dests.map((d) => providerCharged(d, dateStr, prefs));
  const base = percentile(all, p.anchorPercentile ?? 0.5);
  const activity = (tier.pricePerPerson ?? (tier.perPersonCost || 0)) * prefs.travelers;
  return roundUpTo(base + activity, 10);
}

// Mínimo del calendario (misma fórmula que las celdas) para unos prefs/destinos.
function calendarMinPerPerson(prefs = state.prefs, destinations = state.quote?.destinations) {
  const dests = destinations || [];
  if (!dests.length) return null;
  const tier = { perPersonCost: 0, pricePerPerson: 0 };
  const start = minDate();
  start.setHours(0, 0, 0, 0);
  let lowest = Infinity;
  let lowestDate = null;
  for (let i = 0; i < 365; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const ds = fmt(d);
    const per = roundUpTo(surpriseCharged(ds, tier, prefs, dests) / prefs.travelers, 5);
    if (per < lowest) { lowest = per; lowestDate = ds; }
  }
  return Number.isFinite(lowest) ? { min: lowest, minDate: lowestDate } : null;
}

function updateCalendarMin() {
  const r = calendarMinPerPerson();
  state.calendarMin = r?.min ?? null;
  state.calendarMinDate = r?.minDate ?? null;
  if (Number.isFinite(state.calendarMin) && (!Number.isFinite(state.prefs.budget) || state.prefs.budget < state.calendarMin)) {
    state.prefs.budget = state.calendarMin;
  }
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
  const days = state.prefs.days || nights + 1;
  cap.innerHTML = `🧳 Tu viaje: <b>${start}</b> → <b>${end}</b> · ${days} días, ${nights} ${nights === 1 ? "noche" : "noches"} (resaltados en el calendario)`;
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
      const calMin = state.calendarMin;
      const minNote = Number.isFinite(calMin) ? `Mejor precio: <b>${euro(calMin)}</b>/persona · ` : "";
      budgetEl.innerHTML = `💶 ${minNote}Tope: <b>${euro(state.prefs.budget)}/persona</b> · <button type="button" class="cal-budget-edit" id="calBudgetEdit">ajustar</button> · los días por encima del tope aparecen atenuados.`;
      const editBtn = $("#calBudgetEdit");
      if (editBtn) editBtn.addEventListener("click", openAdjustPanel);
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
        invalidateLivePrice();
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
    $("#summaryLine").textContent = `${state.prefs.travelers} viajeros · ${state.prefs.days || state.prefs.nights + 1} días · ${stayName ? stayName + " · " : ""}${tierName}`;
    $("#summaryTotal").textContent = "Elige fecha";
    $("#summaryPer").textContent = "";
    updateResultNav();
    return;
  }
  const fee = discardFeeTotal();
  const d = new Date(state.selectedDate + "T12:00:00");
  const dateLabel = d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "long" });
  const feeNote = fee > 0 ? ` · cambio de destino +${euro(fee)}` : "";
  const hasLivePrice = state.livePrice && state.livePriceKey === priceKey();
  const per = hasLivePrice ? state.livePrice.perPerson : null;
  const overBudget = Number.isFinite(state.prefs.budget) && Number.isFinite(per) && per > state.prefs.budget;
  const budgetNote = overBudget ? ` · ⚠️ sobre tu presupuesto (${euro(state.prefs.budget)}/p)` : "";
  $("#summaryLine").textContent = `${dateLabel} · ${state.prefs.travelers} viajeros · ${stayName ? stayName + " · " : ""}${tierName}${feeNote}${budgetNote}`;
  if (hasLivePrice) {
    $("#summaryTotal").textContent = euro(state.livePrice.total);
    $("#summaryPer").textContent = `· ${euro(per)}/persona${firmPriceLabel(state.livePrice)}`;
  } else {
    $("#summaryTotal").textContent = state.priceLoading ? "Comprobando…" : "Pendiente";
    $("#summaryPer").textContent = "· confirma precio para continuar";
  }
  updateResultNav();
}

// Recalcula el precio EN FIRME para la fecha elegida (vuelo + hotel reales de
// RouteStack, o Amadeus si no hay RouteStack). Muestra primero la estimación
// del calendario y la sustituye cuando llega el precio definitivo.
async function refreshPrice() {
  if (!state.selectedDate) return false;
  const key = priceKey();
  if (priceCache[key]) { applyLivePrice(priceCache[key]); return true; }

  const totalEl = $("#summaryTotal");
  const perEl = $("#summaryPer");
  state.priceLoading = true;
  if (totalEl) totalEl.classList.add("is-checking");
  if (perEl) perEl.textContent = "· comprobando precio…";
  updateResultNav();

  const seq = ++priceReqSeq;
  try {
    const res = await fetch("/api/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefs: state.prefs,
        date: state.selectedDate,
        tierId: state.selectedTier === "none" ? "none" : state.selectedTier,
        tier: currentTier(),
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
      return true;
    } else {
      updateSummary();
    }
  } catch (err) {
    console.error(err);
    if (seq === priceReqSeq) updateSummary();
  } finally {
    if (seq === priceReqSeq) state.priceLoading = false;
    if (seq === priceReqSeq && totalEl) totalEl.classList.remove("is-checking");
    if (seq === priceReqSeq && state.livePriceKey !== priceKey()) updateSummary();
    if (seq === priceReqSeq) updateResultNav();
  }
  return false;
}

function firmPriceLabel(data) {
  if (!data?.live) return "";
  return data.provider === "routestack" ? " · precio en firme · RouteStack" : " · precio en firme";
}

function applyLivePrice(data) {
  if (!state.selectedDate) return;
  const totalEl = $("#summaryTotal");
  const perEl = $("#summaryPer");
  state.livePrice = data;
  state.livePriceKey = priceKey();
  if (totalEl) { totalEl.textContent = euro(data.total); totalEl.classList.remove("is-checking"); }
  if (perEl) {
    const per = data.perPerson ?? roundUpTo(data.total / state.prefs.travelers, 5);
    perEl.textContent = `· ${euro(per)}/persona${firmPriceLabel(data)}`;
  }
  updateResultNav();
}

function invalidateLivePrice() {
  state.livePrice = null;
  state.livePriceKey = null;
}

async function ensureFreshPrice() {
  if (!state.selectedDate) return false;
  if (state.livePriceKey === priceKey()) return true;
  updateSummary();
  return refreshPrice();
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
        tier: currentTier(),
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

function renderReferences(refs) {
  if (!refs || refs.provider !== "routestack") return "";
  const line = (label, value) => (value ? `<div class="hotel-meta"><b>${label}</b> ${value}</div>` : "");
  return `<div class="cart-includes">
    <div class="cart-includes-head"><h5>Referencias RouteStack</h5></div>
    <p class="cart-acts-hint">Códigos del inventario en vivo de este vuelo y este hotel.</p>
    ${line("Salida", [refs.originAirport, refs.originAirportName].filter(Boolean).join(" · "))}
    ${line("Llegada", [refs.destinationAirport, refs.destinationAirportName].filter(Boolean).join(" · "))}
    ${line("Destino", [refs.destinationName, refs.destinationId].filter(Boolean).join(" · "))}
    ${line("Búsqueda de vuelo", refs.flightCorrelationId)}
    ${line("Hotel", refs.hotelId)}
  </div>`;
}

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
          ${b.flightHotel.outbound.stops ? `<div class="hotel-meta">${b.flightHotel.outbound.stops} escala${b.flightHotel.outbound.stops > 1 ? "s" : ""} a la ida</div>` : ""}
          <div class="flight-leg">
            <div><b>${b.flightHotel.inbound.dep}</b> → ${b.flightHotel.inbound.arr}
              <div class="flight-route">${b.flightHotel.inbound.from} → ${b.flightHotel.inbound.to}</div></div>
            <div style="text-align:right">${b.flightHotel.inbound.airline}<br><small>${b.flightHotel.inbound.flightNo}</small></div>
          </div>
          ${b.flightHotel.inbound.stops ? `<div class="hotel-meta">${b.flightHotel.inbound.stops} escala${b.flightHotel.inbound.stops > 1 ? "s" : ""} a la vuelta</div>` : ""}
          <div class="price-chip">Vuelo para esta fecha · <b>${euro(ch.flight)}</b></div>
        </div>
        <div class="book-box">
          <h5>🏨 Hotel · ${b.nights} noches${b.stay ? ` · ${b.stay.name}` : ""}</h5>
          <div class="hotel-name">${b.flightHotel.hotel.name}</div>
          <div class="hotel-meta"><span class="stars">${stars(b.flightHotel.hotel.stars)}</span> · ${b.flightHotel.hotel.neighborhood}</div>
          ${b.flightHotel.hotel.stayType ? `<div class="hotel-meta">${b.flightHotel.hotel.stayType}</div>` : ""}
          ${b.flightHotel.hotel.rating ? `<div class="hotel-meta">Valoración ${b.flightHotel.hotel.rating}/10</div>` : ""}
          ${b.flightHotel.hotel.reference ? `<div class="hotel-meta">Ref. hotel ${b.flightHotel.hotel.reference}</div>` : ""}
          <div class="price-chip">Hotel ${b.nights} noches · <b>${euro(ch.hotel)}</b></div>
        </div>
      </div>
      ${renderReferences(b.flightHotel.references)}

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
          <div class="finance-head">🔒 Precio y margen ${f.live ? "en firme" : "estimados"}${f.provider === "routestack" ? " · RouteStack" : ""} para estas fechas</div>
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
renderVibesPriority();
renderFoodInterests();
renderTripDays();
syncDerivedPrefs();
showStep(0);
