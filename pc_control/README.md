# screen-control (MCP server)

Lets Claude see your screen and use your mouse/keyboard. Windows, Python 3.10+.

## In Yo Claude

Yo Claude's installer sets this up in `pc_control\.venv` (pinned versions: `mcp`, `mss`, `pyautogui`, `pillow`,
`pywin32`, `uiautomation`/`comtypes` and the `winrt-*` packages for Windows' built-in OCR) and starts it for its own
Claude sessions while PC control is on (tray menu or the header's [pc control]). Its log, saved macros and kill-switch
file live in `~/.yoclaude/pc-control/`. Nothing needs registering with Claude Code.

## Code layout and tests

`server.py` is the entry point: it imports the `screen_control` package (importing a module registers its tools)
and re-exports every tool, so a scratch script can `import server` and call `server.batch(...)` directly.

| Module | Holds |
|---|---|
| `app` | FastMCP instance, shared Win32 handles, the per-call log (`_logged`) |
| `safety` | kill switch, stop hotkey, read-only mode, held keys/buttons. Its flags are rebound at run time: read them as `safety._stopped`, never `from .safety import _stopped` |
| `coords` | monitors, screenshot <-> screen coordinate mapping (`coords._active_monitor`) |
| `winapi` | window enumeration, `#handle`/title lookup, coverage, foregrounding |
| `capture` | `screenshot`, `pixels`, `screen_info`, diff crops, the `verify`/`shot` plumbing |
| `inputs` | mouse, keyboard, `clipboard` |
| `windows` | `list_windows`, `focus_window`, `launch`, `set_window` |
| `waiting` | `wait`, `wait_for_change`, `wait_for` |
| `ocr`, `uia` | Windows OCR; UI Automation (`ui_tree`, `ui_act`, `ui_text`, `ui_table`) |
| `batching` | `batch`, `macro` |

```powershell
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python -m pytest                                  # unit tests: no mouse, keyboard or screen
$env:SCREEN_CONTROL_INTEGRATION = '1'; .\.venv\Scripts\python -m pytest   # also drives real windows
```

The integration tests open their own WinForms window (`tests\fixture_form.ps1`, unique title, killed afterwards) and
an Explorer window on a temp folder; they move the mouse and type, so leave the machine alone for the ~25 s they take.

## Tools

| Area | Tools |
|---|---|
| See | `screenshot`, `pixels`, `ocr`, `ui_tree`, `ui_text`, `ui_table`, `list_windows`, `screen_info` |
| Wait | `wait_for`, `wait_for_change`, `wait` |
| Mouse | `mouse_move`, `click`, `double_click`, `right_click`, `drag`, `path`, `ellipse`, `scroll`, `mouse_down`, `mouse_up` |
| Keyboard / clipboard | `type_text`, `press_key`, `key_down`, `key_up`, `clipboard` |
| Controls by name | `ui_tree`, `ui_act`, `ui_text`, `ui_table` |
| Windows/apps | `focus_window`, `set_window`, `launch` |
| Several at once | `batch`, `macro` |
| Recovery | `release_all` |

Coordinates are in the screenshot's space (scaled to 1280 px wide by default; `SCREEN_CONTROL_MAX_WIDTH` to change).

### Choosing windows

- `window`/`title`/`origin` arguments take a title substring (first match, topmost first), `"active"`, or
  `"#<handle>"`. `list_windows` shows handles (and `*` on the foreground window); use a handle when several windows
  share a title, e.g. two "Untitled - Paint".
- `launch(app, wait_for_window=...)` focuses the window it just opened (not an older one with the same title) and
  returns its `#handle`; for single-instance apps it falls back to the existing window after `timeout`.
- `set_window(window, x, y, width, height, state)` moves/resizes a window's visible frame or maximises, minimises or
  restores it. A fixed position and size keeps coordinates stable between runs and saved macros.

### Screenshots

`screenshot(window=None, region=None, scale=1.0, cursor=True, monitor=None, force=False)`

- `window=...` captures only that window; `region=[x, y, w, h]` only that part. `scale` shrinks (saves context) or
  zooms (up to 4x). Crops/scaled images are not in screenshot coordinates; the reply text gives `offset_x`,
  `offset_y`, `scale`: `x = offset_x + px/scale`, `y = offset_y + py/scale`.
- It is a screen grab, so windows covering the target appear in it; a window capture says when that is the case
  ("PARTLY COVERED by ...": focus it first, or clicks there land on the other window).
- A red ring marks the mouse position (`cursor=False` to hide). It is drawn on the image, not captured.
- `monitor=N` switches the active monitor for every tool (coordinates are then relative to that monitor).
- If the image is the same as the last one returned (ignoring up to 64 stray pixels, e.g. a window edge or a caret
  blink), only a text note is sent (`force=True` resends it).

### Keeping usage down

Every tool call is a model round trip that re-reads the whole conversation, including every earlier screenshot (an
image costs about width x height / 750 tokens each time). So, roughly in order of savings:

- `batch(actions=[{"tool": "click", "x": .., "y": ..}, {"tool": "path", "points": [..]}, ...])` runs up to 200
  actions in one call, stopping at the first error. `origin="#<handle>"` makes every coordinate relative to that
  window, so points read straight off a window screenshot need no offset arithmetic. The reply lists only failures,
  `verify` results and the output of the tools that return information.
- `shot="diff"` (on `batch` and every input tool) appends only the parts of the screen that changed, as up to four
  small crops with their offsets, or "no visible change". Picking a colour in Paint returns ~5,000 pixels instead of a
  220,000-pixel window.
- `macro(...)`: save a sequence that worked, replay it later in one short call (see below).
- `ui_tree` / `ocr` / `pixels` / `clipboard` answer many questions as text: which buttons exist and where, what a
  label says, whether a toggle is on, what was copied.
- `ellipse(cx, cy, rx, ry=None)` draws a circle/ellipse without Claude writing out the points.
- Prefer a window or region screenshot with `scale` < 1 over the full screen.

### Controls by name (UI Automation)

`ui_tree(window="active", query=None, control_type=None, max_depth=25, limit=150, include_all=False)` lists a window's
buttons, menus, fields, list items etc. with their names, centre points, supported actions
(`{invoke,toggle,value,expand,select}`) and state (`=on`, `=selected`, `='text'`), each with a `[ref]`.
`ui_act(ref | name=..., action=...)` then acts on one: `click` (a real mouse click at its centre), `invoke`,
`toggle`, `expand`, `collapse`, `select`, `set_value` (with `value`), `focus`, or `get`. `invoke`/`toggle`/`select`/
`set_value` need no mouse at all, so they work even when the window is covered. Works for most Win32, WinForms, WPF,
WinUI and Electron apps (in Paint: tools, menus and the colour palette, e.g. `ui_act(name="Red", action="invoke")`);
canvases and games expose nothing, so use coordinates there.

- `ui_act(name=...)` also finds a control scrolled out of view (a list item, a grid row), including items a
  virtualised list has not created yet (exact name, via ItemContainerPattern), and scrolls it into view first.
  `action="scroll_into_view"` does only that.
- `ui_text(window="active", max_chars=8000)` returns all the text a window shows in UI order, one line per control
  (`Edit: Name = 'Ann'`, `CheckBox: I agree =on`): read a dialog, form or error message without a screenshot.
  Password fields show as `<password>`; grids show as one line pointing at `ui_table`.
- `ui_table(ref | name | neither, window="active", max_rows=200, max_cols=40)` returns a grid, table or list as
  tab-separated rows, header first. It uses UI Automation's GridPattern where the control has it (Explorer's details
  view, WPF/Excel grids) and otherwise reads rows from child elements (.NET Framework DataGridViews, list boxes),
  dropping DataGridView row headers. Virtualised grids only expose about the visible rows: scroll and read again.
  Not yet checked against SSMS's results grid; if a grid exposes nothing, select all + `ctrl+c` + `clipboard()`.

### Waiting for things

`wait_for(control | text | title | pixel, gone=False, window=None, region=None, timeout=10)` polls until:

- `control`: a UI Automation control whose name contains this is on screen in `window` (default the active window;
  a dialog that is still opening counts as "not yet"); `control_type` narrows it.
- `text`: Windows OCR finds this text in `window`/`region` (slower; for canvases and remote desktops).
- `title`: a window with this in its title is open.
- `pixel=[x, y]` shows `color="#rrggbb"` (within 24 per channel), or without `color`, changes from its current colour.
- `gone=True` waits for it to disappear instead.

On timeout it **raises**, so as a `batch` step it stops the batch with a reason instead of letting the next steps
click into the wrong state. Put one after anything slow (a dialog opening, a page loading), especially in macros.
With `batch(origin=...)`, `pixel` is relative to the origin window like every other coordinate.

### Reading text (OCR)

`ocr(window=None, region=None, text=None)` uses Windows' built-in OCR (the user's display language). Without `text`
it returns every line with its position; with `text` only the matches, each with a `center=(x,y)` to click.

### Macros

Macros are written by Claude: after a batch has worked, Claude saves it so the same job later takes one call.

- `macro(action="save", name=..., actions=[...], description=..., origin=...)`: `actions` exactly as for `batch`.
  Any `{word}` in an action value becomes a parameter, e.g. `{"tool": "type_text", "text": "{message}"}` or
  `{"tool": "click", "x": "{x}", "y": 40}` (a value that is only a placeholder keeps its type, so numbers stay
  numbers). Give an `origin` window so coordinates survive the window moving, or use `ui_act` by name, which survives
  layout changes too.
- `macro(action="run", name=..., params={...})` runs it through `batch` (`origin`, `shot`, `shot_window` can be
  overridden). `"list"`, `"show"` (JSON, to edit and re-save) and `"delete"` manage them.
- Stored as JSON in `macros\` next to `server.py` (`SCREEN_CONTROL_MACROS` to move it). They are plain files you can
  read or edit. A macro runs with the same guards as any other input, but it is still input on your machine: read
  one before running it if you didn't see it being made.

### Reliability features

- Mouse presses are preceded by a short hover so apps that ignore a press without hover events (Paint, Electron/WinUI
  apps) still register the first drag/click.
- Pointer movement is sent as real mouse-move input (`SendInput`), not `SetCursorPos`, so pointer-input apps (WinUI
  Paint, ink canvases) see the whole stroke instead of a straight line from press to release.
- `path(points, closed=False)` draws a whole stroke (polyline, polygon, curve) in one call.
- `verify=True` (on click/drag/path/ellipse/scroll/type_text/press_key) reports whether pixels near the action changed,
  so an ignored action is visible. It cannot tell "ignored" from "already in that state".
- `shot=True` (+ optional `shot_window`) appends a fresh screenshot to the result; `shot="diff"` only what changed.
- `wait_for_change` waits for the screen/window/region to change and settle.
- `type_text` handles any Unicode (ASCII via key events, other characters via Unicode input events); for long text,
  `clipboard(text)` + `press_key("ctrl+v")` is instant.
- `press_key` rejects unknown key names with suggestions. `SCREEN_CONTROL_SPEED` (default 1.0; 0.5 = half speed)
  scales all pauses and movement times.

## Safety

- **Kill-switch file**: while `~/.yoclaude/pc-control/DISABLED` exists, every input tool refuses
  immediately (a stroke in progress is aborted and the mouse released). If the file's first line is `all`,
  screenshots, OCR, UI Automation reads, clipboard reads and window listing are blocked too. No restart needed;
  `screen_info` still works and reports it.
  `SCREEN_CONTROL_KILL_FILE` overrides the path.
- **Stop hotkey**: Ctrl+Alt+X (`SCREEN_CONTROL_STOP_KEY`, e.g. `ctrl+alt+pause`) toggles all input off/on and releases
  anything held. Only the user can resume; there is no tool for it.
- Slam the mouse into any screen corner to abort (pyautogui failsafe).
- `SCREEN_CONTROL_READONLY=1` disables all input; reading only.
- **Log**: every tool call is appended to `screen-control.log` (JSON lines: time, tool, arguments, foreground window,
  result; rotates at 1 MB x3; `SCREEN_CONTROL_LOG` to move it). Typed text, clipboard text (both directions),
  `ui_act` values and macro parameters are logged as a character count only, `ui_text`/`ui_table` results and the
  step output of `batch`/`macro` (failures excepted) not at all, unless `SCREEN_CONTROL_LOG_TEXT=1`.
  Keep the log, `DISABLED` and `macros\` out of git.
- `clipboard()` reads whatever you last copied, which may be sensitive; it is only read when Claude calls it, and it
  is logged by length only.
- Claude acts as you, with your logins. Don't leave it running unattended on sensitive apps, and keep tool-approval
  prompts on so you confirm actions.
- `launch` starts any program or opens any file/URL, like the Run dialog; it is covered by the guards above and logged.
