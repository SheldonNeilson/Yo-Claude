// Page errors go to the Yo Claude log (WebView2 has no visible console).
window.addEventListener("error", (e) => window.pywebview?.api?.js_error(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => window.pywebview?.api?.js_error("promise: " + (e.reason?.stack || e.reason)));

// Claude Code's pixel mascot (same art as icons.py), drawn on a canvas and animated per state.
const MASCOT = {
  base: ["..############..", "..##.######.##..", "################", "..############..", "...#.#....#.#..."],
  blink: ["..############..", "..############..", "################", "..############..", "...#.#....#.#..."],
  walk: ["..############..", "..##.######.##..", "################", "..############..", "....#.#..#.#...."],
  lookL: ["..############..", "..#.######.###..", "################", "..############..", "...#.#....#.#..."],
  lookR: ["..############..", "..###.######.#..", "################", "..############..", "...#.#....#.#..."],
  colors: { starting: "#968f86", idle: "#d97757", paused: "#6e6c68", listening: "#ff8c60", thinking: "#e8b04b",
            speaking: "#9fd17f", using_pc: "#5ab0ff", approval: "#ffc400", error: "#ff5a5a", background: "#b9a3ff" },
  // level: 0..1 mic loudness (bounce while listening)
  draw(canvas, state, level = 0, t = performance.now() / 1000) {
    const g = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    let frame = this.base, dy = 0, color = this.colors[state] || this.colors.idle;
    if ((state === "idle" || state === "starting") && t % 4 < 0.15) frame = this.blink;
    if (state === "speaking" && Math.floor(t * 4) % 2) frame = this.walk;
    if (state === "using_pc") frame = [this.lookL, this.base, this.lookR, this.base][Math.floor(t * 3) % 4];
    if (state === "approval" && Math.floor(t * 3) % 2) color = this.colors.idle;
    if (state === "listening") dy = -level * 4;
    const cw = Math.floor(W / 16), ch = Math.min(Math.floor((H - 4) / 5), cw * 3);
    let dx = 0;   // each busy state has its own move, here and in the tray icon (icons.py): thinking shuffles, a background task hops, needing you wiggles
    if (state === "thinking") { const k = Math.floor(t * 4) % 4; dx = [-1, 0, 1, 0][k] * cw; frame = k % 2 ? this.walk : this.base; }   // a step to one side and back to the other, feet alternating
    if (state === "background") { const p = t % 1.5; dy = p < 0.45 ? -Math.sin(p / 0.45 * Math.PI) * Math.max(2, ch * 0.8) : 0; }   // hop, then rest
    if (state === "approval") dx = (Math.floor(t * 14) % 2 ? 1 : -1) * Math.max(1, Math.round(cw / 2));   // a quick side-to-side wiggle
    let ox = Math.floor((W - cw * 16) / 2);
    const oy = Math.floor((H - ch * 5) / 2) + Math.round(dy);   // (whole pixels: a fractional offset leaves seams between the cells)
    ox += Math.max(-ox, Math.min(dx, W - ox - cw * 16));   // (never off the canvas)
    g.fillStyle = color;
    frame.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") g.fillRect(ox + x * cw, oy + y * ch, cw, ch); }));
  },
};
