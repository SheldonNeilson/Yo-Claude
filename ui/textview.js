// Text files in the viewer: Markdown formatted or as source, and editing in place (Ctrl+S saves).
"use strict";
const MD_EXT = /\.(md|markdown|mdx)$/i;

function textView(d, f, path, cwd) {
  const isMd = MD_EXT.test(path);
  let text = f.text, mtime = f.mtime, mode = isMd ? "formatted" : "source", dirty = false;
  let ce = null;   // the code editor component (codeview.js) while viewing source or editing
  const bar = el("div", "tvbar"), body = el("div", "tvbody"), note = el("span", "tvnote dim");
  d.append(bar, body);

  const show = () => {
    body.innerHTML = "";
    if (mode === "formatted") {
      const md_ = el("div", "mdview", md(text));
      body.appendChild(md_);
      if (!f.truncated) wireChecklist(md_);
    } else if (mode === "source") {
      ce = codeEditor({ text, path, readOnly: true });   // (colour, line numbers, column selection; nothing to change)
      body.appendChild(ce.el);
    } else {
      ce = codeEditor({ text, path, readOnly: false, onSave: save, onCancel: cancel,
        onInput: () => { const d2 = ce.value !== text; if (d2 !== dirty) { dirty = d2; renderBar(); } } });
      body.appendChild(ce.el);
      setTimeout(() => ce.focus(), 0);
    }
    if (f.truncated) body.appendChild(el("div", "dim", "(showing the first 300 KB, so it can't be edited here)"));
  };
  // Task lists ("- [ ] item") are tickable in the formatted view: each tick flips that item's [ ]/[x] in the file and
  // saves straight away, so a checklist Claude writes (e.g. a pick list) can be answered by clicking.
  const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/gm;
  const wireChecklist = (view) => {
    const boxes = [...view.querySelectorAll('li > input[type="checkbox"]')];
    if (!boxes.length || boxes.length !== [...text.matchAll(TASK)].length) return;   // can't map boxes to lines safely
    boxes.forEach((cb, n) => {
      cb.disabled = false;
      cb.closest("li").classList.add("tvtask");
      cb.onchange = async () => {
        let i = 0;
        const next = text.replace(TASK, (m, lead, mark) => (i++ === n ? `${lead}[${cb.checked ? "x" : " "}]` : m));
        cb.disabled = true;
        const r = await api().save_text(f.full || path, next, mtime, cwd);
        cb.disabled = false;
        if (r?.error) { cb.checked = !cb.checked; toast(r.error, "error"); return; }
        text = next; mtime = r.mtime;
        note.textContent = "saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      };
    });
  };
  const editor = () => body.querySelector(".ce-ta");
  const save = async () => {
    const ta = editor();
    if (!ta) return;
    if (S.settings.format_on_save) await ce.format(true);   // (Options: format on save)
    note.textContent = "saving…";
    const r = await api().save_text(f.full || path, ta.value, mtime, cwd);
    if (r?.error) { note.textContent = ""; toast(r.error, "error"); return; }
    text = ta.value; mtime = r.mtime; dirty = false;
    note.textContent = "saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    renderBar();
  };
  const cancel = () => {
    if (dirty) return askUnsaved(() => { dirty = false; mode = isMd ? "formatted" : "source"; show(); renderBar(); });
    mode = isMd ? "formatted" : "source"; show(); renderBar();
  };
  // Closing the viewer with unsaved edits asks first (inside the dialog, so it stays retro).
  const askUnsaved = (discard) => {
    if (d.querySelector(".tvask")) return;
    const ask = el("div", "tvask", "<span>You have unsaved changes.</span>");
    const b = (label, fn, cls = "") => { const x = el("button", cls, label); x.onclick = () => { ask.remove(); fn(); }; ask.appendChild(x); };
    b("save", async () => { await save(); if (!dirty) discard(); }, "primary");
    b("discard", discard, "danger");
    b("keep editing", () => editor()?.focus());
    bar.after(ask);
  };
  closeModal.guard = () => {
    if (!dirty || !d.isConnected) return true;
    askUnsaved(() => { dirty = false; closeModal(); });
    return false;
  };

  const renderBar = () => {
    bar.innerHTML = "";
    const seg = (label, m, tip) => {
      const x = el("button", mode === m ? "on" : "", label);
      x.dataset.tip = tip;
      x.onclick = () => { if (mode === "edit" && dirty) return askUnsaved(() => { dirty = false; mode = m; show(); renderBar(); }); mode = m; show(); renderBar(); };
      bar.appendChild(x);
    };
    if (isMd) seg("formatted", "formatted", "Show the Markdown formatted");
    seg(isMd ? "source" : "view", "source", isMd ? "Show the Markdown source" : "Read-only, with highlighting");
    if (f.editable && !f.truncated) seg("✎ edit", "edit", "Edit this file here (Ctrl+S saves, Esc stops editing)");
    else bar.appendChild(el("span", "dim small", f.truncated ? "too big to edit here" : "not UTF-8 text, so it can't be edited here"));
    bar.appendChild(el("span", "spacer"));
    if (mode === "edit") {
      if (dirty) bar.appendChild(el("span", "tvdirty", "● unsaved"));
      bar.appendChild(note);
      const fm = el("button", "", "format");
      fm.dataset.tip = "Tidy the file: indentation, spacing, JSON layout (Shift+Alt+F; Ctrl+Z undoes it)";
      fm.onclick = () => ce.format();
      const fos = el("button", S.settings.format_on_save ? "on" : "", S.settings.format_on_save ? "✓ on save" : "on save");
      fos.dataset.tip = "Format the file every time it's saved";
      fos.onclick = () => { S.settings.format_on_save = !S.settings.format_on_save; api().set_setting("format_on_save", S.settings.format_on_save); renderBar(); };
      bar.append(fm, fos);
      const s = el("button", "primary", "save");
      s.disabled = !dirty; s.dataset.tip = "Ctrl+S";
      s.onclick = save;
      const c = el("button", "", "done");
      c.onclick = cancel;
      bar.append(s, c);
    } else bar.appendChild(note);
  };
  show(); renderBar();
}
