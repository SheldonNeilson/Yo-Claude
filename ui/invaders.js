// Bug Invaders: Space Invaders over the chat transcript, to play while Claude works on a reply.
// It comes up by itself once Claude has been busy on the open session for a few seconds (unless its "auto-pop" box is
// unticked: settings.invaders = false), steps aside whenever a card needs you (approval, question, checklist), and when
// the reply lands shows "REPLY'S IN" and gets out of the way; the run waits there for the next reply. It never takes the
// keyboard by itself: click it to play (the message box keeps focus until you do). Esc hides it until Claude's next
// reply. window.invaders.show() / .hide() / .toggle() open it on demand (a menu item, say).
// Everything is inside this closure: the window's scripts share one global scope (app.js owns $, el, S, api...).
// The game climbs an "arcade history ladder": every wave is a modernisation (era = min(10, wave - floor(wave/4))). Era modules
// (ui/invaders-eNN-*.js) push { n, year, name, blurb, init(core) -> hooks } onto window.INVADERS_ERAS before this file loads;
// the framework section further down (search "era framework") runs them. Full docs: docs/bug-invaders-eras.md, "Framework API".
(() => {
"use strict";
// window.INVADERS_STANDALONE (set by a page that isn't Yo Claude, like neilson.co.za/bug-invaders/) turns the "while you wait"
// behaviour off: no auto-pop, no hiding, no chat, and it takes touch buttons through window.invaders.input(key, down).
const STANDALONE = !!window.INVADERS_STANDALONE;
const q = (s) => document.querySelector(s);
const AUTO_DELAY = 4000, POLL_MS = 400, BANNER_MS = 2200, MAX_LIVES = 5, LH = 1.15;
const PENDING_KINDS = new Set(["approval", "question", "checklist"]);
const SPINNER = "·✢✳✶✻✽✻✶✳✢";
const Who = () => (typeof globalThis.Who === "function" ? globalThis.Who() : typeof window.yocWho === "function" ? window.yocWho() : "Claude");
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

// ---------- era framework: tables, caps and visual knobs (the hook machinery is further down, by the registry) ----------
const ERA_MAX = 10;
const eraOf = (wave) => Math.min(ERA_MAX, wave - Math.floor(wave / 4));   // boss waves (4k) replay the era of the wave before
const waveOfEra = (n) => { let w = 1; while (eraOf(w) < n) w++; return w; };   // first wave of era n (1, 2, 3, 5, 6, 7, 9, 10, 11, 13)
// built-in banner text per era; a module's own year / name / blurb replace these
const ERA_META = {
  1: { year: 1978, name: "SPACE INVADERS", blurb: "the bugs march, the shields hold. Left and right, one shot at a time." },
  2: { year: 1979, name: "GALAXIAN", blurb: "the bugs peel off in curved dive-bombs. Watch the sky." },
  3: { year: 1982, name: "XEVIOUS", blurb: "now the plane flies up and down, and the ground shoots back. [Z] bombs" },
  4: { year: 1984, name: "1942", blurb: "squadrons fly in on curves. [X] rolls you out of trouble." },
  5: { year: 1985, name: "GRADIUS", blurb: "capsules light the power-up meter, and options trail behind you." },
  6: { year: 1987, name: "R-TYPE", blurb: "hold fire to charge the beam. Worms snake across the screen." },
  7: { year: 1990, name: "RAIDEN", blurb: "armour on the ground, bombs for the whole screen, medals for the chain." },
  8: { year: 1995, name: "BULLET HELL", blurb: "dense patterns. Only the dot in your plane can be hit. Graze for points." },
  9: { year: 2001, name: "IKARUGA", blurb: "two polarities: absorb your own colour, fear the other." },
  10: { year: 2004, name: "NEON", blurb: "twin-stick, combos, a grid and particle storms. Final form, endless." },
};
// What the table itself turns on (cumulative). A module's `caps` / `fx` objects ride on top of these while its era is reached.
// Eras 1-2 keep the plane on the bottom row; from era 3 it flies. Shields retire with it (an era may switch them back on).
const ERA_CAPS = { 3: { move2d: true, bomb: true, shields: false }, 4: { roll: true } };
const CAPS_DEFAULT = { move2d: false, bomb: false, roll: false, shields: true, flightFrac: 0.55, contactKills: false };   // flightFrac: share of the field height the plane may climb; contactKills: ramming kills a bug whatever its hp (off: ramming does 1 damage, era 3+)
const FX_DEFAULT = { glow: 1, starLayers: 1, trail: 0, particleMax: 280, burstMul: 1, shake: 1, grid: 0, scanlines: 1 };
const caps = { ...CAPS_DEFAULT }, VFX = { ...FX_DEFAULT };   // live objects; core.caps and core.fx are these two
const MODS = [];   // registered era modules, sorted by era; ACTIVE = those whose era has been reached (rebuilt by applyEra)
let ACTIVE = [];

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
  heisen:   { frames: [["\\(??)/", " /  \\ "], ["/(??)\\", " \\  / "]], color: "text", pts: 40, hp: 1, die: "can't reproduce", dieColor: "dim",
              shot: "?", rank: 3, flicker: true, name: "heisenbug" },
  leak:     { frames: [["{leak}", " (  ) "], ["{leak}", " )  ( "]], color: "green", pts: 15, hp: 1, die: "free()", dieColor: "green",
              shot: "o", rank: 3, splits: true, name: "memory leak" },
  segv:     { frames: [["<SEGV>", " \\||/ "], ["<SEGV>", " /||\\ "]], color: "red", pts: 50, hp: 1, die: "core dumped", dieColor: "red",
              shot: "#", rank: 2, dives: true, name: "segfault" },
};
for (const T of Object.values(TYPES)) if (!T.hurt) T.hurt = T.frames;   // (every type has a hurt frame set; the draw also guards: T.hurt || T.frames)
const SEASON = (() => { const d = new Date(); return d.getMonth() === 9 && d.getDate() === 31 ? "halloween" : d.getDay() === 5 ? "friday" : ""; })();
const UFO_TEXT = SEASON === "halloween" ? "(BOO! BOO)" : SEASON === "friday" ? "(DEPLOY!!)" : "(while(1))";
const UFO = [["  _.----._  ", "<" + UFO_TEXT + ">"], ["  _.----._  ", ">" + UFO_TEXT + "<"]];
const UFO_NAME = SEASON === "friday" ? "deploy on a friday" : SEASON === "halloween" ? "ghost process" : "infinite loop";
const ALLY = [" /+\\ ", "[---]"];
// weapon levels (npm update): [offset, sideways speed] per shot
const WEAPON = [null, [[0, 0]], [[-5, 0], [5, 0]], [[-5, 0], [5, 0], [0, -110], [0, 110]], [[-7, 0], [0, 0], [7, 0], [0, -150], [0, 150]]];
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
  npm:      { label: "npm update", color: "amber" },
  sudo:     { label: "sudo", color: "red" },
  grep:     { label: "grep", color: "blue" },
  pair:     { label: "pair prog", color: "green" },
  firewall: { label: "firewall", color: "orange" },
  sleep:    { label: "sleep(7)", color: "blue" },
  life:     { label: "+1 ✻", color: "orange2" },
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
// the other bosses (BOSSES, further down, has their code): art, voice lines and wave titles
const MERGE_L = ["<<<<<<< HEAD", "  return true;", "  // works here"];
const MERGE_R = [">>>>>>> main", "  return false;", "  // works here too"];
const MERGE_SAYS = ["CONFLICT (content): merge conflict in everything.js", "Accept current change? Incoming? Your fate?",
  "We're both right. That's the problem.", "Who rebased main? WHO?", "Auto-merging... failed. As usual.", "git push --force fixes this, trust me"];
const MERGE_COMMITS = ["boss: merge branch 'feature' into main (conflicts)", "boss: git rebase -i, what could go wrong", "boss: merge pull request #∞ from you/oops"];
const BSOD_TXT = ["Your PC ran into a problem", "and needs to restart."];
const BSOD_SAYS = ["Collecting some error info for you.", "0% complete. 0% complete. 0% complete.", "Stop code: SKILL_ISSUE",
  "IRQL_NOT_LESS_OR_EQUAL to your aim", "Have you tried turning it off and on again?", "Your shots? Hex dumps now."];
const BSOD_COMMITS = ["boss: update the display drivers", "boss: installing Windows Update 1 of 347", "boss: IRQL_NOT_LESS_OR_EQUAL"];
const HEX = "0123456789ABCDEF";
const NPM_ROOT = ["┌──────────────┐", "│ my-app@1.0.0 │", "└──────┬───────┘"];
const DEPS = ["left-pad", "is-odd", "is-even", "lodash", "moment", "colors", "faker", "is-number", "event-stream", "node-ipc", "is-array", "chalk"];
const NPM_SAYS = ["added 1,337 packages in 0.4s", "found 42 vulnerabilities (41 critical)", "npm WARN deprecated: you",
  "peer dependency? I barely know her", "has anyone seen left-pad?", "run npm audit fix --force to break everything"];
const NPM_COMMITS = ["boss: npm install (one tiny package)", "boss: add left-pad as a dependency", "boss: rm -rf node_modules && npm install"];
const LOOP_RING = "do{continue;}while(true)";
const LOOP_SAYS = ["while (true) { you(); }", "Are we there yet? Are we there yet?", "Still loading... still loading...",
  "for (;;) is a lifestyle", "I'll stop when you stop.", "Halting problem? Not my problem."];
const LOOP_COMMITS = ["boss: while (true) { retry(); }", "boss: fix: the loop exits now (it doesn't)", "boss: for (;;) { one more thing }"];
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
if (STANDALONE) root.dataset.standalone = "1";
root.setAttribute("aria-label", `Bug Invaders: a game to play while ${Who()} works. Click to play, Esc hides it.`);
root.innerHTML = '<span class="inv-tag inv-title">[ bug invaders<span class="inv-wait"> · while you wait...</span> ]</span>' +
  '<span class="inv-tag inv-ctl"><button data-act="peek"></button><button data-act="sound"></button><button data-act="auto"></button>' +
  '<button data-act="close" title="Hide until Claude\'s next reply (Esc)">[✕]</button></span>' +
  '<span class="inv-tag inv-status"></span>' +
  `<span class="inv-tag inv-keys"></span><canvas></canvas>`;   // (the keys line is painted by paintKeys: it follows the era)
const cv = root.querySelector("canvas"), ctx = cv.getContext("2d");
const keysEl = root.querySelector(".inv-keys"), padEl = q("#pad");   // #pad: the standalone page's touch buttons
const mctx = document.createElement("canvas").getContext("2d");
const btn = (a) => root.querySelector(`[data-act="${a}"]`), statusEl = root.querySelector(".inv-status");
(q("#chat") || document.body).appendChild(root);

let keysW = 0;   // the cabinet's width the key hint line was last fitted to
const view = { cssW: 0, cssH: 0, z: 1, dpr: 1, s: 1, k: 1, W: 560, H: 400 };
function layout() {
  const t = q("#transcript");
  if (!t || !t.offsetWidth || !t.offsetHeight) return false;
  // with the chat sliver on, the bottom of the chat (Claude's latest) stays in view under the game
  const peek = peekOn() ? Math.min(150, Math.round(t.offsetHeight * 0.28)) : 0;
  Object.assign(root.style, { left: t.offsetLeft + "px", top: t.offsetTop + "px", width: t.offsetWidth + "px", height: t.offsetHeight - peek + "px" });
  root.classList.toggle("narrow", t.offsetWidth < 640);
  if (root.clientWidth !== keysW) { keysW = root.clientWidth; paintKeys(); }   // (the key line shortens to what fits)
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
  glow *= VFX.glow;   // eras raise the glow; 1 (era 1) leaves every sprite as it was
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
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow * VFX.glow * view.k; }
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
  era: () => [392, 523, 659, 784, 1047].forEach((f, i) => later(i * 70, () => beep(f, 0.1, "square", 0.025))),   // a new era: a rising arpeggio
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
  fx: { refactor: 0, coffee: 0, pierce: 0, homing: 0, ally: 0, slow: 0 }, weapon: 1, bubble: false, ally: null, diveT: 6,
  entry: null, scored: false, rank: -1, cheat: false, konami: false, sudoWave: 0,
  combo: { n: 0, last: -9, best: 0 }, shake: 0, intro: 0, clearT: 0, commit: "",
  stars: Array.from({ length: 48 }, () => ({ x: Math.random(), y: Math.random(), s: rnd(3, 16), b: Math.random() < 0.25, l: 0 })),
  // era framework state: era (0 until the first wave starts), the era you pick on the title, lift (0..1: how far the plane has
  // unlocked vertical flight), trail (plane exhaust), hold (a module sets it to keep the wave open), custom (a module owns this wave's
  // formation), speedMul (reset to 1 each frame, before the modules' update hooks), glitch (CRT tear, seconds left)
  era: 1, eraNew: false, startEra: 1, eraIntro: 0, introMax: 2.6, lift: 0, trail: [], trailT: 0, hold: false, custom: false, speedMul: 1, glitch: 0, debugEra: false,
};
// A bug's top-left corner: its own spot (free: module-owned or flying a path), a diver's, or its place in the formation.
const epos = (e) => (e.free ? { x: e.x, y: e.y } : e.dive ? { x: e.dive.x, y: e.dive.y } : { x: G.form.x + e.ox, y: G.form.y + e.oy });
const hidden = (e) => e.wait || (TYPES[e.type].flicker && Math.sin(G.rt * 2.4 + e.col * 0.9 + e.oy * 0.05) < -0.35);   // not out yet / a heisenbug between blinks
// The two lines, kept apart on purpose: the DRAWN ground line sits under the bottom row; the DEADLINE (bugs "shipped to production",
// where the shields stand) is the top of the plane's bottom row, which is where the plane itself used to be fixed.
const groundY = () => view.H - 3;
const bottomY = () => groundY() - 3 - G.player.h - (caps.bottomPad || 0);   // (caps.bottomPad: room an era keeps at the bottom for its own strip, era 5's meter)
const flightTop = () => { const b = bottomY(); return Math.min(b, clamp(b - caps.flightFrac * view.H, 36, b - 60)); };
// what hurts the plane: bullets use the smaller box (or the era-8 dot, P.hb = {w, h}); contact uses the whole plane
function bulletBox() {
  const P = G.player;
  return P.hb ? { x: P.x + P.w / 2 - P.hb.w / 2, y: P.y + P.h / 2 - P.hb.h / 2, w: P.hb.w, h: P.hb.h } : { x: P.x + 3, y: P.y + 4, w: P.w - 6, h: P.h - 4 };
}
const bodyBox = () => { const P = G.player; return P.hb ? bulletBox() : P; };
function placePlayer() {   // on every resize: keep the plane's height in proportion (P.fy: 0 = bottom row, 1 = top of its range)
  const m = measure(PLAYER, 12), P = G.player;
  P.w = m.w; P.h = m.h; P.y = bottomY() - clamp(P.fy || 0, 0, 1) * (bottomY() - flightTop());
  P.x = P.x ? clamp(P.x, 4, view.W - P.w - 4) : view.W / 2 - P.w / 2;
}
function fitFormation() {   // the field got narrower (a pane opened): pull the formation back inside it
  const alive = G.enemies.filter((e) => e.alive && !e.free);
  if (!alive.length) return;
  const F = G.form, lo = Math.min(...alive.map((e) => e.ox)), hi = Math.max(...alive.map((e) => e.ox + e.w));
  F.x = Math.max(8 - lo, Math.min(F.x, view.W - 8 - hi));   // keeps the left edge in view if it can't all fit
}
// era: where to start (the title's pick, never past the best era reached); force skips that cap and the "best era" record (tests)
// Era state that rides on the core's own objects: a module that sets one in its update() sets it again every frame, so clearing them
// at every wave start (before the modules' onWave) keeps a debug jump or a new game from carrying another era's hitbox, focus or skin.
function resetTransient() {
  const P = G.player;
  P.hb = null; P.skin = null; P.noFlicker = false; G.focus = false; G.speedMul = 1;
  core.primary = "core"; core.primaryShot = null; core.primaryHoming = false; core.charging = false;   // weapon composition (see core.primary)
}
function newGame(era = G.startEra, force = false) {
  era = force ? clamp(era | 0, 1, ERA_MAX) : clamp(era | 0, 1, reachedEra());
  Object.assign(G, { state: "play", paused: false, score: 0, lives: 3, hits: 0, wave: 0, duck: null, weapon: 1, bubble: false, ally: null,
    fx: { refactor: 0, coffee: 0, pierce: 0, homing: 0, ally: 0, slow: 0 }, entry: null, scored: false, rank: -1, cheat: false,
    konami: false, sudoWave: 0, combo: { n: 0, last: -9, best: 0 }, particles: [], floaters: [], powerups: [], shields: [],
    era: 0, lift: 0, trail: [], hold: false, custom: false, glitch: 0, debugEra: !!force });
  G.player.fy = 0; G.player.cool = 0; resetTransient();
  placePlayer(); G.player.x = view.W / 2 - G.player.w / 2; G.player.inv = 0;
  for (const m of MODS) call1(m, "onNewGame");   // every module, whatever its era: its state starts clean and waits for its era
  startWave(waveOfEra(era));
}
const hash = (n) => ((n * 2654435761) >>> 0).toString(16).padStart(8, "0").slice(0, 7);
function waveTitle(n) {
  if (n % 4 === 0) { const k = n / 4, c = BOSSES[bossKind(k)].commits; return c[bossPass(k) % c.length]; }
  return COMMITS[(n - Math.floor(n / 4) - 1) % COMMITS.length];
}
function startWave(n) {
  const era = eraOf(n), up = era !== G.era;
  Object.assign(G, { wave: n, shots: [], ebul: [], drones: [], ufo: null, boss: null, enemies: [], clearT: 0, intro: 2.6, introMax: 2.6, eraIntro: 0,
    ufoT: rnd(10, 18), efireT: 1, diveT: rnd(4, 8), commit: waveTitle(n), hold: false, custom: false });
  applyEra(era);   // every wave: caps and fx are rebuilt from the tables, so nothing a higher era set can leak into this one
  if (up && era > 1) {   // a new era: the banner rides on the wave intro (longer), plus a CRT tear
    Object.assign(G, { eraIntro: era, intro: 3.8, introMax: 3.8, glitch: 0.7 }); G.shake = Math.max(G.shake, 3); SFX.era();
  }
  resetTransient();   // (applyEra has just run the onInert hooks of the eras left behind)
  if (!caps.shields) G.shields = [];
  else if (n === 1 || n % 4 === 1 || !G.shields.length) buildShields();
  const boss = n % 4 === 0;
  G.custom = !boss && ACTIVE.some((m) => { const r = m.hooks.replaceFormation ?? m.replaceFormation; return typeof r === "function" ? !!r(n) : r === true; });
  if (boss) spawnBoss(n / 4);
  else if (G.custom) G.form = { x: 0, y: 0, dir: 1, stepT: 99, frame: 0, n: 0 };   // the module spawns its own bugs in onWave
  else buildFormation(n);
  hook("onWave", n);
}
function buildFormation(n) {
  let rows = ["conflict", "fail", "todo", "bug", "bug"];
  if (n > 1) {
    const pool = ["bug", "bug", "todo", "todo", "fail", "fail", "nan", "conflict"];
    if (n > 4) pool.push("conflict", "nan");
    if (n > 2) pool.push("leak"); if (n > 3) pool.push("heisen"); if (n > 4) pool.push("segv");
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
  return { x: sh.fx * view.W - w / 2, y: bottomY() - 70, cw, lh, w, h: SHIELD.length * lh };
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
// Boss k (wave 4k) is BOSS_ORDER[k-1], round and round; each pass through the order (B.pass 0, 1, 2...) makes them all harder.
// B.level = k keeps growing, for the kill bonus.
function spawnBoss(k) {
  const kind = bossKind(k), def = BOSSES[kind];
  G.hitsAtBoss = G.hits;
  const B = G.boss = { kind, def, level: k, pass: bossPass(k), hp: 1, max: 1, x: view.W / 2, y: 50, w: 0, h: 0, t: 0, fireT: 2, spawnT: 5,
    sayT: 0, say: def.says[0], flash: 0, dropped: 0, minionDrops: 0 };
  def.init(B);
  const m = BOSS_HP[G.era] || 1;   // the guns grow with the eras (era 7's fan hits a big boss with every bolt), so the bosses' hit points grow with them
  if (m !== 1) { B.hp = B.max = Math.round(B.hp * m); for (const h of B.halves || []) h.hp = h.max = Math.round(h.hp * m); }
  def.update(B, 0);
}
const BOSS_HP = { 5: 1.4, 6: 2, 7: 3, 8: 3.5, 9: 4, 10: 4.5 };   // boss hit points x this, by era (boss waves are 4: era 3, 8: era 6, 12: era 9, 16+: era 10)

// ---------- effects ----------
function burst(x, y, color, n = 10, chars = "01*+.") {
  n = Math.round(n * VFX.burstMul);
  for (let i = 0; i < n; i++) {
    G.particles.push({ x, y, vx: rnd(-100, 100), vy: rnd(-130, 30), life: rnd(0.45, 1), t: 0, ch: chars[Math.floor(Math.random() * chars.length)], color });
  }
  if (G.particles.length > VFX.particleMax) G.particles.splice(0, G.particles.length - VFX.particleMax);
}
function float(text, x, y, color, size = 11, life = 1.1) { G.floaters.push({ text, x, y, color, size, t: 0, life }); }
const MILESTONES = [[404, "404: bugs not found", 0], [1337, "1337 h4x0r: +1 ✻", 1], [9001, "IT'S OVER 9000!", 1]];
function addScore(n) {
  const was = G.score;
  G.score += n; if (G.score > G.hi) G.hi = G.score;
  if (G.state !== "play") return;
  for (const [at, msg, life] of MILESTONES) {
    if (was >= at || G.score < at) continue;
    float(msg, view.W / 2, view.H * 0.6, C.amber, 15, 2.2); SFX.combo();
    if (life && G.lives < MAX_LIVES) G.lives++;
  }
}

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
  const P = G.player, spread = G.fx.refactor > 0, W = WEAPON[G.weapon];
  const n = W.length + (spread ? 2 : 0), max = (G.fx.coffee > 0 ? 4 : 2) * n;
  if (G.shots.filter((s) => !s.ally && !s.ghost).length >= max) return;
  P.cool = (G.fx.coffee > 0 ? 0.16 : 0.32) * (G.weapon >= 4 ? 0.8 : 1);
  const cx = P.x + P.w / 2, y = P.y - 8, pierce = G.fx.pierce > 0, hex = hexOn();
  const add = (dx, vx) => G.shots.push({ x: cx + dx, y, vx, vy: -440, pierce, hit: pierce ? new Set() : null, hex, ch: hex ? pick(HEX) : "" });
  for (const [dx, vx] of W) add(dx, vx);
  if (spread) { add(0, -140); add(0, 140); }
  SFX.shoot();
}
function stepFormation(dt) {
  const F = G.form, alive = G.enemies.filter((e) => e.alive && !e.dive && !e.free);   // (free = a module's own: it moves itself)
  if (!alive.length || (F.stepT -= dt * (G.fx.slow > 0 ? 0.35 : 1)) > 0) return;
  F.stepT = (0.04 + (0.34 * alive.length) / G.enemies.filter((e) => !e.temp).length) / (1 + 0.1 * (G.wave - 1));
  let minX = Infinity, maxX = -Infinity;
  for (const e of alive) { minX = Math.min(minX, F.x + e.ox); maxX = Math.max(maxX, F.x + e.ox + e.w); }
  const dx = 9 * F.dir;
  if (maxX + dx > view.W - 8 || minX + dx < 8) { F.dir = -F.dir; F.y += 14; } else F.x += dx;
  F.frame ^= 1; SFX.step(F.n++);
  const dead = bottomY();   // the fixed deadline, not the plane (it flies from era 3)
  for (const e of alive) {
    const ex = F.x + e.ox, ey = F.y + e.oy;
    if (ey + e.h > dead - 70) eraseShields(ex, ey, e.w, e.h);
    if (ey + e.h >= dead) return gameOver("the bugs shipped to production");
  }
}
function updateDivers(dt) {   // segfaults peel off and dive at you; the ones that get past fly back into line
  const P = G.player, sdt = dt * (G.fx.slow > 0 ? 0.4 : 1);
  if (!G.boss && (G.diveT -= dt) <= 0) {
    G.diveT = rnd(3, 6.5) / (1 + 0.06 * G.wave);
    const cand = G.enemies.filter((e) => e.alive && !e.dive && !e.free && TYPES[e.type].dives);
    if (cand.length && G.enemies.filter((e) => e.alive && e.dive).length < 1 + Math.floor(G.wave / 5)) {
      const e = pick(cand), p = epos(e);
      e.dive = { x: p.x, y: p.y, t: 0, sway: Math.random() * 6 };
    }
  }
  for (const e of G.enemies) {
    const d = e.dive;
    if (!d || !e.alive || e.free) continue;
    d.t += sdt;
    const tx = P.x + P.w / 2 - e.w / 2;
    d.y += (120 + 8 * G.wave) * sdt;
    d.x = clamp(d.x + clamp(tx - d.x, -150 * sdt, 150 * sdt) * (d.y < P.y - 120 ? 1 : 0.2) + Math.sin(d.t * 5 + d.sway) * 50 * sdt, 2, view.W - e.w - 2);
    eraseShields(d.x, d.y, e.w, e.h);
    const bb = bodyBox();
    if (overlap(d.x, d.y, e.w, e.h, bb.x, bb.y, bb.w, bb.h)) { kill(e, true); playerHit(1, e); continue; }
    if (d.y > view.H) e.dive = null;
  }
}
function updateAlly(dt) {   // the pair programmer: tags along beside you and fires on its own
  if (!(G.fx.ally > 0)) { G.ally = null; return; }
  const P = G.player, m = measure(ALLY, 10);
  const A = G.ally = G.ally || { x: P.x + P.w + 14, y: P.y, cool: 0.3, w: m.w, h: m.h };
  A.w = m.w; A.h = m.h; A.y = P.y + P.h - m.h;
  const tx = P.x + P.w + 14 + Math.sin(G.time * 1.7) * 6;
  A.x += (clamp(tx, 4, view.W - A.w - 4) - A.x) * Math.min(1, dt * 7);
  if ((A.cool -= dt) <= 0 && G.intro <= 0 && (G.boss || G.enemies.some((e) => e.alive))) {
    A.cool = 0.55;
    const hex = hexOn();
    G.shots.push({ x: A.x + A.w / 2, y: A.y - 6, vx: 0, vy: -420, ally: true, hex, ch: hex ? pick(HEX) : "" });
  }
}
function enemyFire(dt) {
  if ((G.efireT -= dt) > 0) return;
  G.efireT = rnd(0.4, 1.25) / (1 + 0.12 * (G.wave - 1));
  if (G.ebul.length >= 2 + Math.floor(G.wave / 2)) return;
  const bottoms = new Map();
  for (const e of G.enemies) if (e.alive && !e.dive && !e.free && (!bottoms.has(e.col) || bottoms.get(e.col).oy < e.oy)) bottoms.set(e.col, e);
  const list = [...bottoms.values()];
  if (!list.length) return;
  const px = G.player.x + G.player.w / 2;
  const e = Math.random() < 0.5 ? list.reduce((a, b) => (Math.abs(G.form.x + a.ox - px) < Math.abs(G.form.x + b.ox - px) ? a : b)) : pick(list);
  const T = TYPES[e.type];
  pushEbul({ x: G.form.x + e.ox + e.w / 2, y: G.form.y + e.oy + e.h, vx: 0, vy: Math.min(270, 135 + 12 * G.wave), ch: T.shot,
    color: C[T.color], wob: !!T.wobble, seed: Math.random() * 6 }, e);
}
function updateUfo(dt) {
  if (G.boss) return;
  if (!G.ufo) {
    if ((G.ufoT -= dt) <= 0) {
      const m = measure(UFO[0], 12), dir = Math.random() < 0.5 ? 1 : -1;
      G.ufo = { x: dir > 0 ? -m.w : view.W, y: 40, dir, w: m.w, h: m.h };   // (below the HUD's chip rows)
      SFX.ufo();
    }
    return;
  }
  G.ufo.x += G.ufo.dir * 85 * dt;
  if (G.ufo.x > view.W + 10 || G.ufo.x < -G.ufo.w - 10) { G.ufo = null; G.ufoT = rnd(14, 24); }
}
// ---------- bosses ----------
// Each boss is a definition with hooks: init(B) sets HP and its own state from B.pass; update(B, dt) moves it and (once the wave
// title is gone, G.intro <= 0) attacks; hit(B, shot) returns true when it took the shot (and calls bossHit for damage); draw(B);
// aim(B, shot) is where grep's homing shots steer; onDeath(B) is optional. Every timer runs on dt, so pause stops it all.
const BOSS_ORDER = ["clippy", "merge", "bsod", "npm", "loop"];
const bossKind = (k) => BOSS_ORDER[(k - 1) % BOSS_ORDER.length];
const bossPass = (k) => Math.floor((k - 1) / BOSS_ORDER.length);
const slowK = () => (G.fx.slow > 0 ? 0.5 : 1);   // sleep(7) slows the bosses' own clocks too
const lerp = (a, b, t) => a + (b - a) * t;
const hexOn = () => !!(G.boss && G.boss.hex > 0);   // the blue screen's hex-dump spell
// (the sway's angular speed is scaled down on a wide field: its linear speed would otherwise outrun the plane's 220 px/s and a boss could not be hit)
const swayX = (B, w, speed) => view.W / 2 - w / 2 + Math.sin(B.t * speed * Math.min(1, 640 / view.W)) * Math.max(0, view.W / 2 - w / 2 - 30);
const bossName = (B) => B.def.name + (B.pass ? ` v${B.pass + 1}` : "");
const hitBox = (s, x, y, w, h) => overlap(s.x - (s.w || 2) / 2, s.y, s.w || 2, s.h || 10, x, y, w, h);   // a shot is 2x10 unless it says (s.w, s.h)
let hitDmg = 1;   // the shot being resolved against a boss: bossHit(x) takes its s.dmg
// every enemy bullet the core makes goes through here, so modules hear about it (onEnemyBullet(b, src): src = the bug / boss that fired it)
function pushEbul(b, src) { G.ebul.push(b); hook("onEnemyBullet", b, src); return b; }
function bossShot(x, y, vx, vy, ch, color, src) { return pushEbul({ x, y, vx, vy, ch, color, seed: Math.random() * 6 }, src || G.boss); }
function minion(label, x, y, o = {}) {
  const m = measure([label], 11);
  G.drones.push({ x: clamp(x - m.w / 2, 2, view.W - m.w - 2), y, w: m.w, h: m.h, seed: Math.random() * 6, label, minion: true, ...o });
}
function aimedShot(x, y, v, ch, color, spread = 0, src) {
  const P = G.player, dx = P.x + P.w / 2 - x, dy = Math.max(40, P.y - y), a = Math.atan2(dx, dy) + spread;
  bossShot(x, y, Math.sin(a) * v, Math.cos(a) * v, ch, color, src);
}
const BOSSES = {
  clippy: {
    name: "CLIPPY.EXE", says: SAYS, commits: BOSS_COMMITS, death: "CLIPPY.EXE has stopped responding", flawless: "Clippy has nothing to say",
    init(B) { B.hp = B.max = 36 + 18 * B.pass; },
    update(B, dt) {
      const m = measure(CLIPPY[0], 15), L = B.pass + 1;
      B.w = m.w; B.h = m.h; B.x = swayX(B, B.w, 0.6); B.y = 50 + Math.sin(B.t * 1.6) * 6;
      if (G.intro > 0) return;
      const cx = B.x + B.w / 2, cy = B.y + B.h;
      if ((B.fireT -= dt) <= 0) {
        B.fireT = Math.max(0.75, 1.6 - 0.15 * L);
        const n = Math.min(7, 3 + 2 * B.pass), v = 160 + 15 * B.pass;
        for (let i = 0; i < n; i++) {
          const a = n > 1 ? -0.55 + (1.1 * i) / (n - 1) : 0;
          bossShot(cx, cy, Math.sin(a) * v, Math.cos(a) * v, i % 2 ? "?" : "@", C.amber);
        }
        SFX.ufo();
      }
      if ((B.spawnT -= dt) <= 0) { B.spawnT = Math.max(3, 6 - L); for (const dx of [-30, 30]) minion("[TODO]", cx + dx, cy); }
    },
    hit(B, s) { if (!hitBox(s, B.x + 6, B.y, B.w - 12, B.h)) return false; bossHit(s.x); return true; },
    draw(B) {
      const blink = Math.floor(B.t * 1.3) % 5 === 4 ? 1 : 0;
      drawSprite(sprite(CLIPPY[blink], 15, B.flash > 0 ? "#ffffff" : C.amber, 8), B.x, B.y);
      txt(bossName(B), B.x + B.w / 2, B.y - 14, C.dim, 10, "center");
    },
  },
  // Two halves drift together; kill both before they meet, or they merge: each heals half its HP (a resolved one comes back).
  merge: {
    name: "MERGE CONFLICT", says: MERGE_SAYS, commits: MERGE_COMMITS, death: "conflicts resolved: git commit --no-edit ✓",
    flawless: "fast-forward only",
    init(B) {
      const hp = 12 + 7 * B.pass;
      B.halves = [{ side: -1, art: MERGE_L, color: "orange2", hp, max: hp }, { side: 1, art: MERGE_R, color: "blue", hp, max: hp }];
      B.hp = B.max = hp * 2; B.gap = 1; B.meetT = Math.max(12, 30 - 8 * B.pass); B.merges = 0; B.fireT = 2.4; B.spawnT = 6;
    },
    update(B, dt) {
      const H = B.halves, alive = H.filter((h) => h.hp > 0);
      if (G.intro <= 0) {
        B.gap -= (dt * slowK() * (alive.length === 1 ? 1.5 : 1)) / B.meetT;   // the one left standing rushes in
        if (B.gap <= 0) mergeHalves(B);
      }
      const cx = view.W / 2, y = 60 + Math.sin(B.t * 1.4) * 5;
      for (const h of H) {
        const m = measure(h.art, 13);
        h.w = m.w; h.h = m.h; h.y = y;
        h.x = h.side < 0 ? lerp(cx - m.w - 8, 10, B.gap) : lerp(cx + 8, view.W - m.w - 10, B.gap);
      }
      B.x = H[0].x; B.y = y; B.w = H[1].x + H[1].w - H[0].x; B.h = Math.max(H[0].h, H[1].h);
      if (G.intro > 0) return;
      if ((B.fireT -= dt) <= 0) {
        B.fireT = Math.max(0.9, 1.8 - 0.3 * B.pass);
        for (const h of alive) {
          const x = h.x + h.w / 2, yy = h.y + h.h, v = 150 + 15 * B.pass;
          aimedShot(x, yy, v, h.side < 0 ? ">" : "<", C[h.color]);
          for (let i = 0; i < B.pass; i++) bossShot(x, yy, -h.side * rnd(30, 90), v, h.side < 0 ? ">" : "<", C[h.color]);
        }
        SFX.ufo();
      }
      if ((B.spawnT -= dt) <= 0) { B.spawnT = Math.max(3.5, 7 - B.pass); minion("[=======]", cx, y + B.h, { die: "resolved ✓", color: "red" }); }
    },
    hit(B, s) {
      for (const h of B.halves) {
        if (h.hp <= 0 || !hitBox(s, h.x, h.y, h.w, h.h)) continue;
        if (--h.hp <= 0 && B.hp > 1) {
          burst(h.x + h.w / 2, h.y + h.h / 2, C[h.color], 16, "<>=");
          float(`${h.side < 0 ? "HEAD" : "main"}: resolved ✓ (now the other one!)`, h.x + h.w / 2, h.y + h.h + 6, C.green, 12, 1.6);
        }
        bossHit(s.x);
        return true;
      }
      return false;
    },
    aim(B, s) {
      const al = B.halves.filter((h) => h.hp > 0);
      const h = al.length ? al.reduce((a, b) => (Math.abs(a.x + a.w / 2 - s.x) < Math.abs(b.x + b.w / 2 - s.x) ? a : b)) : B.halves[0];
      return { x: h.x + h.w / 2, y: h.y + h.h / 2 };
    },
    draw(B) {
      for (const h of B.halves) {
        if (h.hp > 0) {
          drawSprite(sprite(h.art, 13, B.flash > 0 ? "#ffffff" : C[h.color], 7), h.x, h.y);
          const n = 8, f = Math.ceil((h.hp / h.max) * n);
          txt(`[${"#".repeat(f)}${".".repeat(n - f)}]`, h.x + h.w / 2, h.y + h.h + 2, C[h.color], 9, "center", 2);
        } else txt("resolved ✓", h.x + h.w / 2, h.y + h.h / 2 - 6, C.green, 11, "center", 3, 0.45);
      }
      const cx = view.W / 2;
      txt(bossName(B), cx, B.y - 16, C.dim, 10, "center");
      if (B.gap < 0.35) txt("=======", cx, B.y + B.h / 2 - 6, C.red, 12, "center", 6, Math.floor(G.rt * 6) % 2 ? 1 : 0.4);
    },
  },
  // Sweeping rows of hex with a gap to slip through; every so often it turns your shots into harmless hex dumps for a few seconds.
  bsod: {
    name: "BLUE SCREEN OF DEATH", says: BSOD_SAYS, commits: BSOD_COMMITS, death: "rebooting... 100% complete", flawless: "no crash dump needed",
    init(B) {
      B.hp = B.max = 40 + 18 * B.pass; B.rowT = 2.2; B.hexT = 9; B.hex = 0; B.warn = 0; B.spawnT = 8; B.gapX = view.W / 2;
      B.rowEvery = Math.max(1.3, 2.6 - 0.45 * B.pass);
    },
    update(B, dt) {
      const face = pixelText(":(", "#ffffff", "#ffffff"), m = measure(BSOD_TXT, 10);
      B.fw = face.w * 4; B.fh = face.h * 4;
      B.w = Math.max(B.fw, m.w) + 24; B.h = B.fh + m.h + 34;
      B.x = swayX(B, B.w, 0.45); B.y = 50;
      if (G.intro > 0) return;
      const k = dt * slowK();
      if (B.hex > 0) B.hex -= k;
      else if (B.warn > 0) {
        if ((B.warn -= k) <= 0) {
          B.hex = Math.min(4.5, 2.5 + 0.6 * B.pass);
          float("your shots are hex dumps now", view.W / 2, view.H * 0.55, C.blue, 13, 1.6);
        }
      } else if ((B.hexT -= k) <= 0) { B.hexT = Math.max(5, 10 - 1.5 * B.pass); B.warn = 1.3; SFX.ufo(); }
      if ((B.rowT -= k) <= 0) { B.rowT = B.rowEvery; bsodRow(B); }
      if ((B.spawnT -= k) <= 0) { B.spawnT = Math.max(5, 9 - B.pass); minion("[WER.exe]", B.x + B.w / 2, B.y + B.h, { die: "report sent ✓", color: "blue" }); }
    },
    hit(B, s) { if (!hitBox(s, B.x, B.y, B.w, B.h)) return false; bossHit(s.x); return true; },
    draw(B) {
      const cx = B.x + B.w / 2;
      ctx.fillStyle = B.flash > 0 ? "rgba(255,255,255,.35)" : "rgba(0,120,215,.22)"; ctx.fillRect(B.x, B.y, B.w, B.h);
      drawPixelText(":(", cx, B.y + 8, B.fw, 4, "#ffffff", "#ffffff");
      BSOD_TXT.forEach((l, i) => txt(l, cx, B.y + B.fh + 14 + i * 12, C.text, 10, "center"));
      txt(`${Math.floor(100 * (1 - B.hp / B.max))}% complete`, cx, B.y + B.fh + 14 + BSOD_TXT.length * 12, C.blue, 10, "center", 3);
      txt(bossName(B), cx, B.y - 13, C.dim, 10, "center");
      if (B.warn > 0) txt("*** STOP: 0x0000DEAD ***", view.W / 2, view.H * 0.55, C.red, 13, "center", 6, Math.floor(G.rt * 8) % 2 ? 1 : 0.35);
      if (B.hex > 0) txt(`hex mode ${Math.ceil(B.hex)}s: your shots do nothing`, view.W / 2, bottomY() - 86, C.blue, 10, "center", 3);
    },
  },
  // A dependency tree: deps hang under the root package and shield it, drop off as node_modules minions and grow back.
  // Kill the root and the whole tree goes with it.
  npm: {
    name: "npm install", says: NPM_SAYS, commits: NPM_COMMITS, death: "removed 1,337 packages, audited 0", flawless: "found 0 vulnerabilities",
    init(B) {
      B.hp = B.max = 30 + 14 * B.pass; B.depHp = B.pass >= 2 ? 3 : 2;
      B.deps = Array.from({ length: Math.min(6, 4 + B.pass) }, () => ({ name: pick(DEPS), hp: B.depHp, grow: 1 }));
      B.regrowEvery = Math.max(1.6, 4 - 0.8 * B.pass); B.regrowT = B.regrowEvery; B.dropT = 5; B.fireT = 2; B.shots = 0;
    },
    update(B, dt) {
      const m = measure(NPM_ROOT, 12), k = dt * slowK();
      B.w = m.w; B.h = m.h; B.x = swayX(B, B.w, 0.5); B.y = 52 + Math.sin(B.t * 1.2) * 4;   // (clear of the HUD's chip rows)
      const n = B.deps.length, sp = Math.min(84, (view.W - 40) / n), cx = B.x + B.w / 2;
      B.deps.forEach((d, i) => {
        if (!d) return;
        const dm = measure([`[${d.name}]`], 11);
        d.grow = Math.min(1, d.grow + dt * 2); d.w = dm.w; d.h = dm.h; d.flash = Math.max(0, (d.flash || 0) - dt);
        d.x = cx + (i - (n - 1) / 2) * sp - dm.w / 2; d.y = B.y + B.h + 26;
      });
      if (G.intro > 0) return;
      const live = B.deps.filter((d) => d && d.grow >= 0.5);
      if ((B.regrowT -= k) <= 0) {
        B.regrowT = B.regrowEvery;
        const empty = B.deps.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
        if (empty.length) B.deps[pick(empty)] = { name: pick(DEPS), hp: B.depHp, grow: 0 };
      }
      if ((B.dropT -= k) <= 0) {   // a dep falls off the tree as a node_modules minion
        B.dropT = Math.max(2.5, 5 - B.pass);
        if (live.length) {
          const d = pick(live);
          B.deps[B.deps.indexOf(d)] = null;
          minion(`[${d.name}]`, d.x + d.w / 2, d.y, { die: "uninstalled", color: "green", vy: 50 });
        }
      }
      if ((B.fireT -= k) <= 0) {
        B.fireT = Math.max(0.7, 1.5 - 0.25 * B.pass); B.shots++;
        for (let i = 0; i <= Math.min(2, B.pass) && live.length; i++) { const d = pick(live); aimedShot(d.x + d.w / 2, d.y + d.h, 150 + 15 * B.pass, "^", C.green, rnd(-0.15, 0.15)); }
        if (B.shots % 3 === 0) for (const a of [-0.35, 0, 0.35]) bossShot(cx, B.y + B.h, Math.sin(a) * 160, Math.cos(a) * 160, "~", C.amber);
      }
    },
    hit(B, s) {
      for (let i = 0; i < B.deps.length; i++) {
        const d = B.deps[i];
        if (!d || d.grow < 0.5 || !hitBox(s, d.x, d.y, d.w, d.h)) continue;
        if (--d.hp <= 0) {
          B.deps[i] = null; addScore(20 * comboHit());
          burst(d.x + d.w / 2, d.y + d.h / 2, C.green, 10); float(`npm rm ${d.name}`, d.x + d.w / 2, d.y, C.green, 10);
          minionDrop(d.x + d.w / 2, d.y, 0.15); SFX.hit();
        } else { d.flash = 0.07; burst(s.x, s.y, C.amber, 3); SFX.hit(); }
        return true;
      }
      if (!hitBox(s, B.x + 4, B.y, B.w - 8, B.h)) return false;
      bossHit(s.x); return true;
    },
    onDeath(B) {
      for (const d of B.deps) if (d) { burst(d.x + d.w / 2, d.y + d.h / 2, C.green, 8); addScore(20); }
      B.deps = B.deps.map(() => null);
    },
    draw(B) {
      const cx = B.x + B.w / 2, n = B.deps.length, sp = Math.min(84, (view.W - 40) / n), y0 = B.y + B.h, lo = cx - ((n - 1) / 2) * sp;
      drawSprite(sprite(NPM_ROOT, 12, B.flash > 0 ? "#ffffff" : C.amber, 6), B.x, B.y);
      txt(bossName(B), cx, B.y - 13, C.dim, 10, "center");
      ctx.fillStyle = C.faint; ctx.fillRect(lo, y0 + 8, sp * (n - 1), 1); ctx.fillRect(cx, y0 - 2, 1, 10);
      B.deps.forEach((d, i) => {
        const x = lo + i * sp;
        ctx.fillStyle = C.faint; ctx.fillRect(x, y0 + 8, 1, 16);
        if (!d) return;
        const hurt = d.hp < B.depHp;
        drawSprite(sprite([`[${d.name}]`], 11, d.flash > 0 ? "#ffffff" : hurt ? C.amber : C.green, 4), d.x, d.y, d.grow < 0.5 ? 0.3 : d.grow);
      });
    },
  },
  // A spinning ⟳ inside a rotating ring of "do{continue;}while(true)": shots only get through the gaps to the core.
  loop: {
    name: "INFINITE LOOP", says: LOOP_SAYS, commits: LOOP_COMMITS, death: "break; // finally", flawless: "O(1) after all",
    init(B) {
      B.hp = B.max = 24 + 12 * B.pass; B.R = 56; B.N = LOOP_RING.length; B.rot = 0; B.dir = 1; B.flipT = 6; B.fireT = 2.4; B.spawnT = 7;
      B.spin = 0.6 + 0.3 * B.pass;
      const gaps = Math.max(2, 4 - B.pass), every = Math.floor(B.N / gaps);   // gaps of 3 segments: 4, then 3, then 2
      B.open = new Set(Array.from({ length: B.N }, (_, i) => i).filter((i) => i % every < 3 && i < every * gaps));
    },
    update(B, dt) {
      const k = dt * slowK();
      B.cx = view.W / 2 + Math.sin(B.t * 0.4) * Math.max(0, view.W / 2 - B.R - 40); B.cy = 66 + B.R + Math.sin(B.t * 1.3) * 4;
      B.x = B.cx - B.R - 8; B.y = B.cy - B.R - 8; B.w = B.h = 2 * B.R + 16;
      B.rot = (B.rot + B.dir * B.spin * k) % (Math.PI * 2);
      if (G.intro > 0) return;
      if (B.pass > 0 && (B.flipT -= k) <= 0) { B.flipT = rnd(4, 7); B.dir = -B.dir; float("reverse()", B.cx, B.cy + B.R + 10, C.blue, 10); }
      if ((B.fireT -= k) <= 0) {   // bullets fly out of the gaps that face down
        B.fireT = Math.max(0.8, 1.7 - 0.3 * B.pass);
        const seg = (Math.PI * 2) / B.N, v = 140 + 15 * B.pass;
        let fired = 0;
        for (const i of B.open) {
          const a = B.rot + (i + 0.5) * seg;
          if (Math.sin(a) < 0.3) continue;
          bossShot(B.cx + Math.cos(a) * B.R, B.cy + Math.sin(a) * B.R, Math.cos(a) * v, Math.sin(a) * v, "∞", C.orange2); fired++;
        }
        if (!fired || B.pass > 0) aimedShot(B.cx, B.cy + B.R + 4, v, "∞", C.orange2);
        SFX.ufo();
      }
      if ((B.spawnT -= k) <= 0) { B.spawnT = Math.max(4, 8 - B.pass); minion("[for(;;)]", B.cx, B.cy + B.R, { die: "break;", color: "orange2" }); }
    },
    // Where a shot's path this frame crosses the ring (radius R) or reaches the core (radius 22), from its last spot: a fast
    // shot on a slow frame moves over 20px, and could jump straight over a thin ring if we only checked where it is now.
    hit(B, s) {
      const x0 = s.px ?? s.x, y0 = (s.py ?? s.y) + 4, dx = s.x - x0, dy = s.y + 4 - y0, fx = x0 - B.cx, fy = y0 - B.cy;
      const a = dx * dx + dy * dy || 1e-6, b = 2 * (fx * dx + fy * dy);
      const cross = (r) => {   // where along this frame's path (0..1) it crosses the circle of radius r
        const c = fx * fx + fy * fy - r * r, disc = b * b - 4 * a * c;
        if (disc < 0) return [];
        const q = Math.sqrt(disc);
        return [(-b - q) / (2 * a), (-b + q) / (2 * a)].filter((t) => t >= 0 && t <= 1);
      };
      const core = fx * fx + fy * fy <= 484 ? 0 : cross(22)[0], seg = (Math.PI * 2) / B.N;
      for (const t of cross(B.R)) {
        if (core != null && core < t) break;
        const ang = Math.atan2(fy + dy * t, fx + dx * t), i = Math.floor((((ang - B.rot) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / seg) % B.N;
        if (B.open.has(i)) continue;
        burst(x0 + dx * t, y0 + dy * t, C.blue, 3, "{}.");
        return true;   // the ring takes it
      }
      if (core == null) return false;
      bossHit(s.x); return true;
    },
    aim(B) { return { x: B.cx, y: B.cy }; },
    draw(B) {
      const seg = (Math.PI * 2) / B.N;
      for (let i = 0; i < B.N; i++) {
        if (B.open.has(i)) continue;
        const a = B.rot + (i + 0.5) * seg, sp = sprite([LOOP_RING[i]], 14, C.blue, 5);
        drawSprite(sp, B.cx + Math.cos(a) * B.R - sp.w / 2, B.cy + Math.sin(a) * B.R - sp.h / 2);
      }
      ctx.save(); ctx.translate(B.cx, B.cy); ctx.rotate(B.t * 3 * B.dir);
      txt("⟳", 0, -21, B.flash > 0 ? "#ffffff" : C.orange2, 36, "center", 8);
      ctx.restore();
      txt(bossName(B), B.cx, B.cy - B.R - 22, C.dim, 10, "center");
    },
  },
};
function mergeHalves(B) {   // they met: auto-merge, and both heal
  B.merges++; B.gap = 1;
  for (const h of B.halves) h.hp = h.hp > 0 ? Math.min(h.max, h.hp + Math.ceil(h.max / 2)) : Math.ceil(h.max / 2);
  B.hp = B.halves.reduce((a, h) => a + h.hp, 0);
  const cx = view.W / 2, cy = B.y + B.h / 2;
  burst(cx, cy, C.red, 26, "<>=");
  float("Auto-merging... CONFLICT healed itself", cx, cy + 30, C.red, 13, 1.8);
  for (let i = 0; i < 5 + B.pass * 2; i++) { const a = -0.7 + (1.4 * i) / (4 + B.pass * 2); bossShot(cx, cy, Math.sin(a) * 150, Math.cos(a) * 150, "=", C.red); }
  G.shake = Math.max(G.shake, 6); SFX.boom();
}
function bsodRow(B) {   // a row of hex across the field, with one gap the player can reach in time
  const P = G.player, W = view.W, gw = P.w * Math.max(1.8, 2.9 - 0.4 * B.pass), reach = 220 * B.rowEvery * 0.7;
  B.gapX = clamp(B.gapX + rnd(-reach, reach), gw / 2 + 8, W - gw / 2 - 8);
  for (let x = 6; x < W - 4; x += 13) {
    if (Math.abs(x - B.gapX) < gw / 2) continue;
    bossShot(x, B.y + B.h + 4, 0, 70 + 14 * B.pass, pick(HEX), C.blue);
  }
}
function updateBoss(dt) {
  const B = G.boss;
  B.t += dt; B.flash = Math.max(0, B.flash - dt);
  if ((B.sayT -= dt) <= 0) { B.say = pick(B.def.says); B.sayT = 4; }
  B.def.update(B, dt);
}
function updateDrones(dt) {
  for (const d of G.drones) {
    d.y += (d.vy || (d.drip ? 70 : 38)) * dt; d.x += Math.sin(G.time * 2 + d.seed) * (d.drip ? 14 : 40) * dt;
    eraseShields(d.x, d.y, d.w, d.h);
    const bb = bodyBox();
    if (overlap(d.x, d.y, d.w, d.h, bb.x, bb.y, bb.w, bb.h)) { d.dead = true; playerHit(1, d); }
    if (d.y > view.H) d.dead = true;
  }
  G.drones = G.drones.filter((d) => !d.dead);
}
function kill(e, noDrop) {
  e.alive = false;
  const T = TYPES[e.type], p = epos(e), cx = p.x + e.w / 2, cy = p.y + e.h / 2, m = comboHit(), pts = T.pts * m;
  addScore(pts);
  burst(cx, cy, C[T.color], 12);
  float(T.die, cx, cy - 6, C[T.dieColor]);
  if (m > 1) float(`+${pts}`, cx, cy + 8, C.dim, 10);
  if (T.splits) {   // a memory leak drips two more
    const mm = measure(["(.)"], 11);
    for (const dx of [-14, 14]) G.drones.push({ x: cx + dx - mm.w / 2, y: cy, w: mm.w, h: mm.h, seed: Math.random() * 6, label: "(.)", die: "free()", drip: true });
  }
  G.shake = Math.max(G.shake, 1.2);
  SFX.hit();
  if (!noDrop) dropPower(cx, cy, false);
  hook("onKill", e, { x: cx, y: cy, points: pts, mult: m });
}
// want: this power-up and no other; real: never a trojan
function dropPower(x, y, force, want, real) {
  if (!force && (Math.random() > 0.1 || G.powerups.length >= 2)) return;
  const pool = ["refactor", "refactor", "coffee", "coffee", "duck", "lgtm", "revert", "sudo", "grep", "pair", "firewall", "sleep", "npm", "npm", "life"]
    .filter((t) => (t !== "npm" || G.weapon < 4) && (t !== "life" || G.lives < MAX_LIVES));
  if (G.lives < 3) pool.push("revert", "revert", "firewall");
  for (const [id, p] of Object.entries(POWERS)) if (p.drop && G.era >= (p.era || 1)) for (let i = 0; i < p.drop; i++) pool.push(id);   // registered ones (core.addPower)
  const fake = !want && !real && G.wave >= 3 && Math.random() < 0.14;   // a trojan: looks like a power-up, but its name is spelled with numbers
  const type = fake ? pick(["coffee", "refactor", "sudo", "firewall"]) : want || pick(pool);
  const label = fake ? POWERS[type].label.replace(/[oe]/, (c) => (c === "o" ? "0" : "3")) : POWERS[type].label;
  const m = measure(["[" + label + "]"], 11);
  G.powerups.push({ type, label, fake, x: clamp(x - m.w / 2, 4, view.W - m.w - 4), y, w: m.w, h: m.h });
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
  else if (type === "sudo") { G.fx.pierce = 9; float("sudo: shots go right through", cx, y, C.red); }
  else if (type === "grep") { G.fx.homing = 9; float("grep: shots find the bugs", cx, y, C.blue); }
  else if (type === "pair") { G.fx.ally = 12; float("a pair programmer joins", cx, y, C.green); }
  else if (type === "firewall") { G.bubble = true; float("firewall up: blocks one hit", cx, y, C.orange); }
  else if (type === "sleep") { G.fx.slow = 7; float("sleep(7): everything slows down", cx, y, C.blue); }
  else if (type === "npm") {
    if (G.weapon < 4) { G.weapon++; float(`npm update: weapon v${G.weapon}`, cx, y, C.amber, 12, 1.5); }
    else { addScore(300); float("already latest: +300", cx, y, C.amber); }
  } else if (type === "life") {
    if (G.lives < MAX_LIVES) { G.lives++; float("+1 ✻", cx, y, C.orange2); } else { addScore(300); float("full health: +300", cx, y, C.orange2); }
  } else if (type === "lgtm") {
    for (const b of G.ebul) burst(b.x, b.y, C.green, 2, "✓.");
    G.ebul = []; G.drones = [];
    const alive = G.enemies.filter((e) => e.alive && !e.free);
    if (alive.length) { const low = Math.max(...alive.map((e) => e.oy)); for (const e of alive) if (e.oy === low) kill(e, true); }
    for (const e of G.enemies) if (e.alive && e.free && !e.wait && e.y > 0) kill(e, true);   // a module's own bugs on screen go too
    G.shake = Math.max(G.shake, 5);
    float("LGTM ✓ ship it", view.W / 2, view.H * 0.55, C.green, 16, 1.3);
  } else if (POWERS[type] && POWERS[type].apply) POWERS[type].apply(core, P);
}
// dmg: lives lost (polarity's "opposite colour does double"); src: the bullet / drone / bug that did it, for the hook
function playerHit(dmg = 1, src) {
  const P = G.player;
  if (P.inv > 0 || G.state !== "play") return;
  if (hookClaim("onPlayerHit", src)) return;   // a module absorbed it (the roll's dodge, a same-colour bullet)
  if (G.bubble) {   // the firewall takes it
    G.bubble = false; P.inv = 1.2; G.shake = 4; G.ebul = [];
    burst(P.x + P.w / 2, P.y + 6, C.orange, 18, "()|");
    float("firewall held", P.x + P.w / 2, P.y - 22, C.orange, 12, 1.2);
    SFX.hurt();
    return;
  }
  G.lives -= dmg; G.hits++; P.inv = 2; G.shake = 9; G.combo.n = 0;
  burst(P.x + P.w / 2, P.y + 8, C.orange, 26);
  float(pick(OUCH), P.x + P.w / 2, P.y - 22, C.red, 12, 1.4);
  if (G.weapon > 1) { G.weapon--; float(`weapon downgraded to v${G.weapon}`, P.x + P.w / 2, P.y - 38, C.dim, 10, 1.4); }
  G.ebul = [];
  SFX.hurt();
  hook("onPlayerDied", G.lives);   // every lost life (the firewall's save and absorbed hits don't count); livesLeft can be <= 0
  if (G.lives <= 0 && G.state === "play") gameOver("FATAL: unhandled exception in production");
}
function gameOver(reason) {
  G.state = "over"; G.overReason = reason; G.overAt = G.rt; G.shake = 10; G.scored = false;
  store.set("hi", G.hi); SFX.boom();
}
// Power-ups in boss fights: every boss drops one (never a trojan) as its HP passes 2/3 and 1/3, once each (a boss that heals
// can't drop them again), and its minions drop one 22% of the time, at most 3 a fight. While the gun isn't maxed, a fair share of
// them are npm update.
const BOSS_DROPS = [2 / 3, 1 / 3], MINION_DROPS = 3;
function bossDrop(x, y) { dropPower(x, y, true, G.weapon < 4 && Math.random() < 0.45 ? "npm" : null, true); }
function minionDrop(x, y, chance = 0.22) {
  const B = G.boss;
  if (!B || B.minionDrops >= MINION_DROPS || G.powerups.length >= 2 || Math.random() >= chance) return;
  B.minionDrops++;
  dropPower(x, y, true, G.weapon < 4 && Math.random() < 0.35 ? "npm" : null);
}
function bossHit(x) {
  const B = G.boss;
  B.hp -= hitDmg; B.flash = 0.08; addScore(5); G.shake = Math.max(G.shake, 1);
  while (B.hp > 0 && B.dropped < BOSS_DROPS.length && B.hp <= Math.floor(B.max * BOSS_DROPS[B.dropped])) {   // a third of it gone
    B.dropped++; bossDrop(x ?? B.x + B.w / 2, B.y + B.h);
  }
  if (B.hp > 0) return SFX.hit();
  const cx = B.x + B.w / 2, cy = B.y + B.h / 2, bonus = 1000 * B.level * mult();
  addScore(bonus);
  if (B.def.onDeath) B.def.onDeath(B);
  for (let i = 0; i < 4; i++) burst(cx + rnd(-30, 30), cy + rnd(-30, 30), pick([C.amber, C.orange, C.text]), 20);
  float(B.def.death, view.W / 2, cy, C.amber, 14, 2.2);
  float(`+${bonus}`, view.W / 2, cy + 20, C.dim, 11, 2);
  if (G.lives < MAX_LIVES) { G.lives++; float("+1 ✻", G.player.x + G.player.w / 2, G.player.y - 20, C.orange, 12, 1.6); }
  if (G.hits === G.hitsAtBoss) { addScore(500); float(`flawless: ${B.def.flawless}  +500`, view.W / 2, cy + 40, C.green, 12, 2.2); }
  G.boss = null; G.drones = []; G.ebul = []; G.clearT = 2.6; G.shake = 12;
  SFX.boom();
}
function updateShots(dt) {
  const homing = G.fx.homing > 0;
  for (const s of G.shots) {
    const sw = s.w || 2, sh = s.h || 10, sx = () => s.x - sw / 2;   // (modules' shots may be wider / longer; core ones are 2x10)
    if (homing && s.vy < 0 && !s.ally) {   // grep: steer toward the nearest bug above
      let want = null, best = 1e9;
      for (const e of G.enemies) {
        if (!e.alive || hidden(e)) continue;
        const p = epos(e), dx = p.x + e.w / 2 - s.x, dy = p.y + e.h / 2 - s.y;
        if (dy > 0) continue;
        const d = dx * dx + dy * dy * 0.5;
        if (d < best) { best = d; want = dx; }
      }
      if (want == null && G.boss) {   // in a boss fight: steer at its weak spot
        const B = G.boss, t = B.def.aim ? B.def.aim(B, s) : { x: B.x + B.w / 2, y: B.y + B.h / 2 };
        if (t.y < s.y) want = t.x - s.x;
      }
      if (want != null) s.vx += clamp(clamp(want * 3, -240, 240) - s.vx, -700 * dt, 700 * dt);
    }
    s.px = s.x; s.py = s.y;
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.y < 18 || s.y > view.H || s.x < 0 || s.x > view.W || (s.life != null && (s.life -= dt) <= 0)) { s.dead = true; continue; }
    if (shieldHit(s.x, s.y)) { s.dead = true; continue; }
    if (s.hex) {   // a hex dump: harmless, it just splats on the blue screen
      const B = G.boss;
      if (B && hitBox(s, B.x, B.y, B.w, B.h)) { s.dead = true; burst(s.x, s.y, C.blue, 2, HEX); }
      continue;
    }
    for (const e of G.enemies) {
      if (!e.alive || hidden(e) || (s.hit && s.hit.has(e))) continue;
      const p = epos(e);
      if (!overlap(sx(), s.y, sw, sh, p.x, p.y, e.w, e.h)) continue;
      if (s.hit) s.hit.add(e); else s.dead = true;   // a sudo shot goes through
      e.hp -= s.dmg || 1; e.flash = 0.07;
      if (e.hp <= 0) kill(e); else { SFX.hit(); burst(s.x, s.y, C.amber, 4, "=<>"); }
      if (!s.hit) break;
    }
    if (s.dead) continue;
    const U = G.ufo;
    if (U && overlap(sx(), s.y, sw, sh, U.x, U.y, U.w, U.h)) {
      s.dead = true; G.ufo = null; G.ufoT = rnd(14, 24);
      const pts = pick([50, 100, 150, 300]) * comboHit();
      addScore(pts); burst(U.x + U.w / 2, U.y + U.h / 2, C.orange2, 22);
      float(SEASON === "friday" ? "rollback!" : "break;", U.x + U.w / 2, U.y + 4, C.orange2, 13, 1.4); float(`+${pts}`, U.x + U.w / 2, U.y + 20, C.dim, 10, 1.4);
      dropPower(U.x + U.w / 2, U.y + U.h, true); G.shake = Math.max(G.shake, 4); SFX.boom();
      continue;
    }
    const B = G.boss;
    hitDmg = s.dmg || 1;
    const bossTook = B && B.def.hit(B, s);
    hitDmg = 1;
    if (bossTook) { s.dead = true; burst(s.x, s.y, C.amber, 3); continue; }
    for (const d of G.drones) {
      if (d.dead || !overlap(sx(), s.y, sw, sh, d.x, d.y, d.w, d.h)) continue;
      s.dead = d.dead = true; addScore(15 * comboHit()); burst(d.x + d.w / 2, d.y, d.drip ? C.green : C[d.color] || C.text, 8);
      float(d.die || "DONE ✓", d.x + d.w / 2, d.y, C.green);
      if (d.minion) minionDrop(d.x + d.w / 2, d.y);   // (boss fights have power-ups too)
      break;
    }
    if (s.dead) continue;
    for (const p of G.powerups) {   // shoot a trojan before it reaches you
      if (p.dead || !p.fake || !overlap(sx(), s.y, sw, sh, p.x, p.y, p.w, p.h)) continue;
      s.dead = p.dead = true; addScore(150 * comboHit()); burst(p.x + p.w / 2, p.y, C.red, 12, "01x");
      float("trojan neutralised +150", p.x + p.w / 2, p.y, C.red, 11, 1.3); SFX.hit();
      break;
    }
    if (s.dead) continue;
    if (s.ghost) continue;   // a ghost shot (a beam, a laser) flies through enemy bullets
    for (const b of G.ebul) {
      if (!b.dead && !b.solid && Math.abs(b.x - s.x) < 6 && Math.abs(b.y - s.y - 4) < 10) { b.dead = s.dead = true; burst(s.x, s.y, C.amber, 5, "x+."); break; }
    }
  }
  G.shots = G.shots.filter((s) => !s.dead);
  G.drones = G.drones.filter((d) => !d.dead);
  G.powerups = G.powerups.filter((p) => !p.dead);
}
function updateBullets(dt) {
  const D = G.duck, hb = bulletBox();
  for (const b of G.ebul) {
    if (b.dead) continue;
    const sl = G.fx.slow > 0 ? 0.5 : 1;   // sleep(7)
    b.y += b.vy * dt * sl; b.x += b.vx * dt * sl;
    if (b.wob) b.x += Math.sin((G.time + b.seed) * 9) * 70 * dt;
    if (b.y > view.H || b.y < -30 || b.x < -10 || b.x > view.W + 10) { b.dead = true; continue; }
    if (shieldHit(b.x, b.y + 8)) { b.dead = true; continue; }
    const bw = b.r ? b.r * 2 : b.w || 6, bh = b.r ? b.r * 2 : b.h || 10, bx = b.x - bw / 2, by = b.r ? b.y + 5 - b.r : b.y;   // (default 6x10; r: a disc centred 5px below b.y; w / h: a box)
    if (D && overlap(bx, by, bw, bh, D.x, D.y, D.w || 30, D.h || 30)) {
      b.dead = true; D.hp--; burst(b.x, b.y + 6, C.amber, 5, "~'");
      float(D.hp > 0 ? "quack!" : "duck: 'oh, I see the bug now'", D.x + 15, D.y - 4, C.amber, D.hp > 0 ? 10 : 11, 1.3);
      if (D.hp <= 0) G.duck = null;
      continue;
    }
    let touch;
    if (b.r) {   // a round bullet: the nearest point of the plane's box must lie within r
      const dx = Math.max(hb.x - b.x, 0, b.x - hb.x - hb.w), dy = Math.max(hb.y - (b.y + 5), 0, b.y + 5 - hb.y - hb.h);
      touch = dx * dx + dy * dy <= b.r * b.r;
    } else touch = overlap(bx, by, bw, bh, hb.x, hb.y, hb.w, hb.h);
    if (touch) { b.dead = true; playerHit(1, b); }
  }
  G.ebul = G.ebul.filter((b) => !b.dead);
}
function updatePowerups(dt) {
  const P = G.player;
  for (const p of G.powerups) {
    p.y += (p.fake ? 85 : 60) * dt;
    if (overlap(p.x, p.y, p.w, p.h, P.x, P.y, P.w, P.h)) {
      p.dead = true;
      if (p.fake) { float("it was a trojan!", P.x + P.w / 2, P.y - 22, C.red, 12, 1.3); playerHit(1, p); } else applyPower(p.type);
    }
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
// The plane: arrows / WASD. Up and down only with caps.move2d (the lift eases 0..1 so the range opens smoothly); diagonals are normalised.
function movePlane(dt) {
  const P = G.player, down = keys.has("down") ? 1 : 0, up = keys.has("up") ? 1 : 0;
  const dx = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0), dy = caps.move2d ? down - up : 0;
  G.lift += ((caps.move2d ? 1 : 0) - G.lift) * Math.min(1, dt * 3);
  if (!caps.move2d && G.lift < 0.01) G.lift = 0;
  const v = (G.fx.coffee > 0 ? 340 : 220) * G.speedMul * (dx && dy ? Math.SQRT1_2 : 1);
  P.x = clamp(P.x + dx * v * dt, 4, view.W - P.w - 4);
  const bot = bottomY(), full = flightTop(), top = bot - (bot - full) * G.lift;   // era 1-2: top == bot, the plane stays on the bottom row
  P.y = clamp(P.y + dy * v * dt, top, bot);
  P.fy = bot > full ? clamp((bot - P.y) / (bot - full), 0, 1) : 0;
}
function updateTrail(dt) {
  const n = Math.round(VFX.trail), P = G.player;
  if (!n) { if (G.trail.length) G.trail.length = 0; return; }
  if ((G.trailT -= dt) > 0) return;
  G.trailT = 0.025; G.trail.unshift({ x: P.x + P.w / 2, y: P.y + P.h });
  if (G.trail.length > n) G.trail.length = n;
}
// Flying into a bug hurts (era 3+, or any bug on its own path) and costs a life. Eras 1-2: the bug dies. From era 3 ramming does ONE damage
// (a 5-hp bomber survives it; at most one per bug every 0.7 s, so sitting inside one while invulnerable doesn't grind it down) unless
// caps.contactKills is set (the old rule: it dies whatever its hp).
function updateContacts() {
  const bb = bodyBox(), soft = caps.move2d && !caps.contactKills;
  for (const e of G.enemies) {
    if (!e.alive || e.wait || e.dive || !(e.free || caps.move2d)) continue;
    const p = epos(e);
    if (!overlap(p.x, p.y, e.w, e.h, bb.x, bb.y, bb.w, bb.h)) continue;
    if (soft) {
      if (e.contactT > G.time) continue;
      e.contactT = G.time + 0.7; e.hp -= 1;
      if (e.hp <= 0) kill(e, true); else { e.flash = 0.07; burst(p.x + e.w / 2, p.y + e.h / 2, C.amber, 5, "=<>"); SFX.hit(); }
    } else kill(e, true);
    playerHit(1, e);
    if (G.state !== "play") return;
  }
  const B = G.boss;
  if (B && caps.move2d && G.intro <= 0 && overlap(B.x, B.y, B.w, B.h, bb.x, bb.y, bb.w, bb.h)) playerHit(1, B);
}
function clearWave() {   // the last bug is gone: bonus, banner, next wave (a module with its own waves calls this too)
  if (G.clearT || G.state !== "play") return;
  G.clearT = 1.8; addScore(100 * G.wave);
  float("✓ all checks passed", view.W / 2, view.H * 0.45, C.green, 15, 1.7);
  float(`+${100 * G.wave}`, view.W / 2, view.H * 0.45 + 20, C.dim, 11, 1.7);
}
function update(dt) {
  const P = G.player;
  G.time += dt;
  for (const k of Object.keys(G.fx)) G.fx[k] = Math.max(0, G.fx[k] - dt);
  P.inv = Math.max(0, P.inv - dt); P.cool -= dt;
  G.speedMul = 1;
  hook("update", dt);   // (also during the wave title: scroll, animate; don't attack until G.intro <= 0)
  if (G.state !== "play") return;
  movePlane(dt); updateTrail(dt);
  if (keys.has("fire") && P.cool <= 0 && G.intro <= 0 && !fireHooks()) fire();   // (not while the wave's title is up and nothing moves yet)
  if (G.intro > 0) G.intro -= dt;
  else {
    if (!G.custom) { stepFormation(dt); enemyFire(dt); }
    updateUfo(dt); updateDivers(dt); updatePathEnemies(dt);
  }
  if (G.state !== "play") return updateFx(dt);
  if (G.boss) updateBoss(dt);
  updateDrones(dt); updateContacts(); updateShots(dt); updateBullets(dt); updatePowerups(dt); updateDuck(dt); updateAlly(dt); updateFx(dt);
  if (G.state !== "play") return;   // a hit can end the run mid-update
  if (G.enemies.length > 80) G.enemies = G.enemies.filter((e) => e.alive || !e.temp);   // the dead module-spawned ones are only dead weight
  if (!G.boss && !G.clearT && !G.hold && G.enemies.length && !G.enemies.some((e) => e.alive)) clearWave();
  if (G.clearT > 0 && (G.clearT -= dt) <= 0) { G.clearT = 0; startWave(G.wave + 1); }
}

// ---------- render ----------
function render() {
  if (!cv.width) return;
  const W = view.W, H = view.H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(view.k, 0, 0, view.k, 0, 0);
  if (VFX.scanlines !== scanNow) { scanNow = VFX.scanlines; root.style.setProperty("--inv-scan", scanNow); }
  const sh = G.shake * VFX.shake;
  if (sh > 0.2) ctx.translate(rnd(-1, 1) * sh, rnd(-1, 1) * sh);
  for (const s of G.stars) {   // layer 0 is the classic field; deeper layers are quicker and brighter (era fx.starLayers)
    ctx.fillStyle = s.l ? (s.b ? C.dim : C.faint) : s.b ? C.line : "#2a2724";
    ctx.fillRect(s.x * W, (s.y * H + G.rt * s.s) % H, 1.3 + 0.5 * s.l, 1.3 + 0.5 * s.l);
  }
  if (VFX.grid > 0 && G.state !== "title") drawGrid();
  if (G.state === "title") drawTitle();
  else if (G.state === "board") drawBoard();
  else {
    drawField(); drawHud();
    if (G.state === "over") drawOver();
    else if (G.state === "entry") drawEntry();
    else if (G.intro > 0) drawIntro();
  }
  if (G.state !== "over" && !V.bannerUntil) {
    if ((G.state === "entry" || G.state === "board") && !isFocused()) {
      box([{ t: "[ click here to type ]", c: C.amber }, { t: G.state === "entry" ? "your initials need the keyboard" : "then SPACE carries on", c: C.dim }],
        W / 2, H * 0.9, { center: true, frame: C.dim });
    } else if (G.state === "play" && !isFocused()) {
      box([{ t: "[ paused ]", c: C.amber }, { t: "click here to keep playing", c: C.text },
        { t: "(your typing still goes to the message box)", c: C.dim }], W / 2, H * 0.6, { center: true, frame: C.dim });
    } else if (G.state === "play" && G.paused) {
      drawPixelText("PAUSED", W / 2, H * 0.4, W * 0.4, 6, C.amber, C.orange);
      txt("press P to resume", W / 2, H * 0.4 + 70, C.dim, 12, "center");
    }
  }
  if (V.bannerUntil) drawBanner();
  if (G.glitch > 0.02) glitchPass();
}
let scanNow = 1;   // the scanline strength last pushed to the CSS variable
function drawGrid() {   // era fx.grid: a faint neon grid that slides down
  const W = view.W, H = view.H, step = 36, off = (G.rt * 24) % step;
  ctx.globalAlpha = clamp(VFX.grid, 0, 1) * 0.16; ctx.fillStyle = C.blue;
  for (let x = (W % step) / 2; x < W; x += step) ctx.fillRect(x, 0, 1, H);
  for (let y = off; y < H; y += step) ctx.fillRect(0, y, W, 1);
  ctx.globalAlpha = 1;
}
function glitchPass() {   // the CRT tears at an era change: bands of the finished picture knocked sideways
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = Math.ceil(G.glitch * 10); i > 0; i--) {
    const h = Math.round(rnd(3, 22) * view.k), y = Math.floor(rnd(0, Math.max(1, cv.height - h))), off = Math.round(rnd(-28, 28) * view.k);
    ctx.drawImage(cv, 0, y, cv.width, h, off, y, cv.width, h);
  }
}
function drawField() {
  const W = view.W, P = G.player, frame = G.form.frame;
  drawHook("bg");
  ctx.fillStyle = C.line; ctx.fillRect(0, groundY(), W, 1);
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
    if (e.wait) continue;   // still off screen on its way in
    const T = TYPES[e.type], hurt = e.hp < T.hp, fr = e.free ? Math.floor(G.rt * 3) % 2 : frame, lines = hurt ? (T.hurt || T.frames)[fr] : T.frames[fr], p = epos(e);
    drawSprite(sprite(lines, 12, e.flash > 0 ? "#ffffff" : C[hurt ? "amber" : T.color]), p.x, p.y, hidden(e) ? 0.12 : 1);
  }
  if (G.ufo) drawSprite(sprite(UFO[Math.floor(G.rt * 6) % 2], 12, C.orange2, 7), G.ufo.x, G.ufo.y);
  if (G.boss) drawBoss();
  for (const d of G.drones) drawSprite(sprite([d.label || "[TODO]"], 11, d.drip ? C.green : C[d.color] || C.text), d.x, d.y);
  for (const p of G.powerups) {
    const pw = POWERS[p.type];
    drawSprite(sprite(["[" + (p.label || pw.label) + "]"], 11, C[pw.color], 7), p.x, p.y, 0.65 + 0.35 * Math.sin(G.rt * 10));
  }
  drawHook("world");
  for (const s of G.shots) {
    if (s.draw) { s.draw(s); continue; }
    if (s.hex) { drawSprite(sprite([s.ch], 11, C.blue, 3), s.x - 3.5, s.y, 0.75); continue; }
    const ch = s.vx < -40 ? "\\" : s.vx > 40 ? "/" : "|";
    drawSprite(sprite([ch], 12, s.pierce ? C.red : s.ally ? C.green : C.amber, 6), s.x - 3.5, s.y);
  }
  for (const b of G.ebul) { if (b.draw) b.draw(b); else drawSprite(sprite([b.ch], 12, b.color, 5), b.x - 3.5, b.y); }
  if (VFX.trail > 0 && G.state === "play") G.trail.forEach((t, i) => drawSprite(sprite(["¦"], 12, C.orange, 4), t.x - 3.5, t.y + i * 0.6, 0.6 * (1 - i / G.trail.length)));
  if (G.state === "play" || Math.floor(G.rt * 4) % 2) {
    if (!(P.inv > 0 && !P.noFlicker && Math.floor(G.rt * 14) % 2)) {   // P.skin = { lines, color, glow } replaces the plane's look; P.noFlicker stops the invulnerability blink
      const sk = P.skin;
      drawSprite(sprite(sk && sk.lines || PLAYER, 12, sk && sk.color || (G.fx.coffee > 0 ? C.orange2 : C.orange), sk && sk.glow != null ? sk.glow : 7), P.x, P.y);
    }
  }
  if (G.bubble && G.state === "play") {
    const a = 0.65 + 0.3 * Math.sin(G.rt * 6);
    txt("(", P.x - 8, P.y - 2, C.orange, 22, "left", 6, a); txt(")", P.x + P.w + 1, P.y - 2, C.orange, 22, "left", 6, a);
  }
  if (G.ally) drawSprite(sprite(ALLY, 10, C.green, 5), G.ally.x, G.ally.y);
  if (G.duck) drawSprite(sprite(DUCK, 10, C.amber, 5), G.duck.x, G.duck.y);
  for (const p of G.particles) drawSprite(sprite([p.ch], 10, p.color, 3), p.x, p.y, 1 - p.t / p.life);
  for (const f of G.floaters) txt(f.text, f.x, f.y, f.color, f.size, "center", 5, Math.min(1, 2.2 * (1 - f.t / f.life)));
  drawHook("fg");
}
function drawBoss() {
  const B = G.boss, W = view.W;
  B.def.draw(B);
  // (its hit-point bar is in the HUD's top row)
  const lines = wrap(B.say, 24).map((t) => ({ t, c: C.text }));
  const right = B.x + B.w / 2 < W / 2, cw = charW(11), bw = (Math.max(...lines.map((l) => l.t.length)) + 4) * cw;
  const left = right ? B.x + B.w + 10 : B.x - bw - 10;
  if (left > 2 && left + bw < W - 2) {
    box(lines, 0, 0, { left, top: B.y + 2, size: 11, frame: C.dim });
    txt(right ? "<" : ">", right ? left - 8 : left + bw + 1, B.y + 28, C.dim, 11);
  } else txt(`"${B.say}"`, W / 2, B.y + B.h + 14, C.dim, 11, "center", 2);   // no room beside it (the merge conflict's halves)
}
// The HUD: SCORE / HI / WAVE (+ era badge, or the boss bar on boss waves) / lives on the top row, then the chips (core power-ups and each era's hud(): [text,
// colour, short?, prio?]) in at most two rows below it. They wrap at the field's width; if two rows are not enough the short labels and a smaller font are
// used, and then the lowest-priority chips (prio 0 = informational, 1 default, 2 = power-up timers) are dropped. Boss waves use the small font so the rows end at
// y 35, above the boss's name. core.hudBottom is where the chips end (era 10 hangs its combo under it).
function chipRows(list, size, short) {
  const cw = charW(size), W = view.W, rows = [[]]; let x = 8;
  for (const c of list) {
    const t = short && c[2] != null ? c[2] : c[0], w = [...t].length * cw + 9;
    if (x + w > W - 8 && rows[rows.length - 1].length) { rows.push([]); x = 8; }
    rows[rows.length - 1].push({ t, c: c[1], x }); x += w;
  }
  return rows;
}
function drawHud() {
  const W = view.W, B = G.boss;
  txt(`SCORE ${pad(G.score)}`, 8, 4, C.orange, 11, "left", 4);
  txt(`HI ${pad(G.hi)}`, 118, 4, C.dim, 11);
  txt("✻".repeat(Math.max(0, G.lives)), W - 8, 4, C.orange, 12, "right", 5);
  const wv = `WAVE ${G.wave}`;   // the middle of the top row: the wave, then the era (era 1 is plain) or, in a boss fight, its hit points
  let tail = "", tc = C.dim;
  if (B) { const n = 14, f = clamp(Math.ceil((B.hp / B.max) * n), 0, n); tail = ` [${"#".repeat(f)}${".".repeat(n - f)}]`; tc = C.amber; }
  else if (G.era > 1) tail = `  ERA ${G.era}${W < 640 ? "" : " · " + eraMeta(G.era).year}`;
  const w1 = wv.length * charW(11), w2 = tail.length * charW(9), x0 = W / 2 - (w1 + w2) / 2;
  txt(wv, x0, 4, C.amber, 11, "left", 4);
  if (tail) txt(tail, x0 + w1, 5, tc, 9, "left", B ? 4 : 2);
  const fx = [];
  if (comboLive() && G.combo.n > 1) { const left = 1 - (G.time - G.combo.last) / 1.6, n = 8, f = Math.ceil(left * n); fx.push([`COMBO ${G.combo.n} ×${mult()} [${"=".repeat(f)}${" ".repeat(n - f)}]`, C.amber, `×${mult()} COMBO`, 1]); }
  if (G.fx.refactor > 0) fx.push([`refactor ${Math.ceil(G.fx.refactor)}s`, C.blue, `RFT ${Math.ceil(G.fx.refactor)}`, 2]);
  if (G.fx.coffee > 0) fx.push([`coffee ${Math.ceil(G.fx.coffee)}s`, C.orange2, `CAF ${Math.ceil(G.fx.coffee)}`, 2]);
  if (G.duck) fx.push([`duck ${"♥".repeat(G.duck.hp)}`, C.amber, `DUCK ${G.duck.hp}`, 2]);
  if (G.fx.pierce > 0) fx.push([`sudo ${Math.ceil(G.fx.pierce)}s`, C.red, `SUDO ${Math.ceil(G.fx.pierce)}`, 2]);
  if (G.fx.homing > 0) fx.push([`grep ${Math.ceil(G.fx.homing)}s`, C.blue, `GREP ${Math.ceil(G.fx.homing)}`, 2]);
  if (G.fx.ally > 0) fx.push([`pair ${Math.ceil(G.fx.ally)}s`, C.green, `PAIR ${Math.ceil(G.fx.ally)}`, 2]);
  if (G.fx.slow > 0) fx.push([`sleep ${Math.ceil(G.fx.slow)}s`, C.blue, `ZZZ ${Math.ceil(G.fx.slow)}`, 2]);
  if (G.bubble) fx.push(["firewall", C.orange, "FW", 2]);
  if (G.weapon > 1) fx.push([`weapon v${G.weapon}`, C.amber, `W${G.weapon}`, 2]);
  for (const c of hookCollect("hud")) fx.push(c);   // modules' chips
  const maxRows = 2;
  let size = B ? 9 : 10, short = !!B, rows = chipRows(fx, size, short);
  if (rows.length > maxRows) { size = 9; short = true; rows = chipRows(fx, size, short); }
  while (rows.length > maxRows && fx.length) {   // still too many: the least important go (the last of the lowest priority first)
    let at = 0;
    fx.forEach((c, i) => { if ((c[3] ?? 1) <= (fx[at][3] ?? 1)) at = i; });
    fx.splice(at, 1); rows = chipRows(fx, size, short);
  }
  const y0 = size === 10 ? 17 : 16, pitch = size + 2;
  rows.forEach((row, r) => { for (const c of row) txt(c.t, c.x, y0 + r * pitch, c.c, size, "left", 3); });
  core.hudBottom = y0 + Math.max(1, rows.filter((r) => r.length).length) * pitch;
}
function drawEraIntro(a, y) {   // "1982 · XEVIOUS" and what changes, over the wave title
  const W = view.W, M = eraMeta(G.era), t = G.introMax - G.intro, title = `${M.year} · ${M.name}`;
  const p = pixelText(title, C.amber, C.orange), px = clamp(Math.floor((W * 0.7) / p.w), 2, 4), th = p.h * px;
  const lines = wrap(M.blurb, Math.max(24, Math.floor((W * 0.84) / charW(12)))), top = y - 54, ty = y - 30, by = ty + th + 10;
  ctx.fillStyle = `rgba(11,11,10,${0.88 * a})`; ctx.fillRect(0, top, W, by - top + lines.length * 16 + 34);
  ctx.globalAlpha = a;
  txt(`ERA ${G.era} OF ${ERA_MAX}${G.eraNew ? " · NEW!" : ""}`, W / 2, top + 8, C.dim, 11, "center", 3, a);
  drawPixelText(title, W / 2, ty, W * 0.7, 4, C.amber, C.orange, t < 0.7 ? 0.5 : Math.random() < 0.03 ? 0.2 : 0);
  ctx.globalAlpha = 1;
  let n = Math.floor(t * 70);   // typed out
  lines.forEach((l, i) => { txt(l.slice(0, Math.max(0, n)), W / 2, by + i * 16, C.text, 12, "center", 3, a); n -= l.length; });
  txt(`wave ${G.wave} · ${hash(G.wave)} ${G.commit}`, W / 2, by + lines.length * 16 + 8, C.dim, 10, "center", 0, a);
}
function drawIntro() {
  const W = view.W, H = view.H, a = Math.min(1, G.intro / 0.4), y = H * 0.5;
  if (G.eraIntro) return drawEraIntro(a, y);
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
  let y = Math.max(6, (H - 366 - (wait ? 22 : 0) - (reachedEra() > 1 ? 18 : 0)) / 2);
  if (wait) {   // typed out like a prompt, then a blinking cursor
    const s = "While you wait...", n = Math.min(s.length, Math.floor((G.rt - V.shownAt) * 16)), cw = charW(12);
    const x0 = cx - ((s.length + 3) * cw) / 2;
    txt(">", x0, y, C.orange, 12, "left", 3);
    txt(s.slice(0, n) + (n < s.length || Math.floor(G.rt * 2.5) % 2 ? "▍" : ""), x0 + cw * 2, y, C.dim, 12);
    y += 22;
  }
  y += drawPixelText("BUG INVADERS", cx, y, W * 0.75, 4, C.amber, C.orange) + 4;
  txt(STANDALONE ? "for when the build is taking forever" : `something to shoot at while ${Who()} thinks`, cx, y, C.dim, 12, "center"); y += 20;
  const legend = [["conflict", "merge conflict", "30 · takes two hits"], ["fail", "failing test", "20"], ["nan", "NaN", "20 · wobbly shots"],
    ["todo", "TODO", "10"], ["bug", "bug", "10"], ["heisen", "heisenbug", "40 · blinks out of reach"], ["leak", "memory leak", "15 · drips on death"],
    ["segv", "segfault", "50 · dives at you"], ["ufo", UFO_NAME, "??? · break; it"]];
  const two = W >= 540, colW = 262, lx0 = two ? cx - colW - 6 : cx - 130, rows = two ? 5 : legend.length;
  legend.forEach(([t, name, pts], i) => {
    const col = two ? Math.floor(i / rows) : 0, r = i % rows, x = lx0 + col * (colW + 12), yy = y + r * 27;
    const lines = t === "ufo" ? UFO[Math.floor(G.rt * 6) % 2] : TYPES[t].frames[Math.floor(G.rt * 2) % 2];
    drawSprite(sprite(lines, 12, t === "ufo" ? C.orange2 : C[TYPES[t].color], t === "ufo" ? 6 : 5), x + (t === "ufo" ? -6 : 0), yy);
    txt(name, x + 82, yy + 1, C.text, 11); txt(pts, x + 82, yy + 14, C.dim, 10);
  });
  y += rows * 27 + 8;
  const items = Object.values(POWERS).filter((p) => !p.mod).map((p) => [`[${p.label}]`, C[p.color]]), cw = charW(11);   // (the era pick-ups registered by addPower are not on the title)
  const width = (part) => part.reduce((a, [t]) => a + (t.length + 1) * cw, 0);
  const lines = width(items) > W - 30 ? [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))] : [items];
  for (const part of lines) {
    let x = cx - width(part) / 2;
    for (const [t, c] of part) { txt(t, x, y, c, 11, "left", 4); x += (t.length + 1) * cw; }
    y += 16;
  }
  txt("collect npm update to level up your weapon · beware fake power-ups: their names are spelled with numbers", cx, y, C.faint, 10, "center"); y += 14;
  txt("every 4th wave a boss: five of them in turn, then round again, harder", cx, y, C.faint, 10, "center"); y += 18;
  y += drawEraPicker(cx, y);
  const blink = Math.floor(G.rt * 2.5) % 2 === 0;
  if (isFocused()) txt(STANDALONE ? "press SPACE or tap to start · L: top 10" : "press SPACE to start · L: top 10", cx, y, C.amber, 14, "center", 6, blink ? 1 : 0.35);
  else txt("[ click here to play ]", cx, y, C.amber, 14, "center", 6, blink ? 1 : 0.35);
  txt(STANDALONE ? "←→ move · space fire · try the Konami code" : "the message box keeps the keyboard until you click in · Esc hides", cx, y + 20, C.faint, 11, "center");
}
// ◀ era ▶ : start in any era you have reached (left / right; the touch pad's too). Nothing to pick until you reach era 2.
function drawEraPicker(cx, y) {
  const best = reachedEra();
  if (best < 2) return 0;
  const e = clamp(G.startEra, 1, best), M = eraMeta(e), lo = e > 1, hi = e < best;
  txt(`${lo ? "◀" : " "}  start in era ${e} · ${M.year} ${M.name}  ${hi ? "▶" : " "}`, cx, y, e > 1 ? C.amber : C.dim, 12, "center", e > 1 ? 4 : 0);
  return 18;
}
function drawOver() {
  const W = view.W, H = view.H;
  ctx.fillStyle = "rgba(11,11,10,.72)"; ctx.fillRect(0, 0, W, H);
  let y = H * 0.28;
  y += drawPixelText("GAME OVER", W / 2, y, W * 0.6, 7, C.red, C.orange) + 16;
  txt(G.overReason || "", W / 2, y, C.red, 13, "center", 4); y += 26;
  txt(`score ${G.score}   ·   best ${G.hi}`, W / 2, y, C.text, 12, "center"); y += 18;
  txt(`reached wave ${G.wave}   ·   best combo ${G.combo.best}`, W / 2, y, C.dim, 12, "center"); y += 34;
  const high = !G.scored && qualifies(G.score), blink = Math.floor(G.rt * 2.5) % 2 ? 1 : 0.4;
  if (high) txt("★ a top-10 score ★", W / 2, y - 14, C.green, 13, "center", 5);
  if (G.rt - G.overAt > 0.8) txt(high ? "press SPACE to sign it" : "press SPACE to git reset --hard · L: top 10", W / 2, y + 8, C.amber, 13, "center", 5, blink);
  if (G.rt - G.overAt > 0.8 && !high) drawEraPicker(W / 2, y + 34);
}
// ---------- the leaderboard: top 10 and the initials screen ----------
const scores = () => { const l = store.get("scores", []); return Array.isArray(l) ? l : []; };
const qualifies = (n) => n > 0 && (scores().length < 10 || n > scores()[9].s);
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
G.hi = Math.max(G.hi, scores()[0]?.s || 0);
// ---------- the global board (neilson.co.za): everyone's top 10, shared by this copy and the one on the web page ----------
// Only initials, a score and a wave are sent, with a random player id this browser/app makes for itself. Your best local scores
// are sent once, the first time, so you are on the board from the start; after that each score you sign is sent as you sign it.
// Switch it off with X on the board screen (nothing more is sent; what is already there stays).
const GLOBAL_URL = STANDALONE ? "scores.php" : "https://neilson.co.za/bug-invaders/scores.php";
const GB = { rows: null, state: "idle", at: 0, note: "", noteAt: 0 };   // state: idle | loading | ok | offline
const sharing = () => store.get("share", true) !== false;
function playerId() {
  let id = store.get("pid", "");
  if (!/^[a-f0-9]{24}$/.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");
    store.set("pid", id);
  }
  return id;
}
function gFetch(url, opts) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  return fetch(url, Object.assign({ cache: "no-store", signal: ctl.signal }, opts)).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .finally(() => clearTimeout(timer));
}
function gLoad(force) {
  if (GB.state === "loading" || (!force && GB.state === "ok" && Date.now() - GB.at < 30000)) return;
  GB.state = "loading";
  gFetch(`${GLOBAL_URL}?id=${playerId()}`).then((j) => { GB.rows = j.top || []; GB.state = "ok"; GB.at = Date.now(); })
    .catch(() => { GB.state = GB.rows ? "ok" : "offline"; GB.at = Date.now(); });
}
// send rows (the local score shape: n, s, w, t, c); the answer is the new global top 10. Rows that couldn't go wait for next time.
function gSend(rows) {
  rows = rows.filter((r) => r && !r.c).sort((a, b) => b.s - a.s);   // (best first: a request carries ten at most)
  if (!sharing() || !rows.length) return Promise.resolve(0);
  return gFetch(GLOBAL_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },   // (plain text: no pre-flight from a local page)
    body: JSON.stringify({ id: playerId(), rows: rows.slice(0, 10).map((r) => ({ n: r.n, s: r.s, w: r.w, t: r.t })) }) })
    .then((j) => { GB.rows = j.top || GB.rows; GB.state = "ok"; GB.at = Date.now(); return j.accepted || 0; });
}
function gFlush() {   // the first sync of your local top scores, and any scores that could not be sent when you signed them
  if (!sharing()) return;
  const wait = store.get("pending", []), first = !store.get("synced", false);
  const rows = first ? scores().concat(wait) : wait;
  if (!rows.length) { if (first) store.set("synced", true); return; }
  gSend(rows).then((n) => {
    store.set("synced", true); store.set("pending", []);
    if (first && n > 0) { GB.note = "your best local scores have joined the global board"; GB.noteAt = Date.now(); }
  }).catch(() => {});
}
setTimeout(gFlush, 4000);   // (a few seconds after the page loads, not in its way)
function beginEntry() {
  const last = String(store.get("last", "AAA")).toUpperCase().replace(/[^A-Z0-9]/g, "A").padEnd(3, "A").slice(0, 3);
  G.entry = { c: last.split(""), pos: 0, warn: -9 }; G.state = "entry"; keys.clear();
}
function entryKey(e) {
  const E = G.entry, k = e.key, n = ALPHA.length;
  const cycle = (d) => { E.c[E.pos] = ALPHA[(ALPHA.indexOf(E.c[E.pos]) + d + n) % n]; };
  if (k === "ArrowUp") cycle(1);
  else if (k === "ArrowDown") cycle(-1);
  else if (k === "ArrowLeft") E.pos = Math.max(0, E.pos - 1);
  else if (k === "ArrowRight") E.pos = Math.min(2, E.pos + 1);
  else if (k === "Backspace") { if (E.c[E.pos] === " ") E.pos = Math.max(0, E.pos - 1); E.c[E.pos] = " "; }
  else if (/^[a-z0-9]$/i.test(k)) { E.c[E.pos] = k.toUpperCase(); E.pos = Math.min(2, E.pos + 1); }
  else if (k === "Enter") {
    if (E.c.includes(" ")) { E.warn = G.rt; G.shake = 3; } else submitScore();
  }
  SFX.step(E.pos);
}
function submitScore() {
  const name = G.entry.c.join(""), list = scores();
  const row = { n: name, s: G.score, w: G.wave, t: Date.now(), c: G.cheat ? 1 : 0 };
  store.set("last", name);
  list.push(row); list.sort((a, b) => b.s - a.s || a.t - b.t);
  const top = list.slice(0, 10); store.set("scores", top);
  G.scored = true; G.entry = null; SFX.reply();
  if (sharing() && !row.c) { store.set("pending", (store.get("pending", []) || []).concat(row).slice(-20)); gFlush(); }   // and onto the global board
  G.boardTab = "local";
  openBoard("over", top.indexOf(row));
}
function openBoard(from, rank) {
  G.state = "board"; G.boardFrom = from; G.boardAt = G.rt; G.rank = rank;
  if (from === "title" || rank < 0) G.boardTab = "global";   // asked for it: the global one (your own signed score opens on the local board, at its rank)
  gLoad(true); gFlush();
}
function drawEntry() {
  const W = view.W, H = view.H, cx = W / 2, E = G.entry;
  ctx.fillStyle = "rgba(11,11,10,.84)"; ctx.fillRect(0, 0, W, H);
  let y = Math.max(8, H * 0.1);
  y += drawPixelText("HIGH SCORE", cx, y, W * 0.6, 6, C.amber, C.orange) + 10;
  const rank = scores().filter((r) => r.s >= G.score).length + 1;
  txt(`${G.score} points · wave ${G.wave} · #${rank} on the board`, cx, y, C.text, 13, "center", 3); y += 28;
  txt("sign it with three characters", cx, y, C.dim, 12, "center"); y += 34;
  for (let i = 0; i < 3; i++) {
    const x = cx + (i - 1) * 62, on = i === E.pos, ch = E.c[i] === " " ? "_" : E.c[i];
    txt(ch, x, y, on ? C.amber : C.text, 44, "center", on ? 10 : 3);
    ctx.fillStyle = on ? C.amber : C.dim; ctx.fillRect(x - 20, y + 54, 40, 3);
    if (on) { const b = Math.floor(G.rt * 3) % 2; txt("▲", x, y - 18 - b, C.orange, 12, "center"); txt("▼", x, y + 62 + b, C.orange, 12, "center"); }
  }
  y += 90;
  if (G.rt - E.warn < 1.4) txt("all three, please", cx, y, C.red, 13, "center", 4);
  y += 24;
  txt("↑ ↓ change the letter · ← → move · type to set it · ⌫ clears · ENTER saves", cx, y, C.dim, 11, "center");
}
function drawBoard() {
  const W = view.W, H = view.H, cx = W / 2, global = G.boardTab === "global";
  const list = global ? GB.rows || [] : scores();
  let y = Math.max(6, (H - 360) / 2);
  y += drawPixelText("TOP 10", cx, y, W * 0.4, 5, C.amber, C.orange) + 8;
  txt("LOCAL", cx - 56, y, global ? C.dim : C.amber, 12, "center", global ? 0 : 5);   // the two boards: TAB (or G) switches
  txt("GLOBAL", cx + 56, y, global ? C.amber : C.dim, 12, "center", global ? 5 : 0);
  ctx.fillStyle = C.amber; ctx.fillRect(global ? cx + 56 - 24 : cx - 56 - 20, y + 15, global ? 48 : 40, 2);
  y += 28;
  const x0 = cx - 140;
  txt("RANK  NAME   SCORE    WAVE", x0, y, C.dim, 11); y += 20;
  for (let i = 0; i < 10; i++) {
    const r = list[i], mine = global ? !!(r && r.me) : i === G.rank, blink = mine && !global && Math.floor(G.rt * 3) % 2 === 0;
    const col = mine ? (blink ? C.amber : C.orange2) : r ? (i < 3 ? C.text : C.dim) : C.faint;
    txt(String(i + 1).padStart(2, " ") + ".", x0, y, col, 12, "left", mine ? 5 : 0);
    txt(r ? r.n + (r.c ? "*" : "") : "---", x0 + 52, y, col, 12, "left", mine ? 5 : 0);
    txt(r ? pad(r.s) : "000000", x0 + 108, y, col, 12, "left", mine ? 5 : 0);
    txt(r ? String(r.w) : "-", x0 + 200, y, col, 12, "left");
    y += 20;
  }
  if (global && !list.length) {
    const msg = GB.state === "offline" ? "can't reach the global board" : GB.state === "ok" ? "no scores yet: be the first" : "loading the global board…";
    txt(msg, cx, y - 150, GB.state === "offline" ? C.red : C.dim, 12, "center");
  }
  y += 4;
  if (GB.note && Date.now() - GB.noteAt < 12000) { txt(GB.note, cx, y, C.green, 11, "center", 4); }
  else txt(`TAB: ${global ? "local" : "global"} board · X: sharing ${sharing() ? "on" : "off"}`, cx, y, C.dim, 11, "center");
  y += 20;
  const blink = Math.floor(G.rt * 2.5) % 2 ? 1 : 0.4;
  txt(G.boardFrom === "title" ? "press SPACE to go back" : "press SPACE to play again", cx, y, C.amber, 13, "center", 5, blink);
}
function drawBanner() {
  const W = view.W, H = view.H, p = 1 - (V.bannerUntil - performance.now()) / BANNER_MS;
  ctx.fillStyle = "rgba(11,11,10,.78)"; ctx.fillRect(0, 0, W, H);
  const y = H * 0.32, glitch = p < 0.18 ? 0.5 : Math.random() < 0.04 ? 0.15 : 0;
  const h = drawPixelText("REPLY'S IN", W / 2, y, W * 0.8, 9, C.amber, C.orange, glitch);
  txt(who() + " has answered", W / 2, y + h + 18, C.text, 14, "center", 5);
  const run = G.state === "play" ? `run saved · wave ${G.wave} · ${G.score} pts · back next time ${who()} thinks` : `back next time ${who()} thinks`;
  txt(run, W / 2, y + h + 40, C.dim, 12, "center");
}

// ---------- loop ----------
let raf = 0, last = 0, statusAt = 0;
const isFocused = () => document.activeElement === root || V.forceFocus;
function advance(dt, force) {
  G.rt += dt;
  if (G.state === "over" && !G.scored && !V.bannerUntil && G.rt - G.overAt > 2.2) { if (qualifies(G.score)) beginEntry(); else G.scored = true; }
  if (G.state === "play" && !G.paused && !V.bannerUntil && (force || isFocused())) update(dt);
  G.shake = Math.max(0, G.shake - dt * 28);
  G.glitch = Math.max(0, G.glitch - dt);
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
  if (STANDALONE) { statusEl.textContent = `[ ${G.state === "play" ? `wave ${G.wave}` : "ready"} · hi ${pad(G.hi)} ]`; return; }
  const a = app()?.active, busy = !!a?.busy;
  const t = V.bannerUntil ? "✓ reply's in"
    : busy ? `${SPINNER[Math.floor(G.rt * 8) % SPINNER.length]} ${who()} is working · ${Math.floor((performance.now() - V.busySince) / 1000)}s`
    : who() + " is idle";
  statusEl.textContent = `[ ${t} ]`;
}
const autoOn = () => app()?.settings?.invaders !== false;
const peekOn = () => !STANDALONE && app()?.settings?.invaders_peek !== false;
function paintCtl() {
  btn("peek").textContent = peekOn() ? "[▤ chat]" : "[  chat]";
  btn("peek").title = peekOn() ? `A strip of the chat shows under the game (${Who()}'s latest). Click to hide it.` : "Click to show a strip of the chat under the game.";
  btn("sound").textContent = soundOn ? "[♪ on]" : "[♪ off]";
  btn("sound").title = "Sound (M): quiet beeps";
  btn("auto").textContent = autoOn() ? "[✓ auto-pop]" : "[  auto-pop]";
  btn("auto").title = autoOn() ? `Pops up by itself while ${Who()} works on a reply. Click so it doesn't.`
    : `Only opens when you ask for it. Click to let it pop up while ${Who()} works.`;
}

// ---------- keys: only while the game has focus; game keys never reach the app (Esc there would stop Claude) ----------
const keys = new Set();
// Space fires; up / down move (era 3+; ignored before). Both cases of every letter, so Shift can't leave a key stuck down.
// x / Shift = roll (era 4+), but on the board screen X still toggles sharing. Eras add their own keys through `keys` (mergeKeys).
const KEYMAP = { ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right", ArrowUp: "up", w: "up", W: "up",
  ArrowDown: "down", s: "down", S: "down", " ": "fire", Enter: "start", p: "pause", P: "pause", m: "mute", M: "mute", l: "scores", L: "scores",
  Tab: "tab", g: "tab", G: "tab", z: "bomb", Z: "bomb", x: "roll", X: "roll", Shift: "roll" };
const BUILTIN_ACTIONS = new Set(["left", "right", "up", "down", "fire", "bomb", "roll", "start", "pause", "mute", "scores", "tab"]);
// Easter eggs: the Konami code, and a few words typed while playing
let typed = "", seq = [];
const KONAMI = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];
const EGG_WORDS = {
  sudo() {
    if (G.sudoWave === G.wave) return float("sudo: not in the sudoers file. This incident will be reported.", view.W / 2, view.H * 0.5, C.red, 12, 2.4);
    G.sudoWave = G.wave; G.cheat = true; G.fx.pierce = Math.max(G.fx.pierce, 10); SFX.power();
    float("sudo: you are root now", view.W / 2, view.H * 0.5, C.red, 14, 2);
  },
  xyzzy() { addScore(1); float("Nothing happens.", view.W / 2, view.H * 0.5, C.dim, 13, 2); },
  quack() { if (!G.duck) applyPower("duck"); },
  clippy() {
    float("It looks like you're cheating. Need help?", view.W / 2, view.H * 0.5, C.amber, 13, 2.4);
    const m = measure(["[TODO]"], 11);
    for (let i = 0; i < 3; i++) G.drones.push({ x: view.W * (0.25 + 0.25 * i) - m.w / 2, y: 30, w: m.w, h: m.h, seed: Math.random() * 6 });
  },
  idkfa() { float("wrong game. Try the other one.", view.W / 2, view.H * 0.5, C.dim, 13, 2); },
};
function eggKey(e) {
  if (G.state !== "play") return;
  const k = e.key.toLowerCase();
  seq.push(k); if (seq.length > 10) seq.shift();
  if (k.length === 1) typed = (typed + k).slice(-8);
  if (seq.length === 10 && seq.every((x, i) => x === KONAMI[i]) && !G.konami) {
    G.konami = G.cheat = true; G.weapon = 4; G.bubble = true; G.lives = MAX_LIVES; G.fx.pierce = 15; G.fx.homing = 15; SFX.reply();
    float("↑↑↓↓←→←→BA  30 lives!", view.W / 2, view.H * 0.45, C.amber, 16, 2.4);
    float("(all right, five. And every upgrade.)", view.W / 2, view.H * 0.45 + 20, C.dim, 11, 2.4);
    seq = [];
  }
  for (const [w, fn] of Object.entries(EGG_WORDS)) if (typed.endsWith(w)) { typed = ""; fn(); }
}
const actionOf = (e) => (G.state === "board" && (e.key === "x" || e.key === "X") ? "share" : KEYMAP[e.key]);   // (X toggles sharing on the board)
root.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;   // the app's shortcuts keep working
  if (e.key === "Escape") { if (STANDALONE) return; e.preventDefault(); e.stopPropagation(); hideNow(true); return; }
  if (G.state === "entry" && e.target === root && !V.bannerUntil) { e.preventDefault(); e.stopPropagation(); entryKey(e); return; }
  if (e.target === root && !e.repeat) eggKey(e);
  const k = actionOf(e);
  if (!k || e.target !== root) return;
  e.preventDefault(); e.stopPropagation();
  keyDown(k, e.repeat);
});
root.addEventListener("keyup", (e) => {
  const k = actionOf(e);
  if (!k) return;
  keyUp(k);
  if (e.target === root) { e.preventDefault(); e.stopPropagation(); }
});
root.addEventListener("blur", () => keys.clear());
function keyDown(k, repeat) { keys.add(k); if (!repeat) press(k); }
function keyUp(k) { if (keys.delete(k) && G.state === "play" && !G.paused && !V.bannerUntil) hook("onKey", k, false); }
function eraStep(d) {
  const e = clamp(G.startEra + d, 1, reachedEra());
  if (e !== G.startEra) { G.startEra = e; SFX.step(e); }
}
function press(k) {
  if (V.bannerUntil) return;
  if (k === "mute") return toggleSound();
  if (G.state === "board") {
    if (k === "tab") { G.boardTab = G.boardTab === "global" ? "local" : "global"; if (G.boardTab === "global") gLoad(false); return; }
    if (k === "share") { store.set("share", !sharing()); if (sharing()) gFlush(); return; }
    if ((k === "fire" || k === "start" || k === "scores") && G.rt - G.boardAt > 0.4) {
      if (G.boardFrom === "title") G.state = "title";
      else if (!G.scored && qualifies(G.score)) beginEntry();
      else newGame();
    }
    return;
  }
  if (G.state === "title") {
    if (k === "scores") openBoard("title", -1);
    else if (k === "left" || k === "right") eraStep(k === "left" ? -1 : 1);
    else if (k === "fire" || k === "start") newGame();
    return;
  }
  if (G.state === "over") {
    if (G.rt - G.overAt <= 0.8) return;
    if (k === "left" || k === "right") return eraStep(k === "left" ? -1 : 1);
    if (k === "scores") openBoard("over", -1);
    else if (k === "fire" || k === "start") { if (!G.scored && qualifies(G.score)) beginEntry(); else newGame(); }
    return;
  }
  if (G.state === "entry") return;
  if (k === "pause") G.paused = !G.paused;
  else if (G.paused && (k === "fire" || k === "start")) G.paused = false;
  else if (!G.paused && G.intro <= 0) {   // the era hooks: bomb / roll only once the era has them, other keys as plain events
    if (k === "bomb" && caps.bomb) hook("onBomb");
    else if (k === "roll" && caps.roll) hook("onRoll");
    else if (!BUILTIN_ACTIONS.has(k)) hook("onAction", k);
    hook("onKey", k, true);
  }
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
  bannerTimer: 0, resume: false, pendingAt: 0, forceFocus: STANDALONE, shownAt: 0 };
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
if (!STANDALONE) setInterval(poll, POLL_MS);
const tr = q("#transcript");
if (tr && window.ResizeObserver) new ResizeObserver(() => { if (V.visible) layout(); }).observe(tr);
window.addEventListener("resize", () => { if (V.visible) layout(); });

// The [👾] button in the composer's row (index.html) opens and closes it.
const openBtn = q("#invadersBtn");
if (openBtn) {
  openBtn.addEventListener("mousedown", (e) => e.preventDefault());   // so hiding still hands the keyboard back to the message box
  openBtn.addEventListener("click", () => window.invaders.toggle());
}

// ---------- era framework: hooks, registry, paths, the core object ----------
// A module is { n, year, name, blurb, init(core) -> hooks, keys?, caps?, fx?, hints?, replaceFormation? }; `hooks` are the functions it returns
// (onNewGame, onWave, onInert, update, draw, onFire, onBomb, onRoll, onKill, onPlayerHit, onPlayerDied, onEnemyBullet, onKey, onAction, hud).
// A hook that throws is logged once and its whole module is switched off, so one bad era can't freeze the loop.
const warned = new Set();
function call1(m, name, ...a) {
  const fn = m.hooks[name];
  if (!fn || m.dead) return undefined;
  try { return fn.apply(m.hooks, a); } catch (err) {
    m.dead = true; ACTIVE = ACTIVE.filter((x) => x !== m);
    if (!warned.has(m.id + name)) { warned.add(m.id + name); console.error(`[invaders] era ${m.n} ${name} threw; that module is off:`, err); }
    return undefined;
  }
}
function hook(name, ...a) { for (const m of ACTIVE) call1(m, name, ...a); }   // lowest era first
function hookClaim(name, ...a) {   // highest era first; the first one to return true has handled it
  const list = ACTIVE;
  for (let i = list.length - 1; i >= 0; i--) if (call1(list[i], name, ...a) === true) return true;
  return false;
}
// Fire: EVERY active module's onFire runs on a fire event (lowest era first); a `true` only stops the core's own default shot, never another
// module's hook. A module with `exclusiveFire: true` keeps the old claim rule: it runs first (highest era first among those), and its `true`
// ends the event: nothing else runs, no default shot. Returns true when the core's default shot is to be skipped.
function fireHooks() {
  const list = ACTIVE;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].exclusiveFire && call1(list[i], "onFire") === true) return true;
  let claimed = false;
  for (const m of list) if (!m.exclusiveFire && call1(m, "onFire") === true) claimed = true;
  return claimed;
}
function hookCollect(name) { const out = []; for (const m of ACTIVE) { const r = call1(m, name); if (Array.isArray(r)) out.push(...r); } return out; }
function drawHook(layer) {   // each module draws inside its own save / restore, so none can leave alpha or shadow behind
  for (const m of ACTIVE) {
    if (!m.hooks.draw || m.dead) continue;
    ctx.save(); call1(m, "draw", layer); ctx.restore();
  }
}
const eraMeta = (n) => ERA_META[clamp(n | 0, 1, ERA_MAX)];
const reachedEra = () => clamp(Math.floor(Number(store.get("era", 1))) || 1, 1, ERA_MAX);   // the best era you have reached (title select)
function syncStars() {   // fx.starLayers: 48 stars per layer, deeper layers drift faster
  const want = 48 * Math.max(1, Math.round(VFX.starLayers));
  if (G.stars.length > want) G.stars.length = want;
  while (G.stars.length < want) { const l = Math.floor(G.stars.length / 48); G.stars.push({ x: Math.random(), y: Math.random(), s: rnd(3, 16) * (1 + l * 1.3), b: Math.random() < 0.25, l }); }
}
// The key hint line under the cabinet: only the keys of the eras reached, most important first, and whatever does not fit the width left beside the status
// text is dropped from the end (the last to go: move, fire, then the newest era's keys). Narrow (a chat under 640 px): the era keys as letters first ("Z X C F B H V N").
function paintKeys() {
  const all = [caps.bomb && "Z bomb", caps.roll && "X roll"].concat(...ACTIVE.map((m) => m.hints)).filter(Boolean);   // (ascending era)
  const letters = all.filter((h) => /^[A-Z] /.test(h)), others = all.filter((h) => !/^[A-Z] /.test(h)).reverse();   // single keys first; "hold fire: focus", "mouse aim" go before the common keys
  const narrow = root.classList.contains("narrow");
  const list = narrow ? [letters.map((h) => h[0]).join(" "), caps.move2d ? "←→↑↓" : "←→", "space", "P M"]
    : [caps.move2d ? "←→↑↓ move" : "←→ move", "space fire", ...letters, ...others, "P pause", "M sound", "L scores", ...(STANDALONE ? [] : ["Esc hide"])];
  const cs = getComputedStyle(keysEl); mctx.font = cs.font || `15px ${C.mono}`;
  const cw = mctx.measureText("M").width || 8, room = Math.floor((root.clientWidth - statusEl.offsetWidth) / cw) - 9;   // (the status text grows as the seconds tick)
  const text = () => `[ ${list.filter(Boolean).join(narrow ? " " : " · ")} ]`;
  const keep = narrow ? 0 : 2 + letters.length;   // the era's own keys outlast P / M / L / Esc: when only they are left, squeeze them to bare letters first
  while (list.length > keep && text().length > room) list.pop();
  if (!narrow && text().length > room) list.splice(0, list.length, caps.move2d ? "←→↑↓" : "←→", "space", letters.map((h) => h[0]).join(" "));
  while (list.length > 1 && text().length > room) list.pop();
  keysEl.textContent = text(); keysEl.hidden = !root.clientWidth || text().length > room;
}
function paintPad() {   // the standalone page's touch pad shows up / down / bomb / roll only in eras that have them (CSS keys off these attributes)
  if (!padEl) return;
  padEl.dataset.era = G.era;
  for (const k of ["move2d", "bomb", "roll"]) padEl.toggleAttribute("data-" + k, !!caps[k]);
}
// Rebuild caps and fx for this era from the tables, then every reached module's own declarations on top. Runs every wave.
function applyEra(e) {
  const up = e !== G.era;
  G.era = e; G.eraNew = up && !G.debugEra && e > reachedEra();
  ACTIVE = MODS.filter((m) => m.n <= e && !m.dead);
  for (const m of MODS) {   // an era that was on and is now left behind (a debug jump down the ladder) hears it once
    if (m.live && !ACTIVE.includes(m)) { m.live = false; call1(m, "onInert"); }
    else if (ACTIVE.includes(m)) m.live = true;
  }
  for (const k of Object.keys(caps)) delete caps[k];
  for (const k of Object.keys(VFX)) delete VFX[k];
  Object.assign(caps, CAPS_DEFAULT); Object.assign(VFX, FX_DEFAULT);
  for (let i = 1; i <= e; i++) Object.assign(caps, ERA_CAPS[i]);
  for (const m of ACTIVE) { Object.assign(caps, m.caps); Object.assign(VFX, m.fx); }
  if (G.eraNew) store.set("era", e);   // (the debug jump never records)
  syncStars(); paintKeys(); paintPad(); publishActions();
}
// Touch-pad actions: each era action (declared through a module's `keys`) that has a label gets a button on the host page's pad. The label is
// `keys: { meter: { keys: ["c"], label: "METER" } }`, or `padLabels: { meter: "METER" }` on the module (or its hooks), or the built-in name below
// for the nine actions the shipped eras use; an action with none of these (era 10's aim keys) gets no button. `pad: false` / label "" hides one.
// publishActions() hands the list for the eras reached to the host: window.invaders.onActions(list) (set it any time: it is called at once with
// the current list), a CustomEvent "invaders:actions" on window (detail = list) and #pad's data-actions attribute. Each entry is
// { action, label, key }; buttons call window.invaders.input(action, down).
const PAD_LABELS = { meter: "METER", force: "FORCE", screenbomb: "SCR-BOMB", hyper: "HYPER", polarity: "FLIP", release: "RELEASE" };
function padSpec(m, hooks) {
  const spec = m.keys || hooks.keys || {}, labels = { ...hooks.padLabels, ...m.padLabels }, out = [];
  for (const [action, v] of Object.entries(spec)) {
    const obj = v && !Array.isArray(v) ? v : null, list = Array.isArray(v) ? v : (obj && obj.keys) || [];
    const label = obj && obj.label != null ? obj.label : labels[action] ?? PAD_LABELS[action];
    if (!label || (obj && obj.pad === false)) continue;
    out.push({ action, label: String(label), key: list[0] && list[0].length === 1 ? list[0].toUpperCase() : list[0] || "" });
  }
  return out;
}
let actionList = [], actionJson = "[]", hostActions = null;
function publishActions() {
  const seen = new Set(), list = [];
  for (const m of ACTIVE) for (const a of m.pad) if (!seen.has(a.action)) { seen.add(a.action); list.push({ ...a }); }
  const json = JSON.stringify(list);
  if (json === actionJson) return;   // (runs every wave: only a change is news)
  actionJson = json; actionList = list;
  if (padEl) padEl.dataset.actions = list.map((a) => a.action).join(" ");
  tellHost();
}
function tellHost() {
  const list = actionList.map((a) => ({ ...a }));
  try { window.dispatchEvent(new CustomEvent("invaders:actions", { detail: list })); } catch (_) { /* no CustomEvent */ }
  if (typeof hostActions === "function") try { hostActions(list); } catch (err) { console.error("[invaders] onActions threw:", err); }
}
const KEY_NAMES = { shift: "Shift", space: " ", enter: "Enter", tab: "Tab", arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown" };
function mergeKeys(spec) {   // { action: ["z", "shift", ...] } into KEYMAP; a key a core action already owns is never taken over
  for (const [action, v] of Object.entries(spec || {})) {
    const list = Array.isArray(v) ? v : (v && v.keys) || [];   // an array of keys, or { keys: [...], label: "C" } (the label names the touch button)
    for (const raw of list) {
      for (const k of raw.length === 1 ? [raw.toLowerCase(), raw.toUpperCase()] : [KEY_NAMES[raw.toLowerCase()] || raw]) {
        if (k === "Escape" || (KEYMAP[k] && KEYMAP[k] !== action)) { console.warn(`[invaders] key ${k} is already ${KEYMAP[k] || "reserved"}; not mapped to ${action}`); continue; }
        KEYMAP[k] = action;
      }
    }
  }
}

// Enemies that are not part of the grid: free (their own x / y, top-left), temp (spawned by a module, pruned when dead). A bug may also fly
// a path (e.path, from core.paths): the core moves it, hides it until its delay is over and calls e.onEnd(e) when the path ends
// (no onEnd: it flies off, no points, no penalty). e.shoot (seconds) makes it fire aimed shots on its way down.
function spawnEnemy(type, x, y, o = {}) {
  const T = TYPES[type], m = measure(T.frames[0], 12);
  const e = { type, col: 0, ox: 0, oy: 0, w: m.w, h: m.h, hp: T.hp, alive: true, flash: 0, free: true, temp: true, x, y, ...o };
  G.enemies.push(e);
  return e;
}
function updatePathEnemies(dt) {
  const sdt = dt * (G.fx.slow > 0 ? 0.4 : 1);
  for (const e of G.enemies) {
    if (!e.alive || !e.path) continue;
    e.pt += sdt;
    if (e.pt < 0) { e.wait = !!e.hide; continue; }
    e.wait = false;
    if (e.pt >= e.path.dur) { if (e.onEnd) e.onEnd(e); else { e.alive = false; e.gone = true; } continue; }
    const p = e.path.at(e.pt);
    e.x = p.x - e.w / 2; e.y = p.y - e.h / 2; e.heading = p.a;
    if (e.shoot && (e.shootT -= sdt) <= 0) {
      e.shootT = e.shoot * rnd(0.7, 1.3);
      if (e.y > 0 && e.y < view.H * 0.65) { const T = TYPES[e.type]; aimedShot(e.x + e.w / 2, e.y + e.h, Math.min(250, 130 + 10 * G.wave), T.shot, C[T.color], 0, e); }
    }
  }
}
// Flight paths: { kind, dur, at(t) -> { x, y, a } }, the CENTRE of whatever flies and its heading (radians, 0 = right, PI/2 = down), in
// view coordinates. at() is pure for every kind but "dive" (it steers on the live plane, so call it with rising t). Past `dur` the path is over.
const paths = (() => {
  const PI2 = Math.PI * 2, mk = (kind, dur, at) => ({ kind, dur, at });
  const exitDur = (y, vy) => Math.max(0.1, (view.H + 40 - y) / vy);   // time to fly off the bottom
  return {
    line({ x = view.W / 2, y = -20, vx = 0, vy = 100, dur } = {}) { return mk("line", dur ?? exitDur(y, vy), (t) => ({ x: x + vx * t, y: y + vy * t, a: Math.atan2(vy, vx) })); },
    // straight down with a sideways wave
    sine({ x = view.W / 2, y = -20, vy = 90, amp = 60, freq = 1.6, phase = 0, dur } = {}) {
      return mk("sine", dur ?? exitDur(y, vy), (t) => ({ x: x + amp * Math.sin(t * freq + phase), y: y + vy * t, a: Math.atan2(vy, amp * freq * Math.cos(t * freq + phase)) }));
    },
    // down `lead` px, one full loop-the-loop (radius r, turning toward dir = 1 right / -1 left), then on down
    loop({ x = view.W / 2, y = -20, dir = 1, vy = 110, r = 42, lead = 120 } = {}) {
      const ta = lead / vy, w = vy / r, tc = PI2 / w, y1 = y + lead, dur = ta + tc + exitDur(y1, vy);
      return mk("loop", dur, (t) => {
        if (t < ta) return { x, y: y + vy * t, a: Math.PI / 2 };
        if (t >= ta + tc) return { x, y: y1 + vy * (t - ta - tc), a: Math.PI / 2 };
        const f = Math.PI - w * (t - ta);
        return { x: x + dir * r + dir * r * Math.cos(f), y: y1 + r * Math.sin(f), a: Math.atan2(-Math.cos(f), dir * Math.sin(f)) };
      });
    },
    // a quadratic curve from -> via -> to over dur seconds (defaults: in from the side, down to the plane's height, out the far side)
    swoop({ side = 1, from, via, to, dur = 3.2 } = {}) {
      const W = view.W, sx = side > 0 ? -30 : W + 30;
      from = from || { x: sx, y: 40 }; via = via || { x: W / 2 + side * W * 0.1, y: G.player.y }; to = to || { x: W - sx, y: 60 };
      return mk("swoop", dur, (t) => {
        const u = clamp(t / dur, 0, 1), v = 1 - u;
        return { x: v * v * from.x + 2 * v * u * via.x + u * u * to.x, y: v * v * from.y + 2 * v * u * via.y + u * u * to.y,
          a: Math.atan2(2 * v * (via.y - from.y) + 2 * u * (to.y - via.y), 2 * v * (via.x - from.x) + 2 * u * (to.x - via.x)) };
      });
    },
    // n paths (an array) flying down in a V: the middle one leads, the wings fan out as they come
    vee(n, { x = view.W / 2, y = -20, vy = 100, dx = 34, dy = 26, spread = 0.25 } = {}) {
      return Array.from({ length: n }, (_, i) => {
        const k = i - (n - 1) / 2, y0 = y - Math.abs(k) * dy;
        return mk("vee", exitDur(y0, vy), (t) => ({ x: x + k * dx * (1 + spread * t), y: y0 + vy * t, a: Math.PI / 2 }));
      });
    },
    // from (x, y) down at vy, steering toward the plane's x (up to `turn` px/s) until it is within `lock` px above it, then straight on
    dive({ x, y = -20, vy = 150, turn = 180, wobble = 30, lock = 110, dur } = {}) {
      let px = x, py = y, lt = 0; const seed = Math.random() * 6;
      return mk("dive", dur ?? exitDur(y, vy), (t) => {
        const dt = Math.max(0, t - lt), P = G.player; lt = t;
        py += vy * dt;
        if (py < P.y - lock) px = clamp(px + clamp(P.x + P.w / 2 - px, -turn * dt, turn * dt), 2, view.W - 2);
        return { x: px + Math.sin(t * 4 + seed) * wobble, y: py, a: Math.PI / 2 };
      });
    },
    // put an existing bug (a formation member peeling off, say) on a path; its own spot is where it starts
    attach(e, path, o = {}) {
      const p = epos(e);
      Object.assign(e, { free: true, x: p.x, y: p.y, path, pt: -(o.delay || 0), hide: !!o.hide, shoot: o.shoot || 0, shootT: (o.shoot || 0) * rnd(0.5, 1.3), onEnd: o.onEnd });
      return e;
    },
    // give a peeled-off member back to the formation (use as onEnd: it is back in its old place and marches on)
    release(e) { e.free = false; e.path = null; e.wait = false; e.shoot = 0; return e; },
    // a new bug that flies the path: fly("segv", paths.sine({ x: 100 }), { delay: 0.6, shoot: 1.8, onEnd })
    fly(type, path, o = {}) { return paths.attach(spawnEnemy(type, -99, -99, { wait: !!(o.delay > 0), ...o.extra }), path, { hide: true, ...o }); },
  };
})();

function addType(id, def) {   // a new enemy type: frames [[l1, l2], [l1, l2]] like the built-ins; hurt defaults to frames
  return (TYPES[id] = { hurt: def.frames, color: "text", pts: 10, hp: 1, die: "DONE ✓", dieColor: "green", shot: "*", rank: 9, name: id, ...def, mod: true });
}
function addPower(id, def) {   // a new power-up: { label, color, drop (weight in the drop pool, 0 = never drops by itself), era, apply(core, P) }
  return (POWERS[id] = { label: id, color: "text", drop: 0, era: 1, ...def, mod: true });
}
// What an era module gets. Everything here is live (read it each time, never cache G.enemies / G.shots / G.ebul / G.drones / G.powerups: the
// core replaces those arrays every frame). core.G.fx is the power-up timers; core.fx is the visual knobs (the two are not the same).
const core = {
  G, view, C, keys, store, caps, fx: VFX, TYPES, POWERS, SFX, paths, canvas: cv, ctx,   // ctx: the 2D context the core draws with (draw hooks run inside its save / restore)
  rnd, pick, clamp, lerp, overlap, pad, wrap, charW, measure, sprite, drawSprite, txt, box, bigText: drawPixelText, pixelText,
  burst, float, addScore, comboHit, mult, kill, epos, dropPower, applyPower, playerHit, gameOver, clearWave, fire, beep, later,
  eraOf, waveOfEra, addType, addPower, spawnEnemy, bulletBox, bodyBox,
  // Weapon composition (every wave starts as "core": fire() is the whole gun). The module that owns the PRIMARY shot sets these from onWave:
  // primary = "core" | "gradius" | "raiden"; primaryShot(x, y, mini) fires it from (x, y) and returns false when it could not (mini = an option's
  // smaller copy); primaryHoming = it already homes (missiles then stay home); charging = a hold has taken the button (no primary, no extras).
  // Era 5's onFire is the composer: primary at the plane, a copy from each option, missiles. shotRoom(n): is there room for n more player shots?
  hudBottom: 40,   // y where the HUD's chip rows end (read it each frame)
  primary: "core", primaryShot: null, primaryHoming: false, charging: false, fireStamp: -1,
  shotRoom(n = 1) { return G.shots.length + n <= 64; },
  enemyShot(x, y, vx, vy, ch, color, extra) { return pushEbul({ x, y, vx, vy, ch, color, seed: Math.random() * 6, ...extra }, extra && extra.src); },   // one enemy bullet (extra: draw, pol, solid, r | w, h, src ...)
  aimedShot, drone: minion,   // aimedShot(x, y, speed, ch, color, spread, src); drone(label, x, y, { die, color, vy }): a shootable falling label
  playerShot(o) {   // one player shot: { x, y, vx, vy, w, h, dmg, pierce, ally, life, draw(s) }; defaults to a plain 2x10 bolt going up
    const sh = { x: 0, y: 0, vx: 0, vy: -440, pierce: false, hit: null, hex: false, ch: "", ...o };
    if (sh.pierce && !sh.hit) sh.hit = new Set();
    G.shots.push(sh); return sh;
  },
  // Damage the current boss by dmg through its own rules (its def.hit, as if a shot of that damage landed at x, y; default: the boss's weak
  // spot, def.aim or the middle of it). Returns true if it took the hit (the ring of the loop boss, a shielded dependency... can refuse).
  hurtBoss(dmg = 1, x, y) {
    const B = G.boss;
    if (!B || G.state !== "play") return false;
    if (x == null || y == null) { const t = B.def.aim ? B.def.aim(B, { x: B.x + B.w / 2, y: B.y + B.h / 2 }) : { x: B.x + B.w / 2, y: B.y + B.h / 2 }; x = t.x; y = t.y; }
    hitDmg = dmg;
    try { return !!B.def.hit(B, { x, y: y - 4, w: 2, h: 10, dmg }); } finally { hitDmg = 1; }
  },
  toView(clientX, clientY) { const r = cv.getBoundingClientRect(); return { x: ((clientX - r.left) / r.width) * view.W, y: ((clientY - r.top) / r.height) * view.H }; },
  get era() { return G.era; },
  get ground() { return groundY(); },   // the drawn ground line
  get bottomY() { return bottomY(); },  // top of the plane on the bottom row = the deadline (bugs below it ship) = flightBottom
  get flightTop() { return flightTop(); }, get flightBottom() { return bottomY(); },   // the plane's y range (top-left of the plane)
};
let modId = 0;
function addEra(m) {
  if (!m || !(m.n >= 1 && m.n <= ERA_MAX)) { console.error("[invaders] not an era module (needs n 1..10):", m); return false; }
  let hooks;
  try { hooks = (typeof m.init === "function" ? m.init(core) : m.hooks) || {}; } catch (err) { console.error(`[invaders] era ${m.n} init threw; skipped:`, err); return false; }
  const mod = { id: ++modId, n: m.n | 0, hooks, caps: m.caps || hooks.caps, fx: m.fx || hooks.fx, hints: m.hints || hooks.hints || [],
    replaceFormation: m.replaceFormation, dead: false, live: false, exclusiveFire: !!(m.exclusiveFire ?? hooks.exclusiveFire), pad: padSpec(m, hooks) };
  mergeKeys(m.keys || hooks.keys);
  for (const k of ["year", "name", "blurb"]) if (m[k] != null) ERA_META[mod.n] = { ...ERA_META[mod.n], [k]: m[k] };
  MODS.push(mod); MODS.sort((a, b) => a.n - b.n || a.id - b.id);
  if (G.era) applyEra(G.era);   // (added while running, in a test)
  return true;
}
if (Array.isArray(window.INVADERS_ERAS)) window.INVADERS_ERAS.forEach(addEra);
applyEra(1);

window.invaders = {
  // A menu item, say: open it now (and take the keyboard, since you asked for it). Not over a card waiting on you.
  show() {
    if (pendingCard()) { if (typeof toast === "function") toast(`${Who()} is waiting on you first.`); return false; }
    V.resume = false;
    return V.visible ? (root.focus({ preventScroll: true }), true) : showNow(true, true);
  },
  hide() { if (V.visible) hideNow(true); },
  // Options > Arcade: send your scores to the global board (on unless you switch it off)
  sharing: () => sharing(),
  toggleShare() { store.set("share", !sharing()); if (sharing()) gFlush(); return sharing(); },
  // touch buttons (standalone pages): input("left", true) on press, input("left", false) on release;
  // keys: left, right, up, down, fire, bomb, roll, pause (up / down / bomb / roll only act in the eras that have them)
  // any registered action name works too (meter, force, screenbomb, hyper, polarity, release ...): see window.invaders.actions
  input(k, down) { if (down) { keys.add(k); press(k); } else keyUp(k); },
  // the era actions reached so far, [{ action, label, key }]: a host page builds extra touch buttons from them. Assign onActions = fn(list) to hear
  // every change (it is called once straight away); the same list goes out as a window "invaders:actions" CustomEvent and on #pad[data-actions].
  get actions() { return actionList.map((a) => ({ ...a })); },
  get onActions() { return hostActions; },
  set onActions(fn) { hostActions = typeof fn === "function" ? fn : null; if (hostActions) try { hostActions(actionList.map((a) => ({ ...a }))); } catch (err) { console.error("[invaders] onActions threw:", err); } },
  toggle() { return V.visible ? this.hide() : this.show(); },
  get visible() { return V.visible; },
  // for tests: drive the game without real time or focus
  _debug: {
    G, V, view, keys, poll, render, newGame, startWave, applyPower, dropPower, gameOver, BOSSES, bossKind, bossPass, core, caps, eraOf, waveOfEra, addEra,
    mods: () => MODS.map((m) => ({ era: m.n, id: m.id, name: ERA_META[m.n].name, dead: m.dead, active: ACTIVE.includes(m), pad: m.pad, exclusiveFire: m.exclusiveFire })),
    deadMods: () => MODS.filter((m) => m.dead).map((m) => m.n),   // the modules the throw guard has switched off
    startEra(n) { newGame(n, true); },   // straight into era n (its first wave), without recording it as reached
    step(sec) { for (let t = 0; t < sec; t += 1 / 60) advance(1 / 60, true); render(); paintStatus(); },
  },
};
})();
