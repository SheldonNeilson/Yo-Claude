// The file pane: the middle of the window is shared by the chat and this pane (side by side with a draggable divider, or
// either one filling the middle). One viewer for everything: text files open straight in the editor (colour, line numbers,
// AutoCorrect, column selection, Format; Ctrl+S saves), Markdown also gets edit / split / preview, and pictures, video,
// audio and PDFs show in the same tabs. Files Claude changes on disk reload by themselves unless you have unsaved edits.
"use strict";
const docs = (() => {
  const mid = $("#middle"), pane = $("#docs"), tabsEl = $("#docsTabs"), barEl = $("#docsBar"), bodyEl = $("#docsBody"), pathEl = $("#docsPath");
  const tabs = [];
  let cur = null;
  const st = { chat: true, docs: false, w: 0, mdMode: "edit" };
  const norm = (p) => String(p || "").replace(/\//g, "\\").toLowerCase();
  const stamp = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const isDirty = (t) => !!t.ce && !t.ce.readOnly && t.ce.value !== t.text;

  // ---------- layout: chat | divider | files ----------
  function minChat() { return 320; }
  function setWidth(w) {
    const room = mid.clientWidth - minChat() - 7;
    st.w = Math.round(Math.max(280, Math.min(w, room)));
    mid.style.setProperty("--docs-w", st.w + "px");
  }
  function render() {
    mid.classList.toggle("no-docs", !st.docs);
    mid.classList.toggle("no-chat", !st.chat);
    $("#chatBtn")?.classList.toggle("on", st.chat);
    $("#editorBtn")?.classList.toggle("on", st.docs);
    if (st.docs && st.chat) setWidth(st.w || Math.round(mid.clientWidth / 2));
    setTimeout(() => { if (typeof term !== "undefined" && term.shown()) window.dispatchEvent(new Event("resize")); }, 0);
  }
  function setLayout(chat, files, save = true) {
    if (!chat && !files) chat = true;   // never an empty middle
    st.chat = chat; st.docs = files;
    render();
    if (save) { api().set_setting("chat_open", chat); api().set_setting("docs_open", files); }
  }
  const toggleDocs = () => setLayout(st.chat || !st.docs, !st.docs);
  const toggleChat = () => setLayout(!st.chat, st.docs || st.chat);
  function show() { if (!st.docs) setLayout(st.chat, true); }

  const grip = $("#docsGrip");
  grip.onpointerdown = (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = pane.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    grip.onpointermove = (ev) => setWidth(w0 - (ev.clientX - x0));
    grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; document.body.classList.remove("resizing"); api().set_setting("docs_width", st.w); };
  };
  grip.ondblclick = () => { setWidth(Math.round(mid.clientWidth / 2)); api().set_setting("docs_width", null); };
  window.addEventListener("resize", () => { if (st.docs && st.chat) setWidth(st.w); });
  $("#chatBtn").onclick = toggleChat;
  $("#editorBtn").onclick = toggleDocs;

  // ---------- tabs ----------
  function paintTabs() {
    tabsEl.innerHTML = "";
    for (const t of tabs) {
      const b = el("span", "doc-tab" + (t === cur ? " on" : ""));
      const name = el("button", "doc-name", esc(t.name) + (isDirty(t) ? ' <span class="doc-dot">●</span>' : ""));
      name.title = t.m.path;
      name.onclick = () => select(t);
      const x = el("button", "doc-x", "✕");
      x.title = "Close (Ctrl+W)";
      x.onclick = (e) => { e.stopPropagation(); close(t); };
      b.append(name, x);
      b.oncontextmenu = (e) => {
        e.preventDefault(); e.stopPropagation();
        showMenu(e, [["close", () => close(t)], ["show in the files tab", () => revealInFiles(t.m.path)], ["close the others", () => tabs.filter((o) => o !== t).forEach((o) => close(o))],
          ["close all", () => tabs.slice().forEach((o) => close(o))], "-", ["copy path", () => copyText(t.m.path, "path copied")]]);
      };
      tabsEl.appendChild(b);
    }
  }

  function select(t) {
    cur = t;
    for (const o of tabs) o.view.classList.toggle("hidden", o !== t);
    $("#docsEmpty").classList.toggle("hidden", !!tabs.length);
    paintTabs(); paintBar();
    if (t?.ce && st.docs) setTimeout(() => t.focusEditor?.(), 0);
  }

  function close(t, force = false) {
    if (!force && isDirty(t)) return askUnsaved(t, () => close(t, true));
    tabs.splice(tabs.indexOf(t), 1);
    t.view.remove();
    if (cur === t) cur = null;
    if (tabs.length) select(cur || tabs[tabs.length - 1]);
    else { paintTabs(); paintBar(); $("#docsEmpty").classList.remove("hidden"); if (st.docs) setLayout(true, false); }
  }

  // unsaved edits: ask inside the pane (save / discard / keep editing)
  function askUnsaved(t, then) {
    select(t);
    if (t.view.querySelector(".tvask")) return;
    const ask = el("div", "tvask", `<span>${esc(t.name)} has unsaved changes.</span>`);
    const b = (label, fn, cls = "") => { const x = el("button", cls, label); x.onclick = () => { ask.remove(); fn(); }; ask.appendChild(x); };
    b("save", async () => { await t.save(); if (!isDirty(t)) then(); }, "primary");
    b("discard", () => { t.ce.setValue(t.text); paintTabs(); then(); }, "danger");
    b("keep editing", () => t.focusEditor?.());
    t.view.prepend(ask);
  }

  // ---------- the toolbar under the tabs ----------
  function paintBar() {
    barEl.innerHTML = "";
    const t = cur;
    pathEl.classList.toggle("hidden", !t);
    if (!t) return;
    pathEl.textContent = t.m.path;   // (shown from its left end cut off, so the file name is always visible)
    pathEl.title = "Where this file lives: click to show it in the files tab";
    pathEl.onclick = () => revealInFiles(t.m.path);
    if (t.mdSeg) {
      for (const [m, label, tip] of [["edit", "edit", "Edit the Markdown source"], ["split", "split", "Source and the formatted result side by side"], ["preview", "preview", "The formatted result"]]) {
        const x = el("button", t.mdMode === m ? "on" : "", label);
        x.dataset.tip = tip;
        x.onclick = () => { t.setMd(m); st.mdMode = m; api().set_setting("md_mode", m); paintBar(); };
        barEl.appendChild(x);
      }
    }
    barEl.appendChild(el("span", "spacer"));
    if (t.ce && !t.ce.readOnly) {
      if (isDirty(t)) barEl.appendChild(el("span", "tvdirty", "● unsaved"));
      barEl.appendChild(Object.assign(el("span", "tvnote dim"), { textContent: t.note || "" }));
      const fm = el("button", "", "format");
      fm.dataset.tip = "Tidy the file: indentation, spacing, JSON layout (Shift+Alt+F; Ctrl+Z undoes it)";
      fm.onclick = () => t.ce.format();
      const fos = el("button", S.settings.format_on_save ? "on" : "", S.settings.format_on_save ? "✓ on save" : "on save");
      fos.dataset.tip = "Format the file every time it's saved";
      fos.onclick = () => { S.settings.format_on_save = !S.settings.format_on_save; api().set_setting("format_on_save", S.settings.format_on_save); paintBar(); };
      const sv = el("button", "primary", "save");
      sv.disabled = !isDirty(t); sv.dataset.tip = "Ctrl+S";
      sv.onclick = () => t.save();
      barEl.append(fm, fos, sv);
    } else if (t.ce) {
      barEl.appendChild(el("span", "dim small", t.readOnlyWhy || "read-only"));
    }
    const more = el("button", "", "⋯");
    more.title = "Pop out, open with…, show in Explorer, attach, terminal";
    more.onclick = (e) => {
      const r = more.getBoundingClientRect();
      showFileMenu({ clientX: r.right - 180, clientY: r.bottom, preventDefault() {}, stopPropagation() {} }, t.m.path, null, [
        ["attach to message", () => composer.attach(t.m.path)], ["pop out ⤢", () => api().pop_out(t.m.path)], "-"]);
    };
    barEl.appendChild(more);
  }

  // ---------- one file ----------
  function task(t) {   // a tab object, and the view it fills in
    const view = el("div", "doc-view hidden");
    bodyEl.appendChild(view);
    return view;
  }

  async function buildMedia(t, view) {
    const m = t.m;
    if (m.kind === "image") { const img = el("img", "doc-media"); img.src = m.url; view.appendChild(img); }
    else if (m.kind === "video") view.appendChild(retroPlayer(m, { autoplay: true, big: true, cwd: t.cwd }));
    else if (m.kind === "audio") { const a = el("audio"); a.src = m.url; a.controls = true; a.style.width = "100%"; view.appendChild(a); }
    else if (m.kind === "pdf") { const f = el("iframe", "doc-pdf"); f.src = m.url; view.appendChild(f); }
    view.classList.add("doc-media-box");
  }

  async function buildText(t, view) {
    const f = await api().read_any(t.m.path, null);
    if (f.error) { view.appendChild(el("div", "pempty", esc(f.error))); return; }
    if (f.binary) { view.appendChild(el("div", "pempty dim", `binary file, ${f.size} bytes: use ⋯ → open with…`)); return; }
    const isMd = MD_EXT.test(t.m.path), canEdit = !!f.editable && !f.truncated;
    t.text = f.text; t.mtime = f.mtime;
    t.readOnlyWhy = f.truncated ? "too big to edit here (first 300 KB shown)" : "not UTF-8 text, so it can't be edited here";
    const wrap = el("div", "doc-split");
    const prev = isMd ? el("div", "mdview doc-preview") : null;
    const ce = codeEditor({
      text: f.text, path: t.m.path, readOnly: !canEdit, onSave: () => t.save(), onCancel: () => {},   // (Esc never drops your edits)
      onInput: () => { paintTabs(); paintBar(); if (prev && t.mdMode !== "edit") renderPreviewSoon(); },
    });
    ce.readOnly = !canEdit;
    t.ce = ce;
    wrap.appendChild(ce.el);
    if (prev) wrap.appendChild(prev);
    view.appendChild(wrap);

    let pt = 0;
    const renderPreview = () => {
      prev.innerHTML = md(ce.value);
      if (!f.truncated) wireChecklist(prev);
    };
    const renderPreviewSoon = () => { clearTimeout(pt); pt = setTimeout(renderPreview, 150); };
    // Task lists ("- [ ] item") tick in the preview: the file is saved straight away (only while it has no unsaved edits)
    const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/gm;
    const wireChecklist = (vw) => {
      const boxes = [...vw.querySelectorAll('li > input[type="checkbox"]')];
      if (!boxes.length || boxes.length !== [...ce.value.matchAll(TASK)].length) return;
      boxes.forEach((cb, n) => {
        cb.disabled = !canEdit || isDirty(t);
        cb.closest("li").classList.add("tvtask");
        cb.onchange = async () => {
          let i = 0;
          const next = t.text.replace(TASK, (m, lead) => (i++ === n ? `${lead}[${cb.checked ? "x" : " "}]` : m));
          cb.disabled = true;
          const r = await api().save_text(t.m.path, next, t.mtime, null);
          if (r?.error) { cb.checked = !cb.checked; cb.disabled = false; toast(r.error, "error"); return; }
          t.text = next; t.mtime = r.mtime; ce.setValue(next); t.note = "saved " + stamp(); paintBar(); renderPreview();
        };
      });
    };
    if (isMd) {
      t.mdSeg = true;
      t.setMd = (m) => {
        t.mdMode = m;
        wrap.classList.remove("mode-edit", "mode-split", "mode-preview");
        wrap.classList.add("mode-" + m);
        if (m !== "edit") renderPreview();
        if (m === "preview") ce.el.classList.add("hidden"); else ce.el.classList.remove("hidden");
        if (m !== "preview") setTimeout(() => ce.focus(), 0);
      };
      t.setMd(st.mdMode);
    }
    t.focusEditor = () => { if (!ce.el.classList.contains("hidden")) ce.focus(); };
    t.save = async () => {
      if (!canEdit) return;
      if (S.settings.format_on_save) await ce.format(true);
      t.note = "saving…"; paintBar();
      const r = await api().save_text(t.m.path, ce.value, t.mtime, null);
      if (r?.error) { t.note = ""; paintBar(); toast(r.error, "error"); return; }
      t.text = ce.value; t.mtime = r.mtime; t.note = "saved " + stamp();
      paintTabs(); paintBar();
      if (prev && t.mdMode !== "edit") renderPreview();
    };
    // the file changed on disk (Claude, another program): reload it, or say so if you have unsaved edits
    t.disk = async () => {
      const mt = await api().file_mtime(t.m.path);
      if (!mt || Math.abs(mt - t.mtime) < 0.001 || t.askedDisk === mt) return;
      if (!isDirty(t)) {
        const g = await api().read_any(t.m.path, null);
        if (g.error || g.binary) return;
        t.text = g.text; t.mtime = g.mtime; ce.setValue(g.text); t.note = "reloaded " + stamp();
        if (prev && t.mdMode !== "edit") renderPreview();
        paintTabs(); paintBar();
        return;
      }
      t.askedDisk = mt;
      if (view.querySelector(".tvask")) return;
      const ask = el("div", "tvask", `<span>${esc(t.name)} changed on disk, and you have unsaved edits.</span>`);
      const b = (label, fn, cls = "") => { const x = el("button", cls, label); x.onclick = () => { ask.remove(); fn(); }; ask.appendChild(x); };
      b("load theirs", async () => { const g = await api().read_any(t.m.path, null); if (!g.error) { t.text = g.text; t.mtime = g.mtime; ce.setValue(g.text); t.askedDisk = 0; paintTabs(); paintBar(); } }, "danger");
      b("keep mine", () => {});
      view.prepend(ask);
    };
    if (isMd) renderPreview();
  }

  async function open(path, cwd) {
    const m = await api().media(path, cwd);
    if (!m || m.error) return alertBox(m?.error || "Couldn't open that.");
    const key = norm(m.path);
    let t = tabs.find((o) => o.key === key);
    if (!t) {
      t = { key, m, name: m.name, cwd, mdMode: st.mdMode };
      const view = task(t);
      t.view = view;
      tabs.push(t);
      try { await (["image", "video", "audio", "pdf"].includes(m.kind) ? buildMedia(t, view) : buildText(t, view)); }
      catch (e) { console.error(e); view.appendChild(el("div", "pempty", "Couldn't show that file.")); }
    }
    show();
    select(t);
  }

  // ---------- keys, polling, guards ----------
  pane.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "`") return;   // the terminal's toggle still works from here
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && cur) { e.preventDefault(); e.stopPropagation(); return close(cur); }
    e.stopPropagation();   // Ctrl+L, Ctrl+B, Esc... are for the editor while you're in it, not the app
  });
  const poll = () => { if (st.docs && !document.hidden && cur?.disk) cur.disk().catch(() => {}); };
  setInterval(poll, 2500);
  window.addEventListener("focus", poll);
  window.addEventListener("beforeunload", (e) => { if (tabs.some(isDirty)) { e.preventDefault(); e.returnValue = ""; } });

  // saved layout (settings arrive with init)
  window.addEventListener("pywebviewready", async () => {
    for (let i = 0; i < 50 && !Object.keys(S.settings || {}).length; i++) await new Promise((r) => setTimeout(r, 100));
    const s = S.settings || {};
    if (s.docs_width) st.w = s.docs_width;
    if (s.md_mode) st.mdMode = s.md_mode;
    st.chat = s.chat_open !== false; st.docs = !!s.docs_open;
    if (!st.chat && !st.docs) st.chat = true;
    render();
  });
  render();

  return { open, show, toggleDocs, toggleChat, setLayout, chatOn: () => st.chat, docsOn: () => st.docs, tabs: () => tabs, dirty: () => tabs.some(isDirty) };
})();
