// The mini bar (mascot, blocky level meter, prompt line, caption, stop): the floating compact bar, and the same
// thing embedded in the main window next to [talk]. Only one of the two is ever on screen.
"use strict";
class MiniBar {
  static ACTIVE = ["listening", "thinking", "speaking", "using_pc", "approval"];
  static SPIN = "·✢✳✶✻✽✻✶✳✢";
  static HISTORY = 600;   // level readings kept: enough to fill a full-width meter with one column per reading

  // smooth 1-D value noise in [0, 1] (for the "thinking" pattern: uneven, drifting, never a plain wave)
  static noise(x) {
    const i = Math.floor(x), f = x - i, h = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
    const u = f * f * (3 - 2 * f);
    return h(i) * (1 - u) + h(i + 1) * u;
  }
  thinkingLevel(i, cols, t) {
    const n = MiniBar.noise;
    const ripple = 0.65 * n(i * 0.42 - t * 1.6) + 0.35 * n(i * 1.3 + t * 2.7);   // slow drift + faster chatter
    const swell = 0.35 + 0.65 * n(i * 0.09 + t * 0.45 + 40);                     // busier and quieter stretches
    const sweep = (t * 22) % (cols + 30) - 15;                     // a bright pulse runs across every few seconds
    const pulse = Math.exp(-((i - sweep) ** 2) / 8);
    const sparkle = n(i * 3.7 + Math.floor(t * 12) * 1.3) > 0.9 ? 0.4 : 0;     // the odd column flickers up
    return Math.min(1, 0.04 + 1.05 * (ripple * swell) ** 1.3 + 0.7 * pulse + sparkle);
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
      this.state = e.state; this.text = e.text || "";
      this.holdUntil = e.hold ? Date.now() + e.hold * 1000 : 0;
      this.layout();
    }
  }
  label(t) {
    const cur = Math.floor(t * 2) % 2 ? "█" : " ";
    return {
      starting: "> booting" + cur, idle: `> say "${(typeof S !== "undefined" && S.settings?.character === "female") ? "yo claudia" : "yo claude"}"` + cur, paused: "> wake word off · click to talk",
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
    for (let i = 0; i < cols; i++) {   // one column per reading, newest at the right: wider = more history, not stretched
      let lv = this.levels[len - cols + i] || 0;
      if (this.state === "thinking") lv = this.thinkingLevel(i, cols, t);
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
