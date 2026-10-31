// The file editor: a text area with colour (highlight.js) behind it, line numbers, column selection (Alt+Shift+drag, or
// Alt+Shift+arrows), AutoCorrect (comments in code, prose in text files), grey auto-complete (Tab takes it), auto-indent
// and a Format button (Shift+Alt+F, formatter.py). The same component shows files read-only in "view": line numbers,
// colour and column selection (to copy) work there too. textview.js uses it.
"use strict";
const CE_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", pyw: "python",
  cs: "csharp", csx: "csharp", html: "xml", htm: "xml", xml: "xml", svg: "xml", xaml: "xml", csproj: "xml", vbproj: "xml", fsproj: "xml",
  props: "xml", targets: "xml", config: "xml", resx: "xml", razor: "xml", css: "css", scss: "scss", less: "less", json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  psm1: "powershell", psd1: "powershell", bat: "dos", cmd: "dos", sql: "sql", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cc: "cpp", cxx: "cpp", go: "go", rs: "rust", php: "php", rb: "ruby", lua: "lua", ini: "ini", toml: "ini", cfg: "ini", conf: "ini",
  diff: "diff", patch: "diff", kt: "kotlin", swift: "swift", vb: "vbnet", pl: "perl", r: "r", dockerfile: "dockerfile", makefile: "makefile",
};
const CE_PROSE = new Set(["md", "markdown", "txt", "text", "rst", "tex", "adoc", ""]);
const ceExt = (path) => { const b = (path || "").split(/[\\/]/).pop().toLowerCase(); return b.includes(".") ? b.split(".").pop() : b; };
function ceLang(path) {
  const e = ceExt(path), l = CE_LANG[e] || e;
  return l && typeof hljs !== "undefined" && hljs.getLanguage(l) ? l : "";
}
const ceEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const CE_TAB = 4;
const ceVis = (line, idx) => { let v = 0; for (let i = 0; i < idx && i < line.length; i++) v += line[i] === "\t" ? CE_TAB - (v % CE_TAB) : 1; return v; };
const ceIdx = (line, vis) => {   // the character boundary nearest a visual column (tabs count as their width)
  let v = 0, i = 0;
  while (i < line.length) { const w = line[i] === "\t" ? CE_TAB - (v % CE_TAB) : 1; if (v + w / 2 > vis) break; v += w; i++; }
  return i;
};

function codeEditor({ text, path, readOnly, onInput, onSave, onCancel }) {
  const lang = ceLang(path), ext = ceExt(path), prose = CE_PROSE.has(ext) && lang !== "css";
  let ro = !!readOnly, B = null, applying = false;   // B: the column selection {a, b} of {line, vis}
  const root = el("div", "ce"), gut = el("div", "ce-gut"), gin = el("pre", "ce-gin"), main = el("div", "ce-main");
  const blk = el("div", "ce-blk"), hl = el("pre", "ce-hl"), ghost = el("pre", "ce-ghost"), ta = el("textarea", "ce-ta");
  const status = el("div", "ce-status dim small");
  ta.value = text; ta.readOnly = ro; ta.spellcheck = false; ta.setAttribute("wrap", "off");
  ta.setAttribute("autocomplete", "off"); ta.setAttribute("autocapitalize", "off");
  gut.appendChild(gin); main.append(blk, hl, ta, ghost); root.append(gut, main);
  const wrap = el("div", "ce-wrap"); wrap.append(root, status);

  // ----- colour, line numbers, scrolling -----
  let hlTimer = 0, lines = 0;
  const paintHL = () => {
    const v = ta.value;
    let html = ceEsc(v);
    if (lang) {
      try { html = hljs.highlight(v, { language: lang, ignoreIllegals: true }).value; }   // (highlight.js 10.7+)
      catch (_) { try { html = hljs.highlight(lang, v).value; } catch (__) { /* plain */ } }   // (older)
    }
    hl.innerHTML = html + "\n";
    const n = v.split("\n").length;
    if (n !== lines) {
      lines = n;
      gin.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
      gut.style.width = (String(n).length + 2) + "ch";
    }
  };
  const paintSoon = () => { clearTimeout(hlTimer); hlTimer = setTimeout(paintHL, ta.value.length > 120000 ? 250 : 40); };
  const sync = () => {
    const t = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    hl.style.transform = ghost.style.transform = blk.style.transform = t;
    gin.style.transform = `translateY(${-ta.scrollTop}px)`;
  };
  ta.addEventListener("scroll", sync);
  const metrics = () => {
    const cs = getComputedStyle(ta), probe = metrics.probe || (metrics.probe = el("span", "ce-probe", "M".repeat(20)));
    if (!probe.isConnected) main.appendChild(probe);
    return { cw: probe.getBoundingClientRect().width / 20 / ((ta.getBoundingClientRect().width / ta.offsetWidth) || 1),
      lh: parseFloat(cs.lineHeight) || 19, padL: parseFloat(cs.paddingLeft) || 8, padT: parseFloat(cs.paddingTop) || 8 };
  };
  const allLines = () => ta.value.split("\n");
  const lineStart = (ls, n) => { let o = 0; for (let i = 0; i < n; i++) o += ls[i].length + 1; return o; };
  const caretPos = () => {
    const v = ta.value, s = ta.selectionStart, ls = v.slice(0, s).split("\n"), line = ls.length - 1;
    return { line, vis: ceVis(ls[line], ls[line].length) };
  };
  const setCaret = (p) => {
    const ls = allLines(), line = Math.max(0, Math.min(ls.length - 1, p.line)), i = ceIdx(ls[line], p.vis), o = lineStart(ls, line) + i;
    ta.setSelectionRange(o, o);
  };
  const paintStatus = () => {
    const p = caretPos(), sel = ta.selectionEnd - ta.selectionStart;
    const nl = ta.value.includes("\r\n") ? "CRLF" : "LF";
    status.textContent = `Ln ${p.line + 1}, Col ${p.vis + 1}${sel ? ` · ${sel} selected` : ""}${B ? ` · column selection ${Math.abs(B.b.line - B.a.line) + 1} lines` : ""}`
      + ` · ${lang || "plain text"} · ${nl}${ro ? " · read-only" : ""} · Alt+Shift+drag selects a column`;
  };

  // ----- column selection -----
  const bounds = () => ({ l1: Math.min(B.a.line, B.b.line), l2: Math.max(B.a.line, B.b.line), v1: Math.min(B.a.vis, B.b.vis), v2: Math.max(B.a.vis, B.b.vis) });
  const paintBlock = () => {
    blk.textContent = "";
    if (!B) return;
    const { l1, l2, v1, v2 } = bounds(), m = metrics();
    for (let l = l1; l <= Math.min(l2, l1 + 3000); l++) {
      const r = el("div", "ce-row");
      r.style.cssText = `top:${m.padT + l * m.lh}px;left:${m.padL + v1 * m.cw}px;width:${Math.max(2, (v2 - v1) * m.cw)}px;height:${m.lh}px`;
      blk.appendChild(r);
    }
  };
  const clearBlock = () => { if (B) { B = null; paintBlock(); paintStatus(); } };
  const posAt = (e) => {
    const r = ta.getBoundingClientRect(), k = (r.width / ta.offsetWidth) || 1, m = metrics(), ls = allLines();
    const x = (e.clientX - r.left) / k - m.padL + ta.scrollLeft, y = (e.clientY - r.top) / k - m.padT + ta.scrollTop;
    return { line: Math.max(0, Math.min(ls.length - 1, Math.floor(y / m.lh))), vis: Math.max(0, Math.round(x / m.cw)) };
  };
  const reveal = (p) => {   // scroll so the block's moving corner is in view
    const m = metrics(), top = p.line * m.lh, left = p.vis * m.cw;
    if (top < ta.scrollTop) ta.scrollTop = top;
    else if (top + m.lh + m.padT * 2 > ta.scrollTop + ta.clientHeight) ta.scrollTop = top + m.lh + m.padT * 2 - ta.clientHeight;
    if (left < ta.scrollLeft) ta.scrollLeft = left;
    else if (left + m.padL * 2 > ta.scrollLeft + ta.clientWidth) ta.scrollLeft = left + m.padL * 2 - ta.clientWidth;
  };
  ta.addEventListener("mousedown", (e) => {
    if (e.altKey && e.shiftKey && e.button === 0) {
      e.preventDefault(); ta.focus();
      const p = posAt(e);
      B = { a: p, b: { ...p } }; paintBlock(); paintStatus();
      const move = (ev) => { B.b = posAt(ev); reveal(B.b); paintBlock(); paintStatus(); };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); setCaret(B.b); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    } else clearBlock();
  });
  // the text with the block's columns replaced: one undo step (the whole text is re-inserted)
  const applyText = (next, after) => {
    const st = ta.scrollTop, sl = ta.scrollLeft;
    applying = true; ta.focus(); ta.select();
    document.execCommand("insertText", false, next);
    applying = false;
    ta.scrollTop = st; ta.scrollLeft = sl;
    return after;
  };
  const blockEdit = (kind, arg) => {
    if (ro || !B) return;
    const ls = allLines(), { l1, l2, v1, v2 } = bounds(), has = v2 > v1;
    const pieces = kind === "paste" ? String(arg).replace(/\r\n/g, "\n").split("\n") : null;
    let col = v1;
    for (let l = l1; l <= l2; l++) {
      let line = ls[l];
      const i1 = ceIdx(line, v1), i2 = has ? ceIdx(line, v2) : i1;
      if (kind === "insert" || kind === "paste") {
        const ins = kind === "insert" ? arg : pieces[(l - l1) % pieces.length];
        const pad = Math.max(0, v1 - ceVis(line, line.length));
        line = line.slice(0, i1) + " ".repeat(pad) + ins + line.slice(i2);
        col = v1 + ceVis(ins, ins.length);
      } else if (kind === "del") line = has ? line.slice(0, i1) + line.slice(i2) : line.slice(0, i1) + line.slice(i1 + 1);
      else if (kind === "back") {
        if (has) line = line.slice(0, i1) + line.slice(i2);
        else if (i1 > 0) { line = line.slice(0, i1 - 1) + line.slice(i1); col = Math.max(0, ceVis(line, i1 - 1)); }
      }
      ls[l] = line;
    }
    if (kind === "del" || (kind === "back" && has)) col = v1;
    applyText(ls.join("\n"));
    B = { a: { line: B.a.line, vis: col }, b: { line: B.b.line, vis: col } };
    setCaret(B.b); paintBlock(); paintStatus(); onInput && onInput(); fixSoon();
  };
  const blockText = () => {
    const ls = allLines(), { l1, l2, v1, v2 } = bounds();
    return ls.slice(l1, l2 + 1).map((line) => line.slice(ceIdx(line, v1), ceIdx(line, v2))).join("\n");
  };
  ta.addEventListener("copy", (e) => { if (B && bounds().v2 > bounds().v1) { e.clipboardData.setData("text/plain", blockText()); e.preventDefault(); } });
  ta.addEventListener("cut", (e) => {
    if (!B || bounds().v2 === bounds().v1) return;
    e.clipboardData.setData("text/plain", blockText()); e.preventDefault();
    if (!ro) blockEdit("del");
  });
  ta.addEventListener("paste", (e) => { if (B && !ro) { e.preventDefault(); blockEdit("paste", e.clipboardData.getData("text/plain")); } });

  // ----- keys -----
  const ARROWS = /^Arrow(Up|Down|Left|Right)$/;
  const indentOf = (line) => line.match(/^[ \t]*/)[0];
  ta.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && !e.ctrlKey && ARROWS.test(e.key)) {   // grow the column selection from the caret
      e.preventDefault();
      if (!B) { const p = caretPos(); B = { a: p, b: { ...p } }; }
      const ls = allLines();
      if (e.key === "ArrowUp") B.b.line = Math.max(0, B.b.line - 1);
      else if (e.key === "ArrowDown") B.b.line = Math.min(ls.length - 1, B.b.line + 1);
      else if (e.key === "ArrowLeft") B.b.vis = Math.max(0, B.b.vis - 1);
      else B.b.vis = Math.min(400, B.b.vis + 1);
      reveal(B.b); paintBlock(); paintStatus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); onSave && onSave(); return; }
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); format(); return; }
    if (e.key === "Escape") {
      if (B) { e.preventDefault(); e.stopPropagation(); clearBlock(); return; }
      if (onCancel) { e.stopPropagation(); e.preventDefault(); onCancel(); }
      return;
    }
    if (B) {   // typing with a column selected goes into every line of it
      if ((e.ctrlKey || e.metaKey) && /^[zya]$/i.test(e.key)) { clearBlock(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (ARROWS.test(e.key) || e.key === "Home" || e.key === "End" || e.key === "PageUp" || e.key === "PageDown") { clearBlock(); return; }
      if (!ro) {
        if (e.key.length === 1) { e.preventDefault(); blockEdit("insert", e.key); return; }
        if (e.key === "Backspace") { e.preventDefault(); blockEdit("back"); return; }
        if (e.key === "Delete") { e.preventDefault(); blockEdit("del"); return; }
        if (e.key === "Tab") { e.preventDefault(); blockEdit("insert", "\t"); return; }
      }
      if (e.key === "Enter") clearBlock();
    }
    if (ro) return;
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (P.shown) return acceptGhost();
      document.execCommand("insertText", false, "\t");   // a tab in the text, not a jump to the next button
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {   // keep the indent
      const v = ta.value, s = ta.selectionStart, ls = v.lastIndexOf("\n", s - 1) + 1, before = v.slice(ls, s);
      if (before.trim() || before.length) {
        e.preventDefault();
        const more = /[{(\[:]\s*$/.test(before.trimEnd()) && !lang.startsWith("mark") ? (before.includes("\t") ? "\t" : "  ".repeat(ext === "py" ? 2 : 1)) : "";
        document.execCommand("insertText", false, "\n" + indentOf(before) + more);
      }
    }
  });
  ta.addEventListener("keyup", () => { paintStatus(); ghostPaint(); });
  ta.addEventListener("click", () => { paintStatus(); ghostPaint(); });
  ta.addEventListener("blur", ghostPaint);
  ta.addEventListener("focus", ghostPaint);

  // ----- grey auto-complete: the rest of the line (code) or the next words (prose); Tab takes it -----
  const P = { add: "", base: "", timer: 0, busy: false, again: false, shown: false };
  function ghostPaint() {
    const v = ta.value, s = ta.selectionStart, e = v.indexOf("\n", s), end = e < 0 ? v.length : e;
    const on = !!P.add && !ro && !B && document.activeElement === ta && ta.selectionStart === ta.selectionEnd
      && !v.slice(s, end).trim() && S.settings.predict_words !== false;
    P.shown = on;
    if (!on) { ghost.textContent = ""; return; }
    const tail = el("span", "g"); tail.textContent = P.add;
    ghost.textContent = v.slice(0, s); ghost.appendChild(tail);
  }
  const before = () => ta.value.slice(0, ta.selectionStart);
  function predictInput() {
    const b = before();
    if (P.add && b.length > P.base.length && b.startsWith(P.base)) {
      const typed = b.slice(P.base.length);
      if (P.add.startsWith(typed)) { P.add = P.add.slice(typed.length); P.base = b; ghostPaint(); if (!P.add) predictSoon(); return; }
    }
    P.add = ""; ghostPaint(); predictSoon();
  }
  function predictSoon() {
    clearTimeout(P.timer);
    if (ro || S.settings.predict_words === false) return;
    P.timer = setTimeout(predictNow, 350);
  }
  async function predictNow() {
    const b = before(), v = ta.value, s = ta.selectionStart, e = v.indexOf("\n", s), end = e < 0 ? v.length : e;
    const lineText = b.slice(b.lastIndexOf("\n") + 1);
    if (ro || B || S.settings.predict_words === false || lineText.trim().length < 2 || v.slice(s, end).trim()
        || document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) return;
    if (P.busy) { P.again = true; return; }
    P.busy = true;
    let add = "";
    try {
      const sent = prose ? b.slice(-600) : b;
      add = (await Promise.race([api().predict_text(sent, prose ? "prose" : "code", path.split(/[\\/]/).pop()), new Promise((r) => setTimeout(r, 12000, null))]))?.text || "";
    } catch (_) { /* none */ } finally { P.busy = false; }
    const now = before();
    if (now !== b) {   // you typed on meanwhile: still good if it's what was guessed
      add = add && now.startsWith(b) && add.startsWith(now.slice(b.length)) ? add.slice(now.length - b.length) : "";
    }
    P.base = now; P.add = add; ghostPaint();
    if (P.again || (now !== b && !add)) { P.again = false; predictSoon(); }
  }
  function acceptGhost() { document.execCommand("insertText", false, P.add); }

  // ----- AutoCorrect: comments in code, paragraphs in text files; never the line you're on (words a few behind the cursor
  // are fixed too in prose) -----
  const seen = new Set(), LAG = 2;
  let fixTimer = 0, fixBusy = false;
  const COMMENT = /^(\s*(?:\/\/+|#+|--|;+|\*(?!\/)|\/\*+|<!--))[ \t]?(.+?)[ \t]*(?:\*\/|-->)?[ \t]*$/;
  const DIRECTIVE = /^(region|endregion|noqa|eslint|pragma|type:|@|!|-\*-|prettier|istanbul|jshint|tslint|nolint|lint|fmt:|yapf|pylint|mypy|ts-|c8)/i;
  const looksLikeCode = (t) => /[;{}=<>\[\]\\|]|\w\(|\)\s*$/.test(t);
  function fixZone() {
    const v = ta.value, caret = ta.selectionStart;
    if (prose) {
      for (const m of v.matchAll(/[^\n]+(?:\n[^\n]+)*/g)) {
        const from = m.index, para = m[0], to = from + para.length;
        if (para.split(/\s+/).length < 3 || /^\s*(```|~~~|\t|    |\||#!)/.test(para) || /[{};<>]|\|.*\|/.test(para)) continue;
        if ((v.slice(0, from).match(/^\s*(```|~~~)/gm) || []).length % 2) continue;   // inside a code fence
        if (caret >= from && caret <= to + 1) {   // the paragraph you're in: only words a few behind the cursor
          const words = [...para.matchAll(/\S+/g)].map((w) => [w.index, w.index + w[0].length]);
          const c = words.filter((w) => from + w[0] < caret).length, heads = c - 1 - LAG;
          if (heads >= 3) { const text = para.slice(0, words[heads - 1][1]); if (!seen.has(text)) return { from, to: from + text.length, text, head: true }; }
          continue;
        }
        if (!seen.has(para)) return { from, to, text: para };
      }
      return null;
    }
    const ls = v.split("\n"), cl = v.slice(0, caret).split("\n").length - 1;
    let o = 0;
    for (let i = 0; i < ls.length; i++, o += ls[i - 1].length + 1) {
      const m = i !== cl && COMMENT.exec(ls[i]);
      if (!m) continue;
      const t = m[2];
      if (t.split(/\s+/).length < 3 || DIRECTIVE.test(t) || looksLikeCode(t) || (t.match(/[A-Za-z' ,.]/g) || []).length < t.length * 0.85) continue;
      const from = o + m[1].length + (ls[i][m[1].length] === " " || ls[i][m[1].length] === "\t" ? 1 : 0);
      if (!seen.has(t)) return { from, to: from + t.length, text: t, head: true };
    }
    return null;
  }
  const fixSoon = () => {
    clearTimeout(fixTimer);
    if (ro || S.settings.fix_text === false) return;
    fixTimer = setTimeout(fixNow, 700);
  };
  async function fixNow() {
    if (fixBusy || ro || B || !root.isConnected) return;
    const z = fixZone();
    if (!z) return;
    fixBusy = true;
    let fixed = z.text;
    try { fixed = (await api().fix_text(z.text))?.text || z.text; } catch (_) { /* left as typed */ } finally { fixBusy = false; }
    if (ta.value.slice(z.from, z.to) !== z.text || B) return fixSoon();   // you changed that part meanwhile (or are in a column selection)
    seen.add(z.text);
    fixed = z.text.match(/^\s*/)[0] + fixed.trim() + z.text.match(/\s*$/)[0];
    if (z.head && !/[.!?…]\s*$/.test(z.text)) fixed = fixed.replace(/[.!?…]+(\s*)$/, "$1");   // (a comment or part of a sentence isn't finished)
    if (fixed.split("\n").length !== z.text.split("\n").length) fixed = z.text;   // (never rewrap)
    seen.add(fixed);
    if (fixed === z.text) return fixSoon();
    const c0 = ta.selectionStart, c1 = ta.selectionEnd, d = fixed.length - z.text.length, st = ta.scrollTop;
    ta.focus(); ta.setSelectionRange(z.from, z.to);
    document.execCommand("insertText", false, fixed);   // one edit: Ctrl+Z puts back what was there
    const at = (p) => (p >= z.to ? p + d : p);
    ta.setSelectionRange(at(c0), at(c1)); ta.scrollTop = st;
    ta.classList.add("tidied"); setTimeout(() => ta.classList.remove("tidied"), 900);
    fixSoon();
  }

  // ----- Format -----
  async function format(quiet) {
    if (ro) return false;
    const r = await api().format_text(path, ta.value);
    if (!r || r.error) { if (!quiet) toast(r?.error || "Couldn't format that.", "error"); return false; }
    if (r.text === ta.value) { if (!quiet) toast("already tidy"); return true; }
    const p = caretPos(), st = ta.scrollTop;
    clearBlock(); applying = true; ta.focus(); ta.select();
    document.execCommand("insertText", false, r.text);
    applying = false;
    setCaret(p); ta.scrollTop = st;
    paintHL(); if (onInput) onInput();
    if (!quiet) toast("formatted (Ctrl+Z undoes it)");
    return true;
  }

  ta.addEventListener("input", () => {
    if (!applying && B) clearBlock();
    paintSoon(); paintStatus();
    if (onInput) onInput();
    if (!applying) { predictInput(); fixSoon(); }
  });
  paintHL(); sync(); paintStatus();
  return {
    el: wrap, ta, format,
    get value() { return ta.value; },
    focus() { ta.focus(); },
  };
}
