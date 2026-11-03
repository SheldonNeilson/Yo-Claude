"""Terminals for the pane between the chat and the message box: real shells on a Windows pseudo-console (pywinpty), shown by
xterm.js (ui/terminal.js). Output goes to the window as "term_out" events; keys come back through Api.term_write.
A terminal keeps its last bit of output, so a reloaded window gets its screen back."""

import logging
import base64
import os
import shutil
import subprocess
import threading

log = logging.getLogger("yoclaude.terminal")
KEEP = 400_000          # characters of scrollback kept per terminal, for a reloaded window
MAX_TERMS = 8

try:
    from winpty import PtyProcess
except Exception as _e:   # not installed: the pane says so and the external terminal still works
    PtyProcess = None
    log.warning("pywinpty missing: %s", _e)


# The terminal pane's PowerShell, set up after your profile: grey suggestions from your history as you type, Tab takes the
# suggestion (or, with none showing, completes the name as usual), and a program in the current folder runs by its name
# alone ("app.exe" or "app", as in cmd: PowerShell normally wants ".\app.exe").
PS_SETUP = r"""
try {
  Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView -ErrorAction Stop
  Set-PSReadLineKeyHandler -Key Tab -BriefDescription SuggestionOrComplete -ScriptBlock {
    $before = $null; $at = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$before, [ref]$at)
    if ($at -eq $before.Length) { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptSuggestion() }
    $after = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$after, [ref]$at)
    if ($after -eq $before) { [Microsoft.PowerShell.PSConsoleReadLine]::TabCompleteNext() }
  }
} catch {}
$ExecutionContext.InvokeCommand.CommandNotFoundAction = {
  param($name, $e)
  foreach ($c in @($name, "$name.exe")) {
    $p = Join-Path (Get-Location) $c
    if (Test-Path -LiteralPath $p -PathType Leaf) {
      $e.Command = $ExecutionContext.InvokeCommand.GetCommand($p, "Application"); $e.StopSearch = $true; break
    }
  }
}
"""


def shell_argv(choice="", pane=False):
    """PowerShell 7 if it's there, else Windows PowerShell, else cmd. `choice` (a setting) can name another shell.
    pane: the terminal pane's shell (PS_SETUP runs in it)."""
    for name in ([choice] if choice else []) + ["pwsh", "powershell", "cmd"]:
        exe = shutil.which(name)
        if exe:
            low = os.path.basename(exe).lower()
            if not low.startswith(("pwsh", "powershell")):
                return [exe]
            if not pane:
                return [exe, "-NoLogo"]
            code = base64.b64encode(PS_SETUP.encode("utf-16-le")).decode()
            return [exe, "-NoLogo", "-NoExit", "-EncodedCommand", code]
    return ["cmd.exe"]


def quote(path, ps=True):
    """A path as one argument: PowerShell (single quotes, a quote inside is doubled) or cmd (double quotes)."""
    return "'" + str(path).replace("'", "''") + "'" if ps else '"' + str(path) + '"'


# what "run in terminal" types for a file, by extension ({} is the quoted path)
RUNNERS = {".py": "python {}", ".pyw": "python {}", ".js": "node {}", ".mjs": "node {}", ".ts": "npx tsx {}", ".ps1": "& {}",
           ".bat": "& {}", ".cmd": "& {}", ".exe": "& {}", ".sh": "bash {}", ".sql": None}


class Term:
    def __init__(self, tid, title, cwd, proc):
        self.id, self.title, self.cwd, self.proc = tid, title, cwd, proc
        self.buf, self.alive, self.code = "", True, None
        self.ps = os.path.basename(str(getattr(proc, "argv", [""])[0] if hasattr(proc, "argv") else "")).lower().startswith(("pwsh", "powershell"))

    def info(self):
        return {"id": self.id, "title": self.title, "cwd": self.cwd, "alive": self.alive}


class Terminals:
    def __init__(self, emit, settings):
        self.emit, self.settings = emit, settings   # emit(kind, data): the app's event bus
        self.terms = {}
        self.n = 0
        self.lock = threading.Lock()

    def available(self):
        return PtyProcess is not None

    def open(self, cwd, title=None, cols=100, rows=14, run=None):
        """A new shell in `cwd`; `run` is typed (and entered) once it's up. Returns the terminal's info or {"error"}."""
        if PtyProcess is None:
            return {"error": "The terminal needs pywinpty, which isn't installed. Run Install Yo Claude again (or pip install pywinpty)."}
        if not cwd or not os.path.isdir(cwd):
            return {"error": f"Not a folder: {cwd}"}
        with self.lock:
            if len([t for t in self.terms.values() if t.alive]) >= MAX_TERMS:
                return {"error": f"That's {MAX_TERMS} terminals already. Close one first."}
            self.n += 1
            tid = f"t{self.n}"
        try:
            proc = PtyProcess.spawn(shell_argv(self.settings.get("terminal_shell", ""), pane=True), cwd=cwd, dimensions=(rows, cols))
        except Exception as e:
            log.warning("terminal spawn failed: %s", e)
            return {"error": f"Couldn't start a shell: {e}"}
        t = Term(tid, title or os.path.basename(cwd.rstrip("\\/")) or cwd, cwd, proc)
        self.terms[tid] = t
        threading.Thread(target=self._read, args=(t,), daemon=True).start()
        if run:
            self.write(tid, run + "\r")
        return t.info()

    def _read(self, t):
        try:
            while True:
                data = t.proc.read(65536)
                if not data:
                    if not t.proc.isalive():
                        break
                    continue
                t.buf = (t.buf + data)[-KEEP:]
                self.emit("term_out", {"id": t.id, "data": data})
        except EOFError:
            pass
        except Exception as e:
            log.debug("terminal read ended: %s", e)
        t.alive = False
        try:
            t.code = t.proc.exitstatus
        except Exception:
            pass
        self.emit("term_exit", {"id": t.id, "code": t.code})

    def write(self, tid, data):
        t = self.terms.get(tid)
        if t and t.alive and data:
            try:
                t.proc.write(data)
            except Exception as e:
                log.debug("terminal write failed: %s", e)

    def cd(self, tid, folder):
        t = self.terms.get(tid)
        if t and t.alive:
            self.write(tid, (f"Set-Location -LiteralPath {quote(folder)}" if t.ps else f'cd /d {quote(folder, False)}') + chr(13))
            t.cwd = folder
        return bool(t and t.alive)

    def type_path(self, tid, path):
        """Types the path at the prompt (quoted if it needs it), without pressing Enter."""
        t = self.terms.get(tid)
        if t and t.alive:
            self.write(tid, quote(path, t.ps) if " " in path or "'" in path else path)
        return bool(t and t.alive)

    def run_file(self, tid, full):
        """Runs a script or program in its own folder in terminal `tid`. Returns a message if it doesn't know how."""
        ext = os.path.splitext(full)[1].lower()
        cmd = RUNNERS.get(ext)
        t = self.terms.get(tid)
        if not t or not t.alive:
            return "That terminal has closed."
        if not cmd:
            return f"Yo Claude doesn't know how to run {ext or 'that kind of'} files. Paste the path into a terminal and type the command yourself."
        self.cd(tid, os.path.dirname(full))
        self.write(tid, cmd.replace("{}", quote(full, t.ps)) + chr(13))
        return None

    def resize(self, tid, rows, cols):
        t = self.terms.get(tid)
        if t and t.alive and rows > 0 and cols > 0:
            try:
                t.proc.setwinsize(int(rows), int(cols))
            except Exception as e:
                log.debug("terminal resize failed: %s", e)

    def close(self, tid):
        t = self.terms.pop(tid, None)
        if t:
            t.alive = False
            try:
                t.proc.terminate(force=True)
            except Exception:
                pass

    def list(self):
        return [{**t.info(), "buf": t.buf} for t in self.terms.values()]

    def close_all(self):
        for tid in list(self.terms):
            self.close(tid)


def open_external(folder):
    """The folder in a separate terminal window: Windows Terminal if it's installed, else a PowerShell window."""
    wt = shutil.which("wt")
    if wt:
        subprocess.Popen([wt, "-d", folder])
    else:
        subprocess.Popen(shell_argv(), cwd=folder, creationflags=subprocess.CREATE_NEW_CONSOLE)
