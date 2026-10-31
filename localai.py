"""Local models for AutoCorrect and typing predictions: an alternative to Haiku that never leaves the PC.

A model is a dict {id, label, backend, model, url, size}: backend "ollama" (Ollama's own server, which this starts when
it isn't running) or "openai" (anything speaking the OpenAI chat API: LM Studio, llama.cpp's server, vLLM...). The
ones to download are SUGGESTED (the first, DEFAULT, is what the window offers); the ones you add are in the
`local_models` setting; and whatever Ollama already has installed shows up by itself. Settings `fix_model` and
`predict_model` hold "haiku" (the default) or a model id."""
import json
import logging
import os
import shutil
import subprocess
import time

import requests

log = logging.getLogger("yoclaude")

OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT = {"id": "qwen2.5-1.5b", "label": "Qwen 2.5 · 1.5B (small and quick)", "backend": "ollama", "model": "qwen2.5:1.5b",
           "size": "about 1 GB"}
SUGGESTED = [
    DEFAULT,
    {"id": "qwen2.5-3b", "label": "Qwen 2.5 · 3B (better, a little slower)", "backend": "ollama", "model": "qwen2.5:3b", "size": "about 2 GB"},
    {"id": "gemma3-1b", "label": "Gemma 3 · 1B (tiny)", "backend": "ollama", "model": "gemma3:1b", "size": "about 0.8 GB"},
]
NO_WINDOW = 0x08000000
DETACHED = 0x00000008


def _norm(name):
    name = (name or "").strip()
    return name if ":" in name else name + ":latest"


def ollama_exe():
    exe = shutil.which("ollama")
    if exe:
        return exe
    for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles")):
        p = os.path.join(base or "", "Programs", "Ollama", "ollama.exe") if base else ""
        if p and os.path.exists(p):
            return p
    return None


def up(url=OLLAMA_URL):
    try:
        return requests.get(url + "/api/tags", timeout=1.2).ok
    except Exception:
        return False


def ensure_ollama(url=OLLAMA_URL, wait=20):
    """True once Ollama's server answers (starting it, hidden, if it's installed but not running)."""
    if up(url):
        return True
    exe = ollama_exe()
    if not exe or url != OLLAMA_URL:
        return False
    try:
        subprocess.Popen([exe, "serve"], creationflags=DETACHED | NO_WINDOW, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        log.info("Couldn't start Ollama: %s", e)
        return False
    end = time.time() + wait
    while time.time() < end:
        if up(url):
            return True
        time.sleep(0.5)
    return False


def installed(url=OLLAMA_URL):
    """{normalised model name: size in bytes} of what Ollama has downloaded ({} if it isn't running)."""
    try:
        r = requests.get(url + "/api/tags", timeout=2)
        return {_norm(m["name"]): m.get("size", 0) for m in r.json().get("models", [])}
    except Exception:
        return {}


def catalogue(settings):
    """Every model the window can offer: the suggested ones, the user's own, and anything else Ollama has."""
    have = installed()
    out = [dict(m, builtin=True) for m in SUGGESTED]
    out += [dict(m) for m in settings.get("local_models", []) or []]
    known = {_norm(m["model"]) for m in out if m["backend"] == "ollama"}
    for name, size in have.items():
        if name not in known:
            out.append({"id": "ollama:" + name, "label": name.replace(":latest", ""), "backend": "ollama", "model": name,
                        "size": f"{size / 1e9:.1f} GB", "found": True})
    for m in out:
        if m["backend"] == "ollama":
            m["installed"] = _norm(m["model"]) in have
            m["huge"] = have.get(_norm(m["model"]), 0) > 8e9   # (too slow to type with: the window warns)
        else:
            m["installed"] = True   # (a server of the user's own: assumed to be there)
    return out


def find(settings, key):
    """The model chosen in setting `key` (fix_model / predict_model), or None for Haiku."""
    mid = settings.get(key) or "haiku"
    if mid == "haiku":
        return None
    for m in catalogue(settings):
        if m["id"] == mid:
            return m
    return None


def pull(model, progress):
    """Download an Ollama model; progress(percent, status) as it goes. None when done, else a message."""
    if not ollama_exe() and not up():
        return "Ollama isn't installed. Get it from ollama.com (a free, small installer), then try again."
    if not ensure_ollama():
        return "Couldn't start Ollama."
    try:
        with requests.post(OLLAMA_URL + "/api/pull", json={"model": model, "stream": True}, stream=True, timeout=(5, 120)) as r:
            if not r.ok:
                return f"Ollama said no ({r.status_code}): {r.text[:160]}"
            for line in r.iter_lines():
                if not line:
                    continue
                d = json.loads(line)
                if d.get("error"):
                    return d["error"]
                total, done = d.get("total"), d.get("completed")
                progress(int(100 * done / total) if total and done is not None else None, d.get("status", ""))
    except Exception as e:
        return f"Download stopped: {e}"
    return None


def delete(model):
    try:
        r = requests.delete(OLLAMA_URL + "/api/delete", json={"model": model}, timeout=10)
        return None if r.ok else r.text[:160]
    except Exception as e:
        return str(e)


def generate(m, system, prompt, max_tokens=64, timeout=6):
    """One short answer from the local model (temperature 0). Raises on failure."""
    if m["backend"] == "ollama":
        url = m.get("url") or OLLAMA_URL
        if not up(url) and not ensure_ollama(url):
            raise RuntimeError("Ollama isn't running")
        r = requests.post(url + "/api/chat", timeout=timeout, json={
            "model": m["model"], "stream": False, "keep_alive": "20m", "think": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "options": {"temperature": 0, "num_predict": max_tokens}})
        r.raise_for_status()
        return r.json().get("message", {}).get("content", "")
    url = (m.get("url") or "").rstrip("/")
    r = requests.post(url + "/chat/completions", timeout=timeout, json={
        "model": m["model"], "temperature": 0, "max_tokens": max_tokens, "stream": False,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def warm(m):
    """Load the model into memory ahead of the first keystroke."""
    try:
        generate(m, "Reply OK.", "OK?", max_tokens=2, timeout=60)
    except Exception as e:
        log.info("Couldn't warm %s: %s", m.get("model"), e)
