"""Windows UI Automation: listing controls and acting on them by name."""
import re
import sys

from .app import _logged, mcp
from .coords import _from_screen, _scale
from .inputs import _click
from .safety import _guard, _guard_read, _pause
from .winapi import _find_window

_auto = None
_ui_refs: dict[int, object] = {}
_GLYPH = re.compile(r"^[-\s]*$")  # icon-font glyphs used as names: noise
_UI_PATTERNS = {"invoke": "InvokePattern", "toggle": "TogglePattern", "value": "ValuePattern",
                "expand": "ExpandCollapsePattern", "select": "SelectionItemPattern"}
_UI_SHOWN_TYPES = {"Edit", "Text", "Document", "Tab", "TabItem", "MenuItem", "ListItem", "TreeItem", "CheckBox",
                   "RadioButton", "ComboBox", "Hyperlink", "Slider", "Button", "Spinner"}


def _ui():
    """Import uiautomation on first use. COM in the multi-threaded apartment, so elements found in one tool call
    still work when the next call runs on another thread."""
    global _auto
    if _auto is None:
        sys.coinit_flags = 0  # COINIT_MULTITHREADED; must be set before comtypes is first imported
        import uiautomation
        uiautomation.SetGlobalSearchTimeout(1)
        _auto = uiautomation
    return _auto


def _ui_patterns(ctl) -> list[str]:
    P = _ui().PatternId
    return [k for k, p in _UI_PATTERNS.items() if ctl.GetPattern(getattr(P, p))]


def _ui_state(ctl, pats: list[str]) -> str:
    P = _ui().PatternId
    try:
        if "toggle" in pats:
            return " =" + ("off", "on", "mixed")[ctl.GetPattern(P.TogglePattern).ToggleState]
        if "select" in pats and ctl.GetPattern(P.SelectionItemPattern).IsSelected:
            return " =selected"
        if "value" in pats:
            if _is_password(ctl):
                return " =<password>"
            v = ctl.GetPattern(P.ValuePattern).Value or ""
            return f" ={v[:40]!r}" if v else ""
    except Exception:
        pass
    return ""


def _ui_walk(root, max_depth: int, limit: int, keep, offscreen: bool = False):
    """Depth-first over on-screen descendants (offscreen=True: also those scrolled out of view); yields
    (depth, control, type, patterns) where keep() is true."""
    found = 0

    def walk(ctl, depth):
        nonlocal found
        for ch in ctl.GetChildren():
            if found >= limit:
                return
            if ch.Name == "Pop-upHost":  # keyboard-shortcut hint overlays (WinUI)
                continue
            if not offscreen:
                r = ch.BoundingRectangle
                if ch.IsOffscreen or r.width() <= 0 or r.height() <= 0:
                    continue
            typ = ch.ControlTypeName.removesuffix("Control")
            pats = _ui_patterns(ch)
            if keep(ch, typ, pats):
                found += 1
                yield depth, ch, typ, pats
            if depth < max_depth:
                yield from walk(ch, depth + 1)

    yield from walk(root, 0)


def _ui_line(ref: int, depth: int, ch, typ: str, pats: list[str]) -> str:
    r = ch.BoundingRectangle
    cx, cy = _from_screen((r.left + r.right) // 2, (r.top + r.bottom) // 2)
    s = _scale()
    aid = ch.AutomationId
    return (f"{' ' * min(depth, 10)}[{ref}] {typ} {ch.Name!r}{' id=' + aid if aid and aid != ch.Name else ''} "
            f"@({cx},{cy}) {round(r.width() * s)}x{round(r.height() * s)}"
            f"{' {' + ','.join(pats) + '}' if pats else ''}{_ui_state(ch, pats)}")


def _ui_scroll_into_view(ctl) -> bool:
    """Scroll a list item / grid row / tree item into view (realising it first if the list is virtualised)."""
    P = _ui().PatternId
    v = ctl.GetPattern(P.VirtualizedItemPattern)
    if v:
        v.Realize()
    sp = ctl.GetPattern(P.ScrollItemPattern)
    if not sp:
        return False
    sp.ScrollIntoView()
    _pause(0.1)
    return True


def _ui_find_hidden(root, name: str, match):
    """A control scrolled out of view, scrolled back in: first among created-but-offscreen items, then (exact
    name only) via ItemContainerPattern, which also finds rows a virtualised list has not created yet."""
    hit = next((c for _, c, _, _ in _ui_walk(root, 30, 1, match, offscreen=True)), None)
    if hit is None:
        auto = _ui()
        containers = _ui_walk(root, 30, 20, lambda c, typ, p: c.GetPattern(auto.PatternId.ItemContainerPattern))
        for _, cont, _, _ in containers:
            try:
                # the raw COM call: the wrapper cannot pass a NULL "start after" element
                ele = cont.GetPattern(auto.PatternId.ItemContainerPattern).pattern.FindItemByProperty(
                    None, auto.PropertyId.NameProperty, name)
                hit = auto.Control.CreateControlFromElement(ele) if ele else None
            except Exception:
                hit = None
            if hit:
                break
    if hit is not None:
        _ui_scroll_into_view(hit)
    return hit


@mcp.tool(structured_output=False)
@_logged
def ui_tree(window: str = "active", query: str | None = None, control_type: str | None = None,
            max_depth: int = 25, limit: int = 150, include_all: bool = False) -> str:
    """List a window's controls via Windows UI Automation: buttons, menus, fields, list items... with names,
    centre points (screenshot coords), supported actions {invoke,toggle,value,expand,select} and state.
    Usually cheaper and more exact than a screenshot for ordinary apps. Each line has a [ref] for ui_act (refs are
    replaced by the next ui_tree call). query: only controls whose name/automation id contains it.
    control_type: e.g. Button, Edit, MenuItem, ListItem. include_all: also unnamed/inert elements."""
    _guard_read()
    hwnd, title, _ = _find_window(window)
    root = _ui().ControlFromHandle(hwnd)
    q = query.lower() if query else None
    ct = control_type.lower().removesuffix("control") if control_type else None

    def keep(ch, typ, pats):
        name = ch.Name or ""
        named = bool(name and not _GLYPH.match(name)) or bool(ch.AutomationId)
        if not include_all and not (named and (pats or typ in _UI_SHOWN_TYPES)):
            return False
        if q and q not in name.lower() and q not in ch.AutomationId.lower():
            return False
        return not ct or typ.lower() == ct

    _ui_refs.clear()
    lines = []
    for depth, ch, typ, pats in _ui_walk(root, max_depth, limit, keep):
        _ui_refs[len(_ui_refs) + 1] = ch
        lines.append(_ui_line(len(_ui_refs), depth, ch, typ, pats))
    more = f" (limit {limit} reached; narrow with query/control_type)" if len(lines) >= limit else ""
    return f"{len(lines)} control(s) in {title!r} #{hwnd}{more}" + ("\n" + "\n".join(lines) if lines else "")


@mcp.tool(structured_output=False)
@_logged
def ui_act(ref: int | None = None, action: str = "click", value: str | None = None, window: str = "active",
           name: str | None = None, control_type: str | None = None) -> str:
    """Act on a UI Automation control: a [ref] from the last ui_tree, or the first control in `window` whose name
    is `name` (exact match preferred, else contains; optional control_type). A named control scrolled out of view
    (a long list, a grid row) is scrolled into view first where the app supports it.
    action: click (real mouse click at its centre), invoke, toggle, expand, collapse, select, set_value (value),
    focus, scroll_into_view, get (state only). invoke/toggle/select/set_value work without moving the mouse, even
    if the window is covered."""
    if ref is not None:
        ctl = _ui_refs.get(ref)
        if ctl is None:
            raise ValueError(f"unknown ref {ref}; call ui_tree again (refs are replaced by each ui_tree call)")
    elif name:
        hwnd, _, _ = _find_window(window)
        root = _ui().ControlFromHandle(hwnd)
        n, ct = name.lower(), control_type.lower().removesuffix("control") if control_type else None
        match = lambda c, typ, p: n in (c.Name or "").lower() and (not ct or typ.lower() == ct)
        hits = [c for _, c, _, _ in _ui_walk(root, 30, 400, match)]
        if hits:
            ctl = next((c for c in hits if (c.Name or "").lower() == n), hits[0])
        else:
            ctl = _ui_find_hidden(root, name, match)
            if ctl is None:
                raise ValueError(f"no control named {name!r} (on screen or scrolled out of view); "
                                 "try ui_tree(query=...)")
    else:
        raise ValueError("pass ref (from ui_tree) or name")
    P = _ui().PatternId
    pats = _ui_patterns(ctl)
    typ = ctl.ControlTypeName.removesuffix("Control")
    label = f"{typ} {ctl.Name!r}"
    if action == "get":
        _guard_read()
        return label + _ui_state(ctl, pats)
    _guard()
    need = {"invoke": "invoke", "toggle": "toggle", "expand": "expand", "collapse": "expand", "select": "select",
            "set_value": "value"}.get(action)
    if need and need not in pats:
        raise ValueError(f"{label} does not support {action} (supports: {', '.join(pats) or 'nothing'}); "
                         "use action='click'")
    if action == "click":
        r = ctl.BoundingRectangle
        _click(*_from_screen((r.left + r.right) // 2, (r.top + r.bottom) // 2), "left", 1, False, False, None, "clicked")
    elif action == "invoke":
        ctl.GetPattern(P.InvokePattern).Invoke()
    elif action == "toggle":
        ctl.GetPattern(P.TogglePattern).Toggle()
    elif action == "expand":
        ctl.GetPattern(P.ExpandCollapsePattern).Expand()
    elif action == "collapse":
        ctl.GetPattern(P.ExpandCollapsePattern).Collapse()
    elif action == "select":
        ctl.GetPattern(P.SelectionItemPattern).Select()
    elif action == "set_value":
        ctl.GetPattern(P.ValuePattern).SetValue(value or "")
    elif action == "focus":
        ctl.SetFocus()
    elif action == "scroll_into_view":
        if not _ui_scroll_into_view(ctl):
            raise ValueError(f"{label} cannot be scrolled into view (no ScrollItemPattern)")
    else:
        raise ValueError("action must be click, invoke, toggle, expand, collapse, select, set_value, focus, "
                         "scroll_into_view or get")
    _pause(0.1)
    return f"{action} {label}" + _ui_state(ctl, pats)


# ------------------------------------------------------------------------------- reading as text

_TEXT_SKIP = {"TitleBar", "ScrollBar", "Thumb"}  # window chrome: no content, only noise


def _is_password(ctl) -> bool:
    try:
        return bool(ctl.Element.CurrentIsPassword)
    except Exception:
        return False


def _ui_value(ctl, max_len: int = 4000) -> str | None:
    """A control's value or document text, or None when it has neither. Password fields are never read."""
    if _is_password(ctl):
        return "<password>"
    P = _ui().PatternId
    try:
        vp = ctl.GetPattern(P.ValuePattern)
        if vp:
            return vp.Value
        tp = ctl.GetPattern(P.TextPattern)
        if tp:
            return tp.DocumentRange.GetText(max_len)
    except Exception:
        pass
    return None


@mcp.tool(structured_output=False)
@_logged
def ui_text(window: str = "active", max_chars: int = 8000) -> str:
    """All the text a window shows, read through UI Automation in UI order: labels, field values, button and
    list captions, error messages, document text. One line per control ("Type: name = 'value'"). Reads a dialog,
    form or message box without a screenshot. Password fields show as <password>. Controls scrolled out of view
    are skipped; tables read better with ui_table. Logged without the text."""
    _guard_read()
    hwnd, title, _ = _find_window(window)
    root = _ui().ControlFromHandle(hwnd)
    max_chars = max(200, min(100_000, max_chars))
    lines, size, prev = [], 0, None
    truncated = False

    def walk(ctl, depth):
        nonlocal size, prev, truncated
        for ch in ctl.GetChildren():
            if truncated:
                return
            typ = ch.ControlTypeName.removesuffix("Control")
            r = ch.BoundingRectangle
            if typ in _TEXT_SKIP or ch.Name == "Pop-upHost" or ch.IsOffscreen or r.width() <= 0 or r.height() <= 0:
                continue
            name = (ch.Name or "").strip()
            name = "" if _GLYPH.match(name) else name
            if typ in ("Table", "DataGrid"):  # cell by cell is long and unreadable: point at ui_table instead
                lines.append(f"{typ}: {name} [grid; read it with ui_table]")
                prev = lines[-1]
                size += len(prev) + 1
                continue
            value = _ui_value(ch) if typ in ("Edit", "Document", "ComboBox", "Spinner", "DataItem", "Custom") \
                or not name else None
            value = value.strip() if value else ""
            if name or value:
                line = f"{typ}: {name}" + (f" = {value!r}" if value and value != name else "")
                if typ in ("CheckBox", "RadioButton"):
                    line += _ui_state(ch, _ui_patterns(ch))
                if line != prev and not (prev and typ == "Text" and prev.endswith(f" {name}")):
                    lines.append(line)
                    size += len(line) + 1
                    prev = line
                    if size > max_chars:
                        truncated = True
                        return
            if depth < 40:
                walk(ch, depth + 1)

    walk(root, 0)
    more = f" (truncated at {max_chars} chars; raise max_chars)" if truncated else ""
    return f"{len(lines)} line(s) of text in {title!r} #{hwnd}{more}" + ("\n" + "\n".join(lines) if lines else "")


def _ctype(ctl) -> str:
    return ctl.ControlTypeName.removesuffix("Control")


def _cell(ctl) -> str:
    """A grid cell's text: its value if it has one, else its children's names (WPF cells), else its own name."""
    v = _ui_value(ctl, 1000)
    if v is None:
        kids = [c.Name for c in ctl.GetChildren() if c.Name]
        v = " ".join(kids) if kids else (ctl.Name or "")
    v = v.replace("\u200e", "").replace("\u200f", "")  # bidi marks Explorer puts around dates
    return v.replace("\t", "\\t").replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "")


_TABLE_TYPES = {"DataGrid", "Table", "List"}


@mcp.tool(structured_output=False)
@_logged
def ui_table(ref: int | None = None, window: str = "active", name: str | None = None, max_rows: int = 200,
             max_cols: int = 40) -> str:
    """Read a grid/table/list control as tab-separated rows, header first: WinForms DataGridViews, list boxes,
    Explorer-style details views, and other controls exposing UI Automation's GridPattern (WPF DataGrid, Excel
    should too). Pick it by [ref] from ui_tree, by name, or neither for the first grid/table/list in `window`. Only rows the control has created can be read: virtualised grids expose about the
    visible rows, so scroll (ui_act action="scroll_into_view" on the last row) and read again for more. Tabs and
    newlines inside cells show as \\t and \\n. Logged without the data. If a grid exposes nothing (custom-drawn),
    select all + ctrl+c + clipboard() is the fallback."""
    _guard_read()
    auto = _ui()
    P = auto.PatternId
    if ref is not None:
        ctl = _ui_refs.get(ref)
        if ctl is None:
            raise ValueError(f"unknown ref {ref}; call ui_tree again (refs are replaced by each ui_tree call)")
    else:
        hwnd, _, _ = _find_window(window)
        n = name.lower() if name else None

        def is_table(c, typ, p):
            if n and n not in (c.Name or "").lower() and n not in (c.AutomationId or "").lower():
                return False
            return bool(c.GetPattern(P.GridPattern)) or typ in _TABLE_TYPES

        ctl = next((c for _, c, _, _ in _ui_walk(auto.ControlFromHandle(hwnd), 30, 1, is_table)), None)
        if ctl is None:
            raise ValueError(f"no grid/table/list{' named ' + repr(name) if name else ''} on screen in {window!r}; "
                             "try ui_tree(control_type='DataGrid') or pass a ref")
    max_rows, max_cols = max(1, min(5000, max_rows)), max(1, min(200, max_cols))
    label = f"{ctl.ControlTypeName.removesuffix('Control')} {ctl.Name!r}"
    rows: list[list[str]] = []
    grid = ctl.GetPattern(P.GridPattern)
    if grid:
        total, cols = grid.RowCount, grid.ColumnCount
        table = ctl.GetPattern(P.TablePattern)
        headers = [h.Name or "" for h in table.GetColumnHeaders()][:max_cols] if table else []
        if headers:
            rows.append(headers)
        for r in range(min(total, max_rows)):
            row = []
            for c in range(min(cols, max_cols)):
                item = grid.GetItem(r, c)
                row.append(_cell(item) if item else "")
            rows.append(row)
        how = f"{total} row(s) x {cols} column(s) via GridPattern"
    else:
        # no grid pattern (e.g. a .NET Framework DataGridView seen through MSAA): rows are the children, cells theirs
        kids = [ch for ch in ctl.GetChildren() if _ctype(ch) not in ("ScrollBar", "Thumb")]
        typed = []  # [(type, text)] per row; read only as many rows as are shown
        for ch in kids[:max_rows + 1]:
            cells = [c for c in ch.GetChildren() if _ctype(c) not in ("ScrollBar", "Thumb")][:max_cols]
            typed.append([(_ctype(c), _cell(c)) for c in cells] if cells else [(_ctype(ch), _cell(ch))])
        header = typed and len(typed[0]) > 1 and all(t in ("Header", "HeaderItem") for t, _ in typed[0])
        body = typed[1:] if header else typed
        body = body[:max_rows]
        total = len(kids) - (1 if header else 0)
        # a DataGridView's row headers ("Row 0", ...) are a column of Header cells: not data
        drop = 1 if body and all(len(r) > 1 and r[0][0] == "Header" for r in body) else 0
        rows = [[text for _, text in r[drop:]] for r in ([typed[0]] if header else []) + body]
        cols = max((len(r) for r in rows), default=0)
        how = f"{total} row(s) x {cols} column(s) from child elements"
    more = f"; showing the first {max_rows}" if total > max_rows else ""
    more += f"; first {max_cols} columns" if cols > max_cols else ""
    return f"{label}: {how}{more}" + ("\n" + "\n".join("\t".join(r) for r in rows) if rows else "")
