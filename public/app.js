/* ===================== Helpers ===================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ===================== Nav: fondo al hacer scroll ===================== */
const nav = $("#nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 40);
  window.addEventListener("scroll", onScroll);
  onScroll();
}

/* ===================== Animaciones de entrada ===================== */
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
}, { threshold: 0.15 });
$$(".reveal").forEach((el) => io.observe(el));

/* ===================== Hero: rotación de vídeos / posters ===================== */
(function heroRotator() {
  const vids = $$(".hero-vid");
  if (vids.length <= 1) return;
  const dotsWrap = $("#heroDots");
  if (dotsWrap) {
    vids.forEach((_, i) => {
      const d = document.createElement("button");
      d.className = "hero-dot" + (i === 0 ? " is-on" : "");
      d.setAttribute("aria-label", `Escena ${i + 1}`);
      d.addEventListener("click", () => go(i));
      dotsWrap.appendChild(d);
    });
  }
  const dots = $$(".hero-dot");
  let cur = 0, timer = null;
  const DURATION = 6500;

  function go(next) {
    if (next === cur) return;
    const prev = vids[cur];
    const v = vids[next];
    try { v.play(); } catch (e) {}
    v.classList.add("is-active");
    dots[cur]?.classList.remove("is-on");
    dots[next]?.classList.add("is-on");
    setTimeout(() => {
      prev.classList.remove("is-active");
      try { prev.pause(); } catch (e) {}
    }, 1100);
    cur = next;
    const after = vids[(next + 1) % vids.length];
    if (after.preload === "none") after.preload = "metadata";
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => go((cur + 1) % vids.length), DURATION);
  }
  vids[0].play?.().catch(() => {});
  schedule();
})();
