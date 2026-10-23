"""The folder side of Yo Claude: file tree, file preview, git branch, and what changed during a session.

"Changes" compare the working tree with a snapshot taken when the session started (or was opened): every file in
the folder, untracked ones too, written as a git tree object through a temporary index, so your real index, HEAD
and files are never touched. Diffs therefore include edits made by shell commands, not just Claude's Edit/Write.
Folders that aren't git repositories fall back to the files Claude's tools touched.
"""

import logging
import os
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
def list_dir(root, rel=""):
    """One level of the tree: folders first, gitignored and clutter folders left out."""
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
    out = []
    for n in entries:
        full = os.path.join(folder, n)
        out.append({"name": n, "path": os.path.join(rel, n).replace("\\", "/"), "dir": os.path.isdir(full)})
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
    return {"path": rel, "text": data.decode("utf-8", errors="replace"), "size": size, "truncated": size > limit}


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
    code = shutil.which("code")
    if code:
        subprocess.Popen([code, full], creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        os.startfile(full)


def reveal(root, rel):
    full = safe_path(root, rel) if rel else root
    subprocess.Popen(["explorer", "/select,", full] if rel else ["explorer", full])
