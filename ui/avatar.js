// Yo Claude's face: short clips of a real person (ui/avatar/*.mp4, made by scripts/make_avatar_clips.py), turned into
// ASCII live, frame by frame. Always COLS characters across, sized to fill the panel: chunky enough to read as ASCII,
// enough of them to still look like her. Every clip starts from the same frame, so she switches
// clips seamlessly: a clip plays forward and back, and to change clips she rewinds quickly to that shared frame.
// She follows the voice (talking, listening, thinking). Idle, she mostly rests in the calm end of her idle clip (the
// shared start frame is a big smile), now and then shows the start of another expression, and 7 to 16 s after one
// mannerism ends she does another.
"use strict";
const RAMP = " .:-=+o/*#0@";   // sparse to dense: white on the dark window, so bright = dense
const AW = 200;                // the analysis grid frames are decoded to (columns); more than any panel needs
const COLS = 64;               // characters across, whatever the panel's width
const VIEW = [0, 0, 1, 1];     // the part of the clip shown: left, top, right, bottom (fractions)
const REST = [44, 60];         // idle frames with a soft, closed-mouth smile: where she rests
const SPEECH_DELAY = 0.06;     // s from starting the sound to hearing it (Windows' output latency): her mouth waits too

const avatar = {
  el: null, pre: null, fxEl: null, fps: 12, clips: {}, ready: false,
  clip: "idle", frame: 0, dir: 1, turnAt: 20, rewinding: false, idleExtra: null, nextIdleExtra: 0,
  cols: 0, rows: 0, AH: 0, lv: null, glitchRow: -1,

  // `mount`: a box to fill (the floating bar's); without one she goes at the bottom of the window's sidebar
  async init(mount) {
    this.mount = mount || null;
    this.host = mount || $("#side");
    this.el = el("div", "avatar");
    this.el.dataset.tip = "Yo Claude · click to talk";
    this.el.onclick = () => api().talk();
    this.pre = el("pre");
    this.fxEl = el("div", "afx");
    this.el.append(this.pre, this.fxEl);
    if (mount) mount.appendChild(this.el);
    else this.host.querySelector(".sidefoot").after(this.el);   // at the very bottom, under clean up and trash
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
    new ResizeObserver(() => this.fit()).observe(this.host);
    this.nextIdleExtra = Date.now() + 8000;
    setInterval(() => this.tick(), 500 / this.fps);   // twice the clips' rate: lip sync uses every beat, the rest every other
  },
  apply() { this.el?.classList.toggle("hidden", S.settings?.[this.mount ? "bar_avatar" : "avatar"] === false); },
  levels(list) {   // the voice's loudness, as it plays: her mouth's fallback if she has no speech envelope
    if (list?.length) { this.level = Math.min(1, (list.at(-1) || 0) / 3000); this.levelAt = Date.now(); }
  },
  // what's being said, as loudness every `step` s from when it started playing (yo_claude.py Speaker.envelope): her
  // mouth reads it on her own clock, so it's in time with the sound, not behind it like the streamed levels
  speech(e) { this.env = e.env || []; this.envStep = e.step || 0.03; this.envStart = (e.started || 0) * 1000; },
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
  // COLS characters across, the font sized so they fill the panel's width (smaller if she'd be too tall)
  fit() {
    if (!this.ready) return;
    const width = this.el.clientWidth - (this.mount ? 0 : 8), cols = this.colsWanted || COLS;
    const maxH = this.mount ? this.host.clientHeight : this.host.clientHeight * 0.45;
    const probe = this.fit.probe || (this.fit.probe = Object.assign(document.createElement("span"), { textContent: "@".repeat(50) }));
    probe.style.fontSize = "100px";
    if (!probe.isConnected) this.pre.appendChild(probe);
    const em = probe.getBoundingClientRect().width / 5000 || 0.6;   // a character's width, per px of font size
    probe.remove();
    const rows = Math.round(cols * ((VIEW[3] - VIEW[1]) * this.AH) / ((VIEW[2] - VIEW[0]) * AW) / 2);
    const cw = Math.min(width / cols, maxH / (rows * 2));
    this.pre.style.fontSize = (cw / em) + "px";
    this.pre.style.lineHeight = (cw * 2) + "px";   // keep the cells about twice as tall as wide
    if (cols !== this.cols || rows !== this.rows) { this.cols = cols; this.rows = rows; this.lv = null; }
  },
  // app.py display_state already ranks voice and work: Claude thinking beats a paused mic (asleep only when nothing's on)
  state() {
    const d = S.display || {};
    if (["approval", "using_pc", "listening", "speaking", "thinking", "error"].includes(d.state)) return d.state;
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
  // laughing is kept for when something's funny (a mood), not for idling
  idleExtras() { return Object.keys(this.clips).filter((n) => n.startsWith("idle_") || ["looking", "hair"].includes(n)); },
  // the start of an expression, played only part way and back: a glance, a moment's thought. Not the big-smile ones.
  microClips() {
    return Object.keys(this.clips).filter((n) => !["idle", "talking", "hair", "idle_tuck", "laughing", "looking"].includes(n));
  },
  // idle, back at the start frame: a mannerism if one's due (or a mood to show), else now and then a small change of
  // expression, but mostly out to the calm end of her idle clip to rest there a few seconds (swaying among REST).
  nextIdle(now) {
    this.microClip = null; this.restUntil = 0;
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
    if (micro.length && Math.random() < 0.25) {
      this.clip = this.microClip = this.any(micro, this.lastMicro); this.lastMicro = this.clip;
      this.turnAt = 5 + Math.floor(Math.random() * 12);   // 0.4 to 1.4 s out, the same back
    } else {
      this.clip = "idle"; this.turnAt = Math.min(this.clips.idle.length - 1, REST[1]);
      this.restUntil = now + 4000 + Math.random() * 6000;
    }
  },
  any(list, not) { const l = list.length > 1 ? list.filter((n) => n !== not) : list; return l[Math.floor(Math.random() * l.length)]; },

  // one frame of greyscale -> ASCII: down to the character grid, local contrast, her tones spread, the ramp
  toAscii(grey) {
    const C = this.cols, R = this.rows, cell = new Float32Array(C * R);
    const ox = VIEW[0] * AW, oy = VIEW[1] * this.AH, sx = (VIEW[2] - VIEW[0]) * AW / C, sy = (VIEW[3] - VIEW[1]) * this.AH / R;
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {   // average of the source pixels under the cell
      const x0 = Math.floor(ox + c * sx), x1 = Math.max(x0 + 1, Math.floor(ox + (c + 1) * sx));
      const y0 = Math.floor(oy + r * sy), y1 = Math.max(y0 + 1, Math.floor(oy + (r + 1) * sy));
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
    this.beat = (this.beat || 0) + 1;
    if (this.beat % 2 && !(st === "speaking" && this.clip === "talking" && this.mouth && !this.rewinding)) return;
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
      const resting = st === "idle" && this.clip === "idle" && now < this.restUntil;
      if (!resting || this.frame < REST[0] || Math.random() < 0.5) this.frame += this.dir;   // resting: slower sways
      if (this.frame >= end) { this.frame = end; this.dir = -1; }
      if (resting && this.dir < 0 && this.frame <= REST[0]) { this.frame = REST[0]; this.dir = 1; }
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
  let loud = now - (this.levelAt || 0) < 300 ? this.level : 0;
  const i = Math.floor(((now - this.envStart) / 1000 - SPEECH_DELAY) / this.envStep);
  if (this.env?.length && i >= -10 && i < this.env.length + 10) loud = Math.min(1, (this.env[i] || 0) / 3000);
  const goal = Math.min(1, loud * 1.7), was = this.mouthGoal || 0;
  this.mouthGoal = goal > was ? goal : was * 0.4 + goal * 0.6;   // opens at once, closes a touch slower
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
