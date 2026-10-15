/*
 * Pixel mockup, round 9: the fleet tape. One track per run over the last 6 hours, drawn like an audio
 * waveform of tool calls, with marks where something happened: findings (dots, red when high severity),
 * questions (amber diamond), crashes and recoveries (amber tick), start (bracket) and finish (bar).
 * Grey carries the shape; blue is only "now"; amber and red only mark trouble. Hover a track to read it,
 * click to open the run.
 */
(function () {
  "use strict";
  const { runs, find, name, isLive, fmt } = PX;
  const S = 1000, M = 60 * S, H = 60 * M, SPAN = 6 * H, BUCKET = 2 * M, NB = SPAN / BUCKET;
  const T0 = Date.now();
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    C = { s1: v("--s1"), s2: v("--s2"), s3: v("--s3"), line: v("--line"), line2: v("--line-2"), ink: v("--ink"), ink2: v("--ink-2"), ink3: v("--ink-3"), ink4: v("--ink-4"), acc: v("--accent-c"), warn: v("--warning"), bad: v("--critical"), mono: v("--mono"), sans: v("--sans") };
  }
  const rgba = (hex, a) => { const n = parseInt(hex.replace("#", ""), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

  /* ---------- per-run history: tool calls per 2-minute bucket, plus events ---------- */
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const tracks = runs
    .filter((r) => (r.finished || T0) > T0 - SPAN && r.started < T0)
    .sort((a, b) => a.started - b.started)
    .map((r) => {
      const b = new Array(NB).fill(0);
      const end = r.finished || T0;
      const phase = rnd() * 6, speed = 0.08 + rnd() * 0.08, base = r.tpsBase > 100 ? 14 : 10;
      for (let i = 0; i < NB; i++) {
        const t = T0 - SPAN + i * BUCKET;
        if (t < r.started || t > end) continue;
        const wave = 0.5 + 0.3 * Math.sin(i * speed * 0.6 + phase) + 0.2 * Math.sin(i * speed * 1.7 + phase * 2);
        b[i] = Math.max(0, base * wave * (0.85 + rnd() * 0.3));
      }
      // the last 30 minutes come from the live per-minute data
      for (let m = 0; m < 30; m++) { const i = NB - 15 + Math.floor(m / 2) - 0; if (i >= 0 && i < NB) b[i] = (m % 2 ? b[i] : 0) + (r.activity[m]?.n || 0); }
      if (r.status === "failed") b.fill(0);
      const ev = [{ t: r.started, k: "start" }];
      if (r.finished) ev.push({ t: r.finished, k: "finish" });
      if (r.question) ev.push({ t: r.question.at, k: "ask", text: "Asked you a question" });
      if (r.status === "failed") ev.push({ t: T0 - 28 * M, k: "fail", text: r.detail });
      if (r.ooms) ev.push({ t: T0 - 3 * H, k: "crash", text: "opencode OOM-killed, restarted" }, { t: T0 - 2 * M, k: "crash", text: "opencode OOM-killed, restarting" });
      if (r.continues) for (let c = 0; c < Math.min(r.continues, 3); c++) ev.push({ t: T0 - (40 + c * (70 + (r.id.length % 5) * 17)) * M, k: "cont", text: "Went idle, Pixel sent continue" });
      for (const f of K.findingsOf(r.id)) ev.push({ t: f.at, k: "find", sev: f.sev, text: f.title, id: f.id });
      return { r, b, ev: ev.filter((e) => e.t > T0 - SPAN) };
    });
  PX.on("tick", (e) => { const tr = tracks.find((x) => x.r.id === e.run); if (tr) tr.b[NB - 1] += 1; });

  /* ---------- markup ---------- */
  const root = document.getElementById("tape");
  root.innerHTML = `<div class="tape-h"><div class="tape-t"><span class="ttl">Last 6 hours</span><span class="lg"><i class="lg-find"></i>finding<i class="lg-ask"></i>question<i class="lg-crash"></i>crash or continue</span></div><div class="ro" id="ro"></div></div><div class="tape-c"><canvas id="cv-tape" role="img" aria-label="Tool-call activity per run over the last six hours, with findings, questions and crashes marked"></canvas></div>`;
  const cv = document.getElementById("cv-tape"), ctx = cv.getContext("2d");
  const tip = document.createElement("div");
  tip.className = "tip"; tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  let W = 0, Hh = 0, mouse = null;
  const ROW = 38, LW = 168, AX = 20;
  function fit() {
    const dpr = Math.min(2, devicePixelRatio || 1), b = cv.parentElement.getBoundingClientRect();
    W = b.width; Hh = tracks.length * ROW + AX;
    cv.style.height = Hh + "px"; cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(fit).observe(cv.parentElement); fit();
  cv.addEventListener("mousemove", (e) => { const b = cv.getBoundingClientRect(); mouse = { x: e.clientX - b.left, y: e.clientY - b.top, cx: e.clientX, cy: e.clientY }; });
  cv.addEventListener("mouseleave", () => { mouse = null; tip.classList.remove("on"); cv.style.cursor = ""; });
  cv.addEventListener("click", () => { if (hoverRow != null) PX.ui.openRun(tracks[hoverRow].r.id); });

  const X = (t) => LW + ((t - (Date.now() - SPAN)) / SPAN) * (W - LW - 8);
  const statusColor = (r) => (r.question || ["recovering", "stopped"].includes(r.status) ? C.warn : r.status === "failed" ? C.bad : isLive(r) ? C.acc : C.ink4);
  let hoverRow = null;

  function draw() {
    ctx.clearRect(0, 0, W, Hh);
    const now = Date.now(), pw = W - LW - 8;
    // hour grid
    ctx.font = `400 10.5px ${C.mono}`; ctx.textBaseline = "alphabetic"; ctx.textAlign = "center";
    for (let h = 0; h <= 6; h++) {
      const t = now - SPAN + h * H, x = Math.round(LW + (h / 6) * pw) + 0.5;
      ctx.strokeStyle = C.line2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, Hh - AX); ctx.stroke();
      ctx.fillStyle = C.ink3;
      ctx.fillText(h === 6 ? "now" : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }), x, Hh - 5);
    }
    hoverRow = mouse && mouse.y < Hh - AX ? Math.floor(mouse.y / ROW) : null;
    if (hoverRow != null && hoverRow >= tracks.length) hoverRow = null;
    cv.style.cursor = hoverRow != null ? "pointer" : "";
    const bw = pw / NB;
    tracks.forEach((tr, ri) => {
      const r = tr.r, y0 = ri * ROW, mid = y0 + ROW / 2, amp = ROW / 2 - 7;
      if (ri === hoverRow) { ctx.fillStyle = C.s2; ctx.fillRect(0, y0 + 1, W, ROW - 2); }
      // label: status dot and name
      ctx.fillStyle = statusColor(r); ctx.beginPath(); ctx.arc(6, mid, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = `400 12.5px ${C.sans}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillStyle = isLive(r) || r.question ? C.ink : C.ink3;
      let label = name(r); while (ctx.measureText(label).width > LW - 34 && label.length > 3) label = label.slice(0, -2) + "…";
      ctx.fillText(label, 18, mid);
      // baseline
      ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(LW, mid + 0.5); ctx.lineTo(LW + pw, mid + 0.5); ctx.stroke();
      // waveform: a smooth mirrored shape of tool calls; the last 30 minutes of a live run are brighter
      const max = 13, sm = tr.b.map((v, i) => (tr.b[Math.max(0, i - 1)] + 2 * v + tr.b[Math.min(NB - 1, i + 1)]) / 4);
      const seg = (from, to, col) => {
        let open = false;
        const pts = [];
        for (let i = from; i < to; i++) pts.push([LW + (i + 0.5) * bw, Math.min(1, sm[i] / max) * amp]);
        if (!pts.some(([, a]) => a > 0.3)) return;
        ctx.beginPath();
        pts.forEach(([x, a], k) => (k ? ctx.lineTo(x, mid - a) : ctx.moveTo(x, mid - a)));
        for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], mid + pts[k][1]);
        ctx.closePath(); ctx.fillStyle = col; ctx.fill();
      };
      const cut = isLive(r) ? NB - 15 : NB;
      seg(0, Math.min(NB, cut + 1), rgba(C.ink3, 0.45));
      if (cut < NB) seg(cut, NB, rgba(C.ink2, 0.85));
      // events
      for (const e of tr.ev) {
        const x = X(e.t);
        if (e.k === "start") { ctx.strokeStyle = C.ink3; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + 3, mid - amp); ctx.lineTo(x, mid - amp); ctx.lineTo(x, mid + amp); ctx.lineTo(x + 3, mid + amp); ctx.stroke(); }
        else if (e.k === "finish") { ctx.fillStyle = C.ink2; ctx.fillRect(x - 1, mid - amp, 2, amp * 2); }
        else if (e.k === "find") { ctx.beginPath(); ctx.arc(x, y0 + 5, e.sev === "high" ? 3.5 : 3, 0, Math.PI * 2); ctx.fillStyle = e.sev === "high" ? C.bad : C.ink2; ctx.fill(); ctx.strokeStyle = C.s1; ctx.lineWidth = 1.5; ctx.stroke(); }
        else if (e.k === "ask") { ctx.save(); ctx.translate(x, y0 + 6); ctx.rotate(Math.PI / 4); ctx.fillStyle = C.warn; ctx.fillRect(-3, -3, 6, 6); ctx.restore(); }
        else if (e.k === "crash" || e.k === "cont") { ctx.strokeStyle = C.warn; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, mid - amp); ctx.lineTo(x, mid + amp); ctx.stroke(); }
        else if (e.k === "fail") { ctx.strokeStyle = C.bad; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 3, mid - 3); ctx.lineTo(x + 3, mid + 3); ctx.moveTo(x + 3, mid - 3); ctx.lineTo(x - 3, mid + 3); ctx.stroke(); }
      }
      // live head
      if (isLive(r) && r.status === "running" && !r.question) { ctx.fillStyle = C.acc; ctx.beginPath(); ctx.arc(LW + pw, mid, 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = C.line2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y0 + ROW + 0.5); ctx.lineTo(W, y0 + ROW + 0.5); ctx.stroke();
    });
    // now line
    ctx.strokeStyle = rgba(C.acc, 0.7); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(LW + pw + 0.5, 0); ctx.lineTo(LW + pw + 0.5, Hh - AX); ctx.stroke();
    // hover
    if (mouse && hoverRow != null && mouse.x > LW) {
      const tr = tracks[hoverRow], t = now - SPAN + ((mouse.x - LW) / pw) * SPAN, i = Math.max(0, Math.min(NB - 1, Math.floor((mouse.x - LW) / bw)));
      ctx.strokeStyle = C.ink3; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(mouse.x) + 0.5, hoverRow * ROW + 2); ctx.lineTo(Math.round(mouse.x) + 0.5, hoverRow * ROW + ROW - 2); ctx.stroke();
      const near = tr.ev.filter((e) => e.text && Math.abs(X(e.t) - mouse.x) < 8);
      const ago = now - t;
      tip.innerHTML = `<div class="tt">${fmt.esc(name(tr.r))} · ${ago < 2 * M ? "now" : `${fmt.dur(ago)} ago`}</div><div class="tr"><span></span><span>Tool calls</span><b>${tr.b[i]}</b></div>${near.map((e) => `<div class="tr"><span></span><span>${fmt.esc(e.text)}</span><b></b></div>`).join("")}`;
      tip.classList.add("on");
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(innerWidth - w - 8, mouse.cx + 14) + "px"; tip.style.top = Math.max(8, mouse.cy - h - 12) + "px";
    } else if (mouse) tip.classList.remove("on");
  }

  /* ---------- readouts: three numbers with a tiny picture each ---------- */
  const hist = Array.from({ length: 40 }, (_, i) => runs.reduce((a, r) => a + (r.tpsHist[50 + i] || 0), 0));
  function readouts() {
    const fl = PX.fleet();
    hist.push(fl.tps); hist.shift();
    const mx = Math.max(1, ...hist);
    const spark = `<svg viewBox="0 0 80 18" width="80" height="18" aria-hidden="true"><polyline points="${hist.map((v, i) => `${(i / (hist.length - 1)) * 80},${17 - (v / mx) * 15}`).join(" ")}" style="fill:none;stroke:var(--accent-c);stroke-width:1.25;stroke-linejoin:round"/></svg>`;
    const mem = fl.memUsed / fl.memTotal;
    const blocks = Array.from({ length: 15 }, (_, i) => `<i class="${i < Math.round(fl.memUsed) ? "on" : ""}"></i>`).join("");
    document.getElementById("ro").innerHTML = `<span class="r" title="Output tokens per second, last 80 seconds">${spark}<b>${Math.round(fl.tps)}</b><small>tok/s</small></span><span class="r" title="Spent today, and where today ends at the current rate"><b>${fmt.money(fl.spend)}</b><small>today · ${fmt.money(fl.projected)} by midnight</small></span><span class="r" title="Memory used, one block per GB"><span class="blocks${mem > 0.85 ? " warn" : ""}">${blocks}</span><b>${fl.memUsed.toFixed(1)}</b><small>of ${fl.memTotal} GB</small></span>`;
  }

  readColors();
  PX.on("theme", () => setTimeout(readColors, 0));
  let raf = 0;
  const frame = () => { draw(); raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);
  setInterval(readouts, 2000); readouts();
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAnimationFrame(raf); else raf = requestAnimationFrame(frame); });
})();
