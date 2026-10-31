"""The file editor's Format button (Shift+Alt+F): tidies a file without needing any tool installed.

JSON is re-printed; brace languages (JavaScript, TypeScript, CSS, C#, Java, C/C++, Go, Rust, PHP...) are re-indented by
bracket depth, keeping strings, comments and template literals as they are; XML-like files (HTML, XML, project files)
are re-indented by tag depth; everything gets trailing spaces trimmed, runs of blank lines shortened and one newline at
the end. A real formatter is used instead when one is installed (black, ruff or prettier, found on PATH or in the file's
project) and succeeds. format_text() returns the new text, or raises ValueError with a message for the window."""
import json
import os
import re
import shutil
import subprocess

BRACE = {"js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "less", "cs", "java", "c", "h", "cpp", "hpp", "cc", "cxx",
         "go", "rs", "php", "swift", "kt", "kts", "dart", "scala", "groovy", "gradle"}
XMLISH = {"html", "htm", "xml", "svg", "xaml", "csproj", "vbproj", "fsproj", "props", "targets", "config", "resx", "razor"}
TWO = {"js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "less", "json", "html", "htm", "xml", "svg", "xaml", "dart", "yml", "yaml"}
LINE_COMMENT = {"c": ("//",), "default": ("//",), "css": (), "php": ("//", "#")}


def _ext(path):
    base = os.path.basename(path or "").lower()
    return base.rsplit(".", 1)[-1] if "." in base else ""


def _generic(text):
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").split("\n")]
    out, blanks = [], 0
    for ln in lines:
        if ln:
            blanks = 0
        else:
            blanks += 1
            if blanks > 2:
                continue
        out.append(ln)
    while out and not out[-1]:
        out.pop()
    return nl.join(out) + nl if out else ""


def _unit(ext, lines):
    """The file's own indent step (the commonest increase between lines), else a default for the language."""
    steps, prev = {}, 0
    for ln in lines:
        if not ln.strip():
            continue
        ind = len(ln) - len(ln.lstrip(" "))
        if ln.startswith("\t"):
            return "\t"
        if ind > prev and 0 < ind - prev <= 8:
            steps[ind - prev] = steps.get(ind - prev, 0) + 1
        prev = ind
    if steps:
        best = max(steps, key=steps.get)
        if best in (2, 4, 8) and steps[best] >= 0.6 * sum(steps.values()):   # (a messy file doesn't set the style)
            return " " * best
    return "\t" if ext == "go" else " " * (2 if ext in TWO else 4)


def _scan(line, state):
    """Walk one line: brackets that open/close outside strings and comments. state carries multi-line comment / template
    literal / raw string across lines. Returns (opens, closes, leading_closers, kept_verbatim)."""
    opens = closes = lead = 0
    i, n, seen = 0, len(line), False
    verbatim = state["in"] is not None
    while i < n:
        c = line[i]
        mode = state["in"]
        if mode == "block":
            j = line.find("*/", i)
            if j < 0:
                return opens, closes, lead, True
            state["in"], i = None, j + 2
            continue
        if mode in ("`", '"""', "'''"):
            j = line.find(mode, i)
            if j < 0:
                return opens, closes, lead, True
            state["in"], i = None, j + len(mode)
            continue
        if c == "/" and line.startswith("//", i):
            break
        if c == "#" and state.get("hash"):
            break
        if c == "/" and line.startswith("/*", i):
            state["in"], i = "block", i + 2
            seen = True
            continue
        if c in "\"'":
            if line.startswith(c * 3, i) and state.get("triple"):
                state["in"], i = c * 3, i + 3
                continue
            j = i + 1
            while j < n and line[j] != c:
                j += 2 if line[j] == "\\" else 1
            i, seen = j + 1, True
            continue
        if c == "`":
            state["in"], i = "`", i + 1
            seen = True
            continue
        if c in "{[(":
            opens += 1
        elif c in "}])":
            closes += 1
            if not seen:
                lead += 1
        if not c.isspace():
            seen = True
        i += 1
    return opens, closes, lead, verbatim


def _reindent(text, ext, path):
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    unit = _unit(ext, lines)
    state = {"in": None, "hash": ext in ("py",), "triple": ext in ("py",)}
    out, depth = [], 0
    for ln in lines:
        stripped = ln.strip()
        was_in = state["in"]
        opens, closes, lead, verbatim = _scan(stripped, state)
        if was_in is not None:   # inside a block comment or a template/raw string: keep as written (comment stars line up)
            if was_in == "block" and stripped.startswith("*"):
                out.append(unit * depth + " " + stripped)
            else:
                out.append(ln.rstrip())
        elif not stripped:
            out.append("")
        else:
            out.append(unit * max(0, depth - lead) + stripped)
        depth = max(0, depth + opens - closes)
    return nl.join(out)


def _xmlish(text):
    nl = "\r\n" if "\r\n" in text else "\n"
    unit = "  "
    out, depth, in_pre = [], 0, False
    tag = re.compile(r"<(/?)([A-Za-z_][\w:.-]*)[^<>]*?(/?)>|<!--.*?-->|<\?.*?\?>|<![^>]*>", re.S)
    for ln in text.replace("\r\n", "\n").split("\n"):
        s = ln.strip()
        if not s:
            out.append("")
            continue
        if re.search(r"<(pre|script|style|textarea)\b", s, re.I) and not re.search(r"</(pre|script|style|textarea)>", s, re.I):
            in_pre = True
        if in_pre:
            out.append(ln.rstrip())
            if re.search(r"</(pre|script|style|textarea)>", s, re.I):
                in_pre = False
            continue
        delta, lead = 0, 0
        for k, m in enumerate(tag.finditer(s)):
            if not m.group(2):
                continue
            name = m.group(2).lower()
            if name in ("br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "wbr"):
                continue
            if m.group(1):
                delta -= 1
                if m.start() == 0:
                    lead = 1
            elif not m.group(3):
                delta += 1
        out.append(unit * max(0, depth - lead) + s)
        depth = max(0, depth + delta)
    return nl.join(out)


def _external(path, text, ext):
    """A formatter installed on the PC, if there is one that works on this kind of file; else None."""
    cwd = os.path.dirname(path) if path and os.path.isdir(os.path.dirname(path)) else None
    cmds = []
    if ext == "py":
        for tool, args in (("black", ["-q", "-"]), ("ruff", ["format", "-"])):
            exe = shutil.which(tool)
            if exe:
                cmds.append([exe, *args])
    if ext in ("js", "jsx", "mjs", "ts", "tsx", "css", "scss", "less", "json", "html", "htm", "md", "yml", "yaml"):
        exe = shutil.which("prettier")
        if exe:
            cmds.append([exe, "--stdin-filepath", path or f"x.{ext}"])
    for cmd in cmds:
        try:
            r = subprocess.run(cmd, input=text, capture_output=True, text=True, timeout=20, cwd=cwd,
                               creationflags=0x08000000)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout
        except Exception:
            continue
    return None


def format_text(path, text):
    ext = _ext(path)
    if len(text) > 1_000_000:
        raise ValueError("That file is too big to format here.")
    ext_out = _external(path, text, ext)
    if ext_out is not None:
        return ext_out
    if ext in ("json", "jsonc", "webmanifest") or os.path.basename(path or "").lower() in (".eslintrc", ".prettierrc"):
        try:
            return json.dumps(json.loads(text), indent=2, ensure_ascii=False) + "\n"
        except ValueError as e:
            raise ValueError(f"It isn't valid JSON, so I left it alone ({e}).")
    if ext in BRACE:
        return _generic(_reindent(_generic(text), ext, path))
    if ext in XMLISH:
        return _generic(_xmlish(text))
    if ext == "py":
        t = _generic(text)
        return re.sub(r"(?m)^( *)\t+", lambda m: m.group(1) + "    ", t)   # (tabs that lead a line become spaces)
    return _generic(text)
