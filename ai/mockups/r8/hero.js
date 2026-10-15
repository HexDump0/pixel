/*
 * Pixel mockup, round 8: the fleet charts at the top of the wall, in greyscale.
 * Output tokens/s (total line, per-run split on hover), tool calls per run over 30 minutes, spend per hour
 * today with the rest of the day projected, and memory per run. The only motion is new data arriving.
 */
(function () {
  "use strict";
  const { runs, isLive, name, fmt } = PX;
  const H = 3600 * 1000, N = 180;
  const lerp = (a, b, t) => a + (b - a) * t;
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    C = { s1: v("--s1"), s2: v("--s2"), s3: v("--s3"), line: v("--line"), line2: v("--line-2"), ink: v("--ink"), ink2: v("--ink-2"), ink3: v("--ink-3"), ink4: v("--ink-4"), acc: v("--accent-c"), mono: v("--mono"), sans: v("--sans") };
  }
  const rgba = (hex, a) => { const n = parseInt(hex.replace("#", ""), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const order = () => runs.filter((r) => isLive(r) || r.tpsHist.some((x) => x > 0)).sort((a, b) => a.started - b.started);

  /* ---------- data ---------- */
  const tp = new Map();
  for (const r of runs) {
    const src = r.tpsHist, out = [];
    for (let i = 0; i < N; i++) { const j = (i / (N - 1)) * (src.length - 1), a = Math.floor(j), b = Math.min(src.length - 1, a + 1); out.push(lerp(src[a], src[b], j - a)); }
    for (let i = 1; i < N; i++) out[i] = out[i - 1] + (out[i] - out[i - 1]) * 0.2;
    tp.set(r.id, out);
  }
  let lastPush = performance.now();
  setInterval(() => {
    for (const r of runs) {
      let arr = tp.get(r.id);
      if (!arr) tp.set(r.id, (arr = Array(N).fill(0)));
      const on = r.agent === "working" && r.status === "running";
      const prev = arr[arr.length - 1];
      arr.push(Math.max(0, prev + ((on ? r.tps * (0.92 + Math.random() * 0.16) : 0) - prev) * 0.25));
      arr.shift();
    }
    lastPush = performance.now();
  }, 1000);

  const now0 = new Date();
  const dayStart = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate()).getTime();
  const spend = Array.from({ length: 24 }, () => new Map());
  for (const r of runs) {
    if (!r.costToday) continue;
    const from = Math.max(dayStart, r.started), to = Math.min(r.finished || Date.now(), Date.now());
    if (to <= from) continue;
    const h0 = Math.floor((from - dayStart) / H), h1 = Math.floor((to - dayStart) / H);
    const w = []; for (let h = h0; h <= h1; h++) w.push(0.7 + Math.random() * 0.6);
    const sum = w.reduce((a, b) => a + b, 0);
    w.forEach((x, k) => spend[h0 + k].set(r.id, (spend[h0 + k].get(r.id) || 0) + (r.costToday * x) / sum));
  }
  const lastCost = new Map(runs.map((r) => [r.id, r.cost]));
  const hourNow = () => Math.min(23, Math.floor((Date.now() - dayStart) / H));
  const hourTotal = (h) => [...spend[h].values()].reduce((a, b) => a + b, 0);
  const spendTotal = () => spend.reduce((a, _, h) => a + hourTotal(h), 0);
  PX.on("tick", (ev) => {
    const r = PX.find(ev.run); if (!r) return;
    const d = r.cost - (lastCost.get(r.id) ?? r.cost); lastCost.set(r.id, r.cost);
    if (d > 0) { const h = hourNow(); spend[h].set(r.id, (spend[h].get(r.id) || 0) + d); }
  });

  /* ---------- markup ---------- */
  const root = document.getElementById("hero");
  root.innerHTML = `
    <section class="hp hp-wide" aria-label="Output tokens per second"><div class="hp-h"><span class="label">Output tokens/s</span><div class="hp-row"><span class="hp-v" id="hv-tps">0</span><span class="hp-s" id="hs-tps"></span></div></div><div class="hp-c"><canvas id="cv-tps" role="img" aria-label="Output tokens per second over the last 3 minutes"></canvas></div></section>
    <section class="hp" aria-label="Spend per hour today"><div class="hp-h"><span class="label">Spend today</span><div class="hp-row"><span class="hp-v" id="hv-usd">$0</span><span class="hp-s" id="hs-usd"></span></div></div><div class="hp-c"><canvas id="cv-usd" role="img" aria-label="Spend per hour today with the rest of the day projected"></canvas></div></section>
    <section class="hp" aria-label="Tool calls by run, last 30 minutes"><div class="hp-h"><span class="label">Tool calls, 30 min</span><div class="hp-row"><span class="hp-v" id="hv-act">0</span><span class="hp-s" id="hs-act"></span></div></div><div class="hp-c"><canvas id="cv-act" role="img" aria-label="Tool calls per minute for each run"></canvas></div></section>
    <section class="hp" aria-label="Memory by run"><div class="hp-h"><span class="label">Memory</span><div class="hp-row"><span class="hp-v" id="hv-mem">0</span><span class="hp-s" id="hs-mem"></span></div></div><ul class="mem" id="mem"></ul></section>`;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  const showTip = (html, x, y) => { tip.innerHTML = html; tip.classList.add("on"); const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(innerWidth - w - 8, x + 14) + "px"; tip.style.top = Math.max(8, y - h - 12) + "px"; };
  const hideTip = () => tip.classList.remove("on");
  const trow = (label, v) => `<div class="tr"><span></span><span>${fmt.esc(label)}</span><b>${v}</b></div>`;

  const charts = [];
  function chart(id, draw) {
    const cv = document.getElementById(id);
    const c = { cv, ctx: cv.getContext("2d"), w: 0, h: 0, draw, mouse: null };
    const fit = () => { const dpr = Math.min(2, devicePixelRatio || 1), b = cv.getBoundingClientRect(); c.w = b.width; c.h = b.height; cv.width = Math.round(b.width * dpr); cv.height = Math.round(b.height * dpr); c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    new ResizeObserver(fit).observe(cv); fit();
    cv.addEventListener("mousemove", (e) => { const b = cv.getBoundingClientRect(); c.mouse = { x: e.clientX - b.left, y: e.clientY - b.top, cx: e.clientX, cy: e.clientY }; });
    cv.addEventListener("mouseleave", () => { c.mouse = null; hideTip(); });
    charts.push(c);
  }
  const font = (px) => `400 ${px}px ${C.mono}`;
  const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

  /* output tokens/s: total as one line, per-run split on hover */
  let tmax = 500, tpsNow = 0;
  chart("cv-tps", (c) => {
    const { ctx, w, h } = c, L = 28, B = 18, T = 4, pw = w - L, ph = h - B - T;
    const list = order(), tot = Array(N).fill(0);
    for (const r of list) (tp.get(r.id) || []).forEach((v, i) => (tot[i] += v));
    tmax = nice(Math.max(100, ...tot) * 1.15);
    const frac = Math.min(1, (performance.now() - lastPush) / 1000), dx = pw / (N - 2);
    const X = (i) => L + pw - (N - 1 - i + frac) * dx, Y = (v) => T + ph - (v / tmax) * ph;
    ctx.font = font(10.5); ctx.fillStyle = C.ink3; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const v of [0, tmax / 2, tmax]) { const y = Math.round(Y(v)) + 0.5; ctx.strokeStyle = C.line2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w, y); ctx.stroke(); ctx.fillText(String(Math.round(v)), L - 8, y); }
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText("3 min ago", L, h - 3);
    ctx.textAlign = "right"; ctx.fillText("now", w, h - 3);
    ctx.save(); ctx.beginPath(); ctx.rect(L, 0, pw, h); ctx.clip();
    const pts = tot.map((v, i) => [X(i), Y(v)]);
    const path = () => { ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < N - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); } ctx.lineTo(pts[N - 1][0], pts[N - 1][1]); };
    const g = ctx.createLinearGradient(0, T, 0, T + ph); g.addColorStop(0, rgba(C.acc, 0.22)); g.addColorStop(1, rgba(C.acc, 0));
    ctx.beginPath(); path(); ctx.lineTo(pts[N - 1][0], T + ph); ctx.lineTo(pts[0][0], T + ph); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); path(); ctx.strokeStyle = C.acc; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
    ctx.restore();
    if (c.mouse && c.mouse.x > L) {
      const i = Math.max(0, Math.min(N - 1, Math.round(N - 1 - frac - (w - c.mouse.x) / dx))), x = X(i);
      ctx.strokeStyle = C.ink4; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, T); ctx.lineTo(Math.round(x) + 0.5, T + ph); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, Y(tot[i]), 3.5, 0, Math.PI * 2); ctx.fillStyle = C.acc; ctx.fill(); ctx.strokeStyle = C.s1; ctx.lineWidth = 2; ctx.stroke();
      const rows = list.map((r) => [r, (tp.get(r.id) || [])[i] || 0]).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).map(([r, v]) => trow(name(r), Math.round(v))).join("");
      const s = N - 1 - i;
      showTip(`<div class="tt">${s ? `${s}s ago` : "Now"} · ${Math.round(tot[i])} tok/s</div>${rows || trow("Nothing generating", "")}`, c.mouse.cx, c.mouse.cy);
    }
    tpsNow = tot[N - 1];
  });

  /* spend per hour */
  chart("cv-usd", (c) => {
    const { ctx, w, h } = c, B = 18, T = 4, ph = h - B - T;
    const hn = hourNow(), rate = (hourTotal(Math.max(0, hn - 1)) + hourTotal(hn)) / 2 || hourTotal(hn);
    const vals = Array.from({ length: 24 }, (_, i) => (i <= hn ? hourTotal(i) : rate));
    const max = nice(Math.max(0.5, ...vals) * 1.15), slot = w / 24, bw = Math.max(3, Math.min(12, slot - 3));
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, T + ph + 0.5); ctx.lineTo(w, T + ph + 0.5); ctx.stroke();
    let hit = null;
    vals.forEach((v, i) => {
      const x = Math.round(i * slot + (slot - bw) / 2), bh = Math.max(v > 0 ? 2 : 0, (v / max) * ph), y = T + ph - bh;
      if (i > hn) { ctx.strokeStyle = C.ink4; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, bw - 1, bh, [2, 2, 0, 0]); ctx.stroke(); }
      else { ctx.fillStyle = i === hn ? C.acc : rgba(C.acc, 0.4); ctx.beginPath(); ctx.roundRect(x, y, bw, bh, [2, 2, 0, 0]); ctx.fill(); }
      if (c.mouse && c.mouse.x >= i * slot && c.mouse.x < (i + 1) * slot) hit = i;
    });
    ctx.fillStyle = C.ink3; ctx.font = font(10.5); ctx.textBaseline = "alphabetic";
    [["00", 0, "left"], ["06", 6, "center"], ["12", 12, "center"], ["18", 18, "center"], ["24", 24, "right"]].forEach(([l, hh, al]) => { ctx.textAlign = al; ctx.fillText(l, hh * slot, h - 3); });
    if (hit != null) {
      ctx.fillStyle = rgba(C.ink, 0.05); ctx.fillRect(hit * slot, T, slot, ph);
      const lab = `${String(hit).padStart(2, "0")}:00`;
      if (hit > hn) showTip(`<div class="tt">${lab} · projected</div>${trow("At the last hour's rate", fmt.money(rate))}`, c.mouse.cx, c.mouse.cy);
      else { const rs = runs.map((r) => [r, spend[hit].get(r.id) || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]); showTip(`<div class="tt">${lab} · ${fmt.money(hourTotal(hit))}</div>${rs.map(([r, v]) => trow(name(r), fmt.money(v))).join("") || trow("Nothing spent", "")}`, c.mouse.cx, c.mouse.cy); }
    }
    c.projected = spendTotal() + rate * (24 - (Date.now() - dayStart) / H);
  });

  /* tool calls: one row per run, one cell per minute */
  chart("cv-act", (c) => {
    const { ctx, w, h } = c;
    const list = order().filter((r) => isLive(r));
    const LW = 92, B = 18, rows = Math.max(1, list.length), rh = Math.min(26, (h - B) / rows), cw = (w - LW) / 30;
    const max = Math.max(8, ...list.flatMap((r) => r.activity.map((x) => x.n)));
    let hit = null;
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    list.forEach((r, ri) => {
      const y = ri * rh;
      ctx.font = `400 12px ${C.sans}`; ctx.fillStyle = C.ink2;
      let label = name(r); while (ctx.measureText(label).width > LW - 14 && label.length > 3) label = label.slice(0, -2) + "…";
      ctx.fillText(label, 0, y + rh / 2);
      r.activity.forEach((b, ci) => {
        const x = LW + ci * cw;
        ctx.fillStyle = b.n ? (b.k === "bad" ? rgba("#ffb224", 0.85) : rgba(C.acc, 0.1 + 0.75 * Math.pow(b.n / max, 0.9))) : C.s2;
        ctx.beginPath(); ctx.roundRect(x, y + 2, cw - 2, rh - 4, 1.5); ctx.fill();
        if (c.mouse && c.mouse.x >= x && c.mouse.x < x + cw && c.mouse.y >= y && c.mouse.y < y + rh) hit = { r, b, ci };
      });
    });
    ctx.font = font(10.5); ctx.fillStyle = C.ink3; ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText("30 min ago", LW, h - 3);
    ctx.textAlign = "right"; ctx.fillText("now", w, h - 3);
    if (hit) { const a = 29 - hit.ci; showTip(`<div class="tt">${fmt.esc(name(hit.r))} · ${a ? `${a} min ago` : "this minute"}</div>${trow("Tool calls", hit.b.n)}${hit.b.k ? trow("Mostly", hit.b.k === "bad" ? "recovery" : PX.KIND_LABEL[hit.b.k] || hit.b.k) : ""}`, c.mouse.cx, c.mouse.cy); }
  });

  /* ---------- numbers and the memory list ---------- */
  const $ = (id) => document.getElementById(id);
  let tpsShown = 0, usdShown = spendTotal();
  function numbers() {
    tpsShown = lerp(tpsShown, tpsNow, 0.35);
    usdShown = lerp(usdShown, spendTotal(), 0.35);
    const fl = PX.fleet();
    $("hv-tps").textContent = Math.round(tpsShown);
    $("hs-tps").textContent = `${fmt.tok(fl.tokensToday)} tokens today`;
    $("hv-usd").textContent = fmt.money(usdShown);
    $("hs-usd").textContent = charts[1].projected ? `${fmt.money(charts[1].projected)} by midnight` : "";
    const calls = runs.reduce((a, r) => a + r.activity.reduce((x, b) => x + b.n, 0), 0);
    $("hv-act").textContent = calls.toLocaleString();
    $("hs-act").textContent = `${Math.round(runs.reduce((a, r) => a + (r.activity[29]?.n || 0) + (r.activity[28]?.n || 0), 0) / 2)} a minute now`;
    $("hv-mem").textContent = `${fl.memUsed.toFixed(1)} GB`;
    $("hs-mem").textContent = `of ${fl.memTotal} GB`;
    $("mem").innerHTML = fl.mem.slice().sort((a, b) => b.gb - a.gb).slice(0, 4).map((m) => `<li><span>${fmt.esc(m.run ? name(m.run) : "Pixel and system")}</span><span class="mb"><i style="width:${((m.gb / fl.memTotal) * 100).toFixed(1)}%"></i></span><b>${m.gb.toFixed(1)}</b></li>`).join("");
  }

  readColors();
  PX.on("theme", () => setTimeout(readColors, 0));
  let raf = 0;
  const frame = () => { for (const c of charts) { if (!c.w) continue; c.ctx.clearRect(0, 0, c.w, c.h); c.draw(c); } raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);
  setInterval(numbers, 500);
  numbers();
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAnimationFrame(raf); else raf = requestAnimationFrame(frame); });
})();
