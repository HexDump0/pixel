/*
 * Pixel mockup, round 10: the fleet charts at the top of the wall (calmer than round 7: no glow, no pulses).
 * Four canvases, one animation loop: output tokens/s stacked by run (scrolls live), tool calls per run over
 * 30 minutes (cells light up as calls land), spend per hour today with the rest of the day projected, and
 * machine memory as a ring split by run. Colours come from the page tokens, so the charts follow the theme.
 */
(function () {
  "use strict";
  const { runs, find, name, isLive, on, fmt } = PX;
  const S = 1000, M = 60 * S, H = 60 * M;
  const N = 180; // seconds of throughput history on screen
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = { s1: v("--s1"), s2: v("--s2"), s3: v("--s3"), line: v("--line"), line2: v("--line-2"), ink: v("--ink"), ink2: v("--ink-2"), ink3: v("--ink-3"), ink4: v("--ink-4"), warn: v("--warning"), r: [0, 1, 2, 3, 4, 5].map((i) => v(`--r${i}`)), mono: v("--mono"), sans: v("--sans") };
  }
  const alpha = (hex, a) => { const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const t0 = performance.now();

  /* ---------- data ---------- */
  const order = () => runs.filter((r) => isLive(r) || r.tpsHist.some((x) => x > 0)).sort((a, b) => a.started - b.started);
  // throughput: one sample a second per run, started from the 2-second history shared.js keeps
  const tp = new Map();
  for (const r of runs) {
    const src = r.tpsHist, out = [];
    for (let i = 0; i < N; i++) { const j = (i / (N - 1)) * (src.length - 1), a = Math.floor(j), b = Math.min(src.length - 1, a + 1); out.push(lerp(src[a], src[b], j - a)); }
    // ease the start-up history so it reads like the live samples
    for (let i = 1; i < N; i++) out[i] = out[i - 1] + (out[i] - out[i - 1]) * 0.22;
    tp.set(r.id, out);
  }
  let lastPush = performance.now();
  function pushSample() {
    for (const r of runs) {
      let arr = tp.get(r.id);
      if (!arr) tp.set(r.id, (arr = Array(N).fill(0)));
      const prev = arr[arr.length - 1];
      const target = r.agent === "working" && r.status === "running" ? r.tps * (0.9 + Math.random() * 0.2) : 0;
      arr.push(Math.max(0, prev + (target - prev) * 0.28));
      arr.shift();
      if (r.agent === "working" && r.status === "running") r.machine.memUsed = Math.max(0.6, Math.min(r.machine.mem * 0.95, r.machine.memUsed + (Math.random() - 0.5) * 0.04));
    }
    lastPush = performance.now();
  }
  setInterval(pushSample, 1000);

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
    for (let h = h0; h <= h1; h++) w.push(0.6 + Math.random() * 0.8);
    const sum = w.reduce((a, b) => a + b, 0);
    w.forEach((x, k) => spend[h0 + k].set(r.id, (spend[h0 + k].get(r.id) || 0) + (r.costToday * x) / sum));
  }
  const lastCost = new Map(runs.map((r) => [r.id, r.cost]));
  const hourNow = () => Math.min(23, Math.floor((Date.now() - dayStart) / H));
  const spendTotal = () => spend.reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0);
  const hourTotal = (h) => [...spend[h].values()].reduce((x, y) => x + y, 0);

  // activity flashes when a tool call lands
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
    <section class="hp hp-stream" aria-label="Output tokens per second by run">
      <div class="hp-h"><span class="label">Output tokens / s</span><span class="hp-v" id="hv-tps">0</span><span class="hp-s" id="hs-tps"></span></div>
      <div class="hp-c"><canvas id="cv-tps" role="img" aria-label="Stacked area of output tokens per second for each run over the last 3 minutes"></canvas></div>
      <div class="lg" id="lg-tps"></div>
    </section>
    <section class="hp" aria-label="Tool calls by run, last 30 minutes">
      <div class="hp-h"><span class="label">Tool calls · 30 min</span><span class="hp-v" id="hv-act">0</span><span class="hp-s" id="hs-act"></span></div>
      <div class="hp-c"><canvas id="cv-act" role="img" aria-label="Grid of tool calls per minute for each run"></canvas></div>
    </section>
    <section class="hp" aria-label="Spend per hour today">
      <div class="hp-h"><span class="label">Spend today</span><span class="hp-v" id="hv-usd">$0</span><span class="hp-s" id="hs-usd"></span></div>
      <div class="hp-c"><canvas id="cv-usd" role="img" aria-label="Columns of spend per hour today, stacked by run, with the rest of the day projected"></canvas></div>
    </section>
    <section class="hp" aria-label="Machine memory by run">
      <div class="hp-h"><span class="label">Memory</span></div>
      <div class="hp-mem"><div class="hp-c ringc"><canvas id="cv-mem" role="img" aria-label="Ring of memory used by each run out of the machine total"></canvas></div><ul class="lg col" id="lg-mem"></ul></div>
    </section>`;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  const showTip = (html, x, y) => { tip.innerHTML = html; tip.classList.add("on"); const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(innerWidth - w - 8, x + 14) + "px"; tip.style.top = Math.max(8, y - h - 12) + "px"; };
  const hideTip = () => tip.classList.remove("on");
  const row = (r, v) => `<div class="tr"><i style="width:8px;height:8px;border-radius:2px;background:var(--r${r.hue})"></i><span>${fmt.esc(name(r))}</span><b>${v}</b></div>`;

  /* ---------- canvas plumbing ---------- */
  const charts = [];
  function chart(id, draw, hover) {
    const cv = document.getElementById(id);
    const c = { cv, ctx: cv.getContext("2d"), w: 0, h: 0, draw, hover, mouse: null };
    const fit = () => { const dpr = Math.min(2, devicePixelRatio || 1); const r = cv.getBoundingClientRect(); c.w = r.width; c.h = r.height; cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    new ResizeObserver(fit).observe(cv);
    fit();
    cv.addEventListener("mousemove", (e) => { const b = cv.getBoundingClientRect(); c.mouse = { x: e.clientX - b.left, y: e.clientY - b.top, cx: e.clientX, cy: e.clientY }; });
    cv.addEventListener("mouseleave", () => { c.mouse = null; hideTip(); });
    charts.push(c);
    return c;
  }
  const font = (px, w = 400, mono = true) => `${w} ${px}px ${mono ? C.mono : C.sans}`;
  // smooth path through points (midpoint quadratic)
  function curve(ctx, pts, move = true) {
    if (move) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
    const l = pts[pts.length - 1]; ctx.lineTo(l[0], l[1]);
  }
  const niceMax = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };

  /* ---------- 1. throughput ---------- */
  let tpsMax = 200, tpsShown = 0;
  chart("cv-tps", (c, t) => {
    const { ctx, w, h } = c;
    const L = 30, R = 10, T = 6, B = 18, pw = w - L - R, ph = h - T - B;
    const list = order();
    const sums = Array(N).fill(0);
    const layers = list.map((r) => { const v = tp.get(r.id) || Array(N).fill(0); const lo = sums.slice(); v.forEach((x, i) => (sums[i] += x)); return { r, lo, hi: sums.slice(), v }; });
    tpsMax = lerp(tpsMax, niceMax(Math.max(100, ...sums) * 1.15), 0.04);
    const frac = reduce ? 0 : Math.min(1, (performance.now() - lastPush) / 1000);
    const dx = pw / (N - 2);
    const X = (i) => L + pw - (N - 1 - i + frac) * dx;
    const Y = (v) => T + ph - (v / tpsMax) * ph;
    // grid + y labels
    ctx.font = font(10); ctx.textBaseline = "middle"; ctx.textAlign = "right";
    const step = niceMax(tpsMax / 3);
    for (let v = 0; v <= tpsMax + 0.01; v += step) { const y = Math.round(Y(v)) + 0.5; ctx.strokeStyle = v === 0 ? C.line : C.line2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.fillStyle = C.ink3; ctx.fillText(String(Math.round(v)), L - 6, y); }
    // x labels
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    [["3m ago", N - 1], ["2m", 120], ["1m", 60], ["now", 0]].forEach(([l, s]) => { const x = L + pw - (s / (N - 1)) * pw; ctx.fillStyle = C.ink3; ctx.textAlign = s === 0 ? "right" : s === N - 1 ? "left" : "center"; ctx.fillText(l, x, h - 4); });
    // reveal on load
    const rv = reduce ? 1 : ease((t - 150) / 1100);
    ctx.save(); ctx.beginPath(); ctx.rect(L, 0, pw * rv, h); ctx.clip();
    ctx.beginPath(); ctx.rect(L, 0, pw, h); ctx.clip();
    for (const ly of layers) {
      const col = C.r[ly.r.hue];
      const top = ly.hi.map((v, i) => [X(i), Y(v)]), bot = ly.lo.map((v, i) => [X(i), Y(v)]).reverse();
      const g = ctx.createLinearGradient(0, T, 0, T + ph); g.addColorStop(0, alpha(col, 0.5)); g.addColorStop(1, alpha(col, 0.12));
      ctx.beginPath(); curve(ctx, top); curve(ctx, bot, false); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); curve(ctx, top); ctx.strokeStyle = C.s1; ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 1.75; ctx.lineJoin = "round"; ctx.stroke();
    }
    ctx.restore();
    // live end dots
    if (rv >= 1) for (const [k, ly] of layers.entries()) {
      const v = ly.v[N - 1]; if (v < 1) continue;
      const x = X(N - 1), y = Y(ly.hi[N - 1]), col = C.r[ly.r.hue];
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = C.s1; ctx.lineWidth = 2; ctx.stroke();
    }
    // hover crosshair
    if (c.mouse && c.mouse.x > L && c.mouse.x < L + pw) {
      const i = Math.max(0, Math.min(N - 1, Math.round(N - 1 - frac - (L + pw - c.mouse.x) / dx)));
      const x = X(i);
      ctx.strokeStyle = C.ink3; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, T); ctx.lineTo(Math.round(x) + 0.5, T + ph); ctx.stroke();
      for (const ly of layers) { if (ly.v[i] < 1) continue; ctx.beginPath(); ctx.arc(x, Y(ly.hi[i]), 3.5, 0, Math.PI * 2); ctx.fillStyle = C.r[ly.r.hue]; ctx.fill(); ctx.strokeStyle = C.s1; ctx.lineWidth = 2; ctx.stroke(); }
      const secs = N - 1 - i;
      const rows = layers.filter((ly) => ly.v[i] >= 1).reverse().map((ly) => row(ly.r, `${Math.round(ly.v[i])}`)).join("") || `<div class="tr"><span></span><span>Nothing generating</span><b></b></div>`;
      showTip(`<div class="tt">${secs ? `${secs}s ago` : "now"} · ${Math.round(sums[i])} tok/s</div>${rows}`, c.mouse.cx, c.mouse.cy);
    }
    tpsShown = lerp(tpsShown, sums[N - 1], 0.08);
  });

  /* ---------- 2. activity grid ---------- */
  chart("cv-act", (c, t) => {
    const { ctx, w, h } = c;
    const list = order().filter((r) => r.activity.some((x) => x.n) || isLive(r));
    const LW = 74, B = 16, rows = Math.max(1, list.length), cols = 30;
    const gap = 2, cw = (w - LW) / cols, rh = Math.min(32, (h - B) / rows);
    const max = Math.max(8, ...list.flatMap((r) => r.activity.map((x) => x.n)));
    ctx.font = font(11, 500, false); ctx.textBaseline = "middle"; ctx.textAlign = "left";
    let hit = null;
    list.forEach((r, ri) => {
      const y = ri * rh;
      ctx.fillStyle = C.ink2;
      let label = name(r); while (ctx.measureText(label).width > LW - 12 && label.length > 3) label = label.slice(0, -2) + "\u2026";
      ctx.fillText(label, 0, y + rh / 2);
      const fl = flash.get(r.id), fa = fl ? Math.max(0, 1 - (performance.now() - fl) / 900) : 0;
      r.activity.forEach((b, ci) => {
        const appear = reduce ? 1 : ease((t - 200 - ci * 22 - ri * 40) / 380);
        if (appear <= 0) return;
        const x = LW + ci * cw, cwi = cw - gap, chh = rh - gap;
        const k = b.n ? 0.16 + 0.84 * Math.pow(b.n / max, 0.75) : 0;
        ctx.globalAlpha = appear;
        ctx.fillStyle = b.n ? (b.k === "bad" ? alpha(C.warn, 0.9) : alpha(C.r[r.hue], k)) : C.s2;
        ctx.beginPath(); ctx.roundRect(x, y + gap / 2, cwi, chh, 2); ctx.fill();
        if (ci === cols - 1 && fa > 0) { ctx.fillStyle = alpha("#ffffff", 0.25 * fa); ctx.fill(); }
        ctx.globalAlpha = 1;
        if (c.mouse && c.mouse.x >= x && c.mouse.x < x + cw && c.mouse.y >= y && c.mouse.y < y + rh) hit = { r, b, ci, x, y, cwi, chh };
      });
    });
    ctx.fillStyle = C.ink3; ctx.font = font(10); ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText("30m ago", LW, h - 3);
    ctx.textAlign = "right"; ctx.fillText("now", w, h - 3);
    if (hit) {
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(hit.x - 0.5, hit.y + 0.5, hit.cwi + 1, hit.chh + 1, 2); ctx.stroke();
      const ago = 29 - hit.ci;
      showTip(`<div class="tt">${ago ? `${ago} min ago` : "this minute"}</div>${row(hit.r, `${hit.b.n} call${hit.b.n === 1 ? "" : "s"}`)}${hit.b.k ? `<div class="tr"><span></span><span>mostly ${hit.b.k === "bad" ? "recovery" : PX.KIND_LABEL[hit.b.k] || hit.b.k}</span><b></b></div>` : ""}`, c.mouse.cx, c.mouse.cy);
    } else if (c.mouse) hideTip();
  });

  /* ---------- 3. spend per hour ---------- */
  let usdShown = 0;
  chart("cv-usd", (c, t) => {
    const { ctx, w, h } = c;
    const B = 16, T = 4, ph = h - B - T;
    const hn = hourNow();
    const lastRate = (hourTotal(Math.max(0, hn - 1)) + hourTotal(hn)) / 2 || hourTotal(hn);
    const totals = spend.map((m, i) => (i <= hn ? [...m.values()].reduce((a, b) => a + b, 0) : lastRate));
    const max = niceMax(Math.max(0.5, ...totals) * 1.1);
    const slot = w / 24, bw = Math.max(3, Math.min(12, slot - 3));
    const list = order().concat(runs.filter((r) => !order().includes(r)));
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, T + ph + 0.5); ctx.lineTo(w, T + ph + 0.5); ctx.stroke();
    let hit = null;
    for (let i = 0; i < 24; i++) {
      const x = i * slot + (slot - bw) / 2;
      const grow = reduce ? 1 : ease((t - 250 - i * 35) / 500);
      if (i > hn) {
        const bh = (lastRate / max) * ph * grow;
        ctx.fillStyle = alpha(C.ink, 0.07); ctx.beginPath(); ctx.roundRect(x, T + ph - bh, bw, bh, [2, 2, 0, 0]); ctx.fill();
      } else {
        let y = T + ph;
        const segs = list.map((r) => [r, spend[i].get(r.id) || 0]).filter(([, v]) => v > 0);
        segs.forEach(([r, v], k) => {
          const sh = (v / max) * ph * grow;
          const top = k === segs.length - 1;
          ctx.fillStyle = C.r[r.hue];
          ctx.beginPath(); ctx.roundRect(x, y - sh, bw, Math.max(0, sh - (k ? 0 : 0)), top ? [2, 2, 0, 0] : 0); ctx.fill();
          y -= sh;
          if (!top) { ctx.fillStyle = C.s1; ctx.fillRect(x, y - 0.75, bw, 1.5); }
        });
        
      }
      if (c.mouse && c.mouse.x >= i * slot && c.mouse.x < (i + 1) * slot) hit = i;
    }
    ctx.fillStyle = C.ink3; ctx.font = font(10); ctx.textBaseline = "alphabetic";
    [0, 6, 12, 18].forEach((hh) => { ctx.textAlign = hh === 0 ? "left" : "center"; ctx.fillText(String(hh).padStart(2, "0"), hh === 0 ? 0 : hh * slot, h - 3); });
    ctx.textAlign = "right"; ctx.fillText("24", w, h - 3);
    if (hit != null) {
      const x = hit * slot; ctx.fillStyle = alpha(C.ink, 0.06); ctx.fillRect(x, T, slot, ph);
      const lab = `${String(hit).padStart(2, "0")}:00–${String(hit + 1).padStart(2, "0")}:00`;
      if (hit > hn) showTip(`<div class="tt">${lab} · projected</div><div class="tr"><span></span><span>at the last hour's rate</span><b>${fmt.money(lastRate)}</b></div>`, c.mouse.cx, c.mouse.cy);
      else { const rs = list.map((r) => [r, spend[hit].get(r.id) || 0]).filter(([, v]) => v > 0).reverse(); showTip(`<div class="tt">${lab} · ${fmt.money(hourTotal(hit))}</div>${rs.map(([r, v]) => row(r, fmt.money(v))).join("") || `<div class="tr"><span></span><span>Nothing spent</span><b></b></div>`}`, c.mouse.cx, c.mouse.cy); }
    } else if (c.mouse) hideTip();
    usdShown = lerp(usdShown, spendTotal(), 0.06);
    c.projected = spendTotal() + lastRate * (23 - hn + (1 - ((Date.now() - dayStart) % H) / H));
  });

  /* ---------- 4. memory ring ---------- */
  const memShown = new Map();
  chart("cv-mem", (c, t) => {
    const { ctx, w, h } = c;
    const fl = PX.fleet();
    const total = fl.memTotal;
    const segs = fl.mem.map((m) => ({ key: m.run ? m.run.id : "sys", r: m.run, label: m.run ? name(m.run) : m.label, gb: m.gb }));
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2 - 8, th = 11;
    const sweep = reduce ? 1 : ease((t - 200) / 1300);
    ctx.lineCap = "butt";
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.strokeStyle = C.s2; ctx.lineWidth = th; ctx.stroke();
    let a = -Math.PI / 2;
    const gapA = 0.035;
    let hit = null;
    const ma = c.mouse ? Math.atan2(c.mouse.y - cy, c.mouse.x - cx) : null, md = c.mouse ? Math.hypot(c.mouse.x - cx, c.mouse.y - cy) : 0;
    for (const s of segs) {
      const shown = lerp(memShown.get(s.key) ?? 0, s.gb, 0.05); memShown.set(s.key, shown);
      const span = (shown / total) * Math.PI * 2 * sweep;
      if (span > gapA) {
        ctx.beginPath(); ctx.arc(cx, cy, rad, a + gapA / 2, a + span - gapA / 2); ctx.strokeStyle = s.r ? C.r[s.r.hue] : C.ink4; ctx.lineWidth = th; ctx.stroke();
        if (ma != null && md > rad - th && md < rad + th) { let m = ma; while (m < a) m += Math.PI * 2; if (m <= a + span) hit = { s, a0: a, a1: a + span }; }
      }
      a += span;
    }
    // limit tick at 90%
    const la = -Math.PI / 2 + 0.9 * Math.PI * 2;
    ctx.strokeStyle = C.warn; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx + Math.cos(la) * (rad - th / 2 - 3), cy + Math.sin(la) * (rad - th / 2 - 3)); ctx.lineTo(cx + Math.cos(la) * (rad + th / 2 + 3), cy + Math.sin(la) * (rad + th / 2 + 3)); ctx.stroke();
    if (hit) { ctx.beginPath(); ctx.arc(cx, cy, rad, hit.a0 + gapA / 2, hit.a1 - gapA / 2); ctx.strokeStyle = C.ink; ctx.lineWidth = th + 4; ctx.globalAlpha = 0.25; ctx.stroke(); ctx.globalAlpha = 1; showTip(`<div class="tt">Memory</div>${hit.s.r ? row(hit.s.r, `${hit.s.gb.toFixed(1)} GB`) : `<div class="tr"><i style="width:8px;height:8px;border-radius:2px;background:var(--ink-4)"></i><span>${fmt.esc(hit.s.label)}</span><b>${(hit.s.gb * 1024).toFixed(0)} MB</b></div>`}`, c.mouse.cx, c.mouse.cy); }
    else if (c.mouse) hideTip();
    const used = [...memShown.values()].reduce((x, y) => x + y, 0) * sweep;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = C.ink; ctx.font = `650 ${Math.round(rad * 0.42)}px ${C.sans}`;
    ctx.fillText(used.toFixed(1), cx, cy + rad * 0.12);
    ctx.fillStyle = C.ink3; ctx.font = font(10);
    ctx.fillText(`of ${total} GB`, cx, cy + rad * 0.12 + 15);
  });

  /* ---------- header numbers and legends (DOM, a few times a second) ---------- */
  const $ = (id) => document.getElementById(id);
  function dom() {
    const fl = PX.fleet();
    $("hv-tps").textContent = Math.round(tpsShown);
    $("hs-tps").textContent = `${fmt.tok(fl.tokensToday)} today · ${Math.round(fl.cached * 100)}% cached`;
    const list = order();
    const vals = list.map((r) => [r, Math.round((tp.get(r.id) || [0]).slice(-1)[0])]);
    const quiet = vals.filter(([, v]) => v < 1).length;
    $("lg-tps").innerHTML = vals.filter(([, v]) => v >= 1).map(([r, v]) => `<span><i style="background:var(--r${r.hue})"></i>${fmt.esc(name(r))}<b>${v}</b></span>`).join("") + (quiet ? `<span class="off">${quiet} not generating</span>` : "");
    const calls = runs.reduce((a, r) => a + r.activity.reduce((x, b) => x + b.n, 0), 0);
    const lastMin = runs.reduce((a, r) => a + (r.activity[29]?.n || 0) + (r.activity[28]?.n || 0), 0) / 2;
    $("hv-act").textContent = calls.toLocaleString();
    $("hs-act").textContent = `${Math.round(lastMin)} / min now`;
    const usd = charts[2];
    $("hv-usd").textContent = fmt.money(usdShown);
    $("hs-usd").textContent = usd.projected ? `→ ${fmt.money(usd.projected)} by midnight` : "";
    $("lg-mem").innerHTML = fl.mem.slice().sort((a, b) => b.gb - a.gb).slice(0, 4).map((m) => `<li><i style="background:${m.run ? `var(--r${m.run.hue})` : "var(--ink-4)"}"></i><span>${fmt.esc(m.run ? name(m.run) : "Pixel + system")}</span><b>${m.gb.toFixed(1)}</b></li>`).join("");
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
