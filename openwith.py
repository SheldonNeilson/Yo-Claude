"""Windows' "Open with" for a file: the apps registered for its type (default first), launched the way Explorer does
(by ProgID, so Store apps work too)."""

import ctypes
import os
import winreg
from ctypes import wintypes

ASSOCSTR_FRIENDLYAPPNAME = 4
ASSOCF_NOTRUNCATE = 0x20
SEE_MASK_CLASSNAME = 0x1
SEE_MASK_NOASYNC = 0x100


class SHELLEXECUTEINFOW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("fMask", ctypes.c_ulong), ("hwnd", wintypes.HWND),
                ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
                ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
                ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR), ("hkeyClass", wintypes.HKEY),
                ("dwHotKey", wintypes.DWORD), ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE)]


def friendly_name(assoc):
    size = wintypes.DWORD(512)
    buf = ctypes.create_unicode_buffer(size.value)
    hr = ctypes.windll.shlwapi.AssocQueryStringW(ASSOCF_NOTRUNCATE, ASSOCSTR_FRIENDLYAPPNAME, assoc, "open", buf,
                                                 ctypes.byref(size))
    return buf.value if hr == 0 and buf.value else None


def _values(root, path):
    try:
        with winreg.OpenKey(root, path) as k:
            return [winreg.EnumValue(k, i) for i in range(winreg.QueryInfoKey(k)[1])]
    except OSError:
        return []


def _subkeys(root, path):
    try:
        with winreg.OpenKey(root, path) as k:
            return [winreg.EnumKey(k, i) for i in range(winreg.QueryInfoKey(k)[0])]
    except OSError:
        return []


def handlers(path, limit=12):
    """[{id, name, default}] for the file's type: the default app, then the other registered ones."""
    ext = os.path.splitext(path)[1].lower()
    if not ext:
        return []
    ids = []
    user = rf"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}"
    choice = dict((n, v) for n, v, _ in _values(winreg.HKEY_CURRENT_USER, user + r"\UserChoice")).get("ProgId")
    if choice:
        ids.append(choice)
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, ext) as k:
            default = winreg.QueryValueEx(k, "")[0]
            if default:
                ids.append(default)
    except OSError:
        pass
    ids += [n for n, _, _ in _values(winreg.HKEY_CURRENT_USER, user + r"\OpenWithProgids")]
    ids += [n for n, _, _ in _values(winreg.HKEY_CLASSES_ROOT, ext + r"\OpenWithProgids")]
    mru = dict((n, v) for n, v, _ in _values(winreg.HKEY_CURRENT_USER, user + r"\OpenWithList"))
    ids += ["Applications\\" + mru[c] for c in mru.get("MRUList", "") if c in mru]
    ids += ["Applications\\" + exe for exe in _subkeys(winreg.HKEY_CLASSES_ROOT, ext + r"\OpenWithList")]
    out, names = [], set()
    for i, pid in enumerate(dict.fromkeys(i for i in ids if i)):
        name = friendly_name(pid)
        if not name or name.lower() in names or name == "Pick an application":   # we offer "Choose another app…"
            continue
        names.add(name.lower())
        out.append({"id": pid, "name": name, "default": not out})
        if len(out) >= limit:
            break
    return out


def launch(path, handler_id):
    """Open `path` with the app registered under `handler_id` (a ProgID or Applications\\x.exe)."""
    info = SHELLEXECUTEINFOW(cbSize=ctypes.sizeof(SHELLEXECUTEINFOW), fMask=SEE_MASK_CLASSNAME | SEE_MASK_NOASYNC,
                             lpVerb="open", lpFile=path, nShow=1, lpClass=handler_id)
    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info)):
        os.startfile(path)   # fall back to the default app
