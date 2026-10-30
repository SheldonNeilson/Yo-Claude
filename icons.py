"""Claude Code's pixel mascot, drawn for the tray (animated per state), the window and the taskbar (.ico)."""

import ctypes
import os
import winreg

from PIL import Image, ImageDraw, ImageFilter

# From Claude Code's welcome screen block characters (" ▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝"), trimmed to its 16 used
# columns. Pixels are taller than wide, like a quarter of a terminal cell.
CLAWD = ["..############..",
         "..##.######.##..",
         "################",
         "..############..",
         "...#.#....#.#..."]
BLINK = CLAWD[:1] + ["..############.."] + CLAWD[2:]
WALK = CLAWD[:4] + ["....#.#..#.#...."]
LOOK_L = CLAWD[:1] + ["..#.######.###.."] + CLAWD[2:]   # eyes one pixel left
LOOK_R = CLAWD[:1] + ["..###.######.#.."] + CLAWD[2:]

ORANGE = (217, 119, 87)
STATE_COLORS = {
    "starting": (150, 144, 134), "idle": ORANGE, "paused": (110, 108, 104), "listening": (255, 140, 96),
    "thinking": (232, 176, 75), "speaking": (159, 209, 127), "using_pc": (90, 176, 255),
    "approval": (255, 196, 0), "error": (255, 90, 90), "background": (185, 163, 255),
}
DATA_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude")
ICO_PATH = os.path.join(DATA_DIR, "yo-claude.ico")


def tray_size():
    try:
        return max(16, ctypes.windll.user32.GetSystemMetrics(49))   # SM_CXSMICON
    except Exception:
        return 32


def draw(size, color, frame=CLAWD, dy=0, background=None, outline=None):
    """The mascot filling a `size` square with whole-pixel cells (crisp, no smoothing). With `outline` (a colour) it
    gets a 1-pixel edge all round, so it shows on light and dark taskbars alike; where that leaves no room for its
    full 16 columns, the arm tips go (14 columns), and it's a little squatter, leaving room to bob."""
    img = Image.new("RGBA", (size, size), background or (0, 0, 0, 0))
    room = size - 2 if outline else size
    if outline and room // len(frame[0]) < room // (len(frame[0]) - 2):
        frame = [row[1:-1] for row in frame]
    cols, rows = len(frame[0]), len(frame)
    cw = max(1, room // cols)
    ch = max(1, min((room - (2 if outline else 0)) // rows, cw * 3))
    ox = (size - cw * cols) // 2
    oy = (size - ch * rows) // 2 + dy
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    for y, row in enumerate(frame):
        for x, c in enumerate(row):
            if c == "#":
                d.rectangle((ox + x * cw, oy + y * ch, ox + (x + 1) * cw - 1, oy + (y + 1) * ch - 1), fill=255)
    if outline:
        img.paste(outline + (255,), mask=mask.filter(ImageFilter.MaxFilter(3)))
    img.paste(color + (255,), mask=mask)
    return img


def tray_frame(state, tick):
    """Tray icon for `state` at animation step `tick` (the app advances it ~5 times a second). Each state keeps
    its own colour; the mascot moves instead: walks while Claude thinks, hops while it waits for you, strolls
    slowly while a background task runs, bobs while listening, looks around while using your PC."""
    size = tray_size()
    color = STATE_COLORS.get(state, ORANGE)
    frame, dy = CLAWD, 0
    up = -max(1, size // 16)
    if state in ("idle", "starting"):   # (redrawn twice every 4 s: a blink, then a glance)
        frame = {0: BLINK, 20: LOOK_L}.get(tick % 40, CLAWD)
    elif state == "listening":
        dy = up if tick % 4 < 2 else 0
    elif state == "thinking":   # walking in place, glancing about, the odd blink
        frame = WALK if tick % 2 else CLAWD
        if tick % 8 in (2, 3):
            frame = [LOOK_L[1] if i == 1 else r for i, r in enumerate(frame)]
        elif tick % 8 in (6, 7):
            frame = [LOOK_R[1] if i == 1 else r for i, r in enumerate(frame)]
        elif tick % 16 == 0:
            frame = BLINK
        dy = up if tick % 4 == 1 else 0
    elif state == "speaking":
        frame = WALK if tick % 2 else CLAWD
        dy = up if tick % 2 else 0
    elif state == "using_pc":
        frame = (LOOK_L, CLAWD, LOOK_R, CLAWD)[tick % 4]
        if tick % 2:
            frame = frame[:4] + [WALK[4]]
    elif state == "approval":   # hop, hop, wait: it needs you
        dy = (0, 2 * up, 2 * up, up, 0, 0, 0, 0)[tick % 8]
    elif state == "background":   # a slow stroll
        frame = WALK if tick % 4 < 2 else CLAWD
    return draw(size, color, frame, dy, outline=(0, 0, 0))


def animated(state):
    return state not in ("idle", "paused", "starting", "error")


def make_ico():
    """Multi-size .ico for the window, taskbar and shortcuts (dark rounded square, orange mascot)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    images = []
    for s in sizes:
        bg = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        r = max(2, s // 6)
        ImageDraw.Draw(bg).rounded_rectangle((0, 0, s - 1, s - 1), radius=r, fill=(20, 20, 19, 255))
        pad = max(1, s // 10)
        m = draw(s - 2 * pad, ORANGE)
        bg.alpha_composite(m, (pad, pad))
        images.append(bg)
    images[-1].save(ICO_PATH, sizes=[(s, s) for s in sizes], append_images=images[:-1])
    return ICO_PATH


def make_shortcuts(app_id, target, arguments, workdir, ico):
    """Desktop and Start-menu shortcuts carrying the app's AppUserModelID, so the running window groups under them on
    the taskbar (and pins as Yo Claude, not Python)."""
    import pythoncom
    from win32com.client import Dispatch
    from win32com.propsys import propsys, pscon
    from win32com.shell import shell, shellcon

    pythoncom.CoInitialize()
    made = []
    for folder in (shellcon.CSIDL_DESKTOPDIRECTORY, shellcon.CSIDL_PROGRAMS):
        path = os.path.join(shell.SHGetFolderPath(0, folder, None, 0), "Yo Claude.lnk")
        link = Dispatch("WScript.Shell").CreateShortcut(path)
        link.TargetPath = target
        link.Arguments = arguments
        link.WorkingDirectory = workdir
        link.IconLocation = ico
        link.Description = "Yo Claude - voice-first Claude assistant"
        link.Save()
        store = propsys.SHGetPropertyStoreFromParsingName(path, None, shellcon.GPS_READWRITE,
                                                          propsys.IID_IPropertyStore)
        store.SetValue(pscon.PKEY_AppUserModel_ID, propsys.PROPVARIANTType(app_id))
        store.Commit()
        made.append(path)
    return made


def promote_tray_icon(settings, tooltip_prefix="Yo Claude"):
    """Windows 11 hides new tray icons behind the ^ arrow. Show this one on the taskbar the first time Windows lists
    it; if you later move it back into the overflow in Settings, that choice is left alone."""
    done = set(settings.get("tray_promoted", []))
    root = r"Control Panel\NotifyIconSettings"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, root) as k:
            names = [winreg.EnumKey(k, i) for i in range(winreg.QueryInfoKey(k)[0])]
        for name in names:
            if name in done:
                continue
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"{root}\{name}", 0,
                                winreg.KEY_READ | winreg.KEY_SET_VALUE) as k:
                try:
                    tip = winreg.QueryValueEx(k, "InitialTooltip")[0]
                except OSError:
                    continue
                if str(tip).startswith(tooltip_prefix):
                    winreg.SetValueEx(k, "IsPromoted", 0, winreg.REG_DWORD, 1)
                    done.add(name)
    except OSError:
        return
    settings["tray_promoted"] = sorted(done)
    settings.save()
