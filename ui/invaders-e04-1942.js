// Bug Invaders, era 4 · 1984 1942. Non-boss waves swap the rigid grid for SQUADRONS flying curved paths (sine, loop, vee, swoop; 5-8
// bugs each) plus big "N+1 query" bombers that take several hits. X / Shift is a barrel ROLL: ~0.7 s invulnerable, 3 s cooldown (HUD
// gauge). Wipe out a whole squadron for a pattern bonus; a red one (failing tests) also drops a POW: two wingmen (-+-) that fire
// alongside you for 12 s and are lost, absorbing the hit, when you would have been hit. Boss waves keep the core's boss (they are
// never replaced); this era's squads then carry on in every later non-boss wave (cumulative).
(() => {
"use strict";
(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 4, year: 1984, name: "1942",
  blurb: "squadrons fly in on curves. [X] rolls you out of trouble. Wipe out a red squad for a POW: wingmen!",
  replaceFormation: true,   // the grid gives way to squadrons (the core never replaces a boss wave)
  init(core) {
    const { G, view, C, paths, rnd, pick, clamp } = core;
    const ROLL_T = 0.55, ROLL_INV = 0.7, ROLL_CD = 3, WING_T = 12;
    const PLANE = [" /✻\\ ", "[===]"];
    const ROLL = [PLANE, [" /✻\\ ", " [=] "], ["  ✻  ", "  |  "], [" \\✻/ ", " [=] "], [" \\✻/ ", "[===]"], PLANE];   // a barrel roll in text
    core.addType("bomber", { frames: [["  _/====\\_  ", "<=[ N+1 ]=>", "  \\_/||\\_/  "], ["  _/====\\_  ", ">=[ N+1 ]=<", "  \\_/||\\_/  "]],
      color: "orange", pts: 150, hp: 5, die: "cached", dieColor: "green", shot: "#", rank: 9, name: "N+1 query" });
    core.addPower("wingman", { label: "POW", color: "green", drop: 0, era: 4, apply(c, P) {   // by script only: a red squad drops it
      if (!W.t) W.x = [P.x - 40, P.x + P.w + 40];
      W.t = WING_T; W.cool = 0.2;
      c.float("wingmen: -+- fly escort", P.x + P.w / 2, P.y - 22, c.C.green, 12, 1.4);
    } });
    const R = { t: 0, cd: 0, dir: 1 };                       // roll: animation left, cooldown left, dash direction
    const W = { t: 0, x: [0, 0], cool: 0, ph: 0 };           // wingmen: seconds left, their x, fire timer
    const Q = { queue: [], timer: 0, squads: [] };           // squadrons still to launch, launch timer, the ones flying

    // ---- squadrons ----
    const vyK = () => Math.min(1.3, 1 + 0.03 * (G.wave - 5));   // later waves fly a bit faster
    function plan(n) {
      const S = Math.min(6, 3 + Math.floor((n - 5) / 3)), kinds = ["sine", "loop", "vee", "swoop"].sort(() => Math.random() - 0.5);
      const pool = ["bug", "todo", "nan"]; if (n >= 6) pool.push("leak"); if (n >= 9) pool.push("conflict");
      const list = [];
      for (let i = 0; i < S; i++) {
        list.push({ kind: kinds[i % kinds.length], type: i === 1 ? "fail" : pick(pool),   // squad 2 is always red: the POW one
          n: clamp(5 + (Math.random() < 0.5 ? 1 : 0) + Math.floor((n - 5) / 4), 5, 8) });
        if (i === 1) for (let b = 0; b < (n >= 9 ? 2 : 1); b++) list.push({ kind: "bomber" });
      }
      return list;
    }
    function spawnSquad(spec) {
      const W_ = view.W, H = view.H, vk = vyK();
      if (spec.kind === "bomber") {
        const sq = { total: 1, killed: 0, bomber: true, fireT: 1.6, members: [] };
        const hp = Math.min(8, 4 + Math.floor((G.wave - 5) / 4));
        sq.members.push(paths.fly("bomber", paths.sine({ x: rnd(0.3, 0.7) * W_, vy: 55 * vk, amp: 45, freq: 0.8, phase: rnd(0, 6) }), { extra: { sq, hp, bomber: true } }));
        Q.squads.push(sq); return;
      }
      const sq = { total: spec.n, killed: 0, pow: spec.type === "fail", fireT: rnd(1.4, 2.2), members: [] };
      const add = (path, delay) => sq.members.push(paths.fly(spec.type, path, { delay, extra: { sq } }));
      const side = Math.random() < 0.5 ? 1 : -1;
      if (spec.kind === "sine") {   // a snake down the screen
        const amp = Math.min(80, W_ * 0.18), p = paths.sine({ x: clamp(rnd(0.3, 0.7) * W_, amp + 30, W_ - amp - 30), vy: 105 * vk, amp: amp * side, freq: 1.5 });
        for (let i = 0; i < spec.n; i++) add(p, i * 0.34);
      } else if (spec.kind === "loop") {   // each one loops the loop in turn
        const x = side > 0 ? rnd(30, W_ - 130) : rnd(130, W_ - 30), p = paths.loop({ x, dir: side, vy: 125 * vk, r: 44, lead: 110 });
        for (let i = 0; i < spec.n; i++) add(p, i * 0.38);
      } else if (spec.kind === "vee") {   // a V, all together
        paths.vee(spec.n, { x: rnd(0.3, 0.7) * W_, vy: 100 * vk, spread: 0.12 }).forEach((p) => add(p, 0));
      } else {   // in from one side, dipping low, out the other
        const lowY = H * 0.5, from = { x: side > 0 ? -30 : W_ + 30, y: 46 }, to = { x: side > 0 ? W_ + 30 : -30, y: 62 };
        const p = paths.swoop({ side, from, to, via: { x: W_ / 2 + side * W_ * 0.1, y: 2 * lowY - 54 }, dur: 3.6 / vk });
        for (let i = 0; i < spec.n; i++) add(p, i * 0.32);
      }
      Q.squads.push(sq);
    }
    function squads(dt) {
      const live = G.enemies.reduce((n, e) => n + (e.alive && e.sq ? 1 : 0), 0);
      if (Q.queue.length) {
        if ((Q.timer -= dt) <= 0) {
          if (live <= 12) { spawnSquad(Q.queue.shift()); Q.timer = Math.max(1.6, 2.7 - 0.05 * (G.wave - 5)); }   // wait for room: never a wall of bugs
          else Q.timer = 0.3;
          if (!Q.queue.length) G.hold = false;   // the last squadron is out: now the wave may end
        }
      }
      Q.squads = Q.squads.filter((s) => s.members.some((e) => e.alive));
      const cap = 5 + Math.floor(G.wave / 3);
      for (const sq of Q.squads) {
        if ((sq.fireT -= dt) > 0) continue;
        sq.fireT = (sq.bomber ? 1.9 : rnd(1.1, 1.9)) / (1 + 0.04 * (G.wave - 5));
        const vis = sq.members.filter((e) => e.alive && !e.wait && e.y > 8 && e.y < view.H * (sq.bomber ? 0.5 : 0.6));
        if (!vis.length || G.ebul.length >= cap + (sq.bomber ? 3 : 0)) continue;
        const e = pick(vis), T = core.TYPES[e.type], x = e.x + e.w / 2, y = e.y + e.h, v = Math.min(240, 140 + 6 * G.wave);
        if (sq.bomber) for (const s of [-0.4, 0, 0.4]) core.aimedShot(x, y, v * 0.9, T.shot, C.orange, s);   // a fan
        else core.aimedShot(x, y, v, T.shot, C[T.color]);
      }
    }
    function rammed(e, info) {   // died on the plane (the core kills a bug that touches you, and a roll passes through): no pattern credit
      const b = core.bodyBox();
      return Math.abs(info.x - (b.x + b.w / 2)) < (e.w + b.w) / 2 + 4 && Math.abs(info.y - (b.y + b.h / 2)) < (e.h + b.h) / 2 + 4;
    }

    // ---- wingmen ----
    function wingmen(dt) {
      if (W.t <= 0) return;
      W.t -= dt; W.ph += dt;
      const P = G.player, tx = [P.x - 38 + Math.sin(W.ph * 2) * 4, P.x + P.w + 20 + Math.sin(W.ph * 2 + 1.5) * 4];
      for (let i = 0; i < 2; i++) W.x[i] += (clamp(tx[i], 2, view.W - 20) - W.x[i]) * Math.min(1, dt * 8);
      if ((W.cool -= dt) > 0 || G.intro > 0 || !(G.boss || G.enemies.some((e) => e.alive))) return;
      W.cool = 0.5;
      if (G.shots.reduce((n, s) => n + (s.ally ? 1 : 0), 0) >= 8) return;
      for (const x of W.x) core.playerShot({ x: x + 9, y: P.y - 2, vx: 0, vy: -430, ally: true });
    }

    return {
      onNewGame() { R.t = R.cd = 0; W.t = 0; Q.queue = []; Q.squads = []; },
      onWave(n) {
        R.t = 0; R.cd = 0; Q.queue = []; Q.squads = []; Q.timer = 0.4;
        if (G.boss || !G.custom) return;
        Q.queue = plan(n); G.hold = true;   // squads stream in from update(); the wave stays open until the last one is out
      },
      update(dt) {
        R.t = Math.max(0, R.t - dt); R.cd = Math.max(0, R.cd - dt);
        if (R.t > 0) {   // the roll is a little dash, and the plane shows the roll frame (P.skin; later eras' skins give way to it)
          G.speedMul *= 1.7;
          const f = clamp(Math.floor((1 - R.t / ROLL_T) * ROLL.length), 0, ROLL.length - 1);
          G.player.skin = { lines: ROLL[f], color: C.blue, glow: 9 }; G.player.noFlicker = true;
        }
        wingmen(dt);
        if (G.state === "play" && G.intro <= 0 && !G.boss) squads(dt);
      },
      onRoll() {
        if (R.cd > 0 || R.t > 0 || G.state !== "play") return;
        const P = G.player;
        R.t = ROLL_T; R.cd = ROLL_CD; P.inv = Math.max(P.inv, ROLL_INV);
        R.dir = core.keys.has("left") ? -1 : core.keys.has("right") ? 1 : R.dir;
        core.burst(P.x + P.w / 2, P.y + 8, C.blue, 8, "~=-");
        core.beep(520, 0.12, "square", 0.02, 500);
      },
      onPlayerHit() {   // the wingmen take the hit for you, and are gone
        if (W.t <= 0) return false;
        const P = G.player;
        W.t = 0; P.inv = Math.max(P.inv, 1);
        for (const x of W.x) core.burst(x + 9, P.y + 6, C.green, 10, "-+*");
        core.float("wingmen lost", P.x + P.w / 2, P.y - 22, C.green, 12, 1.2);
        G.shake = Math.max(G.shake, 4); core.SFX.hurt();
        return true;
      },
      onKill(e, info) {
        const sq = e.sq;
        if (!sq || rammed(e, info)) return;
        if (e.bomber) {
          const bonus = 200 * info.mult;
          core.addScore(bonus); core.float(`N+1 query cached +${bonus}`, info.x, info.y + 12, C.orange, 11, 1.6);
          if (Math.random() < 0.4 && G.powerups.length < 2) core.dropPower(info.x, info.y, true, null, true);
          return;
        }
        if (++sq.killed < sq.total) return;
        const bonus = (sq.pow ? 100 : 50) * sq.total;   // the whole squadron down: a pattern bonus
        core.addScore(bonus);
        core.float(`SQUADRON DOWN +${bonus}${sq.pow ? " · POW!" : ""}`, info.x, info.y + 12, sq.pow ? C.red : C.amber, 13, 1.8);
        if (sq.pow && G.powerups.length < 3) core.dropPower(info.x, info.y, true, "wingman", true);
        core.SFX.combo();
      },
      draw(layer) {
        const P = G.player;
        if (layer === "world" && W.t > 0 && (W.t > 3 || Math.floor(G.rt * 8) % 2)) {   // blink as they run out
          for (const x of W.x) core.drawSprite(core.sprite(["-+-"], 11, C.green, 6), x, P.y + 6);
        }
        if (layer === "world" && R.t > 0) {   // the roll: two afterimages along the dash (the plane itself wears the roll frame)
          const f = clamp(Math.floor((1 - R.t / ROLL_T) * ROLL.length), 0, ROLL.length - 1), sp = core.sprite(ROLL[f], 12, C.blue, 9);
          core.drawSprite(sp, P.x - R.dir * 24, P.y, 0.15); core.drawSprite(sp, P.x - R.dir * 12, P.y, 0.3);
        }
      },
      hud() {
        const out = [];
        if (R.cd > 0) { const n = 6, f = Math.ceil((1 - R.cd / ROLL_CD) * n); out.push([`roll [${"#".repeat(f)}${".".repeat(n - f)}]`, C.dim, `X ${f}/${n}`, 0]); }
        else out.push(["roll [X] ready", C.blue, "X●", 0]);
        if (W.t > 0) out.push([`wingmen ${Math.ceil(W.t)}s`, C.green, `WNG ${Math.ceil(W.t)}`, 1]);
        return out;
      },
    };
  },
});
})();
