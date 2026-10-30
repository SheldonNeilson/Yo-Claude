// Yo Claude's face: a 3D head rendered to ASCII live (ray-marched signed-distance shapes, lit and shaded with
// denser and lighter characters, in colour). She's never quite still: she looks around, blinks, tilts her head and
// changes expression, and follows the voice: talking (her mouth follows the loudness), listening, thinking, using
// the PC, asking you something, asleep when the wake word is off.
"use strict";
// Drawn as half blocks: each character cell is two square pixels (top and bottom half), the old ANSI-art way. 56 x 36 cells = 56 x 72 pixels.
const AV = { cols: 56, rows: 36, x0: -0.7, x1: 0.7, y0: 0.74 };
AV.px = (AV.x1 - AV.x0) / AV.cols;

// ---- shapes ----
const hyp = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
function ell(x, y, z, a, b, c) {   // ellipsoid (approximate distance)
  const k0 = hyp(x / a, y / b, z / c), k1 = hyp(x / (a * a), y / (b * b), z / (c * c));
  return k1 < 1e-9 ? -Math.min(a, b, c) : k0 * (k0 - 1) / k1;
}
const sph = (x, y, z, r) => hyp(x, y, z) - r;
function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
const smax = (a, b, k) => -smin(-a, -b, k);
function capsule(x, y, z, ax, ay, az, bx, by, bz, r) {
  const px = x - ax, py = y - ay, pz = z - az, vx = bx - ax, vy = by - ay, vz = bz - az;
  const h = Math.max(0, Math.min(1, (px * vx + py * vy + pz * vz) / (vx * vx + vy * vy + vz * vz)));
  return hyp(px - vx * h, py - vy * h, pz - vz * h) - r;
}

// The scene. P: pose and expression. When `m` is given, it's filled with which part was hit and where (head space).
const PIVOT = -0.38;   // the head turns around the top of the neck
function scene(x, y, z, P, m) {
  // body (doesn't turn with the head)
  const body = smin(capsule(x, y, z, 0, -0.40, -0.06, 0, -1.0, -0.06, 0.145), ell(x, y + 1.25, z + 0.05, 0.62, 0.3, 0.3), 0.14);
  // head space: undo the head's turn (yaw, then pitch, then roll) around the pivot
  let hx = x, hy = y - PIVOT, hz = z;
  let t = hx * P.cy - hz * P.sy; hz = hx * P.sy + hz * P.cy; hx = t;            // yaw
  t = hy * P.cp - hz * P.sp; hz = hy * P.sp + hz * P.cp; hy = t;                // pitch
  t = hx * P.cr - hy * P.sr; hy = hx * P.sr + hy * P.cr; hx = t;                // roll
  hy += PIVOT;
  const ax = Math.abs(hx);
  // skin: skull, jaw and chin, cheekbones, eye sockets, nose
  let skin = smin(ell(hx, hy - 0.05, hz, 0.37, 0.49, 0.43), ell(hx, hy + 0.23, hz - 0.08, 0.235, 0.27, 0.31), 0.16);
  skin = smin(skin, ell(ax - 0.17, hy + 0.05, hz - 0.24, 0.13, 0.1, 0.13), 0.08);
  skin = smax(skin, -sph(ax - 0.145, hy - 0.07, hz - 0.40, 0.1), 0.05);
  skin = smin(skin, ell(hx, hy + 0.04, hz - 0.415, 0.035, 0.11, 0.06), 0.035);
  skin = smin(skin, sph(hx, hy + 0.12, hz - 0.455, 0.04), 0.03);
  // mouth: an opening (wider when talking), corners lifted by the smile
  const my = hy + 0.285 - 2.2 * P.smile * hx * hx;
  skin = smax(skin, -ell(hx, my, hz - 0.42, 0.08, 0.006 + 0.05 * P.mouth, 0.12), 0.015);
  const lips = Math.min(ell(hx, my - 0.021, hz - 0.398, 0.092, 0.027, 0.048),
                        ell(hx, my + 0.026 + 0.05 * P.mouth, hz - 0.39, 0.082, 0.034, 0.05));
  // eyes, and the upper lids that come down over them
  const eye = sph(ax - 0.145, hy - 0.07, hz - 0.33, 0.08);
  const cut = 0.07 - 0.088 + 0.176 * P.lid;   // the lid covers the eye above this height: high when open
  const lid = Math.max(sph(ax - 0.145, hy - 0.07, hz - 0.333, 0.087), cut - hy);
  skin = Math.min(skin, lid);
  // brows
  const br = 0.035 * P.brows;
  const brows = capsule(ax, hy, hz, 0.075, 0.185 + br, 0.43, 0.235, 0.165 + br * 0.6, 0.385, 0.017);
  // hair: a cap with the face cut out, a side-swept fringe, long hair down the sides and back
  const face = ell(hx, hy + 0.13, hz - 0.31, 0.325, 0.47, 0.42);
  let hair = smax(ell(hx, hy - 0.11, hz + 0.02, 0.47, 0.6, 0.53), -face, 0.04);
  hair = smin(hair, ell(hx + 0.07, hy - 0.3 + 0.24 * hx, hz - 0.335, 0.29, 0.06, 0.12), 0.05);   // side-swept fringe
  const fall = smin(ell(hx, hy + 0.48, hz + 0.2, 0.47, 0.8, 0.27),
                    ell(ax - 0.355 - 0.06 * Math.max(0, -hy - 0.2), hy + 0.5, hz - 0.02, 0.13, 0.75, 0.2), 0.12);
  hair = smin(hair, smax(fall, -face, 0.03), 0.06);
  const d = Math.min(body, skin, lips, eye, brows, hair);
  if (m) {
    m.x = hx; m.y = hy; m.z = hz;
    m.kind = d === eye ? "eye" : d === lips ? "lips" : d === hair || d === brows ? "hair" : d === body && body < skin - 0.01 ? "body" : "skin";
    if (m.kind === "body" && y > -0.9) m.kind = "skin";   // the neck is skin, the shoulders are clothes
  }
  return d;
}

const COLORS = { skin: [246, 204, 178], lips: [214, 92, 108], hair: [176, 84, 48], body: [70, 86, 120],
                 white: [240, 238, 236], iris: [70, 150, 120], pupil: [20, 22, 28] };
const LIGHT = (() => { const l = hyp(-0.55, 0.6, 0.85); return [-0.55 / l, 0.6 / l, 0.85 / l]; })();

function shade(x, y, P, m) {   // the colour of one pixel, or null for background
  let z = 0.62, steps = 0;
  for (; steps < 56; steps++) {
    const d = scene(x, y, z, P);
    if (d < 0.0025) break;
    z -= d;
    if (z < -0.75) return null;
  }
  if (steps === 56) return null;
  const e = 0.003, k = (dx, dy, dz) => scene(x + dx, y + dy, z + dz, P);
  const a = k(e, -e, -e), b = k(-e, -e, e), c = k(-e, e, -e), d = k(e, e, e);
  let nx = a - b - c + d, ny = -a - b + c + d, nz = -a + b - c + d;
  const nl = hyp(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  scene(x, y, z, P, m);
  const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  const fill = Math.max(0, nx * 0.6 - ny * 0.1 + nz * 0.5) * 0.25;   // soft fill from the other side
  const rim = Math.pow(1 - Math.max(0, nz), 2.5) * 0.3;
  const ao = 1 - Math.min(0.45, steps / 90);
  let b2 = (0.32 + 0.62 * diff + fill + rim) * ao, base = COLORS[m.kind] || COLORS.skin;
  if (m.kind === "hair") b2 *= 0.72 + 0.28 * Math.sin(m.x * 80 + m.y * 10 + Math.sin(m.y * 14) * 2);   // strands
  if (m.kind === "skin") {   // lash line: the edge of the upper lid
    const lx = Math.abs(m.x) - 0.145, ly = m.y - (0.07 - 0.088 + 0.176 * P.lid);
    if (Math.abs(ly) < 0.016 && Math.abs(lx) < 0.085 && m.z > 0.33) { base = [60, 36, 30]; b2 = 1; }
  }
  if (m.kind === "eye") {   // white, iris, pupil and a highlight, by where the point sits on the eyeball vs. the gaze
    const ex = Math.abs(m.x) - 0.145, ey = m.y - 0.07, ez = m.z - 0.33, el = hyp(ex, ey, ez) || 1;
    const gx = Math.sign(m.x) * P.gx, gl = hyp(gx, P.gy, 1);
    const dot = (ex * gx + ey * P.gy + ez) / (el * gl);
    const hl = (ex + 0.025) * (ex + 0.025) + (ey - 0.03) * (ey - 0.03) < 0.00035;
    base = hl ? [255, 255, 255] : dot > 0.975 ? COLORS.pupil : dot > 0.86 ? COLORS.iris : COLORS.white;
    b2 = hl ? 1 : dot > 0.86 ? 0.75 + 0.25 * b2 : Math.max(0.6, b2);
  }
  b2 = Math.max(0.12, Math.min(1.15, b2));
  return `rgb(${Math.min(255, base[0] * b2) | 0},${Math.min(255, base[1] * b2) | 0},${Math.min(255, base[2] * b2) | 0})`;
}

function render(P) {
  const m = {}, W = AV.cols, H = AV.rows * 2, px = new Array(W * H);
  for (let r = 0; r < H; r++) {
    const y = AV.y0 - (r + 0.5) * AV.px;
    for (let c = 0; c < W; c++) px[r * W + c] = shade(AV.x0 + (c + 0.5) * AV.px, y, P, m);
  }
  const out = [];
  for (let r = 0; r < AV.rows; r++) {
    let line = "", run = "", key = "";
    for (let c = 0; c < W; c++) {
      const top = px[2 * r * W + c], bot = px[(2 * r + 1) * W + c];
      // each cell is painted with a two-colour background (top pixel, bottom pixel), so rows meet without gaps
      const k = !top && !bot ? "" : `linear-gradient(${top || "transparent"} 50%,${bot || "transparent"} 50%)`;
      if (k !== key) { line += key ? `<i style="background:${key}">${run}</i>` : run; run = ""; key = k; }
      run += " ";
    }
    line += key ? `<i style="background:${key}">${run}</i>` : "";
    out.push(line);
  }
  return out.join("\n");
}

// ---- behaviour ----
const avatar = {
  el: null, pre: null, fxEl: null, level: 0, levelAt: 0, busy: false,
  pose: { yaw: 0, pitch: 0, roll: 0, gx: 0, gy: 0, smile: 0.6, mouth: 0, brows: 0, lid: 1 },
  goal: { yaw: 0, pitch: 0, roll: 0, gx: 0, gy: 0, smile: 0.6, brows: 0 },
  nextLook: 0, blinkAt: 0, blinkUntil: 0,

  init() {
    const side = $("#side"), foot = side.querySelector(".sidefoot");
    this.el = el("div", "avatar");
    this.el.dataset.tip = "Yo Claude · click to talk";
    this.el.onclick = () => api().talk();
    this.pre = el("pre");
    this.fxEl = el("div", "afx");
    this.el.append(this.pre, this.fxEl);
    side.insertBefore(this.el, foot);
    this.apply();
    setInterval(() => this.tick(), 125);   // about 8 frames a second (a frame takes ~20 ms to draw)
  },
  apply() { this.el?.classList.toggle("hidden", S.settings?.avatar === false); },
  levels(list) { if (list?.length) { this.level = Math.min(1, (list.at(-1) || 0) / 3000); this.levelAt = Date.now(); } },
  state() {
    const d = S.display || {};
    if (d.state === "approval") return "approval";
    if (d.state === "using_pc") return "using_pc";
    if (["listening", "speaking", "paused", "error", "starting"].includes(d.voice)) return d.voice;
    if (d.state === "thinking" || d.voice === "thinking") return "thinking";
    return d.state === "paused" ? "paused" : "idle";
  },

  tick() {
    if (!this.el || this.el.classList.contains("hidden") || document.hidden || this.busy) return;
    const now = Date.now(), t = now / 1000, st = this.state(), g = this.goal, p = this.pose;
    let fx = "";
    if (now > this.nextLook) {   // a new place to look, a new expression
      const wide = st === "idle" ? 0.45 : 0.2;
      g.yaw = (Math.random() * 2 - 1) * wide; g.pitch = (Math.random() * 2 - 1) * 0.12; g.roll = (Math.random() * 2 - 1) * 0.1;
      g.gx = (Math.random() * 2 - 1) * 0.35; g.gy = (Math.random() * 2 - 1) * 0.2;
      g.smile = st === "idle" ? [0.9, 0.6, 0.6, 0.3, 0.75][Math.floor(Math.random() * 5)] : 0.45;
      g.brows = Math.random() < 0.25 ? 1 : 0;
      this.nextLook = now + 2200 + Math.random() * 4000;
    }
    let mouth = 0.04 + 0.03 * Math.sin(t * 0.7), lidGoal = 1;
    if (st === "speaking") {
      const lv = now - this.levelAt < 400 ? this.level : 0;
      mouth = Math.min(1, lv * 1.3 + Math.random() * 0.25 * (lv > 0.05));
      g.brows = Math.sin(t * 1.3) > 0.5 ? 1 : 0.3; g.gx *= 0.5; g.gy = 0;
      fx = Math.floor(t * 3) % 2 ? "~ ♪" : " ♪ ~";
    } else if (st === "listening") {
      const heard = now - this.levelAt < 400 && this.level > 0.12;
      g.brows = 1; g.smile = 0.5; g.gx = 0; g.gy = 0; g.yaw = 0.18 * Math.sin(t * 0.5); g.pitch = heard ? 0.08 * Math.sin(t * 6) : -0.05;
      fx = ")".repeat(1 + Math.floor(t * 3) % 3);
    } else if (st === "thinking") {
      g.gx = -0.45; g.gy = 0.4; g.yaw = 0.25; g.pitch = -0.1; g.roll = 0.08; g.smile = 0.25; g.brows = 0.6;
      fx = ["o", "o O", "o O ( … )", "o O ( … )"][Math.floor(t * 2) % 4];
    } else if (st === "using_pc") {
      g.gy = -0.45; g.gx = 0.1; g.pitch = 0.12; g.yaw = -0.1; g.smile = 0.35; g.brows = 0.2;
      const k = "▓▒░▒"; fx = "[" + k[Math.floor(t * 6) % 4] + k[Math.floor(t * 6 + 1) % 4] + k[Math.floor(t * 6 + 2) % 4] + "]";
    } else if (st === "approval") {
      g.brows = 1; g.gx = 0; g.gy = 0; g.yaw = 0; g.roll = 0.12; g.smile = 0.4; mouth = 0.18;
      fx = Math.floor(t * 2) % 2 ? "?" : " ?";
    } else if (st === "paused") {
      lidGoal = 0; g.pitch = 0.16; g.roll = -0.12; g.yaw = 0; g.smile = 0.5; g.brows = 0;
      fx = ["z", "z Z", "z Z z"][Math.floor(t) % 3];
    } else if (st === "error") {
      g.brows = 0.8; g.smile = 0; g.yaw = 0;
    }
    if (st !== "paused" && now > this.blinkAt) { this.blinkUntil = now + 160; this.blinkAt = now + 2000 + Math.random() * 4000; }
    if (now < this.blinkUntil) lidGoal = 0;
    // ease towards the goal, with a little breathing sway on top
    const ease = (a, b, k) => a + (b - a) * k;
    p.yaw = ease(p.yaw, g.yaw + 0.03 * Math.sin(t * 0.8), 0.12); p.pitch = ease(p.pitch, g.pitch + 0.02 * Math.sin(t * 1.1), 0.12);
    p.roll = ease(p.roll, g.roll + 0.02 * Math.sin(t * 0.6), 0.1);
    p.gx = ease(p.gx, g.gx, 0.35); p.gy = ease(p.gy, g.gy, 0.35); p.smile = ease(p.smile, g.smile, 0.15);
    p.brows = ease(p.brows, g.brows, 0.2); p.mouth = ease(p.mouth, mouth, 0.6); p.lid = ease(p.lid, lidGoal, 0.7);
    const P = { ...p, cy: Math.cos(p.yaw), sy: Math.sin(p.yaw), cp: Math.cos(p.pitch), sp: Math.sin(p.pitch),
                cr: Math.cos(p.roll), sr: Math.sin(p.roll) };
    this.busy = true;
    try { this.pre.innerHTML = render(P); } finally { this.busy = false; }
    this.pre.className = "st-" + st;
    if (this.fxEl.textContent !== fx) this.fxEl.textContent = fx;
    this.fxEl.className = "afx st-" + st;
  },
};
if (typeof module !== "undefined") module.exports = { render, avatar };
