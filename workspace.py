"""The folder side of Yo Claude: file tree, file preview, git branch, and what changed during a session.

"Changes" compare the working tree with a snapshot taken when the session started (or was opened): every file in
the folder, untracked ones too, written as a git tree object through a temporary index, so your real index, HEAD
and files are never touched. Diffs therefore include edits made by shell commands, not just Claude's Edit/Write.
Folders that aren't git repositories fall back to the files Claude's tools touched.
"""

import logging
import os
import time
import re
import shutil
import subprocess
import tempfile

log = logging.getLogger("yo_claude")

HIDDEN = {".git", "node_modules", ".venv", "venv", "__pycache__", ".vs", ".idea", "bin", "obj", ".pytest_cache"}
MAX_PREVIEW = 300_000
MAX_ATTACH_INLINE = 60_000


def git(root, *args, env=None, input=None, check=True):
    p = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", env=env, input=input, creationflags=subprocess.CREATE_NO_WINDOW)
    if check and p.returncode:
        raise RuntimeError((p.stderr or p.stdout).strip() or f"git {args[0]} failed")
    return p.stdout


def is_repo(root):
    try:
        return bool(root) and git(root, "rev-parse", "--is-inside-work-tree").strip() == "true"
    except Exception:
        return False


def repo_root(root):
    return os.path.normpath(git(root, "rev-parse", "--show-toplevel").strip())


# --- files ---------------------------------------------------------------------------------------------------
_deep = {}   # folder -> (when worked out, newest mtime, complete): kept a minute, so refreshes stay quick


def deep_mtime(folder, budget):
    """When anything in `folder` (any depth, clutter folders skipped) last changed: (mtime, complete). Gives up after
    `budget` seconds, keeping the newest seen so far (complete=False)."""
    hit = _deep.get(folder)
    if hit and time.time() - hit[0] < 60:
        return hit[1], hit[2]
    end, newest, stack, complete = time.time() + budget, 0.0, [folder], True
    try:
        newest = os.stat(folder).st_mtime
    except OSError:
        pass
    while stack:
        if time.time() > end:
            complete = False
            break
        try:
            with os.scandir(stack.pop()) as it:
                for k, d in enumerate(it):
                    if k % 256 == 255 and time.time() > end:   # (a folder with a huge number of files)
                        complete = False
                        stack.clear()
                        break
                    try:
                        if d.is_dir(follow_symlinks=False):
                            if d.name not in HIDDEN:
                                stack.append(d.path)
                        else:
                            newest = max(newest, d.stat(follow_symlinks=False).st_mtime)
                    except OSError:
                        continue
        except OSError:
            continue
    _deep[folder] = (time.time(), newest, complete)
    return newest, complete


def drives():
    """This PC: the drives there are, for browsing above a drive's top folder."""
    out = []
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        top = f"{letter}:\\"
        if os.path.exists(top):
            try:
                mtime = os.stat(top).st_mtime
            except OSError:
                mtime = 0
            out.append({"name": f"{letter}:", "path": top, "dir": True, "mtime": mtime, "drive": True})
    return {"entries": out}


def list_dir(root, rel=""):
    """One level of the tree: folders first, gitignored and clutter folders left out. Each entry has its modified
    time; a folder's is that of the newest file anywhere in it (approx when there wasn't time to look at it all)."""
    folder = os.path.join(root, rel)
    try:
        names = os.listdir(folder)
    except OSError as e:
        return {"error": str(e), "entries": []}
    entries = [n for n in names if n not in HIDDEN]
    if entries and is_repo(root):
        paths = [os.path.join(rel, n).replace("\\", "/") for n in entries]
        ignored = set(git(root, "check-ignore", "--stdin", input="\n".join(paths), check=False).split("\n"))
        entries = [n for n, p in zip(entries, paths) if p not in ignored]
    out, end = [], time.time() + 1.2   # (all the folders here get 1.2 s between them)
    for n in entries:
        full = os.path.join(folder, n)
        e = {"name": n, "path": os.path.join(rel, n).replace("\\", "/"), "dir": os.path.isdir(full)}
        try:
            if e["dir"]:
                left = end - time.time()
                e["mtime"], done = deep_mtime(full, min(0.12, left)) if left > 0 else (os.stat(full).st_mtime, False)
                if not done:
                    e["approx"] = True
            else:
                e["mtime"] = os.stat(full).st_mtime
        except OSError:
            e["mtime"] = 0
        out.append(e)
    out.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return {"entries": out}


def all_files(root, limit=5000):
    """Paths for @-autocomplete: git's view (tracked + untracked, not ignored) or a shallow walk."""
    if is_repo(root):
        out = git(root, "ls-files", "--cached", "--others", "--exclude-standard", check=False).splitlines()
        return out[:limit]
    files = []
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in HIDDEN]
        for n in names:
            files.append(os.path.relpath(os.path.join(d, n), root).replace("\\", "/"))
            if len(files) >= limit:
                return files
    return files


TEXT_SKIP = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".pdf", ".zip",
             ".7z", ".gz", ".exe", ".dll", ".pdb", ".bin", ".so", ".woff", ".woff2", ".ttf", ".otf", ".pyc", ".class", ".jar", ".safetensors",
             ".onnx", ".pt", ".ckpt", ".gguf"}


def search_files(root, query, content=False, limit=300):
    """The files tab's search: names containing every word of `query`, then (with `content`) lines containing it, in the
    folder (git's view of it when it's a repo, else a walk that skips the usual junk). {results: [{path, name, mtime,
    line?, text?}], truncated}. Content matches are the phrase as typed, case-insensitive, at most 3 lines per file."""
    q = (query or "").strip().lower()
    if not q:
        return {"results": [], "truncated": False}
    if is_repo(root):
        files = git(root, "ls-files", "--cached", "--others", "--exclude-standard", check=False).splitlines()
    else:
        files = []
        for d, dirs, names in os.walk(root):
            dirs[:] = [x for x in dirs if x not in HIDDEN]
            files += [os.path.relpath(os.path.join(d, n), root).replace("\\", "/") for n in names]
            if len(files) > 100000:
                break
    terms = q.split()
    results, seen = [], set()
    for rel in files:
        low = rel.lower()
        if all(t in os.path.basename(low) or t in low for t in terms):
            results.append({"path": rel, "name": os.path.basename(rel)})
            seen.add(rel)
            if len(results) >= limit:
                break
    truncated = len(results) >= limit
    if content and not truncated:
        deadline = time.time() + 6
        per = {}
        for rel in files:
            if time.time() > deadline or len(results) >= limit:
                truncated = True
                break
            if os.path.splitext(rel)[1].lower() in TEXT_SKIP:
                continue
            full = os.path.join(root, rel)
            try:
                if os.path.getsize(full) > 1_500_000:
                    continue
                with open(full, "r", encoding="utf-8", errors="strict") as f:
                    for n, line in enumerate(f, 1):
                        if q in line.lower():
                            per[rel] = per.get(rel, 0) + 1
                            results.append({"path": rel, "name": os.path.basename(rel), "line": n, "text": line.strip()[:160]})
                            if per[rel] >= 3 or len(results) >= limit:
                                break
            except (OSError, UnicodeDecodeError):
                continue
    for r in results:
        try:
            r["mtime"] = os.path.getmtime(os.path.join(root, r["path"]))
        except OSError:
            r["mtime"] = 0
    return {"results": results, "truncated": truncated}


def safe_path(root, rel):
    full = os.path.normpath(os.path.join(root, rel))
    if os.path.commonpath([os.path.normcase(full), os.path.normcase(os.path.normpath(root))]) != os.path.normcase(
            os.path.normpath(root)):
        raise ValueError("outside the folder")
    return full


def read_file(root, rel, limit=MAX_PREVIEW):
    full = safe_path(root, rel)
    size = os.path.getsize(full)
    with open(full, "rb") as f:
        data = f.read(limit)
    if b"\0" in data[:8000]:
        return {"path": rel, "binary": True, "size": size}
    try:   # only plain UTF-8 can be edited and saved back without changing anything else
        data.decode("utf-8")
        utf8 = True
    except UnicodeDecodeError:
        utf8 = False
    return {"path": rel, "text": data.decode("utf-8", errors="replace").lstrip("﻿"), "size": size,
            "truncated": size > limit, "editable": utf8 and size <= limit, "mtime": os.path.getmtime(full)}


def write_text(full, text, mtime=None):
    """Save an edited text file, keeping its line endings and byte-order mark. Refuses if it changed on disk since
    it was opened (Claude may have edited it meanwhile)."""
    if mtime is not None and abs(os.path.getmtime(full) - mtime) > 0.001:
        return {"error": "This file changed on disk since you opened it, so saving would overwrite those changes. "
                         "Copy your edits, close this, open the file again and paste them back.", "conflict": True}
    with open(full, "rb") as f:
        old = f.read()
    text = text.replace("\r\n", "\n")
    if b"\r\n" in old:
        text = text.replace("\n", "\r\n")
    data = (b"\xef\xbb\xbf" if old.startswith(b"\xef\xbb\xbf") else b"") + text.encode("utf-8")
    tmp = full + ".yoclaude-tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, full)
    return {"mtime": os.path.getmtime(full), "size": len(data)}


def attachment_text(root, rel):
    """How an attached file goes into a prompt: inline when small, otherwise a path for Claude to read."""
    try:
        f = read_file(root, rel, MAX_ATTACH_INLINE)
    except Exception as e:
        return f"(couldn't attach {rel}: {e})"
    if f.get("binary") or f.get("truncated"):
        return f'Attached file (read it as needed): {safe_path(root, rel)}'
    return f'<attached_file path="{rel}">\n{f["text"]}\n</attached_file>'


# --- git -------------------------------------------------------------------------------------------------------
def git_info(root):
    if not is_repo(root):
        return {"repo": False}
    branch = git(root, "branch", "--show-current", check=False).strip()
    head = git(root, "log", "-1", "--format=%h %s", check=False).strip()
    branches = [b.strip() for b in git(root, "branch", "--format=%(refname:short)", check=False).splitlines() if b.strip()]
    status = git(root, "status", "--porcelain", check=False).splitlines()
    tracked_dirty = [l for l in status if not l.startswith("??")]
    upstream = git(root, "rev-list", "--left-right", "--count", "@{upstream}...HEAD", check=False).split()
    return {"repo": True, "branch": branch or "(detached)", "head": head, "branches": branches,
            "dirty": len(tracked_dirty), "untracked": len(status) - len(tracked_dirty),
            "behind": int(upstream[0]) if len(upstream) == 2 else None,
            "ahead": int(upstream[1]) if len(upstream) == 2 else None}


def switch_branch(root, name):
    """Refused while tracked files have uncommitted changes (no auto-stash: your work is never moved behind your
    back). Returns an error message or None."""
    info = git_info(root)
    if not info.get("repo"):
        return "Not a git repository."
    if info["dirty"]:
        return (f"{info['dirty']} tracked file(s) have uncommitted changes. Commit or stash them first, "
                "then switch.")
    try:
        git(root, "switch", name)
    except RuntimeError as e:
        return str(e)
    return None


def create_branch(root, name):
    try:
        git(root, "switch", "-c", name)   # uncommitted changes come along to the new branch
    except RuntimeError as e:
        return str(e)
    return None


# --- session snapshots and changes -----------------------------------------------------------------------------
def snapshot(root):
    """A git tree of the whole working tree right now (tracked + untracked, not ignored), via a temporary index.
    Returns {"tree", "head", "root"} or None for non-repos."""
    if not is_repo(root):
        return None
    top = repo_root(root)
    real_index = git(top, "rev-parse", "--git-path", "index").strip()
    real_index = real_index if os.path.isabs(real_index) else os.path.join(top, real_index)
    fd, tmp = tempfile.mkstemp(prefix="yoclaude-index-")
    os.close(fd)
    try:
        if os.path.exists(real_index):
            shutil.copyfile(real_index, tmp)   # start from the real index so only changed files get re-hashed
        else:
            os.remove(tmp)
        env = dict(os.environ, GIT_INDEX_FILE=tmp)
        git(top, "add", "-A", *scope(root, top), env=env)
        tree = git(top, "write-tree", env=env).strip()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    head = git(top, "rev-parse", "--verify", "-q", "HEAD", check=False).strip()
    return {"tree": tree, "head": head, "root": top}


def scope(root, top):
    """Pathspec limiting git to the chosen folder when it's inside a bigger repo."""
    rel = os.path.relpath(os.path.normpath(root), top)
    return [] if rel in (".", "") else ["--", rel.replace("\\", "/")]


def changes(root, base):
    """Files changed since the snapshot `base`: [{path, status, add, del}] and totals."""
    if not base:
        return {"repo": False, "files": []}
    now = snapshot(root)
    if not now:
        return {"repo": False, "files": []}
    top = base["root"]
    spec = scope(root, top)
    files = {}
    for line in git(top, "diff", "--name-status", "-M", base["tree"], now["tree"], *spec, check=False).splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            st = parts[0][0]
            path = parts[-1]
            files[path] = {"path": path, "status": st, "old": parts[1] if st == "R" else None, "add": 0, "del": 0}
    for line in git(top, "diff", "--numstat", "-M", base["tree"], now["tree"], *spec, check=False).splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            path = parts[2].split(" => ")[-1].strip("{}") if "=>" in parts[2] else parts[2]
            f = files.get(path)
            if f:
                f["add"] = int(parts[0]) if parts[0].isdigit() else 0
                f["del"] = int(parts[1]) if parts[1].isdigit() else 0
    out = sorted(files.values(), key=lambda f: f["path"])
    return {"repo": True, "files": out, "add": sum(f["add"] for f in out), "del": sum(f["del"] for f in out),
            "since_tree": base["tree"], "now_tree": now["tree"], "rel_root": os.path.relpath(root, top)}


def file_diff(root, base, path):
    now = snapshot(root)
    if not base or not now:
        return ""
    return git(base["root"], "diff", "-M", base["tree"], now["tree"], "--", path, check=False)


def revert_file(root, base, path):
    """Put one file back as it was at the snapshot (deletes it if it didn't exist then)."""
    if not base:
        return "No snapshot for this session."
    top = base["root"]
    full = safe_path(top, path)
    existed = subprocess.run(["git", "-C", top, "cat-file", "-e", f"{base['tree']}:{path}"], capture_output=True,
                             creationflags=subprocess.CREATE_NO_WINDOW).returncode == 0
    if existed:
        blob = subprocess.run(["git", "-C", top, "cat-file", "blob", f"{base['tree']}:{path}"], capture_output=True,
                              creationflags=subprocess.CREATE_NO_WINDOW)
        if blob.returncode:
            return blob.stderr.decode(errors="replace")
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(blob.stdout)
    elif os.path.exists(full):
        os.remove(full)
    return None


# --- shell helpers ---------------------------------------------------------------------------------------------
def open_in_editor(root, rel):
    full = safe_path(root, rel) if rel else root
    if not os.path.exists(full):
        raise FileNotFoundError(f"Not found: {full}. It may have been moved, renamed or deleted.")
    code = shutil.which("code")
    if code:
        subprocess.Popen([code, full], creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        os.startfile(full)


def reveal(root, rel):
    full = safe_path(root, rel) if rel else root
    if not os.path.exists(full):
        raise FileNotFoundError(f"Not found: {full}. It may have been moved, renamed or deleted.")
    subprocess.Popen(["explorer", "/select,", full] if rel else ["explorer", full])


# --- file explorer operations ----------------------------------------------------------------------------------
# Every path is relative to the session folder and checked with safe_path. Problems come back as plain-English
# messages: {"error": ...} (plus "paths" for whatever did work when several items were involved).
BAD_NAME_CHARS = set('<>:"/\\|?*')
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def _rel(root, full):
    return os.path.relpath(full, os.path.normpath(root)).replace("\\", "/")


def _check_name(name):
    name = (name or "").strip()
    if not name or name in (".", ".."):
        raise ValueError("Type a name.")
    if "/" in name or "\\" in name:
        raise ValueError(f'"{name}" has a slash in it. Names can\'t contain / or \\.')
    bad = sorted({c for c in name if c in BAD_NAME_CHARS or ord(c) < 32})
    if bad:
        raise ValueError(f'"{name}" contains characters Windows doesn\'t allow in names: {" ".join(bad)}')
    if name.endswith("."):
        raise ValueError(f'"{name}" ends with a dot, which Windows doesn\'t allow.')
    if name.split(".")[0].upper() in RESERVED_NAMES:
        raise ValueError(f'"{name}" is a name Windows reserves for devices. Pick another.')
    return name


def _safe(root, rel):
    try:
        return safe_path(root, rel)
    except ValueError:
        raise ValueError(f"{rel} is outside the session folder, so Yo Claude won't touch it.") from None


def _item(root, rel, what="item"):
    """Full path of an existing item inside the folder (never the folder itself)."""
    full = _safe(root, rel or "")
    if not rel or os.path.normcase(full) == os.path.normcase(os.path.normpath(root)):
        raise ValueError(f"The session folder itself can't be used as the {what}.")
    if not os.path.lexists(full):
        raise FileNotFoundError(f"{rel} isn't there any more. It may have been moved, renamed or deleted.")
    return full


def _folder(root, rel):
    full = _safe(root, rel or "")
    if not os.path.isdir(full):
        raise NotADirectoryError(f"{rel or 'The session folder'} isn't a folder (any more).")
    return full


def _new_item(root, folder_rel, name, make):
    name = _check_name(name)
    full = os.path.join(_folder(root, folder_rel), name)
    _safe(root, _rel(root, full))
    if os.path.lexists(full):
        return {"error": f'"{name}" already exists there.'}
    make(full)
    return {"path": _rel(root, full)}


def _make_empty_file(full):
    with open(full, "x", encoding="utf-8"):
        pass


def create_file(root, folder_rel, name):
    return _new_item(root, folder_rel, name, _make_empty_file)


def create_folder(root, folder_rel, name):
    return _new_item(root, folder_rel, name, os.mkdir)


def rename_path(root, rel, new_name):
    full = _item(root, rel)
    new_name = _check_name(new_name)
    dest = os.path.join(os.path.dirname(full), new_name)
    if dest == full:
        return {"path": rel}
    # a change of letter case only is fine; anything else that exists is a clash
    if os.path.lexists(dest) and os.path.normcase(dest) != os.path.normcase(full):
        return {"error": f'"{new_name}" already exists there.'}
    os.rename(full, dest)
    return {"path": _rel(root, dest)}


def _copy_name(folder, name):
    """name -> "name (copy).ext", "name (copy 2).ext", ... whichever is free in folder."""
    full = os.path.join(folder, name)
    if not os.path.lexists(full):
        return full
    stem, ext = (name, "") if os.path.isdir(full) else os.path.splitext(name)
    stem = re.sub(r" \(copy(?: \d+)?\)$", "", stem)
    n = 1
    while True:
        cand = os.path.join(folder, f"{stem} (copy{'' if n == 1 else f' {n}'}){ext}")
        if not os.path.lexists(cand):
            return cand
        n += 1


def _inside(child, parent):
    c, p = os.path.normcase(os.path.normpath(child)), os.path.normcase(os.path.normpath(parent))
    return c == p or c.startswith(p.rstrip("\\/") + os.sep)


def _transfer(root, rels, dest_rel, move):
    dest = _folder(root, dest_rel) if dest_rel is not None else None
    done, errors = [], []
    for rel in rels or []:
        try:
            src = _item(root, rel)
            target_dir = dest if dest is not None else os.path.dirname(src)
            if os.path.isdir(src) and _inside(target_dir, src):
                raise ValueError(f"Can't put {rel} inside itself.")
            if move and os.path.normcase(os.path.dirname(src)) == os.path.normcase(os.path.normpath(target_dir)):
                done.append(rel)   # cut and pasted back where it was: nothing to do
                continue
            out = _copy_name(target_dir, os.path.basename(src))
            _safe(root, _rel(root, out))
            if move:
                shutil.move(src, out)
            elif os.path.isdir(src) and not os.path.islink(src):
                shutil.copytree(src, out, symlinks=True)
            else:
                shutil.copy2(src, out, follow_symlinks=False)
            done.append(_rel(root, out))
        except Exception as e:
            msg = str(e)
            errors.append(msg if rel and rel in msg else f"{rel}: {msg}")
    out = {"paths": done}
    if errors:
        verb = "move" if move else "copy"
        out["error"] = f"Couldn't {verb} " + ("this: " if len(errors) == 1 else f"{len(errors)} items: ") + "; ".join(errors)
    return out


def copy_paths(root, rels, dest_rel=""):
    """Copy files and whole folders into dest_rel; clashes get " (copy)" names."""
    return _transfer(root, rels, dest_rel or "", move=False)


def move_paths(root, rels, dest_rel=""):
    """Move (cut + paste, or drag) into dest_rel; clashes get " (copy)" names rather than overwriting anything."""
    return _transfer(root, rels, dest_rel or "", move=True)


def duplicate_paths(root, rels):
    """A copy of each item next to itself."""
    return _transfer(root, rels, None, move=False)


def delete_paths(root, rels):
    """Send items to the Windows Recycle Bin. Never a silent permanent delete: network drives are refused, and if
    Windows can't recycle something (too big, no bin on that drive) it asks first. Returns {"paths": deleted} and
    "error" for anything left behind."""
    import ctypes
    from ctypes import wintypes
    fulls, errors = [], []
    for rel in rels or []:
        try:
            full = _item(root, rel, "thing to delete")
            drive = os.path.splitdrive(full)[0]
            if full.startswith("\\\\") or ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") == 4:   # DRIVE_REMOTE
                raise ValueError(f"{rel} is on a network drive, which has no Recycle Bin. Delete it in Explorer.")
            fulls.append((rel, full))
        except Exception as e:
            errors.append(str(e))
    if fulls:
        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                        ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL),
                        ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]
        FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_WANTNUKEWARNING = \
            3, 0x4, 0x10, 0x40, 0x400, 0x4000
        op = SHFILEOPSTRUCTW(wFunc=FO_DELETE, pFrom="\0".join(f for _, f in fulls) + "\0\0",
                             fFlags=FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING)
        rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        if rc and not op.fAnyOperationsAborted:
            errors.append(f"Windows couldn't move them to the Recycle Bin (error {rc:#x}). "
                          "A file may be open in another program.")
    gone = [rel for rel, full in fulls if not os.path.lexists(full)]
    left = [rel for rel, full in fulls if os.path.lexists(full)]
    if left:
        errors.append("Not deleted: " + ", ".join(left) + "." +
                      ("" if errors else " You may have cancelled, or a file is open in another program."))
    out = {"paths": gone}
    if errors:
        out["error"] = " ".join(errors)
    return out
