// The mini bar (mascot, blocky level meter, prompt line, caption, stop): the floating compact bar, and the same
// thing embedded in the main window next to [talk]. Only one of the two is ever on screen.
"use strict";
class MiniBar {
  static ACTIVE = ["listening", "thinking", "speaking", "using_pc", "approval"];
  static SPIN = "·✢✳✶✻✽✻✶✳✢";

  // root holds .mb-m (mascot canvas), .mb-meter (canvas), .mb-label, .mb-text and optionally .mb-stop
  constructor(root, { onLayout } = {}) {
    this.root = root;
    this.q = (s) => root.querySelector(s);
    this.onLayout = onLayout;
    this.state = "starting"; this.text = ""; this.holdUntil = 0;
    this.levels = new Array(24).fill(0);
    this.colors = Object.assign({}, MASCOT.colors, { idle: "#b06a52" });
    this.q(".mb-m").onclick = () => api().talk();
    const stop = this.q(".mb-stop");
    if (stop) stop.onclick = () => api().stop();
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
      starting: "> booting" + cur, idle: '> say "yo claude"' + cur, paused: "> wake word off · click to talk",
      listening: (this.text ? "> follow-up? " : "> listening ") + cur,
      thinking: MiniBar.SPIN[Math.floor(t * 8) % MiniBar.SPIN.length] + " thinking…", speaking: "● claude",
      using_pc: "⌖ using your pc…", approval: "! claude needs your ok", error: "! microphone unavailable",
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
    g.clearRect(0, 0, c.width, c.height);
    const mid = Math.floor(c.height / 2) - 2;
    this.levels.forEach((lv, i) => {
      if (this.state === "thinking") lv = 0.35 + 0.3 * Math.sin(t * 6 - i * 0.5);
      if (this.state === "paused") lv = 0;
      const n = Math.min(4, Math.round(lv * 4));
      g.globalAlpha = (0.3 + 0.7 * (i + 1) / 24) * (act ? 1 : 0.55);
      g.fillStyle = color;
      const x = i * 5;
      g.fillRect(x, mid, 4, 3);
      for (let k = 1; k <= n; k++) { g.fillRect(x, mid - k * 4, 4, 3); g.fillRect(x, mid + k * 4, 4, 3); }
    });
    g.globalAlpha = 1;
    if (this.holdUntil && Date.now() > this.holdUntil) { this.holdUntil = 0; this.layout(); }
    requestAnimationFrame(() => this.draw());
  }
}
