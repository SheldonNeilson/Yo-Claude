// Text files in the viewer: Markdown formatted or as source, and editing in place (Ctrl+S saves).
"use strict";
const MD_EXT = /\.(md|markdown|mdx)$/i;

function textView(d, f, path, cwd) {
  const isMd = MD_EXT.test(path);
  let text = f.text, mtime = f.mtime, mode = isMd ? "formatted" : "source", dirty = false;
  const bar = el("div", "tvbar"), body = el("div", "tvbody"), note = el("span", "tvnote dim");
  d.append(bar, body);

  const show = () => {
    body.innerHTML = "";
    if (mode === "formatted") {
      const md_ = el("div", "mdview", md(text));
      body.appendChild(md_);
    } else if (mode === "source") {
      const pre = el("pre", "viewer"), code = el("code");
      code.textContent = text; pre.appendChild(code);
      const ext = path.split(".").pop();
      if (hljs.getLanguage(ext)) code.className = "language-" + ext;
      try { hljs.highlightElement(code); } catch (_) {}
      body.appendChild(pre);
    } else {
      const ta = el("textarea", "tveditor");
      ta.value = text; ta.spellcheck = isMd;
      ta.oninput = () => { dirty = ta.value !== text; renderBar(); };
      ta.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
        if (e.key === "Tab" && !e.shiftKey) {   // a tab in the text, not a jump to the next button
          e.preventDefault(); ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end"); ta.oninput();
        }
        if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); cancel(); }
      };
      body.appendChild(ta);
      setTimeout(() => ta.focus(), 0);
    }
    if (f.truncated) body.appendChild(el("div", "dim", "(showing the first 300 KB, so it can't be edited here)"));
  };
  const editor = () => body.querySelector(".tveditor");
  const save = async () => {
    const ta = editor();
    if (!ta) return;
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
