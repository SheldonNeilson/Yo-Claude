// The terminal pane: real shells (terminal.py, on a Windows pseudo-console) drawn by xterm.js, between the chat and the
// message box. Ctrl+` or the [term] button shows and hides it (the shells keep running while it's hidden). termMenuItems()
// is what every file and folder right-click menu uses to offer "open in terminal" and friends.
"use strict";
const term = (() => {
  const box = $("#term"), tabsEl = $("#termTabs"), bodyEl = $("#termBody");
  const tabs = new Map();   // id -> { id, title, cwd, alive, xt, fit, div, opened }
  const st = { active: null, ok: true, loaded: false, h: Number(localStorage.getItem("yoc.term.h")) || 260 };
  const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  const theme = () => ({
    background: css("--bg"), foreground: css("--text"), cursor: css("--orange"), cursorAccent: css("--bg"), selectionBackground: "#5a4a40",
    black: "#111110", red: css("--red"), green: css("--green"), yellow: css("--amber"), blue: css("--blue"), magenta: "#c586c0", cyan: "#4ec9b0", white: "#e8e4da",
    brightBlack: "#6a6660", brightRed: "#ff8a8a", brightGreen: "#b5e29a", brightYellow: "#f5c76a", brightBlue: "#8cc8ff", brightMagenta: "#d7a3d2", brightCyan: "#7fe0cc", brightWhite: "#ffffff",
  });
  const shown = () => !box.classList.contains("hidden");
  const err = (m) => { if (m) alertBox(m); return !m; };

  function setHeight(h) {
    const max = Math.max(120, Math.round(($("#chat").clientHeight || 600) * 0.75));
    st.h = Math.round(Math.max(110, Math.min(max, h)));
    box.style.height = st.h + "px";
  }

  function fitActive() {
    const t = tabs.get(st.active);
    if (!t || !shown() || !t.opened) return;
    try { t.fit.fit(); } catch (_) { /* hidden */ }
  }

  function make(info) {
    const div = el("div", "term-screen hidden");
    bodyEl.appendChild(div);
    const xt = new Terminal({ fontFamily: css("--mono"), fontSize: 13, cursorBlink: true, scrollback: 5000, theme: theme(), allowProposedApi: true, rightClickSelectsWord: false });
    const fit = new FitAddon.FitAddon();
    xt.loadAddon(fit);
    if (window.WebLinksAddon) xt.loadAddon(new WebLinksAddon.WebLinksAddon((_, uri) => api().open_url(uri)));
    const t = { ...info, xt, fit, div, opened: false };
    xt.onData((d) => { if (t.alive) api().term_write(t.id, d); });
    xt.onResize(({ rows, cols }) => { if (t.alive) api().term_resize(t.id, rows, cols); });
    xt.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const k = ev.key.toLowerCase();
      if (ev.ctrlKey && !ev.altKey && k === "c" && (ev.shiftKey || xt.hasSelection())) {   // copy when text is selected, else Ctrl+C is the usual interrupt
        if (xt.hasSelection()) { copyText(xt.getSelection(), "copied"); xt.clearSelection(); }
        return false;
      }
      return true;
    });
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      showMenu(e, [
        ["copy", () => { copyText(xt.getSelection(), "copied"); xt.clearSelection(); }, { disabled: !xt.hasSelection() }],
        ["paste", async () => { try { xt.paste(await navigator.clipboard.readText()); xt.focus(); } catch (_) { toast("Couldn't read the clipboard"); } }],
        ["select all", () => xt.selectAll()],
        ["clear", () => xt.clear()],
        "-", ["close this terminal", () => close(t.id)],
      ]);
    });
    tabs.set(t.id, t);
    return t;
  }

  function open(t) {   // xterm needs a visible element to measure
    if (t.opened) return;
    t.xt.open(t.div);
    t.opened = true;
    if (t.buf) { t.xt.write(t.buf); t.buf = ""; }
  }

  function paintTabs() {
    tabsEl.innerHTML = "";
    for (const t of tabs.values()) {
      const b = el("span", "term-tab" + (t.id === st.active ? " on" : "") + (t.alive ? "" : " dead"));
      const name = el("button", "term-name", esc(t.title));
      name.title = t.cwd + (t.alive ? "" : "  (finished)");
      name.onclick = () => select(t.id);
      const x = el("button", "term-x", "✕");
      x.title = "Close this terminal";
      x.onclick = (e) => { e.stopPropagation(); close(t.id); };
      b.append(name, x);
      tabsEl.appendChild(b);
    }
  }

  function select(id) {
    const t = tabs.get(id);
    if (!t) return;
    st.active = id;
    for (const o of tabs.values()) o.div.classList.toggle("hidden", o !== t);
    paintTabs();
    if (shown()) { open(t); setTimeout(() => { fitActive(); t.xt.focus(); }, 0); }
  }

  function show() {
    box.classList.remove("hidden");
    setHeight(st.h);
    $("#termBtn")?.classList.add("on");
    if (!tabs.size) return openAt(null);
    select(st.active || [...tabs.keys()][0]);
  }
  function hide() {
    box.classList.add("hidden");
    $("#termBtn")?.classList.remove("on");
    $("#input")?.focus();
  }
  function toggle() { return shown() ? hide() : show(); }

  function close(id) {
    const t = tabs.get(id);
    if (!t) return;
    api().term_close(id);
    t.xt.dispose(); t.div.remove(); tabs.delete(id);
    if (st.active === id) st.active = null;
    if (!tabs.size) return hide(), paintTabs();
    select(st.active || [...tabs.keys()].pop());
  }

  // a new terminal in the folder (or in the folder holding the file); no path: the session's folder
  async function openAt(path, cwd) {
    if (!st.ok) return err("The terminal needs pywinpty, which isn't installed. Run Install Yo Claude again.");
    box.classList.remove("hidden");
    setHeight(st.h);
    $("#termBtn")?.classList.add("on");
    const r = await api().term_open(path || null, cwd || null, 100, 14);
    if (r.error) { if (!tabs.size) hide(); return err(r.error); }
    const t = make({ ...r, buf: "" });
    select(t.id);
    return true;
  }
  // act on the terminal that's showing, or start one there if there isn't one
  const live = () => { const t = tabs.get(st.active); return t && t.alive ? t : null; };
  async function cd(path, cwd) {
    if (!live()) return openAt(path, cwd);
    show();
    const m = await api().term_cd(live().id, path, cwd);
    if (m) return err(m);
    live().xt.focus();
  }
  async function typePath(path, cwd) {
    if (!live()) await openAt(null, cwd);
    show();
    const t = live();
    if (t && err(await api().term_type_path(t.id, path, cwd))) t.xt.focus();
  }
  async function run(path, cwd) {
    if (!live()) await openAt(null, cwd);
    show();
    const t = live();
    if (t && err(await api().term_run(t.id, path, cwd))) t.xt.focus();
  }
  // Text for the prompt that must NOT run (a code block from the chat, a command Claude suggests). xterm's own paste() turns
  // every newline into Enter, which runs the lines; here trailing newlines are dropped and several lines go in as a
  // bracketed paste with plain line feeds, which PowerShell keeps as one multi-line entry until you press Enter.
  async function typeSafe(t, text) {
    const clean = String(text).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (!clean) return;
    if (!t.gotOut) for (let i = 0; i < 40 && !t.gotOut; i++) await new Promise((r) => setTimeout(r, 100));   // let the prompt draw first
    await new Promise((r) => setTimeout(r, 250));
    api().term_write(t.id, clean.includes("\n") ? "\x1b[200~" + clean + "\x1b[201~" : clean);
    t.xt.focus();
  }
  async function paste(text) {
    if (!live()) await openAt(null, null);
    show();
    const t = live();
    if (t) typeSafe(t, text);
  }
  // Claude's type_in_terminal: the text goes to the prompt, never Enter. A terminal already sitting in that folder is
  // reused (if its last known folder is it); otherwise a new tab opens there.
  async function prefill(text, folder) {
    const same = (a, b) => a && b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
    if (!live() || (folder && !same(live().cwd, folder))) await openAt(folder || null, null);
    show();
    const t = live();
    if (t) typeSafe(t, text);
  }
  function external(path, cwd) { return api().open_terminal_external(path || null, cwd || null).then(err); }

  // events from Python
  function out(id, data) { const t = tabs.get(id); if (t) { t.gotOut = true; if (t.opened) t.xt.write(data); else t.buf = (t.buf || "") + data; } }
  function exited(id, code) {
    const t = tabs.get(id);
    if (!t) return;
    t.alive = false;
    if (t.opened) t.xt.write(`\r\n\x1b[2m[finished${code ? ", exit code " + code : ""}: close this tab or open another]\x1b[0m\r\n`);
    paintTabs();
  }

  // drag the top edge to resize; double-click puts it back
  const grip = $("#termGrip");
  grip.onpointerdown = (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = st.h;
    document.body.classList.add("resizing");
    grip.onpointermove = (ev) => { setHeight(h0 - (ev.clientY - y0)); fitActive(); };
    grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; document.body.classList.remove("resizing"); localStorage.setItem("yoc.term.h", st.h); };
  };
  grip.ondblclick = () => { setHeight(260); localStorage.setItem("yoc.term.h", 260); fitActive(); };
  new ResizeObserver(() => fitActive()).observe(bodyEl);
  window.addEventListener("resize", () => { if (shown()) { setHeight(st.h); fitActive(); } });

  // keys typed in the terminal belong to the shell, not to the app's shortcuts (Ctrl+L, Ctrl+B, Esc...), except Ctrl+` itself
  box.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "`") { e.preventDefault(); e.stopPropagation(); return toggle(); }
    e.stopPropagation();
  });
  $("#termNew").onclick = () => openAt(null);
  $("#termExt").onclick = () => external(null);
  $("#termHide").onclick = hide;
  $("#termBtn").onclick = toggle;
  $("#termBtn").addEventListener("mousedown", (e) => e.preventDefault());

  // after a reload of the window the shells are still running in Python: pick them up again, screens included
  window.addEventListener("pywebviewready", async () => {
    try {
      const r = await api().term_list();
      st.ok = r.ok;
      for (const i of r.terms) if (!tabs.has(i.id)) make(i);
      if (tabs.size) { st.active = [...tabs.keys()][0]; paintTabs(); }
    } catch (_) { /* old backend */ }
    st.loaded = true;
  });

  return { show, hide, toggle, openAt, cd, typePath, run, paste, prefill, external, out, exited, shown, hasLive: () => !!live(), canRun: (p) => /\.(py|pyw|js|mjs|ts|ps1|bat|cmd|exe|sh)$/i.test(p) };
})();

// The terminal entries for a file or folder's right-click menu. kind: "dir" or "file" (a file opens its folder).
function termMenuItems(path, cwd, kind) {
  const dir = kind === "dir";
  return [
    [dir ? "open in terminal" : "open its folder in terminal", () => term.openAt(path, cwd)],
    ["terminal", null, { sub: [
      [dir ? "cd to it in the current terminal" : "cd to its folder in the current terminal", () => term.cd(path, cwd), { disabled: !term.hasLive() }],
      ["type its path into the terminal", () => term.typePath(path, cwd)],
      ...(!dir && term.canRun(path) ? [["run it in the terminal", () => term.run(path, cwd)]] : []),
      "-",
      [dir ? "open in an external terminal window" : "open its folder in an external terminal window", () => term.external(path, cwd)],
    ] }],
  ];
}
