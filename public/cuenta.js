/* ===================== Pasaporte Defy · dashboard ===================== */
const $ = (s, r = document) => r.querySelector(s);
const fmtMiles = (n) => new Intl.NumberFormat("es-ES").format(Math.round(n || 0));

const guest = $("#accountGuest");
const dash = $("#accountDash");

function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast is-" + kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3400);
}

function render(user) {
  if (!DefyAuth.loaded) return;
  if (!user) {
    guest.hidden = false;
    dash.hidden = true;
    return;
  }
  guest.hidden = true;
  dash.hidden = false;
  renderPassport(user);
  renderLevels(user);
  renderRewards(user);
  renderVouchers(user);
  renderHistory(user);
}

/* ---------- Tarjeta-pasaporte ---------- */
function renderPassport(u) {
  const lvl = u.level || {};
  const next = u.nextLevel;
  const progress = u.progressPct ?? 0;
  const nextLine = next
    ? `<span class="passport-next">A <b>${next.icon} ${next.name}</b> te faltan <b>${fmtMiles(u.milesToNext)}</b> millas</span>`
    : `<span class="passport-next">Has alcanzado el nivel máximo. Eres una <b>Leyenda</b> 👑</span>`;

  $("#passport").innerHTML = `
    <div class="passport-glow"></div>
    <div class="passport-top">
      <div class="passport-id">
        <span class="passport-label">Pasaporte Defy</span>
        <span class="passport-name">${escapeHtml(u.name)}</span>
      </div>
      <div class="passport-level">
        <span class="passport-level-ic">${lvl.icon || "🧭"}</span>
        <span class="passport-level-name">${lvl.name || "Curioso"}</span>
      </div>
    </div>

    <div class="passport-miles">
      <div class="passport-miles-main">
        <span class="passport-miles-num">${fmtMiles(u.miles)}</span>
        <span class="passport-miles-unit">millas disponibles</span>
      </div>
      <div class="passport-stamps">
        <span class="stamp-num">${u.trips || 0}</span>
        <span class="stamp-label">${u.trips === 1 ? "sello" : "sellos"} de viaje</span>
      </div>
    </div>

    <div class="passport-progress">
      <div class="passport-progress-bar"><span style="width:${progress}%"></span></div>
      ${nextLine}
    </div>

    <div class="passport-perks">
      ${(lvl.perks || []).map((p) => `<span class="perk-chip">✓ ${escapeHtml(p)}</span>`).join("")}
    </div>
  `;
}

/* ---------- Niveles ---------- */
function renderLevels(u) {
  const track = $("#levelsTrack");
  const levels = DefyAuth.levels || [];
  const currentId = u.level?.id;
  track.innerHTML = levels.map((l) => {
    const reached = (u.milesEarned || 0) >= l.minMiles;
    const isCurrent = l.id === currentId;
    return `
      <div class="level-card${reached ? " reached" : ""}${isCurrent ? " current" : ""}">
        <div class="level-card-ic">${l.icon}</div>
        <div class="level-card-name">${l.name}</div>
        <div class="level-card-req">${l.minMiles === 0 ? "Desde el día 1" : "Desde " + fmtMiles(l.minMiles) + " millas"}</div>
        <ul class="level-card-perks">${(l.perks || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
        ${isCurrent ? `<span class="level-card-tag">Estás aquí</span>` : reached ? `<span class="level-card-tag done">Conseguido</span>` : ""}
      </div>`;
  }).join("");
}

/* ---------- Canje ---------- */
function renderRewards(u) {
  const grid = $("#rewardsGrid");
  const rewards = DefyAuth.rewards || [];
  grid.innerHTML = rewards.map((r) => {
    const affordable = (u.miles || 0) >= r.cost;
    return `
      <article class="reward-card${affordable ? "" : " locked"}">
        <div class="reward-ic">${r.icon}</div>
        <h3 class="reward-name">${r.name}</h3>
        <p class="reward-blurb">${r.blurb}</p>
        <div class="reward-foot">
          <span class="reward-cost">✦ ${fmtMiles(r.cost)} millas</span>
          <button class="btn btn-primary btn-pill reward-btn" data-reward="${r.id}" ${affordable ? "" : "disabled"}>
            ${affordable ? "Canjear" : "Te faltan " + fmtMiles(r.cost - (u.miles || 0))}
          </button>
        </div>
      </article>`;
  }).join("");

  grid.querySelectorAll(".reward-btn").forEach((b) => b.addEventListener("click", () => redeem(b.dataset.reward, b)));
}

async function redeem(rewardId, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Canjeando…";
  try {
    const res = await fetch("/api/rewards/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rewardId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "No se pudo canjear.");
    DefyAuth.setUser(data.user);
    toast(`🎉 ¡Canjeado! Tu código: ${data.voucher.id}`);
  } catch (e) {
    toast(e.message, "err");
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---------- Vouchers ---------- */
function renderVouchers(u) {
  const block = $("#vouchersBlock");
  const grid = $("#vouchersGrid");
  const vouchers = u.vouchers || [];
  if (!vouchers.length) { block.hidden = true; return; }
  block.hidden = false;
  grid.innerHTML = vouchers.map((v) => `
    <div class="voucher">
      <div class="voucher-ic">${v.icon}</div>
      <div class="voucher-info">
        <b>${v.name}</b>
        <span class="voucher-code">${v.id}</span>
      </div>
    </div>`).join("");
}

/* ---------- Historial ---------- */
function renderHistory(u) {
  const list = $("#historyList");
  const items = u.history || [];
  if (!items.length) { list.innerHTML = `<li class="history-empty">Aún no hay movimientos.</li>`; return; }
  list.innerHTML = items.map((h) => {
    const sign = h.miles > 0 ? "+" : "";
    const cls = h.miles > 0 ? "pos" : "neg";
    const date = new Date(h.ts).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
    return `
      <li class="history-row">
        <div class="history-main">
          <span class="history-label">${escapeHtml(h.label)}</span>
          <span class="history-date">${date}</span>
        </div>
        <span class="history-miles ${cls}">${sign}${fmtMiles(h.miles)} ✦</span>
      </li>`;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Eventos invitado ---------- */
$("#guestJoin").addEventListener("click", () => DefyAuth.openModal("register"));
$("#guestLogin").addEventListener("click", () => DefyAuth.openModal("login"));
$("#logoutBtn").addEventListener("click", async () => { await DefyAuth.logout(); toast("Sesión cerrada"); });

/* ---------- Init ---------- */
DefyAuth.onChange(render);
