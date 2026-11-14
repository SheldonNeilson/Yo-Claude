// Bug Invaders, era 2 · 1979 GALAXIAN. Formation members peel off in curved dive-bombs (fire on the way down, then fly off the
// bottom and re-enter from the top, or curl back up into their slot). A diver pays a bonus when shot (more for a lone one); a
// "senior dev" flagship shot mid-dive with its escorts pays big. The starfield twinkles. Era 3+ keep all of it (cumulative);
// it stays inert in waves that own their formation (G.custom) and in boss waves.
(() => {
"use strict";
(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 2, year: 1979, name: "GALAXIAN",
  blurb: "bugs peel off in curved dive-bombs. Shoot a senior dev mid-dive with its escorts for the big bonus.",
  fx: { starLayers: 2, glow: 1.15 },   // a second, quicker star layer; a touch more glow
  init(core) {
    const { G, view, C, TYPES, paths, rnd, pick, clamp, lerp } = core;
    // the Galaxian flagship: 6 in a formation slot (it re-centres), pays 60 in line and a fat bonus when it dives with escorts
    core.addType("senior", { frames: [["{S.DEV}", " /|  |\\"], ["{S.DEV}", " \\|  |/"]], color: "green", pts: 60, hp: 1,
      die: "LGTM, ship it", dieColor: "green", shot: "@", rank: 0, name: "senior dev" });
    const FLAG_BONUS = [300, 500, 800];   // by escorts still alive beside it
    const SKY = Array.from({ length: 44 }, () => ({ x: Math.random(), y: Math.random(), sp: rnd(7, 26), ph: rnd(0, 6.3), f: rnd(1.4, 4),
      ch: pick([".", ".", "+", "*", "'"]), col: pick(["text", "dim", "amber", "blue", "dim"]) }));
    let tDive = 3;

    const bez = (a, b, c, d, u) => {   // cubic Bezier through the view, u 0..1
      const v = 1 - u, k0 = v * v * v, k1 = 3 * v * v * u, k2 = 3 * v * u * u, k3 = u * u * u;
      return { x: k0 * a.x + k1 * b.x + k2 * c.x + k3 * d.x, y: k0 * a.y + k1 * b.y + k2 * c.y + k3 * d.y };
    };
    // One dive as a flight path (core.paths shape: { kind, dur, at(t) } -> centre + heading). Legs: wait in the slot (escorts), swing out
    // and up, cut across to a point by the plane (aimed when it commits), then either carry on off the bottom and drop back in from the
    // top ("top") or U-turn up into the slot ("pull"). The slot is read live, because the formation keeps marching meanwhile.
    function divePath(e, o) {
      const slot = () => ({ x: G.form.x + e.ox + e.w / 2, y: G.form.y + e.oy + e.h / 2 });
      let S = null, T, P1, P2, Q, v, dA = 2, dX = 0.6, xr = null;
      const dR = 1.3, dB = 1.6, pull = o.ret === "pull", up = Math.PI / 2;
      const path = { kind: "gdive", dur: 9, down: false, at };
      function begin() {
        const P = G.player, W = view.W, side = o.side;
        S = slot();
        if (!o.chain.T) o.chain.T = { x: clamp(P.x + P.w / 2 + rnd(-70, 70), 30, W - 30), y: core.bottomY + (pull ? -95 : 8) };   // the whole chain shares one aim point
        T = { x: o.chain.T.x + o.off.x, y: o.chain.T.y + o.off.y };
        P1 = { x: clamp(S.x + side * 95, 12, W - 12), y: S.y - 38 };
        P2 = { x: T.x + side * 110, y: T.y - 150 };
        dA = Math.max(1.5, 2.1 - 0.05 * (G.wave - 2));
        v = { x: (3 * (T.x - P2.x)) / dA, y: (3 * (T.y - P2.y)) / dA };   // the curve's exit velocity: carry on in the same direction
        dX = Math.max(0.2, (view.H + 30 - T.y) / v.y);
        Q = { x: T.x - side * 150, y: T.y + 55 };
        path.dur = o.delay + dA + (pull ? dB : dX + dR);
      }
      function at(t) {
        path.down = false;
        if (t < o.delay) { const s = slot(); return { x: s.x, y: s.y, a: up }; }
        if (!S) begin();
        t -= o.delay;
        if (t < dA) { path.down = true; const p = bez(S, P1, P2, T, t / dA); return { x: p.x, y: p.y, a: up }; }
        t -= dA;
        if (pull) {   // curl back up, slowing as it settles into the slot
          const u = 1 - Math.pow(1 - clamp(t / dB, 0, 1), 1.5), s = slot(), w = 1 - u;
          return { x: w * w * T.x + 2 * w * u * Q.x + u * u * s.x, y: w * w * T.y + 2 * w * u * Q.y + u * u * s.y, a: -up };
        }
        if (t < dX) return { x: T.x + v.x * t, y: T.y + v.y * t, a: up };
        t -= dX;
        const s = slot(); if (xr === null) xr = s.x;
        const u = clamp(t / dR, 0, 1), k = 1 - (1 - u) * (1 - u);   // re-entry: from above the screen, easing into the slot
        return { x: lerp(xr, s.x, k) + Math.sin(u * 9) * 14 * (1 - u), y: lerp(-22, s.y, k), a: up };
      }
      return path;
    }
    function launch(e, o) {
      o = { delay: 0, side: Math.random() < 0.5 ? 1 : -1, ret: "top", chain: {}, off: { x: 0, y: 0 }, ...o };
      e.gd = { flag: false, esc: [], shots: 0, side: o.side, fireT: rnd(0.55, 0.95) + o.delay };
      paths.attach(e, divePath(e, o), { onEnd: (x) => { paths.release(x); x.gd = null; } });
      return e;
    }
    const slotDist = (a, b) => Math.hypot(a.ox - b.ox, (a.oy - b.oy) * 1.6);
    function startDives() {
      const w = G.wave, divers = G.enemies.filter((e) => e.alive && e.gd).length;
      if (divers >= 2 + (w >= 4) + (w >= 7)) return;
      const cand = G.enemies.filter((e) => e.alive && !e.free && !e.dive && !e.gd && !e.wait);
      if (!cand.length) return;
      const ret = Math.random() < (w >= 3 ? 0.4 : 0.25) ? "pull" : "top";   // wave 2 mostly drops back in from the top; later waves curl home more
      const flags = cand.filter((e) => e.type === "senior");
      if (flags.length && divers <= 1 && Math.random() < Math.min(0.65, 0.4 + 0.04 * (w - 2))) {   // the flagship and its escorts
        const lead = pick(flags), side = Math.random() < 0.5 ? 1 : -1, chain = {};
        const n = Math.min(cand.length - 1, w >= 3 || Math.random() < 0.35 ? 2 : 1);
        const esc = cand.filter((e) => e !== lead && e.type !== "senior").sort((a, b) => slotDist(a, lead) - slotDist(b, lead)).slice(0, n);
        launch(lead, { side, ret, chain }).gd.flag = true;
        esc.forEach((e, i) => { launch(e, { side, ret, chain, delay: 0.18 * (i + 1), off: { x: (i ? 1 : -1) * 36, y: 0 } }); lead.gd.esc.push(e); });
        core.float("SENIOR DEV INCOMING", view.W / 2, view.H * 0.5, C.green, 11, 1.1);
        return;
      }
      const a = pick(cand);
      launch(a, { ret });
      if (w >= 3 && divers === 0 && cand.length > 3 && Math.random() < 0.35) {   // a twin dive from the other flank
        const b = pick(cand.filter((e) => e !== a));
        launch(b, { ret, delay: 0.35, side: -a.gd.side || 1 });
      }
    }
    function fireDivers(dt) {
      const P = G.player, cap = 5 + (G.wave >> 1);
      for (const e of G.enemies) {
        const g = e.gd;
        if (!g || !e.alive || !e.free || e.wait || !e.path || !e.path.down) continue;
        if ((g.fireT -= dt) > 0) continue;
        g.fireT = rnd(0.7, 1.2);
        if (g.shots >= (g.flag ? 3 : 2) || G.ebul.length >= cap || e.y < 16 || e.y > P.y - 70) continue;   // never point-blank: it has to be dodgeable
        const T = TYPES[e.type];
        core.aimedShot(e.x + e.w / 2, e.y + e.h, Math.min(250, 125 + 10 * G.wave), T.shot, C[T.color]);
        g.shots++;
      }
    }
    function rammed(e, info) {   // it died by flying into the plane (the core kills it on contact): no bonus for that
      const b = core.bodyBox();
      return Math.abs(info.x - (b.x + b.w / 2)) < (e.w + b.w) / 2 + 4 && Math.abs(info.y - (b.y + b.h / 2)) < (e.h + b.h) / 2 + 4;
    }
    return {
      onNewGame() { tDive = 3; },
      onWave() {
        tDive = rnd(2.8, 3.8);
        if (G.boss || G.custom) return;
        const top = Math.min(...G.enemies.map((e) => e.oy)), row = G.enemies.filter((e) => !e.free && e.oy === top).sort((a, b) => a.col - b.col);
        const m = core.measure(TYPES.senior.frames[0], 12), n = G.wave >= 4 ? 3 : 2;
        for (let i = 0; i < n && row.length > n; i++) {   // flagships: spread along the top row
          const e = row[Math.floor(((i + 0.5) / n) * row.length)];
          e.type = "senior"; e.hp = TYPES.senior.hp; e.ox += (e.w - m.w) / 2; e.w = m.w;
        }
      },
      update(dt) {
        if (G.state !== "play" || G.intro > 0 || G.boss || G.custom) return;
        fireDivers(dt);
        if (G.clearT > 0 || (tDive -= dt) > 0) return;
        tDive = Math.max(1.5, rnd(3.4, 5) - 0.3 * (G.wave - 2));   // wave 2 every ~4 s, tightening a little each wave
        startDives();
      },
      onKill(e, info) {
        const g = e.gd;
        if (!g || rammed(e, info)) return;
        const T = TYPES[e.type];
        let bonus, label;
        if (g.flag) {
          const esc = g.esc.filter((x) => x.alive && x.gd).length;
          bonus = FLAG_BONUS[esc]; label = esc ? `SENIOR DEV + ${esc} ESCORT${esc > 1 ? "S" : ""}` : "SENIOR DEV, DIVING";
        } else if (G.enemies.some((x) => x !== e && x.alive && x.gd)) { bonus = T.pts + 20; label = "diver"; }
        else { bonus = 2 * T.pts + 50; label = "LONE DIVER"; }
        bonus *= info.mult;
        core.addScore(bonus);
        core.float(`${label} +${bonus}`, info.x, info.y + 12, g.flag ? C.green : C.amber, g.flag ? 13 : 10, g.flag ? 1.8 : 1.2);
        if (g.flag) { G.shake = Math.max(G.shake, 4); core.burst(info.x, info.y, C.green, 18, "{}$"); core.SFX.combo(); }
        e.gd = null;
      },
      draw(layer) {
        if (layer !== "bg") return;   // twinkling, scrolling stars (the core's own layers are under them)
        const W = view.W, H = view.H;
        for (const s of SKY) {
          const a = 0.12 + 0.88 * Math.pow(Math.max(0, Math.sin(G.rt * s.f + s.ph)), 2);
          core.drawSprite(core.sprite([s.ch], 9, C[s.col], 2), s.x * W, (s.y * H + G.rt * s.sp) % H, a);
        }
      },
    };
  },
});
})();
