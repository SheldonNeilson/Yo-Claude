// The mini bar (mascot, blocky level meter, prompt line, caption, stop): the floating compact bar, and the same
// thing embedded in the main window next to [talk]. Only one of the two is ever on screen.
"use strict";
class MiniBar {
  static ACTIVE = ["listening", "thinking", "speaking", "using_pc", "approval"];
  static SPIN = "·✢✳✶✻✽✻✶✳✢";
  static HISTORY = 600;   // level readings kept: enough to fill a full-width meter with one column per reading

  // thinking: seconds per hop and of that travelling, seconds a node stays lit, links of the chain kept
  static HOP = 0.62; static TRAVEL = 0.3; static GLOW = 2.6; static HIST = 8;
  static hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  // smooth 1-D value noise in [0, 1] (the idle twinkle of the thinking network)
  static noise(x) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return MiniBar.hash(i) * (1 - u) + MiniBar.hash(i + 1) * u;
  }

  // "thinking" is not a meter: a faint scatter of nodes where a spark hops node to node along dotted links, each node it
  // reaches stays lit a while, and after a few hops the whole chain flashes (a thought formed) and a new one starts elsewhere.
  // Laid out once per canvas size; the walk is stateful but advanced from the clock, so a throttled window doesn't burst.
  thinkLayout(c) {
    let L = this.think;
    if (L && L.w === c.width && L.h === c.height) return L;
    const cols = Math.max(1, Math.floor((c.width + 1) / 5)), rows = Math.max(1, Math.floor((c.height + 1) / 4));
    const oy = Math.floor((c.height - (rows * 4 - 1)) / 2), n = Math.max(4, Math.floor(cols / 2));
    L = this.think = { w: c.width, h: c.height, n, x: new Int16Array(n), y: new Int16Array(n), lit: new Float32Array(n).fill(-99), walkers: [] };
    let prev = -1;
    for (let i = 0; i < n; i++) {   // one node per 2 columns, jittered, never on the row of the node before
      let r = Math.floor(MiniBar.hash(i * 3.1 + 7) * rows);
      if (r === prev) r = (r + 1 + Math.floor(rows / 2)) % rows;
      prev = r;
      L.x[i] = Math.min(cols - 1, i * 2 + Math.floor(MiniBar.hash(i * 1.7) * 2)) * 5; L.y[i] = oy + r * 4;
    }
    const nw = Math.max(1, Math.min(3, Math.round(c.width / 240)));   // a wide bar thinks in a few places at once
    for (let k = 0; k < nw; k++)
      L.walkers.push({ lo: Math.floor(k * n / nw), hi: Math.floor((k + 1) * n / nw) - 1, hist: new Int16Array(MiniBar.HIST), len: 0, at: 0, dir: 1, left: 0, rest: 0 });
    L.fresh = true;
    return L;
  }
  newThought(L, w, t) {   // a new chain starts on a random node of this walker's stretch
    w.hist[0] = w.lo + Math.floor(Math.random() * (w.hi - w.lo + 1)); w.len = 1;
    w.dir = Math.random() < 0.5 ? -1 : 1; w.left = 4 + Math.floor(Math.random() * 4); w.at = t; w.rest = 0;
    L.lit[w.hist[0]] = t;
  }
  stepThought(L, w, t) {
    if (t - w.at > 3) w.at = t - MiniBar.HOP;   // after a stall (hidden window), carry on rather than catch up
    if (w.rest) { if (t >= w.rest) this.newThought(L, w, t); return; }
    if (t - w.at < MiniBar.HOP) return;
    w.at += MiniBar.HOP;
    const cur = w.hist[w.len - 1];
    let nx = -1, best = -1;   // a nearby node not already in the chain, mostly onward in the walk's direction
    if (w.left-- > 0) for (let i = w.lo; i <= w.hi; i++) {
      const dx = L.x[i] - L.x[cur], dy = L.y[i] - L.y[cur], d = Math.hypot(dx, dy);
      if (d < 4 || d > 26 || this.inChain(w, i)) continue;
      const score = Math.random() * (dx * w.dir > 0 ? 3 : 1);
      if (score > best) { best = score; nx = i; }
    }
    if (nx < 0) {   // the thought is complete (or boxed in): light the whole chain together, pause, then start another
      for (let k = 0; k < w.len; k++) L.lit[w.hist[k]] = t;
      w.rest = t + 1.1; return;
    }
    if (L.x[nx] < L.x[w.lo] + 15) w.dir = 1; else if (L.x[nx] > L.x[w.hi] - 15) w.dir = -1;   // turn back near the ends
    if (w.len === MiniBar.HIST) w.hist.copyWithin(0, 1); else w.len++;
    w.hist[w.len - 1] = nx;
  }
  inChain(w, i) { for (let k = 0; k < w.len; k++) if (w.hist[k] === i) return true; return false; }
  link(g, L, a, b, upto) {   // dotted link between two nodes' centres, drawn from a up to fraction `upto`
    const x0 = L.x[a] + 1, y0 = L.y[a] + 1, dx = L.x[b] - L.x[a], dy = L.y[b] - L.y[a];
    const steps = Math.max(2, Math.round(Math.hypot(dx, dy) / 3));
    for (let s = 1; s < steps && s <= steps * upto; s++) g.fillRect(Math.round(x0 + dx * s / steps), Math.round(y0 + dy * s / steps), 2, 1);
  }
  drawThinking(g, c, t, act) {
    const L = this.thinkLayout(c), on = act ? 1 : 0.55;
    if (L.fresh) { L.fresh = false; for (const w of L.walkers) this.newThought(L, w, t); }
    for (let i = 0; i < L.n; i++) {   // the network: faint dots, a slow twinkle; lit nodes are full blocks fading back
      const glow = Math.max(0, 1 - (t - L.lit[i]) / MiniBar.GLOW);
      if (glow > 0) { g.globalAlpha = on * (0.2 + 0.8 * glow * glow); g.fillRect(L.x[i], L.y[i], 4, 3); }
      else { g.globalAlpha = on * (0.18 + 0.22 * MiniBar.noise(i * 1.9 + t * 0.35)); g.fillRect(L.x[i] + 1, L.y[i] + 1, 2, 1); }
    }
    for (const w of L.walkers) {
      this.stepThought(L, w, t);
      const last = w.len - 1, p = w.rest ? 1 : Math.min(1, (t - w.at) / MiniBar.TRAVEL);
      for (let k = 0; k < last; k++) {   // the chain so far, older links fainter; the newest one grows as the spark travels
        g.globalAlpha = on * (w.rest ? 0.25 + 0.5 * Math.max(0, (w.rest - t) / 1.1) : 0.12 + 0.5 * ((k + 1) / last) ** 2);
        this.link(g, L, w.hist[k], w.hist[k + 1], k === last - 1 ? p : 1);
      }
      if (w.rest || !last) continue;
      const a = w.hist[last - 1], b = w.hist[last];
      if (p >= 1) { if (L.lit[b] < w.at) L.lit[b] = t; continue; }   // arrived: the node lights
      const e = p * p * (3 - 2 * p), x = Math.round(L.x[a] + (L.x[b] - L.x[a]) * e), y = Math.round(L.y[a] + (L.y[b] - L.y[a]) * e);
      g.globalAlpha = on; g.fillRect(x + 1, y, 2, 3); g.fillRect(x, y + 1, 4, 1);   // the spark: a small bright cross
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
      if (e.state === "thinking" && this.state !== "thinking" && this.think) this.think.fresh = true;   // each thinking spell starts new chains
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
      background: MiniBar.SPIN[Math.floor(t * 4) % MiniBar.SPIN.length] + " background task running",
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
    lab.style.color = act ? color : "var(--dim)";
    const c = this.q(".mb-meter"), g = c.getContext("2d");
    if (c.clientWidth && Math.abs(c.width - c.clientWidth) > 4) c.width = c.clientWidth;   // stretches in the window
    g.clearRect(0, 0, c.width, c.height);
    const mid = Math.floor(c.height / 2) - 2;
    const cols = Math.max(1, Math.floor((c.width + 1) / 5)), len = this.levels.length;
    if (this.state === "thinking") { g.fillStyle = color; this.drawThinking(g, c, t, act); }
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
