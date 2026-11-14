// Bug Invaders era 10, 2004+ GEOMETRY WARS / NEON: the final form. Twin-stick: the mouse (or I J K L) aims while WASD flies, shots go where
// you aim and the plane's nose turns (8 glyphs). A combo multiplier climbs with quick kills and decays. A warping grid ripples when
// things die, particles come in storms, glow blooms (additive blobs under bugs, bullets and shots) and the screen shakes. From here
// every normal wave adds bugs and speed, forever. Still text sprites: the only canvas lines are the grid's, the "modern layer".
// Cost guard: a rolling average of the frame's own cost; over 12 ms the effects drop to a low tier, back up once it is calm again.
// Lives in one closure. Plane colour and the turned nose are painted by the Ikaruga module (invaders-e09-ikaruga.js) through
// `core.ikaruga.skin`; this file adds `core.neon` (read-only getters, for tests).
(() => {
"use strict";
(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 10, year: 2004, name: "NEON", blurb: "twin-stick. Mouse or I J K L aims, WASD flies. Quick kills build the combo. It never ends.",
  keys: { aimUp: ["i"], aimLeft: ["j"], aimDown: ["k"] },   // (L stays the core's "scores" action, which does nothing in play: we read it as aim right)
  hints: ["mouse / IJKL aim"],
  init(core) {
    const { G, C, view, rnd, pick, clamp, paths } = core;
    const cv = core.canvas, ctx = cv.getContext("2d");
    const PI = Math.PI;
    // the nose: 8 glyph variants of the plane, N then clockwise (the middle of the plane never changes, so the hit box stays put)
    const NOSE = [[" /▲\\ ", "[===]"], [" /✻◥ ", "[===]"], [" /✻\\►", "[===]"], [" /✻\\ ", "[==◢]"],
      [" /✻\\ ", "[=▼=]"], [" /✻\\ ", "[◣==]"], ["◄/✻\\ ", "[===]"], [" ◤✻\\ ", "[===]"]];
    const SHOT_CH = ["|", "/", "-", "\\", "|", "/", "-", "\\"];
    const bucket = (a) => (((Math.round(a / (PI / 4)) % 8) + 8) % 8);
    const polCol = (p) => (core.ikaruga ? core.ikaruga.color(p) : C.amber);

    // ---------- state ----------
    const aim = { x: 0, y: 0, th: 0, mode: "none" };   // mode: none | pointer | keys
    let combo = 0, lastKill = -9, pulse = 0, lastLives = 3, mouseFire = false, hadBoss = null, level = 0, shots = 0, gridDraws = 0;
    let flashes = [], gridGlow = 0;
    // frame-cost governor: avg = smoothed ms of update + render for this module's frames; qual 1 = full effects, 0 = low tier
    let t0 = 0, avg = 3, qual = 1, slow = 0, calm = 0;

    // ---------- the aim ----------
    const live = () => G.era >= 10 && G.state === "play";
    cv.addEventListener("pointermove", (e) => {   // no capture, no preventDefault: the app keeps its pointer
      if (!live()) return;
      const p = core.toView(e.clientX, e.clientY);
      aim.x = p.x; aim.y = p.y; aim.mode = "pointer";
    }, { passive: true });
    cv.addEventListener("pointerdown", (e) => {
      if (!live()) return;
      const p = core.toView(e.clientX, e.clientY);
      aim.x = p.x; aim.y = p.y; aim.mode = "pointer";
      if (e.pointerType !== "touch" && e.button === 0) { mouseFire = true; core.keys.add("fire"); }   // hold the button to fire
    }, { passive: true });
    const release = () => { if (mouseFire) { mouseFire = false; core.keys.delete("fire"); } };
    window.addEventListener("pointerup", release, { passive: true });
    window.addEventListener("pointercancel", release, { passive: true });
    cv.addEventListener("pointerleave", release, { passive: true });
    const planeC = () => { const P = G.player; return { x: P.x + P.w / 2, y: P.y + P.h / 2 }; };
    function updateAim() {
      const K = core.keys, kx = (K.has("scores") ? 1 : 0) - (K.has("aimLeft") ? 1 : 0), ky = (K.has("aimDown") ? 1 : 0) - (K.has("aimUp") ? 1 : 0);
      if (kx || ky) { aim.mode = "keys"; aim.th = Math.atan2(kx, -ky); }
      else if (aim.mode === "pointer") {
        const c = planeC(), dx = aim.x - c.x, dy = aim.y - c.y;
        if (dx * dx + dy * dy > 100) aim.th = Math.atan2(dx, -dy);   // (0 = straight up, clockwise)
      }
    }
    // where the crosshair sits: on the pointer, or 90 px out along the key aim
    const crossPos = () => {
      if (aim.mode === "pointer") return { x: aim.x, y: aim.y };
      const c = planeC();
      return { x: c.x + Math.sin(aim.th) * 90, y: c.y - Math.cos(aim.th) * 90 };
    };
    // new player shots (made by the core or another era, straight up) are turned toward the aim, as one bundle around the plane
    function turnShots() {
      const c = planeC(), th = aim.th, sn = Math.sin(th), cs = Math.cos(th);
      for (const s of G.shots) {
        if (s.e10) continue;
        s.e10 = true;
        const own = s.draw && !s.e9;   // a look of its own (era 7's laser and missiles, the beam): `turn` shots are re-aimed and drawn turned by their owner, the rest fly as they are
        if (s.hex || (s.ally && !s.turn) || (own && !s.turn) || (s.w || 2) > 6) continue;   // helpers, hex dumps and beams
        const ox = s.x - c.x, oy = s.y - c.y, vx = s.vx, vy = s.vy;
        s.x = c.x + ox * cs - oy * sn; s.y = c.y + ox * sn + oy * cs;
        s.vx = vx * cs - vy * sn; s.vy = vx * sn + vy * cs;
        s.px = s.x; s.py = s.y; s.ang = Math.atan2(s.vx, -s.vy);
        if (own) continue;
        s.w = 6; s.h = 8; s.life = 1.05;   // a short, fat bolt: a sideways one must not clog the shot limit
        s.draw = drawShot; shots++;
        if (shots % 2 === 0) ripple(s.x, s.y, 45, 40);
      }
    }
    function drawShot(s) {
      const k = bucket(s.ang), col = s.pierce ? C.red : polCol(s.pol);
      const sp = core.sprite([SHOT_CH[k]], 12, col, 7), off = k === 2 || k === 6 ? 5 : 0;
      core.drawSprite(sp, s.x - 3.5, s.y - off);
      core.drawSprite(sp, s.x - 3.5 - s.vx * 0.022, s.y - off - s.vy * 0.022, 0.35);   // a ghost behind it
    }

    // ---------- bloom: soft additive blobs, one cached radial sprite per colour ----------
    const blobs = new Map();
    function blob(c) {
      let b = blobs.get(c);
      if (b) return b;
      b = document.createElement("canvas"); b.width = b.height = 64;
      const x = b.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
      blobs.set(c, b);
      return b;
    }
    const glowAt = (x, y, r, c, a) => { ctx.globalAlpha = a; ctx.drawImage(blob(c), x - r, y - r, r * 2, r * 2); };
    function flash(x, y, c, r = 60, life = 0.45) { if (flashes.length < 14) flashes.push({ x, y, c, r, t: 0, life }); }

    // ---------- the warping grid: a coarse spring mesh, pinned at the edges ----------
    const grid = { cols: 0, rows: 0, gw: 0, gh: 0, W: 0, H: 0, q: -1, hot: 0, dx: null, dy: null, vx: null, vy: null };
    function ensureGrid() {
      if (grid.W === view.W && grid.H === view.H && grid.q === qual) return;
      const step = Math.max(26, Math.sqrt((view.W * view.H) / 330)) * (qual ? 1 : 1.7);   // about 330 nodes however big the field
      const cols = Math.max(4, Math.round(view.W / step) + 1), rows = Math.max(4, Math.round(view.H / step) + 1), n = cols * rows;
      Object.assign(grid, { W: view.W, H: view.H, q: qual, cols, rows, gw: view.W / (cols - 1), gh: view.H / (rows - 1), hot: 0,
        dx: new Float32Array(n), dy: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n) });
    }
    function ripple(x, y, power, radius) {   // negative power pulls in
      ensureGrid();
      const { cols, rows, gw, gh, vx, vy } = grid;
      const c0 = Math.max(1, Math.floor((x - radius) / gw)), c1 = Math.min(cols - 2, Math.ceil((x + radius) / gw));
      const r0 = Math.max(1, Math.floor((y - radius) / gh)), r1 = Math.min(rows - 2, Math.ceil((y + radius) / gh));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const nx = c * gw - x, ny = r * gh - y, d = Math.hypot(nx, ny);
        if (d >= radius || d < 0.5) continue;
        const f = (1 - d / radius) ** 2 * power / d, i = r * cols + c;
        vx[i] += nx * f; vy[i] += ny * f;
      }
      grid.hot = 4;
    }
    function stepGrid(dt) {
      ensureGrid();
      if ((grid.hot -= dt) <= 0) return;
      const { cols, rows, dx, dy, vx, vy } = grid, h = Math.min(dt, 1 / 30), K = 26, Cc = 160, D = 3.2;
      for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        vx[i] += (-K * dx[i] + Cc * (dx[i - 1] + dx[i + 1] + dx[i - cols] + dx[i + cols] - 4 * dx[i]) - D * vx[i]) * h;
        vy[i] += (-K * dy[i] + Cc * (dy[i - 1] + dy[i + 1] + dy[i - cols] + dy[i + cols] - 4 * dy[i]) - D * vy[i]) * h;
      }
      for (let i = 0, n = cols * rows; i < n; i++) { dx[i] += vx[i] * h; dy[i] += vy[i] * h; }
    }
    function drawGrid() {
      ensureGrid(); gridDraws++;
      const { cols, rows, gw, gh, dx, dy } = grid;
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 0.8; ctx.strokeStyle = C.blue; ctx.globalAlpha = 0.13 + 0.22 * clamp(gridGlow, 0, 1);
      ctx.beginPath();
      for (let r = 0; r < rows; r++) {
        const o = r * cols; ctx.moveTo(dx[o], r * gh + dy[o]);
        for (let c = 1; c < cols; c++) ctx.lineTo(c * gw + dx[o + c], r * gh + dy[o + c]);
      }
      for (let c = 0; c < cols; c++) {
        ctx.moveTo(c * gw + dx[c], dy[c]);
        for (let r = 1; r < rows; r++) ctx.lineTo(c * gw + dx[r * cols + c], r * gh + dy[r * cols + c]);
      }
      ctx.stroke();
      if (qual && grid.hot > 0) {   // nodes the blast has moved light up
        ctx.fillStyle = C.orange2;
        for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
          const i = r * cols + c, m = Math.abs(dx[i]) + Math.abs(dy[i]);
          if (m < 2.2) continue;
          ctx.globalAlpha = Math.min(0.9, m / 16); ctx.fillRect(c * gw + dx[i] - 1, r * gh + dy[i] - 1, 2, 2);
        }
      }
    }

    // ---------- quality: what the effects knobs are in each tier (eras only add: the max with what earlier eras set) ----------
    function applyFx(force) {   // force (a tier change): set the tier's values outright, even downwards
      const f = core.fx, up = (k, v) => { f[k] = force ? v : Math.max(f[k], v); };
      f.grid = 0;   // the core's flat grid would sit under ours
      up("glow", qual ? 1.9 : 1.3); up("starLayers", qual ? 3 : 2); up("trail", qual ? 14 : 6);
      up("particleMax", qual ? 650 : 300); up("burstMul", qual ? 2.2 : 1.2); up("shake", 1.5);
    }
    function govern() {   // called once per real frame with the last cost; hysteresis so it doesn't flap
      if (avg > 12) { slow++; calm = 0; } else if (avg < 7) { calm++; slow = 0; } else { slow = 0; calm = 0; }
      if (qual && slow > 45) { qual = 0; slow = 0; applyFx(true); core.float("effects: low (slow frames)", view.W / 2, view.H * 0.3, C.dim, 10, 1.6); }
      else if (!qual && calm > 600) { qual = 1; calm = 0; applyFx(true); }
    }

    // ---------- endless escalation: after the first neon wave every normal wave brings more bugs, faster ----------
    function swarm(lvl) {
      const n = Math.min(18, 1 + lvl), W = view.W, shoot = Math.max(1.3, 2.8 - 0.06 * lvl);
      for (let i = 0; i < n; i++) {
        const type = pick(["bug", "segv", "nan", "fail", "heisen"]), k = i % 3, x = rnd(50, W - 50);
        const path = k === 0 ? paths.sine({ x, amp: rnd(40, 90), vy: rnd(70, 110), phase: rnd(0, 6) })
          : k === 1 ? paths.swoop({ side: i % 2 ? 1 : -1 }) : paths.loop({ x, dir: i % 2 ? 1 : -1, vy: rnd(90, 120) });
        paths.fly(type, path, { delay: 2.4 + i * 0.7, shoot });
      }
    }

    // ---------- drawing the combo ----------
    function drawCombo() {
      const m = 1 + combo;
      if (combo < 0.2 && pulse < 0.05) return;
      const size = 14 + 8 * pulse + Math.min(4, combo), k = clamp(combo / 6, 0, 1), y = core.hudBottom + 2;   // (under the HUD's chip rows)
      const c = k > 0.6 ? C.orange2 : C.amber;
      core.txt(`×${m.toFixed(1)}`, 8, y, c, size, "left", 10, 0.75 + 0.25 * Math.sin(G.rt * 9) * (combo > 3 ? 1 : 0.3));
      core.txt("COMBO", 8 + size * 2.6, y + size * 0.4, C.dim, 9, "left", 2);
    }
    function drawCross() {
      const p = crossPos(), col = polCol(core.ikaruga ? core.ikaruga.pol() : 0), pc = planeC();
      if (aim.mode === "pointer") {   // a few dots along the line from the plane
        const dx = p.x - pc.x, dy = p.y - pc.y, d = Math.hypot(dx, dy);
        if (d > 50) for (let i = 1; i <= 4; i++) { const u = (i / 5) * (1 - 28 / d) + 28 / d * 0.5; core.drawSprite(core.sprite(["·"], 12, col, 3), pc.x + dx * u - 3.5, pc.y + dy * u - 6, 0.28); }
      }
      const sp = core.sprite(["+"], 20, col, 8), a = 0.78 + 0.22 * Math.sin(G.rt * 8);
      core.drawSprite(sp, p.x - sp.w / 2, p.y - sp.h / 2, a);
    }

    core.neon = {   // read-only, for tests and the other era
      get combo() { return combo; }, get aim() { return aim; }, get quality() { return qual; }, get avgCost() { return avg; },
      get gridDraws() { return gridDraws; }, get level() { return level; }, get shots() { return shots; }, get gridHot() { return grid.hot; },
      setQuality(q) { qual = q ? 1 : 0; applyFx(true); },
    };
    return {
      onNewGame() { combo = 0; lastKill = -9; pulse = 0; flashes = []; gridGlow = 0; hadBoss = null; level = 0; aim.mode = "none"; aim.th = 0; shots = 0; release(); },
      onWave(n) {
        flashes = []; hadBoss = null; lastLives = G.lives;
        applyFx();
        level = Math.max(0, n - core.waveOfEra(10));   // waves into the endless part (boss waves count)
        if (n % 4 !== 0 && level > 0) swarm(level);
        if (core.ikaruga) core.ikaruga.skin = () => NOSE[bucket(aim.th)];
        ripple(view.W / 2, view.H * 0.5, -260, 160);   // the wave drops in: the grid sucks in
      },
      update(dt) {
        t0 = performance.now();
        if (core.ikaruga && !core.ikaruga.skin) core.ikaruga.skin = () => NOSE[bucket(aim.th)];
        updateAim(); turnShots();
        if (G.lives < lastLives) {   // a hit landed: the combo is gone, the grid shudders
          const c = planeC();
          combo = 0; ripple(c.x, c.y, 650, 200); flash(c.x, c.y, C.red, 90, 0.6);
        }
        lastLives = G.lives;
        if (hadBoss && !G.boss) { ripple(hadBoss.x, hadBoss.y, 900, 260); flash(hadBoss.x, hadBoss.y, C.amber, 150, 0.9); G.shake = Math.max(G.shake, 8); }
        hadBoss = G.boss ? { x: G.boss.x + G.boss.w / 2, y: G.boss.y + G.boss.h / 2 } : null;
        if (G.time - lastKill > 1.1) combo = Math.max(0, combo - dt * (0.5 + 0.2 * combo));
        pulse *= Math.exp(-6 * dt); gridGlow = Math.max(0, gridGlow - dt * 0.8);
        for (const f of flashes) f.t += dt;
        if (flashes.length && flashes[0].t >= flashes[0].life) flashes = flashes.filter((f) => f.t < f.life);
        stepGrid(dt);
        if (level > 0 && G.intro <= 0 && !G.custom && !G.boss) {   // the formation steps and shoots sooner, up to double speed
          G.form.stepT -= dt * Math.min(1, 0.05 * level); G.efireT -= dt * Math.min(1, 0.06 * level);
        }
      },
      onKill(e, info) {
        const x = info.x, y = info.y, c = e.pol != null ? polCol(e.pol) : C.orange2;
        const quick = G.time - lastKill < 0.5;
        combo = Math.min(7, combo + (quick ? 0.3 : 0.12)); lastKill = G.time; pulse = 1;
        const extra = Math.round(info.points * combo);
        if (extra > 0) core.addScore(extra);
        ripple(x, y, 230, 110); gridGlow = Math.min(1.2, gridGlow + 0.35); flash(x, y, c, 48);
        core.burst(x, y, c, 8, "+*·◇"); G.shake = Math.max(G.shake, 1.8);
      },
      onBomb() { const c = planeC(); ripple(c.x, c.y, 800, 280); flash(c.x, c.y, C.amber, 160, 0.7); gridGlow = 1.2; },
      draw(layer) {
        if (layer === "bg") {
          drawGrid();
          if (qual && G.enemies.length < 90) {   // a soft bloom under every bug
            ctx.globalCompositeOperation = "lighter";
            for (const e of G.enemies) {
              if (!e.alive || e.wait) continue;
              const p = core.epos(e);
              glowAt(p.x + e.w / 2, p.y + e.h / 2, 24, e.pol != null ? polCol(e.pol) : C[core.TYPES[e.type].color] || C.text, 0.2);
            }
          }
        } else if (layer === "world") {
          if (qual) {   // under the bullets and shots (the core draws them next)
            ctx.globalCompositeOperation = "lighter";
            const P = G.player;
            glowAt(P.x + P.w / 2, P.y + P.h / 2, 26, polCol(core.ikaruga ? core.ikaruga.pol() : 0), 0.28);
            let n = 0;
            for (const b of G.ebul) { if (n++ > 120) break; glowAt(b.x, b.y + 5, 11, b.color || C.orange2, 0.4); }
            for (const s of G.shots) glowAt(s.x, s.y + 4, 11, s.pierce ? C.red : polCol(s.pol), 0.4);
          }
        } else {
          ctx.globalCompositeOperation = "lighter";
          for (const f of flashes) {
            const u = f.t / f.life;
            glowAt(f.x, f.y, f.r * (0.4 + 1.2 * u), f.c, 0.8 * (1 - u) * (1 - u));
          }
          ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
          drawCombo(); drawCross();
          if (t0) { const cost = performance.now() - t0; t0 = 0; avg += (Math.min(cost, 60) - avg) * 0.05; govern(); }
        }
      },
      hud() {
        const out = [];
        if (level > 0) out.push([`+${level} ∞`, C.dim, `+${level}∞`, 0]);
        if (!qual) out.push(["fx low", C.dim, "fx-", 0]);
        return out;
      },
    };
  },
});
})();
