/*
 * Pixel mockup, round 11: the fleet at the top of the wall.
 * One big chart: output tokens/s per run over the last 30 minutes as a streamgraph, labelled at its right
 * edge (no legend), with what happened marked on the streams: findings (dot, coloured by severity),
 * questions (amber diamond) and crashes (amber tick). Hover a stream to isolate it.
 * Beside it three small charts: spend per hour today (rest of the day projected), tool calls per minute,
 * memory by run. Colours come from the page tokens, so the charts follow the theme.
 */
(function () {
  "use strict";
  const { runs, find, name, isLive, on, fmt } = PX;
  const S = 1000, M = 60 * S, H = 60 * M;
  const STEP = 5 * S, N = 360; // 30 minutes in 5-second samples
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = { bg: v("--bg"), s1: v("--s1"), s2: v("--s2"), s3: v("--s3"), line: v("--line"), line2: v("--line-2"), ink: v("--ink"), ink2: v("--ink-2"), ink3: v("--ink-3"), ink4: v("--ink-4"), warn: v("--warning"), bad: v("--critical"), sev: { high: v("--sev-high"), medium: v("--sev-medium"), low: v("--sev-low"), info: v("--sev-info") }, r: [0, 1, 2, 3, 4, 5].map((i) => v(`--r${i}`)), mono: v("--mono"), sans: v("--sans") };
  }
  const alpha = (hex, a) => { const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const t0 = performance.now();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  /* ---------- data ---------- */
  const order = () => runs.filter((r) => isLive(r) || r.status === "failed" || r.tpsHist.some((x) => x > 0)).sort((a, b) => a.started - b.started);
  // 30 minutes of history per run, shaped by its per-minute tool-call counts, then smoothed
  const tp = new Map();
  for (const r of runs) {
    const mx = Math.max(1, ...r.activity.map((b) => b.n));
    const base = r.tpsBase || (r.status === "recovering" ? 58 : 0); // expat was generating until it crashed
    const out = [];
    for (let i = 0; i < N; i++) {
      const minsAgo = ((N - 1 - i) * STEP) / M;
      const b = r.activity[29 - Math.floor(minsAgo)] || { n: 0 };
      const on = b.n && b.k !== "bad" && Date.now() - minsAgo * M > r.started;
      out.push(on ? base * (0.35 + 0.85 * (b.n / mx)) * (0.8 + rnd() * 0.4) : 0);
    }
    for (let k = 0; k < 2; k++) { for (let i = 1; i < N; i++) out[i] = lerp(out[i - 1], out[i], 0.18); for (let i = N - 2; i >= 0; i--) out[i] = lerp(out[i + 1], out[i], 0.18); }
    if (r.agent === "working" && r.status === "running") {
      const recent = out.slice(N - 36, N - 12), m = recent.reduce((a, x) => a + x, 0) / recent.length || 1;
      const f = Math.max(0.6, Math.min(1.8, r.tps / m));
      for (let i = 0; i < N; i++) out[i] *= f;
      for (let i = N - 12; i < N; i++) out[i] = lerp(out[i], r.tps, (i - (N - 12)) / 11);
    }
    tp.set(r.id, out);
  }
  let lastPush = performance.now();
  function pushSample() {
    for (const r of runs) {
      let arr = tp.get(r.id);
      if (!arr) tp.set(r.id, (arr = Array(N).fill(0)));
      const prev = arr[arr.length - 1];
      const target = r.agent === "working" && r.status === "running" ? r.tps * (0.9 + Math.random() * 0.2) : 0;
      arr.push(Math.max(0, prev + (target - prev) * 0.5));
      arr.shift();
      if (r.agent === "working" && r.status === "running") r.machine.memUsed = Math.max(0.6, Math.min(r.machine.mem * 0.95, r.machine.memUsed + (Math.random() - 0.5) * 0.04));
    }
    lastPush = performance.now();
  }
  setInterval(pushSample, STEP);

  // events drawn on the streams
  function events() {
    const now = Date.now(), ev = [];
    for (const f of K.findings) if (now - f.at < N * STEP) ev.push({ run: f.run, at: f.at, kind: "find", sev: f.sev, text: f.title });
    for (const r of runs) {
      if (r.question && now - r.question.at < N * STEP) ev.push({ run: r.id, at: r.question.at, kind: "ask", text: r.question.text });
      if (r.status === "recovering") { r.crashAt = r.crashAt || now - 2 * M - 10 * S; ev.push({ run: r.id, at: r.crashAt, kind: "crash", text: r.detail }); }
    }
    return ev;
  }

  // spend per hour today, per run
  const now0 = new Date();
  const dayStart = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate()).getTime();
  const spend = Array.from({ length: 24 }, () => new Map());
  for (const r of runs) {
    if (!r.costToday) continue;
    const from = Math.max(dayStart, r.started), to = r.finished || Date.now();
    if (to <= from) continue;
    const h0 = Math.floor((from - dayStart) / H), h1 = Math.floor((Math.min(to, Date.now()) - dayStart) / H);
    const w = [];
    for (let h = h0; h <= h1; h++) w.push(0.6 + rnd() * 0.8);
    const sum = w.reduce((a, b) => a + b, 0);
    w.forEach((x, k) => spend[h0 + k].set(r.id, (spend[h0 + k].get(r.id) || 0) + (r.costToday * x) / sum));
  }
  const lastCost = new Map(runs.map((r) => [r.id, r.cost]));
  const hourNow = () => Math.min(23, Math.floor((Date.now() - dayStart) / H));
  const spendTotal = () => spend.reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0);
  const hourTotal = (h) => [...spend[h].values()].reduce((x, y) => x + y, 0);
  const flash = new Map();
  on("tick", (ev) => {
    flash.set(ev.run, performance.now());
    const r = find(ev.run);
    if (r) {
      const d = r.cost - (lastCost.get(r.id) ?? r.cost);
      lastCost.set(r.id, r.cost);
      if (d > 0) { const h = hourNow(); spend[h].set(r.id, (spend[h].get(r.id) || 0) + d); }
    }
  });

  /* ---------- markup ---------- */
  const root = document.getElementById("hero");
  root.innerHTML = `
    <section class="h-main" aria-label="Output tokens per second by run, last 30 minutes">
      <div class="h-read"><span class="h-big num" id="hv-tps">0</span><span class="h-unit">tok/s</span></div>
      <canvas id="cv-stream" role="img" aria-label="Streamgraph of output tokens per second for each run over the last 30 minutes, with findings, questions and crashes marked"></canvas>
    </section>
    <div class="h-side">
      <section class="h-mini" aria-label="Spend per hour today"><div class="h-mh"><span class="cap">Spend today</span><b class="num" id="hv-usd">$0</b><small id="hs-usd"></small></div><div class="h-mc"><canvas id="cv-usd" role="img" aria-label="Spend per hour today stacked by run, with the rest of the day projected"></canvas></div></section>
      <section class="h-mini" aria-label="Tool calls per minute"><div class="h-mh"><span class="cap">Tool calls</span><b class="num" id="hv-act">0</b><small>/ min</small></div><div class="h-mc"><canvas id="cv-act" role="img" aria-label="Tool calls per minute for the last 30 minutes, stacked by run"></canvas></div></section>
      <section class="h-mini" aria-label="Memory by run"><div class="h-mh"><span class="cap">Memory</span><b class="num" id="hv-mem">0</b><small id="hs-mem"></small></div><div class="h-mc"><canvas id="cv-mem" role="img" aria-label="Memory used by each run out of the machine total"></canvas></div></section>
    </div>`;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  const showTip = (html, x, y) => { tip.innerHTML = html; tip.classList.add("on"); const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(innerWidth - w - 8, x + 14) + "px"; tip.style.top = Math.max(8, y - h - 12) + "px"; };
  const hideTip = () => tip.classList.remove("on");
  const row = (r, v, hot) => `<div class="tr ${hot ? "hot" : ""}"><i style="background:var(--r${r.hue})"></i><span>${fmt.esc(name(r))}</span><b>${v}</b></div>`;

  /* ---------- canvas plumbing ---------- */
  const charts = [];
  function chart(id, draw) {
    const cv = document.getElementById(id);
    const c = { cv, ctx: cv.getContext("2d"), w: 0, h: 0, draw, mouse: null };
    const fit = () => { const dpr = Math.min(2, devicePixelRatio || 1); const r = cv.getBoundingClientRect(); c.w = r.width; c.h = r.height; cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    new ResizeObserver(fit).observe(cv);
    fit();
    cv.addEventListener("mousemove", (e) => { const b = cv.getBoundingClientRect(); c.mouse = { x: e.clientX - b.left, y: e.clientY - b.top, cx: e.clientX, cy: e.clientY }; });
    cv.addEventListener("mouseleave", () => { c.mouse = null; hideTip(); });
    cv.addEventListener("click", () => { if (c.hotRun) PX.ui.openRun(c.hotRun); });
    charts.push(c);
    return c;
  }
  const font = (px, w = 400, mono = true) => `${w} ${px}px ${mono ? C.mono : C.sans}`;
  function curve(ctx, pts, move = true) {
    if (move) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
    const l = pts[pts.length - 1]; ctx.lineTo(l[0], l[1]);
  }
  const niceMax = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
  const trunc = (ctx, s, w) => { if (ctx.measureText(s).width <= w) return s; while (s.length > 3 && ctx.measureText(s + "…").width > w) s = s.slice(0, -1); return s + "…"; };

  /* ---------- 1. the stream ---------- */
  let maxSum = 300, tpsShown = 0;
  const hot = { id: null, a: 0 };
  chart("cv-stream", (c, t) => {
    const { ctx, w, h } = c;
    const GUT = Math.min(170, w * 0.2), L = 0, T = 68, B = 30, pw = w - L - GUT, ph = h - T - B;
    const list = order();
    const sums = Array(N).fill(0);
    const layers = list.map((r) => { const v = tp.get(r.id) || Array(N).fill(0); const lo = sums.slice(); v.forEach((x, i) => (sums[i] += x)); return { r, lo, hi: sums.slice(), v }; });
    maxSum = lerp(maxSum, Math.max(120, ...sums) * 1.1, 0.03);
    const k = ph / maxSum, mid = T + ph / 2;
    const frac = reduce ? 0 : Math.min(1, (performance.now() - lastPush) / STEP);
    const dx = pw / (N - 2);
    const X = (i) => L + pw - (N - 1 - i + frac) * dx;
    const Yv = (i, v) => mid - (v - sums[i] / 2) * k; // silhouette: centred on the mid line
    // time grid
    ctx.font = font(10); ctx.textBaseline = "alphabetic";
    [[30, "30m"], [20, "20m"], [10, "10m"], [0, "now"]].forEach(([m, l]) => {
      const x = Math.round(L + pw - (m / 30) * pw) + 0.5;
      if (m && m < 30) { ctx.strokeStyle = C.line2; ctx.lineWidth = 1; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, T - 8); ctx.lineTo(x, T + ph + 4); ctx.stroke(); ctx.setLineDash([]); }
      ctx.fillStyle = C.ink4; ctx.textAlign = m === 30 ? "left" : m === 0 ? "right" : "center"; ctx.fillText(l, x, h - 4);
    });
    // which stream is under the mouse
    let hover = null, hi = -1;
    if (c.mouse && c.mouse.x > L && c.mouse.x < L + pw) {
      hi = Math.max(0, Math.min(N - 1, Math.round(N - 1 - frac - (L + pw - c.mouse.x) / dx)));
      for (const ly of layers) { const y0 = Yv(hi, ly.lo[hi]), y1 = Yv(hi, ly.hi[hi]); if (ly.v[hi] > 0.5 && c.mouse.y <= y0 + 2 && c.mouse.y >= y1 - 2) hover = ly.r.id; }
    }
    hot.a = lerp(hot.a, hover ? 1 : 0, 0.18); if (hover) hot.id = hover;
    c.hotRun = hover;
    c.cv.style.cursor = hover ? "pointer" : "default";
    // reveal on load
    const rv = reduce ? 1 : ease((t - 150) / 1200);
    ctx.save(); ctx.beginPath(); ctx.rect(L, 0, pw * rv, h); ctx.clip();
    ctx.beginPath(); ctx.rect(L, 0, pw, h); ctx.clip();
    for (const ly of layers) {
      if (!ly.v.some((x) => x > 0.5)) continue;
      const col = C.r[ly.r.hue];
      const dim = hot.id && hot.id !== ly.r.id ? 1 - 0.7 * hot.a : 1;
      const top = ly.hi.map((v, i) => [X(i), Yv(i, v)]), bot = ly.lo.map((v, i) => [X(i), Yv(i, v)]).reverse();
      const g = ctx.createLinearGradient(L, 0, L + pw, 0); g.addColorStop(0, alpha(col, 0.22 * dim)); g.addColorStop(0.75, alpha(col, 0.5 * dim)); g.addColorStop(1, alpha(col, 0.72 * dim));
      ctx.beginPath(); curve(ctx, top); curve(ctx, bot, false); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); curve(ctx, top); ctx.strokeStyle = alpha(col, 0.9 * dim); ctx.lineWidth = 1.25; ctx.lineJoin = "round"; ctx.stroke();
    }
    ctx.restore();
    // events on the streams
    const now = Date.now();
    let evHit = null;
    if (rv > 0.98) for (const e of events()) {
      const ly = layers.find((x) => x.r.id === e.run); if (!ly) continue;
      const i = Math.round(N - 1 - (now - e.at) / STEP); if (i < 0 || i >= N) continue;
      const x = X(i), y = Yv(i, ly.hi[i]);
      ctx.lineWidth = 2; ctx.strokeStyle = C.s1;
      if (e.kind === "find") { ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = C.sev[e.sev] || C.ink2; ctx.fill(); ctx.stroke(); }
      else if (e.kind === "ask") { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.beginPath(); ctx.rect(-4, -4, 8, 8); ctx.fillStyle = C.warn; ctx.fill(); ctx.stroke(); ctx.restore(); }
      else { ctx.beginPath(); ctx.roundRect(x - 1.5, y - 8, 3, 16, 1.5); ctx.fillStyle = C.warn; ctx.fill(); }
      if (c.mouse && Math.hypot(c.mouse.x - x, c.mouse.y - y) < 9) evHit = { e, r: ly.r };
    }
    // right-edge labels with leader lines, spread so they never overlap
    const labs = layers.filter((ly) => ly.v[N - 1] >= 1).map((ly) => ({ ly, y: (Yv(N - 1, ly.lo[N - 1]) + Yv(N - 1, ly.hi[N - 1])) / 2 }));
    labs.sort((a, b) => a.y - b.y);
    const gap = 30;
    const ys = labs.map((l) => l.y);
    for (let it = 0; it < 20; it++) for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < gap) { const d = (gap - (ys[i] - ys[i - 1])) / 2; ys[i - 1] -= d; ys[i] += d; }
    const lx = L + pw + 14;
    labs.forEach((l, i) => {
      const y = Math.max(T, Math.min(T + ph, ys[i])), col = C.r[l.ly.r.hue];
      const dim = hot.id && hot.id !== l.ly.r.id ? 1 - 0.6 * hot.a : 1;
      ctx.globalAlpha = rv * dim;
      ctx.strokeStyle = alpha(col, 0.6); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L + pw + 2, l.y); ctx.bezierCurveTo(L + pw + 8, l.y, lx - 8, y, lx - 3, y); ctx.stroke();
      ctx.font = font(12, 500, false); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = C.ink;
      ctx.fillText(trunc(ctx, name(l.ly.r), w - lx - 4), lx, y - 2);
      ctx.font = font(11); ctx.fillStyle = col;
      ctx.fillText(`${Math.round(l.ly.v[N - 1])}`, lx, y + 12);
      ctx.globalAlpha = 1;
    });
    // live end of each stream
    if (rv >= 1) for (const ly of layers) { if (ly.v[N - 1] < 1) continue; const x = X(N - 1); ctx.fillStyle = C.r[ly.r.hue]; ctx.fillRect(x - 1, Yv(N - 1, ly.hi[N - 1]), 2, Math.max(1, (ly.hi[N - 1] - ly.lo[N - 1]) * k)); }
    // hover
    if (evHit) {
      const e = evHit.e;
      const lab = e.kind === "find" ? `${e.sev} finding` : e.kind === "ask" ? "Question" : "Crash";
      showTip(`<div class="tt">${lab} · ${PX.fmt.ago(e.at)}</div>${row(evHit.r, "")}<div class="tx">${fmt.esc(e.text)}</div>`, c.mouse.cx, c.mouse.cy);
    } else if (hi >= 0) {
      const x = X(hi);
      ctx.strokeStyle = alpha(C.ink, 0.25); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, T - 8); ctx.lineTo(Math.round(x) + 0.5, T + ph + 4); ctx.stroke();
      const secs = Math.round((N - 1 - hi) * STEP / S);
      const when = secs < 60 ? (secs ? `${secs}s ago` : "now") : `${Math.round(secs / 60)} min ago`;
      const rows = layers.filter((ly) => ly.v[hi] >= 1).reverse().map((ly) => row(ly.r, `${Math.round(ly.v[hi])}`, ly.r.id === hover)).join("");
      if (rows) showTip(`<div class="tt">${when} · ${Math.round(sums[hi])} tok/s</div>${rows}`, c.mouse.cx, c.mouse.cy); else hideTip();
    } else if (c.mouse) hideTip();
    tpsShown = lerp(tpsShown, sums[N - 1], 0.08);
  });

  /* ---------- 2. spend per hour ---------- */
  let usdShown = 0;
  const spendChart = chart("cv-usd", (c, t) => {
    const { ctx, w, h } = c;
    const ph = h - 2;
    const hn = hourNow();
    const lastRate = (hourTotal(Math.max(0, hn - 1)) + hourTotal(hn)) / 2 || hourTotal(hn);
    const totals = spend.map((m, i) => (i <= hn ? [...m.values()].reduce((a, b) => a + b, 0) : lastRate));
    const max = Math.max(0.5, ...totals) * 1.05;
    const slot = w / 24, bw = Math.max(2, slot - 3);
    const list = order().concat(runs.filter((r) => !order().includes(r)));
    let hit = null;
    for (let i = 0; i < 24; i++) {
      const x = i * slot + 1.5;
      const grow = reduce ? 1 : ease((t - 250 - i * 30) / 500);
      if (i > hn) {
        const bh = Math.max(2, (lastRate / max) * ph * grow);
        ctx.strokeStyle = alpha(C.ink, 0.16); ctx.setLineDash([2, 2]); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x + 0.5, ph - bh + 0.5, bw - 1, bh - 1, 2); ctx.stroke(); ctx.setLineDash([]);
      } else {
        let y = ph;
        const segs = list.map((r) => [r, spend[i].get(r.id) || 0]).filter(([, v]) => v > 0);
        if (!segs.length) { ctx.fillStyle = C.s3; ctx.fillRect(x, ph - 2, bw, 2); }
        segs.forEach(([r, v], k) => {
          const sh = (v / max) * ph * grow;
          ctx.fillStyle = C.r[r.hue];
          ctx.beginPath(); ctx.roundRect(x, y - sh, bw, sh, k === segs.length - 1 ? [2, 2, 0, 0] : 0); ctx.fill();
          y -= sh;
        });
      }
      if (c.mouse && c.mouse.x >= i * slot && c.mouse.x < (i + 1) * slot) hit = i;
    }
    if (hit != null) {
      ctx.fillStyle = alpha(C.ink, 0.06); ctx.fillRect(hit * slot, 0, slot, ph);
      const lab = `${String(hit).padStart(2, "0")}:00`;
      if (hit > hn) showTip(`<div class="tt">${lab} · projected</div><div class="tr"><span></span><span>at the last hour's rate</span><b>${fmt.money(lastRate)}</b></div>`, c.mouse.cx, c.mouse.cy);
      else { const rs = list.map((r) => [r, spend[hit].get(r.id) || 0]).filter(([, v]) => v > 0).reverse(); showTip(`<div class="tt">${lab} · ${fmt.money(hourTotal(hit))}</div>${rs.map(([r, v]) => row(r, fmt.money(v))).join("")}`, c.mouse.cx, c.mouse.cy); }
    } else if (c.mouse) hideTip();
    usdShown = lerp(usdShown, spendTotal(), 0.06);
    c.projected = spendTotal() + lastRate * (23 - hn + (1 - ((Date.now() - dayStart) % H) / H));
  });

  /* ---------- 3. tool calls per minute ---------- */
  chart("cv-act", (c, t) => {
    const { ctx, w, h } = c;
    const list = order();
    const ph = h - 2, slot = w / 30, bw = Math.max(2, slot - 2);
    const tot = (i) => list.reduce((a, r) => a + (r.activity[i].k === "bad" ? 0 : r.activity[i].n), 0);
    const max = Math.max(10, ...Array.from({ length: 30 }, (_, i) => tot(i))) * 1.05;
    let hit = null;
    for (let i = 0; i < 30; i++) {
      const x = i * slot + 1;
      const grow = reduce ? 1 : ease((t - 300 - i * 18) / 450);
      let y = ph;
      const segs = list.filter((r) => r.activity[i].n && r.activity[i].k !== "bad");
      segs.forEach((r, k) => {
        const sh = (r.activity[i].n / max) * ph * grow;
        const fl = i === 29 ? flash.get(r.id) : 0, fa = fl ? Math.max(0, 1 - (performance.now() - fl) / 900) : 0;
        ctx.fillStyle = C.r[r.hue];
        ctx.globalAlpha = 0.55 + 0.45 * (i / 29) + fa * 0.4;
        ctx.beginPath(); ctx.roundRect(x, y - sh, bw, sh, k === segs.length - 1 ? [2, 2, 0, 0] : 0); ctx.fill();
        ctx.globalAlpha = 1;
        y -= sh;
      });
      if (c.mouse && c.mouse.x >= i * slot && c.mouse.x < (i + 1) * slot) hit = i;
    }
    if (hit != null) {
      ctx.fillStyle = alpha(C.ink, 0.06); ctx.fillRect(hit * slot, 0, slot, ph);
      const ago = 29 - hit;
      showTip(`<div class="tt">${ago ? `${ago} min ago` : "this minute"} · ${tot(hit)} calls</div>${list.filter((r) => r.activity[hit].n && r.activity[hit].k !== "bad").reverse().map((r) => row(r, r.activity[hit].n)).join("")}`, c.mouse.cx, c.mouse.cy);
    } else if (c.mouse) hideTip();
    c.perMin = (tot(29) + tot(28)) / 2;
  });

  /* ---------- 4. memory ---------- */
  const memShown = new Map();
  chart("cv-mem", (c, t) => {
    const { ctx, w, h } = c;
    const fl = PX.fleet();
    const total = fl.memTotal;
    const bh = 10, y = Math.round((h - bh) / 2);
    const grow = reduce ? 1 : ease((t - 300) / 1000);
    ctx.fillStyle = C.s3; ctx.beginPath(); ctx.roundRect(0, y, w, bh, 3); ctx.fill();
    let x = 0, hit = null;
    const segs = fl.mem.map((m) => ({ key: m.run ? m.run.id : "sys", r: m.run, label: m.run ? name(m.run) : "Pixel + system", gb: m.gb }));
    ctx.save(); ctx.beginPath(); ctx.roundRect(0, y, w, bh, 3); ctx.clip();
    for (const s of segs) {
      const shown = lerp(memShown.get(s.key) ?? 0, s.gb, 0.05); memShown.set(s.key, shown);
      const sw = (shown / total) * w * grow;
      ctx.fillStyle = s.r ? C.r[s.r.hue] : C.ink4;
      ctx.fillRect(x, y, Math.max(0, sw - 2), bh);
      if (c.mouse && c.mouse.x >= x && c.mouse.x < x + sw) hit = s;
      x += sw;
    }
    ctx.restore();
    const lx = Math.round(w * 0.9) + 0.5;
    ctx.strokeStyle = C.warn; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lx, y - 4); ctx.lineTo(lx, y + bh + 4); ctx.stroke();
    if (hit) showTip(`<div class="tt">Memory</div>${hit.r ? row(hit.r, `${hit.gb.toFixed(1)} GB`) : `<div class="tr"><i style="background:var(--ink-4)"></i><span>${hit.label}</span><b>${hit.gb.toFixed(1)} GB</b></div>`}`, c.mouse.cx, c.mouse.cy);
    else if (c.mouse) showTip(`<div class="tt">Memory</div><div class="tr"><i style="background:var(--warning)"></i><span>new runs wait above</span><b>90%</b></div>`, c.mouse.cx, c.mouse.cy);
    c.used = [...memShown.values()].reduce((a, b) => a + b, 0);
  });

  /* ---------- numbers (DOM, a few times a second) ---------- */
  const $ = (id) => document.getElementById(id);
  function dom() {
    const fl = PX.fleet();
    $("hv-tps").textContent = Math.round(tpsShown);
    $("hv-usd").textContent = fmt.money(usdShown);
    $("hs-usd").textContent = spendChart.projected ? `→ ${fmt.money(spendChart.projected)}` : "";
    $("hs-usd").title = "Projected by midnight at the last hour's rate";
    $("hv-act").textContent = Math.round(charts[2].perMin || 0);
    $("hv-mem").textContent = (charts[3].used || 0).toFixed(1);
    $("hs-mem").textContent = `/ ${fl.memTotal} GB`;
  }

  /* ---------- loop ---------- */
  readColors();
  on("theme", () => setTimeout(readColors, 0));
  let raf = 0;
  function frame(now) {
    const t = now - t0;
    for (const c of charts) { if (!c.w) continue; c.ctx.clearRect(0, 0, c.w, c.h); c.draw(c, t); }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  setInterval(dom, 250);
  dom();
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAnimationFrame(raf); else raf = requestAnimationFrame(frame); });
})();
