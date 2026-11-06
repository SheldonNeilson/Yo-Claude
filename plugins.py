"""Plugins: small add-ons that put buttons on Yo Claude's toolbars (the header row at the top by default).

They live in `~/.yoclaude/plugins/<name>/plugin.json`, outside the app, so they are never part of what ships or is
published, and survive updates. `YOCLAUDE_PLUGINS_DIR` points somewhere else (tests). Plugins are read at startup and
by Tools > Reload plugins. A plugin that fails to load (bad JSON, missing field) is skipped and listed with its error;
the others still load. Plugins run commands as you (like a script of your own): only keep ones you trust there.

plugin.json:
  {"name": "my-plugin", "description": "...", "version": "1.0.0",
   "placement": "header",
   "buttons": [{"id": "update", "icon": "🕒", "label": "update", "tooltip": "...", "placement": "header", "order": 0,
                "run": <action>}]}

placement (on the plugin as the default for its buttons, and/or on a button) says where the button shows:
  "header"   the row at the top with the mic / voice / awake toggles (the default; "top" means the same)
  "menubar"  the menu bar at the very top, next to the pane buttons
  "composer" the row under the message box
order (optional number, default 0) sorts buttons within a place, lowest first. A bad placement skips the plugin and says why.

An action is one of
  {"kind": "command", "command": ["pwsh", "-File", "{plugin_dir}/x.ps1"]}
      runs it; its output shows as a note in the open session.
  {"kind": "review", "preview": [argv], "apply": [argv with {file}], "label": "{task}: {hours}h", "title": "..."}
      runs `preview`, which prints a JSON array of objects; each becomes a row of Claude's tick-list card (so you can
      tick, untick and add a note per row). Nothing else happens until [submit]: then `apply` runs with {file} = a
      temp JSON file of only the ticked objects (a ticked row's note is added to its object as "note"). `label` is
      a Python format string over the object's fields. Nothing goes to Claude.
  {"kind": "compose", "text": "Add to my timesheet: "}
      puts `text` in the message box (on a new line if it already holds text) and focuses it; nothing is sent, you finish
      the sentence and send it yourself. Nothing is run.
A review action may also have "when_empty": "<text>": when its preview prints an empty array, it still says there is
nothing to propose, and puts `when_empty` in the message box the same way (so there is a way to add something).
Placeholders in argv: {plugin_dir}. Timeouts: "timeout" seconds on the action (default 300).
"""
import json
import logging
import os
import subprocess
import tempfile

import yo_claude

log = logging.getLogger("yoclaude.plugins")
PLUGINS_DIR = os.environ.get("YOCLAUDE_PLUGINS_DIR") or os.path.join(yo_claude.DATA_DIR, "plugins")
KINDS = ("command", "review", "compose")
PLACEMENTS = ("header", "menubar", "composer")
PLACEMENT_ALIASES = {"top": "header"}


class _Fields(dict):
    def __missing__(self, key):
        return ""


def _argv(value, what):
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x for x in value):
        raise ValueError(f"{what} must be a list of strings")
    return value


def _action(run):
    if not isinstance(run, dict) or run.get("kind") not in KINDS:
        raise ValueError(f"run.kind must be one of {', '.join(KINDS)}")
    out = {"kind": run["kind"], "timeout": float(run.get("timeout") or 300)}
    if run["kind"] == "command":
        out["command"] = _argv(run.get("command"), "run.command")
    elif run["kind"] == "compose":
        if not isinstance(run.get("text"), str) or not run["text"].strip():
            raise ValueError("run.text must be a non-empty string")
        out["text"] = run["text"]
    else:
        out["preview"] = _argv(run.get("preview"), "run.preview")
        out["apply"] = _argv(run.get("apply"), "run.apply")
        out["label"] = str(run.get("label") or "")
        out["title"] = str(run.get("title") or "")
        out["when_empty"] = str(run.get("when_empty") or "")
    return out


def _placement(value, default):
    if value is None or value == "":
        return default
    v = PLACEMENT_ALIASES.get(str(value).strip().lower(), str(value).strip().lower())
    if v not in PLACEMENTS:
        raise ValueError(f"placement must be one of {', '.join(PLACEMENTS)} (not {value!r})")
    return v


def _read(folder):
    with open(os.path.join(folder, "plugin.json"), encoding="utf-8-sig") as f:
        m = json.load(f)
    name = str(m.get("name") or "").strip()
    if not name or not isinstance(m.get("buttons"), list) or not m["buttons"]:
        raise ValueError("needs a name and at least one button")
    default_place = _placement(m.get("placement"), "header")
    buttons, seen = [], set()
    for b in m["buttons"]:
        bid = str(b.get("id") or "").strip()
        if not bid or bid in seen:
            raise ValueError("every button needs its own id")
        seen.add(bid)
        buttons.append({"id": bid, "icon": str(b.get("icon") or ""), "label": str(b.get("label") or bid),
                        "tooltip": str(b.get("tooltip") or ""), "run": _action(b.get("run")),
                        "placement": _placement(b.get("placement"), default_place), "order": float(b.get("order") or 0)})
    return {"name": name, "description": str(m.get("description") or ""), "version": str(m.get("version") or ""),
            "dir": folder, "buttons": buttons}


def load():
    """Every plugin in PLUGINS_DIR: ([plugin], [{"folder", "error"}]). One bad plugin never stops the rest."""
    plugins, errors = [], []
    try:
        names = sorted(os.listdir(PLUGINS_DIR))
    except OSError:
        return plugins, errors
    for n in names:
        folder = os.path.join(PLUGINS_DIR, n)
        if not os.path.isfile(os.path.join(folder, "plugin.json")):
            continue
        try:
            p = _read(folder)
            if any(x["name"] == p["name"] for x in plugins):
                raise ValueError(f"another plugin is already called {p['name']}")
            plugins.append(p)
        except Exception as e:   # isolation: whatever is wrong with this one, carry on
            log.warning("plugin %s skipped: %s", n, e)
            errors.append({"folder": n, "error": f"{type(e).__name__}: {e}"})
    return plugins, errors


def public(plugins, errors):
    """What the window needs: the buttons, not the commands."""
    return {"plugins": [{"name": p["name"], "description": p["description"], "version": p["version"],
                         "buttons": [dict({k: b[k] for k in ("id", "icon", "label", "tooltip", "placement", "order")},
                                          **({"compose": b["run"]["text"]} if b["run"]["kind"] == "compose" else {}))
                                     for b in p["buttons"]]}
                        for p in plugins], "errors": errors}


def find(plugins, name, button):
    for p in plugins:
        if p["name"] == name:
            for b in p["buttons"]:
                if b["id"] == button:
                    return p, b
    return None, None


def run(plugin, argv, timeout, file=None):
    """Run an argv (no shell) in the plugin's folder. Returns (ok, stdout, stderr-or-error)."""
    argv = [x.replace("{plugin_dir}", plugin["dir"]).replace("{file}", file or "") for x in argv]
    try:
        r = subprocess.run(argv, cwd=plugin["dir"], capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        return False, "", f"timed out after {timeout:g}s"
    except OSError as e:
        return False, "", f"could not start {argv[0]}: {e}"
    return r.returncode == 0, r.stdout.strip(), (r.stderr.strip() or f"exit code {r.returncode}")[:2000]


def preview_rows(plugin, action):
    """Run a review action's preview: (entries, labels), or raises ValueError with what went wrong."""
    ok, out, err = run(plugin, action["preview"], action["timeout"])
    if not ok:
        raise ValueError(err)
    try:
        entries = json.loads(out)
    except ValueError:
        raise ValueError("the preview did not print JSON: " + out[:200])
    if not isinstance(entries, list) or not all(isinstance(x, dict) for x in entries):
        raise ValueError("the preview must print a JSON array of objects")
    labels = []
    for x in entries:
        try:
            labels.append(" ".join(action["label"].format_map(_Fields(x)).split()) or json.dumps(x, ensure_ascii=False))
        except (ValueError, IndexError, AttributeError):
            labels.append(json.dumps(x, ensure_ascii=False))
    return entries, labels


def apply_entries(plugin, action, entries):
    """Run a review action's apply on only these entries. Returns (ok, text)."""
    fd, path = tempfile.mkstemp(prefix="yoc-plugin-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=1)
        ok, out, err = run(plugin, action["apply"], action["timeout"], file=path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return ok, (out or "Done.") if ok else err
