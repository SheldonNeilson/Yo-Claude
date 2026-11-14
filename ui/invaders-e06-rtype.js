// Bug Invaders era 6 · 1987 R-TYPE. Hold SPACE: after a short tap-fire grace the gun stops and a CHARGE builds at the nose (orb + gauge);
// release it for a piercing text-sprite BEAM (wider and harder the fuller the charge; a full one is the big ripple). The beam wipes the
// enemy bullets and drones in its way and stops at a boss, for balanced damage (full = 6, a boss has 36+ hp). F launches the FORCE pod
// "<O>": up the field, it eats enemy bullets, hurts whatever it touches (bosses too), fires while out, then comes back and docks
// (F again recalls it). WORMS (worm.exe) snake across the field as a chain of segments; shoot them one at a time, the tail pays most.
// core.charging (a hold has taken the button) silences the primary in eras 6-7; from era 8 a hold is focus and the gun keeps firing.
// Beam, pod shots and worms use only framework API; pod-vs-boss damage goes through G.boss.def.hit(B, {x, y, w, h}).
(() => {
"use strict";
const TAP = 0.28, FULL = 1.1, MIN = 0.33;   // seconds of hold that count as "charging", to fill the gauge, and the least charge that fires
const LVL = [null, { w: 12, dmg: 2, cool: 0.3 }, { w: 20, dmg: 4, cool: 0.38 }, { w: 32, dmg: 6, cool: 0.45 }];
const WORM_N = 8;

(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 6, year: 1987, name: "R-TYPE",
  blurb: "hold fire to charge the beam, let go to pierce. [F] launches the force pod. Worms snake across the field.",
  keys: { force: ["f"] }, hints: ["hold SPACE charge", "F force pod"],
  fx: { glow: 1.5, trail: 9, starLayers: 3, burstMul: 1.2 },
  init(core) {
    const { G, C, view, keys, TYPES, SFX, rnd, clamp, overlap, measure, sprite, drawSprite, txt, burst, float, addScore, playerShot, charW } = core;
    const ctx = core.canvas.getContext("2d");   // the same context the core draws with (draw hooks run inside its save / restore)
    const ghosts = [], touch = new WeakMap(), pod = { st: "dock", x: NaN, y: 0, t: 0, ty: 0, cool: 0, fireT: 0, flash: 0, bossT: 0 };
    let held = 0, charge = 0, pinged = false, tick = 0, lastLives = 3, worm = null, wormT = 4;
    const podSize = measure(["<O>"], 14);

    core.addType("wormH", { frames: [["{@_@}"], ["{@o@}"]], color: "green", pts: 30, hp: 3, die: "kill -9", dieColor: "green", shot: "~", rank: 9, name: "worm head" });
    core.addType("wormS", { frames: [["(####)"], ["(=##=)"]], color: "green", pts: 10, hp: 1, die: "freed", dieColor: "green", shot: "~", rank: 9, name: "worm segment" });
    core.addType("wormT", { frames: [["<~~~~>"], ["<-~~->"]], color: "amber", pts: 100, hp: 1, die: "free()", dieColor: "amber", shot: "~", rank: 9, name: "worm tail" });

    function reset() {
      ghosts.length = 0; held = charge = 0; pinged = false; worm = null; wormT = rnd(3, 5); lastLives = G.lives;
      Object.assign(pod, { st: "dock", x: NaN, cool: 0, flash: 0, t: 0 });
    }

    // ---------- the beam: a fast head does the hitting; a rippling column of text trails it back to the nose ----------
    function wipe(x, y, w, h) {   // enemy bullets, drones and trojans inside the rect are gone (a pierce shot would otherwise die on the first one)
      for (const b of G.ebul) if (!b.dead && b.x + 3 > x && b.x - 3 < x + w && b.y + 10 > y && b.y < y + h) { b.dead = true; burst(b.x, b.y, C.blue, 3, "x+."); }
      for (const d of G.drones) if (!d.dead && overlap(x, y, w, h, d.x, d.y, d.w, d.h)) {
        d.dead = true; addScore(15); burst(d.x + d.w / 2, d.y, C.blue, 6); float(d.die || "DONE ✓", d.x + d.w / 2, d.y, C.green);
      }
      for (const p of G.powerups) if (p.fake && !p.dead && overlap(x, y, w, h, p.x, p.y, p.w, p.h)) {
        p.dead = true; addScore(150); burst(p.x + p.w / 2, p.y, C.red, 8, "01x"); float("trojan neutralised +150", p.x + p.w / 2, p.y, C.red, 11, 1.2);
      }
    }
    const row = (n, odd) => { let s = ""; for (let j = 0; j < n; j++) { const d = Math.abs(j - (n - 1) / 2) / (n / 2); s += d < 0.3 ? (odd ? "█" : "▓") : d < 0.65 ? "▓" : "▒"; } return s; };
    const nChars = (w) => Math.max(1, Math.round(w / charW(11)));
    function drawHead(s) {
      const sp = sprite(["<" + row(nChars(s.w), false) + ">"], 12, Math.floor(G.rt * 20) % 2 ? C.text : C.blue, 12);
      drawSprite(sp, s.x - sp.w / 2, s.y);
    }
    function drawColumn(g) {
      const top = Math.max(18, g.top), a = Math.max(0, 1 - g.t / g.life), n = nChars(g.w);
      let i = 0;
      for (let y = g.oy; y > top; y -= 11, i++) {
        const rip = Math.sin(y * 0.07 - G.rt * 38) * (1.5 + g.w * 0.06), sp = sprite([row(n, i % 2 === 0)], 11, i % 3 ? C.blue : C.text, 6);
        drawSprite(sp, g.x + rip - sp.w / 2, y - 11, a * (0.55 + 0.45 * Math.sin(i * 0.9 - G.rt * 25) ** 2));
      }
    }
    function fireBeam() {
      const P = G.player, lvl = charge >= 1 ? 3 : charge >= 0.66 ? 2 : 1, L = LVL[lvl], x = P.x + P.w / 2;
      const head = playerShot({ x, y: Math.max(20, P.y - 36), vx: 0, vy: -1100, w: L.w, h: 60, dmg: L.dmg, pierce: true, ally: true, beam: lvl, life: 0.9, draw: drawHead });
      ghosts.push({ x, oy: P.y, w: L.w, top: head.y, t: 0, life: 0.2 + 0.1 * lvl, head });
      if (ghosts.length > 4) ghosts.shift();
      P.cool = Math.max(P.cool, L.cool); G.shake = Math.max(G.shake, 1.5 + 1.2 * lvl);
      burst(x, P.y - 4, C.blue, 6 + 4 * lvl, "~=*");
      core.beep(180, 0.35, "sawtooth", 0.03, 420);
      if (lvl === 3) float("WAVE CANNON", x, P.y - 30, C.blue, 12, 1.1);
    }

    // ---------- the force pod ----------
    function togglePod() {
      if (pod.st === "dock" && pod.cool <= 0) { Object.assign(pod, { st: "out", t: 0, ty: Math.max(34, G.player.y - 200), fireT: 0.2 }); core.beep(300, 0.12, "triangle", 0.025, 300); }
      else if (pod.st === "out") pod.st = "back";
    }
    function updatePod(dt) {
      const P = G.player, dx = P.x + P.w / 2, dy = P.y - 20;
      pod.cool = Math.max(0, pod.cool - dt); pod.flash = Math.max(0, pod.flash - dt);
      if (isNaN(pod.x)) { pod.x = dx; pod.y = dy; }
      if (pod.st === "dock") { pod.x += (dx - pod.x) * Math.min(1, dt * 18); pod.y += (dy - pod.y) * Math.min(1, dt * 18); }
      else if (pod.st === "out") {
        pod.t += dt;
        pod.y = Math.max(pod.ty, pod.y - 480 * dt);
        pod.x = clamp(pod.x + (dx - pod.x) * Math.min(1, dt * 1.6), 12, view.W - 12);
        if (pod.y <= pod.ty) pod.y += Math.sin(G.rt * 6) * 10 * dt;
        if ((pod.fireT -= dt) <= 0 && G.intro <= 0) { pod.fireT = 0.45; playerShot({ x: pod.x, y: pod.y - 14, vx: 0, vy: -460, ally: true, life: 1.4, col: C.orange2, draw: (s) => drawSprite(sprite(["|"], 12, C.orange2, 6), s.x - 3.5, s.y) }); }
        if (pod.t > 2.4) pod.st = "back";
      } else {   // back
        const ex = dx - pod.x, ey = dy - pod.y, d = Math.hypot(ex, ey) || 1, v = Math.min(d, 560 * dt);
        pod.x += (ex / d) * v; pod.y += (ey / d) * v;
        if (d < 14) { pod.st = "dock"; pod.cool = 0.7; }
      }
      if (G.intro > 0) return;
      const bx = pod.x - podSize.w / 2 - 2, by = pod.y - podSize.h / 2 - 2, bw = podSize.w + 4, bh = podSize.h + 4;
      for (const b of G.ebul) if (!b.dead && overlap(b.x - 3, b.y, 6, 10, bx, by, bw, bh)) { b.dead = true; pod.flash = 0.08; burst(b.x, b.y, C.orange2, 3, "x+."); }
      for (const d of G.drones) if (!d.dead && overlap(d.x, d.y, d.w, d.h, bx, by, bw, bh)) { d.dead = true; addScore(15); burst(d.x + d.w / 2, d.y, C.orange2, 6); float(d.die || "DONE ✓", d.x + d.w / 2, d.y, C.green); }
      for (const e of G.enemies) {   // it hurts what it touches: one point of damage per bug per 0.35 s
        if (!e.alive || e.wait || (touch.get(e) || -9) > G.time - 0.35) continue;
        const p = core.epos(e);
        if (!overlap(p.x, p.y, e.w, e.h, bx, by, bw, bh)) continue;
        touch.set(e, G.time); e.hp -= 1; e.flash = 0.07; pod.flash = 0.08;
        if (e.hp <= 0) core.kill(e); else { SFX.hit(); burst(pod.x, pod.y, C.amber, 3, "=<>"); }
      }
      const B = G.boss;
      if (B && B.w && G.time - pod.bossT > 0.4 && overlap(B.x, B.y, B.w, B.h, bx, by, bw, bh)) {
        pod.bossT = G.time; pod.flash = 0.08;
        B.def.hit(B, { x: pod.x, y: pod.y - podSize.h / 2, w: podSize.w, h: podSize.h });   // (may kill it: B is not touched again)
      }
    }
    function drawPod() {
      const sp = sprite([G.rt * 6 % 2 < 1 ? "<O>" : "<0>"], 14, pod.flash > 0 ? "#ffffff" : C.orange2, 10);
      drawSprite(sp, pod.x - sp.w / 2, pod.y - sp.h / 2, pod.st === "dock" ? 0.9 : 0.75 + 0.25 * Math.sin(G.rt * 12));
    }

    // ---------- worms ----------
    const wpos = (w, t) => ({ x: w.dir > 0 ? -40 + w.speed * t : view.W + 40 - w.speed * t, y: w.yc + w.amp * Math.sin(t * w.freq) });
    function spawnWorm() {
      if (worm) return;
      const w = { t: 0, dir: Math.random() < 0.5 ? 1 : -1, gap: 0.2, speed: rnd(105, 130), yc: view.H * rnd(0.24, 0.4) + 30, amp: rnd(34, 54), freq: rnd(2, 2.7),
        fireT: 1.2, killed: 0, segs: [] };
      for (let i = 0; i < WORM_N; i++) w.segs.push(core.spawnEnemy(i === 0 ? "wormH" : i === WORM_N - 1 ? "wormT" : "wormS", -99, -99, { wait: true, worm: w }));
      worm = w;
      float("worm.exe is running", view.W / 2, view.H * 0.3, C.green, 12, 1.4);
    }
    function updateWorm(dt) {
      const w = worm;
      w.t += dt * (G.fx.slow > 0 ? 0.4 : 1);
      let live = 0;
      w.segs.forEach((e, i) => {
        if (!e.alive) return;
        live++;
        const p = wpos(w, w.t - i * w.gap);
        e.x = p.x - e.w / 2; e.y = p.y - e.h / 2; e.wait = p.x < 2 || p.x > view.W - 2;
      });
      const head = w.segs[0];
      if (head.alive && !head.wait && (w.fireT -= dt) <= 0) { w.fireT = rnd(1.5, 2.3); core.aimedShot(head.x + head.w / 2, head.y + head.h, 150, "~", C.green); }
      if (!live || w.t > (view.W + 80) / w.speed + (WORM_N - 1) * w.gap) {   // gone off the far side (or all dead)
        for (const e of w.segs) if (e.alive) { e.alive = false; e.gone = true; }
        worm = null; wormT = rnd(13, 19);
      }
    }

    // ---------- charge visuals ----------
    function drawCharge() {
      if (charge <= (G.era >= 8 ? 0.4 : 0.02)) return;   // (era 8+: you hold fire all the time; show it only once a beam is worth releasing)
      const P = G.player, cx = P.x + P.w / 2, full = charge >= 1, size = 8 + 20 * charge, blink = Math.floor(G.rt * 16) % 2;
      const ch = charge < 0.25 ? "." : charge < 0.5 ? "o" : charge < 0.75 ? "O" : "@";
      txt(ch, cx, P.y - 6 - size * 0.55, full && blink ? C.text : C.blue, size, "center", 10, 0.7 + 0.3 * Math.sin(G.rt * 30));
      if (charge > 0.45) for (let i = 0; i < 3; i++) {
        const a = G.rt * 9 + (i * Math.PI * 2) / 3, r = 8 + 14 * charge;
        txt("*", cx + Math.cos(a) * r, P.y - 6 + Math.sin(a) * r * 0.7 - 5, C.blue, 9, "center", 4, 0.8);
      }
      const n = Math.round(charge * 10), left = P.x > 80;
      txt(`[${"#".repeat(n)}${".".repeat(10 - n)}]${full ? "!" : ""}`, left ? P.x - 6 : P.x + P.w + 6, P.y + 6, full && blink ? C.text : C.blue, 9, left ? "right" : "left", 4);
    }

    if (this) this.debug = { state: () => ({ held, charge, pod: { ...pod }, worm: !!worm, ghosts: ghosts.length }), spawnWorm, togglePod };

    return {
      onNewGame: reset, onWave: reset,
      update(dt) {
        const P = G.player, down = keys.has("fire") && G.intro <= 0, focus = G.era >= 8;   // era 8+: a hold is FOCUS and the gun keeps firing (twin-stick mouse fire must not go quiet)
        core.charging = down && held > TAP && !focus;   // read by the composer (era 5) and by era 7's gun: it stops the primary while a charge builds
        if (G.lives < lastLives) { charge = held = 0; if (pod.st !== "dock") { pod.st = "dock"; pod.cool = 0.7; } }
        lastLives = G.lives;
        if (down) {
          held += dt;
          if (held > TAP) {
            charge = Math.min(1, charge + dt / FULL);
            if (!focus && (tick -= dt) <= 0) { tick = 0.12; core.beep(220 + 520 * charge, 0.05, "triangle", 0.012); }
            if (charge >= 1 && !pinged) { pinged = true; core.beep(1175, 0.12, "square", 0.025); }
          }
        } else {   // let go (or the key was lost, or the wave title came up): a charge past the minimum fires, never during the title
          if (charge >= (focus ? 0.66 : MIN) && G.intro <= 0) fireBeam();   // (era 8+: only a long hold pays out a beam)
          held = charge = 0; pinged = false;
        }
        for (const g of ghosts) {
          g.t += dt;
          if (g.head) { if (g.head.dead || !G.shots.includes(g.head)) g.head = null; else g.top = g.head.y; }
          if (g.t < g.life * 0.8) wipe(g.x - g.w / 2 - 3, Math.max(0, g.top), g.w + 6, g.oy - g.top);
        }
        for (const s of G.shots) if (s.beam && !s.dead) { const y0 = s.y + s.vy * dt - 4; wipe(s.x - s.w / 2 - 3, y0, s.w + 6, s.h + s.y - y0); }   // what is ahead of the head this frame
        for (let i = ghosts.length - 1; i >= 0; i--) if (ghosts[i].t > ghosts[i].life) ghosts.splice(i, 1);
        updatePod(dt);
        if (G.intro > 0) return;
        if (worm) updateWorm(dt);
        else if (!G.clearT && (wormT -= dt) <= 0) {
          let n = 0; for (const e of G.enemies) if (e.alive) n++;
          if (G.boss || n >= 4) spawnWorm(); else wormT = 3;
        }
      },
      onFire() { return !!core.charging; },   // a tap fires the primary; a hold stops it and charges (the composer in era 5 and era 7's gun check core.charging too)
      onAction(a) { if (a === "force") togglePod(); },
      onKill(e, info) {
        const w = e.worm;
        if (w && ++w.killed >= WORM_N) { addScore(300); float("worm.exe terminated  +300", info.x, info.y - 14, C.green, 12, 1.6); }
      },
      hud() { const rdy = pod.st === "dock" && pod.cool <= 0; return [[`F force ${pod.st === "dock" ? (pod.cool > 0 ? "..." : "rdy") : pod.st}`, rdy ? C.green : C.amber, rdy ? "F●" : "F○", rdy ? 0 : 1]]; },
      draw(layer) {
        if (layer === "world") { for (const g of ghosts) drawColumn(g); drawPod(); }
        else if (layer === "fg") drawCharge();
      },
    };
  },
});
})();
