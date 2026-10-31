"""What Yo Claude has learned about how you write, for typing predictions: the messages you've sent (kept on this PC only, in
~/.yoclaude/writing.jsonl), and a picture of the conversation you're in. A prediction is far better when the model sees your own
earlier messages from this project as examples and knows what the session is about, whichever model makes it."""

import glob
import json
import logging
import os
import re
import threading
import time

log = logging.getLogger("yoclaude.writing")
PATH = os.path.join(os.path.expanduser("~"), ".yoclaude", "writing.jsonl")
PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
KEEP = 4000          # messages remembered
MAX_LEN = 500        # longer messages are pasted logs and specs, not how you write
STOP = set("the and for you that this with have are was but not can all from your will just they what when there their about "
           "would could should into then them been were than also some more very".split())


def words(text):
    return [w for w in re.findall(r"[a-z0-9_.\-/\\]{3,}", (text or "").lower()) if w not in STOP]


class Writing:
    def __init__(self):
        self.items = []             # [{"t": text, "cwd": folder or "", "ts": seconds}]
        self.seen = set()
        self.lock = threading.Lock()
        self.boot = set()           # folders whose old sessions have been read
        try:
            with open(PATH, encoding="utf-8") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if d.get("t") and d["t"] not in self.seen:
                        self.items.append(d)
                        self.seen.add(d["t"])
        except OSError:
            pass

    @staticmethod
    def clean(text):
        text = re.sub(r"^\[voice\]\s*", "", (text or "").strip())
        text = " ".join(text.split())
        if not text or len(text) > MAX_LEN or text.startswith(("[Yo Claude]", "<", "/")) or len(words(text)) < 2:
            return ""
        return text

    def add(self, text, cwd, ts=None, save=True):
        text = self.clean(text)
        if not text:
            return
        with self.lock:
            if text in self.seen:
                return
            self.seen.add(text)
            d = {"t": text, "cwd": cwd or "", "ts": ts or time.time()}
            self.items.append(d)
            if len(self.items) > KEEP:
                self.items = self.items[-KEEP:]
            if save:
                try:
                    os.makedirs(os.path.dirname(PATH), exist_ok=True)
                    with open(PATH, "a", encoding="utf-8") as f:
                        f.write(json.dumps(d, ensure_ascii=False) + "\n")
                except OSError as e:
                    log.debug("writing memory not saved: %s", e)

    def bootstrap(self, cwd, project_key):
        """Once per folder: what you wrote in its last sessions (Claude Code keeps them), so predictions know you from day one."""
        if cwd in self.boot:
            return
        self.boot.add(cwd)
        folder = os.path.join(PROJECTS_DIR, project_key)
        files = sorted(glob.glob(os.path.join(folder, "*.jsonl")), key=os.path.getmtime, reverse=True)[:25]
        n = 0
        for path in reversed(files):
            try:
                with open(path, encoding="utf-8") as f:
                    for raw in f:
                        if '"type":"user"' not in raw.replace(" ", ""):
                            continue
                        try:
                            d = json.loads(raw)
                        except ValueError:
                            continue
                        c = (d.get("message") or {}).get("content")
                        if isinstance(c, str) and not d.get("isMeta"):
                            before = len(self.items)
                            self.add(c, cwd, os.path.getmtime(path), save=False)
                            n += len(self.items) - before
            except OSError:
                continue
        if n:
            try:
                with open(PATH, "w", encoding="utf-8") as f:   # (rewritten whole: the new ones were added unsaved)
                    for d in self.items:
                        f.write(json.dumps(d, ensure_ascii=False) + "\n")
            except OSError:
                pass
            log.info("Learned %d earlier messages of yours from %s", n, os.path.basename(cwd or "chats"))

    def examples(self, typed, cwd, k=6):
        """Messages you wrote before that fit what you're typing now (shared words, the same project, recent first)."""
        tw = set(words(typed))
        scored = []
        now = time.time()
        for d in self.items:
            w = set(words(d["t"]))
            score = 2.0 * len(tw & w) + (1.5 if d.get("cwd") == (cwd or "") else 0) + max(0, 1 - (now - d["ts"]) / (60 * 86400))
            scored.append((score, d["t"]))
        scored.sort(key=lambda x: -x[0])
        out, used = [], set()
        for _, t in scored:
            if t not in used and not t.lower().startswith(typed.strip().lower()[:30] or "\0"):
                out.append(t)
                used.add(t)
            if len(out) >= k:
                break
        return out

    def forget(self):
        with self.lock:
            self.items, self.seen = [], set()
            try:
                os.remove(PATH)
            except OSError:
                pass

    def count(self):
        return len(self.items)
