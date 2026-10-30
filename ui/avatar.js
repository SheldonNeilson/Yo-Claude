// Yo Claude's face: short clips of a real person (ui/avatar/*.mp4, made by scripts/make_avatar_clips.py), turned into
// ASCII live, frame by frame. The characters stay a fixed small size, so a wider panel gets more of them (more
// detail); the height follows, within part of the panel. Every clip starts from the same frame, so she switches
// clips seamlessly: a clip plays forward and back, and to change clips she rewinds quickly to that shared frame.
// She follows the voice (talking, listening, thinking) and, when idle, now and then looks around, plays with her
// hair or laughs.
"use strict";
const RAMP = " .:-=+o/*#0@";   // sparse to dense: white on the dark window, so bright = dense
const AW = 200;                // the analysis grid frames are decoded to (columns); more than any panel needs

const avatar = {
  el: null, pre: null, fxEl: null, fps: 12, clips: {}, ready: false,
  clip: "idle", frame: 0, dir: 1, rewinding: false, idleExtra: null, nextIdleExtra: 0,
  cols: 0, rows: 0, AH: 0, lv: null, glitchRow: -1,

  async init() {
    const side = $("#side"), foot = side.querySelector(".sidefoot");
    this.el = el("div", "avatar");
    this.el.dataset.tip = "Yo Claude · click to talk";
    this.el.onclick = () => api().talk();
    this.pre = el("pre");
    this.fxEl = el("div", "afx");
    this.el.append(this.pre, this.fxEl);
    side.insertBefore(this.el, foot);
    this.apply();
    let manifest;
    try { manifest = await (await fetch("avatar/clips.json", { cache: "no-store" })).json(); } catch (_) { return; }
    this.fps = manifest.fps || 12;
    for (const [name, count] of Object.entries(manifest.clips || {})) {
      try { this.clips[name] = await this.decode(`avatar/${name}.mp4`, count); } catch (e) { console.warn("avatar clip", name, e); }
      if (name === "idle" && this.clips.idle) { this.ready = true; this.fit(); }   // start as soon as idle is in
    }
    if (!this.ready) return;
    new ResizeObserver(() => this.fit()).observe(side);
    this.nextIdleExtra = Date.now() + 12000;
    setInterval(() => this.tick(), 1000 / this.fps);
  },
  apply() { this.el?.classList.toggle("hidden", S.settings?.avatar === false); },
  levels() {},   // app.js passes the voice loudness; the clips carry the mouth, so it isn't needed
  // the clip's frames as greyscale at AW columns (decoded once, by seeking through it)
  async decode(src, count) {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = src;
    await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(v.error); });
    this.AH = this.AH || Math.round(AW * v.videoHeight / v.videoWidth);
    const c = document.createElement("canvas"); c.width = AW; c.height = this.AH;
    const g = c.getContext("2d", { willReadFrequently: true });
    const frames = [];
    for (let i = 0; i < count; i++) {
      v.currentTime = Math.min(v.duration - 0.001, (i + 0.5) / this.fps);
      await new Promise((ok) => { v.onseeked = ok; });
      g.drawImage(v, 0, 0, AW, this.AH);
      const px = g.getImageData(0, 0, AW, this.AH).data, grey = new Uint8ClampedArray(AW * this.AH);
      for (let j = 0, k = 0; j < grey.length; j++, k += 4) grey[j] = (px[k] * 77 + px[k + 1] * 150 + px[k + 2] * 29) >> 8;
      frames.push(grey);
    }
    return frames;
  },
  // how many characters fit: fixed-size characters, as many as the panel's width allows, the height kept in bounds
  fit() {
    if (!this.ready) return;
    const side = $("#side"), width = this.el.clientWidth - 8;
    const probe = this.fit.probe || (this.fit.probe = Object.assign(document.createElement("span"), { textContent: "@".repeat(50) }));
    if (!probe.isConnected) this.pre.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 50 || 3;
    probe.remove();
    let cols = Math.max(30, Math.min(AW, Math.floor(width / cw)));
    const maxRows = Math.floor((side.clientHeight * 0.45) / (cw * 2));
    let rows = Math.round(cols * this.AH / AW / 2);
    if (rows > maxRows) { rows = Math.max(20, maxRows); cols = Math.round(rows * 2 * AW / this.AH); }
    this.pre.style.lineHeight = (cw * 2) + "px";   // keep the cells about twice as tall as wide
    if (cols !== this.cols || rows !== this.rows) { this.cols = cols; this.rows = rows; this.lv = null; }
  },
  state() {
    const d = S.display || {};
    if (d.state === "approval") return "approval";
    if (d.state === "using_pc") return "using_pc";
    if (["listening", "speaking", "paused", "error"].includes(d.voice)) return d.voice;
    if (d.state === "thinking" || d.voice === "thinking") return "thinking";
    return d.state === "paused" ? "paused" : "idle";
  },
  clipFor(st) {
    const has = (c) => this.clips[c] ? c : "idle";
    return { speaking: has("talking"), listening: has("listening"), thinking: has("thinking"), using_pc: has("looking"),
             approval: has("listening") }[st] || "idle";
  },

  // one frame of greyscale -> ASCII: down to the character grid, local contrast, her tones spread, the ramp
  toAscii(grey) {
    const C = this.cols, R = this.rows, sx = AW / C, sy = this.AH / R, cell = new Float32Array(C * R);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {   // average of the source pixels under the cell
      const x0 = Math.floor(c * sx), x1 = Math.max(x0 + 1, Math.floor((c + 1) * sx));
      const y0 = Math.floor(r * sy), y1 = Math.max(y0 + 1, Math.floor((r + 1) * sy));
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += grey[y * AW + x];
      cell[r * C + c] = s / ((x1 - x0) * (y1 - y0));
    }
    const rad = Math.max(1, Math.round(C * 0.04)), blur = boxBlur(cell, C, R, rad);
    for (let i = 0; i < cell.length; i++) cell[i] = Math.max(0, Math.min(255, cell[i] + 1.6 * (cell[i] - blur[i])));
    const hist = new Uint32Array(256); let n = 0;   // spread her tones (not the dark backdrop) over the whole range
    for (const v of cell) if (v > 60) { hist[v | 0]++; n++; }
    const cdf = new Float32Array(256); let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = n ? acc / n : i / 255; }
    for (let i = 0; i < cell.length; i++) if (cell[i] > 60) cell[i] = 60 + cdf[cell[i] | 0] * 195;
    if (!this.lv) {   // one set of levels per size, from this frame: the backdrop goes blank
      const sorted = Float32Array.from(cell).sort();
      this.lv = [sorted[Math.floor(sorted.length * 0.3)], sorted[Math.floor(sorted.length * 0.997)]];
    }
    const [lo, hi] = this.lv, top = RAMP.length - 1, lines = [];
    for (let r = 0; r < R; r++) {
      let line = "";
      for (let c = 0; c < C; c++) line += RAMP[Math.max(0, Math.min(top, Math.round((cell[r * C + c] - lo) / (hi - lo) * top)))];
      lines.push(r === this.glitchRow ? (" ".repeat(2) + line).slice(0, C) : line.replace(/\s+$/, ""));   // the odd glitch line
    }
    return lines.join("\n");
  },

  tick() {
    if (!this.el || this.el.classList.contains("hidden") || document.hidden || !this.cols) return;
    const st = this.state(), now = Date.now();
    let want = this.clipFor(st);
    if (want === "idle" && st === "idle") {
      if (this.idleExtra && this.clip === this.idleExtra) want = this.idleExtra;   // let it finish
      else if (now > this.nextIdleExtra) {
        const pick = ["looking", "hair", "looking", "hair", "laughing"].filter((c) => this.clips[c]);
        this.idleExtra = pick.length ? pick[Math.floor(Math.random() * pick.length)] : null;
        this.nextIdleExtra = now + 15000 + Math.random() * 25000;
        want = this.idleExtra || "idle";
      }
    }
    const frames = this.clips[this.clip];
    if (want !== this.clip && !this.rewinding) this.rewinding = true;   // back to the shared start frame first
    if (this.rewinding) {
      this.frame = Math.max(0, this.frame - 3);
      if (this.frame === 0) { this.rewinding = false; this.clip = want; this.dir = 1; }
    } else {
      this.frame += this.dir;
      if (this.frame >= frames.length - 1) { this.frame = frames.length - 1; this.dir = -1; }
      if (this.frame <= 0) {
        this.frame = 0; this.dir = 1;
        if (this.clip === this.idleExtra) { this.idleExtra = null; this.clip = "idle"; }
      }
    }
    this.glitchRow = Math.random() < 0.03 ? Math.floor(Math.random() * this.rows) : -1;
    this.pre.textContent = this.toAscii(this.clips[this.clip][this.frame]);
    const t = now / 1000;
    const fx = st === "thinking" ? ["", "o", "o O", "o O ( … )"][Math.floor(t * 1.5) % 4] : st === "paused" ? ["z", "z Z", "z Z z"][Math.floor(t) % 3]
      : st === "approval" ? (Math.floor(t * 2) % 2 ? "?" : " ?") : "";
    if (this.fxEl.textContent !== fx) this.fxEl.textContent = fx;
    this.el.classList.toggle("asleep", st === "paused");
  },
};

function boxBlur(a, W, H, r) {   // two passes of a running-sum box blur
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < H; y++) {
    let s = 0, n = 0;
    for (let x = -r; x < W; x++) {
      if (x + r < W) { s += a[y * W + x + r]; n++; }
      if (x - r - 1 >= 0) { s -= a[y * W + x - r - 1]; n--; }
      if (x >= 0) tmp[y * W + x] = s / n;
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let y = -r; y < H; y++) {
      if (y + r < H) { s += tmp[(y + r) * W + x]; n++; }
      if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * W + x]; n--; }
      if (y >= 0) out[y * W + x] = s / n;
    }
  }
  return out;
}
