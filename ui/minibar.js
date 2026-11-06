// The mini bar (mascot, blocky level meter, prompt line, caption, stop): the floating compact bar, and the same
// thing embedded in the main window next to [talk]. Only one of the two is ever on screen.
"use strict";
class MiniBar {
  static ACTIVE = ["listening", "thinking", "speaking", "using_pc", "approval"];
  static SPIN = "·✢✳✶✻✽✻✶✳✢";
  static HISTORY = 600;   // level readings kept: enough to fill a full-width meter with one column per reading

  // thinking, a firing neural network. Seconds a neuron flashes, then lies dim (refractory) before it can fire again;
  // pulse speed in cells per second; chance a firing neuron sends a pulse down each other branch; charge a pulse adds (it
  // fires once charge beats a random threshold, so two pulses close together nearly always fire it); seconds charge leaks;
  // spontaneous firings per neuron per second (4x while nothing is in flight); most pulses in flight per neuron.
  static FLASH = 0.16; static REFRACT = 1.2; static SPEED = 7; static FANOUT = 0.65; static KICK = 0.75; static LEAK = 0.8;
  static SPONT = 0.025; static PULSES = 0.45; static WIDE_RATE = 0.65;   // WIDE_RATE: the speed (of everything) at 560 px and wider; 160 px and under run at 1
  static hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  // smooth 1-D value noise in [0, 1] (the idle shimmer of the resting neurons)
  static noise(x) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return MiniBar.hash(i) * (1 - u) + MiniBar.hash(i + 1) * u;
  }

  // "thinking" is not a meter: neurons on the bar's block grid, wired to their nearest neighbours by faint stepped
  // branches. A neuron that fires flashes, goes dim a while, and sends pulses down several branches at once; a pulse that
  // arrives charges its neuron and may fire it in turn, so activity cascades and dies down, and stray firings start new
  // cascades. Laid out once per canvas size into typed arrays; the simulation runs on its own clock that never moves more
  // than 0.1 s a frame, so a throttled window pauses rather than bursts.
  thinkLayout(c) {
    let L = this.think;
    if (L && L.w === c.width && L.h === c.height) return L;
    const cols = Math.max(1, Math.floor((c.width + 1) / 5)), rows = Math.max(1, Math.floor((c.height + 1) / 4));
    const oy = Math.floor((c.height - (rows * 4 - 1)) / 2), cell = new Int16Array(cols * rows).fill(-1);
    const bands = Math.max(1, Math.round(rows / 4)), bins = Math.max(1, Math.floor(cols / 4)), cx = [], cy = [];
    for (let b = 0; b < bins * bands; b++) {   // one neuron per 4-column, ~4-row bin, jittered, kept apart
      const band = Math.floor(b / bins), c0 = (b % bins) * 4, r0 = Math.floor(band * rows / bands), r1 = Math.floor((band + 1) * rows / bands);
      for (let tr = 0; tr < 4; tr++) {
        const x = Math.min(cols - 1, c0 + Math.floor(MiniBar.hash(b * 5.3 + tr * 17.9) * 4));
        const y = r0 + Math.floor(MiniBar.hash(b * 2.9 + tr * 11.3 + 4) * (r1 - r0));
        let ok = true;
        for (let k = 0; k < cx.length && ok; k++) ok = Math.abs(cx[k] - x) >= 3 || Math.abs(cy[k] - y) >= 2;
        if (ok) { cell[y * cols + x] = cx.length; cx.push(x); cy.push(y); break; }
      }
    }
    const n = cx.length, ea = [], eb = [], path = [];
    const d2 = (i, j) => ((cx[i] - cx[j]) * 5) ** 2 + ((cy[i] - cy[j]) * 4) ** 2;
    for (let i = 0; i < n; i++) {   // branches to the 3 nearest neighbours in reach whose stepped path crosses no other neuron
      const near = [];
      for (let j = 0; j < n; j++) if (j !== i && d2(i, j) <= 40 * 40) near.push(j);
      near.sort((p, q) => d2(i, p) - d2(i, q));
      let made = 0;
      for (const j of near) {
        if (made === 3) break;
        let dup = false;
        for (let e = 0; e < ea.length && !dup; e++) dup = (ea[e] === i && eb[e] === j) || (ea[e] === j && eb[e] === i);
        if (dup) { made++; continue; }
        const dx = cx[j] - cx[i], dy = cy[j] - cy[i], steps = Math.max(Math.abs(dx), Math.abs(dy)), cells = [];
        let clear = true;
        for (let s = 1; s < steps && clear; s++) {
          const x = cx[i] + Math.round(dx * s / steps), y = cy[i] + Math.round(dy * s / steps);
          if (cell[y * cols + x] >= 0) clear = false; else cells.push(x, y);
        }
        if (clear) { ea.push(i); eb.push(j); path.push(cells); made++; }
      }
    }
    const ne = ea.length;
    L = this.think = { w: c.width, h: c.height, n, ne, x: new Int16Array(n), y: new Int16Array(n),
      fired: new Float32Array(n), v: new Float32Array(n), vt: new Float32Array(n),
      ea: Int16Array.from(ea), eb: Int16Array.from(eb), eoff: new Int16Array(ne + 1), adj: new Int16Array(ne * 2), aoff: new Int16Array(n + 1),
      cap: Math.max(6, Math.min(40, Math.round(n * MiniBar.PULSES))), now: 0, last: -1,
      rate: Math.max(MiniBar.WIDE_RATE, Math.min(1, 1 - (c.width - 160) / 400 * (1 - MiniBar.WIDE_RATE))) };   // (a wide bar has many more neurons: it runs slower, so the pulses stay easy to follow)
    for (let i = 0; i < n; i++) { L.x[i] = cx[i] * 5; L.y[i] = oy + cy[i] * 4; }
    let len = 0;   // branch cells, flat: edge e's run from its ea end to its eb end is eoff[e] .. eoff[e + 1] - 1
    for (let e = 0; e < ne; e++) { L.eoff[e] = len; len += path[e].length / 2; }
    L.eoff[ne] = len; L.px = new Int16Array(len); L.py = new Int16Array(len);
    const wire = new Uint8Array(cols * rows);   // and each wired cell once, for the faint wiring drawn every frame
    for (let e = 0; e < ne; e++) for (let k = 0; k < path[e].length; k += 2) {
      const at = L.eoff[e] + k / 2, x = path[e][k], y = path[e][k + 1];
      L.px[at] = x * 5; L.py[at] = oy + y * 4; wire[y * cols + x] = 1;
    }
    let nw = 0; for (const f of wire) nw += f;
    L.wx = new Int16Array(nw); L.wy = new Int16Array(nw); nw = 0;
    for (let k = 0; k < wire.length; k++) if (wire[k]) { L.wx[nw] = (k % cols) * 5; L.wy[nw] = oy + Math.floor(k / cols) * 4; nw++; }
    for (let e = 0; e < ne; e++) { L.aoff[L.ea[e] + 1]++; L.aoff[L.eb[e] + 1]++; }   // each neuron's branches, as edge ids
    for (let i = 0; i < n; i++) L.aoff[i + 1] += L.aoff[i];
    const fill = L.aoff.slice(0, n);
    for (let e = 0; e < ne; e++) { L.adj[fill[L.ea[e]]++] = e; L.adj[fill[L.eb[e]]++] = e; }
    L.pe = new Int16Array(L.cap); L.pto = new Int16Array(L.cap).fill(-1); L.pt = new Float32Array(L.cap);   // pulses: edge, target (-1 = free), start
    L.fresh = true;
    return L;
  }
  fire(L, i, from, all) {   // neuron i fires (unless refractory): flash, and pulses down its other branches (all, or each by chance)
    if (L.now - L.fired[i] < MiniBar.FLASH + MiniBar.REFRACT) return;
    L.fired[i] = L.now; L.v[i] = 0;
    let slot = 0;
    for (let k = L.aoff[i]; k < L.aoff[i + 1]; k++) {
      const e = L.adj[k];
      if (e === from || (!all && Math.random() > MiniBar.FANOUT)) continue;
      while (slot < L.cap && L.pto[slot] >= 0) slot++;
      if (slot === L.cap) return;   // pulses capped: the rest of the fan-out is dropped
      L.pe[slot] = e; L.pto[slot] = L.ea[e] === i ? L.eb[e] : L.ea[e]; L.pt[slot] = L.now;
    }
  }
  stepThinking(L, t) {
    let dt = L.last < 0 ? 0 : Math.min(0.1, Math.max(0, t - L.last));
    L.last = t; L.now += dt *= L.rate;
    if (L.fresh) {   // a new thinking spell: everything at rest, and one cascade straight away
      L.fresh = false; L.fired.fill(-99); L.v.fill(0); L.pto.fill(-1);
      if (L.n) this.fire(L, Math.floor(Math.random() * L.n), -1, true);
    }
    let busy = false;
    for (let s = 0; s < L.cap; s++) {   // pulses arriving: charge the target, which fires if the charge beats a random threshold
      const j = L.pto[s];
      if (j < 0) continue;
      busy = true;
      const e = L.pe[s];
      if ((L.now - L.pt[s]) * MiniBar.SPEED < L.eoff[e + 1] - L.eoff[e] + 1) continue;
      L.pto[s] = -1;
      L.v[j] = L.v[j] * Math.exp(-(L.now - L.vt[j]) / MiniBar.LEAK) + MiniBar.KICK; L.vt[j] = L.now;
      if (L.v[j] > 0.2 + Math.random()) this.fire(L, j, e, false);
    }
    if (L.n && Math.random() < L.n * MiniBar.SPONT * (busy ? 1 : 4) * dt * L.rate) this.fire(L, Math.floor(Math.random() * L.n), -1, true);
  }
  // Background work (a command or subagent still running while Claude is idle): a radar sweep. A scan line crosses the bar with a
  // fading trail, and a few blips sit in the dark and light as it passes, then fade: "something is still going on out there".
  // The same violet and the same sweep as the little radar on the session rows. Nothing is stored; it's all a function of time.
  drawBackground(g, c, t, cols, mid) {
    const period = Math.max(2.6, cols / 22), head = (t / period) % 1 * cols, trail = Math.min(16, cols * 0.4), rows = Math.max(1, Math.floor((c.height - 3) / 8));
    g.globalAlpha = 0.12;   // the dark scope: a dotted midline
    for (let i = 0; i < cols; i += 2) g.fillRect(i * 5, mid, 4, 3);
    for (let i = 0; i < cols; i++) {   // the sweep: tall at its head, shorter and fainter behind it
      const d = (head - i + cols) % cols;
      if (d >= trail) continue;
      const f = 1 - d / trail, n = Math.round(f * f * rows * 2 / 2 + (d < 1 ? 1 : 0));
      g.globalAlpha = 0.15 + 0.85 * f * f;
      g.fillRect(i * 5, mid, 4, 3);
      for (let k = 1; k <= Math.min(rows, n); k++) { g.fillRect(i * 5, mid - k * 4, 4, 3); g.fillRect(i * 5, mid + k * 4, 4, 3); }
    }
    const blips = Math.max(2, Math.round(cols / 9));   // blips at fixed places, lit by the sweep and fading over about a turn
    for (let j = 0; j < blips; j++) {
      const bx = Math.floor(MiniBar.hash(j * 7.31 + 1) * cols), by = Math.floor(MiniBar.hash(j * 3.17 + 5) * (rows * 2 + 1)) - rows;
      const since = (head - bx + cols) % cols / cols;   // how far round the sweep is since it passed: 0 just now, 1 about to again
      g.globalAlpha = 0.14 + 0.86 * Math.max(0, 1 - since * 1.6) ** 2;
      g.fillRect(bx * 5, mid + by * 4, 4, 3);
    }
    g.globalAlpha = 1;
  }
  drawThinking(g, c, t, act) {
    const L = this.thinkLayout(c), on = act ? 1 : 0.55, F = MiniBar.FLASH, R = MiniBar.REFRACT;
    this.stepThinking(L, t);
    g.globalAlpha = on * 0.1;   // the wiring: faint, always there
    for (let k = 0; k < L.wx.length; k++) g.fillRect(L.wx[k], L.wy[k], 4, 3);
    for (let s = 0; s < L.cap; s++) {   // pulses: a bright block with a short fading tail, stepping cell to cell along the branch
      const j = L.pto[s];
      if (j < 0) continue;
      const e = L.pe[s], o = L.eoff[e], len = L.eoff[e + 1] - o, fwd = L.eb[e] === j;
      const head = Math.floor((L.now - L.pt[s]) * MiniBar.SPEED);
      for (let b = 0; b < 3; b++) {
        const k = head - b;   // 1..len are branch cells; 0 is the source neuron, len + 1 the target
        if (k < 1 || k > len) continue;
        const at = o + (fwd ? k - 1 : len - k);
        g.globalAlpha = on * (b === 0 ? 1 : b === 1 ? 0.45 : 0.2); g.fillRect(L.px[at], L.py[at], 4, 3);
      }
    }
    for (let i = 0; i < L.n; i++) {   // neurons: a resting glow (brighter as charge builds), a flash with a halo, a dim refractory spell
      const age = L.now - L.fired[i], x = L.x[i], y = L.y[i];
      const rest = 0.34 + 0.12 * MiniBar.noise(i * 1.9 + L.now * 0.4) + 0.35 * L.v[i] * Math.exp(-(L.now - L.vt[i]) / MiniBar.LEAK);
      let a = rest;
      if (age < F) {
        a = 1; g.globalAlpha = on * 0.5 * (1 - age / F);
        g.fillRect(x - 5, y, 4, 3); g.fillRect(x + 5, y, 4, 3); g.fillRect(x, y - 4, 4, 3); g.fillRect(x, y + 4, 4, 3);
      } else if (age < F + 0.25) a = 1 - 0.94 * (age - F) / 0.25;
      else if (age < F + R) a = 0.06 + (rest - 0.06) * ((age - F - 0.25) / (R - 0.25)) ** 2;
      g.globalAlpha = on * a; g.fillRect(x, y, 4, 3);
    }
    g.globalAlpha = 1;
  }

  // root holds .mb-m (mascot canvas), .mb-meter (canvas), .mb-label, .mb-text and optionally .mb-stop
  constructor(root, { onLayout } = {}) {
    this.root = root;
    this.q = (s) => root.querySelector(s);
    this.onLayout = onLayout;
    this.state = "starting"; this.text = ""; this.holdUntil = 0;
    this.levels = new Array(MiniBar.HISTORY).fill(0);   // newest last; a wider meter just shows more of it
    this.colors = Object.assign({}, MASCOT.colors, { idle: "#b06a52" });
    this.q(".mb-m").onclick = () => api().talk();
    const stop = this.q(".mb-stop");
    if (stop) stop.onclick = () => api().stop();
    const meter = this.q(".mb-meter");   // in the window it stretches: draw at its real width, never scaled
    new ResizeObserver(() => { if (meter.clientWidth && meter.width !== meter.clientWidth) meter.width = meter.clientWidth; }).observe(meter);
    requestAnimationFrame(() => this.draw());
  }
  loud(v) { return Math.min(1, Math.max(0, (20 * Math.log10((v || 1) / 32768) + 62) / 45)); }
  active() { return MiniBar.ACTIVE.includes(this.state); }
  event(e) {
    if (e.kind === "levels") for (const v of e.levels) { this.levels.push(this.loud(v)); this.levels.shift(); }
    if (e.kind === "display") {
      if (e.state === "thinking" && this.state !== "thinking" && this.think) this.think.fresh = true;   // each thinking spell starts afresh
      this.state = e.state; this.text = e.text || "";
      this.holdUntil = e.hold ? Date.now() + e.hold * 1000 : 0;
      this.layout();
    }
  }
  label(t) {
    const cur = Math.floor(t * 2) % 2 ? "█" : " ";
    return {
      starting: "> booting" + cur, idle: `> say "yo ${who()}"` + cur, paused: "> wake word off · click to talk",
      listening: (this.text ? "> follow-up? " : "> listening ") + cur,
      thinking: MiniBar.SPIN[Math.floor(t * 8) % MiniBar.SPIN.length] + " thinking…", speaking: "● " + who(),
      using_pc: "⌖ using your pc…", approval: "! " + who() + " needs your ok", error: "! microphone unavailable",
      background: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(t * 10) % 10] + " background task running",
    }[this.state] || this.state;
  }
  shownText() {
    if (this.active() || this.state === "error") return this.text;
    return Date.now() < this.holdUntil ? this.text : "";
  }
  layout() {
    const t = this.shownText(), box = this.q(".mb-text");
    box.textContent = t;
    box.classList.toggle("hidden", !t);
    this.q(".mb-stop")?.classList.toggle("hidden", !this.active());
    if (this.onLayout) this.onLayout();
  }
  draw() {
    const t = performance.now() / 1000, act = this.active();
    const color = this.colors[this.state] || this.colors.idle;
    const m = this.q(".mb-m");
    MASCOT.draw(m, this.state, this.levels.at(-1), t);
    m.style.opacity = act ? 1 : 0.75;
    const lab = this.q(".mb-label");
    lab.textContent = this.label(t);
    lab.style.color = act || this.state === "background" ? color : "var(--dim)";
    const c = this.q(".mb-meter"), g = c.getContext("2d");
    if (c.clientWidth && Math.abs(c.width - c.clientWidth) > 4) c.width = c.clientWidth;   // stretches in the window
    g.clearRect(0, 0, c.width, c.height);
    const mid = Math.floor(c.height / 2) - 2;
    const cols = Math.max(1, Math.floor((c.width + 1) / 5)), len = this.levels.length;
    if (this.state === "thinking") { g.fillStyle = color; this.drawThinking(g, c, t, act); }
    else if (this.state === "background") { g.fillStyle = color; this.drawBackground(g, c, t, cols, mid); }
    else for (let i = 0; i < cols; i++) {   // one column per reading, newest at the right: wider = more history, not stretched
      let lv = this.levels[len - cols + i] || 0;
      if (this.state === "paused") lv = 0;
      const n = Math.min(4, Math.round(lv * 4));
      g.globalAlpha = (0.3 + 0.7 * (i + 1) / cols) * (act ? 1 : 0.55);
      g.fillStyle = color;
      const x = i * 5;
      g.fillRect(x, mid, 4, 3);
      for (let k = 1; k <= n; k++) { g.fillRect(x, mid - k * 4, 4, 3); g.fillRect(x, mid + k * 4, 4, 3); }
    }
    g.globalAlpha = 1;
    if (this.holdUntil && Date.now() > this.holdUntil) { this.holdUntil = 0; this.layout(); }
    requestAnimationFrame(() => this.draw());
  }
}
