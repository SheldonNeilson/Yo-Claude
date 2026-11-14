// Bug Invaders, era 7: RAIDEN (1990). Ground ARMOUR that scrolls with the ground and shoots at you (tanks, turrets, "CI pipeline"
// trains), three guns that the W pickup cycles through (vulcan / laser / homing), a screen-clearing bomb stock (key B) and MEDALS that
// chain. The armour is this module's own list, not G.enemies: the wave still ends when the air is clear (the ground is a bonus), so the
// formation, the flight paths and every earlier era run untouched. Z (era 3's ground bomb) also splashes the armour at the bombsight.
// Eras 8+ talk to this one through G.focus (era 8's focus tightens the shot). State lives in G.rdn (also handy for tests).
// From here the gun IS the primary shot (core.primary = "raiden", core.primaryShot): era 5's composer fires it, and the options' copies of it.
(() => {
"use strict";
(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 7, year: 1990, name: "RAIDEN",
  blurb: "armour rolls in on the ground and shoots at you. [W] cycles vulcan / laser / homing, [B] clears the screen, medals chain.",
  fx: { glow: 1.3, trail: 6 },
  keys: { screenbomb: ["b"] },
  hints: ["B screen bomb"],
  init(core) {
    const { G, view, C, rnd, pick, clamp, overlap } = core;
    const ctx = core.canvas.getContext("2d");   // the game's own context (the same object the core draws with)
    const GUNS = [
      { name: "VULCAN", color: "amber", msg: "vulcan: spray and pray" },
      { name: "LASER", color: "blue", msg: "laser: one narrow, piercing commit" },
      { name: "HOMING", color: "red", msg: "homing: grep -r the bugs" },
    ];
    const KINDS = {
      tank:   { hp: 4, pts: 150, fire: 2.4, color: "green", die: "docker rm -f", medals: 1 },
      turret: { hp: 3, pts: 100, fire: 2.0, color: "amber", die: "kubectl delete", medals: 1 },
      car:    { hp: 2, pts: 60, fire: 0, color: "blue", die: "job cancelled", medals: 1 },
      loco:   { hp: 3, pts: 200, fire: 2.6, color: "red", die: "pipeline red", medals: 2 },
    };
    const TANK = ["  _|_  ", "[=-T-=]"];
    const TURRET = ["\\", "|", "/"].map((b) => ["   " + b + "   ", "[#(O)#]"]);   // the barrel follows the plane
    const WRECK = ["  ,*,  ", " (x#x) "];
    const CARS = ["[BUILD]", "[TEST]", "[LINT]", "[SCAN]", "[DEPLOY]", "[CACHE]"];
    const noop = () => {};
    // S is the one state object (G.rdn)
    const S = { units: [], medals: [], bombs: 3, wtype: 0, wlvl: 1, chain: 0, best: 0, blast: null, spawnT: 1, pickT: 4, zCool: 0, hits: 0, fresh: true };
    G.rdn = S;
    // the W pickup cycles the gun (and powers it up to level 3); the B pickup is one more screen bomb
    core.addPower("rdn_w", { label: "W", color: "red", drop: 2, era: 7, apply(c, P) {
      S.wtype = (S.wtype + 1) % GUNS.length; S.wlvl = Math.min(3, S.wlvl + 1);
      core.float(`${GUNS[S.wtype].msg} (L${S.wlvl})`, P.x + P.w / 2, P.y - 20, C[GUNS[S.wtype].color], 11, 1.5);
    } });
    core.addPower("rdn_bomb", { label: "B", color: "orange2", drop: 1, era: 7, apply(c, P) {
      if (S.bombs < 5) { S.bombs++; core.float("+1 bomb", P.x + P.w / 2, P.y - 20, C.orange2, 11, 1.3); }
      else { core.addScore(300); core.float("bomb stock full: +300", P.x + P.w / 2, P.y - 20, C.orange2, 11, 1.3); }
    } });

    // The ground scrolls at the era 3 layer's speed when that exists (read lazily: it may not be loaded), else at our own pace.
    const gSpeed = () => {
      const gl = core.groundLayer, s = gl && (typeof gl.speed === "function" ? gl.speed() : gl.speed);
      return typeof s === "number" && s >= 15 && s <= 200 ? s : 46;
    };
    const lvl = () => clamp(S.wlvl + G.weapon - 1, 1, 4);   // npm update (the core's weapon level) feeds ours too

    // ----- armour -----
    function addUnit(kind, x, y, vx, lines) {
      const K = KINDS[kind], m = core.measure(lines, 12);
      const u = { kind, K, x, y, w: m.w, h: m.h, hp: K.hp, vx, fireT: rnd(0.8, 2) + K.fire * 0.3, flash: 0, dead: false, t: 0, lines, aim: 1 };
      S.units.push(u);
      return u;
    }
    function spawnArmour(y0) {
      const W = view.W, r = Math.random();
      if (r < 0.45) addUnit("tank", rnd(30, W - 70), y0, rnd(14, 34) * (Math.random() < 0.5 ? -1 : 1), TANK);
      else if (r < 0.75) addUnit("turret", rnd(24, W - 60), y0, 0, TURRET[1]);
      else {   // a CI pipeline: a loco and a few cars crossing the ground, each car its own target
        const dir = Math.random() < 0.5 ? 1 : -1, n = 3 + (G.wave > 10 ? 1 : 0);
        let cursor = dir > 0 ? -60 : W + 60;
        for (let i = 0; i <= n; i++) {
          const label = pick(CARS), lines = i === 0 ? [dir > 0 ? "[CI/CD>" : "<CI/CD]", "o-----o"] : [label, "o" + "-".repeat(label.length - 2) + "o"];
          const u = addUnit(i === 0 ? "loco" : "car", 0, y0, 55 * dir, lines);
          u.x = dir > 0 ? cursor - u.w : cursor;
          cursor = dir > 0 ? u.x - 3 : u.x + u.w + 3;
        }
      }
    }
    function fireUnit(u, px, py) {
      const K = u.K, cx = u.x + u.w / 2, cy = u.y + 4;
      u.fireT = (K.fire * rnd(0.8, 1.3)) / (1 + 0.04 * Math.max(0, G.wave - 9));
      const dx = px - cx, dy = py + 10 - cy;
      if (u.y < 16 || u.y > core.ground - 30 || G.ebul.length > 70 || dx * dx + dy * dy < 6400) return;   // off the top, on the ground line, or point blank: no shot
      const v = Math.min(190, 125 + 4 * G.wave), a = Math.atan2(dy, dx), n = u.kind === "turret" ? 3 : 1;
      for (let i = 0; i < n; i++) { const b = a + (i - (n - 1) / 2) * 0.22; core.enemyShot(cx, cy, Math.cos(b) * v, Math.sin(b) * v, "o", C[K.color]); }
    }
    function hurt(u, dmg) {
      if (u.dead) return;
      u.hp -= dmg; u.flash = 0.07;
      if (u.hp > 0) { core.SFX.hit(); return; }
      u.dead = true; u.t = 1.6; u.vx = 0;
      const cx = u.x + u.w / 2, cy = u.y + u.h / 2, K = u.K;
      core.addScore(K.pts * core.comboHit());
      core.burst(cx, cy, C[K.color], 14, "#=+*");
      core.float(K.die, cx, cy - 6, C[K.color], 10);
      G.shake = Math.max(G.shake, 2); core.SFX.hit();
      for (let i = 0; i < K.medals; i++) if (S.medals.length < 30) S.medals.push({ x: cx + (i ? 12 : 0), y: cy, t: Math.random() * 6 });
      const r = Math.random();
      if (G.powerups.length < 2) { if (r < 0.12) core.dropPower(cx, cy, true, "rdn_w"); else if (r < 0.18) core.dropPower(cx, cy, true, "rdn_bomb"); }
    }
    const alive = () => S.units.reduce((n, u) => n + (u.dead ? 0 : 1), 0);

    // ----- medals: collect them in a row (no miss, no hit) and each is worth more -----
    function collect(m) {
      const val = 100 * Math.min(10, S.chain + 1);
      S.chain++; S.best = Math.max(S.best, S.chain);
      core.addScore(val); core.float(`+${val}`, m.x, m.y - 8, C.amber, 10, 0.9);
      core.beep(700 + 70 * Math.min(S.chain, 10), 0.05, "square", 0.02);
    }
    function breakChain(x, y) {
      if (S.chain > 1) core.float("medal chain lost", x, y, C.dim, 10, 1.2);
      S.chain = 0;
    }

    // ----- guns -----
    // The PRIMARY shot (weapon composition: era 5 calls this through core.primaryShot, from the plane and from each option; mini = an option's
    // copy: one bolt / laser / missile). Returns false if it could not fire. Shots carry `turn`: era 10 re-aims them (laser, missiles too).
    function firePlayer(cx, y, mini) {
      const P = G.player, L = lvl(), tight = G.focus ? 0.3 : 1, pierce = G.fx.pierce > 0, fast = G.fx.coffee > 0 ? 0.55 : 1;
      if (!core.shotRoom(mini ? 1 : 8)) { if (!mini) P.cool = 0.1; return false; }   // one cap for everything on screen
      if (S.wtype === 0) {   // vulcan: a fan of bolts
        const n = mini ? 1 : [3, 5, 5, 7][L - 1] + (G.fx.refactor > 0 ? 2 : 0), step = 0.16 * tight;
        for (let i = 0; i < n; i++) {
          const a = (i - (n - 1) / 2) * step;
          core.playerShot({ x: cx + (i - (n - 1) / 2) * 3 * tight, y, vx: Math.sin(a) * 520, vy: -Math.cos(a) * 520, pierce, turn: true });
        }
        if (!mini) P.cool = (L >= 4 ? 0.16 : 0.2) * fast;
      } else if (S.wtype === 1) {   // laser: narrow, fast, piercing
        const n = mini || L < 3 ? 1 : 3, dmg = L >= 4 ? 3 : L >= 2 ? 2 : 1;
        for (let i = 0; i < n; i++) core.playerShot({ x: cx + (i - (n - 1) / 2) * 9 * tight, y: y - 18, vy: -760, w: 4, h: 34, dmg, pierce: true, turn: true, draw: drawLaser });
        if (!mini) P.cool = 0.13 * fast;
      } else {   // homing: missiles that fan out and then seek (steered in update), plus a plain bolt
        const n = mini ? 1 : L >= 3 ? 4 : 2;
        for (let i = 0; i < n; i++) {
          const k = (i - (n - 1) / 2) * 2;
          core.playerShot({ x: cx + k * 4, y, vx: k * 55 * tight, vy: -260, w: 3, h: 9, dmg: 1, pierce, mis: true, turn: true, draw: drawMissile });
        }
        if (L >= 2 && !mini) core.playerShot({ x: cx, y, vy: -520, pierce, turn: true });
        if (!mini) P.cool = 0.26 * fast;
      }
      if (!mini) core.SFX.shoot();
      return true;
    }
    // (era 10 turns a shot: s.ang = its heading, 0 = up, clockwise; the sprite is drawn turned about its middle)
    const turned = (s, mid, fn) => { if (!s.ang) return fn(); ctx.save(); ctx.translate(s.x, s.y + mid); ctx.rotate(s.ang); ctx.translate(-s.x, -s.y - mid); fn(); ctx.restore(); };
    function drawLaser(s) { turned(s, 5, () => core.drawSprite(core.sprite(["║", "║", "║"], 12, C.blue, 8), s.x - 3.5, s.y - 12)); }
    function drawMissile(s) { core.drawSprite(core.sprite([s.vx < -90 ? "\\" : s.vx > 90 ? "/" : "^"], 13, C.red, 7), s.x - 3.5, s.y); }   // (it steers: the glyph follows vx)
    // a missile steers at the nearest thing above it: bugs, armour and the boss (positions gathered once a frame)
    const tx = [], ty = [];
    function targets() {
      tx.length = 0; ty.length = 0;
      for (const e of G.enemies) { if (!e.alive || e.wait) continue; const p = core.epos(e); tx.push(p.x + e.w / 2); ty.push(p.y + e.h / 2); }
      for (const u of S.units) if (!u.dead && u.y > 8) { tx.push(u.x + u.w / 2); ty.push(u.y + u.h / 2); }
      const B = G.boss;
      if (B) { tx.push(B.x + B.w / 2); ty.push(B.y + B.h / 2); }
    }
    function steer(s, dt) {
      let best = 1e9, want = null;
      for (let i = 0; i < tx.length; i++) {
        const dy = ty[i] - s.y;
        if (dy > -2) continue;
        const dx = tx[i] - s.x, d = dx * dx + dy * dy * 0.6;
        if (d < best) { best = d; want = tx[i]; }
      }
      if (want != null) s.vx += clamp(clamp((want - s.x) * 4, -340, 340) - s.vx, -950 * dt, 950 * dt);
      s.vy = Math.max(s.vy - 640 * dt, -560);
    }

    // ----- the screen-clear bomb -----
    function screenBomb() {
      const P = G.player;
      if (S.blast) return;
      if (S.bombs <= 0) { core.float("no bombs left (git stash empty)", P.x + P.w / 2, P.y - 22, C.dim, 10, 1); return; }
      S.bombs--;
      S.blast = { t: 0, x: P.x + P.w / 2, y: P.y + P.h / 2 };
      P.inv = Math.max(P.inv, 2.2); G.shake = Math.max(G.shake, 14);
      for (let i = 0; i < G.ebul.length; i += 3) core.burst(G.ebul[i].x, G.ebul[i].y, C.amber, 1, "x+.");
      G.ebul = []; G.drones = [];
      for (const u of S.units) hurt(u, 8);
      // toned down: one damage each, and only the ten lowest bugs (the ones that were about to reach you): it never skips a whole wave
      const low = G.enemies.filter((e) => e.alive && !e.wait).sort((a, b) => core.epos(b).y - core.epos(a).y).slice(0, 10);
      for (const e of low) {
        e.hp -= 1; e.flash = 0.08;
        if (e.hp <= 0) core.kill(e, true);
      }
      const B = G.boss;
      if (B) for (let i = 0; i < 4; i++) core.playerShot({ x: B.x + ((i + 0.5) * B.w) / 4, y: B.y + B.h / 2, vy: -20, w: 6, h: 12, dmg: 1, life: 0.2, draw: noop });
      core.beep(70, 0.5, "sawtooth", 0.04, -30);
      core.float(`bombs left: ${S.bombs}`, P.x + P.w / 2, P.y - 22, C.amber, 10, 1.2);
    }
    function drawBlast() {
      const B = S.blast;
      if (!B) return;
      const W = view.W, H = view.H, t = B.t / 1.2, e = 1 - (1 - t) * (1 - t), R = Math.hypot(W, H) * 0.8;
      ctx.globalAlpha = (1 - t) * (1 - t) * 0.4; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      const GL = "*#@+%&", COL = [C.amber, C.orange2, C.text];
      for (let ring = 0; ring < 2; ring++) {
        const tt = clamp((t - ring * 0.15) / (1 - ring * 0.15), 0, 1), r = (1 - (1 - tt) * (1 - tt)) * R * (1 - ring * 0.4), n = ring ? 24 : 36;
        if (tt <= 0 || tt >= 1) continue;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + tt * (ring ? -1 : 1);
          core.drawSprite(core.sprite([GL[i % GL.length]], 16, COL[(i + ring) % 3], 8), B.x + Math.cos(a) * r, B.y + Math.sin(a) * r, 1 - tt);
        }
      }
      if (t < 0.9) { ctx.globalAlpha = Math.min(1, (0.9 - t) * 3); core.bigText("GIT RESET --HARD", W / 2, H * 0.26, W * 0.8, 5, C.amber, C.orange); }
    }

    return {
      onNewGame() {
        Object.assign(S, { bombs: 2, wtype: 0, wlvl: 1, chain: 0, best: 0, blast: null, zCool: 0, hits: 0, fresh: true });
        S.units.length = 0; S.medals.length = 0; G.focus = false;
      },
      onWave() {
        S.units.length = 0; S.medals.length = 0; S.blast = null; S.spawnT = 1; S.pickT = 4; S.chain = 0; S.hits = G.hits; G.focus = false;
        core.primary = "raiden"; core.primaryShot = firePlayer;
        if (S.fresh) { S.fresh = false; S.bombs = 2; } else S.bombs = Math.max(S.bombs, 1);
        for (let i = 0; i < 2; i++) spawnArmour(rnd(20, 150));
      },
      update(dt) {
        const P = G.player, sy = gSpeed() * dt, live = G.state === "play" && G.intro <= 0 && !G.clearT;
        if (G.hits > S.hits) { S.wlvl = Math.max(1, S.wlvl - 1); breakChain(P.x + P.w / 2, P.y - 20); }
        S.hits = G.hits;
        S.zCool -= dt;
        core.primaryHoming = S.wtype === 2;
        if (S.blast && (S.blast.t += dt) >= 1.2) S.blast = null;
        // armour comes in on a timer and is wiped with the wave
        if (live && (S.spawnT -= dt) <= 0) {
          S.spawnT = (rnd(2.2, 3.6) * (G.boss ? 1.6 : 1)) / (1 + 0.04 * Math.max(0, G.wave - 9));
          if (S.units.length < 9 && alive() < 6) spawnArmour(-26);
        }
        if (G.intro <= 0 && S.pickT > 0 && (S.pickT -= dt) <= 0) {   // one W pickup per wave, so the guns always get a look
          if (G.powerups.length < 2) core.dropPower(rnd(60, view.W - 60), 24, true, "rdn_w"); else S.pickT = 1;
        }
        const px = P.x + P.w / 2, py = P.y;
        let j = 0;
        for (const u of S.units) {
          u.y += sy; u.x += u.vx * dt;
          if (u.flash > 0) u.flash -= dt;
          if (u.dead) u.t -= dt;
          else {
            if (u.kind === "tank") { if (u.x < 8) { u.x = 8; u.vx = Math.abs(u.vx); } else if (u.x + u.w > view.W - 8) { u.x = view.W - 8 - u.w; u.vx = -Math.abs(u.vx); } }
            if (u.kind === "turret") { const d = px - (u.x + u.w / 2); u.aim = d < -24 ? 0 : d > 24 ? 2 : 1; }
            if (u.K.fire && live && (u.fireT -= dt) <= 0) fireUnit(u, px, py);
          }
          const gone = u.y > view.H + 4 || (u.dead && u.t <= 0) || (u.vx > 0 && u.x > view.W + 80) || (u.vx < 0 && u.x < -u.w - 80);
          if (!gone) S.units[j++] = u;
        }
        S.units.length = j;
        // missiles and every player shot against the armour
        targets();
        for (const s of G.shots) {
          if (s.dead || s.hex || s.y < 8) continue;
          if (s.mis) steer(s, dt);
          const sw = s.w || 2, sh = s.h || 10, y0 = Math.min(s.y, s.py ?? s.y), hh = sh + Math.abs(s.y - (s.py ?? s.y));
          for (const u of S.units) {
            if (u.dead || u.y < -4 || (s.hit && s.hit.has(u)) || !overlap(s.x - sw / 2, y0, sw, hh, u.x, u.y, u.w, u.h)) continue;
            if (s.hit) s.hit.add(u); else { s.dead = true; s.y = -50; }
            hurt(u, s.dmg || 1);
            if (s.dead) break;
          }
        }
        // medals drift down; the plane collects them, one that falls off the bottom breaks the chain
        j = 0;
        for (const m of S.medals) {
          m.y += 52 * dt; m.x += Math.sin(G.time * 3 + m.t) * 22 * dt;
          if (live && overlap(m.x - 10, m.y, 20, 13, P.x - 4, P.y - 4, P.w + 8, P.h + 8)) { collect(m); continue; }
          if (m.y > view.H - 2) { breakChain(m.x, view.H - 20); continue; }
          S.medals[j++] = m;
        }
        S.medals.length = j;
      },
      onFire() {   // (era 5's composer has normally fired this event already: fireStamp; this is the fallback when it is not there)
        if (!core.charging && core.fireStamp !== G.time) firePlayer(G.player.x + G.player.w / 2, G.player.y - 8, false);
        return true;
      },
      onBomb() {   // Z: era 3's ground bomb lands at the bombsight; the armour there takes a splash too
        const P = G.player;
        if (S.zCool > 0) return;
        S.zCool = 0.5;
        const bx = P.x + P.w / 2, by = P.y - 110;
        for (const u of S.units) if (!u.dead && Math.hypot(u.x + u.w / 2 - bx, u.y + u.h / 2 - by) < 44 + u.w / 2) hurt(u, 3);
      },
      onAction(a) { if (a === "screenbomb") screenBomb(); },
      draw(layer) {
        if (layer === "bg") {
          for (const u of S.units) {
            if (u.y < -u.h || u.y > view.H) continue;
            const lines = u.dead ? WRECK : u.kind === "turret" ? TURRET[u.aim] : u.lines;
            const col = u.flash > 0 ? "#ffffff" : u.dead ? C.faint : u.hp < u.K.hp ? C.orange2 : C[u.K.color];
            core.drawSprite(core.sprite(lines, 12, col, 4), u.x, u.y, u.dead ? clamp(u.t / 1.6, 0, 1) : 1);
          }
        } else if (layer === "world") {
          for (const m of S.medals) { const sp = core.sprite(["(M)"], 11, C.amber, 7); core.drawSprite(sp, m.x - sp.w / 2, m.y, 0.7 + 0.3 * Math.sin(G.rt * 9 + m.t)); }
        } else if (layer === "fg") drawBlast();
      },
      hud() {
        const g = GUNS[S.wtype], out = [[`${g.name} L${lvl()}`, C[g.color], `${g.name.slice(0, 3)}${lvl()}`, 1], [`B screen-bomb ×${S.bombs}`, S.bombs ? C.orange2 : C.dim, `B×${S.bombs}`, 1]];
        if (S.chain > 0) out.push([`MEDAL ×${Math.min(10, S.chain + 1)}`, C.amber, `M×${Math.min(10, S.chain + 1)}`, 1]);
        return out;
      },
    };
  },
});
})();
