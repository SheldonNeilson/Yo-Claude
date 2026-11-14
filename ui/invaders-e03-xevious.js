// Bug Invaders era 3: 1982 XEVIOUS / SCRAMBLE. The plane flies (the core does that); this module adds a scrolling ground, ground
// targets that only BOMBS hit (Z), a bombsight ahead of the plane, and air squadrons on curved paths that must not get past you.
//
// core.groundLayer (set in init, read lazily by later eras such as Raiden; it is empty and idle below era 3, `active` says so):
//   scroll()        px the ground has scrolled since the game began (the terrain and every target move with it)
//   speed           px/s the ground moves down right now (updated every frame)
//   targets         live array of ground units (never replaced, only emptied on a new wave: keep the reference or re-read it)
//   spawn(def)      add a unit and return it. def: { frames: [[line, ...], ...] | art: [line, ...], size = 12, color = palette name or css,
//                   x, y (top-left; default: random x, just above the screen), hp = 1, pts = 100, die = "destroyed", drop = 0.12 (power-up
//                   chance), vx / vy (px/s on top of the scroll), shoot = seconds between aimed shots (0 = none), shot = "!" (bullet char),
//                   burst = shots per volley, shootable = true (normal bullets hurt it too; default: only bombs do),
//                   update(t, dt), draw(t) (replaces the sprite), onKill(t) }
//   explode(x, y, r, dmg = 2)  a ground burst: rings, noise, damage to every unit within r (full dmg near the centre, one less at the edge)
//   hurt(t, dmg)    damage one unit (kills and scores it at 0 hp)
//   onKill          array of callbacks (t, { x, y, points, mult }) run after a unit dies
//   spawnRate       multiplier on this module's own target spawning (1; reset in onWave, so set it from your own onWave: a higher era's
//                   onWave runs after this one)
//   bombEnabled     true; a later era with its own bomb (Raiden's screen-clear) sets it false to switch off Z dropping a ground bomb
// Air squadrons (replaceFormation + curved paths) and the "shipped" rule only exist on the era-3 waves; the ground stays in later eras.
(() => {
"use strict";
const SIZE = 12, LH = 14, ROWS = 56, ALLOW = 6;   // terrain glyph size, row height, rows in the repeating tile, shipped bugs a wave forgives
const BOMB_CD = 0.5, BOMB_AIR = 0.4, BOMB_R = 36, SIGHT_AHEAD = 100;
const SQUADS = ["column", "vee", "pair", "loop", "strafe", "dive", "vee"];   // the era-3 wave, in order (random picks after the list)
const SHOOTERS = new Set(["fail", "nan", "conflict", "segv", "heisen"]);   // the squad types that shoot back (bug / todo / leak never do)
// ground targets: weight is [from wave offset, weight]. Sitters just score; shooters aim slowly at the plane
const DEFS = {
  log:  { frames: [["[LOG]", "=====", "====="]], color: "amber", hp: 1, pts: 100, die: "logrotate ✓", cluster: 2, w: [0, 3] },
  db:   { frames: [["[DB]", "(  )", " '  "], ["[DB]", "(  )", "  .  "], ["[DB]", "(  )", "     "]], color: "green", hp: 1, pts: 150, die: "DROP TABLE ✓", w: [0, 2] },
  cron: { frames: [["{CRON}", "*/5 * "], ["{CRON}", " */5 *"]], color: "orange2", hp: 2, pts: 200, die: "never runs again", w: [0, 2], shootFrom: 2, shoot: 4.6, burst: 3, shot: "*" },
  ci:   { frames: [["[ CI ]", "[>   ]"], ["[ CI ]", "[>>  ]"], ["[ CI ]", "[>>> ]"]], color: "blue", hp: 1, pts: 250, die: "pipeline cancelled", w: [0, 1], shoot: 5.4, shot: "!" },
  srv:  { frames: [["[SRV]", "|o:o|", "|:o:|", "|o:o|"], ["[SRV]", "|:o:|", "|o:o|", "|:o:|"]], color: "text", hp: 2, pts: 300, die: "503 · gone", cluster: 3, w: [1, 2], shoot: 3.8, shot: "#" },
};
const FIELD_PATS = ['" ', "';", "+ ", "01", "{}", "<>", ";;"];
const LABELS = ["/usr/bin", "/var/log", "/tmp", "prod", "staging", "/etc/hosts", "~/projects", "main", "origin", "v1.0.0"];
const CLOUDS = [["  .--~~--.  ", " (  ~~~~~  )", "  '--~~--'  "], ["   .-~~-.    ", " .(  ~~  ).  ", "(  ~~~~~~  ) ", " '-.____.-'  "], ["  _~~_  ", " (~~~~) ", "  '--'  "]];

(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 3, year: 1982, name: "XEVIOUS",
  blurb: "the plane flies up and down over a scrolling dev world. Shoot the air, BOMB the ground: [Z] drops a bomb on the sight. Bugs that fly off the bottom ship to production.",
  fx: { glow: 1.1, trail: 6 },
  replaceFormation: (w) => w === 3,   // era 3 is waves 3 (this) and 4 (boss); later eras bring their own squadrons
  init(core) {
    const { G, view, C, paths, rnd, pick, clamp, overlap, sprite, drawSprite, txt, measure, charW, SFX, beep } = core;
    const ctx = core.canvas.getContext("2d");   // the same context the core draws with (draw hooks run inside its save / restore)
    const targets = [], bombs = [], rings = [];
    let scrollPx = 0, speed = 56, groundT = 2, bombCool = 0, killed = 0, hintT = 10, flashT = 0;
    const label = { n: 0, t: 0 };   // one rolling "shipped to prod! ×n" label instead of a floater per bug (they piled up in the corner)
    let air = false, squadLeft = 0, squadT = 0, squadIdx = 0, shipped = 0, shipTot = 0, pending = 0, cleanDone = false;
    const diff = () => Math.max(0, G.wave - 3);   // how far past the first era-3 wave (ground and air get meaner with it)

    // ---------- the ground layer other eras can use ----------
    const layer = core.groundLayer = {
      targets, speed, spawnRate: 1, bombEnabled: true, onKill: [],
      get active() { return G.era >= 3; },
      scroll: () => scrollPx,
      spawn(def) {
        const frames = def.frames || [def.art || ["[?]"]], size = def.size || SIZE, m = measure(frames[0], size);
        const t = { hp: 1, pts: 100, color: "text", die: "destroyed", drop: 0.12, vx: 0, vy: 0, shoot: 0, shot: "!", burst: 1, ...def,
          frames, size, w: m.w, h: m.h, age: Math.random() * 3, flash: 0, dead: false };
        t.x = def.x ?? rnd(10, Math.max(11, view.W - t.w - 10)); t.y = def.y ?? -t.h - 4;
        t.max = t.hp; t.shootT = t.shoot * rnd(0.6, 1.2);
        targets.push(t);
        return t;
      },
      explode, hurt,
    };
    function explode(x, y, r, dmg = 2) {   // a ground burst: damages every unit within r of (x, y); returns how many it touched
      if (rings.length >= 5) rings.shift();
      rings.push({ x, y, r, t: 0 });
      core.burst(x, y, C.orange, 14, "*+#%.");
      G.shake = Math.max(G.shake, 2.5);
      beep(120, 0.28, "sawtooth", 0.035, -80);
      let n = 0;
      for (const t of targets.slice()) {
        if (t.dead) continue;
        const dx = Math.max(t.x - x, 0, x - (t.x + t.w)), dy = Math.max(t.y - y, 0, y - (t.y + t.h)), d = Math.hypot(dx, dy);
        if (d > r) continue;
        n++; hurt(t, d <= r * 0.45 ? dmg : Math.max(1, dmg - 1));
      }
      return n;
    }
    function hurt(t, dmg) {
      if (t.dead) return;
      t.hp -= dmg; t.flash = 0.12;
      if (t.hp > 0) { core.burst(t.x + t.w / 2, t.y + t.h / 2, C[t.color] || t.color, 4, "=#"); SFX.hit(); return; }
      t.dead = true; killed++;
      const cx = t.x + t.w / 2, cy = t.y + t.h / 2, m = core.comboHit(), pts = t.pts * m;
      core.addScore(pts);
      core.burst(cx, cy, C[t.color] || t.color, 16, "#%*+=");
      core.float(t.die, cx, cy - 8, C.green, 11, 1.3); core.float(`+${pts}`, cx, cy + 6, C.dim, 10, 1.1);
      G.shake = Math.max(G.shake, 1.5); SFX.hit();
      if (G.powerups.length < 2 && Math.random() < t.drop) core.dropPower(cx, cy, true);   // some of the infrastructure was holding a power-up
      if (t.onKill) t.onKill(t);
      for (const fn of layer.onKill) fn(t, { x: cx, y: cy, points: pts, mult: m });
    }

    // ---------- the landscape: two cached tiles (ground, clouds) that repeat while scrolling ----------
    // Built once per size / palette from a seeded generator so it is the same dev world every game. Roads, a river and the tile's
    // edges are periodic (sine with whole periods), so the repeat has no seam.
    const tiles = { key: "", ground: null, clouds: null, gh: ROWS * LH, ch: 620 };
    const rng = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    function buildTiles() {
      const W = view.W, kt = Math.min(view.k, 1.25), cw = charW(SIZE);
      const key = [Math.round(W), kt.toFixed(2), cw.toFixed(2), C.bg, C.green, C.mono].join("|");
      if (tiles.key === key) return;
      tiles.key = key;
      const cols = Math.ceil(W / cw) + 1, R = ROWS, rr = rng(1982), COL = [C.faint, C.green, C.blue, C.dim, C.amber, C.line, C.text];
      const ch = new Array(R * cols).fill(""), ci = new Uint8Array(R * cols), occ = new Uint8Array(R * cols);
      const at = (r, c) => (((r % R) + R) % R) * cols + c;
      const put = (r, c, s, k, o) => { if (c < 0 || c >= cols) return; const i = at(r, c); ch[i] = s; ci[i] = k; if (o) occ[i] = 1; };
      const text = (r, c, s, k) => [...s].forEach((x, j) => put(r, c + j, x, k, 1));
      const free = (r0, c0, w, h, m) => {
        if (c0 - m < 0 || c0 + w + m > cols) return false;
        for (let r = -m; r < h + m; r++) for (let c = -m; c < w + m; c++) if (occ[at(r0 + r, c0 + c)]) return false;
        return true;
      };
      for (let i = 0; i < ch.length; i++) if (rr() < 0.05) { ch[i] = rr() < 0.5 ? "." : ","; ci[i] = 0; }
      const rx = (r) => cols * 0.74 + cols * 0.08 * Math.sin((2 * Math.PI * r * 2) / R + 1), vx = (r) => cols * 0.26 + 2.2 * Math.sin((2 * Math.PI * r * 3) / R);
      for (let r = 0; r < R; r++) {   // the river (/dev/null), blue, with green banks
        const c0 = Math.round(rx(r));
        for (let c = -2; c <= 2; c++) put(r, c0 + c, Math.abs(c) === 2 ? "," : (r + c) & 1 ? "~" : "-", Math.abs(c) === 2 ? 1 : 2, 1);
        for (const c of [-3, 3]) occ[at(r, clamp(c0 + c, 0, cols - 1))] = 1;
      }
      for (const r0 of [9, 28, 45]) {   // horizontal roads, bridging the river
        for (let c = 0; c < cols; c++) {
          const wet = Math.abs(c - Math.round(rx(r0))) <= 2;
          put(r0 - 1, c, wet ? "#" : "=", wet ? 4 : 3, 1); put(r0 + 1, c, wet ? "#" : "=", wet ? 4 : 3, 1); put(r0, c, wet ? "#" : c & 1 ? "-" : " ", 3, 1);
        }
      }
      for (let r = 0; r < R; r++) {   // the main road, a wavering vertical
        const c0 = Math.round(vx(r));
        put(r, c0 - 1, "|", 3, 1); put(r, c0 + 1, "|", 3, 1); put(r, c0, r % 3 === 0 ? "'" : " ", 3, 1);
        occ[at(r, c0 - 2)] = occ[at(r, c0 + 2)] = 1;
      }
      for (let n = 0, tries = 0; n < Math.round((cols * R) / 190) && tries < 500; tries++) {   // fields: fenced plots of crop tokens
        const w = 6 + Math.floor(rr() * 9), h = 4 + Math.floor(rr() * 5), r0 = Math.floor(rr() * R), c0 = Math.floor(rr() * (cols - w)), pat = pick(FIELD_PATS), k = rr() < 0.7 ? 1 : 4;
        if (!free(r0, c0, w, h, 1)) continue;
        n++;
        for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
          const edge = r === 0 || r === h - 1 || c === 0 || c === w - 1, s = pat[(c + (r & 1)) % pat.length];
          put(r0 + r, c0 + c, edge ? (r === 0 || r === h - 1 ? "-" : "|") : s, edge ? 3 : k, 1);
        }
      }
      for (let n = 0, tries = 0; n < 2 && tries < 300; tries++) {   // node_modules: a dense forest
        const rw = 6, rh = 3, r0 = Math.floor(rr() * R), c0 = Math.floor(rr() * (cols - 2 * rw)) + rw;
        if (!free(r0 - rh - 1, c0 - rw, 2 * rw + 1, 2 * rh + 2, 1)) continue;
        n++;
        for (let r = -rh; r <= rh; r++) for (let c = -rw; c <= rw; c++) if ((c * c) / (rw * rw) + (r * r) / (rh * rh) <= 1 && rr() < 0.85) put(r0 + r, c0 + c, rr() < 0.6 ? "^" : "A", 1, 1);
        text(r0 - rh - 1, c0 - 6, "node_modules", 0);
      }
      for (let tries = 0, n = 0; n < 1 && tries < 300; tries++) {   // a town
        const w = 14, h = 6, r0 = Math.floor(rr() * R), c0 = Math.floor(rr() * (cols - w));
        if (!free(r0 - 1, c0, w, h + 1, 1)) continue;
        n++;
        for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) put(r0 + r, c0 + c, r % 2 === 0 ? ("[]  "[c % 4] === " " ? "" : "[]  "[c % 4]) : "", 3, 1);
        text(r0 - 1, c0, "localhost:3000", 0);
      }
      for (let n = 0, tries = 0; n < 6 && tries < 200; tries++) {   // signposts
        const s = pick(LABELS), r0 = Math.floor(rr() * R), c0 = Math.floor(rr() * (cols - s.length));
        if (free(r0, c0, s.length, 1, 1)) { text(r0, c0, s, 0); n++; }
      }
      text(14, Math.round(rx(14)) - 4, "/dev/null", 2);
      const tile = document.createElement("canvas");
      tile.width = Math.ceil(cols * cw * kt); tile.height = Math.ceil(R * LH * kt);
      const x = tile.getContext("2d");
      x.scale(kt, kt); x.font = `${SIZE}px ${C.mono}`; x.textBaseline = "top";
      for (let k = 0; k < COL.length; k++) {
        x.fillStyle = COL[k];
        for (let r = 0; r < R; r++) {
          let s = "", any = false;
          for (let c = 0; c < cols; c++) { const i = r * cols + c, on = ch[i] && ci[i] === k; s += on ? ch[i] : " "; any = any || on; }
          if (any) x.fillText(s, 0, r * LH);
        }
      }
      tiles.ground = { img: tile, w: tile.width / kt, h: R * LH };
      const kc = Math.min(view.k, 1), cl = document.createElement("canvas");   // the cloud layer: big, faint, faster than the ground
      cl.width = Math.ceil(W * kc); cl.height = Math.ceil(tiles.ch * kc);
      const y = cl.getContext("2d");
      y.scale(kc, kc); y.font = `20px ${C.mono}`; y.textBaseline = "top"; y.fillStyle = C.text;
      for (let i = 0; i < 7; i++) {
        const art = CLOUDS[Math.floor(rr() * CLOUDS.length)], cx = rr() * (W - 150), cy = rr() * (tiles.ch - 110);
        art.forEach((l, j) => y.fillText(l, cx, cy + j * 22));
      }
      tiles.clouds = { img: cl, w: W, h: tiles.ch };
    }
    function drawTile(t, off, alpha) {   // the tile repeated down the field, edges snapped to device pixels so repeats don't show a seam
      const k = view.k, H = view.H;
      ctx.globalAlpha = alpha;
      for (let y = (off % t.h) - t.h; y < H; y += t.h) {
        const y0 = Math.round(y * k) / k, y1 = Math.round((y + t.h) * k) / k;
        ctx.drawImage(t.img, 0, y0, t.w, y1 - y0);
      }
      ctx.globalAlpha = 1;
    }

    // ---------- air squadrons ----------
    const airType = () => {
      const d = diff(), pool = ["bug", "todo", "fail"];
      if (d >= 1) pool.push("nan", "fail"); if (d >= 2) pool.push("conflict", "leak"); if (d >= 3) pool.push("heisen");
      return pick(pool);
    };
    function ship(e) {   // a squadron member flew off the bottom unshot: it is in production now
      e.alive = false; e.gone = true;
      shipped++; shipTot++; flashT = 0.6;
      label.n = label.t > 0 ? label.n + 1 : 1; label.t = 1.4;
      beep(150, 0.18, "square", 0.025, -60);
      if (shipped >= ALLOW) { shipped = 0; pending++; }   // too many: it costs a life (the allowance refills)
    }
    function spawnSquad() {
      const W = view.W, d = diff(), vy = Math.min(150, 76 + 7 * d), kind = squadIdx < SQUADS.length ? SQUADS[squadIdx] : pick(SQUADS);
      squadIdx++;
      const type = airType(), sh = SHOOTERS.has(type) ? Math.max(1.8, 4.6 - 0.25 * d) : 0, ex = { mine3: true };
      const go = (path, delay, t = type, s = sh) => paths.fly(t, path, { delay, shoot: s, onEnd: ship, extra: ex });
      if (kind === "column") {   // a snake of four down one wavy line
        const amp = rnd(36, 80), x = rnd(amp + 34, W - amp - 34);
        for (let i = 0; i < 4; i++) go(paths.sine({ x, vy, amp }), i * 0.5);
      } else if (kind === "vee") {   // a wedge fanning out
        paths.vee(d >= 2 ? 5 : 3, { x: rnd(110, W - 110), vy: vy * 1.05 }).forEach((p) => go(p, 0));
      } else if (kind === "pair") {   // two columns weaving across each other
        const x = rnd(130, W - 130);
        for (const ph of [0, Math.PI]) for (let i = 0; i < 3; i++) go(paths.sine({ x, vy, amp: 70, phase: ph }), i * 0.6);
      } else if (kind === "loop") {   // one by one, each does a loop-the-loop
        const r = 38, dir = Math.random() < 0.5 ? 1 : -1, x = rnd(r + 60, W - r - 60);
        for (let i = 0; i < 3; i++) go(paths.loop({ x, vy: vy * 1.1, dir, r, lead: rnd(110, 170) }), i * 0.8);
      } else if (kind === "strafe") {   // a diagonal run from one side
        const side = Math.random() < 0.5 ? 1 : -1;
        for (let i = 0; i < 4; i++) go(paths.line({ x: side > 0 ? 26 : W - 26, vx: side * 48, vy: vy * 1.15 }), i * 0.45);
      } else {   // dive: segfaults that steer on the plane
        for (let i = 0; i < 1 + (d >= 2 ? 1 : 0); i++) go(paths.dive({ x: rnd(60, W - 60), vy: vy * 1.45 }), i * 1.1, "segv", 0);
      }
      if (--squadLeft <= 0) G.hold = false;
    }

    // ---------- ground spawning, bombs, shooting ----------
    function spawnGround() {
      const d = diff(), pool = [];
      for (const [id, def] of Object.entries(DEFS)) {
        const [from, w] = def.w;
        if (d >= from) for (let i = 0; i < w + (id === "ci" || id === "srv" ? Math.min(2, d) : 0); i++) pool.push(id);
      }
      const def = DEFS[pick(pool)], shoots = def.shoot && d >= (def.shootFrom || 0);
      const m = measure(def.frames[0], SIZE), n = def.cluster && Math.random() < 0.3 + 0.05 * d ? def.cluster : 1;
      const x0 = rnd(12, Math.max(13, view.W - n * (m.w + 10) - 12));
      for (let i = 0; i < n; i++) layer.spawn({ ...def, x: x0 + i * (m.w + 10), shoot: shoots ? def.shoot / (1 + 0.06 * d) : 0, drop: def.id === "srv" ? 0.3 : 0.16 });
    }
    function groundFire(t) {
      if (G.ebul.filter((b) => b.gnd).length >= 3 + Math.floor(diff() / 3)) return;
      const P = G.player, cx = t.x + t.w / 2, cy = t.y + t.h / 2, dx = P.x + P.w / 2 - cx, dy = P.y + P.h / 2 - cy, dist = Math.hypot(dx, dy);
      if (dist < 70) return;   // too close to aim sensibly
      const v = Math.min(165, 88 + 7 * diff()), col = C[t.color === "text" ? "red" : t.color] || C.red;
      for (let i = 0; i < t.burst; i++) {
        const a = Math.atan2(dx, dy) + (i - (t.burst - 1) / 2) * 0.22;   // (the angle from "down", like core.aimedShot)
        core.enemyShot(cx, cy, Math.sin(a) * v, Math.cos(a) * v, t.shot, col, { gnd: true });
      }
      beep(300, 0.06, "square", 0.015, -140);
    }
    const sight = () => { const P = G.player; return { x: P.x + P.w / 2, y: Math.max(24, P.y - SIGHT_AHEAD) }; };

    return {
      onNewGame() {
        targets.length = bombs.length = rings.length = 0;
        Object.assign(layer, { spawnRate: 1, bombEnabled: true });   // (onKill keeps what other eras registered in their init)
        label.n = 0; label.t = 0; scrollPx = 0; killed = 0; hintT = 10; bombCool = 0; flashT = 0; air = false; squadLeft = 0; shipped = shipTot = pending = 0;
      },
      onWave() {
        targets.length = bombs.length = rings.length = 0;
        layer.spawnRate = 1; bombCool = 0; squadIdx = 0; shipped = shipTot = pending = 0; cleanDone = false; squadLeft = 0; label.n = 0; label.t = 0;
        air = !G.boss && G.era === 3;
        if (air) { squadLeft = SQUADS.length; squadT = 1.2; G.hold = true; }   // squads stream in; the wave stays open until the last one is out
        groundT = rnd(1.5, 2.5);
        for (let i = 0; i < 2; i++) {   // a field that already has things on it when the title clears (two harmless sitters)
          const def = DEFS[pick(["log", "db", "cron"])];
          layer.spawn({ ...def, shoot: 0, x: view.W * (0.25 + 0.4 * i) + rnd(-40, 40), y: rnd(30, view.H * 0.5) });
        }
      },
      update(dt) {
        if (G.state !== "play") return;
        speed = layer.speed = 56 + Math.min(40, 3 * diff());
        scrollPx += speed * dt;
        bombCool -= dt; flashT -= dt; label.t -= dt;
        for (const r of rings) r.t += dt;
        for (let i = rings.length - 1; i >= 0; i--) if (rings[i].t > 0.45) rings.splice(i, 1);
        for (const b of bombs) {
          b.t += dt;
          if (b.t >= BOMB_AIR) { b.done = true; explode(b.x, b.y, BOMB_R, 2); }
        }
        for (let i = bombs.length - 1; i >= 0; i--) if (bombs[i].done) bombs.splice(i, 1);
        for (const t of targets) {
          t.age += dt; t.flash = Math.max(0, t.flash - dt);
          t.y += (speed + t.vy) * dt; t.x += t.vx * dt;
          if (t.update) t.update(t, dt);
          if (t.y > view.H + 4 || t.x < -t.w - 60 || t.x > view.W + 60) t.dead = true;   // scrolled off the bottom: gone, no penalty
          else if (t.shoot && G.intro <= 0 && (t.shootT -= dt) <= 0) {
            t.shootT = t.shoot * rnd(0.8, 1.3);
            if (t.y > 6 && t.y < view.H * 0.8) groundFire(t);
          }
          if (t.shootable && !t.dead) {   // another era's units that normal bullets hurt too
            for (const s of G.shots) {
              if (s.dead || s.hex || (s.hit && s.hit.has(t)) || !overlap(s.x - (s.w || 2) / 2, s.y, s.w || 2, s.h || 10, t.x, t.y, t.w, t.h)) continue;
              if (s.hit) s.hit.add(t); else s.dead = true;
              hurt(t, s.dmg || 1);
              if (t.dead) break;
            }
          }
        }
        for (let i = targets.length - 1; i >= 0; i--) if (targets[i].dead) targets.splice(i, 1);
        if (G.intro > 0) return;   // nothing spawns or fires under the wave title
        if (hintT > 0) hintT -= dt;
        if (!G.clearT && (groundT -= dt) <= 0) {
          groundT = rnd(1.8, 3.0) / ((layer.spawnRate || 0.01) * (1 + 0.08 * diff())) * (G.boss ? 1.8 : 1);
          if (targets.length < 10) spawnGround();
        }
        if (air && squadLeft > 0 && !G.clearT && (squadT -= dt) <= 0) { squadT = Math.max(1.4, 3.1 - 0.15 * diff()); spawnSquad(); }
        if (pending > 0 && G.player.inv <= 0) {   // too many shipped: a life, once the plane can take a hit
          pending--;
          core.float("TOO MANY SHIPPED  -1 ✻", view.W / 2, view.H * 0.4, C.red, 14, 1.6);
          core.playerHit(1, { shipped: true });
          if (G.state === "over") G.overReason = "too many bugs shipped to production";
        }
        if (air && squadLeft <= 0 && G.clearT > 0 && !cleanDone) {   // the wave is clear
          cleanDone = true;
          if (!shipTot) { core.addScore(500); core.float("clean deploy: nothing shipped  +500", view.W / 2, view.H * 0.5, C.green, 12, 2); }
        }
      },
      onBomb() {
        if (!layer.bombEnabled || bombCool > 0 || bombs.length >= 2) return;
        bombCool = BOMB_CD; hintT = 0;
        const P = G.player, s = sight();
        bombs.push({ x0: P.x + P.w / 2, y0: P.y, x: s.x, y: s.y, t: 0 });
        beep(900, 0.35, "triangle", 0.018, -650);   // the falling whistle; the burst is the explosion's sawtooth
      },
      hud() {
        const o = [[`ground ${killed}`, C.green, `G${killed}`, 0], [bombCool <= 0 && bombs.length < 2 ? "Z bomb ●" : "Z bomb ○", C.blue, bombCool <= 0 && bombs.length < 2 ? "Z●" : "Z○", 0]];
        if (air) o.push([`shipped ${shipped}/${ALLOW}`, shipped >= ALLOW - 2 ? C.red : shipped ? C.amber : C.dim, `SHP ${shipped}/${ALLOW}`, shipped ? 1 : 0]);
        return o;
      },
      draw(lay) {
        const W = view.W, H = view.H;
        if (lay === "bg") {
          buildTiles();
          ctx.globalAlpha = 0.82; ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);   // dims the stars: the ground is a surface now
          ctx.globalAlpha = 1;
          drawTile(tiles.ground, scrollPx, 0.32);
          for (const t of targets) {
            if (t.draw) { t.draw(t); continue; }
            const fr = t.frames[Math.floor(t.age * 2.5) % t.frames.length], hurtC = t.hp < t.max ? C.amber : C[t.color] || t.color;
            drawSprite(sprite(fr, t.size, t.flash > 0 ? "#ffffff" : hurtC, 3), t.x, t.y, 0.92);
          }
          drawTile(tiles.clouds, scrollPx * 1.7, 0.08);
        } else if (lay === "world") {
          if (!layer.bombEnabled || !core.caps.bomb || G.state !== "play") return;
          const P = G.player, s = sight();
          let locked = false;
          for (const t of targets) if (!t.dead && Math.hypot(Math.max(t.x - s.x, 0, s.x - t.x - t.w), Math.max(t.y - s.y, 0, s.y - t.y - t.h)) <= BOMB_R * 0.6) { locked = true; break; }
          const sx = P.x + P.w / 2;
          for (const f of [0.3, 0.55, 0.8]) txt(".", sx - 2, P.y + (s.y - P.y) * f, C.blue, 12, "left", 0, 0.35);
          const col = locked ? C.red : C.blue, a = locked ? 0.6 + 0.4 * Math.sin(G.rt * 16) : 0.75;
          drawSprite(sprite([locked ? "-(X)-" : "-(+)-"], 12, col, 6), s.x - 17, s.y - 7, a);
          for (const b of bombs) {
            const u = b.t / BOMB_AIR, x = b.x0 + (b.x - b.x0) * u, y = b.y0 + (b.y - b.y0) * u - 20 * Math.sin(Math.PI * u);
            drawSprite(sprite(["o"], 13 - Math.round(3 * u), C.text, 5), x - 3.5, y - 6);
          }
          for (const r of rings) {   // the ground burst: rings of symbols opening out
            const u = r.t / 0.45, rad = r.r * (0.25 + 0.75 * Math.sqrt(u));
            for (let i = 0; i < 14; i++) {
              const an = (i / 14) * Math.PI * 2 + u;
              drawSprite(sprite([i & 1 ? "*" : "+"], 11, C.orange2, 4), r.x + Math.cos(an) * rad - 3.5, r.y + Math.sin(an) * rad * 0.8 - 6, 1 - u);
            }
            for (let i = 0; i < 6; i++) { const an = (i / 6) * Math.PI * 2 - u * 2; drawSprite(sprite(["#"], 10, C.amber, 3), r.x + Math.cos(an) * rad * 0.5 - 3, r.y + Math.sin(an) * rad * 0.4 - 5, (1 - u) * 0.8); }
          }
        } else if (lay === "fg") {
          if (air && G.state === "play") txt("v  production  v", W / 2, H - 14, flashT > 0 ? C.red : C.faint, 9, "center", flashT > 0 ? 4 : 0, flashT > 0 ? 1 : 0.6);
          if (label.t > 0 && G.state === "play") txt(`shipped to prod!${label.n > 1 ? " ×" + label.n : ""}`, W / 2, core.bottomY - 20, C.red, 11, "center", 4, Math.min(1, label.t * 2));
          if (hintT > 0 && G.intro <= 0 && G.state === "play") txt("[Z] drops a bomb on the sight. Bullets only hit the air.", W / 2, core.bottomY - 40, C.dim, 11, "center", 2, Math.min(1, hintT));
        }
      },
    };
  },
});
})();
