"""Screen-control MCP server: lets Claude see the screen and drive mouse/keyboard (Windows).

Tools: screenshot (screen / one window / a region, with cursor marker), list_windows, focus_window, launch,
screen_info, mouse_move, click, double_click, right_click, mouse_down, mouse_up, drag, path, ellipse, scroll,
type_text, press_key, key_down, key_up, release_all, wait, wait_for_change, wait_for (control/text/window/pixel
appears or goes), pixels (colours at points), clipboard, set_window (move/resize/maximise), ocr (Windows OCR),
ui_tree / ui_act / ui_text / ui_table (UI Automation: controls by name, a window's text, grids as TSV), batch
(many actions in one call, optionally in a window's coordinates), macro (saved, replayable batches).

Coordinates are in the space of the screenshot Claude receives for the active monitor (scaled to MAX_WIDTH); the
server maps them to real screen pixels. screenshot(monitor=N) switches the active monitor.

Safety (see README): pyautogui FAILSAFE (slam the mouse into a screen corner), a global stop hotkey that toggles
input off/on (default Ctrl+Alt+X, SCREEN_CONTROL_STOP_KEY), a kill-switch file (DISABLED next to this script, or
SCREEN_CONTROL_KILL_FILE) that blocks every input tool while it exists - and screenshots too if its first line is
"all" - SCREEN_CONTROL_READONLY=1 to disable input entirely, and a log of every tool call (SCREEN_CONTROL_LOG;
typed text, clipboard text, ui_act values and macro params are logged by length only unless SCREEN_CONTROL_LOG_TEXT=1).

Code layout (package screen_control): app (FastMCP instance, log), safety (guards, stop hotkey), coords (monitors,
coordinate mapping), winapi (window lookup), capture (screenshot, pixels, diff), inputs (mouse, keyboard,
clipboard), windows (focus/launch/set_window), waiting, ocr, uia, batching (batch, macro). This file imports every
tool module (importing registers the tools) and re-exports the tools, so scratch scripts can `import server` and
call e.g. server.batch(...) directly.
"""
from screen_control import safety
from screen_control.app import mcp
from screen_control.batching import batch, macro
from screen_control.capture import pixels, screen_info, screenshot
from screen_control.inputs import (clipboard, click, double_click, drag, ellipse, key_down, key_up, mouse_down,
                                   mouse_move, mouse_up, path, press_key, release_all, right_click, scroll,
                                   type_text)
from screen_control.ocr import ocr
from screen_control.uia import ui_act, ui_table, ui_text, ui_tree
from screen_control.waiting import wait, wait_for, wait_for_change
from screen_control.windows import focus_window, launch, list_windows, set_window

if __name__ == "__main__":
    safety.start_hotkey()
    mcp.run()
