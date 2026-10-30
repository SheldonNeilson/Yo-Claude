// Yo Claude main window. Python pushes events through app.events([...]); we call window.pywebview.api.*.
"use strict";
const $ = (s) => document.querySelector(s);
// Calls that open things answer with a message when they can't (file gone, no app for it...): show it.
const REPORTS_ERRORS = new Set(["open_path", "open_with", "pop_out", "reveal", "open_in_editor"]);
const api = () => new Proxy(window.pywebview.api, {
  get: (t, k) => !REPORTS_ERRORS.has(k) ? t[k] : (...a) => t[k](...a).then((r) => {
    const err = typeof r === "string" ? r : r?.error;
    if (err) toast(err, "error");
    return r;
  }),
});
const S = { settings: {}, folder: null, workspaces: [], groups: [], lists: {}, busy: new Set(), bg: new Set(), work: {}, active: null,
            items: [], display: { state: "starting" }, filter: "", manual: {}, more: new Set() };

const MODELS = [["", "model: default"], ["claude-fable-5-1", "Fable 5.1"], ["claude-opus-5-5", "Opus 5.5"],
                ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]];
const EFFORTS = [["", "effort: default"], ["low", "effort: low"], ["medium", "effort: medium"], ["high", "effort: high"],
                 ["xhigh", "effort: xhigh"], ["max", "effort: max"]];
const PERMS = [["auto", "auto mode"], ["default", "ask before changes"], ["acceptEdits", "auto-accept edits"], ["plan", "plan mode"]];
const STATE_LABEL = { starting: "booting…", idle: "● ready", paused: "○ wake word off", listening: "◉ listening",
                      thinking: "✻ thinking…", speaking: "▶ speaking", using_pc: "⌖ using your pc",
                      approval: "! needs your ok", error: "✗ mic unavailable", background: "⧗ background task" };
const SPIN = "·✢✳✶✻✽✻✶✳✢";
const SESSIONS_SHOWN = 12;   // per folder, before "show more"
const RECENT_SHOWN = 8;      // in the Recent section at the top of the tree
const RECENT_KEY = "__recent__";
const ACTIVE_WINDOW_MS = 24 * 3600 * 1000;   // folders with activity this recent open by themselves

// ---------- safety: Claude's text is rendered as markdown, never as raw HTML ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
marked.use({
  renderer: {
    html(token) { return esc(typeof token === "string" ? token : token.raw || token.text); },
    link(href, title, text) {
      if (typeof href === "object") { text = href.text; title = href.title; href = href.href; }
      const ok = /^https?:\/\//i.test(href || "");
      return ok ? `<a href="${esc(href)}" data-external="1" title="${esc(title || href)}">${text}</a>` : text;
    },
    image(href, title, text) { return esc(typeof href === "object" ? href.text : text || ""); },
  },
});
const md = (text) => marked.parse(text || "");
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a) return;
  e.preventDefault();
  if (a.dataset.external) api().open_url(a.getAttribute("href"));
});

// ---------- helpers ----------
const sameFolder = (a, b) => (!a && !b) || (a && b && a.toLowerCase().replace(/[\\/]+$/, "") === b.toLowerCase().replace(/[\\/]+$/, ""));
const keyOf = (cwd) => cwd ? cwd.toLowerCase().replace(/[\\/]+$/, "") : "";
const base = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p;
const rel = (p) => { const f = S.active?.cwd; return f && p && p.toLowerCase().startsWith(f.toLowerCase()) ? p.slice(f.length).replace(/^[\\/]/, "") : p; };
function ago(ms) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
const allSessions = () => Object.values(S.lists).flat();
const findSession = (id) => allSessions().find((s) => s.id === id);

// ---------- events from Python ----------
window.app = {
  events(list) {
    for (const e of list) {
      try { handle(e); } catch (err) { console.error(err, e); api().js_error(`${err} in ${e.kind}`); }
    }
  },
};
function handle(e) {
  switch (e.kind) {
    case "item":
      if (S.active && e.session === S.active.id) {
        S.items[e.item.i] = e.item; renderItem(e.item);
        if (planBox.isPlanItem(e.item)) planBox.update();
      }
      break;
    case "delta":
      if (S.active && e.session === S.active.id && S.items[e.i]) { S.items[e.i].text += e.text; scheduleRender(e.i); }
      break;
    case "sessions":
      S.lists[keyOf(e.cwd)] = e.sessions;
      for (const s of e.sessions) if (s.busy) S.busy.add(s.id);
      renderTree();
      break;
    case "workspaces":
      S.workspaces = e.workspaces;
      loadLists().then(renderTree);
      break;
    case "opened": {
      S.active = e.session; S.items = e.items || []; S.folder = e.session.cwd;
      const s = findSession(S.active.id); if (s) s.unseen = false;
      renderTranscript(); renderHead(); renderTree();   // its folder opens by itself (it holds the active session)
      tasks.sessionChanged();
      planBox.collapsed = null; planBox.update();
      if (window.btw?.session && btw.session !== S.active.id) btw.close();   // side chats belong to their conversation
      setSuggest("");
      composer.preload();
      showDisplay();   // the bar follows the conversation you switched to
      panel.refresh(true);
      break;
    }
    case "display": S.display = e; showDisplay(); break;
    case "levels": inbar.event(e); avatar.levels(e.levels); break;
    case "speech": avatar.speech(e); break;
    case "dictation": dictation(e); break;
    case "live": if (S.active && e.session === S.active.id) transcript.live(e.image); break;
    case "settings": S.settings = e.settings; renderToggles(); avatar.apply(); renderBusy(); renderName(); renderAwake(); break;
    case "folder": S.folder = e.folder; renderHead(); break;
    case "confirm_quit":
      confirmBox(`Claude is in the middle of a reply in ${e.busy.map((b) => `“${b.title}”`).join(", ")}. ` +
                 "Quitting now cuts it off (background tasks keep running and are picked up after a restart).",
                 () => api().quit(true));
      break;
    case "work":
      S.work[e.session] = e.session_state;
      setTimeout(showDisplay, 0);
      if (e.session_state === "idle") S.busy.delete(e.session); else S.busy.add(e.session);
      if (e.session_state === "background") S.bg.add(e.session); else S.bg.delete(e.session);
      renderTree();
      if (S.active && e.session === S.active.id) {
        S.active.busy = e.session_state !== "idle"; renderBusy(); transcript.refreshGroups();
        if (e.session_state === "idle") { panel.refresh(true); composer.preload(true); }
      }
      break;
    case "suggest":   // ignored while you're typing (it would only show after you send)
      if (S.active && e.session === S.active.id && !(e.text && $("#input").value)) setSuggest(e.text);
      break;
    case "btw": btw.event(e); break;
    case "update": renderUpdate(e); break;
    case "notice": toast(e.text); break;
    case "session_info":
      if (S.active && e.session.id === S.active.id) { Object.assign(S.active, e.session); renderExtraDirs(); }
      break;
    case "context":
      if (S.active && e.session === S.active.id) { S.active.context = e.context; renderContext(); }
      break;
    case "limits": renderLimits(e.limits); break;
    case "ui": showForClaude(e); break;
    case "mood": avatar.react(e.clip); break;
    case "train": training.onJudgement(e); break;
    case "open_training": training.open(); break;
    case "tool_done": case "baseline":
      if (S.active && e.session === S.active.id) panel.refresh(true);
      break;
  }
}

// ---------- header ----------
function renderFolder() {
  const cwd = S.active ? S.active.cwd : S.folder;
  if (document.activeElement !== $("#folderPath")) $("#folderPath").value = cwd || "";
  $("#modeBadge").textContent = cwd ? "CODE" : "CHAT";
  $("#modeBadge").className = "badge " + (cwd ? "code" : "chat");
}
// Yo Claudia with the female character, Yo Claude with the male one (the default), whether the face shows or not
const appName = () => (S.settings?.character === "female" ? "Yo Claudia" : "Yo Claude");
function renderName() {
  $("#top .brand").textContent = appName().toUpperCase();
  document.title = appName();
  if (avatar.el) avatar.el.dataset.tip = `${appName()} · click to talk`;
}
function renderAwake() {   // ☕ in the menu bar: lit while the PC is kept awake always
  const b = $("#awakeBtn"), on = S.settings?.keep_awake === true;
  b.classList.toggle("on", on);
  b.title = on ? "The PC is kept awake (it won't go to sleep while Yo Claude runs). Click to let it sleep when idle."
    : "Click to keep the PC awake always. (While Claude works it's kept awake anyway"
      + (S.settings?.awake_while_working === false ? ": that's off too, in Options)" : ")");
}
function renderToggles() {
  $("#tListen").classList.toggle("on", S.settings.listening !== false);
  $("#tVoice").classList.toggle("on", S.settings.voice_replies !== false);
  $("#tPc").classList.toggle("on", !!S.settings.pc_control);
}
// The window shows the conversation you have open: what Yo Claude is doing overall (any session) stays on the tray
// and the floating bar. Your voice (listening, speaking) and a question waiting in any session still show here.
const WORK_TO_STATE = { thinking: "thinking", using_pc: "using_pc", awaiting_approval: "approval", background: "background" };
function localDisplay() {
  const d = S.display || {}, voice = d.voice;
  const others = Object.entries(S.work).filter(([id, w]) => id !== S.active?.id && ["thinking", "using_pc", "awaiting_approval"].includes(w)).length;
  if (["listening", "speaking"].includes(voice) || d.state === "approval" || d.state === "starting" || d.state === "error") return { ...d, others };
  const mine = S.active ? (S.work[S.active.id] || (S.active.busy ? "thinking" : "idle")) : "idle";
  const state = WORK_TO_STATE[mine] || (voice === "thinking" ? "thinking" : voice === "paused" ? "paused" : "idle");
  return { ...d, state, others };
}
function showDisplay() {
  S.local = localDisplay();
  renderState();
  inbar.event({ ...S.local, kind: "display" });
}
function renderState() {
  const st = (S.local || S.display).state || "idle";
  let label = STATE_LABEL[st] || st;
  if (st === "thinking") label = SPIN[Math.floor(performance.now() / 120) % SPIN.length] + " thinking…";
  const others = S.local?.others || 0;
  if (others) label += ` · ${others} other${others > 1 ? "s" : ""} working`;
  $("#stateLabel").textContent = label;
  $("#stateLabel").style.color = MASCOT.colors[st] || "";
}
function animate() {   // spinners: header state, busy sessions in the tree, running activity groups
  const t = performance.now();
  if ((S.local || S.display).state === "thinking") renderState();
  const glyph = SPIN[Math.floor(t / 120) % SPIN.length];
  document.querySelectorAll(".spin").forEach((n) => { n.textContent = glyph; });
  if (Math.floor(t / 1000) !== animate.sec) {   // background-task timers, once a second
    animate.sec = Math.floor(t / 1000);
    document.querySelectorAll(".elapsed").forEach((n) => { n.textContent = fmtElapsed(Date.now() - +n.dataset.start); });
  }
  requestAnimationFrame(animate);
}
const inbar = new MiniBar($("#inbar"));

$("#folderBtn").onclick = (e) => {
  showMenu(e.currentTarget, [
    ["sub:new session in…"],
    ...S.workspaces.map((f) => ["  " + f, () => api().new_session(f)]),
    ["  chat (no folder)", () => api().new_session(null)],
    "-", ["add a folder…", () => api().add_folder()],
  ]);
};
$("#tListen").onclick = () => api().set_setting("listening", !(S.settings.listening !== false));
$("#tVoice").onclick = () => api().set_setting("voice_replies", !(S.settings.voice_replies !== false));
$("#tPc").onclick = () => api().set_setting("pc_control", !S.settings.pc_control);
$("#compactBtn").onclick = () => api().compact();
$("#helpBtn").onclick = () => training.open();
$("#logo").onclick = () => api().talk();
// ---------- the panes beside the chat: [sessions] on the left, [files] on the right, [focus] hides or brings back both ----------
const panes = {
  side() { return !$("#app").classList.contains("no-side"); },
  files() { return $("#app").classList.contains("with-panel"); },
  set(side, files) {
    if (side !== this.side()) { $("#app").classList.toggle("no-side", !side); api().set_setting("side_open", side); }
    if (files !== this.files()) { $("#app").classList.toggle("with-panel", files); api().set_setting("panel_open", files); panel.refresh(); }
    this.render();
  },
  focus() {   // just the chat; again: the panes that were open before
    if (this.side() || this.files()) { this.before = [this.side(), this.files()]; this.set(false, false); }
    else this.set(...(this.before || [true, false]));
  },
  render() {
    $("#sideBtn").classList.toggle("on", this.side());
    $("#panelBtn").classList.toggle("on", this.files());
    $("#focusBtn").classList.toggle("on", !this.side() && !this.files());
  },
};
$("#panelBtn").onclick = () => panes.set(panes.side(), !panes.files());
$("#sideBtn").onclick = () => panes.set(!panes.side(), panes.files());
$("#focusBtn").onclick = () => panes.focus();
new MutationObserver(() => panes.render()).observe($("#app"), { attributes: true, attributeFilter: ["class"] });   // (the panel opens itself too)

// ---------- sidebar: folders and their sessions ----------
async function loadLists() {
  const keys = [null, ...S.workspaces];
  const lists = await Promise.all(keys.map((cwd) => api().list_sessions(cwd)));
  keys.forEach((cwd, i) => { S.lists[keyOf(cwd)] = lists[i] || []; });
  for (const s of allSessions()) {
    if (s.busy) S.busy.add(s.id);
    if (s.background) { S.busy.add(s.id); S.bg.add(s.id); }
  }
}
// A folder is open when it has recent activity (busy, unseen reply, changed in the last day, or holds the session
// you're in), closed otherwise. Opening or closing one yourself wins until something new happens in it.
function lastActivity(sessions) {
  let t = 0;
  for (const s of sessions) {
    if (S.busy.has(s.id) || s.unseen || (S.active && s.id === S.active.id)) return Date.now();
    t = Math.max(t, s.modified || 0);
  }
  return t;
}
function isOpen(key, sessions, autoDefault) {
  const m = S.manual[key];
  const latest = sessions ? lastActivity(sessions) : 0;
  if (m && m.at >= latest) return m.open;
  return autoDefault !== undefined ? autoDefault : latest > Date.now() - ACTIVE_WINDOW_MS;
}
function setOpen(key, open) {
  S.manual[key] = { open, at: Date.now() };
  api().set_setting("tree_manual", S.manual);
}
function renderTree() {
  const tree = $("#tree");
  const scroll = tree.scrollTop;
  tree.innerHTML = "";
  const f = S.filter.toLowerCase();
  if (!f) {   // the latest sessions from every folder, so nothing recent hides in a collapsed folder
    const open = isOpen(RECENT_KEY, null, true);
    const recent = allSessions().slice().sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, RECENT_SHOWN);
    const head = el("div", "fnode recent");
    head.innerHTML = `<span class="tw">${open ? "▾" : "▸"}</span><span class="fname">◷ RECENT</span>` +
      `${recent.some((s) => S.busy.has(s.id)) ? '<span class="spin busy">✻</span>' : ""}` +
      `${recent.some((s) => s.unseen) ? '<span class="dot"></span>' : ""}`;
    head.title = "The latest sessions from every folder";
    head.onclick = () => { setOpen(RECENT_KEY, !open); renderTree(); };
    tree.appendChild(head);
    if (open) for (const s of recent) tree.appendChild(sessionRow(s, true));
  }
  const nodes = [{ key: "", cwd: null, label: "CHATS", title: "Conversations without a folder" },
                 ...S.workspaces.map((w) => ({ key: keyOf(w), cwd: w, label: base(w), title: w }))];
  for (const n of nodes) {
    const all = (S.lists[n.key] || []).filter((s) => !f || (s.title || "").toLowerCase().includes(f) || (s.first || "").toLowerCase().includes(f));
    const busy = all.some((s) => S.busy.has(s.id)), unseen = all.some((s) => s.unseen);
    const open = (f && all.length) || isOpen(n.key, S.lists[n.key] || []);
    const head = el("div", "fnode" + (sameFolder(S.active?.cwd ?? null, n.cwd) && S.active ? " here" : ""));
    head.innerHTML = `<span class="tw">${open ? "▾" : "▸"}</span><span class="fname">${n.cwd ? "▤ " : "◇ "}${esc(n.label)}</span>` +
      `${busy ? '<span class="spin busy">✻</span>' : ""}${unseen ? '<span class="dot" title="New reply"></span>' : ""}` +
      `<span class="spacer"></span><button class="fadd" title="New ${n.cwd ? "session in this folder" : "chat"}">+</button>`;
    head.title = n.title;
    head.onclick = (e) => {
      if (e.target.closest(".fadd")) return api().new_session(n.cwd);
      setOpen(n.key, !open); renderTree();
    };
    head.oncontextmenu = (e) => { e.preventDefault(); folderMenu(e, n); };
    tree.appendChild(head);
    if (!open) continue;
    const pinned = all.filter((s) => s.pinned);
    const grouped = S.groups.map((g) => [g, all.filter((s) => !s.pinned && s.group === g)]).filter(([, l]) => l.length);
    const rest = all.filter((s) => !s.pinned && !(s.group && S.groups.includes(s.group)));
    const rows = [...pinned.map((s) => ["", s]), ...grouped.flatMap(([g, l]) => [[g, null], ...l.map((s) => ["", s])])];
    const limit = S.more.has(n.key) || f ? rest.length : Math.max(0, SESSIONS_SHOWN - rows.length);
    rows.push(...rest.slice(0, limit).map((s) => ["", s]));
    for (const [g, s] of rows) tree.appendChild(s ? sessionRow(s) : el("div", "sgroup", esc(g)));
    if (rest.length > limit) {
      const more = el("div", "smore", `show ${rest.length - limit} more`);
      more.onclick = () => { S.more.add(n.key); renderTree(); };
      tree.appendChild(more);
    }
    if (!all.length) tree.appendChild(el("div", "smore dim", f ? "no matches" : "no sessions yet"));
  }
  tree.scrollTop = scroll;
}
function sessionRow(s, withFolder = false) {
  const row = el("div", "session" + (S.active && S.active.id === s.id ? " active" : "") + (s.unseen ? " unseen" : ""));
  const src = s.source && s.source !== "yoclaude" ? ` <span class="src">cli</span>` : "";
  const mark = S.bg.has(s.id) ? '<span class="spin busy bgtask" title="Background task running">✻</span>'
             : S.busy.has(s.id) ? '<span class="spin busy" title="Working">✻</span>'
             : s.unseen ? '<span class="dot" title="New reply you haven\'t seen"></span>' : "";
  const where = withFolder ? ` · ${s.cwd ? "▤ " + esc(base(s.cwd)) : "◇ chat"}` : "";
  row.innerHTML = `<div class="t">${mark}${s.pinned ? "▴ " : ""}${esc(s.title)}</div>
    <div class="m">${esc(ago(s.modified))}${where}${s.branch ? " · ⎇ " + esc(s.branch) : ""}${src}</div>`;
  row.title = s.first || s.title;
  row.onclick = () => api().open_session(s.id, s.cwd);
  row.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(e, s); };
  return row;
}
function folderMenu(e, n) {
  showMenu(e, [
    ["sub:" + (n.cwd || "chats")],
    [n.cwd ? "new session here" : "new chat", () => api().new_session(n.cwd)],
    n.cwd ? ["open in vs code", () => api().open_path(n.cwd, "code")] : null,
    n.cwd ? ["show in explorer", () => api().open_path(n.cwd, "open")] : null,
    n.cwd ? "-" : null,
    n.cwd ? ["remove from list (keeps files and sessions)", () => api().remove_folder(n.cwd)] : null,
  ].filter(Boolean));
}
function sessionMenu(e, s) {
  const groups = S.groups.filter((g) => g !== s.group).map((g) => ["  → " + g, () => api().set_group(s.id, s.cwd, g)]);
  showMenu(e, [
    ["rename…", () => ask("Rename session", s.title, (t) => api().rename(s.id, s.cwd, t))],
    [s.pinned ? "unpin" : "pin to top", () => api().pin(s.id, s.cwd, !s.pinned)],
    "-", ["sub:move to group"], ...groups,
    ["  → new group…", () => ask("New group", "", (g) => { if (!S.groups.includes(g)) S.groups.push(g); api().set_group(s.id, s.cwd, g); })],
    s.group ? ["  → no group", () => api().set_group(s.id, s.cwd, null)] : null,
    "-",
    ["fork (branch the conversation)", async () => { const err = await api().fork(s.id, s.cwd); if (err) alertBox(err); }],
    ["move to trash", () => confirmBox(`Move “${s.title}” to the trash? You can restore it from the trash.`,
      async () => { const err = await api().delete(s.id, s.cwd); if (err) alertBox(err); })],
  ].filter(Boolean));
}
$("#search").oninput = (e) => { S.filter = e.target.value; renderTree(); };
$("#addFolderBtn").onclick = () => api().add_folder();
$("#newChatBtn").onclick = () => api().new_session(null);
$("#cleanBtn").onclick = async () => {   // suggested stale sessions, all ticked, moved to the (restorable) trash
  const d = dialog("Clean up stale conversations");
  d.classList.add("wide");
  const note = el("div", "dim", "Looking for empty, short and long-untouched sessions…");
  d.appendChild(note);
  const rows = await api().stale_sessions();
  if (!rows.length) { note.textContent = "Nothing to clean up: everything has been used recently."; addButtons(d, [["close", closeModal, "primary"]]); return; }
  note.innerHTML = `${rows.length} suggestion${rows.length > 1 ? "s" : ""}. They go to the <b>trash</b>, where you can restore them. ` +
    "Pinned, open and busy sessions and anything used in the last week are never suggested.";
  const list = el("div", "cleanlist");
  const boxes = [];
  const byFolder = new Map();
  for (const r of rows) { const k = r.cwd || ""; if (!byFolder.has(k)) byFolder.set(k, []); byFolder.get(k).push(r); }
  for (const [k, items] of byFolder) {
    list.appendChild(el("div", "cleanfolder", esc(k ? "▤ " + k : "◇ chats")));
    for (const r of items) {
      const row = el("label", "cleanrow");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
      row.append(cb, el("span", "t", esc(r.title)), el("span", "why", esc(r.reason)),
                 el("span", "dim", esc(ago(r.modified)) + (r.source !== "yoclaude" ? " · cli" : "")));
      boxes.push([cb, r]); list.appendChild(row);
    }
  }
  d.appendChild(list);
  const go = () => {
    const picked = boxes.filter(([cb]) => cb.checked).map(([, r]) => ({ id: r.id, cwd: r.cwd }));
    goBtn.textContent = `move ${picked.length} to trash`; goBtn.disabled = !picked.length;
    return picked;
  };
  list.onchange = go;
  addButtons(d, [
    ["select all", () => { boxes.forEach(([cb]) => cb.checked = true); go(); }],
    ["select none", () => { boxes.forEach(([cb]) => cb.checked = false); go(); }],
    ["cancel", closeModal],
    ["move to trash", async () => {
      const picked = go();
      if (!picked.length) return;
      goBtn.disabled = true; goBtn.textContent = "moving…";
      const failed = await api().clean_up(picked);
      closeModal();
      if (failed?.length) alertBox(`Moved ${picked.length - failed.length}. ${failed.length} couldn't be moved: ` +
                                   failed.map((f) => f.error).filter((v, i, a) => a.indexOf(v) === i).join(" "));
    }, "danger"],
  ]);
  const goBtn = d.querySelector(".btns button:last-child");
  go();
};
$("#trashBtn").onclick = async () => {
  const rows = await api().trash();
  const d = dialog("Trash");
  if (!rows.length) d.appendChild(el("div", "dim", "The trash is empty."));
  for (const r of rows) {
    const row = el("div", "trash-row", `<span class="t">${esc(r.title)}</span><span class="dim">${esc(ago(r.deleted * 1000))}</span>`);
    const b = el("button", "", "restore");
    b.onclick = async () => { const err = await api().restore(r.id); if (err) alertBox(err); else row.remove(); };
    row.appendChild(b); d.appendChild(row);
  }
  addButtons(d, [["close", closeModal]]);
};

// ---------- session header: model / effort / permissions ----------
function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  sel.value = value ?? options[0][0];
}
function renderHead() {
  renderContext();
  const a = S.active;
  const title = a ? (findSession(a.id)?.title || "new session") : "new session";
  $("#sessionTitle").textContent = title + (a?.cwd ? `  ·  ${a.cwd}` : "");
  fillSelect($("#modelSel"), MODELS, a ? a.model : (S.settings.model || ""));
  fillSelect($("#effortSel"), EFFORTS, a ? a.effort : (S.settings.effort || ""));
  fillSelect($("#permSel"), PERMS, a ? a.permission_mode : "auto");
  $("#permSel").classList.toggle("hidden", !(a ? a.cwd : S.folder));
  renderFolder(); renderBusy(); renderExtraDirs();
}
function renderExtraDirs() {   // other folders this session may read and write
  const box = $("#extraDirs"), a = S.active;
  box.classList.toggle("hidden", !a);
  if (!a) return;
  box.innerHTML = `<span class="lbl">${(a.extra_dirs || []).length ? "also works in:" : "only this folder"}</span>`;
  for (const d of a.extra_dirs || []) {
    const chip = el("span", "xdir", `▤ ${esc(base(d))}<b title="Remove">×</b>`);
    chip.title = d + " · click to open · × to remove";
    chip.onclick = (e) => e.target.tagName === "B" ? api().remove_extra_dir(a.id, d) : api().open_path(d, "open");
    box.appendChild(chip);
  }
  const add = el("button", "", "+ folder");
  add.title = "Let this session also read and write another folder";
  add.onclick = async () => { const err = await api().add_extra_dir(a.id); if (err) alertBox(err); };
  box.appendChild(add);
}
async function ensureActive() {
  if (!S.active) S.active = await api().new_session();
  return S.active;
}
$("#modelSel").onchange = async (e) => { const a = await ensureActive(); a.model = e.target.value; api().set_model(a.id, e.target.value); };
$("#effortSel").onchange = async (e) => { const a = await ensureActive(); a.effort = e.target.value; api().set_effort(a.id, e.target.value); };
$("#permSel").onchange = async (e) => { const a = await ensureActive(); a.permission_mode = e.target.value; api().set_permission_mode(a.id, e.target.value); };

// ---------- transcript: messages, with consecutive tool steps folded into one activity summary ----------
const PC_KIND = { screenshot: "look", ocr: "look", pixels: "look", screen_info: "look", ui_tree: "look", ui_text: "look",
  ui_table: "look", list_windows: "look", wait_for: "wait", wait_for_change: "wait", wait: "wait", click: "click",
  double_click: "click", right_click: "click", drag: "click", mouse_down: "click", mouse_up: "click", mouse_move: "click",
  scroll: "click", path: "click", ellipse: "click", ui_act: "click", type_text: "type", press_key: "type", key_down: "type",
  key_up: "type", release_all: "type", clipboard: "type", launch: "app", focus_window: "app", set_window: "app",
  batch: "steps", macro: "steps" };
const PC_WORDS = { click: ["click", "clicks"], look: ["look", "looks"], type: ["typing", "typing"], app: ["window", "windows"],
  steps: ["batch", "batches"], wait: ["wait", "waits"] };
const CODE_KIND = { Read: "read", Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit", Bash: "run",
  PowerShell: "run", Grep: "search", Glob: "search", WebSearch: "web", WebFetch: "web", Task: "agent", Agent: "agent",
  TodoWrite: "plan" };
const CODE_WORDS = { read: ["read 1 file", "read %d files"], edit: ["edited 1 file", "edited %d files"],
  run: ["ran 1 command", "ran %d commands"], search: ["searched once", "searched %d×"], web: ["used the web once", "used the web %d×"],
  agent: ["ran 1 agent", "ran %d agents"], plan: ["updated the plan", "updated the plan %d×"], mcp: ["1 tool call", "%d tool calls"],
  other: ["1 other step", "%d other steps"], thought: ["thought", "thought %d×"] };
const isPc = (it) => (it.name || "").startsWith("mcp__screen-control__");

function summarize(items) {
  const pc = {}, code = {};
  let pcN = 0, errors = 0;
  for (const it of items) {
    if (it.status === "error") errors++;
    if (it.kind === "thinking") { code.thought = (code.thought || 0) + 1; continue; }
    if (isPc(it)) { pcN++; const k = PC_KIND[it.name.split("__").pop()] || "click"; pc[k] = (pc[k] || 0) + 1; continue; }
    const k = CODE_KIND[it.name] || (String(it.name).startsWith("mcp__") ? "mcp" : "other");
    code[k] = (code[k] || 0) + 1;
  }
  const parts = [];
  for (const k of ["click", "look", "type", "app", "steps", "wait"]) if (pc[k]) parts.push(`${pc[k]} ${PC_WORDS[k][pc[k] > 1 ? 1 : 0]}`);
  for (const k of ["edit", "run", "read", "search", "web", "agent", "plan", "mcp", "other", "thought"])
    if (code[k]) parts.push(CODE_WORDS[k][code[k] > 1 ? 1 : 0].replace("%d", code[k]));
  const title = pcN ? "Used your PC" : code.edit ? "Changed code" : code.run ? "Ran commands"
              : (code.read || code.search) ? "Explored" : code.web ? "Searched the web" : code.thought && items.length === code.thought ? "Thought" : "Worked";
  const steps = items.filter((i) => i.kind !== "thinking").length;
  return { title, pc: pcN > 0, text: parts.join(", "), steps, errors };
}

const transcript = {
  els: new Map(),      // item index -> element (messages)
  groupOf: new Map(),  // item index -> group
  groups: [], last: null, liveImage: null,

  reset() { this.els.clear(); this.groupOf.clear(); this.groups = []; this.last = null; this.liveImage = null; },
  // Queued messages wait in a box pinned at the bottom, below what Claude is still writing, until it takes them up.
  queue() {
    const t = $("#transcript");
    let q = t.querySelector(":scope > .queuebox");
    if (!q) {
      q = el("div", "queuebox"); t.appendChild(q);
      q.addEventListener("dragover", (e) => {   // the dragged message moves between the others as you go
        const drag = q.querySelector(".dragging");
        if (!drag) return;
        e.preventDefault();
        const after = [...q.children].find((c) => c !== drag && e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
        if (after !== drag.nextElementSibling) q.insertBefore(drag, after || null);
      });
      q.addEventListener("drop", (e) => {
        if (!q.querySelector(".dragging")) return;
        e.preventDefault(); e.stopPropagation();
        api().reorder_queue([...q.children].map((c) => +c.dataset.i).filter((i) => !isNaN(i)));
      });
    }
    return q;
  },
  // queued messages are in the order they'll go (qpos, from dragging them; new ones last)
  sortQueue() {
    const q = this.queue(), kids = [...q.children], sorted = kids.slice().sort((a, b) => a.dataset.qpos - b.dataset.qpos);
    if (sorted.some((c, k) => c !== kids[k])) sorted.forEach((c) => q.appendChild(c));
  },
  put(node) { $("#transcript").insertBefore(node, this.queue()); },   // into the flow, above the queue box
  running(g) {
    return g.items.some((i) => S.items[i]?.status === "running") || (g === this.last && !!S.active?.busy);
  },
  newGroup() {
    const g = { items: [], open: false, el: el("div", "group"), stepEls: new Map() };
    g.head = el("div", "ghead"); g.live = el("img", "glive hidden"); g.steps = el("div", "gsteps hidden");
    g.pics = el("div", "gpics hidden");   // pictures Claude looked at in these steps, shown even while folded
    g.el.append(g.head, g.pics, g.live, g.steps);
    g.head.onclick = () => { g.open = !g.open; g.steps.classList.toggle("hidden", !g.open); this.renderHead(g); };
    this.put(g.el);
    this.groups.push(g);
    return g;
  },
  renderHead(g) {
    const items = g.items.map((i) => S.items[i]).filter(Boolean);
    const sum = summarize(items);
    const run = this.running(g);
    const nowItem = [...items].reverse().find((i) => i.kind === "tool");
    const now = run && nowItem ? `${isPc(nowItem) ? nowItem.name.split("__").pop().replace(/_/g, " ") : nowItem.name} ${toolArg(nowItem.name, nowItem.input)}` : "";
    g.el.className = "group" + (run ? " running" : "") + (sum.pc ? " pc" : "") + (sum.errors ? " has-errors" : "");
    g.head.innerHTML = `<span class="gst">${run ? '<span class="spin">✻</span>' : sum.errors ? "!" : "●"}</span>` +
      `<span class="gtitle">${esc(sum.title)}</span><span class="gsum">${sum.steps > 1 ? `· ${sum.steps} steps · ` : "· "}${esc(sum.text)}` +
      `${sum.errors ? ` · <span class="del">${sum.errors} failed</span>` : ""}</span>` +
      `${now ? `<span class="gnow">now: ${esc(now)}</span>` : ""}<span class="spacer"></span>${whenHtml(items[0]?.ts, "gwhen")}` +
      `<span class="gtog">${g.open ? "▾ hide" : "▸ steps"}</span>`;
    const pics = items.filter((i) => i.image).slice(-6);
    if (g.pics.childElementCount !== pics.length || g.pics.dataset.last !== String(pics.at(-1)?.i)) {
      g.pics.innerHTML = "";
      g.pics.dataset.last = String(pics.at(-1)?.i);
      for (const it of pics) {
        const img = el("img", "gpic");
        img.src = it.image;
        const file = it.input?.file_path;
        img.dataset.tip = file ? `${file}
Click to open` : "What Claude saw · click to enlarge";
        img.onclick = (e) => { e.stopPropagation(); file ? viewFile(file) : showPicture(it.image, toolArg(it.name, it.input) || it.name); };
        g.pics.appendChild(img);
      }
    }
    g.pics.classList.toggle("hidden", !pics.length);
    const showLive = run && sum.pc && this.liveImage && g === this.last;
    g.live.classList.toggle("hidden", !showLive);
    if (showLive && g.live.src !== this.liveImage) g.live.src = this.liveImage;
  },
  refreshGroups() { for (const g of this.groups) this.renderHead(g); },
  live(image) {
    this.liveImage = image;
    if (this.last && this.last.items) this.renderHead(this.last);
  },
  addStep(g, it) {
    const node = it.kind === "thinking" ? thinkingCard(it) : toolCard(it);
    const old = g.stepEls.get(it.i);
    if (old) old.replaceWith(node); else g.steps.appendChild(node);
    g.stepEls.set(it.i, node);
  },
  render(it, bulk) {
    const t = $("#transcript");
    t.querySelector(".empty")?.remove();
    const prev = this.last;
    this.renderInner(it);
    if (prev && prev.items && prev !== this.last) this.renderHead(prev);   // something came after it: no longer "now"
    if (!bulk) follow.stick("chat", t);   // stays put once you've scrolled up (the follow toggle is off)
  },
  renderInner(it) {
    const t = $("#transcript");
    if (it.kind === "tool") {
      let g = this.groupOf.get(it.i);
      if (!g) {
        g = this.last && this.last.items ? this.last : this.newGroup();
        g.items.push(it.i); this.groupOf.set(it.i, g); this.last = g;
      }
      this.addStep(g, it);
      this.renderHead(g);
    } else {
      const node = buildItem(it);
      const old = this.els.get(it.i);
      const after = it.kind === "spoken" && this.els.get(it.for);
      const waiting = it.kind === "user" && it.queued, boxed = old?.parentElement?.classList.contains("queuebox");
      if (waiting && boxed) old.replaceWith(node);
      else if (waiting) { old?.remove(); this.queue().appendChild(node); }   // pinned at the bottom, in the order sent
      else if (boxed && it.kind === "user") {
        old.remove(); this.put(node); this.last = { item: it.i };   // Claude took it up: into the flow, here
      } else if (old) old.replaceWith(node);
      else if (after) {   // under the message it's about, after any earlier voice bubbles for it
        let at = after;
        while (at.nextElementSibling?.classList.contains("spoken")) at = at.nextElementSibling;
        at.after(node);
        if (!after.nextElementSibling || after === this.queue().previousElementSibling) this.last = { item: it.i };
      } else { this.put(node); this.last = { item: it.i }; }
      this.els.set(it.i, node);
      if (waiting) {   // drag it up or down the queue to change when it goes
        node.dataset.i = it.i; node.dataset.qpos = it.qpos ?? 1e6 + it.i;
        if (!it.sent_now) {
          node.draggable = true; node.classList.add("draggable");
          const grip = el("span", "qgrip", "⠿"); grip.dataset.tip = "Drag to change when it goes"; node.prepend(grip);
          node.ondragstart = (e) => { node.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(it.i)); };
          node.ondragend = () => node.classList.remove("dragging");
        }
        this.sortQueue();
      }
      node.querySelectorAll("pre code").forEach((c) => { try { hljs.highlightElement(c); } catch (_) {} });
      addCopyButtons(node, it);
      if (it.ts && ["user", "assistant", "advisor"].includes(it.kind)) node.insertAdjacentHTML("beforeend", whenHtml(it.ts, "bubble-when"));
      else if (it.ts && (it.kind === "note" || it.kind === "error")) node.insertAdjacentHTML("beforeend", " " + whenHtml(it.ts, "inline-when"));
      if (it.kind === "assistant" && !it.streaming) { mediaUnder(node, it); checklistUnder(node, it); }
    }
  },
};

// ---------- checklists: Claude's checklist tool as a card (and "- [ ]" lists in its messages): tick yes or no for each
// item, say why for any of them, add a note, [submit]: it all goes to Claude as your next message ----------
const checkState = new Map();   // "session:card" -> { yes: [bool], why: [text], open: [why box shown], note }
function checkRow(label, st, k, done, onChange) {
  const row = el("div", "crow");
  const box = el("input"); box.type = "checkbox"; box.checked = st.yes[k]; box.disabled = done;
  const text = el("span", "clabel"); text.textContent = label;
  const whyBtn = el("button", "cwhybtn", st.why[k] ? "why ✎" : "+ why");
  whyBtn.dataset.tip = "Say why (optional): it goes to Claude with your answer";
  const why = el("input", "cwhy");
  why.value = st.why[k];
  const sync = () => {
    row.classList.toggle("yes", st.yes[k]);
    why.classList.toggle("hidden", !st.open[k]);
    why.placeholder = st.yes[k] ? "why yes? (optional)" : "why not? (optional)";
    whyBtn.textContent = st.why[k] ? "why ✎" : "+ why";
  };
  box.onchange = () => { st.yes[k] = box.checked; sync(); onChange(); };
  row.onclick = (e) => {   // the whole line ticks, except the why parts
    if (done || e.target === box || e.target.closest(".cwhybtn, .cwhy, a")) return;
    box.checked = !box.checked; box.onchange();
  };
  whyBtn.onclick = (e) => { e.stopPropagation(); st.open[k] = !st.open[k]; sync(); if (st.open[k]) why.focus(); };
  why.oninput = () => { st.why[k] = why.value; whyBtn.textContent = st.why[k] ? "why ✎" : "+ why"; };
  why.onkeydown = (e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); if (!st.why[k].trim()) st.open[k] = false; sync(); } };
  whyBtn.disabled = done; why.disabled = done;
  row.append(box, text, whyBtn);
  sync();
  return [row, why];
}
function checkStateFor(key, n, ticked) {
  if (!checkState.has(key)) checkState.set(key, { yes: ticked || Array(n).fill(false), why: Array(n).fill(""), open: Array(n).fill(false), note: "" });
  return checkState.get(key);
}
function checklistCard(it) {
  const items = it.items || [], n = el("div", "question checklist " + it.status);
  if (it.status !== "pending") {   // answered (what you said), or from an earlier run (answered in the message after it)
    n.appendChild(el("div", "q", it.status === "answered" ? "✓ you answered" : "☑ checklist"));
    n.appendChild(el("div", "ctitle", esc(it.title || "")));
    items.forEach((x, k) => {
      const p = (it.picks || [])[k], r = el("div", "crow done" + (p?.yes ? " yes" : ""));
      r.appendChild(el("span", "cmark", p ? (p.yes ? "✓" : "✗") : "·"));
      const t = el("span", "clabel"); t.textContent = x; r.appendChild(t);
      if (p?.why) { const w = el("span", "cwhydone"); w.textContent = "— " + p.why; r.appendChild(w); }
      n.appendChild(r);
    });
    if (it.note) { const d = el("div", "cnote"); d.textContent = "Note: " + it.note; n.appendChild(d); }
    return n;
  }
  const sid = S.active.id, st = checkStateFor(`${sid}:${it.id}`, items.length, items.map((x) => (it.checked || []).includes(x)));
  n.appendChild(el("div", "q", "☑ Claude asks you to pick"));
  n.appendChild(el("div", "ctitle", esc(it.title || "")));
  const count = el("span", "dim"), upd = () => { count.textContent = `${st.yes.filter(Boolean).length} of ${items.length} ticked`; };
  const list = el("div", "clist");
  items.forEach((x, k) => list.append(...checkRow(x, st, k, false, upd)));
  n.appendChild(list);
  const note = el("input", "cnotein");
  note.placeholder = "Anything else? (optional)"; note.value = st.note;
  note.oninput = () => { st.note = note.value; };
  n.appendChild(note);
  const bar = el("div", "checkbar"), go = el("button", "primary", "[submit]");
  go.dataset.tip = "Send your answers to Claude: ticked = yes, the rest = no";
  go.onclick = async () => {
    go.disabled = true;
    const r = await api().checklist_answer(sid, it.id, st.yes.map((y, k) => ({ yes: y, why: st.why[k] })), st.note);
    if (r?.error) { go.disabled = false; return toast(r.error, "error"); }
    checkState.delete(`${sid}:${it.id}`);
    follow.set("chat", true); follow.stickAll("chat");
  };
  const all = el("button", "", "[all]"), none = el("button", "", "[none]");
  const setAll = (v) => list.querySelectorAll("input[type=checkbox]").forEach((b) => { b.checked = v; b.onchange(); });
  all.onclick = () => setAll(true); none.onclick = () => setAll(false);
  bar.append(go, all, none, count);
  n.appendChild(bar);
  upd();
  return n;
}

// "- [ ] item" lists in Claude's messages: the same rows (tick, why), answered with [submit] as your next message
const submittedLists = new Set();   // "session:message" already answered, so a re-render doesn't offer it again
function checklistUnder(node, it) {
  const lis = [...node.querySelectorAll("li")].filter((li) => li.querySelector(":scope > input[type=checkbox]"));
  if (!lis.length || !S.active) return;
  const key = `${S.active.id}:m${it.i}`, done = submittedLists.has(key);
  const labels = lis.map((li) => li.textContent.replace(/\s+/g, " ").trim());
  const st = checkStateFor(key, lis.length, lis.map((li) => li.querySelector("input").checked));
  const count = el("span", "dim"), upd = () => { count.textContent = `${st.yes.filter(Boolean).length} of ${lis.length} ticked`; };
  lis.forEach((li, k) => {   // each item becomes a row you can tick (its text kept plain)
    const [row, why] = checkRow(labels[k], st, k, done, upd);
    li.replaceChildren(row, why);
    li.classList.add("checkitem");
  });
  const bar = el("div", "checkbar"), go = el("button", "primary", done ? "[sent]" : "[submit]");
  go.disabled = done;
  go.dataset.tip = "Send your answers to Claude: ticked = yes, the rest = no";
  go.onclick = async (e) => {
    e.stopPropagation();
    const lines = labels.map((x, k) => (st.yes[k] ? "✓ yes: " : "✗ no: ") + x + (st.why[k].trim() ? `  (why: ${st.why[k].trim()})` : ""));
    submittedLists.add(key);
    node.querySelectorAll(".crow input, .crow button, .cwhy").forEach((b) => { b.disabled = true; });
    go.disabled = true; go.textContent = "[sent]";
    follow.set("chat", true); follow.stickAll("chat");
    await api().send("My answers to the checklist (ticked = yes):\n" + lines.join("\n"), [], []);
  };
  bar.append(go, count);
  upd();
  lis.at(-1).closest("ul, ol").after(bar);
}

// ---------- when things happened: relative for recent ones ("4m ago"), a time or date for older ones ----------
function whenText(ts) {
  const d = new Date(ts * 1000), ago_s = (Date.now() - d) / 1000;
  if (ago_s < 45) return "just now";
  if (ago_s < 3600) return Math.round(ago_s / 60) + "m ago";
  if (ago_s < 4 * 3600) return Math.floor(ago_s / 3600) + "h ago";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  if (now - d < 6 * 86400e3) return d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }) + " " + time;
}
const fullWhen = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function whenHtml(ts, cls = "") {
  return ts ? `<span class="when ${cls}" data-ts="${ts}" data-tip="${esc(fullWhen(ts))}">${esc(whenText(ts))}</span>` : "";
}
setInterval(() => document.querySelectorAll(".when[data-ts]").forEach((w) => { w.textContent = whenText(+w.dataset.ts); }), 30000);

const rawText = new WeakMap();   // message element -> its text as written (markdown), for "Copy message"
function addCopyButtons(node, it) {
  const raw = it.kind === "task" ? [it.description, it.summary, it.output_file].filter(Boolean).join("\n") : it.text;
  if (!raw) return;
  rawText.set(node, raw);
  if (node.classList.contains("msg") && (it.kind === "user" || it.kind === "assistant")) {
    const b = el("button", "copybtn", "⧉ copy");
    b.title = "Copy this message";
    b.onclick = (e) => { e.stopPropagation(); copyText(raw, "message copied"); };
    node.appendChild(b);
    if (it.kind === "assistant" && !it.streaming) {
      const v = el("button", "saybtn", "🔊 say it");
      v.dataset.tip = "Hear the short version of this message";
      v.onclick = async (e) => {
        e.stopPropagation(); v.disabled = true; v.textContent = "🔊 …";
        const r = await api().say_short(it.i);
        v.disabled = false; v.textContent = "🔊 say it";
        if (r?.error) toast(r.error, "error");
      };
      node.appendChild(v);
    }
  }
  node.querySelectorAll("pre").forEach((pre) => {
    const b = el("button", "codecopy", "copy");
    b.onclick = (e) => { e.stopPropagation(); copyText(pre.querySelector("code")?.textContent ?? pre.textContent, "code copied"); };
    pre.appendChild(b);
  });
}
function renderTranscript() {
  const t = $("#transcript");
  t.innerHTML = ""; transcript.reset();
  if (!S.items.length) {
    const cwd = S.active ? S.active.cwd : S.folder;
    t.appendChild(el("div", "empty", esc(cwd
      ? `code session in ${cwd}\n\nsay “${appName().toLowerCase()}” or type below`
      : `chat — no folder\n\nsay “${appName().toLowerCase()}” or type below\npick or add a folder (left) for coding`)));
  }
  // a message Claude took up after it had waited shows where it was taken up (`at`), not where it was sent
  const place = (it) => (it.at != null ? it.at - 0.5 : it.i);
  S.items.filter(Boolean).sort((a, b) => place(a) - place(b)).forEach((it) => transcript.render(it, true));
  follow.bind("chat", t);
  follow.set("chat", true);             // a freshly opened conversation starts at the newest message
  t.scrollTop = t.scrollHeight;
}
let renderTimer = null;
function scheduleRender(i) {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; const it = S.items[i]; if (it) transcript.render(it); }, 60);
}
function renderItem(it) { transcript.render(it, false); }
function buildItem(it) {
  switch (it.kind) {
    case "user": {
      const n = el("div", "msg user"); n.appendChild(document.createTextNode(it.text || ""));
      if (it.voice) n.appendChild(el("span", "mic", "🎤 voice"));
      if (it.queued_by === "claude") n.appendChild(el("span", "mic", "↻ queued by claude"));
      const cwd = S.active?.cwd;
      for (const p of it.attachments || []) n.appendChild(fileChip("📎 " + p, p, cwd));
      if (it.image_paths?.length) {
        const strip = el("div", "thumbs");
        for (const p of it.image_paths) strip.appendChild(mediaThumb(p, cwd));
        n.appendChild(strip);
      } else if (it.images) n.appendChild(el("span", "chip small", `🖼 ${it.images} image${it.images > 1 ? "s" : ""}`));
      if (it.queued && it.sent_now) {   // sent now: Claude Code has it, and reads it at its next step
        n.classList.add("queued");
        n.appendChild(el("span", "queuedtag", "➤ sent: Claude reads it at its next step"));
      } else if (it.queued) {   // waiting for the reply before it: it can still be taken back
        n.classList.add("queued");
        const q = el("span", "queuedtag", "⧗ queued ");
        const x = el("button", "", "✕ cancel");
        x.dataset.tip = "Don't send this: it goes back in the message box";
        x.onclick = async (e) => {
          e.stopPropagation();
          const r = await api().cancel_queued(it.i);
          if (r?.error) return toast(r.error, "error");
          const b = $("#input");
          b.value = r.text + (b.value ? "\n" + b.value : ""); autosize(); b.focus();
          for (const p of r.attachments || []) composer.attach(p);
        };
        if (!(it.text || "").trimStart().startsWith("/")) {   // commands only run between replies
          const now = el("button", "sendnow", "➤ send now");
          now.dataset.tip = "Give this to Claude now: it reads it at its next step instead of after this reply";
          now.onclick = async (e) => {
            e.stopPropagation(); now.disabled = true;
            const r = await api().send_now(it.i);
            if (r?.error) { now.disabled = false; toast(r.error, "error"); }
          };
          q.appendChild(now);
        }
        q.appendChild(x); n.appendChild(q);
      }
      if (it.uuid) {
        const rw = el("button", "rewindbtn", "⟲ rewind");
        rw.dataset.tip = "Go back to before this message: undo the conversation from here, the files, or both";
        rw.onclick = (e) => { e.stopPropagation(); showRewind(it); };
        n.appendChild(rw);
      }
      return n;
    }
    case "assistant": {   // (while it streams, the advisor's advice Claude is passing on stays out: it gets its own bubble)
      const text = it.streaming ? (it.text || "").replace(/<advisor>[\s\S]*?(<\/advisor>\s*|$)/g, "") : it.text;
      return el("div", "msg assistant" + (it.streaming ? " cursor" : ""), md(text));
    }
    case "advisor": {   // Claude's advisor: a third member of the chat. Its reply is encrypted, so this is Claude passing it on
      const wait = it.status === "asking" ? "reading the conversation…"
        : S.active?.busy ? "advice given · Claude is passing it on…" : "consulted · its advice wasn't passed on";
      const n = el("div", "msg advisor" + (it.text ? "" : " pending"), it.text ? md(it.text) : `<span class="ahint">${wait}</span>`);
      if (it.took) n.dataset.tip = `answered in ${it.took}s`;
      return n;
    }
    case "approval": return approvalCard(it);
    case "question": return questionCard(it);
    case "checklist": return checklistCard(it);
    case "task": return taskCard(it);
    case "cancelled": return el("div", "hidden");   // a queued message you took back
    case "thinking": return thoughtBubble(it);
    case "spoken": {   // what Yo Claude said out loud about Claude's message, in case you missed it
      const n = el("div", "spoken", `<span class="sicon">🔊</span><span class="stext">“${esc(it.text)}”</span>`);
      const b = el("button", "", "▶ again");
      b.dataset.tip = "Say it again";
      b.onclick = (e) => { e.stopPropagation(); api().say_again(it.text); };
      n.appendChild(b);
      return n;
    }
    case "note": return el("div", "msg note", "⧗ " + esc(it.text));
    case "result": {
      const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0);
      return el("div", "msg result", esc(`— ${k(it.tokens)} tokens processed (${k(it.cached)} cached) · ` +
        (it.cost == null ? "" : `$${it.cost.toFixed(4)} api-equivalent · `) + `${((it.duration || 0) / 1000).toFixed(1)}s`));
    }
    case "error": {
      const n = el("div", "msg error", "✗ " + esc(it.text));
      const isLast = S.items.slice(it.i + 1).every((x) => !x || ["note", "result", "cancelled"].includes(x.kind));
      if (isLast && S.items.some((x) => x?.kind === "user")) {   // only on the latest error: send your last message again
        const b = el("button", "retrybtn", "↻ retry");
        b.dataset.tip = "Send your last message again";
        b.onclick = async (e) => {
          e.stopPropagation(); b.disabled = true;
          const r = await api().retry();
          if (r?.error) { b.disabled = false; toast(r.error, "error"); } else b.remove();
        };
        n.appendChild(b);
      }
      return n;
    }
  }
  return el("div", "msg dim", esc(JSON.stringify(it)));
}
function toolArg(name, inp) {
  inp = inp || {};
  const p = inp.file_path || inp.notebook_path || inp.path;
  if (name === "Bash" || name === "PowerShell") return inp.description || inp.command;
  if (p) return rel(p);
  if (inp.x != null && inp.y != null) return `(${inp.x}, ${inp.y})`;
  if (name === "AskUserQuestion" && Array.isArray(inp.questions)) return inp.questions.map((q) => q?.question).filter(Boolean).join(" · ");
  return inp.pattern || inp.query || inp.url || inp.text || inp.keys || inp.title || inp.prompt || inp.description ||
    Object.values(inp).find((v) => typeof v === "string") || "";
}
function diffHtml(oldS, newS) {
  const a = (oldS || "").split("\n"), b = (newS || "").split("\n");
  return `<pre class="diff">${a.map((l) => `<span class="del">- ${esc(l)}</span>`).join("")}${b.map((l) => `<span class="add">+ ${esc(l)}</span>`).join("")}</pre>`;
}
function toolBody(name, inp, result) {
  inp = inp || {};
  let h = "";
  if (name === "Edit") h = diffHtml(inp.old_string, inp.new_string);
  else if (name === "MultiEdit") h = (inp.edits || []).map((e) => diffHtml(e.old_string, e.new_string)).join("");
  else if (name === "Write") h = `<pre>${esc((inp.content || "").slice(0, 6000))}</pre>`;
  else if (name === "Bash" || name === "PowerShell") h = `<pre>${name === "Bash" ? "$" : "PS>"} ${esc(inp.command)}</pre>`;
  else h = `<pre>${esc(JSON.stringify(inp, null, 2))}</pre>`;
  if (result) h += `<pre>${esc(result)}</pre>`;
  return h;
}
function toolCard(it) {
  const pc = isPc(it);
  const name = pc ? it.name.split("__").pop().replace(/_/g, " ") : (it.name || "").replace(/^mcp__/, "");
  const d = el("details", `card step ${it.status || "done"}${pc ? " pc" : ""}`);
  const st = { running: '<span class="spin">✻</span>', done: "●", error: "✗", denied: "⊘" }[it.status] || "●";
  d.innerHTML = `<summary><span class="st">${st}</span><span class="name">${esc(name)}</span><span class="arg">${esc(toolArg(it.name, it.input))}</span>` +
    `${it.image ? `<img class="stepthumb" src="${it.image}">` : ""}</summary>`;
  const body = el("div", "body", "");
  d.addEventListener("toggle", () => {
    if (d.open && !body.innerHTML) {
      body.innerHTML = (it.image ? `<img class="shot" src="${it.image}" title="What Claude saw">` : "") + toolBody(it.name, it.input, it.result);
      const path = (it.input || {}).file_path;
      if (path && MEDIA_RE_ONE.test(path)) body.prepend(mediaThumb(path, S.active?.cwd));
    }
  });
  d.appendChild(body);
  return d;
}
function thinkingCard(it) {
  const d = el("details", "card step");
  d.innerHTML = `<summary><span class="st">✻</span><span class="dim">thinking</span></summary>`;
  d.appendChild(el("div", "body msg thinking", esc(it.text)));
  return d;
}
function approvalCard(it) {
  const n = el("div", "approval " + it.status);
  const head = it.status === "pending" ? "Claude wants to " : it.status === "allowed" ? "✓ allowed: " : "⊘ denied: ";
  n.innerHTML = `<div class="q">${esc(head + it.summary)}</div>`;
  const d = el("details", "card"); d.innerHTML = `<summary><span class="name">${esc(it.tool)}</span><span class="arg">${esc(toolArg(it.tool, it.input))}</span></summary>`;
  d.appendChild(el("div", "body", toolBody(it.tool, it.input)));
  if (it.status === "pending") d.open = true;
  n.appendChild(d);
  if (it.status === "pending") {
    const b = el("div", "btns");
    const sid = S.active.id;
    const btn = (label, cls, allow, always) => { const x = el("button", cls, label); x.onclick = () => api().approve(sid, it.id, allow, always); b.appendChild(x); };
    btn("[allow]", "primary", true, false);
    btn(`[always allow ${it.tool.replace(/^mcp__/, "")} this session]`, "", true, true);
    btn("[deny]", "danger", false, false);
    n.appendChild(b);
  }
  return n;
}
// Claude's AskUserQuestion: one button per option, an "Other…" box, send / skip. What you've picked so far is kept
// outside the card, so it survives the card being drawn again (switching sessions and back).
const questionPicks = new Map();   // "session:question card id" -> per question { picked: [labels], other: "" }
function questionHead(q) {
  return el("div", "qhead", `${q.header ? `<span class="qchip">${esc(q.header)}</span>` : ""}<span class="qtext">${esc(q.question)}</span>` +
    (q.multiSelect ? `<span class="qmulti">(pick any)</span>` : ""));
}
function questionCard(it) {
  const qs = it.questions || [];
  const n = el("div", "question " + it.status);
  if (it.status !== "pending") {   // answered or skipped: what was chosen, read-only
    n.appendChild(el("div", "q", it.status === "answered" ? "✓ you answered" : "⊘ skipped: Claude carries on without an answer"));
    for (const q of qs) {
      const a = (it.answers || {})[q.question], b = el("div", "qblock");
      b.appendChild(questionHead(q));
      b.appendChild(a ? el("div", "qans", esc(Array.isArray(a) ? a.join(", ") : a)) : el("div", "qans none", "no answer"));
      n.appendChild(b);
    }
    return n;
  }
  const sid = S.active.id, key = `${sid}:${it.id}`;
  if (!questionPicks.has(key)) questionPicks.set(key, qs.map(() => ({ picked: [], other: "" })));
  const st = questionPicks.get(key);
  const quick = qs.length === 1 && !qs[0].multiSelect;   // a single one-choice question: clicking an option answers it
  n.appendChild(el("div", "q", "? Claude asks" + (qs.length > 1 ? ` ${qs.length} questions` : "")));
  const answers = () => {   // {question: label or typed text}, a list for multi-select (the shape Claude Code takes)
    const r = {};
    qs.forEach((q, k) => {
      const o = st[k].other.trim();
      const a = q.multiSelect ? [...st[k].picked, ...(o ? [o] : [])] : o || st[k].picked[0];
      if (a && a.length) r[q.question] = a;
    });
    return r;
  };
  let sent = false;
  const send = (ans) => {
    if (sent) return;
    sent = true;
    n.querySelectorAll("button, input").forEach((x) => { x.disabled = true; });
    questionPicks.delete(key);
    api().answer_question(sid, it.id, ans);
  };
  const sendBtn = el("button", "primary", "[send]");
  const ready = () => { sendBtn.disabled = !Object.keys(answers()).length; };
  qs.forEach((q, k) => {
    const s = st[k], b = el("div", "qblock"), opts = el("div", "qopts"), other = el("input");
    const sync = () => {
      opts.querySelectorAll(".qopt").forEach((x) => x.classList.toggle("on", s.picked.includes(x.dataset.label)));
      other.classList.toggle("on", !!s.other.trim());
      ready();
    };
    b.appendChild(questionHead(q));
    for (const o of q.options || []) {
      const x = el("button", "qopt" + (q.multiSelect ? "" : " radio"),
        `<span class="ql">${esc(o.label)}</span>` + (o.description ? `<span class="qd">${esc(o.description)}</span>` : ""));
      x.dataset.label = o.label;
      x.onclick = () => {
        if (q.multiSelect) s.picked = s.picked.includes(o.label) ? s.picked.filter((l) => l !== o.label) : [...s.picked, o.label];
        else { s.picked = [o.label]; s.other = ""; other.value = ""; }
        sync();
        if (quick) send(answers());
      };
      opts.appendChild(x);
    }
    b.appendChild(opts);
    const row = el("div", "qother");
    other.placeholder = q.multiSelect ? "Other… add your own" : "Other… type your own answer";
    other.value = s.other;
    other.oninput = () => { s.other = other.value; if (!q.multiSelect && s.other.trim()) s.picked = []; sync(); };
    other.onkeydown = (e) => { if (e.key === "Enter" && qs.length === 1 && Object.keys(answers()).length) send(answers()); };
    row.appendChild(other);
    b.appendChild(row);
    n.appendChild(b);
    sync();
  });
  const btns = el("div", "btns");
  sendBtn.dataset.tip = "Send your answers to Claude";
  sendBtn.onclick = () => send(answers());
  const skip = el("button", "danger", "[skip]");
  skip.dataset.tip = "Don't answer: Claude carries on without it";
  skip.onclick = () => send(null);
  btns.append(sendBtn, skip);
  n.appendChild(btns);
  return n;
}
// Claude Code's task summaries mostly repeat the command ("Background command "<command>" completed (exit code 0)"). Keep only
// what they add: the exit code, and a note when there is real text (an agent's reason for failing, Yo Claude's own notes).
const TASK_TAILS = [
  [/^completed \(exit code (-?\d+)\)\.?$/, "code"], [/^failed with exit code (-?\d+)\.?$/, "code"], [/^script failed \(exit (-?\d+)\)\.?$/, "code"],
  [/^(?:finished|stream ended|was stopped(?: by the user)?|was killed)\.?$/, ""], [/^failed: ([\s\S]+)$/, "note"],
  [/^(is waiting on its own background work)\.?$/, "note"]];
function taskOutcome(it) {   // -> { code, note, quoted }: the exit code (or null), extra text worth showing, the quoted command
  const s = (it.summary || "").trim();
  let code = it.exit_code ?? null, note = s, quoted = "";
  const tail = (rest) => {
    for (const [re, what] of TASK_TAILS) {
      const m = rest.match(re);
      if (m) { if (what === "code") code = +m[1]; note = what === "note" ? m[1] : ""; return true; }
    }
    return false;
  };
  const prefixes = ["Background command", "Agent", "Task", "Monitor"];
  const known = [it.description, it.command].filter(Boolean);
  let done = prefixes.some((p) => known.some((q) => s.startsWith(`${p} "${q}" `) && tail(s.slice(p.length + q.length + 4)) && ((quoted = q), true)));
  if (!done) {   // the quoted part isn't one we know: take the longest quote that ends in a known tail (commands hold quotes too)
    const m = s.match(/^(?:Background command|Agent|Task|Monitor) "([\s\S]*)" ([\s\S]+)$/);
    if (m && tail(m[2])) { quoted = m[1]; done = true; }
  }
  if (!done) {
    const m = s.match(/^Ran to the end \(exit code (-?\d+)\)\.?$/);   // Yo Claude's own, for tasks it followed across a restart
    if (m) { code = +m[1]; note = ""; }
  }
  if (note === it.description) note = "";
  return { code, note, quoted };
}
function shortCommand(cmd) {   // a shell command, readable: no "cd <folder> &&" steps, one line
  const parts = cmd.replace(/\s+/g, " ").trim().split(/\s*(&&|\|\||;)\s*/);   // [part, sep, part, sep, …]
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (/^(cd|pushd|Set-Location|sl)( (("[^"]*"|'[^']*'|(\\ |[^ ])+)))?$/i.test(parts[i]) && i + 2 < parts.length) continue;
    out.push(parts[i], parts[i + 1]);
  }
  return out.filter((x) => x != null).join(" ").replace(/ (;|&&|\|\|)$/, "").replace(/ ;/g, ";") || cmd.trim();
}
const taskOpen = new Set();   // "<task id>:cmd" / "<task id>:note" that are expanded, kept across re-renders
function taskCard(it) {   // a background task: running timer, stop, its output, how it ended, the command on demand
  const running = it.status === "running" || it.status === "pending";
  const icon = running ? '<span class="spin">✻</span>' : { completed: "✓", failed: "✗", stopped: "⊘", killed: "⊘" }[it.status] || "●";
  const n = el("div", `taskcard ${running ? "running" : it.status}`);
  const out = taskOutcome(it);
  const desc = (it.description || "").trim();
  const shellish = (s) => s.length > 60 || /&&|\|\||;|\|/.test(s);
  // the full command: what the tool ran, else the summary's quote, else a description that is itself a command
  const cmd = (it.command || (out.quoted && out.quoted !== desc ? out.quoted : "") || (shellish(desc) ? desc : "")).trim();
  const label = desc && desc !== cmd ? desc : shortCommand(cmd || desc);
  const kind = /agent/.test(it.type || "") ? "agent" : it.command || /bash|shell/.test(it.type || "") ? "command" : "task";
  const took = it.started && it.ended ? fmtElapsed((it.ended - it.started) * 1000) : "";
  const word = { completed: "finished", failed: "failed", stopped: "stopped", killed: "stopped" }[it.status] || it.status;
  const stat = [word, out.code != null ? `exit ${out.code}` : "",
                took && (["stopped", "killed"].includes(it.status) ? `after ${took}` : took)].filter(Boolean).join(" · ");
  n.innerHTML = `<span class="ticon">${icon}</span><span class="tlabel"><span class="tbg">background </span>${kind}</span>` +
    `<span class="tdesc">${esc(label)}</span>` +
    (running ? `<span class="tstat">running <span class="elapsed" data-start="${(it.started || 0) * 1000}"></span></span>` : `<span class="tstat">${esc(stat)}</span>`) +
    (it.last_tool && running ? `<span class="dim">· ${esc(it.last_tool)}</span>` : "") + `<span class="spacer"></span>` + whenHtml(it.started, "gwhen");
  n.querySelector(".tdesc").dataset.tip = desc || cmd;
  const wrap = el("div", "taskwrap"); wrap.appendChild(n);
  wrap.dataset.task = it.task_id || "";
  let cmdBox = null;
  const fold = (key, toggle, body, open, shut) => {   // a toggle that shows/hides body, remembered per task
    const set = (on) => { body.classList.toggle("hidden", !on); toggle.textContent = on ? open : shut; };
    set(taskOpen.has(key));
    toggle.onclick = (e) => { e.stopPropagation(); taskOpen.has(key) ? taskOpen.delete(key) : taskOpen.add(key); set(taskOpen.has(key)); };
  };
  if (cmd && cmd !== label) {
    const t = el("button", "tcmdtoggle");
    t.dataset.tip = "Show the full command";
    n.appendChild(t);
    const box = el("div", "tcmd");
    const pre = el("pre", "tcmdtext"); pre.textContent = cmd;
    const cp = el("button", "tcmdcopy", "copy");
    cp.onclick = (e) => { e.stopPropagation(); copyText(cmd, "command copied"); };
    box.append(pre, cp);
    fold(`${it.task_id}:cmd`, t, box, "▾ command", "▸ command");
    cmdBox = box;
  }
  if (running && !it.detached) {
    const b = el("button", "danger", "[stop]");
    b.onclick = async () => { const err = await api().stop_task(S.active.id, it.task_id); if (err) alertBox(err); };
    n.appendChild(b);
  }
  if (it.output_file) {
    const b = el("button", "", "[output]");
    b.onclick = () => viewFile(it.output_file);
    n.appendChild(b);
  }
  if (it.detached && running) wrap.appendChild(el("div", "tnote", "Started before Yo Claude restarted and still running; Claude will be told when it finishes."));
  if (out.note && !running) {   // real extra text: two lines, the rest on click
    const note = el("div", `tnote${it.status === "failed" ? " bad" : ""}`);
    const text = el("span", "tnotetext"); text.textContent = out.note;
    note.appendChild(text);
    if (out.note.length > 160 || out.note.includes("\n")) {
      const more = el("button", "tmore");
      note.appendChild(more);
      const clamp = (on) => { note.classList.toggle("clamp", !on); more.textContent = on ? "less" : "more"; };
      clamp(taskOpen.has(`${it.task_id}:note`));
      more.onclick = (e) => { e.stopPropagation(); const k = `${it.task_id}:note`; taskOpen.has(k) ? taskOpen.delete(k) : taskOpen.add(k); clamp(taskOpen.has(k)); };
    }
    wrap.appendChild(note);
  }
  if (cmdBox) wrap.appendChild(cmdBox);
  return wrap;
}
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
function renderBusy() {
  const box = $("#input"), hint = S.suggest && S.settings.suggest_next !== false ? S.suggest : "";
  box.classList.toggle("suggesting", !!hint);   // a suggested next message, grey in the empty box: Tab takes it
  box.placeholder = hint ? `${hint}   Tab ↹`
    : S.active?.busy
    ? "> claude is working — you can queue another message"
    : "> message claude…  (Enter sends · Shift+Enter new line · @ attaches a file · paste images)";
}
function setSuggest(text) { if ((S.suggest || "") !== (text || "")) { S.suggest = text || ""; renderBusy(); } }

// ---------- your message, tidied by Haiku (sessions.tidy_text): spelling and grammar fixed as you pause typing (Ctrl+Z
// undoes it), and what you say shows in the box, gets fixed, then is sent (yo_claude.py VoiceEngine.tidy) ----------
const tidy = { busy: false, timer: 0, seen: new Set(), dictating: false };
function dictation(e) {
  const box = $("#input");
  if (e.session && S.active && e.session !== S.active.id) return;
  if (e.stage === "sent") {
    if (tidy.dictating) { tidy.dictating = false; box.value = ""; box.classList.remove("dictating"); autosize(); }
    return;
  }
  if (!tidy.dictating && box.value.trim()) return;   // you're typing something else: leave it be
  tidy.dictating = true;
  box.value = e.text || ""; tidy.seen.add(box.value);
  box.classList.toggle("dictating", e.stage === "heard");   // grey while it's being fixed
  autosize();
}
function tidySoon() {
  clearTimeout(tidy.timer);
  if (S.settings.fix_text !== false) tidy.timer = setTimeout(tidyNow, 1600);
}
async function tidyNow() {
  const box = $("#input"), text = box.value, t = text.trim();
  if (tidy.busy || tidy.dictating || tidy.seen.has(text) || t.split(/\s+/).length < 3 || t.startsWith("/")
      || !$("#atlist").classList.contains("hidden")) return;
  tidy.busy = true;
  let fixed = text;
  try { fixed = (await api().fix_text(text))?.text || text; } catch (_) { /* left as typed */ } finally { tidy.busy = false; }
  if (box.value !== text) return tidySoon();   // you kept typing: again at your next pause
  tidy.seen.add(text); tidy.seen.add(fixed);   // (so an undo isn't fixed all over again)
  if (fixed === text || tidy.dictating || !$("#atlist").classList.contains("hidden")) return;
  const fromEnd = text.length - box.selectionEnd, focused = document.activeElement === box;
  box.focus(); box.select();
  document.execCommand("insertText", false, fixed);   // one edit: Ctrl+Z puts back what you typed
  const at = Math.max(0, fixed.length - fromEnd); box.setSelectionRange(at, at);
  if (!focused) box.blur();
  box.classList.add("tidied"); setTimeout(() => box.classList.remove("tidied"), 900);
  autosize();
}

// ---------- files and media: chips, thumbnails, previews under replies, the viewer, open with… ----------
const MEDIA_EXT = "png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|flac|pdf";
// Paths in plain text: folders may contain spaces ("D:\Oddly Based\..."), the file name may not.
const MEDIA_RE = new RegExp(String.raw`(?:[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\`]+[\\/])*|(?:\.{0,2}[\\/])?(?:[\w.\-~]+[\\/])+)?[^\\/\s:*?"<>|\`()\[\]]+\.(?:${MEDIA_EXT})\b`, "gi");
const MEDIA_RE_ONE = new RegExp(String.raw`\.(?:${MEDIA_EXT})$`, "i");
const looksLikePath = (t) => /^([A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])/.test(t) || /^[\w.\- ]+([\\/][\w.\- ]+)+[\\/]?$/.test(t) || /^[\w\-]+\.[A-Za-z0-9]{1,6}$/.test(t);
const mediaCache = new Map();

function fileMenuItems(path, cwd, apps) {
  // apps: the "open with" choices Windows has for this type (filled in a moment after the menu opens)
  const openWith = apps === undefined ? [["  …", () => {}, { disabled: true }]]
    : apps.map((h) => ["  " + h.name + (h.default ? "  (default)" : ""), () => api().open_with(path, h.id, cwd)]);
  return [
    ["sub:" + base(path)],
    ["preview", () => viewFile(path, cwd)],
    ["pop out in its own window", () => api().pop_out(path, cwd)],
    ["show in explorer", () => api().open_path(path, "reveal", cwd)],
    ["copy path", async () => { const m = await api().media(path, cwd); copyText(m.path || path, "path copied"); }],
    "-", ["sub:open with"], ...openWith,
    ["  choose another app…", () => api().open_path(path, "openwith", cwd)],
  ];
}
function showFileMenu(e, path, cwd, extra = []) {   // right-click on any file: shown at once, apps added when found
  e.preventDefault(); e.stopPropagation();
  const at = { clientX: e.clientX, clientY: e.clientY };
  showMenu(at, [...extra, ...fileMenuItems(path, cwd)]);
  const token = showFileMenu.token = {};
  api().open_with_options(path, cwd).then((apps) => {
    if (showFileMenu.token === token && !$("#menu").classList.contains("hidden")) showMenu(at, [...extra, ...fileMenuItems(path, cwd, apps || [])]);
  });
}
function fileChip(label, path, cwd) {
  const c = el("span", "chip small link", esc(label));
  c.title = "Click to preview · right-click for more";
  c.onclick = () => viewFile(path, cwd);
  c.oncontextmenu = (e) => showFileMenu(e, path, cwd);
  return c;
}
function mediaThumb(path, cwd, info) {
  const box = el("span", "mthumb", "…");
  box.title = base(path) + " · click to view · right-click for more";
  box.onclick = () => viewFile(path, cwd);
  box.oncontextmenu = (e) => showFileMenu(e, path, cwd);
  (info ? Promise.resolve(info) : api().media(path, cwd)).then((m) => {
    if (!m || m.error) { box.textContent = "missing: " + base(path); box.classList.add("missing"); return; }
    box.innerHTML = "";
    if (m.kind === "image") { const img = el("img"); img.src = m.url; box.appendChild(img); }
    else if (m.kind === "video") { box.classList.add("vid"); box.title = ""; box.appendChild(retroPlayer(m, { cwd })); }
    else if (m.kind === "audio") { box.classList.add("wide"); box.innerHTML = `<div class="mname">♪ ${esc(m.name)}</div>`; const a = el("audio"); a.src = m.url; a.controls = true; box.appendChild(a); a.onclick = (e) => e.stopPropagation(); }
    else box.innerHTML = `<div class="mname">${m.kind === "pdf" ? "▤ PDF" : "▤"} ${esc(m.name)}</div>`;
  });
  return box;
}
function mediaUnder(node, it) {
  // Paths a reply mentions become links (click: preview, right-click: open with...; folders open in Explorer), and
  // pictures, video, audio and PDFs among them are shown underneath it.
  const codes = [...node.querySelectorAll("code")].filter((c) => !c.closest("pre"));
  const tokens = new Set(codes.map((c) => c.textContent.trim()).filter(looksLikePath));
  for (const m of (it.text || "").match(MEDIA_RE) || []) tokens.add(m.trim());
  if (!tokens.size) return;
  const cwd = S.active?.cwd;
  const show = (list) => {
    const byToken = new Map(list.map((m) => [m.token, m]));
    for (const c of codes) {
      const m = byToken.get(c.textContent.trim());
      if (!m) continue;
      c.classList.add("pathlink");
      c.title = m.kind === "dir" ? "Open this folder · right-click for more" : "Preview · right-click for open with…";
      c.onclick = () => m.kind === "dir" ? api().open_path(m.path, "open") : viewFile(m.path, cwd);
      c.oncontextmenu = (e) => {
        if (m.kind !== "dir") return showFileMenu(e, m.path, cwd);
        e.preventDefault(); e.stopPropagation();
        showMenu(e, [["sub:" + m.name], ["open in explorer", () => api().open_path(m.path, "open")],
          ["open in vs code", () => api().open_path(m.path, "code")], ["copy path", () => copyText(m.path, "path copied")]]);
      };
    }
    const seen = new Set(), media = list.filter((m) => !["dir", "file"].includes(m.kind) && !seen.has(m.path) && seen.add(m.path));
    if (!media.length) return;
    const strip = el("div", "thumbs");
    for (const m of media) strip.appendChild(mediaThumb(m.path, cwd, m));
    node.appendChild(strip);
  };
  if (mediaCache.has(it.i)) return show(mediaCache.get(it.i));
  api().resolve_paths([...tokens], cwd).then((list) => { mediaCache.set(it.i, list || []); show(list || []); });
}
async function viewFile(path, cwd, opts = {}) {
  const m = await api().media(path, cwd);
  if (!m || m.error) return alertBox(m?.error || "Couldn't open that.");
  const d = dialog(m.name);
  d.classList.add("wide");
  d.appendChild(el("div", "dim small", esc(m.path)));
  if (m.kind === "image") { const img = el("img", "viewer-media"); img.src = m.url; d.appendChild(img); }
  else if (m.kind === "video") d.appendChild(retroPlayer(m, { autoplay: true, big: true, cwd }));
  else if (m.kind === "audio") { const a = el("audio"); a.src = m.url; a.controls = true; a.autoplay = true; a.style.width = "100%"; d.appendChild(a); }
  else if (m.kind === "pdf") { const f = el("iframe", "viewer-pdf"); f.src = m.url; d.appendChild(f); }
  else {
    const f = await api().read_any(path, cwd);
    if (f.error) d.appendChild(el("div", "", esc(f.error)));
    else if (f.binary) d.appendChild(el("div", "dim", `binary file, ${f.size} bytes: use open or open with…`));
    else textView(d, f, path, cwd);
  }
  const buttons = [["pop out ⤢", () => { closeModal(); api().pop_out(m.path); }],
                   ["open", () => api().open_path(m.path, "open")],
                   ["open with ▾", async (e) => {
                     const r = e.currentTarget.getBoundingClientRect();
                     const apps = await api().open_with_options(m.path);
                     showMenu({ clientX: r.left, clientY: r.top - 8 - 24 * (apps.length + 2) },
                       [...apps.map((h) => [h.name + (h.default ? "  (default)" : ""), () => api().open_with(m.path, h.id)]),
                        "-", ["choose another app…", () => api().open_path(m.path, "openwith")]]);
                   }],
                   ["show in explorer", () => api().open_path(m.path, "reveal")], ["copy path", () => copyText(m.path, "path copied")]];
  if (opts.attach) buttons.push(["attach to message", () => { composer.attach(path); closeModal(); }]);
  buttons.push(["close", closeModal, "primary"]);
  addButtons(d, buttons);
}

// Claude's thinking: the last two sentences while it thinks (and once done), all of it when you click
function thoughtBubble(it) {
  const n = el("div", "thought" + (it.streaming ? " live" : ""));
  const text = (it.text || "").trim();
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) || [];
  const tail = sentences.slice(-2).join("").trim();
  const cut = !it.expanded && tail.length < text.length;
  n.innerHTML = `<span class="ttext">${esc(it.expanded || !cut ? text : "… " + tail) || (it.streaming ? "" : "(nothing to show)")}</span>` +
    (cut ? '<span class="more">▸ all of it</span>' : it.expanded ? '<span class="more">▾ less</span>' : "");
  n.dataset.tip = it.expanded ? "Click to show less" : "Claude's thinking · click to read all of it";
  n.onclick = (e) => {
    if (getSelection().toString()) return;   // selecting text to copy, not toggling
    e.stopPropagation(); it.expanded = !it.expanded; renderItem(it);
  };
  return n;
}

// Claude showing you something (its yo-claude tools): the files panel at a folder, a file, a diff, a tab
async function showForClaude(e) {
  const open = (tab) => { $("#app").classList.add("with-panel"); api().set_setting("panel_open", true); panel.tab = tab; };
  if (e.action === "panel") {
    if (e.tab === "close") { $("#app").classList.remove("with-panel"); api().set_setting("panel_open", false); return; }
    open(e.tab); await panel.load(); if (e.tab === "tasks") tasks.poll(); return;
  }
  if (e.action === "folder") {
    open("files");
    panel.openPath(e.rel);
    await panel.load();
    panel.select([e.select], e.select);
    const row = panel.rows.get(e.select);
    if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 2000); }
    return;
  }
  if (e.action === "file") {
    if (e.rel != null && S.active?.cwd) {   // also point at it in the files panel, if it's open
      panel.openPath(panel.parentOf(e.rel));
      if (panel.shown() && panel.tab === "files") { await panel.load(); panel.select([e.rel], e.rel); }
    }
    return viewFile(e.path, S.active?.cwd);
  }
  if (e.action === "diff") { open("changes"); await panel.load(); return showDiff(e.rel); }
}

function showPicture(src, title) {   // a screenshot or picture from a tool result, big
  const d = dialog(title || "Picture");
  d.classList.add("wide");
  const img = el("img", "viewer-media"); img.src = src; d.appendChild(img);
  addButtons(d, [["close", closeModal, "primary"]]);
}

// ---------- rewind: back to before one of your messages (conversation, files or both), optionally copying it first ----------
function showRewind(it) {
  const a = S.active, code = !!a?.cwd;
  const d = dialog("Rewind");
  const short = (it.text || "").length > 240 ? it.text.slice(0, 240) + "…" : it.text || "(no text)";
  d.appendChild(el("div", "", `<p>Go back to just before this message. It and everything after it are taken out.</p>` +
    `<div class="rwq">&gt; ${esc(short)}</div>`));
  const opts = [
    ["both", "Conversation and files", "Undo the conversation from here, and put back the files Claude changed since.", code],
    ["conversation", "Conversation only", "Keep the files as they are now.", true],
    ["files", "Files only", "Keep the conversation; put back the files Claude changed since this message.", code],
  ];
  let mode = code ? "both" : "conversation";
  const box = el("div", "rwopts");
  for (const [v, label, help, ok] of opts) {
    const r = el("label", "rwopt" + (ok ? "" : " disabled"),
      `<input type="radio" name="rwmode" value="${v}" ${v === mode ? "checked" : ""} ${ok ? "" : "disabled"}>` +
      `<span><b>${label}</b><br><span class="dim">${ok ? help : "Chats have no files to rewind."}</span></span>`);
    r.querySelector("input").onchange = () => { mode = v; note(); };
    box.appendChild(r);
  }
  d.appendChild(box);
  const exp = el("label", "rwopt rwexport", `<input type="checkbox"><span><b>First copy this conversation to a new session</b><br>` +
    `<span class="dim">The copy keeps everything, including the part you rewind, so that work can carry on there without being redone. ` +
    `It shows up in the session list as “(rewound part)”.</span></span>`);
  d.appendChild(exp);
  const warn = el("div", "rwnote dim small");
  const note = () => {
    warn.innerHTML = (mode !== "conversation" ? "Files: only changes Claude made with its edit tools are put back. Changes made by commands it ran, or by you, stay. " : "") +
      (exp.querySelector("input").checked && mode !== "conversation" ? '<span class="mid">The copy shares the same files, so rewinding them undoes its changes too.</span> ' : "") +
      (a?.busy ? '<br><span class="del">Claude is working in this session: wait until it finishes (or stop it) to rewind.</span>' : "");
  };
  exp.querySelector("input").onchange = note;
  note();
  d.appendChild(warn);
  addButtons(d, [["cancel", closeModal], ["rewind", async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "rewinding…";
    const r = await api().rewind(it.uuid, mode, exp.querySelector("input").checked);
    if (r?.error) { btn.disabled = false; btn.textContent = "rewind"; toast(r.error, "error"); return; }
    closeModal();
    if (r?.text) { const b = $("#input"); b.value = r.text; autosize(); b.focus(); }   // your message, back in the box
    toast(["Rewound", r?.export ? "a copy is in the session list as “(rewound part)”" : "", r?.text ? "your message is back in the box" : ""].filter(Boolean).join(" · "));
    loadLists().then(renderTree);
  }, "danger"]]);
}

// ---------- composer: text, attached files (chips or @mentions), pasted images ----------
window.composer = {
  files: [], images: [], comments: [], fileList: null, fileListFor: undefined, pick: -1, matches: [],
  attach(path) { if (!this.files.includes(path)) this.files.push(path); this.renderChips(); $("#input").focus(); },
  addComment(quote, text) { this.comments.push({ quote, text: text || "" }); this.renderChips(); $("#input").focus(); },
  renderChips() {
    const c = $("#chips");
    c.innerHTML = "";
    this.files.forEach((p, i) => c.appendChild(this.chip("📎 " + p, () => { this.files.splice(i, 1); this.renderChips(); }, () => viewFile(p))));
    this.images.forEach((u, i) => {
      const x = this.chip("", () => { this.images.splice(i, 1); this.renderChips(); });
      const img = el("img", "chipimg"); img.src = u; x.prepend(img);
      c.appendChild(x);
    });
    this.comments.forEach((m, i) => {   // a reply (↩) or a comment (💬) on something Claude said: click to edit
      const drop = () => { this.comments.splice(i, 1); this.renderChips(); };
      const x = this.chip("", drop, () => commentBox(m.quote, null, m.text, (t) => { m.text = t; this.renderChips(); }, drop));
      x.classList.add("cchip");
      x.dataset.tip = m.quote;
      x.prepend(el("span", "cq", `${m.text ? "💬" : "↩"} “${esc(shortText(m.quote, 40))}”` + (m.text ? ` <span class="ct">${esc(shortText(m.text, 40))}</span>` : "")));
      c.appendChild(x);
    });
    if (this.comments.length > 1) {
      const all = el("button", "chip cclear", "clear all");
      all.dataset.tip = "Take all the replies and comments out of your message";
      all.onclick = () => { this.comments = []; this.renderChips(); };
      c.appendChild(all);
    }
  },
  chip(label, remove, view) {
    const x = el("span", "chip", esc(label) + " <b>×</b>");
    x.querySelector("b").onclick = (e) => { e.stopPropagation(); remove(); };
    if (view) { x.classList.add("link"); x.onclick = view; }
    return x;
  },
  async knownFiles() {
    const cwd = S.active ? S.active.cwd : S.folder;
    if (!cwd) return [];
    if (this.fileListFor !== cwd || !this.fileList) {
      this.fileListFor = cwd;
      this.fileLoad = api().files().then((r) => (this.fileList = Array.isArray(r) ? r : []));
    }
    return this.fileList || this.fileLoad;
  },
  // Load the folder's file list and the slash commands in the background, so @ and / pop up at once.
  preload(fresh = false) {
    if (fresh) this.fileList = null;
    this.knownFiles();
    api().commands().then((c) => { this.serverCommands = Array.isArray(c) ? c : []; });
  },
  commandList() {
    const local = LOCAL_COMMANDS.map(([name, hint, description]) => ({ name, hint, description, local: true }));
    const names = new Set(local.map((c) => c.name));
    return [...local, ...(this.serverCommands || []).filter((c) => !names.has(c.name))];
  },
  async autocomplete() {
    const box = $("#input"), before = box.value.slice(0, box.selectionStart);
    const at = before.match(/@([^\s@]*)$/), slash = before.match(/^\/(\S*)$/);
    if (!at && !slash) return this.closeList();
    const q = (at || slash)[1].toLowerCase();
    const seq = this.seq = (this.seq || 0) + 1;
    if (slash) {
      this.mode = "/";
      const cmds = this.commandList();
      this.matches = cmds.filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1))
        .slice(0, 14).map((c) => ({ value: c.name, html: `<b>/${esc(c.name)}</b>${c.hint ? ` <span class="dim">${esc(c.hint)}</span>` : ""}` +
          `<span class="adesc">${esc(c.description)}</span>`, cmd: c }));
    } else {
      this.mode = "@";
      const files = await this.knownFiles();
      if (seq !== this.seq) return;   // a later keystroke already took over
      this.matches = files.filter((f) => f.toLowerCase().includes(q))
        .sort((a, b) => (base(a).toLowerCase().startsWith(q) ? 0 : 1) - (base(b).toLowerCase().startsWith(q) ? 0 : 1) || a.length - b.length)
        .slice(0, 12).map((f) => ({ value: f, html: esc(f) }));
    }
    if (!this.matches.length) return this.closeList();
    this.pick = 0;
    const list = $("#atlist");
    list.innerHTML = this.matches.map((m, i) => `<div data-i="${i}" class="${i === 0 ? "on" : ""}">${m.html}</div>`).join("") +
      `<div class="ahint">↑↓ choose · Enter/Tab pick · Esc close</div>`;
    list.querySelectorAll("div[data-i]").forEach((d) => d.onmousedown = (e) => { e.preventDefault(); this.choose(+d.dataset.i); });
    list.classList.remove("hidden");
  },
  closeList() { $("#atlist").classList.add("hidden"); this.matches = []; },
  choose(i) {
    const box = $("#input"), m = this.matches[i];
    if (!m) return;
    const rest = box.value.slice(box.selectionStart);
    const before = this.mode === "/" ? "/" + m.value + " "
      : box.value.slice(0, box.selectionStart).replace(/@([^\s@]*)$/, "@" + m.value + " ");
    box.value = before + rest.replace(/^\S*/, "");
    box.selectionStart = box.selectionEnd = before.length;
    this.closeList();
    box.focus();
  },
  key(e) {
    if (!this.matches.length) return false;
    const list = [...$("#atlist").querySelectorAll("div[data-i]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      this.pick = (this.pick + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list.forEach((d, i) => d.classList.toggle("on", i === this.pick));
      list[this.pick]?.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") { this.choose(this.pick); return true; }
    if (e.key === "Escape") { this.closeList(); return true; }
    return false;
  },
  async mentions(text) {
    if (!text.includes("@")) return [];   // listing a big folder's files takes a moment: only when needed
    const known = new Set(await this.knownFiles());
    return [...text.matchAll(/@([^\s]+)/g)].map((m) => m[1]).filter((p) => known.has(p));
  },
  addImage(file) {
    const r = new FileReader();
    r.onload = () => { this.images.push(r.result); this.renderChips(); };
    r.readAsDataURL(file);
  },
};
const LOCAL_COMMANDS = [
  ["new", "", "Start a new session in this folder"],
  ["chat", "", "Start a new chat without a folder"],
  ["model", "<fable|opus|sonnet|haiku|default>", "Switch this session's model"],
  ["effort", "<low|medium|high|xhigh|max|default>", "Switch this session's effort"],
  ["context", "", "What's using this conversation's context window"],
  ["usage", "", "Your plan's 5-hour and weekly limits"],
  ["tasks", "", "Background tasks and subagents"],
  ["files", "", "The folder's files"],
  ["changes", "", "What this session changed"],
  ["git", "", "Branch and commits"],
  ["stop", "", "Stop Claude"],
  ["btw", "<question>", "Ask a side question without adding it to the conversation"],
];
function runLocalCommand(text) {
  const [, name, arg = ""] = text.match(/^\/(\S+)\s*(.*)$/) || [];
  if (!LOCAL_COMMANDS.some(([n]) => n === name)) return false;
  const pick = (sel, wanted, list) => {
    const w = wanted.trim().toLowerCase();
    const hit = list.find(([v, label]) => (w === "default" && !v) || (v && (v.toLowerCase() === w || label.toLowerCase().includes(w))));
    if (!w || !hit) { toast(`Try /${name} ${list.filter(([v]) => v).map(([v, l]) => l.replace(/^effort: /, "").split(" ")[0].toLowerCase()).join(", ")}`, "error"); return; }
    $(sel).value = hit[0]; $(sel).dispatchEvent(new Event("change"));
    toast(`${name}: ${hit[1].replace(/^(model|effort): /, "")}`);
  };
  const tab = (t) => { $("#app").classList.add("with-panel"); panel.tab = t; panel.load(); if (t === "tasks") tasks.poll(); };
  ({
    new: () => api().new_session(S.active ? S.active.cwd : S.folder),
    chat: () => api().new_session(null),
    model: () => pick("#modelSel", arg, MODELS),
    effort: () => pick("#effortSel", arg, EFFORTS),
    context: () => showContext(),
    usage: () => showLimits(),
    tasks: () => tab("tasks"), files: () => tab("files"), changes: () => tab("changes"), git: () => tab("git"),
    stop: () => api().stop(),
    btw: () => btw.ask(arg),
  })[name]();
  return true;
}
// ---------- replies and comments on what Claude said: select text, right-click "Reply to this" or "Comment on this…".
// Each is a chip above the box (the quote, and your comment); when you send, they go first, as "> quote" blocks, each
// followed by its comment, then your message. (Typed sends only: a spoken message goes without them.) ----------
const shortText = (t, n = 60) => { t = (t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
function withComments(text, comments) {
  const blocks = comments.map((c) => c.quote.split("\n").map((l) => "> " + l).join("\n") + (c.text.trim() ? "\n\n" + c.text.trim() : ""));
  return [...blocks, text].filter(Boolean).join("\n\n");
}
function commentBox(quote, at, initial, save, remove) {   // (remove: editing one that's there already)
  document.querySelector(".cbox")?.remove();
  const box = el("div", "cbox");
  const q = el("div", "cboxq"); q.textContent = "“" + shortText(quote, 160) + "”";
  const ta = el("textarea"); ta.rows = 3; ta.value = initial || ""; ta.placeholder = "Your comment on this (Enter adds it · Esc cancels)";
  const ok = el("button", "primary", initial ? "[save]" : "[add comment]"), no = el("button", "", "[cancel]");
  const close = () => box.remove();
  const done = () => { const t = ta.value.trim(); close(); if (t || initial) save(t); };
  ok.onclick = done; no.onclick = close;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const btns = el("div", "btns"); btns.append(ok, no);
  if (remove) { const rm = el("button", "", "[remove]"); rm.dataset.tip = "Take this comment out of your message"; rm.onclick = () => { close(); remove(); }; btns.append(rm); }
  box.append(q, ta, btns);
  document.body.appendChild(box);
  const r = box.getBoundingClientRect(), x = at ? at.x : innerWidth / 2 - r.width / 2, y = at ? at.y + 8 : innerHeight / 2 - r.height / 2;
  box.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, x)) + "px";
  box.style.top = Math.max(8, Math.min(innerHeight - r.height - 8, y)) + "px";
  ta.focus();
}

let sending = false;
async function send() {
  // Take the message and clear the box straight away: a second Enter while @mentions are looked up used to send
  // the text again (without the image, which the first send had already taken).
  if (sending || tidy.dictating) return;   // (what you said sends itself, once it's fixed)
  clearTimeout(tidy.timer);
  const box = $("#input");
  const text = box.value.trim(), chips = composer.files.slice(), images = composer.images.slice();
  const comments = text.startsWith("/") ? [] : composer.comments.slice();   // (a /command goes as it is: they wait)
  if (!text && !chips.length && !images.length && !comments.length) return;
  if (text.startsWith("/") && !chips.length && !images.length && runLocalCommand(text)) {
    box.value = ""; autosize(); composer.closeList();
    return;
  }
  if (/^\/btw(\s|$)/.test(text)) {   // a side question never goes to the conversation, even with files attached
    box.value = ""; autosize(); composer.closeList(); runLocalCommand(text);   // (the chips stay for your next message)
    return;
  }
  sending = true;
  box.value = ""; autosize();
  follow.set("chat", true); follow.stickAll("chat");   // you sent something: follow the reply
  composer.files = []; composer.images = []; if (comments.length) composer.comments = []; composer.renderChips();
  try {
    const files = [...new Set([...chips, ...(await composer.mentions(text))])];
    await api().send(withComments(text, comments), files, images);
  } finally {
    sending = false;
  }
}
$("#input").addEventListener("paste", (e) => {
  for (const it of e.clipboardData?.items || []) if (it.type.startsWith("image/")) { e.preventDefault(); composer.addImage(it.getAsFile()); }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const cwd = (S.active ? S.active.cwd : S.folder) || "";
  for (const f of e.dataTransfer?.files || []) {
    if (f.type.startsWith("image/")) { composer.addImage(f); continue; }
    const full = f.pywebviewFullPath || f.path;
    if (full && cwd && full.toLowerCase().startsWith(cwd.toLowerCase())) composer.attach(full.slice(cwd.length).replace(/^[\\/]/, "").replace(/\\/g, "/"));
    else if (full) alertBox("Only files inside the session's folder can be attached.");
  }
});
function autosize() { const b = $("#input"); b.style.height = "auto"; b.style.height = Math.min(200, b.scrollHeight + 2) + "px"; }
$("#input").addEventListener("keydown", (e) => {
  if (composer.key(e)) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.target.value && $("#input").classList.contains("suggesting")) {
    e.preventDefault();   // take the suggested next message into the box, to edit or send
    const b = e.target; b.value = S.suggest; b.selectionStart = b.selectionEnd = b.value.length;
    setSuggest(""); autosize();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
$("#input").addEventListener("input", () => { autosize(); composer.autocomplete(); });
$("#input").addEventListener("input", () => setSuggest(""));   // typing anything hides the suggestion
$("#input").addEventListener("input", tidySoon);
$("#sendBtn").onclick = send;
$("#talkBtn").onclick = () => api().talk();
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !$("#modal").classList.contains("hidden")) return;
  if (!$("#atlist").classList.contains("hidden")) return composer.closeList();   // close what's open first
  if (!$("#menu").classList.contains("hidden")) return hideMenu();
  if (inbar.active()) api().stop();
});
$("#input").addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== $("#input")) composer.closeList(); }, 150));

// ---------- menus & dialogs ----------
function showMenu(anchor, items) {
  const m = $("#menu");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "-") { m.appendChild(el("hr")); continue; }
    const [label, fn, opts = {}] = it;
    if (label.startsWith("sub:")) { m.appendChild(el("div", "sub", esc(label.slice(4)))); continue; }
    const row = el("div", opts.disabled ? "disabled" : "",
      (opts.checked !== undefined ? `<span class="chk">${opts.checked ? "✓" : ""}</span>` : "") + esc(label) +
      (opts.kbd ? `<span class="kbd">${esc(opts.kbd)}</span>` : ""));
    row.onclick = () => { if (opts.disabled) return; hideMenu(); fn(); };
    m.appendChild(row);
  }
  m.classList.remove("hidden");
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.clientX, bottom: anchor.clientY };
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.min(r.bottom + 2, innerHeight - m.offsetHeight - 8) + "px";
}
function hideMenu() { $("#menu").classList.add("hidden"); }
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#menu")) hideMenu(); });
function dialog(title) {
  const modal = $("#modal");
  closeModal.guard = null;   // set by a dialog with unsaved work (the text editor)
  modal.innerHTML = ""; modal.classList.remove("hidden");
  const d = el("div", "dialog", `<h3>${esc(title)}</h3>`);
  modal.appendChild(d);
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  return d;
}
function closeModal() {
  if (closeModal.guard && !closeModal.guard()) return;
  closeModal.guard = null;
  $("#modal").querySelectorAll("video, audio").forEach((m) => m.pause());
  $("#modal").classList.add("hidden");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) closeModal(); });
function addButtons(d, buttons) {
  const b = el("div", "btns");
  for (const [label, fn, cls] of buttons) { const x = el("button", cls || "", esc(label)); x.onclick = fn; b.appendChild(x); }
  d.appendChild(b);
}
function ask(title, value, done) {
  const d = dialog(title);
  const input = el("input"); input.value = value || ""; d.appendChild(input);
  const ok = () => { const v = input.value.trim(); closeModal(); if (v) done(v); };
  input.onkeydown = (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") closeModal(); };
  addButtons(d, [["cancel", closeModal], ["ok", ok, "primary"]]);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
function confirmBox(text, done) {
  const d = dialog("Are you sure?");
  d.appendChild(el("div", "", esc(text)));
  addButtons(d, [["cancel", closeModal], ["yes", () => { closeModal(); done(); }, "danger"]]);
}
function alertBox(text) { const d = dialog(appName()); d.appendChild(el("div", "", esc(text))); addButtons(d, [["ok", closeModal, "primary"]]); }

// ---------- start ----------
window.addEventListener("pywebviewready", async () => {
  const s = await api().init();
  Object.assign(S, { settings: s.settings, folder: s.folder, workspaces: s.workspaces || [], groups: s.groups,
                     active: s.active, items: s.items || [], display: s.display });
  S.manual = s.settings.tree_manual || {};
  $("#versionTag").textContent = "v" + s.version;
  renderUpdate(s.update);
  renderLimits(s.limits || null);
  if (s.settings.zoom) document.body.style.zoom = s.settings.zoom;
  await loadLists();
  $("#sessionHead").insertBefore(follow.button("chat"), $("#sessionHead .spacer").nextSibling);
  renderToggles(); renderTree(); renderHead(); renderTranscript(); renderState(); planBox.update();
  setTimeout(() => composer.preload(), 1500);
  avatar.wanted = true; avatar.apply(); renderName(); renderAwake();
  $("#awakeBtn").onclick = () => api().set_setting("keep_awake", S.settings?.keep_awake !== true);   // (her face loads when it's turned on: Options > Face in Sidebar)
  if (S.settings.panel_open) $("#app").classList.add("with-panel");
  if (S.settings.side_open === false) $("#app").classList.add("no-side");
  panes.render();
  panel.load();
  MASCOT.draw($("#logo"), "idle", 0, 1);
  showDisplay();
  requestAnimationFrame(animate);
  $("#input").focus();
  api().ui_loaded(`tree: ${S.workspaces.length} folders, ${allSessions().length} sessions; transcript: ${S.items.length} items`);
});
