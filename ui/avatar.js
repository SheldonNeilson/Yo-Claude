// Yo Claude's face: short clips of a real person (ui/avatar/*.mp4, made by scripts/make_avatar_clips.py), turned into
// ASCII live, frame by frame. Always COLS characters across, sized to fill the panel: chunky enough to read as ASCII,
// enough of them to still look like her. Every clip starts from the same frame, so she switches
// clips seamlessly: a clip plays forward and back, and to change clips she rewinds quickly to that shared frame.
// She follows the voice (talking, listening, thinking). Idle, she mostly rests in the calm end of her idle clip (the
// shared start frame is a big smile), now and then shows the start of another expression, and 7 to 16 s after one
// mannerism ends she does another.
"use strict";
const RAMP = " .:-=+o/*#0@";   // sparse to dense: white on the dark window, so bright = dense
const AW = 128;                // the analysis grid frames are decoded to (columns): 2 per character across
const COLS = 64;               // characters across, whatever the panel's width
const VIEW = [0, 0, 1, 1];     // the part of the clip shown: left, top, right, bottom (fractions; see frameView)
const REST = [44, 60];         // idle frames with a soft, closed-mouth smile: where she rests
const GENTLE = /look|gaze|glance|brow|tilt|turn|drift|eyes|head|attentive|chin|lean|thought|soften|nod/;   // the calm moves
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
    this.stamps = {};
    this.loadedBase = this.base();
    const manifest = await this.manifest();
    this.noClips = !manifest;
    if (!manifest) { this.apply(); return; }   // (that character has no clips yet: no face)
    this.fps = manifest.fps || 12;
    // idle first, and she starts as soon as it's in; talking next; the rest join her pool as they're decoded
    const order = Object.entries(manifest.clips).sort(([a], [b]) => (b === "idle") - (a === "idle") || (b === "talking") - (a === "talking"));
    for (const [name, v] of order) {
      await this.load(name, v);
      if (name === "idle" && this.clips.idle && !this.ready) this.start();
    }
    this.loaded = true;   // (only now: before this, refresh would decode the ones still to come a second time)
    setInterval(() => this.refresh(), 60000);
  },
  start() {
    this.baseView = frameView(this.clips.idle[0], this.AH);
    this.ready = true;
    this.fit();
    new ResizeObserver(() => this.fit()).observe(this.host);
    this.nextIdleExtra = Date.now() + 8000;
    setInterval(() => this.tick(), 500 / this.fps);   // twice the clips' rate: lip sync uses every beat, the rest every other
  },
  // What to keep out of the calm moments, per clip, from its measured blinks (clips.json, made by
  // scripts/make_avatar_clips.py with a face landmarker; the generated clips blink far more than people do):
  // skips: the short blinks, padded a frame each side, which she steps over; shutAt: where a long eyes-shut stretch
  // starts (looking down, a squinting smile), which she turns back before.
  analyse() {
    this.skips = {}; this.shutAt = {}; this.closedFrames = null;   // (lip sync's resting frames: grins may have changed)
    for (const [name, frames] of Object.entries(this.clips)) {
      const runs = this.meta?.[name]?.blinks || [];
      this.skips[name] = runs.filter(([a, z]) => z - a < 8).map(([a, z]) => [Math.max(1, a - 1), Math.min(frames.length - 1, z + 1)]);
      this.shutAt[name] = runs.find(([a, z]) => z - a >= 8)?.[0] ?? frames.length;
    }
    const rest = this.skips.idle?.filter(([, z]) => z >= REST[0] && z < REST[1] - 6).map(([, z]) => z + 1) || [];
    this.restFrom = Math.max(REST[0], ...rest);   // (her resting sway starts after any blink there)
  },
  // frame `f`, or if that's in a blink, the first frame past it going `dir` (past back-to-back blinks too)
  stepPast(f, dir, frames) {
    for (let moved = true; moved;) {
      moved = false;
      for (const [a, z] of this.skips?.[this.clip] || [])
        if (f >= a && f <= z) { f = Math.max(0, Math.min(frames.length - 1, dir > 0 ? z + 1 : a - 1)); moved = f !== 0 && f !== frames.length - 1; break; }
    }
    return f;
  },
  // the character's clips: Claudia's (female) in avatar/, Claude's (male, the default) in avatar/male/
  base() { const c = S.settings?.character || "male"; return c === "female" ? "avatar/" : `avatar/${c}/`; },
  async manifest() {   // avatar/clips.json: {fps, clips: {name: {frames, stamp}}} (or just a frame count, as it was)
    try { const m = await (await fetch(this.base() + "clips.json", { cache: "no-store" })).json(); return m?.clips ? m : null; } catch (_) { return null; }
  },
  async load(name, v, into = this.clips) {
    const count = typeof v === "number" ? v : v.frames;
    try { into[name] = await this.decode(`${this.base()}${name}.mp4?${v.stamp || ""}`, count); } catch (e) { console.warn("avatar clip", name, e); return; }
    this.stamps[name] = v.stamp || "";
    (this.meta ||= {})[name] = v;
    if (name === "talking" && into === this.clips) { this.mouth = mouthOpenness(into.talking, this.AH); this.closedFrames = null; }
    if (into === this.clips) this.analyse();
  },
  // New clips are recorded while she runs (scripts/make_avatar_clips.py adds each to clips.json as it's made): every
  // minute, any new or re-made one is decoded and joins her pool. A new idle clip means a new set (another start
  // frame): then all of it is decoded first and swapped in at once, so she never mixes two sets.
  async refresh() {
    if (this.refreshing || !this.loaded || document.hidden) return;
    this.refreshing = true;
    try {
      const m = await this.manifest();
      const changed = m ? Object.entries(m.clips).filter(([n, v]) => (typeof v === "number" ? "" : v.stamp || "") !== (this.stamps[n] ?? null)) : [];
      if (changed.some(([n]) => n === "idle")) {
        const fresh = {};
        for (const [n, v] of Object.entries(m.clips)) await this.load(n, v, fresh);
        if (fresh.idle) {
          this.clips = fresh; this.clip = "idle"; this.frame = 0; this.rewinding = false; this.idleExtra = this.moodClip = null;
          if (fresh.talking) { this.mouth = mouthOpenness(fresh.talking, this.AH); this.closedFrames = null; }
          this.analyse();
          this.lv = null;
        }
      } else for (const [n, v] of changed) await this.load(n, v);
      if (m && JSON.stringify(Object.keys(m.clips).map((n) => m.clips[n].blinks)) !== JSON.stringify(Object.keys(m.clips).map((n) => this.meta?.[n]?.blinks))) {
        for (const [n, v] of Object.entries(m.clips)) if (this.clips[n]) this.meta[n] = v;   // blinks measured since
        this.analyse();
      }
    } finally { this.refreshing = false; }
  },
  apply() {   // (off unless turned on; in the window, nothing's loaded until it is)
    const on = S.settings?.[this.mount ? "bar_avatar" : "avatar"] === true;
    if (on && this.wanted && !this.el) this.init();
    if (this.el && this.loadedBase && this.loadedBase !== this.base()) this.switchCharacter();
    this.el?.classList.toggle("hidden", !on || this.noClips);
  },
  // another character picked (Options): all of theirs decoded, then swapped in at once
  async switchCharacter() {
    if (this.switching) return;
    this.switching = true; this.loadedBase = this.base();
    try {
      const m = await this.manifest();
      this.noClips = !m;
      if (m) {
        const fresh = {};
        this.stamps = {};
        for (const [n, v] of Object.entries(m.clips)) await this.load(n, v, fresh);
        if (fresh.idle) {
          this.clips = fresh; this.clip = "idle"; this.frame = 0; this.rewinding = false; this.idleExtra = this.moodClip = null;
          if (fresh.talking) { this.mouth = mouthOpenness(fresh.talking, this.AH); this.closedFrames = null; }
          this.lv = null; this.analyse();
          this.baseView = frameView(fresh.idle[0], this.AH); this.cols = 0; this.fit();
          if (!this.ready) this.start();
        }
      }
    } finally { this.switching = false; this.apply(); }
  },
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
    const maxH = this.mount ? this.host.clientHeight : this.host.clientHeight * 0.62;   // (the sessions list keeps the rest)
    const probe = this.fit.probe || (this.fit.probe = Object.assign(document.createElement("span"), { textContent: "@".repeat(50) }));
    probe.style.fontSize = "100px";
    if (!probe.isConnected) this.pre.appendChild(probe);
    const em = probe.getBoundingClientRect().width / 5000 || 0.6;   // a character's width, per px of font size
    probe.remove();
    // the person's part of the frame (frameView); with height to spare at this width, zoom in to fill it: narrow the
    // view around the middle (to 60% of the width at most, so the shoulders stay)
    const base = this.baseView || VIEW, vh = (base[3] - base[1]) * this.AH, cwW = width / cols;
    const fullRows = cols * vh / AW / 2, fillRows = maxH / (2 * cwW);
    const share = Math.max(0.6, Math.min(1, fullRows / fillRows));
    const V = this.view = [0.5 - share / 2, base[1], 0.5 + share / 2, base[3]];
    const rows = Math.round(cols * ((V[3] - V[1]) * this.AH) / ((V[2] - V[0]) * AW) / 2);
    const cw = Math.min(cwW, maxH / (rows * 2));
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
    const g = st === "speaking" ? have(["talking"])
      : st === "listening" || st === "approval" ? have(["listening", ...all.filter((n) => n.startsWith("listen_"))])
      : st === "thinking" ? have(["thinking", ...all.filter((n) => n.startsWith("think_"))])
      : st === "using_pc" ? have(["think_read", "looking"]) : [];
    return g.length ? g : ["idle"];
  },
  // a mood from her reaction to a reply (sessions.py MOODS): that clip plays next, once, if she has it
  react(clip) { if (this.clips[clip]) { this.moodClip = clip; this.moodUntil = Date.now() + 20000; } },
  // laughing is kept for when something's funny (a mood), not for idling
  // (the blink ones only now and then: she blinks in plenty of the others already)
  idleExtras() {
    const all = Object.keys(this.clips).filter((n) => (n.startsWith("idle_") || ["looking", "hair"].includes(n)) && (this.shutAt?.[n] ?? 99) >= 12);
    return Math.random() < 0.05 ? all : all.filter((n) => !n.includes("blink"));
  },
  // the start of an expression, played only part way and back: a glance, a moment's thought. Not the big-smile ones.
  microClips() {
    return Object.keys(this.clips).filter((n) => !["idle", "hair", "idle_tuck", "laughing", "looking"].includes(n) && !n.startsWith("talk")
      && !n.includes("blink") && (this.shutAt?.[n] ?? 99) >= 6);   // (not if her eyes shut for long straight away)
  },
  // idle, back at the start frame: a mannerism if one's due (or a mood to show), else now and then a small change of
  // expression, but mostly out to the calm end of her idle clip to rest there a few seconds (swaying among REST).
  nextIdle(now) {
    this.microClip = null; this.restUntil = 0;
    // each play of a clip a little different: its own speed, and a pause at the turn now and then (an expression held)
    this.speed = 0.6 + Math.random() * 0.55; this.holdFor = Math.random() < 0.45 ? 300 + Math.random() * 1400 : 0;
    if (this.idleExtra && this.clip === this.idleExtra && !this.extraPending) {   // just played: the next in a while
      this.idleExtra = null; this.nextIdleExtra = now + 14000 + Math.random() * 14000;   // (a whole one now and then)
    }
    this.extraPending = false;
    const extras = this.idleExtras();
    if (!this.idleExtra && extras.length && this.bigNext) {   // (only just after a change of state)
      this.bigNext = false;
      this.idleExtra = this.any(extras, this.lastExtra); this.lastExtra = this.idleExtra;
    }
    if (this.idleExtra) {   // the whole thing (up to any long eyes-shut stretch in it)
      const shut = this.shutAt?.[this.idleExtra] ?? 99, n = this.clips[this.idleExtra]?.length || 61;
      this.clip = this.idleExtra; this.turnAt = shut < n ? shut - 1 : 0; this.blinkOk = false; return;
    }
    const micro = this.microClips();
    if (micro.length && Math.random() < 0.65) {   // mostly small, subtle changes of expression
      const gentle = micro.filter((n) => GENTLE.test(n) || /_[sv]_/.test(n));   // looking about, brows, the subtle set
      this.clip = this.microClip = this.any(gentle.length && Math.random() < 0.9 ? gentle : micro, this.lastMicro); this.lastMicro = this.clip;
      this.turnAt = 3 + Math.floor(Math.random() * 7);   // a hint of it: 0.25 to 0.75 s out, the same back
      this.turnAt = Math.min(this.turnAt, (this.shutAt?.[this.clip] ?? 99) - 1);   // (before any long eyes-shut stretch)
    } else {
      this.clip = "idle"; this.turnAt = Math.min(this.clips.idle.length - 1, REST[1]);
      this.blinkOk = Math.random() < 0.05;   // her idle clip's own blink: on the odd pass, else skipped over
      this.restUntil = now + 1500 + Math.random() * 3500;
    }
  },
  // how far into a clip she goes in a busy state: all the way just after the state changed, else only a hint of it
  pickTurn(st) {
    this.speed = 0.6 + Math.random() * 0.5;
    const shut = this.shutAt?.[this.clip] ?? 99, n = this.clips[this.clip]?.length || 61;
    if (st === "speaking") { this.turnAt = 0; return; }
    if (this.bigNext) { this.bigNext = false; this.turnAt = shut < n ? shut - 1 : 0; return; }   // (up to any eyes-shut stretch)
    this.turnAt = Math.min(4 + Math.floor(Math.random() * 8), (this.shutAt?.[this.clip] ?? 99) - 1);
    this.holdFor = Math.random() < 0.4 ? 300 + Math.random() * 1200 : 0;
  },
  any(list, not) { const l = list.length > 1 ? list.filter((n) => n !== not) : list; return l[Math.floor(Math.random() * l.length)]; },

  // one frame of greyscale -> ASCII: down to the character grid, local contrast, her tones spread, the ramp
  toAscii(grey) {
    const C = this.cols, R = this.rows, cell = new Float32Array(C * R);
    const V = this.view || VIEW;
    const ox = V[0] * AW, oy = V[1] * this.AH, sx = (V[2] - V[0]) * AW / C, sy = (V[3] - V[1]) * this.AH / R;
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
    if (!this.el || this.el.offsetParent === null || document.hidden || !this.cols) return;   // (not shown: no work)
    const st = this.state(), now = Date.now(), group = this.group(st);
    if (st !== this.lastSt) { this.lastSt = st; this.bigNext = true; }   // a change of state: one bigger move allowed
    this.beat = (this.beat || 0) + 1;
    if (this.beat % 2 && !(st === "speaking" && this.clip === "talking" && this.mouth && !this.rewinding)) return;
    let want = group.includes(this.clip) ? this.clip : this.any(group);   // stay on a suitable clip until it ends
    if (this.moodClip && now > this.moodUntil) this.moodClip = null;   // too late to react to that now
    if (st === "idle" && this.moodClip) {   // reacting to what just happened (after she's done speaking)
      this.idleExtra = this.moodClip; this.extraPending = true; this.moodClip = null;
    }
    if (st === "idle")   // idle picks its next move each time she's back at the start frame (nextIdle)
      want = this.idleExtra || (this.clip === "idle" || this.clip === this.microClip ? this.clip : "idle");
    else if (st === "speaking") this.turnAt = 0;   // talking plays all the way (lip sync)
    const frames = this.clips[this.clip];
    const lipSync = st === "speaking" && this.clip === "talking" && this.mouth && !this.rewinding;
    if (want !== this.clip && this.clip === "talking") {   // her voice stopped: her mouth stops at once (no rewinding
      this.frame = 0; this.rewinding = false; this.dir = 1;     // through the talking frames: that looked like more talk)
      if (st === "idle") this.nextIdle(now); else { this.clip = want; this.pickTurn(st); }
    }
    if (want !== this.clip && !this.rewinding) this.rewinding = true;   // back to the shared start frame first
    if (this.rewinding) {
      this.frame = this.stepPast(Math.max(0, this.frame - 3), -1, frames);   // (no blink on the way back either)
      if (this.frame === 0) {
        this.rewinding = false; this.dir = 1;
        if (st === "idle") this.nextIdle(now); else { this.clip = want; this.pickTurn(st); }
      }
    } else if (lipSync) {
      this.frame = this.lipFrame(now);
    } else {
      const end = Math.min(frames.length - 1, this.turnAt || Infinity);   // a short play turns back early
      const resting = st === "idle" && this.clip === "idle" && now < this.restUntil;
      const idleish = st !== "speaking" && this.clip !== "talking";   // (every calm state: own speed, holds)
      this.acc = (this.acc || 0) + (idleish ? this.speed || 1 : 1);   // (idle plays at this play's own speed)
      const step = this.acc >= 1 && !(idleish && now < (this.heldUntil || 0));
      if (step) this.acc -= 1;
      if (step && (!resting || this.frame < (this.restFrom || REST[0]) || Math.random() < 0.5)) this.frame += this.dir;   // resting: slower sways
      // blinks are stepped over (but in the blink mannerisms, and talking's lip sync), bar the odd one in her idle clip:
      // she blinks now and then, not constantly
      if (!this.clip.includes("blink") && !(this.blinkOk && this.clip === "idle")) this.frame = this.stepPast(this.frame, this.dir, frames);
      if (this.frame >= end && this.dir > 0) {   // the turn: back again, maybe after holding the expression a moment
        this.frame = end; this.dir = -1;
        if (idleish && this.holdFor && this.clip !== "idle") { this.heldUntil = now + this.holdFor; this.holdFor = 0; }
      }
      if (resting && this.dir < 0 && this.frame <= (this.restFrom || REST[0])) { this.frame = this.restFrom || REST[0]; this.dir = 1; }
      if (this.frame <= 0 && this.dir < 0) {   // forward and back (not just waiting there): what next?
        this.frame = 0; this.dir = 1;
        if (st === "idle") this.nextIdle(now);
        else {   // another of the kind, after a calm moment
          const roomy = group.filter((n) => (this.shutAt?.[n] ?? 99) >= 7);   // (not ones that shut her eyes at once)
          if (group.length > 1) this.clip = this.any(roomy.length ? roomy : group, this.clip);
          this.pickTurn(st);
          if (st !== "speaking") this.heldUntil = now + 300 + Math.random() * 1400;
        }
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
  if (this.env?.length && i >= -10) loud = i < this.env.length ? Math.min(1, (this.env[i] || 0) / 3000) : 0;   // (past its end: silent)
  const goal = Math.min(1, loud * 1.7), was = this.mouthGoal || 0;
  this.mouthGoal = Math.min(0.78, goal > was ? goal : was * 0.4 + goal * 0.6);   // opens at once, closes slower; never her widest
  const m = this.mouth, target = this.mouthGoal;
  // not her big toothy grins (measured, clips.json "grin"): in ASCII a row of teeth reads like a shark's
  const grin = new Set(this.meta?.talking?.grin || []), ok = (i) => !grin.has(i) || grin.size > m.length - 6;
  if (target < 0.08) {   // a pause between words: never frozen, drift slowly among the closed-mouth frames
    const closed = this.closedFrames || (this.closedFrames = [...m.keys()].filter(ok).sort((a, b) => m[a] - m[b]).slice(0, 8).sort((a, b) => a - b));
    return closed[Math.floor(now / 650) % closed.length];
  }
  let best = this.frame, bestScore = Infinity;
  for (let i = 0; i < m.length; i++) {
    if (!ok(i)) continue;
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

// The part of the clip worth showing: from a little above the person's head down (the dark backdrop above them would
// only be blank rows), the full width. Found in her (or his) first idle frame: the first rows with enough light in them.
function frameView(grey, AH) {
  let top = 0;
  for (let y = 0; y < AH; y++) {
    let n = 0;
    for (let x = 0; x < AW; x++) if (grey[y * AW + x] > 70) n++;
    if (n > AW * 0.04) { top = y; break; }
  }
  return [0, Math.max(0, top - AH * 0.03) / AH, 1, 1];
}
