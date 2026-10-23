"""batch (many actions in one call) and macro (saved, parameterised batches)."""
import json
import os
import re
import time

from .app import HERE, _logged, mcp
from .capture import _box, _finish, _grab, _shot_box, pixels
from .coords import _from_screen
from .inputs import (clipboard, click, double_click, drag, ellipse, key_down, key_up, mouse_down, mouse_move,
                     mouse_up, path, press_key, release_all, right_click, scroll, type_text)
from .ocr import ocr
from .uia import ui_act, ui_table, ui_text, ui_tree
from .waiting import wait, wait_for, wait_for_change
from .windows import focus_window, launch, set_window

_BATCHABLE = {f.__name__: f for f in (mouse_move, click, double_click, right_click, mouse_down, mouse_up, drag, path,
                                      ellipse, scroll, type_text, press_key, key_down, key_up, release_all,
                                      focus_window, launch, wait, wait_for_change, wait_for, pixels, clipboard,
                                      set_window, ocr, ui_tree, ui_act, ui_text, ui_table)}
# results worth reading back; plain input actions are only reported when they fail
_REPORTED = {"focus_window", "launch", "wait_for_change", "wait_for", "pixels", "release_all", "clipboard",
             "set_window", "ocr", "ui_tree", "ui_act", "ui_text", "ui_table"}
_XY_KEYS = (("x", "y"), ("x1", "y1"), ("x2", "y2"), ("cx", "cy"))


def _shift(args: dict, dx: int, dy: int) -> dict:
    """Offset an action's coordinates (x/y, x1/y1, x2/y2, cx/cy, points, region, pixel) by (dx, dy)."""
    out = dict(args)
    for kx, ky in _XY_KEYS:
        if out.get(kx) is not None and out.get(ky) is not None:
            out[kx], out[ky] = out[kx] + dx, out[ky] + dy
    if out.get("points"):
        out["points"] = [[p[0] + dx, p[1] + dy] for p in out["points"]]
    if out.get("region"):
        out["region"] = [out["region"][0] + dx, out["region"][1] + dy, *out["region"][2:]]
    if out.get("pixel"):
        out["pixel"] = [out["pixel"][0] + dx, out["pixel"][1] + dy]
    return out


def _check_actions(actions: list) -> None:
    if not 1 <= len(actions) <= 200:
        raise ValueError("actions must have 1-200 entries")
    bad = [f"{i}: {a.get('tool') if isinstance(a, dict) else a!r}" for i, a in enumerate(actions, 1)
           if not isinstance(a, dict) or a.get("tool") not in _BATCHABLE]
    if bad:  # checked up front so nothing runs from a batch with a typo in it
        raise ValueError(f"unknown tool in action(s) {', '.join(bad)}; batchable: {', '.join(_BATCHABLE)}")


@mcp.tool(structured_output=False)
@_logged
def batch(actions: list[dict], origin: str | None = None, shot: bool | str = False, shot_window: str | None = None):
    """Run several actions in ONE call, in order, stopping at the first error. Each action is
    {"tool": "<name>", ...that tool's arguments}, e.g. [{"tool": "click", "x": 10, "y": 20},
    {"tool": "path", "points": [[0, 0], [50, 50]]}, {"tool": "press_key", "keys": "ctrl+z"}].
    Tools: mouse_move, click, double_click, right_click, mouse_down, mouse_up, drag, path, ellipse, scroll,
    type_text, press_key, key_down, key_up, release_all, focus_window, launch, wait, wait_for_change, wait_for,
    pixels, clipboard, set_window, ocr, ui_tree, ui_act, ui_text, ui_table.
    Put a wait_for step after anything slow (a dialog opening, a page loading): it stops the batch with a reason
    if the expected control/text/window never appears, instead of clicking into the wrong state.
    Prefer this whenever the next few steps do not depend on seeing the screen: every separate call re-reads the
    whole conversation. A sequence that worked can be kept with macro(action="save").
    origin: a window (title, "#handle" or "active"); all coordinates are then relative to its top-left, i.e. the
    pixel coordinates of a scale-1 screenshot of that window. Resolved once, before the first action.
    shot: True = one screenshot at the end, "diff" = only what changed during the batch (of shot_window, else
    origin, else the screen); per-action shot is ignored.
    The reply lists only failures, verify results and the output of the tools that return information."""
    _check_actions(actions)
    dx = dy = 0
    if origin:
        box, _ = _box(origin, None)
        dx, dy = _from_screen(box["left"], box["top"])
        shot_window = shot_window or origin
    before = _grab(_shot_box(shot_window)) if shot == "diff" else None
    notes = []
    for i, act in enumerate(actions, 1):
        args = dict(act)
        name = args.pop("tool")
        fn = _BATCHABLE[name]
        args.pop("shot", None)
        args.pop("shot_window", None)
        try:
            result = fn(**(args if name == "set_window" else _shift(args, dx, dy)))
        except Exception as e:
            notes.append(f"{i} {name} FAILED: {type(e).__name__}: {e}")
            return _finish([f"stopped after {i - 1} of {len(actions)} actions", "; ".join(notes)], shot, shot_window,
                           before)
        if name in _REPORTED or args.get("verify"):
            texts = result if isinstance(result, list) else [result]
            notes.append(f"{i} " + " | ".join(t for t in texts if isinstance(t, str)))
    return _finish([f"ran {len(actions)} actions" + (f" (origin {origin} at {dx},{dy})" if origin else ""),
                    "; ".join(notes)], shot, shot_window, before)


# ----------------------------------------------------------------------------------------- macros

MACRO_DIR = os.environ.get("SCREEN_CONTROL_MACROS", os.path.join(HERE, "macros"))
_MACRO_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _macro_path(name: str | None) -> str:
    if not name or not _MACRO_NAME.match(name):
        raise ValueError("macro name must be 1-64 letters, digits, _ or -")
    return os.path.join(MACRO_DIR, f"{name}.json")


def _placeholders(obj) -> set[str]:
    if isinstance(obj, str):
        return set(_PLACEHOLDER.findall(obj))
    if isinstance(obj, dict):
        return set().union(*(_placeholders(v) for v in obj.values())) if obj else set()
    if isinstance(obj, list):
        return set().union(*(_placeholders(v) for v in obj)) if obj else set()
    return set()


def _fill(obj, params: dict):
    """Substitute {name} placeholders. A string that is exactly one placeholder takes the value as-is (so numbers
    stay numbers); otherwise the value is inserted as text."""
    if isinstance(obj, str):
        m = _PLACEHOLDER.fullmatch(obj)
        if m:
            return params[m.group(1)]
        return _PLACEHOLDER.sub(lambda mm: str(params[mm.group(1)]), obj)
    if isinstance(obj, dict):
        return {k: _fill(v, params) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_fill(v, params) for v in obj]
    return obj


@mcp.tool(structured_output=False)
@_logged
def macro(action: str, name: str | None = None, actions: list[dict] | None = None, description: str | None = None,
          params: dict | None = None, origin: str | None = None, shot: bool | str = False,
          shot_window: str | None = None):
    """Saved, replayable action sequences - save one after a batch has worked, then repeat it in one short call.
    action="save": name, actions (exactly as for batch), description (what it does and when it applies), optional
      origin (window the coordinates are relative to; strongly recommended so it survives the window moving).
      Any "{word}" inside an action value becomes a parameter, e.g. {"tool": "type_text", "text": "{message}"} or
      {"tool": "click", "x": "{x}", "y": 40} (a value that is only a placeholder keeps its type).
    action="run": name, params {"message": ..} for its placeholders; origin/shot/shot_window override. Runs via batch.
    action="list" (all macros), "show" (one macro's JSON, e.g. to edit and re-save), "delete"."""
    if action == "list":
        if not os.path.isdir(MACRO_DIR):
            return "no macros saved"
        rows = []
        for fn in sorted(os.listdir(MACRO_DIR)):
            if fn.endswith(".json"):
                with open(os.path.join(MACRO_DIR, fn), encoding="utf-8") as f:
                    m = json.load(f)
                rows.append(f"{m['name']}({', '.join(m.get('params', []))}) - {m.get('description', '')}"
                            f"{' [origin ' + m['origin'] + ']' if m.get('origin') else ''} ({len(m['actions'])} actions)")
        return "\n".join(rows) or "no macros saved"
    path_ = _macro_path(name)
    if action == "save":
        if not actions or not description:
            raise ValueError("save needs actions and a description")
        _check_actions(actions)
        os.makedirs(MACRO_DIR, exist_ok=True)
        existed = os.path.exists(path_)
        m = {"name": name, "description": description, "origin": origin, "params": sorted(_placeholders(actions)),
             "actions": actions, "saved": time.strftime("%Y-%m-%d %H:%M:%S")}
        with open(path_, "w", encoding="utf-8") as f:
            json.dump(m, f, indent=1, ensure_ascii=False)
        return (f"{'replaced' if existed else 'saved'} macro {name!r}: {len(actions)} actions, params "
                f"{m['params'] or 'none'}")
    if not os.path.exists(path_):
        raise ValueError(f"no macro {name!r}; macro(action='list') shows the saved ones")
    with open(path_, encoding="utf-8") as f:
        m = json.load(f)
    if action == "show":
        return json.dumps(m, ensure_ascii=False)
    if action == "delete":
        os.remove(path_)
        return f"deleted macro {name!r}"
    if action != "run":
        raise ValueError("action must be save, run, list, show or delete")
    params = params or {}
    missing = [p for p in m.get("params", []) if p not in params]
    if missing:
        raise ValueError(f"macro {name!r} needs params: {', '.join(missing)}")
    result = batch(_fill(m["actions"], params), origin=origin or m.get("origin"), shot=shot, shot_window=shot_window)
    if isinstance(result, list):
        return [f"macro {name}: {result[0]}", *result[1:]]
    return f"macro {name}: {result}"
