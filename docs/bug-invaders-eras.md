# Bug Invaders: the arcade-history ladder

The user's brief (verbatim): "There were these games that I used to play when I was younger where you piloted a plane. There were
air and ground enemies. You could move forwards and backwards as well as left and right. It would be super cool if Bug Invaders
incrementally morphs into a more and more modern game while retaining its "retro" feel. Every turn should be a "modernization"
through arcade game history. Make it happen. Inside Yo Claude and on neilson.co.za."

Two copies of one game: Yo Claude (`ui\invaders*.js|css` in this repo, loaded by `ui\index.html`) and the web page
(`..\Neilson\site\bug-invaders\`, `window.INVADERS_STANDALONE = true`). **Edit only in YoClaude\ui**; the site copy is
produced by `YoClaude\scripts\sync-invaders.ps1`. Everything must work in both.

## The retro feel is a hard rule
Everything stays glowing monospace text sprites (`sprite()` / `drawSprite()` / `txt()`), the app palette `C`, square-wave beeps,
dev jokes (bugs, merge conflicts, failing tests, "git revert" power-ups). Modernization = *mechanics and layered effects*
(more movement, more bullets, glow, parallax, trails, particles), never swapping to smooth vector art or bitmaps.

## One "turn" = one wave. The era of a wave
`era(wave) = min(10, wave - floor(wave / 4))` i.e. boss waves (every 4th) replay the current era's rules, and the next normal wave
steps the era up. After era 10 the game is endless with everything on. Eras are **cumulative**: an era adds to the previous ones
unless it says it replaces something. Each new era opens with a banner ("1982 · XEVIOUS — now the plane flies up and down, and
the ground shoots back. [Z] bombs") and a short CRT glitch/morph. The title screen lets you start in any era you have reached
(stored in localStorage, `store.get("era")`), and `_debug.startEra(n)` jumps straight there for tests.

| # | Year | Ancestor | What changes (on top of everything before) |
|---|------|----------|---------------------------------------------|
| 1 | 1978 | Space Invaders | Today's game: formation, shields, left/right only, one shot. |
| 2 | 1979 | Galaxian | Formation members peel off in curved dive-bombs (aimed, swooping, return or fly off), twinkling scrolling starfield, bonus score for diving kills. |
| 3 | 1982 | Xevious / Scramble | **The plane.** Free flight inside the lower part of the field: up, down, left, right. Ground scrolls beneath (parallax); **ground targets** (dev-joke structures: `[CI]` runner, `[SRV]` rack, `{CRON}`, `[LOG]` pile) that only a **bomb** (Z / second button) can hit, with a bombsight marker ahead of the plane. Air bugs still attack from above. Shields retire. |
| 4 | 1984 | 1942 | Squadrons fly in on curved **flight paths** (sine, loop, swoop, vee) instead of one rigid grid; **roll / loop dodge** (Shift or X): brief invulnerability with a cooldown; wingman power-up. |
| 5 | 1985 | Gradius | **Power-up meter**: collected capsules light a bar (SPEED · MISSILE · DOUBLE · LASER · OPTION · ?) and you spend it. Trailing "options" that copy your moves. Scrolling hazards. |
| 6 | 1987 | R-Type | **Charge beam**: hold fire to charge, release for a piercing beam; a detachable "force" pod; bug "worms" snake across the screen. |
| 7 | 1990 | Raiden | Ground armour (tanks, turrets) plus air; weapon choice (vulcan / laser / homing), **screen-clear bomb stock**, **medals** that chain for score. |
| 8 | 1995 | Bullet hell (DonPachi / Batsugun) | Dense, readable bullet patterns (rings, spirals, aimed fans); the **hitbox shows as a dot**, you move slower with fire held (focus), **graze** score for near misses, hypers. |
| 9 | 2001 | Ikaruga | **Polarity**: two colours (orange / blue); same-colour bullets are absorbed (and charge a homing release), opposite colour kills you and does double damage. |
| 10 | 2004+ | Geometry Wars / modern neon | Twin-stick feel: aim with the mouse (or keys) while moving, combo multiplier, geometry-wars grid, particle storms, bloom. Final form; everything above stays on. |

Visual modernization rides along (see `core.fx` knobs in the framework): glow radius, starfield layers, plane trails, particle
count, screen shake, a faint grid, scanline strength. Era 1 is flat and plain; era 10 is a light show, still in text sprites.

## Rules for every era (these break easily; read them)
1. **Movement is decided by the framework, not by eras.** Keys: arrows / WASD move (up/down only when the era allows vertical
   movement; era 1-2 lock the plane to the bottom row), **Space = fire**, **Z = bomb** (era 3+), **X or Shift =
   roll** (era 4+), **C** meter (5), **F** force (6), **B** screen bomb (7), **H** hyper (8), **V** polarity flip (9), **N** gauge release (9),
   mouse / **I J K** aim (10), **P** pause, **M** sound, **L** scores. `ArrowUp`/`W` must no longer mean fire. The standalone touch pad gains
   up/down/bomb buttons (they appear with the era that needs them).
2. **Nothing may assume `G.player.y` is the bottom.** The lose check ("bugs shipped to production"), shield erasing, the ground
   line and `placePlayer()` (called on every resize, panes open and close in Yo Claude) must use the framework's fixed `ground`
   line and keep a vertical position proportionally on resize.
3. **Don't break the host.** Auto-pop, hiding when a card needs the user, Esc never reaching the app, the `narrow` class under 640
   px, the "peek" sliver, the paused-until-clicked behaviour, sound off by default, `window.invaders.*` API.
4. **Leaderboard.** `gSend` rows keep their shape (scores.php is on the live site). Later eras will score much higher; fine.
5. **Cumulative and replaceable.** An era module registers hooks; the core decides which are active (`era >= n`). A module must be
   inert below its era and must reset its state on `newGame()` / `startWave()`.
6. **Keep the dev-joke cast.** New enemies are bugs of some kind (race condition, deadlock, off-by-one, null pointer, 404, flaky
   test, regex, YAML indentation...), ground targets are infrastructure. Death words are jokes ("PASS ✓", "free()").
7. **Performance.** Sprites are cached by (text, size, colour); keep new per-frame allocations small; cap particles.
8. **Code style.** Match `invaders.js`: terse, comments explain why, no new globals beyond the registry, everything inside a
   closure, `"use strict"`.
9. **Testing is short and consolidated** (the workspace testing rule): one check per agent: load the standalone page, `startEra(n)`,
   `_debug.step(10)` with scripted keys, no console errors, one screenshot saved for the user. Do not re-run passing checks.

## File layout
```
ui/invaders.js                core + framework (era registry, movement, banner, ground line, helpers)  [framework agent]
ui/invaders.css
ui/invaders-e02-galaxian.js   one file per era (or pair), each registers itself:
ui/invaders-e03-xevious.js    window.INVADERS_ERAS.push({ n, year, name, blurb, init(core) { return hooks } })
ui/invaders-e04-1942.js ...
scripts/sync-invaders.ps1     copies ui/invaders*.js|css to Neilson\site\bug-invaders\, stamps ?v= on the script tags
```
Era files load *before* `invaders.js` (they only push onto `window.INVADERS_ERAS`); `invaders.js` calls each module's `init(core)`
once at startup and then calls its hooks. The framework agent defines `core` and the hooks and documents them at the top of
`invaders.js` and in section "Framework API" below.

## Framework API
Everything below is implemented in `ui/invaders.js` (search "era framework"). Era agents: write ONLY your own `ui/invaders-eNN-name.js`,
then run `scripts/sync-invaders.ps1` and test. Do not edit `invaders.js` / `.css` (ask the framework owner for a missing hook).

### Eras, waves and the registry
- `era(wave) = min(10, wave - floor(wave/4))`: waves 1,2,3,4(boss) = eras 1,2,3,3; 5,6,7,8(boss) = 4,5,6,6; 9,10,11,12(boss) = 7,8,9,9; 13+ = 10.
  First wave of era n (`core.waveOfEra`): 1, 2, 3, 5, 6, 7, 9, 10, 11, 13. Note era 1 is only wave 1 and era 2 only wave 2.
- Your file must be `(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({ n, year, name, blurb, init(core) { return hooks; } })`
  inside an IIFE, nothing else global. `init` runs once at startup (after the whole core exists); the hooks object it returns is yours.
  Several modules may share one `n` (they run in load order). Optional module fields: `caps: {}`, `fx: {}`, `keys: {}`, `hints: []`,
  `replaceFormation` (below). `year`, `name`, `blurb` replace the built-in banner text ("1982 · XEVIOUS" + blurb).
- **Cumulative / inert rules.** A module is *active* while `G.era >= n`. Active hooks run lowest era first, except the claim hook
  `onPlayerHit`, which runs highest era first and stops at the first `true` (`onFire` is different, see the table). Below its era a module gets no hook except
  `onNewGame` (called for EVERY module at every new game, so its state is clean and waiting) and `onInert` (below). Reset the rest of your state in
  `onWave(n)` too (a wave may start at any time: the era select starts mid-ladder). A hook that throws is logged
  (`[invaders] era N hook threw`) and that whole module is switched off for the session: check the console.
- **What the table turns on by itself** (before any module): era 3: `caps.move2d`, `caps.bomb`, `caps.shields = false`; era 4: `caps.roll`.
  Everything else (era 2's dives, ground targets, ...) is yours. Caps and fx are rebuilt from the table plus every active module's `caps` / `fx`
  objects at the start of EVERY wave, so put static settings in the module's `caps` / `fx` fields; values you poke into `core.caps` / `core.fx`
  at runtime last only until the next wave.
- Banner: on the first wave of a new era the intro (`G.intro`) is 3.8 s instead of 2.6 s and shows the era banner, a CRT tear and a rising beep.
  Nothing may attack or fire while `G.intro > 0` (the core already blocks the player's fire and the formation).
- Bosses: their hit points are multiplied by era (x1.4 from era 5, x2 era 6, x3 era 7, x3.5 era 8, x4 era 9, x4.5 era 10: `BOSS_HP` in `invaders.js`) because the guns grow; the sway of a boss slows on fields wider than 640 so it never outruns the plane. Boss waves use the era of the wave before.
- Best era reached: `store` key `"era"` (`core.store.get("era", 1)`); the title and game-over screens let you pick an era up to it with
  left / right; `newGame(era)` starts at its first wave. `_debug.startEra(n)` jumps anywhere without recording it.

### Hooks (all optional; `this` is your hooks object)
| Hook | Called | Notes |
|---|---|---|
| `onNewGame()` | `newGame()`, all modules | reset all state |
| `onWave(n)` | end of every `startWave(n)` (also boss waves), active modules only | the formation / boss / shields for the wave already exist (or the wave is `custom`, below). Spawn here. |
| `update(dt)` | start of every play frame (also during the wave intro; not when paused or on the title) | before movement: set `core.G.speedMul` (reset to 1 every frame) for focus / SPEED. Don't attack while `G.intro > 0`. |
| `draw(layer)` | `"bg"`: behind everything in the field (before the ground line, shields, bugs). `"world"`: after bugs / boss / drones / power-ups, before shots, bullets and the plane. `"fg"`: after particles and floaters, before the HUD | each call is inside `ctx.save()/restore()`. Draw with `core.sprite/drawSprite/txt`. |
| `onFire()` | each time fire is held, `P.cool <= 0`, `G.intro <= 0` (about every 0.32 s while held) | **Every** active module's `onFire` runs on every fire event (lowest era first). A `true` return only suppresses the core's DEFAULT shot (`core.fire()`), never another module's hook: Raiden's gun does not shadow Gradius' options or R-Type's charge. Return `true` = "I handled the default shot" (set `P.cool` yourself or you are called every frame). Nothing returned lets the default shot happen too (if nobody returns true). Module field `exclusiveFire: true` restores the old claim rule for that one module: its `onFire` runs first (highest era first among such modules) and its `true` ends the event (no other hook runs, no default shot). |
| `onBomb()` | Z pressed (edge), `caps.bomb`, not paused, `G.intro <= 0` | the core has no bomb: you implement it |
| `onRoll()` | X / Shift pressed (edge), `caps.roll` | e.g. set `P.inv`; the core's `playerHit` respects `P.inv` |
| `onInert()` | once, when the module's era is left (a debug jump or new game that starts below it; the module is no longer active) | drop what it left on the screen / on `core.*` objects. `onNewGame` / `onWave` still reset its state; this is for what lingers (a canvas style, a body class, a skin you set). |
| `onKill(e, info)` | after `kill(e)` scored (`info = { x, y, points, mult }`) | formation bugs, divers, your own |
| `onPlayerHit(src)` | a hit that WOULD land (not invulnerable, game running) | return `true` to absorb it (no life lost; a bullet is already gone). `src` = the bullet / drone / bug / power-up / boss that did it. Called before the firewall. |
| `onPlayerDied(livesLeft)` | every lost life (after the hit landed and `G.lives` dropped; not for an absorbed hit or the firewall's save), before game over | `livesLeft` can be 0 or less on the last one (game over follows). |
| `onEnemyBullet(b, src)` | whenever the core pushes a bullet into `G.ebul` (formation fire, boss shots, `core.aimedShot`, `core.enemyShot`) | cheap: tag the bullet (`b.pol = ...`). `src` = the bug / boss that fired it (`extra.src` for `core.enemyShot`), may be undefined. Bullets a module pushes into `G.ebul` by hand are not announced. |
| `onKey(action, down)` | every key action edge during play (down and up), incl. `"fire"`, `"left"`, touch buttons | for hold / release (charge beam) |
| `onAction(action)` | keydown of an action you declared in `keys` that the core doesn't know | e.g. `hyper` |
| `hud()` | each frame while drawing the HUD | return `[[text, colour, short?, prio?], ...]`: chips in the rows under the top line (at most TWO rows, wrapped to the field's width: if they do not fit, every chip's `short` text (default: `text`) and a smaller font are used, then the lowest `prio` chips are dropped: 0 = informational, 1 = default, 2 = power-up timers). Keep `text` under ~16 chars and `short` under ~8. `core.hudBottom` is where the chips end |
| `replaceFormation` | a property (or a function `(wave) => bool`) on the hooks or the module; checked at the start of each non-boss wave | `true`: the core skips `buildFormation`, `stepFormation` and its own bullet fire (`G.custom = true`); you spawn bugs in `onWave`. Boss waves are never replaced. |

`keys: { action: ["z", "shift", "ArrowLeft"...] }` (or `action: { keys: [...], label: "METER" }`, see the touch pad below) merges into the key map (both cases of letters; names `shift space enter tab arrowup...`). Keys the core already
owns (arrows, WASD, space, Enter, P, M, L, G, Tab, Z = bomb, X = roll, Shift = roll, Esc) are never taken over (a console warning says so).
Final key map: arrows / WASD move, Space fire, Z bomb (3+), X or Shift roll (4+), C meter (5), F force (6), B screen bomb (7), H hyper (8), V polarity (9), N gauge release (9), mouse / I J K aim (10), P pause, M sound, L scores.
`hints: ["C hyper"]` appends text to the key hint line under the cabinet (the core already adds `Z bomb` / `X roll` from the caps).

### Weapon composition (eras 5, 6, 7, 8, 10 all fire: ONE gun)
One rule, so `onFire` of several eras never stacks into mush. `core.primary` is `"core"` (default: `core.fire()`), `"gradius"` (era 5 on) or `"raiden"` (era 7 on); the owner
also sets `core.primaryShot(x, y, mini)` (fires the primary from (x, y), returns false when it could not; `mini` = an option's smaller copy) and `core.primaryHoming`.
`core.charging` is true while a hold has taken the button. The core resets all of these at every wave start (set them from `onWave` / `update`).
- **Era 5's `onFire` is the composer.** It fires the primary once at the plane, then the extras ride on it: a copy from each OPTION (`primaryShot(opt.x, opt.y, true)`: one bolt / laser / missile), the
  MISSILES (not when the primary already homes, not when `core.shotRoom(12)` says the screen is full). With no era 7: the primary is the core bolt, or the LASER slot; DOUBLE is a second barrel.
- **Era 7's `firePlayer` is the primary from era 7** (vulcan / laser / homing; its levels already include `npm update`). Era 5's DOUBLE and LASER slots are skipped from era 7 (they would do nothing).
  Era 7's own `onFire` is only a fallback for a build without era 5 (`core.fireStamp === G.time` says the composer already fired).
- **Era 6, the charge.** Eras 6-7: tap = primary, hold longer than 0.28 s = the gun stops and the charge builds (`core.charging`), release = beam. From era 8 a hold is FOCUS (era 8), so the primary keeps
  firing (era 10's mouse-hold fire would otherwise go silent after 0.3 s) and a hold of ~1 s still stores a beam, released with the button.
- **Era 8's focus** is `G.focus`: the primary narrows (era 7's fan: spread x0.3), the plane slows. **Era 10's aim** turns every shot with `turn: true` (era 7's bolts, lasers and missiles; era 9 and 10 own
  look for plain bolts); beams, option bolts of other eras and ally shots fly straight.
- **Caps:** `core.shotRoom(n)` (64 player shots in all) is the one limit modules check; the core's own `fire()` still has its 2-in-flight rule.

### Movement and the field (done by the core; eras must not move the plane themselves)
Arrows / WASD move, Space fires; `ArrowUp`/`W` no longer fire. Up/down act only when `caps.move2d` (the range opens smoothly over ~1 s: `G.lift`
0..1). Speed 220 (coffee 340) times `G.speedMul`, diagonals normalised. `core.bottomY` = top of the plane on the bottom row = the deadline where
shipped bugs end the run and where shields stand (bugs lose at `y + h >= bottomY`; shields sit at `bottomY - 70`); `core.ground` = the drawn ground
line (`view.H - 3`); `core.flightTop` .. `core.flightBottom` (= `bottomY`) = the plane's y range (`caps.flightFrac`, default 0.55 of the field height, from the
bottom; era 10 may raise it). All are getters: read them every time (they follow resizes; the plane keeps its height in proportion, `P.fy`).
With `caps.move2d` bodies hurt: touching a formation bug or the boss costs a life (a bug dies, `kill(e, true)`); a free bug always does.
Contact: ramming a free bug (or any formation bug from era 3) costs a life; eras 1-2 kill the bug, from era 3 it takes **1 damage** (at most one per bug per 0.7 s) so a 5-hp bomber survives; set `caps.contactKills = true` (era module `caps`) for the old kill-whatever-the-hp rule. Bosses keep their own contact rule.
`caps.bottomPad` (px, default 0; era 5 sets 16) lifts `bottomY` (the plane's lowest row and the shipped deadline) above a strip an era draws along the bottom (the meter).
`G.player.hb = { w, h }` shrinks what enemy bullets AND contact can hit to a centred box (the era-8 dot; pick-ups still use the whole plane);
`core.bulletBox()` / `core.bodyBox()` return the boxes in use.
Player look and transient state: `G.player.skin = { lines, color, glow }` replaces the plane's sprite (lines default `[" /✻\ ", "[===]"]`, colour the palette orange / coffee orange2, glow 7; era 9's overpainting still works); `G.player.noFlicker = true` stops the blink while invulnerable. `G.player.hb`, `G.player.skin`, `G.player.noFlicker`, `G.focus` and `G.speedMul` are cleared by the core in `newGame()` and at the start of every `startWave()` (after `onInert` of eras left behind, before the active modules' `onWave`): set them from `onWave` / `update`, not once at init. Mouse aim (era 10): `core.canvas` and `core.toView(clientX, clientY)` -> view coordinates.

### Bugs of your own
- `core.addType(id, def)`: register an enemy type (same fields as `TYPES`: `frames` [[l1,l2],[l1,l2]], `hurt` (defaults to frames), `color` (a palette name), `pts`, `hp`, `die`, `dieColor`, `shot`, `name`).
- `core.spawnEnemy(type, x, y, extra)`: a *free* bug (`e.free`, top-left `e.x/e.y`, `e.temp`); you move it, the core draws it, collides, scores, kills. `e.wait` hides it.
- `core.paths`: flight paths `{ kind, dur, at(t) -> {x, y, a} }` (centre of the thing, heading `a`, view coords): `line`, `sine`, `loop`, `swoop`, `vee(n)` (returns an array), `dive` (steers on the live plane; call `at` with rising t). `paths.fly(type, path, { delay, shoot, onEnd, extra })` spawns a bug that flies it (the core moves it, hidden during `delay`; `shoot` = seconds between aimed shots; no `onEnd` = it flies off and vanishes without points or penalty; `onEnd(e)` runs at the end of the path). `paths.attach(e, path, opts)` puts an existing formation member on a path (it peels off); `paths.release(e)` (use it as `onEnd`) gives it back to the formation: it is drawn at its formation spot again.
- Wave end: all `G.enemies` dead and not `G.hold` -> the core clears the wave (bonus, next wave). Streaming spawns: set `G.hold = true` until you have spawned the last one, then `false`. A wave with no `G.enemies` never clears by itself: call `core.clearWave()`.
- Free bugs fly their paths only while `G.intro <= 0`. `core.enemyShot(x, y, vx, vy, ch, color, extra)` fires an enemy bullet (`extra` e.g. `{ draw(b) {...}, pol }`); `core.aimedShot(x, y, speed, ch, color, spread)`; `core.drone(label, x, y, { die, color, vy })` a shootable falling label.
- `core.playerShot({ x, y, vx, vy, w, h, dmg, pierce, ally, life, ghost, draw(s) })` adds a player shot (defaults: a 2x10 bolt going up; `dmg` also hurts bosses; `draw(s)` replaces the sprite). `ghost: true`: enemy bullets cannot destroy it and it does not count against the core's shot cap (`ally` shots also don't). `core.fire()` is the normal shot.
- Enemy bullets (`core.enemyShot` extras, or fields of a bullet you push yourself): `solid: true` cannot be destroyed by player shots (the core's shot-vs-bullet trade skips it); `r` = collision radius (a disc centred 5 px under `b.y`, tested against the plane's bullet box / dot) or `w` / `h` = a box centred on `b.x` with its top at `b.y`, instead of the fixed 6x10; `src` = who fired it (for `onEnemyBullet`). Nothing set = unchanged behaviour.
- `core.hurtBoss(dmg, x, y)`: damages the current boss through its own `def.hit` rules (as a shot of `dmg` landing at x, y; default: its weak spot via `def.aim`, else its middle). Returns true if the boss took it (the loop boss' ring or a shielded npm dependency may refuse). False when there is no boss.
- `core.addPower(id, { label, color, drop, era, apply(core, P) })`: a new power-up; `drop` = weight in the drop pool (0 = only by script), `era` = from which era it drops. It is not listed on the title.

### `core` (everything an era may touch; arrays on `G` are replaced each frame, never cache them)
- State: `G` (note `G.fx` = the power-up timers; also `G.stars`, `G.player {x,y,w,h,inv,cool,fy,hb,skin,noFlicker}`, `G.shots/ebul/enemies/drones/powerups/particles/floaters`, `G.era`, `G.wave`, `G.intro`, `G.hold`, `G.custom`, `G.lift`, `G.speedMul`, `G.boss`, `G.lives`, `G.score`), `view` (`W`, `H` logical size, `s`, `k`), `C` (palette), `keys` (Set of held actions: left right up down fire bomb roll + yours), `store`, `caps`, `fx`, `TYPES`, `POWERS`, `SFX`, `paths`, `canvas`, `ctx` (the 2D context the core draws with), getters `era ground bottomY flightTop flightBottom`.
- Helpers: `rnd pick clamp lerp overlap pad wrap charW measure sprite drawSprite txt box bigText pixelText burst float addScore comboHit mult kill epos dropPower applyPower playerHit(dmg, src) gameOver clearWave fire beep later eraOf waveOfEra addType addPower spawnEnemy bulletBox bodyBox enemyShot aimedShot drone playerShot hurtBoss toView`.
- `core.fx` (visual knobs, NOT `G.fx`; the defaults reproduce era 1): `glow` (multiplier on every sprite / text glow, 1), `starLayers` (48 stars per layer, deeper = faster and brighter, 1), `trail` (plane exhaust length, 0), `particleMax` (280), `burstMul` (particles per burst, 1), `shake` (screen shake multiplier, 1), `grid` (0..1 neon grid, 0), `scanlines` (CRT strength, 1).
- `core.caps` (defaults `move2d bomb roll contactKills` false, `shields` true, `flightFrac` 0.55): add your own flags (`hyper: true`) freely; the core only reads those six. `shields: false` clears the shields and stops rebuilding them.

### Minimal era module (an era-2-ish sketch: a bug peels off every few seconds and swoops)
```js
(() => {
"use strict";
(window.INVADERS_ERAS = window.INVADERS_ERAS || []).push({
  n: 2, year: 1979, name: "GALAXIAN", blurb: "the bugs peel off in curved dive-bombs.",
  fx: { starLayers: 2 },
  init(core) {
    const { G, paths, rnd, pick } = core;
    let t = 0;
    return {
      onNewGame() { t = 0; }, onWave() { t = rnd(3, 5); },   // reset: a new game or wave starts clean
      update(dt) {
        if (G.intro > 0 || G.boss || (t -= dt) > 0) return;
        t = rnd(2.5, 4.5);
        const e = pick(G.enemies.filter((x) => x.alive && !x.free && !x.dive));
        if (!e) return;
        const p = core.epos(e);
        paths.attach(e, paths.swoop({ from: { x: p.x + e.w / 2, y: p.y + e.h / 2 }, side: Math.random() < 0.5 ? 1 : -1 }), { shoot: 1.6, onEnd: paths.release });
      },
      draw(layer) { if (layer === "fg" && G.era === 2) core.txt("GALAXIAN", 8, core.view.H - 14, core.C.dim, 9); },
    };
  },
});
})();
```

### Files, sync and the standalone page
- `scripts/sync-invaders.ps1` (run: `powershell -File scripts\sync-invaders.ps1`): copies `ui/invaders*.js|css` to `..\Neilson\site\bug-invaders\` (deleting stale ones; `scores.php` untouched), writes that folder's `index.html` from the master `scripts/site-bug-invaders.index.html` (era scripts first, `invaders.js` last, each with `?v=<VERSION>.<hash>`), and rewrites the block between `<!-- invaders:eras` and `<!-- /invaders:eras -->` in `ui/index.html` with a tag for each `ui/invaders-e*.js` that exists (so a missing file never 404s; a new era file is picked up by running the script, or add one `<script src>` tag by hand inside that block). Never edit the site copy; page changes go in the master page.
- The touch pad (`#pad`, coarse pointers only; `?pad` in the URL shows it on a desktop) has up / down / bomb / roll buttons that `invaders.js` shows through `data-move2d`, `data-bomb`, `data-roll` on `#pad`; `window.invaders.input(k, down)` takes `left right up down fire bomb roll pause` and **any registered action name** (`meter force screenbomb hyper polarity release` ...).
- **Era actions on the pad (dynamic).** An action declared in a module's `keys` gets a pad button when it has a label: `keys: { meter: { keys: ["c"], label: "METER" } }` (the plain array form still works), or `padLabels: { meter: "METER" }` on the module / hooks, or a built-in label (meter METER, force FORCE, screenbomb SCR-BOMB, hyper HYPER, polarity FLIP, release RELEASE, so the shipped eras need nothing). No label = no button (era 10's aim keys; its aim is canvas-touch); `pad: false` or `label: ""` hides one. `core` publishes the list for the eras reached (`[{ action, label, key }]`, ascending era, every wave but only when it changes) three ways: `window.invaders.onActions = fn` (called at once with the current list, then on every change), a `CustomEvent("invaders:actions", { detail: list })` on `window`, and `#pad[data-actions="meter force ..."]`; `window.invaders.actions` returns the current list. The master page's script builds one `button.x` per entry (second row, wraps; six fit at 360 px), wired to `window.invaders.input(action, down)`.
- Pointer events: the core adds only a `click` listener on the canvas (and `touch-action: none` in the CSS), so `pointermove` / `pointerdown` reach era modules untouched (era 10's aim).
- `_debug` also has `mods()` (every module: era, active, dead, pad, exclusiveFire) and `deadMods()` (eras the throw guard has switched off).

### Test recipe (one short, consolidated check per agent)
1. `npm run dev` in the Neilson repo (serves http://localhost:8080/, the game at `/bug-invaders/`, no caching).
2. Run the sync script. Load the Claude in Chrome tools with ToolSearch (`mcp__claude-in-chrome__tabs_context_mcp, tabs_create_mcp, navigate, javascript_tool, computer, read_console_messages, browser_batch`) and open `http://localhost:8080/bug-invaders/` in a NEW tab.
3. In `javascript_tool`: `const d = invaders._debug, G = d.G; d.startEra(N); d.keys.add("up"); d.keys.add("fire"); d.step(10); JSON.stringify({ era: G.era, y: G.player.y, state: G.state, lives: G.lives })`. `d.step(sec)` runs the game on fake time (no focus needed), `d.keys` is the held-action Set, `d.core` is the core, `d.addEra(module)` injects a module without a file. Set `G.lives = 5` first if you want to survive 10 s of unattended play.
4. `read_console_messages` with `onlyErrors: true` (ignore errors from before your last navigation) and one screenshot with `computer` (`save_to_disk: true`, scale 0.6; the tool returns a saved .jpg path: copy it into your scratch folder). Run each check once; after a fix re-run only what failed. Kill the dev server (port 8080) and close your tab when done; remove any `yoc.invaders.*` localStorage keys you made (`era`, `scores`, `hi`).

## Playing the ladder
You start in era 1 and each wave steps the plane (and the world) forward a few years; every 4th wave is a boss of the era you just left. After wave 13 it is era 10, endless, with everything on.

| Era | First wave | Year | Ancestor | Keys that arrive | One line |
|---|---|---|---|---|---|
| 1 | 1 | 1978 | Space Invaders | ← → move, **Space** fire | Formation, shields, one shot at a time. |
| 2 | 2 | 1979 | Galaxian | | Bugs peel off in curved dive-bombs; a senior dev leads escorts for big bonuses. |
| 3 | 3 | 1982 | Xevious | **↑ ↓** (now free flight), **Z** bomb | The plane flies over a scrolling dev world; bombs hit the ground targets; bugs that get past ship to prod. |
| 4 | 5 | 1984 | 1942 | **X** or **Shift** roll | Squadrons on curved paths, N+1 bombers, a barrel roll to dodge, wingmen from red squads. |
| 5 | 6 | 1985 | Gradius | **C** meter | Capsules light a power-up meter (speed, missile, option, shield); options copy your fire; stack traces fall. |
| 6 | 7 | 1987 | R-Type | **F** force pod, hold **Space** | Hold to charge the beam, let go to pierce; a force pod eats bullets; worms snake across. |
| 7 | 9 | 1990 | Raiden | **B** screen bomb | Ground armour fires back; vulcan / laser / homing guns (W pickups); medals chain. |
| 8 | 10 | 1995 | Bullet hell | **H** hyper, hold **Space** to focus | Rings, fans, spirals; only a small dot is hit; graze for points and hyper. |
| 9 | 11 | 2001 | Ikaruga | **V** flip polarity, **N** release | Orange and blue: absorb your own colour, fear the other. |
| 10 | 13 | 2004+ | Geometry Wars | mouse or **I J K L** aim | Twin-stick, combo multiplier, a warping grid, particle storms. Endless. |

Always: **P** pause, **M** sound (off by default), **L** top ten, **Esc** hides it in Yo Claude. Touch pad on phones; every era key has a button.
