/* ===================== Defy · Auth + widget de cuenta =====================
   Módulo compartido por todas las páginas. Gestiona el estado de sesión,
   pinta el widget de cuenta en la barra de navegación (cualquier elemento con
   [data-acct-slot]) y abre el modal de login / registro. Expone window.DefyAuth.
*/
(function () {
  const state = { user: null, rewards: [], levels: [], loaded: false };
  const listeners = new Set();
  const euro = (n) => new Intl.NumberFormat("es-ES").format(Math.round(n)) + " €";
  const fmtMiles = (n) => new Intl.NumberFormat("es-ES").format(Math.round(n || 0));

  /* ---------- API ---------- */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res.json();
  }

  async function refresh() {
    try {
      const data = await api("/api/auth/me");
      state.user = data.user || null;
      state.rewards = data.rewards || [];
      state.levels = data.levels || [];
    } catch (e) {
      state.user = null;
    }
    state.loaded = true;
    emit();
  }

  function emit() {
    renderWidgets();
    listeners.forEach((cb) => { try { cb(state.user); } catch (e) {} });
  }

  /* ---------- Widget en la barra ---------- */
  function renderWidgets() {
    document.querySelectorAll("[data-acct-slot]").forEach((slot) => {
      slot.innerHTML = "";
      if (state.user) {
        const a = document.createElement("a");
        a.href = "/cuenta";
        a.className = "acct-pill";
        a.innerHTML =
          `<span class="acct-pill-ic">${state.user.level?.icon || "🧭"}</span>` +
          `<span class="acct-pill-info"><b>${escapeHtml(firstName(state.user.name))}</b>` +
          `<small>✦ ${fmtMiles(state.user.miles)} millas</small></span>`;
        slot.appendChild(a);
      } else {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "acct-btn";
        b.textContent = "Entrar / Unirme";
        b.addEventListener("click", () => openModal("register"));
        slot.appendChild(b);
      }
    });
  }

  function firstName(name) { return String(name || "").trim().split(/\s+/)[0] || "Tú"; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- Modal ---------- */
  let modal = null;
  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "auth-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="auth-card" role="dialog" aria-modal="true">
        <button class="auth-close" aria-label="Cerrar">✕</button>
        <div class="auth-brand"><span class="brand-mark">◆</span> Pasaporte Defy</div>
        <p class="auth-tagline">Únete gratis y empieza con <b>500 millas</b> de bienvenida. Sube de nivel con cada escapada y canjea descuentos y experiencias.</p>
        <div class="auth-tabs">
          <button class="auth-tab" data-mode="login">Iniciar sesión</button>
          <button class="auth-tab" data-mode="register">Crear cuenta</button>
        </div>
        <form class="auth-form">
          <label class="auth-field auth-name"><span>Nombre</span>
            <input type="text" name="name" autocomplete="given-name" placeholder="¿Cómo te llamas?" /></label>
          <label class="auth-field"><span>Email</span>
            <input type="email" name="email" autocomplete="email" placeholder="tu@email.com" required /></label>
          <label class="auth-field"><span>Contraseña</span>
            <input type="password" name="password" autocomplete="current-password" placeholder="Mínimo 6 caracteres" required /></label>
          <p class="auth-error" hidden></p>
          <button type="submit" class="btn btn-primary btn-lg auth-submit">Continuar</button>
        </form>
        <p class="auth-perks">✦ 500 millas de bienvenida · 🗺️ niveles con ventajas · 🎁 recompensas sorpresa</p>
      </div>`;
    document.body.appendChild(modal);

    const card = modal.querySelector(".auth-card");
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    modal.querySelector(".auth-close").addEventListener("click", closeModal);
    modal.querySelectorAll(".auth-tab").forEach((t) =>
      t.addEventListener("click", () => setMode(t.dataset.mode)));
    modal.querySelector(".auth-form").addEventListener("submit", onSubmit);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });
    return modal;
  }

  let mode = "register";
  function setMode(m) {
    mode = m;
    ensureModal();
    modal.querySelectorAll(".auth-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.mode === m));
    modal.querySelector(".auth-name").style.display = m === "register" ? "" : "none";
    modal.querySelector('[name="name"]').required = m === "register";
    modal.querySelector('[name="password"]').autocomplete = m === "register" ? "new-password" : "current-password";
    modal.querySelector(".auth-submit").textContent = m === "register" ? "Crear mi cuenta gratis" : "Entrar";
    const err = modal.querySelector(".auth-error"); err.hidden = true; err.textContent = "";
  }

  function openModal(m = "register") {
    ensureModal();
    setMode(m);
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => modal.querySelector(mode === "register" ? '[name="name"]' : '[name="email"]')?.focus(), 60);
  }
  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const err = modal.querySelector(".auth-error");
    const submit = modal.querySelector(".auth-submit");
    const body = {
      email: form.email.value,
      password: form.password.value,
      name: form.name.value,
    };
    err.hidden = true;
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = "Un momento…";
    try {
      const data = await api(mode === "register" ? "/api/auth/register" : "/api/auth/login", { method: "POST", body });
      if (!data.ok) throw new Error(data.error || "No se pudo completar.");
      state.user = data.user;
      await refresh();
      closeModal();
      pendingResolve && pendingResolve(state.user);
      pendingResolve = null;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    await refresh();
  }

  /* ---------- API pública ---------- */
  let pendingResolve = null;
  // Garantiza que hay sesión; si no, abre el modal y resuelve cuando entra.
  function requireAuth(m = "register") {
    if (state.user) return Promise.resolve(state.user);
    openModal(m);
    return new Promise((resolve) => { pendingResolve = resolve; });
  }

  window.DefyAuth = {
    get user() { return state.user; },
    get rewards() { return state.rewards; },
    get levels() { return state.levels; },
    get loaded() { return state.loaded; },
    refresh,
    openModal,
    closeModal,
    logout,
    requireAuth,
    setUser(u) { state.user = u; emit(); },
    onChange(cb) { listeners.add(cb); if (state.loaded) cb(state.user); return () => listeners.delete(cb); },
    fmtMiles,
    euro,
  };

  refresh();
})();
