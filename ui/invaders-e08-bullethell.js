// Bug Invaders, era 8: BULLET HELL (1995, DonPachi / Batsugun). Dense but readable patterns (rings, spirals, aimed fans, curtains with a
// gap) fired from the bugs and, on boss waves, from the boss ON TOP of its own attacks. Only a small dot in the plane can be hit
// (G.player.hb), holding fire is "focus" (slower, tighter shot), bullets that scrape past the dot are GRAZES (points + the hyper meter),
// and a full meter buys a HYPER (key H): a few seconds of piercing shots and a bullet-eating aura that turns bullets into score items.
// Bullets are slower than the arcades' and the patterns ramp with the wave. Runs from era 8 on (eras 9 and 10 keep it).
// State lives in G.bh; G.focus (fire held) tightens whatever the primary shot is (era 7's gun narrows its spread; see core.primary), and with focus
// a hold no longer charges era 6's beam (the gun keeps firing; a long hold still stores one for the release).
(() => {
"use strict";
(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 8, year: 1995, name: "BULLET HELL",
  blurb: "dense patterns. Only the dot in your plane can be hit: hold fire to focus, graze bullets for points, [H] unleashes a hyper.",
  fx: { glow: 1.45 },
  keys: { hyper: ["h"] },
  hints: ["hold fire: focus", "H hyper"],
  init(core) {
    const { G, view, C, rnd, pick, clamp } = core;
    const TAU = Math.PI * 2, CAP = 280, GRAZE_R2 = 12 * 12, HYPER_R2 = 105 * 105, HYPER_SEC = 2.6;
    const HB = { w: 3, h: 3 };   // the hitbox: the core's bullets are 6x10, so a 3px box keeps a pass of ~4px honest
    const S = { graze: 0, meter: 0, hyper: 0, gain: 0, items: 0, held: 0, focus: false, t: 2, pulse: 0, gx: 0, hits: 0, last: "", streams: [], pool: [] };
    G.bh = S;

    // ----- bullet looks: one cached sprite per style, drawn straight (no per-bullet key building) -----
    const mk = (ch, color, size) => ({ ch, color, size, spr: null, k: 0, ex: null });
    const ST = {
      ring: mk("o", "orange2", 11), fan: mk("o", "red", 12), spiral: mk("·", "blue", 18), curtain: mk("·", "green", 18),
      item: mk("+", "amber", 13), dot: mk("•", "#ffffff", 22), tick: mk("·", "text", 14), fist: mk("║", "amber", 18),
    };
    function spr(st) {
      if (st.k !== view.k || !st.spr) { st.spr = core.sprite([st.ch], st.size, C[st.color] || st.color, 6); st.k = view.k; }
      return st.spr;
    }
    function drawB(b) { const s = spr(b.st); core.drawSprite(s, b.x - s.w / 2, b.y + 5 - s.h / 2); }   // centred on the core's 6x10 hit box
    for (const st of Object.values(ST)) st.ex = { draw: drawB, st, gz: false, r: 4 };   // r: a round bullet (the core tests a 4px disc against the dot, not a 6x10 box)
    const drawHS = (s) => { const p = spr(ST.fist); core.drawSprite(p, s.x - p.w / 2, s.y); };
    function shoot(st, x, y, vx, vy) { if (G.ebul.length < CAP) core.enemyShot(x, y, vx, vy, st.ch, C[st.color], st.ex); }

    // ----- difficulty: wave 10 (the first of the era) is 0, boss waves and later waves climb -----
    const level = () => clamp(G.wave - core.waveOfEra(8), 0, 10);
    const speed = (d) => Math.min(135, 88 + 4 * d);   // px/s: the arcades are well over twice that

    // ----- patterns: a stream follows its source (a bug or the boss) and ends when the shooter dies -----
    const NAMES = { ring: "ring buffer overflow", fan: "fan-out", spiral: "while(1) { spin(); }", curtain: "curtain call" };
    function pickSource() {
      const B = G.boss;
      if (B) return { boss: true, x: B.x + B.w / 2, y: B.y + B.h * 0.75, e: null };
      const c = G.enemies.filter((e) => { if (!e.alive || e.wait) return false; const p = core.epos(e); return p.y > 10 && p.y < view.H * 0.6; });
      if (!c.length) return null;
      const e = pick(c), p = core.epos(e);
      return { boss: false, x: p.x + e.w / 2, y: p.y + e.h, e };
    }
    function begin(kind, src) {
      const d = level(), s = { k: kind, x: src ? src.x : 0, y: src ? src.y : 0, e: src && src.e, boss: !!(src && src.boss), t: 0, next: 0, i: 0, d,
        a: rnd(0, TAU), rot: rnd(0, TAU), dir: Math.random() < 0.5 ? 1 : -1, dur: 0 };
      if (kind === "spiral") s.dur = Math.min(3.2, 1.7 + 0.12 * d);
      S.streams.push(s);
      S.last = kind;
      if (src && !src.boss && G.floaters.length < 6) core.float(NAMES[kind], s.x, s.y + 4, C[ST[kind].color], 9, 0.9);
    }
    function ring(s) {
      const d = s.d, n = 12 + Math.min(d, 8), v = speed(d) * (s.i ? 0.8 : 1), a0 = s.a + (s.i ? Math.PI / n : 0);
      for (let i = 0; i < n; i++) { const a = a0 + (i * TAU) / n; shoot(ST.ring, s.x, s.y, Math.cos(a) * v, Math.sin(a) * v); }
    }
    function fan(s) {   // aimed at where you are now; odd volleys are shifted half a step, so each leaves a lane open
      const P = G.player, d = s.d, n = Math.min(9, 3 + 2 * Math.floor(d / 2)), v = speed(d) + 15;
      const a = Math.atan2(P.y + P.h / 2 - s.y, P.x + P.w / 2 - s.x);
      for (let k = 0; k < n; k++) { const o = a + (k - (n - 1) / 2) * 0.17 + (s.i % 2 ? 0.085 : 0); shoot(ST.fan, s.x, s.y, Math.cos(o) * v, Math.sin(o) * v); }
    }
    function spiral(s) {
      const d = s.d, arms = 2 + (d >= 4 ? 1 : 0) + (d >= 8 ? 1 : 0), v = speed(d);
      for (let k = 0; k < arms; k++) { const a = s.rot + (k * TAU) / arms; shoot(ST.spiral, s.x, s.y, Math.cos(a) * v, Math.sin(a) * v); }
      s.rot += 0.25 * s.dir;
    }
    function curtain(s) {   // a wall of dots with one gap; the first gap is near you, the next ones drift by at most 100px
      const P = G.player, W = view.W, d = s.d, gw = P.w * Math.max(2.2, 3 - 0.1 * d), v = speed(d) * 0.85;
      const prev = s.i ? S.gx : P.x + P.w / 2 + rnd(-80, 80);
      S.gx = clamp(prev + (s.i ? rnd(-100, 100) : 0), gw / 2 + 10, W - gw / 2 - 10);
      for (let x = 10; x < W - 6; x += 14) if (Math.abs(x - S.gx) > gw / 2) shoot(ST.curtain, x, 46, 0, v);
    }
    // one frame of one stream; true = finished
    function stepStream(s, dt) {
      if (s.k !== "curtain") {
        if (s.boss) { const B = G.boss; if (!B) return true; s.x = B.x + B.w / 2; s.y = B.y + B.h * 0.75; }
        else if (s.e) { if (!s.e.alive) return true; const p = core.epos(s.e); s.x = p.x + s.e.w / 2; s.y = p.y + s.e.h; }
      }
      s.t += dt;
      if (s.k === "spiral") {
        if (s.t > s.dur) return true;
        if (s.t >= s.next) { spiral(s); s.next += 0.08; }
        return false;
      }
      if (s.t < s.next) return false;
      if (s.k === "ring") { ring(s); s.next += 0.45; return ++s.i >= (s.d >= 3 ? 2 : 1); }
      if (s.k === "fan") { fan(s); s.next += 0.4; return ++s.i >= Math.min(4, 2 + Math.floor(s.d / 4)); }
      curtain(s); s.next += 1.1; return ++s.i >= (s.d >= 5 ? 3 : 2);
    }
    function schedule(dt) {
      if (G.intro > 0 || G.clearT || G.state !== "play") return;
      if ((S.t -= dt) > 0) return;
      const d = level(), boss = !!G.boss;
      S.t = (boss ? Math.max(2.2, 3.4 - 0.2 * d) : Math.max(1.5, 2.9 - 0.22 * d)) * rnd(0.85, 1.15);
      if (S.streams.length >= 4 || G.ebul.length > 190) return;
      for (let n = d >= 4 ? 2 : 1; n > 0; n--) {
        let kind = "ring";
        for (let tries = 0; tries < 3; tries++) {
          kind = pick(boss ? ["ring", "fan", "spiral", "fan"] : d < 1 ? ["ring", "fan", "spiral", "fan", "ring"] : ["ring", "fan", "spiral", "curtain", "fan", "ring"]);   // (the blue screen and the loop already have their own walls; the first wave of the era has no wall of ~60 dots: curtains from the next one)
          if (kind !== S.last) break;
        }
        const src = kind === "curtain" ? null : pickSource();
        if (kind !== "curtain" && !src) continue;
        begin(kind, src);
      }
    }

    // ----- graze, hyper, items -----
    function toItem(b) {
      b.dead = true;
      if (S.pool.length < 150) S.pool.push({ x: b.x, y: b.y + 5, t: 0 }); else core.addScore(50);
    }
    function hyper() {
      const P = G.player;
      if (S.hyper > 0) return;
      if (S.meter < 100) { core.float(`hyper ${Math.floor(S.meter)}%: graze some more`, P.x + P.w / 2, P.y - 24, C.blue, 10, 1.1); return; }
      S.meter = 0; S.hyper = HYPER_SEC; S.pulse = 0; S.gain = 0; S.items = 0;
      P.inv = Math.max(P.inv, 1); G.shake = Math.max(G.shake, 8);
      for (const b of G.ebul) if (!b.dead) toItem(b);   // every bullet on screen becomes a score item
      core.float("HYPER!", P.x + P.w / 2, P.y - 26, C.red, 16, 1.3);
      core.beep(300, 0.4, "sawtooth", 0.03, 700);
    }
    function reset(full) {
      S.streams.length = 0; S.pool.length = 0; S.hyper = 0; S.held = 0; S.focus = false; S.t = 1.6; S.gx = 0; S.hits = G.hits; G.focus = false;
      if (full) { S.graze = 0; S.meter = 0; S.last = ""; }
    }

    return {
      onNewGame() { reset(true); },
      onWave() { reset(false); G.player.hb = HB; },
      onAction(a) { if (a === "hyper") hyper(); },
      update(dt) {
        const P = G.player, hx = P.x + P.w / 2, hy = P.y + P.h / 2;
        P.hb = HB;
        // focus: fire held for a moment (a tap keeps the wide shot and full speed)
        S.held = core.keys.has("fire") ? S.held + dt : 0;
        S.focus = S.held > 0.15 && G.intro <= 0;
        G.focus = S.focus;
        if (S.focus) G.speedMul *= 0.45;
        if (G.hits !== S.hits) {   // a hit: the field clears, you lose half the meter and get a breather
          S.hits = G.hits; S.meter = Math.max(0, S.meter - 50); S.streams.length = 0; S.t = 1.8;
        }
        schedule(dt);
        let j = 0;
        for (const s of S.streams) if (!stepStream(s, dt)) S.streams[j++] = s;
        S.streams.length = j;
        // graze (a bullet's centre inside 12px of the dot, once per bullet; not while you are invulnerable) and the hyper's bullet eater
        const live = P.inv <= 0 && G.state === "play" && G.intro <= 0;
        for (const b of G.ebul) {
          if (b.dead) continue;
          const dx = b.x - hx, dy = b.y + 5 - hy, d2 = dx * dx + dy * dy;
          if (S.hyper > 0 && d2 < HYPER_R2) { toItem(b); continue; }
          if (live && !b.gz && d2 < GRAZE_R2) {
            b.gz = true; S.graze++; core.addScore(10);
            const was = S.meter; S.meter = Math.min(100, S.meter + 2.5);
            if (was < 100 && S.meter >= 100) core.float("HYPER READY [H]", hx, hy - 26, C.red, 12, 1.4);
            core.burst(hx, hy, C.text, 1, "+");
          }
        }
        if (S.hyper > 0) {
          S.hyper -= dt; S.pulse -= dt;
          if (S.pulse <= 0 && G.shots.length < 90) { S.pulse = 0.22; for (const dx of [-9, 9]) core.playerShot({ x: hx + dx, y: P.y - 6, vy: -640, w: 14, h: 22, dmg: 1, pierce: true, draw: drawHS }); }
          if (S.hyper <= 0) { S.hyper = 0; if (S.items) core.float(`HYPER: ${S.items} items  +${S.gain}`, hx, hy - 30, C.amber, 12, 1.8); }
        }
        j = 0;
        for (const it of S.pool) {   // items hang for a beat, then fly to the plane
          it.t += dt;
          if (it.t < 0.25) it.y += 50 * dt;
          else {
            const dx = hx - it.x, dy = hy - it.y, dist = Math.hypot(dx, dy) || 1, sp = (200 + it.t * 300) * dt;
            if (dist < 16 + sp) { core.addScore(50); S.gain += 50; S.items++; continue; }
            it.x += (dx / dist) * sp; it.y += (dy / dist) * sp;
          }
          S.pool[j++] = it;
        }
        S.pool.length = j;
      },
      draw(layer) {
        if (layer === "world") {
          for (const it of S.pool) { const p = spr(ST.item); core.drawSprite(p, it.x - p.w / 2, it.y - p.h / 2, 0.6 + 0.4 * Math.sin(G.rt * 14 + it.x)); }
        } else if (layer === "fg" && G.state === "play") {
          const P = G.player, hx = P.x + P.w / 2, hy = P.y + P.h / 2;
          if (S.hyper > 0) {   // the bullet eater's edge
            const r = 105 * (0.94 + 0.06 * Math.sin(G.rt * 20)), p = spr(ST.item);
            for (let i = 0; i < 18; i++) { const a = (i / 18) * TAU + G.rt * 2; core.drawSprite(p, hx + Math.cos(a) * r - p.w / 2, hy + Math.sin(a) * r - p.h / 2, 0.55); }
          }
          if (S.focus) {   // the graze ring
            const p = spr(ST.tick);
            for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU - G.rt * 1.5; core.drawSprite(p, hx + Math.cos(a) * 12 - p.w / 2, hy + Math.sin(a) * 12 - p.h / 2, 0.6); }
          }
          const dot = spr(ST.dot);
          core.drawSprite(dot, hx - dot.w / 2, hy - dot.h / 2, 0.85 + 0.15 * Math.sin(G.rt * 12));
        }
      },
      hud() {
        const out = [[`GRAZE ${S.graze}`, C.amber, `GZ ${S.graze}`, 0]];
        out.push(S.hyper > 0 ? [`HYPER ${Math.ceil(S.hyper)}s`, C.red, `HYP ${Math.ceil(S.hyper)}s`, 2]
          : S.meter >= 100 ? ["HYPER [H]", Math.floor(G.rt * 6) % 2 ? C.red : C.amber, "HYP [H]", 2] : [`HYPER ${Math.floor(S.meter)}%`, C.blue, `HYP ${Math.floor(S.meter)}%`, 1]);
        if (S.focus) out.push(["FOCUS", C.green, "FOC", 0]);
        return out;
      },
    };
  },
});
})();
