// Bug Invaders era 5 · 1985 GRADIUS. Red bugs, when a whole squad of them is wiped out (and now and then by luck), drop a capsule "(P)".
// Each capsule moves the lit cell of the POWER-UP METER along the bottom of the field one slot on (SPEED · MISSILE · DOUBLE · LASER ·
// OPTION · SHIELD, skipping slots that are full). C spends the lit cell. Dying loses the upgrades but one (the mercy). Stack traces fall
// and memory-leak blobs drift down the field: weave through them (shoot the traces; only a charged beam clears a blob).
// Shots made here are "ally" shots, so they never count against the core's shot cap in fire(). core.groundLayer (era 3, read lazily):
// missiles also home on ground units and call groundLayer.hurt(t, dmg) on them.
// Weapon composition (docs: "Weapon composition"): onFire here is the composer for every era from 5 on: one primary shot (core.primaryShot when era 7's gun is on),
// then a copy from each option and the missiles. Era 7 takes the LASER / DOUBLE slots' job (they are skipped from era 7).
(() => {
"use strict";
const SLOTS = [
  { id: "speed", name: "SPEED", max: 3 }, { id: "missile", name: "MISSILE", max: 1 }, { id: "double", name: "DOUBLE", max: 1 },
  { id: "laser", name: "LASER", max: 1 }, { id: "option", name: "OPTION", max: 2 }, { id: "shield", name: "SHIELD", max: 1 },
];
const SHIELD_HP = 3, MAX_CAPS = 2, MAX_HAZ = 4, MAX_MISSILES = 8, MAX_LASERS = 12;
const TRACES = [["TypeError:", " at run()", " at main()"], ["Error: ENOENT", " at open()", " at <anon>"], ["RangeError:", " call stack", " exceeded"],
  ["NullPointer", " at <init>", " at null"], ["Segmentation", " fault (core", " dumped)"], ["Unhandled", " promise", " rejection"]];
const BLOBS = [["  .~~~~~.  ", " ( malloc ) ", "  '~~~~~'  "], ["  .~~~~~.  ", " ( leak!! ) ", "  '~~~~~'  "]];
const TRACE_DIE = ["caught", "try/catch", "handled", "logged and ignored"];

(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 5, year: 1985, name: "GRADIUS",
  blurb: "wipe out red squads for capsules that light the meter along the bottom. [C] spends the lit slot. Weave through the stack traces.",
  keys: { meter: ["c"] }, hints: ["C power-up"],
  fx: { glow: 1.3, trail: 6, starLayers: 3 },
  caps: { bottomPad: 16 },   // the plane's lowest row (and the deadline) rise above the meter strip along the bottom
  init(core) {
    const { G, C, view, TYPES, SFX, paths, rnd, pick, clamp, overlap, measure, sprite, drawSprite, txt, burst, float, addScore, playerShot, playerHit, bodyBox, epos } = core;
    const ctx = core.canvas.getContext("2d");   // the same context the core draws with (draw hooks run inside its save / restore)
    const cap = [], haz = [], hist = [], squads = new Map();
    let lv = { speed: 0, missile: 0, double: 0, laser: 0, option: 0 }, lit = -1, shieldHp = 0, lastLives = 3, flip = false, mT = 0, hazT = 3, squadT = 5, squadId = 0;
    const capSize = measure(["(P)"], 12);

    core.addType("e5err", { frames: [["{ERR!}", " \\/\\/ "], ["{ERR!}", " /\\/\\ "]], color: "red", pts: 30, hp: 1, die: "caught ✓", dieColor: "green",
      shot: "!", rank: 9, name: "unhandled error" });

    function reset() {   // a new game: nothing owned, nothing lit
      lv = { speed: 0, missile: 0, double: 0, laser: 0, option: 0 }; lit = -1; shieldHp = 0; lastLives = G.lives; flip = false; mT = 0;
      clearField();
    }
    function clearField() {   // a wave starts: the things in flight go, what you own stays
      cap.length = 0; haz.length = 0; hist.length = 0; squads.clear(); hazT = rnd(2.5, 4); squadT = rnd(4, 7); lastLives = G.lives;
    }
    const levelOf = (i) => (SLOTS[i].id === "shield" ? (shieldHp > 0 ? 1 : 0) : lv[SLOTS[i].id]);
    // from era 7 the gun is Raiden's: its own levels replace our laser / double barrel, so those two slots are skipped (they never light)
    const maxed = (i) => (SLOTS[i].id === "shield" ? shieldHp >= SHIELD_HP : lv[SLOTS[i].id] >= SLOTS[i].max || (G.era >= 7 && (SLOTS[i].id === "laser" || SLOTS[i].id === "double")));

    // ---------- the meter ----------
    function collect(x, y) {   // a capsule: light the next slot that still has room
      SFX.power();
      for (let k = 1; k <= SLOTS.length; k++) {
        const i = (lit + k + SLOTS.length) % SLOTS.length;
        if (maxed(i)) continue;
        lit = i; float(`${SLOTS[i].name} lit: press C`, x, y - 8, C.amber, 11, 1.3);
        return;
      }
      addScore(500); float("meter full: +500", x, y - 8, C.amber, 11, 1.3);
    }
    function spend() {
      if (lit < 0) return core.beep(160, 0.07, "square", 0.02);
      const P = G.player, x = P.x + P.w / 2, y = P.y - 24, id = SLOTS[lit].id;
      if (id === "speed") { lv.speed++; float(`SPEED UP ×${lv.speed}`, x, y, C.green); }
      else if (id === "missile") { lv.missile = 1; float("MISSILES: they find the bugs", x, y, C.orange2); }
      else if (id === "double") { lv.double = 1; lv.laser = 0; float("DOUBLE: a second barrel", x, y, C.orange2); }
      else if (id === "laser") { lv.laser = 1; lv.double = 0; float("LASER: pierces the line", x, y, C.blue); }
      else if (id === "option") { lv.option++; float(`OPTION ×${lv.option}: (o) copies your fire`, x, y, C.orange2); burst(x, y, C.orange2, 8, "(o)"); }
      else { shieldHp = SHIELD_HP; float(`FORCE FIELD ×${SHIELD_HP}`, x, y, C.blue); }
      lit = -1; SFX.power();
    }
    function loseUpgrades() {   // Gradius cruelty, with a mercy: one of what you owned survives (at level 1)
      const have = SLOTS.map((s, i) => i).filter((i) => levelOf(i) > 0), keep = have.length ? pick(have) : -1, P = G.player;
      if (!have.length) return;
      for (const s of SLOTS) if (s.id !== "shield") lv[s.id] = 0;
      shieldHp = 0;
      if (keep >= 0) { const id = SLOTS[keep].id; if (id === "shield") shieldHp = 1; else lv[id] = 1; }
      float(`upgrades lost${keep >= 0 ? ", kept " + SLOTS[keep].name : ""}`, P.x + P.w / 2, P.y - 40, C.dim, 10, 1.6);
    }

    // ---------- shots made here ----------
    const drawBolt = (s) => drawSprite(sprite([s.vx < -60 ? "\\" : s.vx > 60 ? "/" : "|"], 12, s.col, 6), s.x - 3.5, s.y);
    const bolt = (x, y, vx, vy, col) => playerShot({ x, y, vx, vy, ally: true, col, life: 1.6, draw: drawBolt });
    function drawLaser(s) { const sp = sprite(["║", "║", "║", "║"], 12, C.blue, 8); drawSprite(sp, s.x - sp.w / 2, s.y - 2); }
    const laser = (x, y) => playerShot({ x, y: Math.max(20, y - 50), vx: 0, vy: -900, w: 3, h: 56, pierce: true, ally: true, laser: true, life: 0.9, draw: drawLaser });
    function drawMissile(s) {
      const sp = sprite(["^", "|"], 11, C.orange2, 6);
      ctx.save(); ctx.translate(s.x, s.y + 5); ctx.rotate(Math.atan2(s.vx, -s.vy)); drawSprite(sp, -sp.w / 2, -sp.h / 2); ctx.restore();
    }
    const missile = (x, y, vx) => playerShot({ x, y, vx, vy: -120, w: 6, h: 10, dmg: 2, ally: true, missile: true, tt: 0, life: 3, draw: drawMissile });
    const count = (key) => { let n = 0; for (const s of G.shots) if (s[key]) n++; return n; };

    // ---------- options: orbs that replay where the plane was a moment ago ----------
    function record() {
      const P = G.player, o = hist.length >= 90 ? hist.shift() : {};
      o.x = P.x + P.w / 2; o.y = P.y + P.h / 2; o.t = G.time; hist.push(o);
    }
    function optPos(k) {
      const P = G.player, want = G.time - 0.16 * (k + 1);
      let h = hist[0] || null;
      for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= want) { h = hist[i]; break; }
      return { x: (h ? h.x : P.x + P.w / 2) + (k % 2 ? 30 : -30), y: (h ? h.y : P.y + P.h / 2) + 8 + Math.sin(G.rt * 3 + k * 2) * 2 };
    }

    // ---------- missiles: home on the nearest air target, boss or (era 3) ground unit ----------
    function groundList() {
      const gl = core.groundLayer, l = gl && gl.active !== false ? gl.targets : null;
      return Array.isArray(l) ? l.filter((t) => t && !t.dead) : [];
    }
    function aim(s, grounds) {
      let best = null, bd = 1e9;
      const eye = (x, y, air) => {
        if (air && (y > s.y + 30 || y < 6)) return;   // air targets only ahead of it (and on screen); ground units anywhere
        const d = (x - s.x) ** 2 + (y - s.y) ** 2;
        if (d < bd) { bd = d; best = { x, y }; }
      };
      for (const e of G.enemies) if (e.alive && !e.wait) { const p = epos(e); eye(p.x + e.w / 2, p.y + e.h / 2, true); }
      const B = G.boss;
      if (B && B.w) { const t = B.def.aim ? B.def.aim(B, s) : { x: B.x + B.w / 2, y: B.y + B.h / 2 }; eye(t.x, t.y, true); }
      if (G.ufo) eye(G.ufo.x + G.ufo.w / 2, G.ufo.y + G.ufo.h / 2, true);
      for (const g of grounds) eye(g.x + g.w / 2, g.y + g.h / 2, false);
      return best;
    }
    function steerMissiles(dt) {
      const grounds = lv.missile || count("missile") ? groundList() : [];
      for (const s of G.shots) {
        if (!s.missile || s.dead) continue;
        if ((s.tt -= dt) <= 0) { s.tt = 0.18; const t = aim(s, grounds); s.tx = t ? t.x : null; s.ty = t ? t.y : 0; }
        let tvx = 0, tvy = -380;
        if (s.tx != null) { const dx = s.tx - s.x, dy = s.ty - s.y, d = Math.hypot(dx, dy) || 1; tvx = (dx / d) * 340; tvy = (dy / d) * 340; }
        const a = 850 * dt;
        s.vx += clamp(tvx - s.vx, -a, a); s.vy += clamp(tvy - s.vy, -a, a);
        for (const g of grounds) {   // it came down on a ground unit
          if (!overlap(s.x - 3, s.y, 6, 10, g.x, g.y, g.w, g.h)) continue;
          s.dead = true; core.groundLayer.hurt(g, 2); burst(s.x, s.y, C.orange2, 6, "*+");
          break;
        }
      }
    }

    // ---------- hazards ----------
    function spawnHazard() {
      const blob = Math.random() < 0.35, lines = blob ? pick(BLOBS) : pick(TRACES), size = blob ? 13 : 10, m = measure(lines, size);
      haz.push({ blob, lines, size, w: m.w, h: m.h, x: rnd(10, Math.max(11, view.W - m.w - 10)), y: -m.h - 4, vx: blob ? 0 : rnd(-35, 35),
        vy: blob ? rnd(34, 48) : rnd(85, 125), hp: blob ? 6 : 3, seed: Math.random() * 6, t: 0, flash: 0 });
    }
    function updateHazards(dt) {
      const bb = bodyBox();
      for (const h of haz) {
        h.t += dt; h.flash = Math.max(0, h.flash - dt);
        h.y += h.vy * dt * (G.fx.slow > 0 ? 0.4 : 1);
        h.x = clamp(h.x + (h.blob ? Math.sin(h.t * 0.9 + h.seed) * 42 : h.vx) * dt, 2, view.W - h.w - 2);
        if (h.y > view.H) { h.dead = true; continue; }
        for (const s of G.shots) {   // your shots vs it: a trace takes damage; a blob swallows everything but a charged beam
          if (s.dead || s.hex || !overlap(s.x - (s.w || 2) / 2, s.y, s.w || 2, s.h || 10, h.x, h.y, h.w, h.h)) continue;
          if (s.hit && s.hit.has(h)) continue;
          const dmg = s.dmg || 1;
          if (h.blob && dmg < 4) { if (!s.pierce) { s.dead = true; burst(s.x, s.y, C.green, 2, "~."); } continue; }
          if (s.hit) s.hit.add(h); else s.dead = true;
          h.hp -= dmg; h.flash = 0.08;
          if (h.hp <= 0) {
            h.dead = true; addScore(h.blob ? 100 : 25); burst(h.x + h.w / 2, h.y + h.h / 2, h.blob ? C.green : C.amber, 10, h.blob ? "~o." : "!@#");
            float(h.blob ? "free()" : pick(TRACE_DIE), h.x + h.w / 2, h.y, C.green, 10, 1);
            break;
          }
        }
        if (h.dead || G.intro > 0) continue;
        if (overlap(h.x + 3, h.y + 2, h.w - 6, h.h - 4, bb.x, bb.y, bb.w, bb.h)) {
          if (!h.blob) { h.dead = true; burst(h.x + h.w / 2, h.y + h.h / 2, C.amber, 10, "!@#"); }
          playerHit(1, h);
          if (G.state !== "play") return;
        }
      }
      for (let i = haz.length - 1; i >= 0; i--) if (haz[i].dead) haz.splice(i, 1);
    }

    // ---------- squads and capsules ----------
    function others() { let n = 0; for (const e of G.enemies) if (e.alive && !e.squad5) n++; return n; }
    function spawnSquad() {
      const id = ++squadId, n = 5, x = rnd(90, Math.max(91, view.W - 90)), conga = Math.random() < 0.5;
      const list = conga ? Array.from({ length: n }, () => paths.sine({ x, y: -20, vy: 105, amp: 70, freq: 1.8 })) : paths.vee(n, { x, y: -20, vy: 100, dx: 36 });
      list.forEach((p, i) => paths.fly("e5err", p, { delay: conga ? i * 0.38 : 0, shoot: 2.6, extra: { squad5: id } }));
      squads.set(id, { n, dead: 0 });
    }
    function drop(x, y) { if (cap.length < MAX_CAPS) cap.push({ x: clamp(x - capSize.w / 2, 4, view.W - capSize.w - 4), y, t: 0, seed: Math.random() * 6 }); }
    function updateCaps(dt) {
      const P = G.player;
      for (const c of cap) {
        c.t += dt; c.y += 58 * dt; c.x = clamp(c.x + Math.sin(c.t * 2 + c.seed) * 26 * dt, 4, view.W - capSize.w - 4);
        if (overlap(c.x, c.y, capSize.w, capSize.h, P.x, P.y, P.w, P.h)) { c.dead = true; collect(c.x + capSize.w / 2, c.y); }
        else if (c.y > view.H) c.dead = true;
      }
      for (let i = cap.length - 1; i >= 0; i--) if (cap[i].dead) cap.splice(i, 1);
    }

    // ---------- drawing ----------
    function drawMeter() {
      const n = SLOTS.length, cw = Math.min(88, (view.W - 12) / n), x0 = (view.W - cw * n) / 2, y = view.H - 15;
      const blink = Math.floor(G.rt * 4) % 2;
      SLOTS.forEach((S, i) => {
        const x = x0 + i * cw, on = i === lit, lvl = levelOf(i), full = maxed(i);
        const col = on ? C.bg : lvl ? C.green : C.dim, label = S.name + (lvl ? (S.max > 1 ? " " + lvl : " *") : "");
        if (on) { ctx.globalAlpha = blink ? 0.95 : 0.7; ctx.fillStyle = C.amber; ctx.fillRect(x, y, cw - 3, 11); ctx.globalAlpha = 1; }
        ctx.strokeStyle = on ? C.amber : full ? C.green : C.faint; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cw - 4, 10);
        txt(label, x + (cw - 3) / 2, y + 1.5, col, 9, "center", on ? 0 : lvl ? 3 : 0);
      });
    }
    function drawWorld() {
      for (const h of haz) {
        const a = h.blob ? 0.6 + 0.2 * Math.sin(G.rt * 4 + h.seed) : 1;
        drawSprite(sprite(h.lines, h.size, h.flash > 0 ? "#ffffff" : h.blob ? C.green : h.hp < 3 ? C.orange : C.amber, h.blob ? 8 : 4), h.x, h.y, a);
      }
      for (const c of cap) drawSprite(sprite(["(P)"], 12, C.orange2, 9), c.x, c.y, 0.7 + 0.3 * Math.sin(G.rt * 9));
      for (let k = 0; k < lv.option; k++) {
        const p = optPos(k), sp = sprite(["(o)"], 12, C.orange2, 8);
        drawSprite(sp, p.x - sp.w / 2, p.y - sp.h / 2);
      }
    }
    function drawShield() {
      if (shieldHp <= 0) return;
      const P = G.player, a = 0.3 + 0.18 * shieldHp + 0.12 * Math.sin(G.rt * 7), cx = P.x + P.w / 2;
      txt("(", P.x - 11, P.y - 6, C.blue, 26, "left", 8, a); txt(")", P.x + P.w + 3, P.y - 6, C.blue, 26, "left", 8, a);
      txt("~".repeat(3 + shieldHp), cx, P.y - 12, C.blue, 10, "center", 6, a);
    }

    // test hook: the registry entry carries it (this is the module object); not used by the game
    if (this) this.debug = { grant: (n = 1) => { for (let i = 0; i < n; i++) collect(G.player.x, G.player.y); }, spend, state: () => ({ lv: { ...lv }, lit, shieldHp, caps: cap.length, haz: haz.length, hist: hist.length }),
      drop: (x, y) => drop(x, y), spawnHazard, spawnSquad };

    return {
      onNewGame: reset, onWave() { clearField(); core.primary = "gradius"; },
      update(dt) {
        G.speedMul *= 1 + 0.18 * lv.speed;
        record();
        if (G.lives < lastLives) loseUpgrades();
        lastLives = G.lives;
        mT -= dt;
        if (G.intro > 0) return;
        steerMissiles(dt);
        if (!G.clearT) {
          if ((hazT -= dt) <= 0) { hazT = rnd(3.2, 5.5) * (G.boss ? 1.6 : 1); if (haz.length < MAX_HAZ) spawnHazard(); }
          if ((squadT -= dt) <= 0) {
            squadT = rnd(14, 20) * (G.boss ? 1.4 : 1);
            if ((G.boss || others() >= 4) && !G.enemies.some((e) => e.alive && e.squad5)) spawnSquad(); else squadT = 3;
          }
        }
        updateHazards(dt); updateCaps(dt);
        G.shots = G.shots.filter((s) => !s.dead);   // (shots a hazard or a missile used up this frame must not also hit something in the core's pass)
      },
      onFire() {   // the composer (weapon composition, see core.primary): ONE primary shot, then the extras ride along on whatever fired
        core.fireStamp = G.time;
        if (core.charging) return true;   // a charge (era 6) has the button: no primary, no extras
        const P = G.player, cx = P.x + P.w / 2, gun = core.primaryShot;   // gun: era 7's weapon when it is on
        let fired;
        if (gun) fired = gun(cx, P.y - 8, false);
        else if (lv.laser) { P.cool = G.fx.coffee > 0 ? 0.11 : 0.2; fired = count("laser") < MAX_LASERS; if (fired) { laser(cx, P.y); SFX.shoot(); } }
        else { core.fire(); fired = P.cool > 0; }
        if (!fired) return true;
        if (lv.double && !lv.laser && !gun) { flip = !flip; bolt(cx, P.y - 8, flip ? 210 : -210, -380, C.orange2); }
        if (lv.missile && mT <= 0 && !core.primaryHoming && core.shotRoom(12) && count("missile") < MAX_MISSILES) { mT = 0.85; missile(P.x + 2, P.y, -80); missile(P.x + P.w - 2, P.y, 80); }
        for (let k = 0; k < lv.option; k++) {
          const p = optPos(k);
          if (gun) gun(p.x, p.y - 8, true); else if (lv.laser) laser(p.x, p.y); else bolt(p.x, p.y - 8, 0, -440, C.blue);
        }
        return true;
      },
      onAction(a) { if (a === "meter") spend(); },
      onKill(e, info) {
        const T = TYPES[e.type], red = T && T.color === "red", sq = e.squad5 && squads.get(e.squad5);
        if (sq) {
          if (++sq.dead >= sq.n) { squads.delete(e.squad5); drop(info.x, info.y); float("squad cleared: capsule!", info.x, info.y - 10, C.amber, 11, 1.4); }
          return;
        }
        if (e.sq && red && e.sq.killed >= e.sq.total && !e.sq.cap5) { e.sq.cap5 = true; drop(info.x, info.y); return; }   // era 4's red squads too
        if (Math.random() < (red ? 0.15 : 0.04)) drop(info.x, info.y);
      },
      onPlayerHit() {   // the force field takes it
        if (shieldHp <= 0) return false;
        const P = G.player;
        shieldHp--; P.inv = Math.max(P.inv, 0.6); G.shake = Math.max(G.shake, 3);
        burst(P.x + P.w / 2, P.y, C.blue, 12, "()~"); SFX.hit();
        float(shieldHp ? "force field holds" : "force field down", P.x + P.w / 2, P.y - 22, C.blue, 11, 1.1);
        return true;
      },
      hud() { return shieldHp > 0 ? [[`shield ×${shieldHp}`, C.blue, `SHLD×${shieldHp}`, 2]] : []; },
      draw(layer) { if (layer === "world") { drawMeter(); drawWorld(); } else if (layer === "fg") drawShield(); },   // (the meter in the world layer: era 7's ground armour is drawn in bg and scrolls through the bottom strip)
    };
  },
});
})();
