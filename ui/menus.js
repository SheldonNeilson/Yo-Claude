// Menu bar (File / Edit / View / Session / Voice / Tools / Help), keyboard shortcuts, copying, the folder field,
// version and update badge. Items: [label, action, {checked, kbd, disabled}] | "-" | ["sub:heading"].
"use strict";
const setting = (k, def = true) => S.settings[k] === undefined ? def : !!S.settings[k];
const toggleSetting = (k, def = true) => api().set_setting(k, !setting(k, def));
const activeSession = () => S.active && findSession(S.active.id);

function copyText(text, what = "copied") {
  if (!text) return;
  api().copy_text(text).then(() => toast(what));
}
function toast(text, kind = "") {
  const t = $("#toast");
  t.textContent = text; t.className = kind;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add("hidden"), (kind === "error" ? 2500 : 1200) + 45 * text.length);
}
function conversationText() {
  return S.items.filter((it) => it && ["user", "assistant", "note"].includes(it.kind))
    .map((it) => (it.kind === "user" ? "> " : "") + (it.text || "")).join("\n\n");
}
function zoom(step) {
  const z = step === 0 ? 1 : Math.min(1.6, Math.max(0.7, (S.settings.zoom || 1) + step));
  document.body.style.zoom = z;
  api().set_setting("zoom", z);
}
function expandAll(open) {
  for (const k of ["", ...S.workspaces.map(keyOf)]) S.manual[k] = { open, at: Date.now() };
  api().set_setting("tree_manual", S.manual); renderTree();
}
async function pastePath() { $("#folderPath").focus(); $("#folderPath").value = (await api().paste_text()) || ""; }

const MENUS = {
  file: () => [
    ["New session", () => api().new_session(), { kbd: "Ctrl+N" }],
    ["New chat (no folder)", () => api().new_session(null), { kbd: "Ctrl+Shift+N" }],
    ["Add a folder…", () => api().add_folder()],
    ["Open a folder by path…", () => { $("#folderPath").focus(); $("#folderPath").select(); }, { kbd: "Ctrl+L" }],
    "-",
    ["Show folder in Explorer", () => api().open_path(S.active?.cwd, "open"), { disabled: !S.active?.cwd }],
    ["Open folder in VS Code", () => api().open_path(S.active?.cwd, "code"), { disabled: !S.active?.cwd }],
    "-",
    ["Clean up old conversations…", () => $("#cleanBtn").click()],
    ["Trash…", () => $("#trashBtn").click()],
    "-",
    ["Compact mode (just the bar)", () => api().compact()],
    ["Close to tray", () => api().compact()],
    [`Restart ${appName()}`, async () => { if (await api().request_restart()) toast("Restarting once the reply in progress is done"); }],
    ["Exit", () => api().request_quit()],
  ],
  edit: () => [
    ["Copy", () => copyText(getSelection().toString()), { kbd: "Ctrl+C", disabled: !getSelection().toString() }],
    ["Paste into message", async () => { const t = await api().paste_text(); const b = $("#input"); b.focus(); b.setRangeText(t || "", b.selectionStart, b.selectionEnd, "end"); autosize(); }, { kbd: "Ctrl+V" }],
    "-",
    ["Copy last reply", () => copyText([...S.items].reverse().find((i) => i?.kind === "assistant")?.text, "reply copied")],
    ["Copy whole conversation", () => copyText(conversationText(), "conversation copied")],
    ["Copy folder path", () => copyText(S.active?.cwd || S.folder, "path copied"), { disabled: !(S.active?.cwd || S.folder) }],
    ["Copy session ID", () => copyText(S.active?.id, "session id copied"), { disabled: !S.active }],
    "-",
    ["Find a session", () => $("#search").focus(), { kbd: "Ctrl+F" }],
  ],
  view: () => [
    ["Sessions list", () => $("#sideBtn").click(), { checked: panes.side(), kbd: "Ctrl+Shift+B" }],
    ["Files, changes & git panel", () => $("#panelBtn").click(), { checked: $("#app").classList.contains("with-panel"), kbd: "Ctrl+B" }],
    ["Just the chat (hide both)", () => panes.focus(), { checked: !panes.side() && !panes.files() }],
    ["Expand all folders", () => expandAll(true)],
    ["Collapse all folders", () => expandAll(false)],
    "-",
    ["Zoom in", () => zoom(0.1), { kbd: "Ctrl+=" }],
    ["Zoom out", () => zoom(-0.1), { kbd: "Ctrl+-" }],
    ["Actual size", () => zoom(0), { kbd: "Ctrl+0" }],
    "-",
    ["Floating bar when the window is closed", () => toggleSetting("show_bar"), { checked: setting("show_bar") }],
    ["Start Maximized", () => toggleSetting("start_maximized"), { checked: setting("start_maximized") }],
    ["Keep the floating bar visible when idle", () => toggleSetting("bar_when_idle"), { checked: setting("bar_when_idle") }],
  ],
  session: () => {
    const s = activeSession(), a = S.active;
    const pick = (list, cur, fn) => list.map(([v, t]) => ["  " + t, () => fn(v), { checked: (cur || "") === v }]);
    return [
      ["Rename…", () => ask("Rename session", s.title, (t) => api().rename(s.id, s.cwd, t)), { disabled: !s }],
      [s?.pinned ? "Unpin" : "Pin to top", () => api().pin(s.id, s.cwd, !s.pinned), { disabled: !s }],
      ["Fork (branch the conversation)", async () => { const e = await api().fork(s.id, s.cwd); if (e) alertBox(e); }, { disabled: !s }],
      ["Add folder…", async () => { const e = await api().add_extra_dir(a.id); if (e) alertBox(e); }, { disabled: !a }],
      ["Move to trash…", () => confirmBox(`Move “${s.title}” to the trash?`, async () => { const e = await api().delete(s.id, s.cwd); if (e) alertBox(e); }), { disabled: !s }],
      "-",
      ["Stop", () => api().stop(), { kbd: "Esc" }],
      "-", ["sub:model"], ...pick(MODELS, a ? a.model : S.settings.model, (v) => { $("#modelSel").value = v; $("#modelSel").onchange({ target: $("#modelSel") }); }),
      "-", ["sub:effort"], ...pick(EFFORTS, a ? a.effort : S.settings.effort, (v) => { $("#effortSel").value = v; $("#effortSel").onchange({ target: $("#effortSel") }); }),
      ...((a ? a.cwd : S.folder) ? ["-", ["sub:permissions"], ...pick(PERMS, a ? a.permission_mode : "auto",
        (v) => { $("#permSel").value = v; $("#permSel").onchange({ target: $("#permSel") }); })] : []),
    ];
  },
  voice: () => [
    ["Talk now", () => api().talk(), { kbd: "Ctrl+Space" }],
    "-",
    [`Listen for “${appName()}”`, () => toggleSetting("listening"), { checked: setting("listening") }],
    ["Read replies aloud", () => toggleSetting("voice_replies"), { checked: setting("voice_replies") }],
    [`Say Hello After “Yo ${Who()}” (Else a Beep)`, () => toggleSetting("greeting", false), { checked: setting("greeting", false) }],
    ["Say when a session is done", () => toggleSetting("notify_done", true), { checked: setting("notify_done", true) }],
    ["More accurate speech recognition (slower)", () => toggleSetting("accurate_speech", false), { checked: setting("accurate_speech", false) }],
    ["PC control (screen, keyboard, mouse)", () => toggleSetting("pc_control", false), { checked: setting("pc_control", false) }],
    "-",
    ["Training mode…", () => training.open()],
  ],
  tools: () => [
    ["Check for updates…", () => { api().check_updates(); toast("checking…"); }],
    ["Launch with Windows", () => toggleSetting("launch_at_login"), { checked: setting("launch_at_login") }],
    "-",
    ["Open log", () => api().open_log()],
    ["Open Yo Claude's data folder", () => api().open_data_folder()],
  ],
  // the extras, each on or off (named the old way). Claude's own (tick lists, advisor notes) apply from a session's
  // next start; the rest at once.
  options: () => [
    ["sub:writing"],
    ["AutoCorrect (Haiku)", () => toggleSetting("fix_text"), { checked: setting("fix_text") }],
    ["Word Prediction", () => toggleSetting("suggest_next"), { checked: setting("suggest_next") }],
    ["Predict While Claude Works", () => toggleSetting("suggest_early"), { checked: setting("suggest_early") }],
    ["Reply & Comment on Selection", () => toggleSetting("reply_menu"), { checked: setting("reply_menu") }],
    "-",
    ["sub:claude"],
    ["Tick Lists", () => toggleSetting("checklist_tool"), { checked: setting("checklist_tool") }],
    ["Show Advisor Notes", () => toggleSetting("advisor_relay"), { checked: setting("advisor_relay") }],
    ["Remember Queued Messages", () => toggleSetting("keep_queue"), { checked: setting("keep_queue") }],
    "-",
    ["sub:face & fun"],
    // the assistant's look and voice: three of each (the keys are what settings already hold)
    ...[["female", [["female", "1"], ["female2", "2"], ["female3", "3"]]], ["male", [["male", "1"], ["professor", "2"], ["male3", "3"]]]]
      .flatMap(([head, list]) => [["sub:assistant · " + head],
        ...list.map(([c, n]) => [`  ${n}`, () => api().set_setting("character", c), { checked: (S.settings.character || "male") === c }])]),
    ["Face in Sidebar", () => toggleSetting("avatar", false), { checked: setting("avatar", false) }],
    ["Face on Floating Bar", () => toggleSetting("bar_avatar", false), { checked: setting("bar_avatar", false) }],
    ["Activity on Floating Bar", () => toggleSetting("bar_feed"), { checked: setting("bar_feed") }],
    ["Animated Tray Icon", () => toggleSetting("tray_animate"), { checked: setting("tray_animate") }],
    ["Arcade While You Wait", () => toggleSetting("invaders"), { checked: setting("invaders") }],
    "-",
    ["sub:power"],
    ["Keep PC Awake While Claude Works", () => toggleSetting("awake_while_working"), { checked: setting("awake_while_working") }],
    ["Keep PC Awake (Always)", () => toggleSetting("keep_awake", false), { checked: setting("keep_awake", false) }],
    "-",
    ["Chat Sliver Under the Arcade", () => toggleSetting("invaders_peek"), { checked: setting("invaders_peek") }],
    ["Play Bug Invaders Now", () => window.invaders?.show()],
  ],
  help: () => [
    ["Welcome tour", () => training.open(), { kbd: "F1" }],
    ["Keyboard shortcuts", showShortcuts],
    "-",
    ["What's new", async () => api().open_url((await api().repo_url()) + "/commits/main")],
    ["Report a problem", async () => { api().open_log(); api().open_url((await api().repo_url()) + "/issues"); }],
    "-",
    ["About Yo Claude", showAbout],
  ],
};

let openMenu = null;
document.querySelectorAll("#menubar [data-menu]").forEach((b) => {
  const show = () => {
    document.querySelectorAll("#menubar button.open").forEach((x) => x.classList.remove("open"));
    b.classList.add("open"); openMenu = b.dataset.menu;
    showMenu(b, MENUS[b.dataset.menu]());
  };
  b.onclick = () => (openMenu === b.dataset.menu && !$("#menu").classList.contains("hidden")) ? (hideMenu(), openMenu = null) : show();
  b.onmouseenter = () => { if (openMenu && !$("#menu").classList.contains("hidden") && openMenu !== b.dataset.menu) show(); };
});
new MutationObserver(() => { if ($("#menu").classList.contains("hidden")) { openMenu = null; document.querySelectorAll("#menubar button.open").forEach((x) => x.classList.remove("open")); } })
  .observe($("#menu"), { attributes: true, attributeFilter: ["class"] });

function showShortcuts() {
  const d = dialog("Keyboard shortcuts");
  const rows = [["Ctrl+N", "new session in this folder"], ["Ctrl+Shift+N", "new chat"], ["Ctrl+L", "type or paste a folder path"],
    ["Ctrl+F", "find a session"], ["Ctrl+B", "files, changes & git panel"], ["Ctrl+Space", "talk"], ["Esc", "stop"],
    ["Enter / Shift+Enter", "send / new line"], ["@", "attach a file"], ["Ctrl+V", "paste text or a screenshot"],
    ["Ctrl+= / - / 0", "zoom"], ["F1", "welcome tour"], ["right-click", "more on sessions, folders, files and messages"]];
  d.appendChild(el("table", "shortcuts", rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")));
  addButtons(d, [["close", closeModal, "primary"]]);
}
async function showAbout() {
  const a = await api().about();
  const u = a.update;
  const d = dialog("About Yo Claude");
  d.appendChild(el("div", "", `<p><b style="color:var(--orange)">Yo Claude ${esc(a.version)}</b> <span class="dim">${esc(a.commit)}</span></p>
    <p>A voice-first Claude assistant for Windows. Unofficial fan project, not made by Anthropic.</p>
    <p class="dim small">${u ? (u.behind ? `Version ${esc(u.latest)} is available.` : "Up to date.") + ` Checked ${esc(ago(u.checked * 1000))} ago.` : "Not checked for updates yet."}</p>
    <p class="dim small">Installed in ${esc(a.folder)}<br>Data in ${esc(a.data)} · Python ${esc(a.python)}</p>`));
  addButtons(d, [["check for updates", () => { api().check_updates(); toast("checking…"); }], ["close", closeModal, "primary"]]);
}
function renderUpdate(u) {
  S.update = u;
  const b = $("#updateBadge");
  b.classList.toggle("hidden", !(u && u.behind));
  if (u && u.behind) b.textContent = `▲ ${u.latest} available`;
}
$("#updateBadge").onclick = () => confirmBox(`Update to Yo Claude ${S.update.latest}? It restarts; background tasks keep running.`,
  () => api().check_updates());

// ---------- the folder field: select/copy the path, or paste/type one and press Enter ----------
$("#folderPath").addEventListener("focus", (e) => setTimeout(() => e.target.select(), 0));
$("#folderPath").addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { renderFolder(); e.target.blur(); }
  if (e.key !== "Enter") return;
  const v = e.target.value.trim();
  if (!v || sameFolder(v, S.active ? S.active.cwd : S.folder)) return e.target.blur();
  const err = await api().open_folder_path(v);
  if (err) alertBox(err); else e.target.blur();
});
$("#folderPath").addEventListener("blur", () => setTimeout(renderFolder, 150));
$("#folderCopy").onclick = () => copyText(S.active?.cwd || S.folder, "path copied");

// ---------- copying anything in the conversation ----------
$("#transcript").addEventListener("contextmenu", (e) => {
  const sel = getSelection().toString();
  const msg = e.target.closest(".msg, .taskwrap, .card");
  const pre = e.target.closest("pre");
  const raw = msg && rawText.get(msg);
  const items = [];
  const quote = sel.trim(), node = getSelection().anchorNode;   // (taken now: clicking the menu clears the selection)
  if (quote && node && $("#transcript").contains(node) && setting("reply_menu")) {
    items.push(["Reply to this", () => composer.addComment(quote, "")]);
    items.push(["Comment on this…", () => commentBox(quote, { x: e.clientX, y: e.clientY }, "", (t) => composer.addComment(quote, t))]);
    items.push("-");
  }
  if (sel) items.push(["Copy", () => copyText(sel)]);
  if (pre) items.push(["Copy code", () => copyText(pre.querySelector("code")?.textContent ?? pre.textContent, "code copied")]);
  if (raw) items.push(["Copy message", () => copyText(raw, "message copied")]);
  items.push(["Copy whole conversation", () => copyText(conversationText(), "conversation copied")]);
  e.preventDefault();
  showMenu(e, items);
});

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey) {
    if (k === "n") { e.preventDefault(); return e.shiftKey ? api().new_session(null) : api().new_session(); }
    if (k === "f") { e.preventDefault(); return $("#search").focus(); }
    if (k === "l") { e.preventDefault(); $("#folderPath").focus(); return $("#folderPath").select(); }
    if (k === "b") { e.preventDefault(); return $(e.shiftKey ? "#sideBtn" : "#panelBtn").click(); }
    if (k === " ") { e.preventDefault(); return api().talk(); }
    if (k === "=" || k === "+") { e.preventDefault(); return zoom(0.1); }
    if (k === "-") { e.preventDefault(); return zoom(-0.1); }
    if (k === "0") { e.preventDefault(); return zoom(0); }
  }
  if (e.key === "F1") { e.preventDefault(); training.open(); }
});

// ---------- text fields: the browser's own menu (spelling suggestions, cut/copy/paste) ----------
// app.py turns WebView2's built-in menu on; cancel it everywhere except where you type, so other right-clicks keep
// showing nothing or Yo Claude's own menus (those call preventDefault themselves).
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]), [contenteditable=true]")) e.preventDefault();
});
