// Claude's own hands on the window (the ui_state and ui_control tools in sessions.py): read what is showing, and show or hide
// panes, move around the lists, open tabs and sessions. Python asks over the "ui" event with op "ctl" and a token, and gets the
// answer back from api().ui_report(token, text). Never turns PC control on, never changes the permission mode or approves anything.
"use strict";
window.selfctl = (() => {
  const SETTINGS = {   // friendly name -> setting key: the harmless switches Claude may flip
    mic: "listening", voice_replies: "voice_replies", keep_awake: "keep_awake", prediction: "predict_words",
    autocorrect: "fix_text", suggest_next: "suggest_next", learn_from_messages: "predict_learn", say_when_done: "notify_done",
  };
  const on = (k, d = true) => (S.settings[k] === undefined ? d : !!S.settings[k]);
  const clip = (t, n = 80) => String(t || "").replace(/\s+/g, " ").slice(0, n);

  function state() {
    const a = S.active, kids = (g) => S.groups.filter((c) => S.groupParent[c] === g);
    const groupInfo = (g) => ({
      name: g, folder: g in S.groupCwd ? (S.groupCwd[g] || "(chats, no folder)") : undefined,
      open: isOpen("grp:" + g, allSessions().filter((s) => s.group === g)),
      sessions: allSessions().filter((s) => s.group === g).sort((x, y) => (y.modified || 0) - (x.modified || 0)).slice(0, 25)
        .map((s) => ({ id: s.id, title: clip(s.title), busy: S.busy.has(s.id) || undefined, unseen: s.unseen || undefined, active: a && a.id === s.id || undefined })),
      groups: kids(g).map(groupInfo),
    });
    const tabs = docs.tabs().map((t) => ({ name: t.name, path: t.m.path, active: t === docs.current() || undefined }));
    return {
      session: a ? { id: a.id, title: clip(a.title), folder: a.cwd, working: S.busy.has(a.id) } : null,
      panes: { sessions_list: panes.side(), files_panel: panes.files(), chat: docs.chatOn(), editor: docs.docsOn(), terminal: term.shown(), face: S.settings.avatar === true },
      files_panel: { tab: panel.tab, folder: panel.cwd || null, search: panel.q[panel.tab] || "", selected: [...panel.sel].slice(0, 20),
                     changes: (panel.changes?.files || []).slice(0, 40).map((f) => `${f.status} ${f.path}`),
                     tasks: (tasks.list || []).slice(0, 20).map((t) => ({ key: t.key, what: clip(t.description), status: t.status })) },
      editor_tabs: tabs, markdown_view: S.settings.md_mode || "edit",
      session_list: { search: S.filter || "", focused_group: S.settings.group_focus || null, groups: S.groups.filter((g) => !S.groupParent[g]).map(groupInfo) },
      switches: Object.fromEntries(Object.entries(SETTINGS).map(([n, k]) => [n, on(k, k !== "predict_learn" ? true : true)])),
      pc_control: on("pc_control"), zoom: S.settings.zoom || 1,
    };
  }

  const PANES = {
    sessions: { get: () => panes.side(), set: (v) => panes.set(v, panes.files()) },
    sessions_list: { get: () => panes.side(), set: (v) => panes.set(v, panes.files()) },
    files_panel: { get: () => panes.files(), set: (v) => panes.set(panes.side(), v) },
    chat: { get: () => docs.chatOn(), set: (v) => docs.toggleChat !== undefined && v !== docs.chatOn() && (v ? docs.setLayout(true, docs.docsOn()) : docs.toggleChat()) },
    editor: { get: () => docs.docsOn(), set: (v) => v !== docs.docsOn() && docs.toggleDocs() },
    terminal: { get: () => term.shown(), set: (v) => (v ? term.show() : term.hide()) },
    face: { get: () => S.settings.avatar === true, set: (v) => api().set_setting("avatar", v) },
    bug_invaders: { get: () => false, set: (v) => (v ? window.invaders?.show() : window.invaders?.hide()) },
  };

  const findSession = (what) => {
    const w = String(what || "").toLowerCase(), all = allSessions();
    return all.find((s) => s.id === what) || all.find((s) => (s.title || "").toLowerCase() === w) || all.find((s) => (s.title || "").toLowerCase().includes(w));
  };
  const needGroup = (g) => S.groups.find((x) => x === g) || S.groups.find((x) => x.toLowerCase() === String(g).toLowerCase()) || S.groups.find((x) => x.toLowerCase().includes(String(g).toLowerCase()));

  async function run(op, a = {}) {
    const target = a.target ?? "", value = a.value, text = a.text ?? "";
    switch (op) {
      case "show": case "hide": case "toggle": {
        const p = PANES[target];
        if (!p) return `Unknown element "${target}": use ${Object.keys(PANES).join(", ")}.`;
        const want = op === "toggle" ? !p.get() : op === "show";
        if (target === "chat" && !want && !docs.docsOn()) return "Not hidden: the chat is the only thing showing (show the editor first).";
        p.set(want);
        return `${target} is now ${want ? "shown" : "hidden"}.`;
      }
      case "focus_chat": panes.set(false, false); if (docs.docsOn()) docs.setLayout(true, false); if (term.shown()) term.hide(); return "Just the chat is showing.";
      case "reset_layout":
        if (docs.dirty()) return "Not reset: a file in the editor has unsaved changes.";
        setTimeout(() => resetLayoutNow(), 200);
        return "Resetting the layout to the default (the window reloads).";
      case "zoom": {
        const z = String(value || target);
        if (z === "in") zoom(0.1); else if (z === "out") zoom(-0.1); else if (z === "reset") zoom(0); else return "Zoom: in, out or reset.";
        return `Zoom ${z}.`;
      }
      case "panel_tab": {
        const tab = String(value || target);
        if (!["files", "changes", "git", "tasks", "media"].includes(tab)) return "Tab: files, changes, git, tasks or media.";
        $("#app").classList.add("with-panel"); api().set_setting("panel_open", true); panel.tab = tab; await panel.load(); if (tab === "tasks") tasks.poll();
        return `Showing the ${tab} tab.`;
      }
      case "panel_search": {
        $("#app").classList.add("with-panel"); panel.q[panel.tab] = text; panel.render();
        return text ? `Searching the ${panel.tab} tab for "${text}".` : "Search cleared.";
      }
      case "session_search": S.filter = text; $("#search").value = text; renderTree(); return text ? `Session list filtered by "${text}".` : "Session list filter cleared.";
      case "open_session": {
        const s = findSession(target);
        if (!s) return `No session matches "${target}". Use ui_state to see the list.`;
        api().open_session(s.id, s.cwd);
        return `Opening "${clip(s.title)}". (This conversation is no longer the one showing, so further UI tools from here won't act.)`;
      }
      case "new_session": api().new_session(target || null); return target ? `New session in ${target}.` : "New chat.";
      case "expand_group": case "collapse_group": {
        const open = op === "expand_group";
        if (String(target).toLowerCase() === "all") { for (const g of S.groups) setOpen("grp:" + g, open); renderTree(); return `${open ? "Expanded" : "Collapsed"} every group.`; }
        const g = needGroup(target);
        if (!g) return `No group "${target}".`;
        setOpen("grp:" + g, open); renderTree();
        return `${open ? "Expanded" : "Collapsed"} "${g}".`;
      }
      case "focus_group": {
        if (!target) { api().set_setting("group_focus", null); return "Showing every group again."; }
        const g = needGroup(target);
        if (!g) return `No group "${target}".`;
        api().set_setting("group_focus", g);
        return `Showing only "${g}".`;
      }
      case "editor_tab": {
        const t = docs.find(target);
        if (!t) return `No editor tab "${target}". Open it with show_file first.`;
        docs.show(); docs.select(t);
        return `Showing ${t.name}.`;
      }
      case "close_tab": {
        if (String(target).toLowerCase() === "all") { for (const t of [...docs.tabs()]) docs.close(t); return "Closed every editor tab (any with unsaved edits asked first)."; }
        const t = docs.find(target);
        if (!t) return `No editor tab "${target}".`;
        docs.close(t);
        return `Closed ${t.name}${docs.dirty() ? " (it has unsaved edits, so the user is being asked)" : ""}.`;
      }
      case "markdown_view": {
        const m = String(value || target);
        if (!["edit", "split", "preview"].includes(m)) return "Markdown view: edit, split or preview.";
        return docs.setMd(m) ? `Markdown shown as ${m}.` : "The tab showing isn't a Markdown file.";
      }
      case "open_change": {   // a file in the changes list: its diff
        const f = (panel.changes?.files || []).find((x) => x.path === target || x.path.endsWith("/" + target) || x.path.toLowerCase().includes(String(target).toLowerCase()));
        if (!f) return `No changed file matches "${target}".`;
        $("#app").classList.add("with-panel"); api().set_setting("panel_open", true); panel.tab = "changes"; await panel.load(); showDiff(f.path);
        return `Showing the diff of ${f.path}.`;
      }
      case "open_task": {
        const t = (tasks.list || []).find((x) => x.key === target || (x.description || "").toLowerCase().includes(String(target).toLowerCase()));
        if (!t) return `No task matches "${target}".`;
        tasks.show(t.key);
        return `Showing the output of "${clip(t.description)}".`;
      }
      case "select_files": {   // point at files in the files tab
        const rels = String(text || target).split("\n").map((x) => x.trim()).filter(Boolean);
        if (!rels.length) return "Give the path(s) to select.";
        $("#app").classList.add("with-panel"); api().set_setting("panel_open", true); panel.tab = "files";
        panel.openPath(panel.parentOf(rels[0])); await panel.load(); panel.select(rels, rels[0]);
        const row = panel.rows.get(rels[0]); if (row) row.scrollIntoView({ block: "center" });
        return `Selected ${rels.length} item${rels.length === 1 ? "" : "s"} in the files tab.`;
      }
      case "scroll": {
        const el_ = { chat: $("#transcript"), panel: $("#pbody"), sessions: $("#tree") }[target];
        if (!el_) return "Scroll: chat, panel or sessions.";
        const v = String(value);
        if (v === "top") el_.scrollTop = 0; else if (v === "bottom") el_.scrollTop = el_.scrollHeight; else if (v === "up") el_.scrollTop -= el_.clientHeight * 0.8; else if (v === "down") el_.scrollTop += el_.clientHeight * 0.8;
        else return "Scroll value: top, bottom, up or down.";
        return `Scrolled the ${target} ${v}.`;
      }
      case "switch": {
        const k = SETTINGS[target];
        if (!k) return `Switch: ${Object.keys(SETTINGS).join(", ")}. (PC control, permissions and approvals can't be changed from here.)`;
        const want = value === true || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "on";
        api().set_setting(k, want);
        return `${target} is now ${want ? "on" : "off"}.`;
      }
      default: return `Unknown op "${op}".`;
    }
  }

  window.addEventListener("pywebviewready", () => {});
  return { state, run, reply: async (token, op, args) => {
    let out;
    try { out = op === "state" ? JSON.stringify(state(), null, 1) : await run(op, args); } catch (e) { out = "Failed: " + (e?.message || e); }
    api().ui_report(token, out);
  } };
})();
