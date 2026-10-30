// Bug Invaders: Space Invaders over the chat transcript, to play while Claude works on a reply.
// It comes up by itself once Claude has been busy on the open session for a few seconds (unless its "auto-pop" box is
// unticked: settings.invaders = false), steps aside whenever a card needs you (approval, question, checklist), and when
// the reply lands shows "REPLY'S IN" and gets out of the way; the run waits there for the next reply. It never takes the
// keyboard by itself: click it to play (the message box keeps focus until you do). Esc hides it until Claude's next
// reply. window.invaders.show() / .hide() / .toggle() open it on demand (a menu item, say).
// Everything is inside this closure: the window's scripts share one global scope (app.js owns $, el, S, api...).
(() => {
"use strict";
const q = (s) => document.querySelector(s);
const AUTO_DELAY = 4000, POLL_MS = 400, BANNER_MS = 2200, MAX_LIVES = 5, LH = 1.15;
const PENDING_KINDS = new Set(["approval", "question", "checklist"]);
const SPINNER = "·✢✳✶✻✽✻✶✳✢";
const app = () => (typeof S !== "undefined" ? S : null);   // app.js's state (a global const, not on window)
const callApi = (fn, ...a) => {
  try { const r = api()[fn](...a); if (r && r.catch) r.catch(() => {}); } catch (_) { /* no pywebview (tests) */ }
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("yoc.invaders." + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem("yoc.invaders." + k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
};
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const overlap = (ax, ay, aw, ah, bx, by, bw, bh) => ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
const pad = (n, w = 6) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

// ---------- the cast ----------
const TYPES = {
  conflict: { frames: [["<<<<<<", ">>>>>>"], [">>>>>>", "<<<<<<"]], hurt: [["======", "<<>>>>"], ["======", ">><<<<"]],
              color: "orange2", pts: 30, hp: 2, die: "merged", dieColor: "orange2", shot: "%", rank: 0, name: "merge conflict" },
  fail:     { frames: [["{FAIL}", " d  b "], ["{FAIL}", " b  d "]], color: "red", pts: 20, hp: 1, die: "PASS ✓", dieColor: "green",
              shot: "!", rank: 1, name: "failing test" },
  nan:      { frames: [["(NaN)", "/| |\\"], ["(NaN)", "\\| |/"]], color: "blue", pts: 20, hp: 1, die: "= 0", dieColor: "blue",
              shot: "~", rank: 2, wobble: true, name: "NaN" },
  todo:     { frames: [["[TODO]", "/    \\"], ["[TODO]", "\\    /"]], color: "text", pts: 10, hp: 1, die: "DONE ✓", dieColor: "green",
              shot: "?", rank: 3, name: "TODO" },
  bug:      { frames: [["\\(oo)/", " /  \\ "], ["/(oo)\\", " \\  / "]], color: "amber", pts: 10, hp: 1, die: "squashed",
              dieColor: "amber", shot: "*", rank: 4, name: "bug" },
};
const UFO = [["  _.----._  ", "<(while(1))>"], ["  _.----._  ", ">(while(1))<"]];
const CLIPPY = [
  ["   .---.  ", "  / .-. \\ ", "  | | | | ", " (o)| |(o)", "  | | | | ", "  | '-' | ", "  \\_____/ "],
  ["   .---.  ", "  / .-. \\ ", "  | | | | ", " (-)| |(-)", "  | | | | ", "  | '-' | ", "  \\_____/ "],
];
const PLAYER = [" /✻\\ ", "[===]"];
const DUCK = [" __", "<(o)__", " (___/"];
const SHIELD = [" {{{}}} ", "{{{  }}}", "{{    }}"];
const ERODE = { "{": "(", "}": ")", "(": ":", ")": ":", ":": ".", ".": "" };
const POWERS = {
  revert:   { label: "git revert", color: "green" },
  refactor: { label: "refactor", color: "blue" },
  duck:     { label: "rubber duck", color: "amber" },
  coffee:   { label: "coffee", color: "orange2" },
  lgtm:     { label: "LGTM", color: "green" },
};
const COMMITS = ["feat: initial commit", "fix: off-by-one in the formation", "test: add failing tests (on purpose)",
  "chore: bump all the dependencies", "refactor: everything, again", "fix: fix the fix", "hotfix: friday 16:59 deploy",
  'revert "revert \\"fix tests\\""', "wip", "perf: they move faster now", "docs: nobody reads these",
  "style: tabs vs spaces, final battle", "fix: works on my machine", "chore: rm -rf node_modules", "feat: more bugs (by accident)",
  "fix: typo"];
const BOSS_COMMITS = ["boss: it looks like you're writing code", "boss: clippy.exe restarted", "boss: merge branch 'main' into main",
  "boss: while (true) { help(); }"];
const SAYS = ["It looks like you're writing a bug. Need help?", "Would you like me to add more TODOs?",
  "Have you tried turning it off and on again?", "I see you're winning. Let me fix that.", "Tip: tests pass if you delete them!",
  "Did you mean: rm -rf node_modules?", "It looks like you're debugging. Want a printf?"];
const OUCH = ["segfault", "stack overflow", "undefined is not a function", "NullReferenceException", "off by one", "race condition"];

// ---------- palette, from the app's own CSS ----------
const C = {};
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, f) => cs.getPropertyValue(n).trim() || f;
  Object.assign(C, { bg: v("--bg", "#111110"), line: v("--line2", "#4a3e36"), text: v("--text", "#e8e4da"), dim: v("--dim", "#8f8a80"),
    faint: v("--faint", "#5c5a56"), orange: v("--orange", "#d97757"), orange2: v("--orange2", "#ff8c60"), amber: v("--amber", "#e8b04b"),
    green: v("--green", "#9fd17f"), blue: v("--blue", "#5ab0ff"), red: v("--red", "#ff6b6b"), mono: v("--mono", "Consolas, monospace") });
  sprites.clear(); pixCache.clear(); cwCache.clear();
}

// ---------- the cabinet ----------
const root = document.createElement("div");
root.id = "invaders"; root.tabIndex = 0;
root.setAttribute("aria-label", "Bug Invaders: a game to play while Claude works. Click to play, Esc hides it.");
root.innerHTML = '<span class="inv-tag inv-title">[ bug invaders<span class="inv-wait"> · while you wait...</span> ]</span>' +
  '<span class="inv-tag inv-ctl"><button data-act="peek"></button><button data-act="sound"></button><button data-act="auto"></button>' +
  '<button data-act="close" title="Hide until Claude\'s next reply (Esc)">[✕]</button></span>' +
  '<span class="inv-tag inv-status"></span>' +
  '<span class="inv-tag inv-keys">[ ←→ move · space fire · P pause · M sound · Esc hide ]</span><canvas></canvas>';
const cv = root.querySelector("canvas"), ctx = cv.getContext("2d");
const mctx = document.createElement("canvas").getContext("2d");
const btn = (a) => root.querySelector(`[data-act="${a}"]`), statusEl = root.querySelector(".inv-status");
(q("#chat") || document.body).appendChild(root);

const view = { cssW: 0, cssH: 0, z: 1, dpr: 1, s: 1, k: 1, W: 560, H: 400 };
function layout() {
  const t = q("#transcript");
  if (!t || !t.offsetWidth || !t.offsetHeight) return false;
  // with the chat sliver on, the bottom of the chat (Claude's latest) stays in view under the game
  const peek = peekOn() ? Math.min(150, Math.round(t.offsetHeight * 0.28)) : 0;
  Object.assign(root.style, { left: t.offsetLeft + "px", top: t.offsetTop + "px", width: t.offsetWidth + "px", height: t.offsetHeight - peek + "px" });
  root.classList.toggle("narrow", t.offsetWidth < 640);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (w < 60 || h < 60) return false;
  const z = parseFloat(document.body.style.zoom) || 1, dpr = window.devicePixelRatio || 1;
  if (w === view.cssW && h === view.cssH && z === view.z && dpr === view.dpr) return true;
  Object.assign(view, { cssW: w, cssH: h, z, dpr });
  view.s = clamp(Math.min(w / 560, h / 400), 0.7, 2.2);
  view.W = w / view.s; view.H = h / view.s; view.k = view.s * z * dpr;
  cv.width = Math.round(w * z * dpr); cv.height = Math.round(h * z * dpr);
  sprites.clear(); pixCache.clear();
  placePlayer(); fitFormation();
  if (!raf) render();
  return true;
}

// ---------- drawing helpers: glowing text sprites, cached per size and colour ----------
const sprites = new Map(), pixCache = new Map(), cwCache = new Map();
function charW(size) {
  if (!cwCache.has(size)) { mctx.font = `${size}px ${C.mono}`; cwCache.set(size, mctx.measureText("M").width); }
  return cwCache.get(size);
}
function measure(lines, size) {
  mctx.font = `${size}px ${C.mono}`;
  return { w: Math.max(...lines.map((l) => mctx.measureText(l).width)), h: lines.length * size * LH };
}
function sprite(lines, size, color, glow = 5) {
  const key = lines.join("\n") + "|" + size + "|" + color + "|" + glow;
  let sp = sprites.get(key);
  if (sp) return sp;
  const k = view.k, padPx = glow + 2, m = measure(lines, size);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil((m.w + padPx * 2) * k)); c.height = Math.max(1, Math.ceil((m.h + padPx * 2) * k));
  const x = c.getContext("2d");
  x.scale(k, k); x.font = `${size}px ${C.mono}`; x.textBaseline = "top"; x.fillStyle = color;
  const draw = () => lines.forEach((l, i) => x.fillText(l, padPx, padPx + i * size * LH + size * 0.06));
  if (glow) { x.shadowColor = color; x.shadowBlur = glow * k; draw(); x.shadowBlur = 0; }
  draw();
  sp = { img: c, w: m.w, h: m.h, pad: padPx };
  sprites.set(key, sp);
  return sp;
}
function drawSprite(sp, x, y, alpha = 1) {
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sp.img, x - sp.pad, y - sp.pad, sp.w + sp.pad * 2, sp.h + sp.pad * 2);
  ctx.globalAlpha = 1;
}
function txt(s, x, y, color, size = 11, align = "left", glow = 0, alpha = 1) {
  ctx.font = `${size}px ${C.mono}`; ctx.textAlign = align; ctx.textBaseline = "top"; ctx.fillStyle = color; ctx.globalAlpha = alpha;
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow * view.k; }
  ctx.fillText(s, x, y);
  ctx.shadowBlur = 0; ctx.globalAlpha = 1;
}
// Big arcade lettering: text drawn tiny, hard-thresholded and blown up without smoothing, in two-tone stripes.
function pixelText(str, c1, c2) {
  const key = str + "|" + c1 + "|" + c2;
  let p = pixCache.get(key);
  if (p) return p;
  const f = 15; mctx.font = `bold ${f}px ${C.mono}`;
  const w = Math.ceil(mctx.measureText(str).width) + 2, h = f + 3;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.font = mctx.font; x.textBaseline = "top"; x.fillStyle = "#fff"; x.fillText(str, 1, 1);
  const d = x.getImageData(0, 0, w, h);
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] > 120 ? 255 : 0;
  x.putImageData(d, 0, 0);
  x.globalCompositeOperation = "source-in";
  const g = x.createLinearGradient(0, 0, 0, h);   // one fill: with source-in, each separate fill would wipe the rest
  g.addColorStop(0, c1); g.addColorStop(0.5, c1); g.addColorStop(0.5, c2); g.addColorStop(1, c2);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  p = { img: c, w, h };
  pixCache.set(key, p);
  return p;
}
function drawPixelText(str, cx, y, maxW, maxPx, c1, c2 = c1, glitch = 0) {
  const p = pixelText(str, c1, c2), px = clamp(Math.floor(maxW / p.w), 2, maxPx), w = p.w * px, h = p.h * px;
  ctx.imageSmoothingEnabled = false;
  ctx.shadowColor = c2; ctx.shadowBlur = 14 * view.k;
  if (glitch > 0) {   // slices knocked sideways, like a bad VHS frame
    for (let s = 0; s < p.h; s++) {
      const off = Math.random() < glitch ? rnd(-12, 12) : 0;
      ctx.drawImage(p.img, 0, s, p.w, 1, cx - w / 2 + off, y + s * px, w, px);
    }
  } else ctx.drawImage(p.img, cx - w / 2, y, w, h);
  ctx.shadowBlur = 0; ctx.imageSmoothingEnabled = true;
  return h;
}
// An ASCII-framed panel, like the chat's bubbles: lines are {t, c}.
function box(lines, cx, cy, o = {}) {
  const size = o.size || 12, cw = charW(size), lh = Math.round(size * 1.35);
  const n = Math.max(...lines.map((l) => [...l.t].length));
  const w = (n + 4) * cw, h = (lines.length + 2) * lh;
  const x = o.left != null ? o.left : cx - w / 2, y = o.top != null ? o.top : cy - h / 2, fc = o.frame || C.orange;
  ctx.fillStyle = "rgba(11,11,10,.93)"; ctx.fillRect(x, y + lh * 0.3, w, h - lh * 0.5);
  txt("." + "-".repeat(n + 2) + ".", x, y, fc, size);
  lines.forEach((l, i) => {
    const ly = y + (i + 1) * lh;
    txt("|", x, ly, fc, size); txt("|", x + (n + 3) * cw, ly, fc, size);
    const off = o.center ? ((n - [...l.t].length) * cw) / 2 : 0;
    txt(l.t, x + cw * 2 + off, ly, l.c || C.text, size, "left", l.g || 0);
  });
  txt("'" + "-".repeat(n + 2) + "'", x, y + (lines.length + 1) * lh, fc, size);
  return { x, y, w, h };
}
function wrap(s, n) {
  const out = []; let line = "";
  for (const w of s.split(" ")) { if ((line + " " + w).trim().length > n && line) { out.push(line); line = w; } else line = (line + " " + w).trim(); }
  if (line) out.push(line);
  return out;
}

// ---------- sound: quiet square-wave beeps, off until you turn them on ----------
let audio = null, soundOn = store.get("sound", false);
function beep(f, dur = 0.08, type = "square", vol = 0.03, slide = 0) {
  if (!soundOn) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch (_) { /* no audio */ }
}
const later = (ms, fn) => setTimeout(fn, ms);
const SFX = {
  shoot: () => beep(880, 0.06, "square", 0.015, -420), hit: () => beep(240, 0.09, "square", 0.025, -140),
  boom: () => beep(110, 0.3, "sawtooth", 0.03, -70), hurt: () => beep(180, 0.45, "sawtooth", 0.035, -140),
  step: (i) => beep([98, 92, 87, 82][i % 4], 0.05, "triangle", 0.02),
  power: () => { beep(523, 0.07, "square", 0.025); later(70, () => beep(784, 0.1, "square", 0.025)); },
  combo: () => { beep(660, 0.05); later(50, () => beep(990, 0.07)); },
  reply: () => [523, 659, 784, 1047].forEach((f, i) => later(i * 90, () => beep(f, 0.11, "square", 0.025))),
  ufo: () => beep(300, 0.12, "triangle", 0.015, 200),
};
function toggleSound() {
  soundOn = !soundOn; store.set("sound", soundOn); paintCtl();
  if (soundOn) SFX.power();
}

// ---------- game state ----------
const G = {
  state: "title", paused: false, time: 0, rt: 0, score: 0, hi: store.get("hi", 0), lives: 3, hits: 0, wave: 0,
  player: { x: 0, y: 0, w: 30, h: 26, inv: 0, cool: 0 },
  shots: [], ebul: [], enemies: [], drones: [], powerups: [], particles: [], floaters: [], shields: [],
  form: { x: 0, y: 0, dir: 1, stepT: 0, frame: 0, n: 0 }, ufo: null, boss: null, duck: null,
  fx: { refactor: 0, coffee: 0 }, combo: { n: 0, last: -9, best: 0 }, shake: 0, intro: 0, clearT: 0, commit: "",
  stars: Array.from({ length: 48 }, () => ({ x: Math.random(), y: Math.random(), s: rnd(3, 16), b: Math.random() < 0.25 })),
};
function placePlayer() {
  const m = measure(PLAYER, 12), P = G.player;
  P.w = m.w; P.h = m.h; P.y = view.H - m.h - 6;
  P.x = P.x ? clamp(P.x, 4, view.W - P.w - 4) : view.W / 2 - P.w / 2;
}
function fitFormation() {   // the field got narrower (a pane opened): pull the formation back inside it
  const alive = G.enemies.filter((e) => e.alive);
  if (!alive.length) return;
  const F = G.form, lo = Math.min(...alive.map((e) => e.ox)), hi = Math.max(...alive.map((e) => e.ox + e.w));
  F.x = Math.max(8 - lo, Math.min(F.x, view.W - 8 - hi));   // keeps the left edge in view if it can't all fit
}
function newGame() {
  Object.assign(G, { state: "play", paused: false, score: 0, lives: 3, hits: 0, wave: 0, fx: { refactor: 0, coffee: 0 }, duck: null,
    combo: { n: 0, last: -9, best: 0 }, particles: [], floaters: [], powerups: [], shields: [] });
  placePlayer(); G.player.x = view.W / 2 - G.player.w / 2; G.player.inv = 0;
  startWave(1);
}
const hash = (n) => ((n * 2654435761) >>> 0).toString(16).padStart(8, "0").slice(0, 7);
function waveTitle(n) {
  if (n % 4 === 0) return BOSS_COMMITS[(n / 4 - 1) % BOSS_COMMITS.length];
  return COMMITS[(n - Math.floor(n / 4) - 1) % COMMITS.length];
}
function startWave(n) {
  Object.assign(G, { wave: n, shots: [], ebul: [], drones: [], ufo: null, boss: null, enemies: [], clearT: 0, intro: 2.6,
    ufoT: rnd(10, 18), efireT: 1, commit: waveTitle(n) });
  if (n === 1 || n % 4 === 1 || !G.shields.length) buildShields();
  if (n % 4 === 0) spawnBoss(n / 4); else buildFormation(n);
}
function buildFormation(n) {
  let rows = ["conflict", "fail", "todo", "bug", "bug"];
  if (n > 1) {
    const pool = ["bug", "bug", "todo", "todo", "fail", "fail", "nan", "conflict"];
    if (n > 4) pool.push("conflict", "nan");
    rows = Array.from({ length: n >= 6 ? 6 : 5 }, () => pick(pool)).sort((a, b) => TYPES[a].rank - TYPES[b].rank);
  }
  const gapX = 50, gapY = 30, base = measure(TYPES.bug.frames[0], 12);
  const cols = clamp(Math.min(9 + Math.floor((n - 1) / 3), Math.floor((view.W - 40 - base.w) / gapX)), 4, 11);
  const fw = (cols - 1) * gapX + base.w;
  G.form = { x: (view.W - fw) / 2, y: 66 + Math.min(n - 1, 5) * 8, dir: 1, stepT: 0.4, frame: 0, n: 0 };
  rows.forEach((t, r) => {
    const m = measure(TYPES[t].frames[0], 12);
    for (let c = 0; c < cols; c++) {
      G.enemies.push({ type: t, col: c, ox: c * gapX + (base.w - m.w) / 2, oy: r * gapY, w: m.w, h: m.h, hp: TYPES[t].hp, alive: true, flash: 0 });
    }
  });
}
function buildShields() {
  const n = view.W > 720 ? 4 : 3;
  G.shields = Array.from({ length: n }, (_, i) => ({ fx: (i + 1) / (n + 1), rows: SHIELD.map((r) => [...r].map((c) => (c === " " ? "" : c))) }));
}
function shieldGeom(sh) {
  const cw = charW(12), lh = 13, w = SHIELD[0].length * cw;
  return { x: sh.fx * view.W - w / 2, y: G.player.y - 70, cw, lh, w, h: SHIELD.length * lh };
}
function shieldHit(x, y) {
  for (const sh of G.shields) {
    const g = shieldGeom(sh);
    if (x < g.x || x >= g.x + g.w || y < g.y || y >= g.y + g.h) continue;
    const c = Math.floor((x - g.x) / g.cw), r = Math.floor((y - g.y) / g.lh), ch = sh.rows[r] && sh.rows[r][c];
    if (ch) {
      sh.rows[r][c] = ERODE[ch] ?? "";
      burst(x, y, C.orange, 3, ".:'");
      return true;
    }
  }
  return false;
}
function eraseShields(x, y, w, h) {
  for (const sh of G.shields) {
    const g = shieldGeom(sh);
    if (!overlap(x, y, w, h, g.x, g.y, g.w, g.h)) continue;
    sh.rows.forEach((row, r) => row.forEach((ch, c) => {
      if (ch && overlap(x, y, w, h, g.x + c * g.cw, g.y + r * g.lh, g.cw, g.lh)) row[c] = "";
    }));
  }
}
function spawnBoss(level) {
  const hp = 36 + 18 * (level - 1);
  G.boss = { level, hp, max: hp, x: view.W / 2, y: 50, w: 0, h: 0, t: 0, fireT: 2, spawnT: 5, sayT: 0, say: SAYS[0], flash: 0 };
}

// ---------- effects ----------
function burst(x, y, color, n = 10, chars = "01*+.") {
  for (let i = 0; i < n; i++) {
    G.particles.push({ x, y, vx: rnd(-100, 100), vy: rnd(-130, 30), life: rnd(0.45, 1), t: 0, ch: chars[Math.floor(Math.random() * chars.length)], color });
  }
  if (G.particles.length > 280) G.particles.splice(0, G.particles.length - 280);
}
function float(text, x, y, color, size = 11, life = 1.1) { G.floaters.push({ text, x, y, color, size, t: 0, life }); }
function addScore(n) { G.score += n; if (G.score > G.hi) G.hi = G.score; }
const comboLive = () => G.time - G.combo.last < 1.6;
const mult = () => (comboLive() ? 1 + Math.min(4, Math.floor(G.combo.n / 5)) : 1);
function comboHit() {
  const before = mult(), cb = G.combo;
  cb.n = comboLive() ? cb.n + 1 : 1; cb.last = G.time; cb.best = Math.max(cb.best, cb.n);
  const m = mult();
  if (m > before) { float(`COMBO ×${m}!`, view.W / 2, view.H * 0.48, C.amber, 16, 1.2); G.shake = Math.max(G.shake, 3); SFX.combo(); }
  return m;
}

// ---------- update ----------
function fire() {
  const P = G.player, spread = G.fx.refactor > 0, max = (G.fx.coffee > 0 ? 4 : 2) * (spread ? 3 : 1);
  if (G.shots.length >= max) return;
  P.cool = G.fx.coffee > 0 ? 0.16 : 0.32;
  const cx = P.x + P.w / 2, y = P.y - 8;
  G.shots.push({ x: cx, y, vx: 0, vy: -440 });
  if (spread) G.shots.push({ x: cx, y, vx: -140, vy: -420 }, { x: cx, y, vx: 140, vy: -420 });
  SFX.shoot();
}
function stepFormation(dt) {
  const F = G.form, alive = G.enemies.filter((e) => e.alive);
  if (!alive.length || (F.stepT -= dt) > 0) return;
  F.stepT = (0.04 + (0.34 * alive.length) / G.enemies.length) / (1 + 0.1 * (G.wave - 1));
  let minX = Infinity, maxX = -Infinity;
  for (const e of alive) { minX = Math.min(minX, F.x + e.ox); maxX = Math.max(maxX, F.x + e.ox + e.w); }
  const dx = 9 * F.dir;
  if (maxX + dx > view.W - 8 || minX + dx < 8) { F.dir = -F.dir; F.y += 14; } else F.x += dx;
  F.frame ^= 1; SFX.step(F.n++);
  for (const e of alive) {
    const ex = F.x + e.ox, ey = F.y + e.oy;
    if (ey + e.h > G.player.y - 70) eraseShields(ex, ey, e.w, e.h);
    if (ey + e.h >= G.player.y) return gameOver("the bugs shipped to production");
  }
}
function enemyFire(dt) {
  if ((G.efireT -= dt) > 0) return;
  G.efireT = rnd(0.4, 1.25) / (1 + 0.12 * (G.wave - 1));
  if (G.ebul.length >= 2 + Math.floor(G.wave / 2)) return;
  const bottoms = new Map();
  for (const e of G.enemies) if (e.alive && (!bottoms.has(e.col) || bottoms.get(e.col).oy < e.oy)) bottoms.set(e.col, e);
  const list = [...bottoms.values()];
  if (!list.length) return;
  const px = G.player.x + G.player.w / 2;
  const e = Math.random() < 0.5 ? list.reduce((a, b) => (Math.abs(G.form.x + a.ox - px) < Math.abs(G.form.x + b.ox - px) ? a : b)) : pick(list);
  const T = TYPES[e.type];
  G.ebul.push({ x: G.form.x + e.ox + e.w / 2, y: G.form.y + e.oy + e.h, vx: 0, vy: Math.min(270, 135 + 12 * G.wave), ch: T.shot,
    color: C[T.color], wob: !!T.wobble, seed: Math.random() * 6 });
}
function updateUfo(dt) {
  if (G.boss) return;
  if (!G.ufo) {
    if ((G.ufoT -= dt) <= 0) {
      const m = measure(UFO[0], 12), dir = Math.random() < 0.5 ? 1 : -1;
      G.ufo = { x: dir > 0 ? -m.w : view.W, y: 30, dir, w: m.w, h: m.h };
      SFX.ufo();
    }
    return;
  }
  G.ufo.x += G.ufo.dir * 85 * dt;
  if (G.ufo.x > view.W + 10 || G.ufo.x < -G.ufo.w - 10) { G.ufo = null; G.ufoT = rnd(14, 24); }
}
function updateBoss(dt) {
  const B = G.boss, m = measure(CLIPPY[0], 15);
  B.t += dt; B.w = m.w; B.h = m.h; B.flash = Math.max(0, B.flash - dt);
  B.x = view.W / 2 - B.w / 2 + Math.sin(B.t * 0.6) * Math.max(0, view.W / 2 - B.w / 2 - 30);
  B.y = 50 + Math.sin(B.t * 1.6) * 6;
  if ((B.sayT -= dt) <= 0) { B.say = pick(SAYS); B.sayT = 4; }
  if (G.intro > 0) return;
  if ((B.fireT -= dt) <= 0) {
    B.fireT = Math.max(0.75, 1.6 - 0.15 * B.level);
    const n = Math.min(7, 3 + 2 * (B.level - 1)), cx = B.x + B.w / 2, cy = B.y + B.h;
    for (let i = 0; i < n; i++) {
      const a = n > 1 ? -0.55 + (1.1 * i) / (n - 1) : 0;
      G.ebul.push({ x: cx, y: cy, vx: Math.sin(a) * 160, vy: Math.cos(a) * 160, ch: i % 2 ? "?" : "@", color: C.amber, seed: 0 });
    }
    SFX.ufo();
  }
  if ((B.spawnT -= dt) <= 0) {
    B.spawnT = Math.max(3, 6 - B.level);
    for (let i = 0; i < 2; i++) {
      const m2 = measure(["[TODO]"], 11);
      G.drones.push({ x: B.x + B.w / 2 - m2.w / 2 + (i ? 30 : -30), y: B.y + B.h, w: m2.w, h: m2.h, seed: Math.random() * 6 });
    }
  }
}
function updateDrones(dt) {
  for (const d of G.drones) {
    d.y += 38 * dt; d.x += Math.sin(G.time * 2 + d.seed) * 40 * dt;
    eraseShields(d.x, d.y, d.w, d.h);
    const P = G.player;
    if (overlap(d.x, d.y, d.w, d.h, P.x, P.y, P.w, P.h)) { d.dead = true; playerHit(); }
    if (d.y > view.H) d.dead = true;
  }
  G.drones = G.drones.filter((d) => !d.dead);
}
function kill(e, noDrop) {
  e.alive = false;
  const T = TYPES[e.type], cx = G.form.x + e.ox + e.w / 2, cy = G.form.y + e.oy + e.h / 2, m = comboHit(), pts = T.pts * m;
  addScore(pts);
  burst(cx, cy, C[T.color], 12);
  float(T.die, cx, cy - 6, C[T.dieColor]);
  if (m > 1) float(`+${pts}`, cx, cy + 8, C.dim, 10);
  G.shake = Math.max(G.shake, 1.2);
  SFX.hit();
  if (!noDrop) dropPower(cx, cy, false);
}
function dropPower(x, y, force) {
  if (!force && (Math.random() > 0.08 || G.powerups.length >= 2)) return;
  const pool = ["refactor", "refactor", "coffee", "coffee", "duck", "lgtm", "revert"];
  if (G.lives < 3) pool.push("revert", "revert");
  const type = pick(pool), m = measure(["[" + POWERS[type].label + "]"], 11);
  G.powerups.push({ type, x: clamp(x - m.w / 2, 4, view.W - m.w - 4), y, w: m.w, h: m.h });
}
function applyPower(type) {
  const P = G.player, cx = P.x + P.w / 2, y = P.y - 20;
  SFX.power();
  if (type === "revert") {
    if (G.hits > 0 && G.lives < MAX_LIVES) { G.lives++; G.hits--; float("git revert HEAD: hit undone", cx, y, C.green); }
    else { addScore(250); float("nothing to revert: +250", cx, y, C.green); }
  } else if (type === "refactor") { G.fx.refactor = 10; float("refactor: spread shot", cx, y, C.blue); }
  else if (type === "coffee") { G.fx.coffee = 10; float("coffee: faster everything", cx, y, C.orange2); }
  else if (type === "duck") { G.duck = { hp: 5, x: P.x, y: P.y - 34, t: 0 }; float("rubber duck: explain it to me", cx, y, C.amber); }
  else if (type === "lgtm") {
    for (const b of G.ebul) burst(b.x, b.y, C.green, 2, "✓.");
    G.ebul = []; G.drones = [];
    const alive = G.enemies.filter((e) => e.alive);
    if (alive.length) { const low = Math.max(...alive.map((e) => e.oy)); for (const e of alive) if (e.oy === low) kill(e, true); }
    G.shake = Math.max(G.shake, 5);
    float("LGTM ✓ ship it", view.W / 2, view.H * 0.55, C.green, 16, 1.3);
  }
}
function playerHit() {
  const P = G.player;
  if (P.inv > 0 || G.state !== "play") return;
  G.lives--; G.hits++; P.inv = 2; G.shake = 9; G.combo.n = 0;
  burst(P.x + P.w / 2, P.y + 8, C.orange, 26);
  float(pick(OUCH), P.x + P.w / 2, P.y - 22, C.red, 12, 1.4);
  G.ebul = [];
  SFX.hurt();
  if (G.lives <= 0) gameOver("FATAL: unhandled exception in production");
}
function gameOver(reason) {
  G.state = "over"; G.overReason = reason; G.overAt = G.rt; G.shake = 10;
  store.set("hi", G.hi); SFX.boom();
}
function bossHit() {
  const B = G.boss;
  B.hp--; B.flash = 0.08; addScore(5); G.shake = Math.max(G.shake, 1);
  if (B.hp > 0) return SFX.hit();
  const cx = B.x + B.w / 2, cy = B.y + B.h / 2, bonus = 1000 * B.level * mult();
  addScore(bonus);
  for (let i = 0; i < 4; i++) burst(cx + rnd(-30, 30), cy + rnd(-30, 30), pick([C.amber, C.orange, C.text]), 20);
  float("CLIPPY.EXE has stopped responding", view.W / 2, cy, C.amber, 14, 2.2);
  float(`+${bonus}`, view.W / 2, cy + 20, C.dim, 11, 2);
  if (G.lives < MAX_LIVES) { G.lives++; float("+1 ✻", G.player.x + G.player.w / 2, G.player.y - 20, C.orange, 12, 1.6); }
  G.boss = null; G.drones = []; G.ebul = []; G.clearT = 2.6; G.shake = 12;
  SFX.boom();
}
function updateShots(dt) {
  for (const s of G.shots) {
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.y < 18 || s.x < 0 || s.x > view.W) { s.dead = true; continue; }
    if (shieldHit(s.x, s.y)) { s.dead = true; continue; }
    for (const e of G.enemies) {
      if (!e.alive || !overlap(s.x - 1, s.y, 2, 10, G.form.x + e.ox, G.form.y + e.oy, e.w, e.h)) continue;
      s.dead = true; e.hp--; e.flash = 0.07;
      if (e.hp <= 0) kill(e); else { SFX.hit(); burst(s.x, s.y, C.amber, 4, "=<>"); }
      break;
    }
    if (s.dead) continue;
    const U = G.ufo;
    if (U && overlap(s.x - 1, s.y, 2, 10, U.x, U.y, U.w, U.h)) {
      s.dead = true; G.ufo = null; G.ufoT = rnd(14, 24);
      const pts = pick([50, 100, 150, 300]) * comboHit();
      addScore(pts); burst(U.x + U.w / 2, U.y + U.h / 2, C.orange2, 22);
      float("break;", U.x + U.w / 2, U.y + 4, C.orange2, 13, 1.4); float(`+${pts}`, U.x + U.w / 2, U.y + 20, C.dim, 10, 1.4);
      dropPower(U.x + U.w / 2, U.y + U.h, true); G.shake = Math.max(G.shake, 4); SFX.boom();
      continue;
    }
    const B = G.boss;
    if (B && overlap(s.x - 1, s.y, 2, 10, B.x + 6, B.y, B.w - 12, B.h)) { s.dead = true; burst(s.x, s.y, C.amber, 3); bossHit(); continue; }
    for (const d of G.drones) {
      if (d.dead || !overlap(s.x - 1, s.y, 2, 10, d.x, d.y, d.w, d.h)) continue;
      s.dead = d.dead = true; addScore(15 * comboHit()); burst(d.x + d.w / 2, d.y, C.text, 8); float("DONE ✓", d.x + d.w / 2, d.y, C.green);
      break;
    }
    if (s.dead) continue;
    for (const b of G.ebul) {
      if (!b.dead && Math.abs(b.x - s.x) < 6 && Math.abs(b.y - s.y - 4) < 10) { b.dead = s.dead = true; burst(s.x, s.y, C.amber, 5, "x+."); break; }
    }
  }
  G.shots = G.shots.filter((s) => !s.dead);
  G.drones = G.drones.filter((d) => !d.dead);
}
function updateBullets(dt) {
  const P = G.player, D = G.duck;
  for (const b of G.ebul) {
    if (b.dead) continue;
    b.y += b.vy * dt; b.x += b.vx * dt;
    if (b.wob) b.x += Math.sin((G.time + b.seed) * 9) * 70 * dt;
    if (b.y > view.H || b.x < -10 || b.x > view.W + 10) { b.dead = true; continue; }
    if (shieldHit(b.x, b.y + 8)) { b.dead = true; continue; }
    if (D && overlap(b.x - 3, b.y, 6, 10, D.x, D.y, D.w || 30, D.h || 30)) {
      b.dead = true; D.hp--; burst(b.x, b.y + 6, C.amber, 5, "~'");
      float(D.hp > 0 ? "quack!" : "duck: 'oh, I see the bug now'", D.x + 15, D.y - 4, C.amber, D.hp > 0 ? 10 : 11, 1.3);
      if (D.hp <= 0) G.duck = null;
      continue;
    }
    if (overlap(b.x - 3, b.y, 6, 10, P.x + 3, P.y + 4, P.w - 6, P.h - 4)) { b.dead = true; playerHit(); }
  }
  G.ebul = G.ebul.filter((b) => !b.dead);
}
function updatePowerups(dt) {
  const P = G.player;
  for (const p of G.powerups) {
    p.y += 60 * dt;
    if (overlap(p.x, p.y, p.w, p.h, P.x, P.y, P.w, P.h)) { p.dead = true; applyPower(p.type); }
    else if (p.y > view.H) p.dead = true;
  }
  G.powerups = G.powerups.filter((p) => !p.dead);
}
function updateDuck(dt) {
  const D = G.duck;
  if (!D) return;
  const m = measure(DUCK, 10), P = G.player;
  D.t += dt; D.w = m.w; D.h = m.h;
  const tx = P.x + P.w / 2 - m.w / 2 + Math.cos(D.t * 2.2) * 36, ty = P.y - m.h - 26 + Math.sin(D.t * 2.2) * 8;
  D.x += (tx - D.x) * Math.min(1, dt * 8); D.y += (ty - D.y) * Math.min(1, dt * 8);
}
function updateFx(dt) {
  for (const p of G.particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 230 * dt; }
  G.particles = G.particles.filter((p) => p.t < p.life);
  for (const f of G.floaters) { f.t += dt; f.y -= 22 * dt; }
  G.floaters = G.floaters.filter((f) => f.t < f.life);
  for (const e of G.enemies) if (e.flash > 0) e.flash -= dt;
}
function update(dt) {
  const P = G.player;
  G.time += dt;
  for (const k of Object.keys(G.fx)) G.fx[k] = Math.max(0, G.fx[k] - dt);
  P.inv = Math.max(0, P.inv - dt); P.cool -= dt;
  const dir = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
  P.x = clamp(P.x + dir * (G.fx.coffee > 0 ? 340 : 220) * dt, 4, view.W - P.w - 4);
  if (keys.has("fire") && P.cool <= 0) fire();
  if (G.intro > 0) G.intro -= dt;
  else { stepFormation(dt); enemyFire(dt); updateUfo(dt); }
  if (G.state !== "play") return updateFx(dt);
  if (G.boss) updateBoss(dt);
  updateDrones(dt); updateShots(dt); updateBullets(dt); updatePowerups(dt); updateDuck(dt); updateFx(dt);
  if (G.state !== "play") return;   // a hit can end the run mid-update
  if (!G.boss && !G.clearT && G.enemies.length && !G.enemies.some((e) => e.alive)) {
    G.clearT = 1.8; addScore(100 * G.wave);
    float("✓ all checks passed", view.W / 2, view.H * 0.45, C.green, 15, 1.7);
    float(`+${100 * G.wave}`, view.W / 2, view.H * 0.45 + 20, C.dim, 11, 1.7);
  }
  if (G.clearT > 0 && (G.clearT -= dt) <= 0) { G.clearT = 0; startWave(G.wave + 1); }
}

// ---------- render ----------
function render() {
  if (!cv.width) return;
  const W = view.W, H = view.H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(view.k, 0, 0, view.k, 0, 0);
  if (G.shake > 0.2) ctx.translate(rnd(-1, 1) * G.shake, rnd(-1, 1) * G.shake);
  for (const s of G.stars) {
    ctx.fillStyle = s.b ? C.line : "#2a2724";
    ctx.fillRect(s.x * W, (s.y * H + G.rt * s.s) % H, 1.3, 1.3);
  }
  if (G.state === "title") drawTitle();
  else {
    drawField(); drawHud();
    if (G.state === "over") drawOver();
    else if (G.intro > 0) drawIntro();
  }
  if (G.state !== "over" && !V.bannerUntil) {
    if (G.state === "play" && !isFocused()) {
      box([{ t: "[ paused ]", c: C.amber }, { t: "click here to keep playing", c: C.text },
        { t: "(your typing still goes to the message box)", c: C.dim }], W / 2, H * 0.6, { center: true, frame: C.dim });
    } else if (G.state === "play" && G.paused) {
      drawPixelText("PAUSED", W / 2, H * 0.4, W * 0.4, 6, C.amber, C.orange);
      txt("press P to resume", W / 2, H * 0.4 + 70, C.dim, 12, "center");
    }
  }
  if (V.bannerUntil) drawBanner();
}
function drawField() {
  const W = view.W, P = G.player, frame = G.form.frame;
  ctx.fillStyle = C.line; ctx.fillRect(0, P.y + P.h + 3, W, 1);
  for (const sh of G.shields) {
    const g = shieldGeom(sh);
    sh.rows.forEach((row, r) => row.forEach((ch, c) => {
      if (!ch) return;
      const col = ch === "{" || ch === "}" ? C.orange : ch === "(" || ch === ")" ? C.amber : C.dim;
      drawSprite(sprite([ch], 12, col, 3), g.x + c * g.cw, g.y + r * g.lh);
    }));
  }
  for (const e of G.enemies) {
    if (!e.alive) continue;
    const T = TYPES[e.type], hurt = e.hp < T.hp, lines = hurt ? T.hurt[frame] : T.frames[frame];
    drawSprite(sprite(lines, 12, e.flash > 0 ? "#ffffff" : C[hurt ? "amber" : T.color]), G.form.x + e.ox, G.form.y + e.oy);
  }
  if (G.ufo) drawSprite(sprite(UFO[Math.floor(G.rt * 6) % 2], 12, C.orange2, 7), G.ufo.x, G.ufo.y);
  if (G.boss) drawBoss();
  for (const d of G.drones) drawSprite(sprite(["[TODO]"], 11, C.text), d.x, d.y);
  for (const p of G.powerups) {
    const pw = POWERS[p.type];
    drawSprite(sprite(["[" + pw.label + "]"], 11, C[pw.color], 7), p.x, p.y, 0.65 + 0.35 * Math.sin(G.rt * 10));
  }
  for (const s of G.shots) drawSprite(sprite([s.vx < 0 ? "\\" : s.vx > 0 ? "/" : "|"], 12, C.amber, 6), s.x - 3.5, s.y);
  for (const b of G.ebul) drawSprite(sprite([b.ch], 12, b.color, 5), b.x - 3.5, b.y);
  if (G.state === "play" || Math.floor(G.rt * 4) % 2) {
    if (!(P.inv > 0 && Math.floor(G.rt * 14) % 2)) drawSprite(sprite(PLAYER, 12, G.fx.coffee > 0 ? C.orange2 : C.orange, 7), P.x, P.y);
  }
  if (G.duck) drawSprite(sprite(DUCK, 10, C.amber, 5), G.duck.x, G.duck.y);
  for (const p of G.particles) drawSprite(sprite([p.ch], 10, p.color, 3), p.x, p.y, 1 - p.t / p.life);
  for (const f of G.floaters) txt(f.text, f.x, f.y, f.color, f.size, "center", 5, Math.min(1, 2.2 * (1 - f.t / f.life)));
}
function drawBoss() {
  const B = G.boss, W = view.W;
  const blink = Math.floor(B.t * 1.3) % 5 === 4 ? 1 : 0;
  drawSprite(sprite(CLIPPY[blink], 15, B.flash > 0 ? "#ffffff" : C.amber, 8), B.x, B.y);
  txt("CLIPPY.EXE", B.x + B.w / 2, B.y - 14, C.dim, 10, "center");
  const n = 20, f = Math.ceil((B.hp / B.max) * n);
  txt(`[${"#".repeat(f)}${".".repeat(n - f)}]`, W / 2, 20, C.amber, 10, "center", 4);
  const lines = wrap(B.say, 24).map((t) => ({ t, c: C.text }));
  const right = B.x + B.w / 2 < W / 2, cw = charW(11), bw = (Math.max(...lines.map((l) => l.t.length)) + 4) * cw;
  const left = right ? B.x + B.w + 10 : B.x - bw - 10;
  if (left > 2 && left + bw < W - 2) {
    box(lines, 0, 0, { left, top: B.y + 2, size: 11, frame: C.dim });
    txt(right ? "<" : ">", right ? left - 8 : left + bw + 1, B.y + 28, C.dim, 11);
  }
}
function drawHud() {
  const W = view.W;
  txt(`SCORE ${pad(G.score)}`, 8, 4, C.orange, 11, "left", 4);
  txt(`HI ${pad(G.hi)}`, 118, 4, C.dim, 11);
  txt(`WAVE ${G.wave}`, W / 2, 4, C.amber, 11, "center", 4);
  txt("✻".repeat(Math.max(0, G.lives)), W - 8, 4, C.orange, 12, "right", 5);
  if (comboLive() && G.combo.n > 1) {
    const left = 1 - (G.time - G.combo.last) / 1.6, n = 10, f = Math.ceil(left * n);
    txt(`COMBO ${G.combo.n} ×${mult()} [${"=".repeat(f)}${" ".repeat(n - f)}]`, 8, 18, C.amber, 10, "left", 3);
  }
  const fx = [];
  if (G.fx.refactor > 0) fx.push([`refactor ${Math.ceil(G.fx.refactor)}s`, C.blue]);
  if (G.fx.coffee > 0) fx.push([`coffee ${Math.ceil(G.fx.coffee)}s`, C.orange2]);
  if (G.duck) fx.push([`duck ${"♥".repeat(G.duck.hp)}`, C.amber]);
  let x = W - 8;
  for (const [t, c] of fx.reverse()) { txt(t, x, 18, c, 10, "right", 3); x -= (t.length + 2) * charW(10); }
}
function drawIntro() {
  const W = view.W, H = view.H, a = Math.min(1, G.intro / 0.4), y = H * 0.5;
  ctx.fillStyle = `rgba(11,11,10,${0.82 * a})`; ctx.fillRect(0, y - 12, W, 112);   // a band, so it reads over the formation
  ctx.globalAlpha = a;
  drawPixelText(G.wave % 4 === 0 ? "BOSS WAVE" : `WAVE ${G.wave}`, W / 2, y, W * 0.45, 5, C.amber, C.orange);
  ctx.globalAlpha = 1;
  const line = `${hash(G.wave)} ${G.commit}`, shown = Math.floor((2.6 - G.intro) * 40);
  txt("$ git log -1 --oneline", W / 2, y + 62, C.dim, 11, "center", 0, a);
  txt(line.slice(0, shown) + (shown < line.length || Math.floor(G.rt * 3) % 2 ? "▍" : " "), W / 2, y + 78, C.text, 12, "center", 3, a);
}
function drawTitle() {
  const W = view.W, H = view.H, cx = W / 2;
  const wait = !V.manual;   // it popped up by itself while Claude works (not opened with the button or the menu)
  let y = Math.max(10, H * 0.5 - 196 - (wait ? 11 : 0));
  if (wait) {   // typed out like a prompt, then a blinking cursor
    const s = "While you wait...", n = Math.min(s.length, Math.floor((G.rt - V.shownAt) * 16)), cw = charW(12);
    const x0 = cx - ((s.length + 3) * cw) / 2;
    txt(">", x0, y, C.orange, 12, "left", 3);
    txt(s.slice(0, n) + (n < s.length || Math.floor(G.rt * 2.5) % 2 ? "▍" : ""), x0 + cw * 2, y, C.dim, 12);
    y += 22;
  }
  y += drawPixelText("BUG INVADERS", cx, y, W * 0.75, 5, C.amber, C.orange) + 8;
  txt("something to shoot at while Claude thinks", cx, y, C.dim, 12, "center"); y += 26;
  const legend = [["conflict", "merge conflict", "30  · takes two hits"], ["fail", "failing test", "20"], ["nan", "NaN", "20  · wobbly shots"],
    ["todo", "TODO", "10"], ["bug", "bug", "10"]];
  const lx = cx - 150;
  for (const [t, name, pts] of legend) {
    drawSprite(sprite(TYPES[t].frames[Math.floor(G.rt * 2) % 2], 12, C[TYPES[t].color]), lx, y);
    txt(name, lx + 70, y + 6, C.text, 12); txt(pts, lx + 200, y + 6, C.dim, 12);
    y += 28;
  }
  drawSprite(sprite(UFO[Math.floor(G.rt * 6) % 2], 12, C.orange2, 6), lx - 20, y);
  txt("infinite loop", lx + 70, y + 6, C.text, 12); txt("???  · break; it", lx + 200, y + 6, C.dim, 12);
  y += 36;
  const pw = Object.values(POWERS), cw = charW(11);
  let total = pw.reduce((n, p) => n + (p.label.length + 3) * cw, 0), px = cx - total / 2;
  for (const p of pw) { txt(`[${p.label}]`, px, y, C[p.color], 11, "left", 4); px += (p.label.length + 3) * cw; }
  y += 28;
  const blink = Math.floor(G.rt * 2.5) % 2 === 0;
  if (isFocused()) txt("press SPACE to start", cx, y, C.amber, 14, "center", 6, blink ? 1 : 0.35);
  else txt("[ click here to play ]", cx, y, C.amber, 14, "center", 6, blink ? 1 : 0.35);
  txt("the message box keeps the keyboard until you click in · Esc hides", cx, y + 22, C.faint, 11, "center");
}
function drawOver() {
  const W = view.W, H = view.H;
  ctx.fillStyle = "rgba(11,11,10,.72)"; ctx.fillRect(0, 0, W, H);
  let y = H * 0.28;
  y += drawPixelText("GAME OVER", W / 2, y, W * 0.6, 7, C.red, C.orange) + 16;
  txt(G.overReason || "", W / 2, y, C.red, 13, "center", 4); y += 26;
  txt(`score ${G.score}   ·   best ${G.hi}`, W / 2, y, C.text, 12, "center"); y += 18;
  txt(`reached wave ${G.wave}   ·   best combo ${G.combo.best}`, W / 2, y, C.dim, 12, "center"); y += 34;
  if (G.rt - G.overAt > 0.8) txt("press SPACE to git reset --hard", W / 2, y, C.amber, 13, "center", 5, Math.floor(G.rt * 2.5) % 2 ? 1 : 0.4);
}
function drawBanner() {
  const W = view.W, H = view.H, p = 1 - (V.bannerUntil - performance.now()) / BANNER_MS;
  ctx.fillStyle = "rgba(11,11,10,.78)"; ctx.fillRect(0, 0, W, H);
  const y = H * 0.32, glitch = p < 0.18 ? 0.5 : Math.random() < 0.04 ? 0.15 : 0;
  const h = drawPixelText("REPLY'S IN", W / 2, y, W * 0.8, 9, C.amber, C.orange, glitch);
  txt("claude has answered", W / 2, y + h + 18, C.text, 14, "center", 5);
  const run = G.state === "play" ? `run saved · wave ${G.wave} · ${G.score} pts · back next time claude thinks` : "back next time claude thinks";
  txt(run, W / 2, y + h + 40, C.dim, 12, "center");
}

// ---------- loop ----------
let raf = 0, last = 0, statusAt = 0;
const isFocused = () => document.activeElement === root || V.forceFocus;
function advance(dt, force) {
  G.rt += dt;
  if (G.state === "play" && !G.paused && !V.bannerUntil && (force || isFocused())) update(dt);
  G.shake = Math.max(0, G.shake - dt * 28);
}
function frame(ts) {
  raf = 0;
  if (!V.visible) return;
  const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
  last = ts;
  advance(dt, false);
  render();
  if (ts - statusAt > 150) { statusAt = ts; paintStatus(); }
  raf = requestAnimationFrame(frame);
}
function startLoop() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
function paintStatus() {
  const a = app()?.active, busy = !!a?.busy;
  const t = V.bannerUntil ? "✓ reply's in"
    : busy ? `${SPINNER[Math.floor(G.rt * 8) % SPINNER.length]} claude is working · ${Math.floor((performance.now() - V.busySince) / 1000)}s`
    : "claude is idle";
  statusEl.textContent = `[ ${t} ]`;
}
const autoOn = () => app()?.settings?.invaders !== false;
const peekOn = () => app()?.settings?.invaders_peek !== false;
function paintCtl() {
  btn("peek").textContent = peekOn() ? "[▤ chat]" : "[  chat]";
  btn("peek").title = peekOn() ? "A strip of the chat shows under the game (Claude's latest). Click to hide it." : "Click to show a strip of the chat under the game.";
  btn("sound").textContent = soundOn ? "[♪ on]" : "[♪ off]";
  btn("sound").title = "Sound (M): quiet beeps";
  btn("auto").textContent = autoOn() ? "[✓ auto-pop]" : "[  auto-pop]";
  btn("auto").title = autoOn() ? "Pops up by itself while Claude works on a reply. Click so it doesn't."
    : "Only opens when you ask for it. Click to let it pop up while Claude works.";
}

// ---------- keys: only while the game has focus; game keys never reach the app (Esc there would stop Claude) ----------
const keys = new Set();
const KEYMAP = { ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right", " ": "fire", ArrowUp: "fire",
  w: "fire", W: "fire", Enter: "start", p: "pause", P: "pause", m: "mute", M: "mute", ArrowDown: "none" };
root.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;   // the app's shortcuts keep working
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideNow(true); return; }
  const k = KEYMAP[e.key];
  if (!k || e.target !== root) return;
  e.preventDefault(); e.stopPropagation();
  keys.add(k);
  if (!e.repeat) press(k);
});
root.addEventListener("keyup", (e) => {
  const k = KEYMAP[e.key];
  if (!k) return;
  keys.delete(k);
  if (e.target === root) { e.preventDefault(); e.stopPropagation(); }
});
root.addEventListener("blur", () => keys.clear());
function press(k) {
  if (V.bannerUntil) return;
  if (k === "mute") return toggleSound();
  if (G.state === "title") { if (k === "fire" || k === "start") newGame(); return; }
  if (G.state === "over") { if ((k === "fire" || k === "start") && G.rt - G.overAt > 0.8) newGame(); return; }
  if (k === "pause") G.paused = !G.paused;
  else if (G.paused && (k === "fire" || k === "start")) G.paused = false;
}
cv.addEventListener("click", () => {   // clicking gives the game the keyboard; on the title screen it also starts
  if (!isFocused() || V.bannerUntil) return;
  if (G.state === "title") newGame();
  else if (G.state === "play" && G.paused) G.paused = false;
});
const ctl = root.querySelector(".inv-ctl");
ctl.addEventListener("mousedown", (e) => e.preventDefault());   // its buttons don't take focus from the message box
ctl.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  e.stopPropagation();
  if (b.dataset.act === "sound") toggleSound();
  else if (b.dataset.act === "peek") {
    const on = !peekOn(), s = app();
    if (s && s.settings) s.settings.invaders_peek = on;
    callApi("set_setting", "invaders_peek", on);
    view.cssW = 0; layout(); paintCtl();
  }
  else if (b.dataset.act === "auto") {
    const on = !autoOn(), s = app();
    if (s && s.settings) s.settings.invaders = on;   // the settings event from Python replaces this shortly
    callApi("set_setting", "invaders", on);
    paintCtl();
  } else if (b.dataset.act === "close") hideNow(true);
});

// ---------- when it shows: Claude busy a few seconds, no card waiting on you ----------
const V = { visible: false, manual: false, dismissed: false, sid: undefined, wasBusy: false, busySince: 0, bannerUntil: 0,
  bannerTimer: 0, resume: false, pendingAt: 0, forceFocus: false, shownAt: 0 };
function pendingCard() {
  const s = app();
  if (!s) return false;
  if (s.active && s.work && s.work[s.active.id] === "awaiting_approval") return true;
  const items = s.items || [];
  for (let i = items.length - 1, seen = 0; i >= 0 && seen < 8; i--) {
    const it = items[i];
    if (!it) continue;
    seen++;
    if (PENDING_KINDS.has(it.kind) && it.status === "pending") return true;
  }
  return false;
}
function poll() {
  const a = app()?.active || null, sid = a ? a.id : null, busy = !!a?.busy, now = performance.now();
  if (sid !== V.sid) {   // another session opened: start fresh, no banner (that reply isn't the one we waited on)
    const first = V.sid === undefined;
    Object.assign(V, { sid, wasBusy: busy, busySince: busy ? now : 0, dismissed: false, resume: false });
    if (!first && V.visible && !V.manual && !V.bannerUntil) hideNow(false);
    return;
  }
  if (busy && !V.wasBusy) { V.busySince = now; V.dismissed = false; }   // a new wait
  if (!busy && V.wasBusy) { V.busySince = 0; V.resume = false; if (V.visible && !pendingCard()) replyIn(); }
  V.wasBusy = busy;
  if (pendingCard()) {   // Claude needs an answer: never cover the card
    V.pendingAt = now;
    if (V.visible) { V.resume = true; hideNow(false); }
    return;
  }
  if (V.visible) { layout(); paintCtl(); return; }
  if (V.bannerUntil || !busy || V.dismissed) return;
  if ((autoOn() || V.resume) && now - V.busySince >= AUTO_DELAY && now - V.pendingAt >= 700) showNow(false, false);
}
function replyIn() {
  clearTimeout(V.bannerTimer);
  V.bannerUntil = performance.now() + BANNER_MS;
  keys.clear();
  SFX.reply();
  V.bannerTimer = setTimeout(() => { V.bannerUntil = 0; if (V.visible) hideNow(false); }, BANNER_MS);
}
function showNow(manual, focus) {
  if (pendingCard()) return false;
  readPalette();
  root.style.display = "block";
  V.visible = true; V.manual = !!manual; V.dismissed = false; V.shownAt = G.rt;
  root.classList.toggle("auto", !V.manual);
  view.cssW = 0;   // measure afresh
  if (!layout()) { root.style.display = "none"; V.visible = false; return false; }
  paintCtl(); paintStatus(); render(); startLoop();
  if (focus) root.focus({ preventScroll: true });
  return true;
}
function hideNow(dismiss) {
  const hadFocus = root.contains(document.activeElement);
  clearTimeout(V.bannerTimer); V.bannerUntil = 0;
  if (dismiss) V.dismissed = true;
  V.visible = false; V.manual = false;
  root.style.display = "none";
  stopLoop(); keys.clear(); store.set("hi", G.hi);
  if (hadFocus) { const inp = q("#input"); if (inp && !inp.disabled) inp.focus({ preventScroll: true }); }   // hand the keyboard back
}
readPalette();
setInterval(poll, POLL_MS);
const tr = q("#transcript");
if (tr && window.ResizeObserver) new ResizeObserver(() => { if (V.visible) layout(); }).observe(tr);
window.addEventListener("resize", () => { if (V.visible) layout(); });

// The [👾] button in the composer's row (index.html) opens and closes it.
const openBtn = q("#invadersBtn");
if (openBtn) {
  openBtn.addEventListener("mousedown", (e) => e.preventDefault());   // so hiding still hands the keyboard back to the message box
  openBtn.addEventListener("click", () => window.invaders.toggle());
}

window.invaders = {
  // A menu item, say: open it now (and take the keyboard, since you asked for it). Not over a card waiting on you.
  show() {
    if (pendingCard()) { if (typeof toast === "function") toast("Claude is waiting on you first."); return false; }
    V.resume = false;
    return V.visible ? (root.focus({ preventScroll: true }), true) : showNow(true, true);
  },
  hide() { if (V.visible) hideNow(true); },
  toggle() { return V.visible ? this.hide() : this.show(); },
  get visible() { return V.visible; },
  // for tests: drive the game without real time or focus
  _debug: {
    G, V, view, keys, poll, render, newGame, startWave, applyPower, dropPower, gameOver,
    step(sec) { for (let t = 0; t < sec; t += 1 / 60) advance(1 / 60, true); render(); paintStatus(); },
  },
};
})();
