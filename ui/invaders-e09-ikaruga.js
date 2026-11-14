// Bug Invaders era 9, 2001 IKARUGA: polarity. The plane is orange or blue (V flips it); every enemy bullet and most bugs carry a colour
// too. A bullet of YOUR colour is absorbed into the gauge, a bullet of the OTHER colour kills you; your shots do double damage to the
// opposite colour and half to your own. N releases the gauge as homing shots. Three same-colour kills in a row score a chain bonus.
// Everything is inside this closure (see docs/bug-invaders-eras.md, "Framework API"). It talks to the neon era (invaders-e10-neon.js)
// through `core.ikaruga` only: { pol(), color(p), skin, energy(), chain(), lasers() }; era 10 sets `skin` (a function returning the plane's lines) to turn the nose.
(() => {
"use strict";
(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 9, year: 2001, name: "IKARUGA", blurb: "two colours. [V] flips yours: absorb your own colour, fear the other. [N] fires what you absorbed.",
  keys: { polarity: ["v"], release: ["n"] },
  hints: ["V polarity", "N release"],
  init(core) {
    const { G, C, rnd, pick, clamp, overlap, epos, TYPES, view } = core;
    const PLAYER = [" /✻\\ ", "[===]"];   // what the core draws (we paint over it in the plane's colour)
    const MORPH = 0.32, ENERGY_MAX = 12, PER_BULLET = 1 / 3, LASER_DMG = 2.5, ROW = 30;
    const col = (p) => (p ? C.blue : C.orange2);   // 0 = orange, 1 = blue (read C each time: the palette is re-read on show)
    let pol = 0, morph = 0, morphFrom = 0, energy = 0, chain = { pol: -1, n: 0, k: 0 }, lasers = [], absorbT = 0, absorbed = 0;

    // The first hits of the era must not teach by killing: its first wave is slower and the gauge starts a quarter full.
    const firstWave = () => G.wave === core.waveOfEra(9);
    const friendly = () => clamp(0.65 - 0.03 * (G.wave - core.waveOfEra(9)), 0.4, 0.65);   // chance a shooter-less bullet matches you
    const reset = () => { pol = 0; morph = 0; energy = 0; chain = { pol: -1, n: 0, k: 0 }; lasers = []; absorbT = 0; absorbed = 0; };

    function tagEnemies() {
      for (const e of G.enemies) {
        if (!e.alive || e.pol !== undefined) continue;
        e.pol = e.free ? (Math.random() < 0.8 ? (Math.random() < 0.5 ? 0 : 1) : null) : (Math.round(e.oy / ROW) + G.wave) & 1;   // rows alternate
      }
    }
    // a bullet takes its shooter's colour (the bug whose muzzle it left), else a roll that leans your way early on
    function shooterPol(b) {
      let best = null, bd = 900;   // 30 px
      for (const e of G.enemies) {
        if (!e.alive || e.wait || typeof e.pol !== "number") continue;
        const p = epos(e), dx = b.x - (p.x + e.w / 2), dy = b.y - (p.y + e.h), d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = e; }
      }
      return best ? best.pol : Math.random() < friendly() ? pol : 1 - pol;
    }
    function tagBullet(b, src) {   // src: the bug that fired it (onEnemyBullet), when there is one that carries a colour
      b.pol = src && typeof src.pol === "number" ? src.pol : shooterPol(b); b.color = col(b.pol);
      if (firstWave()) { b.vx *= 0.85; b.vy *= 0.85; }
    }
    const tagAll = tagEnemies;   // (bullets are tagged as they are fired, in onEnemyBullet)
    const isBullet = (s) => s && typeof s.vx === "number" && typeof s.vy === "number" && s.ch != null && s.type === undefined;

    // ---- shots: your colour, and the damage the polarity rule gives the bug each is about to hit ----
    function shotGlyph(s) { return s.vx < -40 ? "\\" : s.vx > 40 ? "/" : "|"; }
    function drawShot(s) { core.drawSprite(core.sprite([shotGlyph(s)], 12, s.pierce ? C.red : col(s.pol), 6), s.x - 3.5, s.y); }
    function tagShots(dt) {
      for (const s of G.shots) {
        if (s.pol === undefined) {
          s.pol = pol; s.dmg0 = s.dmg || 1;
          if (!s.draw && !s.hex) { s.draw = drawShot; s.e9 = true; }
        }
        // predict the first bug this frame's move reaches (the core resolves hits right after its own move)
        const nx = s.x + s.vx * dt, ny = s.y + s.vy * dt, sw = s.w || 2, sh = s.h || 10;
        let f = 1;
        for (const e of G.enemies) {
          if (!e.alive || e.wait || typeof e.pol !== "number" || (s.hit && s.hit.has(e))) continue;
          const p = epos(e);
          if (overlap(nx - sw / 2, ny, sw, sh, p.x, p.y, e.w, e.h)) { f = e.pol === s.pol ? 0.5 : 2; break; }
        }
        s.dmg = s.dmg0 * f;
      }
    }

    // ---- absorbing: your colour touching the whole plane is eaten (the opposite colour still needs the small hit box) ----
    function absorb(b) {
      b.dead = true;
      const P = G.player;
      energy = Math.min(ENERGY_MAX, energy + PER_BULLET);
      absorbed++; core.addScore(5);
      core.burst(b.x, b.y, col(b.pol), 2, "+·");
      if ((absorbT -= 1) <= 0) { absorbT = 4; core.beep(1180 + energy * 40, 0.04, "sine", 0.012); }
      if (energy >= ENERGY_MAX && Math.random() < 0.15) core.float("FULL: [N]", P.x + P.w / 2, P.y - 24, col(pol), 11, 0.9);
    }
    function absorbScan() {
      const P = G.player;
      for (const b of G.ebul) {
        if (b.dead || b.pol !== pol) continue;
        if (overlap(b.x - 3, b.y, 6, 10, P.x - 1, P.y, P.w + 2, P.h)) absorb(b);
      }
    }

    // ---- release: the gauge becomes homing shots that fly through bullets (they are not in G.shots, so bullets can't trade with them) ----
    function release() {
      const P = G.player, n = Math.floor(energy);
      if (n < 1) { core.float("gauge empty: absorb your colour", P.x + P.w / 2, P.y - 24, C.dim, 10, 1); return; }
      energy -= n;
      const cx = P.x + P.w / 2, cy = P.y;
      for (let i = 0; i < n; i++) {
        const a = n > 1 ? -1.25 + (2.5 * i) / (n - 1) : 0;
        lasers.push({ x: cx, y: cy, vx: Math.sin(a) * 300, vy: -Math.cos(a) * 300, t: 0, pol, trail: [] });
      }
      core.float(`RELEASE ×${n}`, cx, P.y - 26, col(pol), 13, 1.1);
      core.burst(cx, cy, col(pol), 10, "◆*+");
      core.beep(260, 0.25, "sawtooth", 0.025, 700);
      G.shake = Math.max(G.shake, 3);
    }
    function nearestTarget(l) {
      let best = null, bd = 1e12;
      for (const e of G.enemies) {
        if (!e.alive || e.wait) continue;
        const p = epos(e), cx = p.x + e.w / 2, cy = p.y + e.h / 2;
        if (cy < 4 || cy > view.H) continue;
        const d = (cx - l.x) ** 2 + (cy - l.y) ** 2;
        if (d < bd) { bd = d; best = { x: cx, y: cy, e }; }
      }
      if (best) return best;
      const B = G.boss;
      if (!B) return null;
      const t = B.def.aim ? B.def.aim(B, { x: l.x, y: l.y }) : { x: B.x + B.w / 2, y: B.y + B.h / 2 };
      return { x: t.x, y: t.y, boss: B };
    }
    function stepLasers(dt) {
      for (const l of lasers) {
        l.t += dt;
        const tg = nearestTarget(l);
        let sp = Math.min(560, 300 + l.t * 380), a = Math.atan2(l.vx, -l.vy);   // heading, 0 = up
        if (tg) {
          const want = Math.atan2(tg.x - l.x, -(tg.y - l.y));
          let d = want - a; d = Math.atan2(Math.sin(d), Math.cos(d));
          a += clamp(d, -8 * dt, 8 * dt) * (l.t > 0.12 ? 1 : 0.2);   // a moment of spread first, then they lock on
        }
        l.vx = Math.sin(a) * sp; l.vy = -Math.cos(a) * sp;
        l.trail.unshift(l.x, l.y); if (l.trail.length > 10) l.trail.length = 10;
        l.px = l.x; l.py = l.y; l.x += l.vx * dt; l.y += l.vy * dt;
        if (l.t > 3.2 || l.x < -10 || l.x > view.W + 10 || l.y < 6 || l.y > view.H) { l.dead = true; continue; }
        for (const e of G.enemies) {
          if (!e.alive || e.wait) continue;
          const p = epos(e);
          if (!overlap(l.x - 4, l.y - 4, 8, 8, p.x, p.y, e.w, e.h)) continue;
          l.dead = true; e.hp -= LASER_DMG; e.flash = 0.07;
          if (e.hp <= 0) core.kill(e); else { core.beep(300, 0.05, "square", 0.02); core.burst(l.x, l.y, col(l.pol), 4, "=<>"); }
          break;
        }
        const B = G.boss;
        if (!l.dead && B && B.def.hit(B, { x: l.x, y: l.y, px: l.px, py: l.py, w: 8, h: 8 })) {
          l.dead = true; core.burst(l.x, l.y, col(l.pol), 4);
          if (G.boss === B) B.def.hit(B, { x: l.x, y: l.y, px: l.px, py: l.py, w: 8, h: 8 });   // a second point of damage: they are the payoff
        }
      }
      if (lasers.some((l) => l.dead)) lasers = lasers.filter((l) => !l.dead);
    }

    function flip() {
      const P = G.player;
      morphFrom = pol; pol ^= 1; morph = MORPH;
      core.burst(P.x + P.w / 2, P.y + P.h / 2, col(pol), 8, "◆+*");
      core.beep(pol ? 520 : 400, 0.07, "square", 0.02, pol ? 260 : -120);
    }

    // the plane in the polarity colour: P.skin (the core draws it, blink and all); era 10 supplies the turned nose. Only the morph brackets are ours.
    function setSkin() {
      const P = G.player, ik = core.ikaruga;
      if (P.skin) return;   // (era 4's roll frames, say)
      P.skin = { lines: G.era >= 10 && ik.skin ? ik.skin() : PLAYER, color: morph > 0 && Math.floor(G.rt * 20) % 2 ? col(morphFrom) : col(pol), glow: 8 };
    }
    function drawMorph() {
      const P = G.player;
      if (G.state === "play" && morph > 0) {   // the morph: two brackets fly out
        const m = morph / MORPH, d = 6 + (1 - m) * 26, cy = P.y + P.h / 2 - 11;
        core.txt("(", P.x - d, cy, col(pol), 22, "left", 6, m); core.txt(")", P.x + P.w + d - 8, cy, col(pol), 22, "left", 6, m);
      }
    }

    core.ikaruga = { pol: () => pol, color: col, skin: null, energy: () => energy, chain: () => chain.n, lasers: () => lasers.length };
    return {
      onNewGame() { reset(); },
      onWave() {
        lasers = []; chain = { pol: -1, n: 0, k: 0 }; morph = 0;
        if (firstWave() && energy < 4) energy = 4;
        const f = core.fx; f.glow = Math.max(f.glow, 1.3); f.starLayers = Math.max(f.starLayers, 2);   // eras only ever add to the look
        tagAll();
      },
      update(dt) {
        morph = Math.max(0, morph - dt);
        tagAll(); tagShots(dt); setSkin();
        absorbScan();
        if (lasers.length) stepLasers(dt);
      },
      onAction(a) { if (a === "polarity") flip(); else if (a === "release") release(); },
      onEnemyBullet(b, src) { if (b.pol === undefined) tagBullet(b, src); },
      onPlayerHit(src) {
        if (isBullet(src)) {
          if (src.pol === undefined) tagBullet(src);
          if (src.pol === pol) { absorb(src); return true; }   // the same colour that slipped through the small box
        }
        chain = { pol: -1, n: 0, k: 0 };   // a hit that lands breaks the chain
        return false;
      },
      onKill(e) {
        if (typeof e.pol !== "number") return;
        const P = G.player;
        if (chain.pol === e.pol) chain.n++; else chain = { pol: e.pol, n: 1, k: 0 };
        if (chain.n % 3 === 0) {
          chain.k = Math.min(8, chain.n / 3);
          const bonus = 150 * chain.k;
          core.addScore(bonus);
          core.float(`${e.pol ? "BLUE" : "ORANGE"} CHAIN ×${chain.k}  +${bonus}`, view.W / 2, view.H * 0.4 - chain.k * 3, col(e.pol), 13, 1.5);
          core.beep(700 + chain.k * 60, 0.09, "square", 0.025);
        }
      },
      draw(layer) {
        if (layer === "bg") { tagAll(); return; }   // (before the core draws the bullets: they must already wear their colour)
        if (layer === "world") {
          for (const e of G.enemies) {   // each bug repainted in its colour, exactly over the core's sprite
            if (!e.alive || e.wait || typeof e.pol !== "number") continue;
            const T = TYPES[e.type], fr = e.free ? Math.floor(G.rt * 3) % 2 : G.form.frame, lines = e.hp < T.hp ? T.hurt[fr] : T.frames[fr], p = epos(e);
            const blink = T.flicker && Math.sin(G.rt * 2.4 + e.col * 0.9 + e.oy * 0.05) < -0.35;
            core.drawSprite(core.sprite(lines, 12, e.flash > 0 ? "#ffffff" : col(e.pol)), p.x, p.y, blink ? 0.12 : 1);
          }
          for (const l of lasers) {
            for (let i = 2; i < l.trail.length; i += 2) core.drawSprite(core.sprite(["·"], 12, col(l.pol), 4), l.trail[i] - 3.5, l.trail[i + 1] - 6, 0.6 * (1 - i / l.trail.length));
            core.drawSprite(core.sprite(["◆"], 12, col(l.pol), 8), l.x - 4.5, l.y - 6);
          }
          return;
        }
        for (const b of G.ebul) if (b.draw && b.pol !== undefined) core.drawSprite(core.sprite(["◦"], 12, col(b.pol), 4), b.x - 3.5, b.y - 1);   // custom-drawn bullets get a colour pip
        drawMorph();
      },
      hud() {
        const n = Math.floor(energy), cells = Math.round(energy / 2), out = [[`◆ ${pol ? "BLUE" : "ORANGE"} [V]`, col(pol), `◆${pol ? "BLU" : "ORG"}`, 2],
          [`[${"#".repeat(cells)}${".".repeat(6 - cells)}] [N]${n >= ENERGY_MAX ? " FULL" : ""}`, n >= 1 ? col(pol) : C.dim, `[${"#".repeat(cells)}${".".repeat(6 - cells)}]`, 1]];
        if (chain.n > 0) out.push([`CHAIN ${"●".repeat(chain.n % 3)}${"○".repeat(3 - (chain.n % 3))}${chain.k ? ` ×${chain.k}` : ""}`, col(chain.pol), `${"●".repeat(chain.n % 3)}${"○".repeat(3 - (chain.n % 3))}${chain.k ? `×${chain.k}` : ""}`, 1]);
        return out;
      },
    };
  },
});
})();
