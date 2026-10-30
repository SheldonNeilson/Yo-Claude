// Yo Claude's face: short clips of a real person (ui/avatar/*.mp4, made by scripts/make_avatar_clips.py), turned into
// ASCII live, frame by frame. The characters stay a fixed small size, so a wider panel gets more of them (more
// detail); the height follows, within part of the panel. Every clip starts from the same frame, so she switches
// clips seamlessly: a clip plays forward and back, and to change clips she rewinds quickly to that shared frame.
// She follows the voice (talking, listening, thinking). When idle, her expression shifts every couple of seconds (the
// start of another clip, played part way and back), and 7 to 16 s after one mannerism ends she does another.
"use strict";
const RAMP = " .:-=+o/*#0@";   // sparse to dense: white on the dark window, so bright = dense
const AW = 200;                // the analysis grid frames are decoded to (columns); more than any panel needs

const avatar = {
  el: null, pre: null, fxEl: null, fps: 12, clips: {}, ready: false,
  clip: "idle", frame: 0, dir: 1, turnAt: 20, rewinding: false, idleExtra: null, nextIdleExtra: 0,
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
      if (name === "talking" && this.clips.talking) this.mouth = mouthOpenness(this.clips.talking, this.AH);
      if (name === "idle" && this.clips.idle) { this.ready = true; this.fit(); }   // start as soon as idle is in
    }
    if (!this.ready) return;
    new ResizeObserver(() => this.fit()).observe(side);
    this.nextIdleExtra = Date.now() + 8000;
    setInterval(() => this.tick(), 1000 / this.fps);
  },
  apply() { this.el?.classList.toggle("hidden", S.settings?.avatar === false); },
  levels(list) {   // the voice's loudness, as it plays: drives her mouth while she talks
    if (list?.length) { this.level = Math.min(1, (list.at(-1) || 0) / 3000); this.levelAt = Date.now(); }
  },
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
  // the clips that suit a state; she picks among them at random, a new one each time one ends
  group(st) {
    const have = (names) => names.filter((n) => this.clips[n]), all = Object.keys(this.clips);
    const g = st === "speaking" ? have(["talking"]) : st === "listening" || st === "approval" ? have(["listening"])
      : st === "thinking" ? have(["thinking", ...all.filter((n) => n.startsWith("think_"))])
      : st === "using_pc" ? have(["think_read", "looking"]) : [];
    return g.length ? g : ["idle"];
  },
  // a mood from her reaction to a reply (sessions.py MOODS): that clip plays next, once, if she has it
  react(clip) { if (this.clips[clip]) { this.moodClip = clip; this.moodUntil = Date.now() + 20000; } },
  idleExtras() { return Object.keys(this.clips).filter((n) => n.startsWith("idle_") || ["looking", "hair", "laughing"].includes(n)); },
  // the start of an expression, played only part way and back: a glance, a hint of a smile, a moment's thought
  microClips() {
    return Object.keys(this.clips).filter((n) => n !== "idle" && n !== "talking" && n !== "hair" && n !== "idle_tuck");
  },
  // idle, back at the start frame: a mannerism if one's due (or a mood to show), else a small change of expression
  // (most of the time) or a short stretch of her idle sway. Something changes every couple of seconds.
  nextIdle(now) {
    this.microClip = null;
    if (this.idleExtra && this.clip === this.idleExtra && !this.extraPending) {   // just played: the next in a while
      this.idleExtra = null; this.nextIdleExtra = now + 7000 + Math.random() * 9000;
    }
    this.extraPending = false;
    const extras = this.idleExtras();
    if (!this.idleExtra && extras.length && now > this.nextIdleExtra) {
      this.idleExtra = this.any(extras, this.lastExtra); this.lastExtra = this.idleExtra;
    }
    if (this.idleExtra) { this.clip = this.idleExtra; this.turnAt = 0; return; }   // the whole thing
    const micro = this.microClips();
    if (micro.length && Math.random() < 0.6) {
      this.clip = this.microClip = this.any(micro, this.lastMicro); this.lastMicro = this.clip;
      this.turnAt = 5 + Math.floor(Math.random() * 12);   // 0.4 to 1.4 s out, the same back
    } else { this.clip = "idle"; this.turnAt = 10 + Math.floor(Math.random() * 26); }
  },
  any(list, not) { const l = list.length > 1 ? list.filter((n) => n !== not) : list; return l[Math.floor(Math.random() * l.length)]; },

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
    const st = this.state(), now = Date.now(), group = this.group(st);
    let want = group.includes(this.clip) ? this.clip : this.any(group);   // stay on a suitable clip until it ends
    if (this.moodClip && now > this.moodUntil) this.moodClip = null;   // too late to react to that now
    if (st === "idle" && this.moodClip) {   // reacting to what just happened (after she's done speaking)
      this.idleExtra = this.moodClip; this.extraPending = true; this.moodClip = null;
    }
    if (st === "idle")   // idle picks its next move each time she's back at the start frame (nextIdle)
      want = this.idleExtra || (this.clip === "idle" || this.clip === this.microClip ? this.clip : "idle");
    else this.turnAt = 0;   // the other states play their clips all the way
    const frames = this.clips[this.clip];
    const lipSync = st === "speaking" && this.clip === "talking" && this.mouth && !this.rewinding;
    if (want !== this.clip && !this.rewinding) this.rewinding = true;   // back to the shared start frame first
    if (this.rewinding) {
      this.frame = Math.max(0, this.frame - 3);
      if (this.frame === 0) {
        this.rewinding = false; this.dir = 1;
        if (st === "idle") this.nextIdle(now); else { this.clip = want; this.turnAt = 0; }
      }
    } else if (lipSync) {
      this.frame = this.lipFrame(now);
    } else {
      const end = Math.min(frames.length - 1, this.turnAt || Infinity);   // a short play turns back early
      this.frame += this.dir;
      if (this.frame >= end) { this.frame = end; this.dir = -1; }
      if (this.frame <= 0) {   // forward and back: what next?
        this.frame = 0; this.dir = 1;
        if (st === "idle") this.nextIdle(now);
        else if (group.length > 1) this.clip = this.any(group, this.clip);   // another of the kind
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

// Lip sync: on each beat, the talking frame whose mouth is as open as the voice is loud right now, preferring frames
// near the current one so her face doesn't jump about.
avatar.lipFrame = function (now) {
  const loud = now - (this.levelAt || 0) < 300 ? this.level : 0;
  this.mouthGoal = (this.mouthGoal || 0) * 0.35 + Math.min(1, loud * 1.7) * 0.65;
  const m = this.mouth, target = this.mouthGoal;
  if (target < 0.08) {   // a pause between words: never frozen, drift slowly among the closed-mouth frames
    const closed = this.closedFrames || (this.closedFrames = [...m.keys()].sort((a, b) => m[a] - m[b]).slice(0, 8).sort((a, b) => a - b));
    return closed[Math.floor(now / 650) % closed.length];
  }
  let best = this.frame, bestScore = Infinity;
  for (let i = 0; i < m.length; i++) {
    const score = Math.abs(m[i] - target) * 4 + Math.abs(i - this.frame) / m.length;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
};

// How open her mouth is in each talking frame (0 closed to 1 widest), ranked. The mouth is found as the part of the
// lower face that changes most across the clip; open = darker there (the inside of the mouth).
function mouthOpenness(frames, AH) {
  const n = frames.length, x0 = Math.floor(AW * 0.3), x1 = Math.floor(AW * 0.7), y0 = Math.floor(AH * 0.47), y1 = Math.floor(AH * 0.78);   // below the eyes (blinks change a lot too)
  const W = x1 - x0, H = y1 - y0, sd = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, s2 = 0;
    for (const f of frames) { const v = f[(y0 + y) * AW + x0 + x]; s += v; s2 += v * v; }
    sd[y * W + x] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  const cut = Float32Array.from(sd).sort()[Math.floor(sd.length * 0.95)];   // the most-changing 5%
  const box = [];
  for (let i = 0; i < sd.length; i++) if (sd[i] >= cut) box.push((y0 + Math.floor(i / W)) * AW + x0 + (i % W));
  const dark = frames.map((f) => -box.reduce((a, j) => a + f[j], 0) / box.length);
  const order = dark.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), rank = new Float32Array(n);
  order.forEach(([, i], k) => { rank[i] = k / Math.max(1, n - 1); });
  return rank;
}

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
