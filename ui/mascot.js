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
    if (state === "thinking") dy = -Math.abs(Math.sin(t * 5)) * 2;
    if (state === "listening") dy = -level * 4;
    const cw = Math.floor(W / 16), ch = Math.min(Math.floor((H - 4) / 5), cw * 3);
    const ox = Math.floor((W - cw * 16) / 2), oy = Math.floor((H - ch * 5) / 2) + dy;
    g.fillStyle = color;
    frame.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") g.fillRect(ox + x * cw, oy + y * ch, cw, ch); }));
  },
};
