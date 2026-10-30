"""Claude sessions for Yo Claude, on the Claude Agent SDK.

A session is either a **chat** (no folder: web tools only, cheap) or **code** (a folder: Claude Code's full toolset,
your user + project settings minus hooks). The router runs every session on one asyncio loop in its own thread,
keeps a live connection per open session so follow-ups skip the CLI start-up, turns SDK messages into transcript
items for the UI, and routes tool approvals to the UI and to voice.
"""

import asyncio
import base64
import ctypes
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import warnings

import anyio
import claude_agent_sdk as sdk
from claude_agent_sdk._internal import sessions as sdk_sessions

import workspace

log = logging.getLogger("yo_claude")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude")
PC_CONTROL_DATA = os.path.join(DATA_DIR, "pc-control")   # its log, saved macros and kill-switch file
CHAT_DIR = os.path.join(DATA_DIR, "home")       # cwd for chats: outside any project, so nothing project-level loads
TRASH_DIR = os.path.join(DATA_DIR, "trash")
TASKS_KEEP_S = 12 * 3600        # finished tasks stay in the tasks panel this long
TASKS_SHOWN = 40
TASK_TAIL_BYTES = 64 * 1024     # how much of a background command's output the panel shows
AGENT_QUIET_S = 120             # a subagent whose transcript hasn't changed for this long has probably stopped
META_PATH = os.path.join(DATA_DIR, "sessions.json")
PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
PC_CONTROL_SERVER = "screen-control"
WEB_TOOLS = ["WebSearch", "WebFetch"]
FILE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"]
CHAT_MODEL = "sonnet"
MAX_LIVE = 6              # connected sessions kept warm (several folders can be working at once)
ATTACH_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude", "attachments")   # pasted images, kept viewable
RESULT_PREVIEW = 4000     # characters of a tool result kept for the transcript
QUIET_DAYS = 7            # clean-up never suggests anything touched more recently
STALE_DAYS = 30           # ...and suggests anything untouched for this long
EMPTY_BYTES = 3_000       # session files this small have no real conversation in them
SMALL_BYTES = 20_000      # "short" conversations: suggested once they're QUIET_DAYS old

VOICE_NOTE = (
    " Messages that start with [voice] were spoken and transcribed by speech recognition, so they may contain "
    "mistakes; interpret them sensibly. Your reply to a [voice] message is read aloud: start it with one or two plain "
    "conversational sentences (no markdown, lists, code or URLs) that give the answer or say what you did."
)
CHAT_PROMPT = (
    "You are Claude inside Yo Claude, a voice and text assistant on the user's Windows PC. Keep spoken answers short, "
    "one to three sentences, unless the user asks for detail." + VOICE_NOTE
)
CODE_PROMPT = (
    "You are running inside Yo Claude, a voice-first coding assistant app on the user's Windows PC. For [voice] "
    "messages, put code, lists and detail after the spoken opening; the app shows them on screen." + VOICE_NOTE
)
PC_CONTROL_PROMPT = (
    " You can see and control the user's screen, keyboard and mouse with the screen-control tools; use them when the "
    "user asks you to do something on their PC, then say briefly what you did. Before anything hard to undo "
    "(deleting, sending, posting, buying, submitting), ask the user to confirm and wait for their reply."
)

# claude.exe is a console program: under pythonw each start would flash a console window.
_open_process = anyio.open_process


async def _open_process_no_window(*args, **kwargs):
    kwargs.setdefault("creationflags", subprocess.CREATE_NO_WINDOW)
    return await _open_process(*args, **kwargs)


anyio.open_process = _open_process_no_window


class _SubprocessNoWindow:
    """The SDK's session listing runs `git worktree list` per folder; without this each one flashes a console."""

    def __getattr__(self, name):
        return getattr(subprocess, name)

    @staticmethod
    def run(*args, **kwargs):
        kwargs.setdefault("creationflags", subprocess.CREATE_NO_WINDOW)
        return subprocess.run(*args, **kwargs)


sdk_sessions.subprocess = _SubprocessNoWindow()
# Chats pre-approve the web tools on purpose; the SDK warns that those then skip can_use_tool.
warnings.filterwarnings("ignore", category=sdk.CanUseToolShadowedWarning)


# --- metadata the SDK doesn't keep: groups, pins, where a session came from -----------------------------------
class Meta:
    def __init__(self):
        self.data = {"sessions": {}, "groups": [], "recent_folders": []}
        try:
            with open(META_PATH, encoding="utf-8") as f:
                self.data.update(json.load(f))
        except (OSError, ValueError):
            pass
        self.data.setdefault("workspaces", list(self.data["recent_folders"]))   # folders in the sidebar tree
        self.lock = threading.Lock()

    def save(self):
        with self.lock:
            tmp = META_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=1)
            os.replace(tmp, META_PATH)

    def session(self, sid):
        return self.data["sessions"].setdefault(sid, {})

    def update(self, sid, **fields):
        self.session(sid).update(fields)
        if "group" in fields and fields["group"] and fields["group"] not in self.data["groups"]:
            self.data["groups"].append(fields["group"])
        self.save()

    def add_folder(self, folder):
        folders = [f for f in self.data["recent_folders"] if os.path.normcase(f) != os.path.normcase(folder)]
        self.data["recent_folders"] = [folder] + folders[:11]
        self.save()

    def set_workspace(self, folder, present):
        ws = [f for f in self.data["workspaces"] if not same_folder(f, folder)]
        self.data["workspaces"] = ws + [folder] if present else ws
        self.save()


# --- transcript items -------------------------------------------------------------------------------------------
def result_text(content):
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
    else:
        text = "" if content is None else str(content)
    return text if len(text) <= RESULT_PREVIEW else text[:RESULT_PREVIEW] + f"\n… ({len(text) - RESULT_PREVIEW} more)"


def block_get(b, key, default=None):
    return b.get(key, default) if isinstance(b, dict) else getattr(b, key, default)


def result_images(content):
    """(media_type, base64) of the images in a tool result (screen-control screenshots, Read of an image)."""
    out = []
    for b in content if isinstance(content, list) else []:
        if block_get(b, "type") == "image":
            src = block_get(b, "source") or {}
            if block_get(src, "type") == "base64" and block_get(src, "data"):
                out.append((block_get(src, "media_type", "image/png"), block_get(src, "data")))
    return out


def thumbnail(data_b64, width=480):
    """A small JPEG data: URL of an image, for the transcript (full screenshots would bloat it)."""
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(base64.b64decode(data_b64)))
        img.thumbnail((width, width * 3))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=70)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        log.debug("thumbnail failed: %s", e)
        return None


def save_image(sid, media_type, data_b64):
    """Keep a pasted image on disk (named by its content) so it stays viewable in the conversation."""
    ext = {"image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp"}.get(media_type, "png")
    raw = base64.b64decode(data_b64)
    folder = os.path.join(ATTACH_DIR, sid)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, hashlib.sha1(raw).hexdigest()[:16] + "." + ext)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(raw)
    return path


def is_noise(text):
    """Claude Code bookkeeping that isn't part of the conversation."""
    t = text.lstrip()
    return t.startswith(("<command-", "<local-command", "Caveat:", "<system-reminder", "[Request interrupted"))


def approval_summary(tool, inp):
    """What Claude wants to do, said in a few words (for the card and for voice)."""
    path = inp.get("file_path") or inp.get("notebook_path") or inp.get("path") or ""
    name = os.path.basename(path) if path else ""
    if tool in ("Bash", "PowerShell"):
        return "run: " + (inp.get("description") or inp.get("command", ""))[:120]
    if tool in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"edit {name}"
    if tool == "Write":
        return f"write {name}"
    if tool == "WebFetch":
        return "fetch " + re.sub(r"^https?://([^/]+).*", r"\1", inp.get("url", ""))
    if tool.startswith("mcp__"):
        server, _, action = tool[5:].partition("__")
        return f"use {server}: {action.replace('_', ' ')}"
    return f"use {tool}"


class Session:
    """One conversation: its transcript, live SDK connection and pending approvals."""

    def __init__(self, router, cwd, sid=None, resumed=False):
        self.router = router
        self.cwd = cwd                      # None = chat
        self.id = sid or str(uuid.uuid4())
        self.resumed = resumed              # an existing Claude Code session (pass resume=, not session_id=)
        self.items = []
        self.client = None
        self.busy = False
        self.permission_mode = "auto"       # always the default; changing it is per session
        self.extra_dirs = [d for d in router.meta.session(self.id).get("extra_dirs", []) if os.path.isdir(d)]
        self.model = router.settings.get("model") or None     # None = your Claude Code default (chats: CHAT_MODEL)
        self.effort = router.settings.get("effort") or None
        self.approvals = {}                 # approval id -> asyncio future
        self.always = set()                 # tools allowed for the rest of this session
        self.voice_turn = False
        self.picked = False                 # chosen in the app: voice keeps talking to it however old it is
        self.baseline = None                # workspace snapshot the changes panel compares with
        self.baseline_kind = None           # "start" (made here) or "opened" (an older session opened now)
        self.touched = []                   # files Claude's tools changed (for folders that aren't git repos)
        self.stream_item = None
        self.last_used = time.time()
        self.cost_seen = 0.0                # the CLI reports cost cumulatively per connection
        self.lock = None                    # asyncio.Lock, made on the loop
        self.reader = None                  # the task reading everything Claude sends
        self.turn_future = None             # resolved with Claude's reply to the message being sent
        self.unsolicited = False            # Claude is replying by itself (a background task finished)
        self.tasks = {}                     # background task id -> its transcript item
        self.task_outputs = {}              # tool_use_id -> output file (named in the tool result)
        self.pid = None                     # this session's claude.exe
        self.context = None                 # context window usage, measured after each reply

    @property
    def mode(self):
        return "code" if self.cwd else "chat"

    def add(self, item):
        item["i"] = len(self.items)
        self.items.append(item)
        self.router.emit("item", session=self.id, item=item)
        return item

    def changed(self, item):
        self.router.emit("item", session=self.id, item=item)

    def tool_item(self, tool_id):
        for item in reversed(self.items):
            if item.get("kind") == "tool" and item.get("id") == tool_id:
                return item
        return None

    def load_history(self):
        """Transcript of an existing session, from its JSONL."""
        try:
            messages = sdk.get_session_messages(self.id, directory=self.cwd or CHAT_DIR)
        except Exception as e:
            log.warning("Couldn't read session %s: %s", self.id, e)
            return
        for m in messages:
            msg = m.message if isinstance(m.message, dict) else {}
            role, content = msg.get("role"), msg.get("content")
            if m.parent_tool_use_id:   # subagent internals
                continue
            blocks = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text" and b.get("text", "").strip() and not is_noise(b["text"]):
                    text = b["text"]
                    voice = role == "user" and text.startswith("[voice] ")
                    attachments = []
                    if role == "user":   # attached files go back to chips, as they were when sent
                        attachments = re.findall(r'<attached_file path="([^"]+)">', text)
                        attachments += re.findall(r"^Attached file \(read it as needed\): (.+)$", text, flags=re.M)
                        text = re.sub(r'\s*<attached_file path="[^"]+">.*?</attached_file>', "", text, flags=re.S)
                        text = re.sub(r"\s*^Attached file \(read it as needed\): .+$", "", text, flags=re.M).strip()
                    self.add({"kind": role if role in ("user", "assistant") else "assistant",
                              "text": text[8:] if voice else text, "voice": voice, "attachments": attachments})
                elif t == "image" and role == "user":   # a pasted image: back as a viewable picture
                    pics = result_images([b])
                    if pics:
                        last = self.items[-1] if self.items and self.items[-1]["kind"] == "user" else None
                        if last is None:
                            last = self.add({"kind": "user", "text": "", "attachments": []})
                        last.setdefault("image_paths", []).append(save_image(self.id, *pics[0]))
                elif t == "thinking" and b.get("thinking"):
                    self.add({"kind": "thinking", "text": b["thinking"]})
                elif t == "tool_use":
                    self.add({"kind": "tool", "id": b.get("id"), "name": b.get("name"), "input": b.get("input", {}),
                              "result": None, "status": "done"})
                elif t == "tool_result":
                    item = self.tool_item(b.get("tool_use_id"))
                    if item:
                        item["result"] = result_text(b.get("content"))
                        item["status"] = "error" if b.get("is_error") else "done"
                        pics = result_images(b.get("content"))
                        if pics:
                            item["image"] = thumbnail(pics[-1][1])

    # --- SDK plumbing ---
    def options(self):
        r = self.router
        system = CODE_PROMPT if self.cwd else CHAT_PROMPT
        servers = r.mcp_servers(self.cwd)
        if PC_CONTROL_SERVER in servers:
            system += PC_CONTROL_PROMPT
        opts = dict(
            cwd=self.cwd or CHAT_DIR,
            can_use_tool=self.can_use_tool,
            permission_mode=self.permission_mode,
            include_partial_messages=True,
            settings=json.dumps({"disableAllHooks": True}),
            strict_mcp_config=True,
            mcp_servers=servers,
            system_prompt={"type": "preset", "preset": "claude_code", "append": system},
            stderr=lambda line: log.debug("claude: %s", line.rstrip()),
        )
        if self.resumed:
            opts["resume"] = self.id
        else:
            opts["session_id"] = self.id
        if self.cwd:
            opts.update(setting_sources=["user", "project", "local"], enable_file_checkpointing=True)
        else:
            # not [] - the SDK sends that as an empty --setting-sources, which loads everything. CHAT_DIR has no
            # project settings, so this leaves out your user settings (skills, plugins: ~10k tokens a question).
            # A chat given extra folders also gets the file tools, so it can work in them.
            tools = WEB_TOOLS + (FILE_TOOLS if self.extra_dirs else [])
            opts.update(setting_sources=["project", "local"], tools=tools, allowed_tools=list(WEB_TOOLS),
                        model=CHAT_MODEL)
        if self.extra_dirs:   # more folders Claude may read and write, besides the main one
            opts["add_dirs"] = list(self.extra_dirs)
        if self.model:
            opts["model"] = self.model
        if self.effort:
            opts["effort"] = self.effort
        return sdk.ClaudeAgentOptions(**opts)

    async def can_use_tool(self, tool, inp, ctx):
        if tool.startswith(f"mcp__{PC_CONTROL_SERVER}__"):
            self.router.set_work(self, "using_pc")
            return sdk.PermissionResultAllow()   # turned on deliberately from the tray
        if tool in self.always or (self.cwd is None and tool in WEB_TOOLS):
            return sdk.PermissionResultAllow()
        aid = uuid.uuid4().hex[:12]
        future = asyncio.get_running_loop().create_future()
        self.approvals[aid] = future
        summary = approval_summary(tool, inp)
        item = self.add({"kind": "approval", "id": aid, "tool": tool, "input": inp, "summary": summary,
                         "title": getattr(ctx, "title", None) or "", "status": "pending"})
        self.router.set_work(self, "awaiting_approval")
        if self.voice_turn and self.router.on_voice_approval:
            self.router.on_voice_approval(self.id, aid, summary)
        try:
            allow, always = await future
        finally:
            self.approvals.pop(aid, None)
        item["status"] = "allowed" if allow else "denied"
        self.changed(item)
        self.router.set_work(self, "thinking")
        if not allow:
            return sdk.PermissionResultDeny(message="The user declined this.", interrupt=False)
        if always:
            self.always.add(tool)
        return sdk.PermissionResultAllow()

    async def connect(self):
        if self.client is None:
            self.client = sdk.ClaudeSDKClient(options=self.options())
            self.cost_seen = 0.0
            await self.client.connect()
            try:   # remembered with background tasks, so a restart can tell whether they're still going
                self.pid = self.client._transport._process.pid
            except Exception:
                self.pid = None
            self.reader = asyncio.ensure_future(self.read_loop(self.client))
            self.router.evict(keep=self)

    async def disconnect(self):
        client, self.client = self.client, None
        if self.reader:
            self.reader.cancel()
            self.reader = None
        if client:
            try:
                await client.disconnect()
            except Exception as e:
                log.debug("disconnect %s: %s", self.id, e)
        if self.items:
            self.resumed = True   # reconnecting must resume, not start over

    async def read_loop(self, client):
        """Everything Claude sends, for as long as the connection lives: replies to your messages, and replies it
        starts by itself (a background task finished), plus background-task progress in between."""
        try:
            async for m in client.receive_messages():
                try:
                    self.dispatch(m)
                except Exception:
                    log.exception("Couldn't handle a message from Claude")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("Session %s stopped listening: %s", self.id, e)
        finally:
            if self.turn_future and not self.turn_future.done():
                self.turn_future.set_exception(RuntimeError("Claude stopped responding"))
            if self.client is client:   # Claude's process ended on its own
                self.client = None
                self.reader = None
                self.resumed = True

    def dispatch(self, m):
        if isinstance(m, (sdk.TaskStartedMessage, sdk.TaskProgressMessage, sdk.TaskUpdatedMessage,
                          sdk.TaskNotificationMessage)):
            return self.on_task(m)
        in_turn = self.turn_future is not None and not self.turn_future.done()
        if not in_turn and not self.unsolicited and isinstance(m, (sdk.AssistantMessage, sdk.StreamEvent)):
            self.unsolicited = True          # Claude picked up again by itself, e.g. a background task finished
            self.busy = True
            self.router.set_work(self, "thinking")
        result = self.handle(m)
        if isinstance(m, sdk.ResultMessage):
            if in_turn:
                self.turn_future.set_result(result)
            elif self.unsolicited:
                self.unsolicited = False
                self.busy = False
                self.after_turn()

    def after_turn(self):
        self.stream_item = None
        if self.client:
            asyncio.ensure_future(self.measure_context())
        if getattr(self, "reconnect_after", False) and not self.running_tasks():   # extra folders changed mid-reply
            self.reconnect_after = False
            asyncio.ensure_future(self.disconnect())
        if self.router.active is not self:   # finished while you were looking at another session
            self.router.meta.update(self.id, unseen=True)
        self.router.set_work(self, "background" if self.running_tasks() else "idle")
        self.router.sessions_changed(self.cwd)

    # --- background tasks ---
    def running_tasks(self):
        return [t for t in self.tasks.values() if t["status"] in ("pending", "running")]

    def on_task(self, m):
        t = self.tasks.get(m.task_id)
        if t is None:
            t = self.tasks[m.task_id] = {"kind": "task", "task_id": m.task_id, "status": "running",
                                         "description": "", "started": time.time(), "output_file": None}
            t["tool_use_id"] = getattr(m, "tool_use_id", None)
            t["output_file"] = self.task_outputs.get(t["tool_use_id"])
            tool = self.tool_item(t["tool_use_id"]) if t["tool_use_id"] else None
            t["command"] = ((tool or {}).get("input") or {}).get("command")
            self.add(t)
        if getattr(m, "description", None):
            t["description"] = m.description
        if isinstance(m, sdk.TaskStartedMessage):
            t["type"] = m.task_type
        elif isinstance(m, sdk.TaskProgressMessage):
            t["last_tool"] = m.last_tool_name
        elif isinstance(m, sdk.TaskUpdatedMessage) and m.status:
            t["status"] = m.status
        elif isinstance(m, sdk.TaskNotificationMessage):
            t["status"] = m.status or t["status"]
            t["summary"] = m.summary
            t["output_file"] = m.output_file or t["output_file"]
        if t["status"] in ("stopped", "killed") and isinstance(m, sdk.TaskNotificationMessage):
            self.correct_lost_task(t)
        if t["status"] not in ("pending", "running"):
            t["ended"] = t.get("ended") or time.time()
        self.changed(t)
        self.save_tasks()
        if not self.busy:
            self.router.set_work(self, "background" if self.running_tasks() else "idle")

    def correct_lost_task(self, t):
        """After a restart Claude Code reports its old background commands as stopped, but they keep running on their
        own. Say what really happened: finished (with its exit code), or still running."""
        code = exit_code(t.get("output_file"))
        earlier = self.router.finished_tasks.get(t["task_id"])
        if code is None and earlier:
            code = earlier.get("exit_code")
        if code is not None:
            t.update(finished_card(code))
        elif command_running(task_command(t), running_shells()) or \
                any(d.get("task_id") == t["task_id"] for d in self.router.detached.get(self.id, [])):
            t.update(status="running", detached=True, summary=None, ended=None)
            self.router.follow(self.id, t)
        else:
            t["summary"] = "Stopped: its process ended without finishing (Yo Claude or Claude Code restarted)."

    def save_tasks(self):
        """Running tasks, with this session's Claude process id: after a restart Yo Claude can follow them."""
        running = [{k: t.get(k) for k in ("task_id", "description", "output_file", "started", "type", "command")}
                   for t in self.running_tasks()]
        self.router.meta.update(self.id, tasks=running, tasks_pid=self.pid, cwd=self.cwd)

    async def turn(self, prompt, voice):
        """Send one message and stream the reply into the transcript. Returns Claude's final text."""
        if self.lock is None:
            self.lock = asyncio.Lock()
        async with self.lock:
            self.last_used = time.time()
            self.voice_turn = voice
            self.busy = True
            self.router.set_work(self, "thinking")
            try:
                if self.cwd and not self.baseline:   # the changes panel needs "before" captured before any edit
                    await asyncio.to_thread(self.router.take_baseline, self, "opened" if self.resumed else "start")
                await self.connect()
                self.turn_future = asyncio.get_running_loop().create_future()
                await self.client.query(prompt)
                return await self.turn_future or ""
            except Exception as e:
                log.exception("Turn failed")
                self.add({"kind": "error", "text": f"{type(e).__name__}: {e}"})
                await self.disconnect()
                return None
            finally:
                self.turn_future = None
                self.busy = False
                self.voice_turn = False
                self.after_turn()

    async def measure_context(self):
        """How full the context window is, by category (Claude Code's /context), for the meter and its breakdown."""
        client = self.client
        if not client:
            return
        try:
            u = await client.get_context_usage()
        except Exception as e:
            log.debug("context usage: %s", e)
            return
        top = lambda items, n: sorted(({"name": i.get("name") or i.get("path") or i.get("serverName") or "?",
                                        "tokens": i.get("tokens", 0), "server": i.get("serverName")}
                                       for i in (items or []) if isinstance(i, dict)),
                                      key=lambda i: -i["tokens"])[:n]
        self.context = {"total": u.get("totalTokens", 0), "max": u.get("maxTokens", 0),
                        "percentage": u.get("percentage", 0), "model": u.get("model"),
                        "autocompact": u.get("autoCompactThreshold") if u.get("isAutoCompactEnabled") else None,
                        "categories": [{"name": c["name"], "tokens": c["tokens"], "color": c.get("color"),
                                        "deferred": bool(c.get("isDeferred"))} for c in u.get("categories", [])],
                        "mcp": top(u.get("mcpTools"), 8), "memory": top(u.get("memoryFiles"), 6),
                        "breakdown": {k: v for k, v in (u.get("messageBreakdown") or {}).items() if isinstance(v, int)}}
        self.router.emit("context", session=self.id, context=self.context)

    def handle(self, m):
        if isinstance(m, sdk.RateLimitEvent):
            self.router.on_rate_limit(m.rate_limit_info)
            return None
        if isinstance(m, sdk.StreamEvent):
            ev = m.event or {}
            if m.parent_tool_use_id:
                return None
            if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                if self.stream_item is None:
                    self.stream_item = self.add({"kind": "assistant", "text": "", "streaming": True})
                self.stream_item["text"] += ev["delta"]["text"]
                self.router.emit("delta", session=self.id, i=self.stream_item["i"], text=ev["delta"]["text"])
            return None
        if isinstance(m, sdk.AssistantMessage):
            if m.parent_tool_use_id:
                return None
            for b in m.content:
                if isinstance(b, sdk.TextBlock):
                    if self.stream_item is not None:
                        self.stream_item.update(text=b.text, streaming=False)
                        self.changed(self.stream_item)
                        self.stream_item = None
                    elif b.text.strip():
                        self.add({"kind": "assistant", "text": b.text})
                elif isinstance(b, sdk.ThinkingBlock) and b.thinking:
                    self.add({"kind": "thinking", "text": b.thinking})
                elif isinstance(b, sdk.ToolUseBlock):
                    self.stream_item = None
                    self.add({"kind": "tool", "id": b.id, "name": b.name, "input": b.input, "result": None,
                              "status": "running"})
                    if b.name.startswith(f"mcp__{PC_CONTROL_SERVER}__"):
                        self.router.set_work(self, "using_pc")
            return None
        if isinstance(m, sdk.UserMessage):
            if isinstance(m.content, list):
                for b in m.content:
                    if isinstance(b, sdk.ToolResultBlock):
                        item = self.tool_item(b.tool_use_id)
                        if item:
                            item["result"] = result_text(b.content)
                            item["status"] = "error" if b.is_error else "done"
                            pics = result_images(b.content)
                            if pics:   # what Claude saw (screenshots), as a small thumbnail
                                item["image"] = thumbnail(pics[-1][1])
                            self.changed(item)
                            out = re.search(r"Output is being written to: (.+?\.output)", item["result"] or "")
                            if out:   # a background task: where its output goes (kept for after a restart)
                                self.task_outputs[b.tool_use_id] = out.group(1)
                                for t in self.tasks.values():
                                    if t.get("tool_use_id") == b.tool_use_id:
                                        t["output_file"] = out.group(1)
                                        self.changed(t)
                                        self.save_tasks()
                            path = (item["input"] or {}).get("file_path")
                            if path and item["name"] in ("Edit", "MultiEdit", "Write", "NotebookEdit") \
                                    and path not in self.touched:
                                self.touched.append(path)
                            self.router.emit("tool_done", session=self.id, name=item["name"])
                if self.router.work_state(self) == "using_pc":
                    self.router.set_work(self, "thinking")
            return None
        if isinstance(m, sdk.ResultMessage):
            self.resumed = True
            self.router.meta.update(self.id, source="yoclaude", cwd=self.cwd)
            u = m.usage or {}
            tokens = sum(u.get(k, 0) or 0 for k in ("input_tokens", "cache_creation_input_tokens",
                                                     "cache_read_input_tokens"))
            total = m.total_cost_usd or 0.0   # cumulative for the CLI process: show this reply's share
            cost = total - self.cost_seen if total >= self.cost_seen else total
            self.cost_seen = total
            self.add({"kind": "result", "cost": cost, "tokens": tokens,
                      "cached": u.get("cache_read_input_tokens", 0), "duration": m.duration_ms,
                      "error": m.is_error})
            log.info("Turn done in %.1fs: %d tokens processed (%d cached), $%.4f api-equivalent",
                     (m.duration_ms or 0) / 1000, tokens, u.get("cache_read_input_tokens", 0) or 0, cost)
            return m.result or ""
        return None


# --- the router -------------------------------------------------------------------------------------------------
def agent_steps(path, limit=400):
    """A subagent's transcript as readable lines: its brief, what it said, and each tool it used."""
    lines = []

    def brief(inp):
        inp = inp or {}
        for k in ("description", "command", "file_path", "pattern", "url", "query", "prompt"):
            if inp.get(k):
                return " ".join(str(inp[k]).split())[:160]
        return ""
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                content = (d.get("message") or {}).get("content")
                if d.get("type") == "user" and isinstance(content, str):
                    lines.append("> " + content.strip())
                elif d.get("type") == "assistant" and isinstance(content, list):
                    for b in content:
                        if b.get("type") == "text" and b.get("text", "").strip():
                            lines.append(b["text"].strip())
                        elif b.get("type") == "tool_use" and b.get("name") == "SubagentHandback":
                            lines.append("✓ reported back:\n" + str((b.get("input") or {}).get("message", "")))
                        elif b.get("type") == "tool_use":
                            lines.append(f"⚙ {b.get('name')}  {brief(b.get('input'))}".rstrip())
    except OSError as e:
        return f"Couldn't read its transcript: {e}"
    return "\n".join(lines[-limit:])


class Router:
    """Owns the sessions. Thread-safe entry points; everything SDK runs on its own event loop."""

    def __init__(self, settings, emit):
        self.settings = settings
        self._emit = emit
        self.meta = Meta()
        self.live = {}                      # session id -> Session (open in the app this run)
        self.active = None                  # the session voice and the input box talk to
        self.folder = None                  # folder new sessions use; None = chat
        self.work = {}                      # session id -> "thinking" | "using_pc" | "awaiting_approval" | "background"
        self.detached = {}                  # session id -> background tasks still running from before a restart
        self.finished_tasks = {}            # task id -> how a task from before a restart ended
        self.watcher = None
        self.limits = self.meta.data.get("limits")   # last known plan usage limits
        self.on_voice_approval = None       # set by the voice assistant
        os.makedirs(CHAT_DIR, exist_ok=True)
        os.makedirs(TRASH_DIR, exist_ok=True)
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name="sessions", daemon=True).start()
        self.restore_detached()

    def emit(self, kind, **data):
        self._emit(kind, data)

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    # --- state for the icons ---
    def set_work(self, session, state):
        sid = session if isinstance(session, str) else session.id
        if state == "idle":
            self.work.pop(sid, None)
        else:
            self.work[sid] = state
        self.emit("work", state=self.work_summary(), session=sid, session_state=state)

    def work_state(self, session):
        return self.work.get(session.id, "idle")

    def work_summary(self):
        states = set(self.work.values())
        for s in ("awaiting_approval", "using_pc", "thinking", "background"):
            if s in states:
                return s
        return "idle"

    def on_rate_limit(self, info):
        """Plan usage limits (5-hour and weekly windows), as Claude Code reports them with each reply."""
        raw = info.raw or {}
        windows = {k: {"utilization": v.get("utilization"), "resets_at": v.get("resetsAt")}
                   for k, v in (raw.get("unifiedWindows") or {}).items() if isinstance(v, dict)}
        if not windows and info.rate_limit_type:
            windows[info.rate_limit_type] = {"utilization": info.utilization, "resets_at": info.resets_at}
        self.limits = {"windows": windows, "status": info.status, "type": info.rate_limit_type,
                       "overage": info.overage_status, "overage_reason": info.overage_disabled_reason,
                       "using_overage": raw.get("isUsingOverage"), "updated": time.time()}
        self.meta.data["limits"] = self.limits
        self.meta.save()
        self.emit("limits", limits=self.limits)

    def busy_report(self):
        """What would be lost by quitting now: sessions mid-reply, and background tasks (those survive a restart)."""
        out = []
        for sid, state in self.work.items():
            s = self.live.get(sid)
            title = self.title_of(sid)
            tasks = [t["description"] for t in s.running_tasks()] if s else \
                    [t.get("description") for t in self.detached.get(sid, [])]
            out.append({"id": sid, "title": title, "state": state, "tasks": tasks})
        return out

    def shutdown(self):
        """Quitting: close sessions, except ones with background tasks running. Those keep going on their own and
        Yo Claude picks them up again at its next start (restore_detached)."""
        for s in list(self.live.values()):
            if s.running_tasks():
                s.save_tasks()
                log.info("Leaving %s running: %d background task(s)", s.id, len(s.running_tasks()))
                continue
            try:
                self.run(s.disconnect()).result(5)
            except Exception:
                pass

    # --- background tasks that outlived a restart ---
    def restore_detached(self):
        """Background tasks still recorded from before Yo Claude last quit (or was killed)."""
        for sid, m in list(self.meta.data["sessions"].items()):
            if m.get("tasks") and not m.get("deleted"):
                self.detached[sid] = m["tasks"]
                self.work[sid] = "background"
                log.info("Following %d background task(s) of %s from before the restart", len(m["tasks"]), sid)
        if self.detached:
            self.watcher = threading.Thread(target=self.watch_detached, daemon=True, name="detached-tasks")
            self.watcher.start()

    def detached_alive(self, sid):
        """Finished when every task's output ends with Claude Code's "[exited with code N]" marker. Tasks without one
        (agents) count as running while their Claude process lives or their output changed in the last minute."""
        m = self.meta.session(sid)
        unknown = False
        shells = running_shells()
        for t in self.detached.get(sid, []):
            out = t.get("output_file")
            if t.get("ended"):
                continue
            if command_running(task_command(t), shells):
                return True
            if out and os.path.exists(out) and time.time() - os.path.getmtime(out) < 60:
                return True
            if task_command(t) and shells is not None:   # we know what to look for, and it's gone
                continue
            unknown = True
        return unknown and pid_alive(m.get("tasks_pid"))

    def follow(self, sid, t):
        """Keep watching a background command Claude Code lost track of (its process is still running)."""
        tasks = self.detached.setdefault(sid, [])
        if not any(d.get("task_id") == t.get("task_id") for d in tasks):
            tasks.append({k: t.get(k) for k in ("task_id", "description", "output_file", "started", "type", "command")})
            self.work[sid] = "background"
            log.info("Following background task %s of %s: its process is still running", t.get("task_id"), sid)
        if not self.watcher or not self.watcher.is_alive():
            self.watcher = threading.Thread(target=self.watch_detached, daemon=True, name="detached-tasks")
            self.watcher.start()

    def watch_detached(self):
        import pythoncom
        pythoncom.CoInitialize()   # running_shells() asks Windows (WMI) from this thread
        while self.detached:
            for sid in list(self.detached):
                shells = running_shells()
                for t in self.detached.get(sid, []):
                    if t.get("ended"):
                        continue
                    code = exit_code(t.get("output_file"))
                    gone = code is None and task_command(t) and shells is not None \
                        and not command_running(task_command(t), shells)
                    if code is not None or gone:   # this one's done: its card says so now, not when they all are
                        t["ended"], t["exit_code"] = time.time(), code
                        self.detached_card(sid, t)
                if not self.detached_alive(sid):
                    self.detached_finished(sid)
            time.sleep(5)

    def detached_card(self, sid, t):
        """Bring a restored task's card in the transcript up to date with how it ended."""
        s = self.live.get(sid)
        item = s.tasks.get(t.get("task_id")) if s else None
        if item is not None:
            item.update(finished_card(t.get("exit_code")), ended=t.get("ended") or time.time(), detached=False)
            s.changed(item)

    def detached_finished(self, sid):
        """A task from before the restart is done: let its session know, so Claude checks it and reports back."""
        tasks = self.detached.pop(sid, [])
        m = self.meta.session(sid)
        cwd = m.get("cwd")
        self.meta.update(sid, tasks=[], tasks_pid=None)
        self.work.pop(sid, None)
        for t in tasks:
            if not t.get("ended"):
                t["ended"], t["exit_code"] = time.time(), exit_code(t.get("output_file"))
            self.finished_tasks[t.get("task_id")] = t
            self.detached_card(sid, t)
        names = "; ".join(f"\"{t.get('description') or 'background task'}\"" +
                          (f" (output: {t['output_file']})" if t.get("output_file") else "") for t in tasks)
        log.info("Background task(s) of %s finished after the restart: %s", sid, names)
        s = self.live.get(sid)
        if s is None:
            s = Session(self, cwd, sid, resumed=True)
            s.load_history()
            self.live[sid] = s
        s.add({"kind": "note", "text": f"Background task finished while Yo Claude was restarting: {names}"})
        self.send("Yo Claude restarted while your background task kept running, so its completion notice didn't "
                  f"reach you. It has now finished: {names}. Check the result and carry on with what you said you'd "
                  "do when it was done.", sid=sid, origin="system")

    # --- the tasks panel: background commands and subagents, across sessions ---
    def title_of(self, sid):
        s = self.live.get(sid)
        return (self.meta.session(sid).get("title") or (s.items[0].get("text", "")[:60] if s and s.items else "")
                or sid[:8])

    def tasks_list(self):
        """Background commands and subagents of the sessions Yo Claude has open or is following, newest first."""
        out, cutoff = [], time.time() - TASKS_KEEP_S
        sids = {sid: (s.cwd if s else None) for sid, s in self.live.items()}
        for sid in self.detached:
            sids.setdefault(sid, self.meta.session(sid).get("cwd"))
        for sid, cwd in sids.items():
            s, base = self.live.get(sid), {"session": sid, "title": self.title_of(sid), "cwd": cwd}
            agents = self.subagents(sid, cwd)
            agent_tools = {a["tool_use_id"] for a in agents}
            shells = list(s.tasks.values()) if s else []
            shells += [dict(t, detached=True, **(finished_card(t.get("exit_code")) if t.get("ended") else {"status": "running"}))
                       for t in self.detached.get(sid, []) if t.get("task_id") not in (s.tasks if s else {})]
            for t in shells:
                if t.get("tool_use_id") in agent_tools or (t.get("ended") or time.time()) < cutoff:
                    continue
                out.append({**base, "key": f"{sid}:{t['task_id']}", "kind": "shell", "task_id": t["task_id"],
                            "description": t.get("description") or "background command", "status": t["status"],
                            "started": t.get("started"), "ended": t.get("ended"), "summary": t.get("summary"),
                            "detached": bool(t.get("detached")), "output_file": t.get("output_file")})
            ids = {t.get("tool_use_id"): t["task_id"] for t in shells if t.get("tool_use_id")}
            for a in agents:
                a["task_id"] = ids.get(a["tool_use_id"])   # background agents can be stopped like commands
                item = s.tool_item(a["tool_use_id"]) if s else None
                if item and item.get("status") == "running":
                    a["status"], a["ended"] = "running", None
                if (a.get("ended") or time.time()) >= cutoff:
                    out.append({**base, **a, "key": f"{sid}:{a['agent_id']}", "kind": "agent"})
        return sorted(out, key=lambda t: (t["status"] != "running", -(t.get("started") or 0)))[:TASKS_SHOWN]

    def subagents(self, sid, cwd):
        """Claude Code keeps each subagent's transcript next to its session: <session>/subagents/agent-*.jsonl."""
        folder = os.path.join(self.session_file(sid, cwd)[0], sid, "subagents")
        out = []
        try:
            names = [n for n in os.listdir(folder) if n.endswith(".meta.json")]
        except OSError:
            return out
        for n in names:
            agent_id = n[len("agent-"):-len(".meta.json")]
            log_file = os.path.join(folder, f"agent-{agent_id}.jsonl")
            try:
                with open(os.path.join(folder, n), encoding="utf-8") as f:
                    m = json.load(f)
                st = os.stat(log_file)
            except (OSError, ValueError):
                continue
            recent = time.time() - st.st_mtime < AGENT_QUIET_S
            running = recent and not m.get("finished")
            out.append({"agent_id": agent_id, "tool_use_id": m.get("toolUseId"), "agent_type": m.get("agentType"),
                        "description": m.get("description") or m.get("agentType") or "subagent",
                        "background": m.get("requestShape") == "background", "agent_file": log_file,
                        "status": "done" if m.get("finished") else "running" if recent else "stopped",
                        "started": st.st_ctime, "ended": None if running else st.st_mtime})
        return out

    def task_output(self, key):
        """The tail of a background command's output, or a subagent's steps so far, as text."""
        t = next((t for t in self.tasks_list() if t["key"] == key), None)
        if not t:
            return {"error": "That task is no longer listed."}
        if t["kind"] == "shell":
            path = t.get("output_file")
            if not path or not os.path.exists(path):
                return {"text": "", "note": "No output yet." if path else "Its output file isn't known."}
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(max(0, size - TASK_TAIL_BYTES))
                text = f.read().decode("utf-8", "replace")
            return {"text": text, "cut": size > TASK_TAIL_BYTES, "path": path}
        return {"text": agent_steps(t["agent_file"]), "path": t["agent_file"]}

    def stop_task(self, sid, task_id):
        s = self.live.get(sid)
        if s and s.client and task_id in s.tasks:
            self.run(s.client.stop_task(task_id))
            return None
        return "That task isn't connected to this window (it started before Yo Claude restarted)."

    def evict(self, keep):
        """Keep at most MAX_LIVE sessions connected (never one whose background tasks are still running)."""
        connected = sorted((s for s in self.live.values()
                            if s.client and s is not keep and not s.busy and not s.running_tasks()),
                           key=lambda s: s.last_used)
        while len(connected) >= MAX_LIVE:
            asyncio.ensure_future(connected.pop(0).disconnect())

    # --- MCP servers ---
    def mcp_servers(self, cwd):
        """Your user MCP servers (+ the folder's .mcp.json) for code sessions; screen-control only with PC control."""
        servers = {}
        try:
            with open(os.path.expanduser("~/.claude.json"), encoding="utf-8") as f:
                config = json.load(f)
        except (OSError, ValueError):
            config = {}
        user = config.get("mcpServers", {})
        if cwd:
            servers.update(user)
            try:
                with open(os.path.join(cwd, ".mcp.json"), encoding="utf-8") as f:
                    servers.update(json.load(f).get("mcpServers", {}))
            except (OSError, ValueError):
                pass
        servers.pop(PC_CONTROL_SERVER, None)
        if self.settings.get("pc_control"):
            server = pc_control_server() or user.get(PC_CONTROL_SERVER)
            if server:
                servers[PC_CONTROL_SERVER] = server
            else:
                log.warning("PC control is on but its server isn't installed (run install.ps1)")
        return servers

    # --- sessions list ---
    def list(self, cwd):
        """Sessions for a folder (None = chats), newest first, merged with our metadata."""
        try:
            infos = sdk.list_sessions(directory=cwd or CHAT_DIR)
        except Exception as e:
            log.warning("list_sessions failed: %s", e)
            infos = []
        meta = self.meta.data["sessions"]
        out, seen = [], set()
        for s in infos:
            m = meta.get(s.session_id, {})
            seen.add(s.session_id)
            out.append({"id": s.session_id, "title": m.get("title") or s.custom_title or s.summary or s.first_prompt
                        or "(empty)", "first": s.first_prompt, "modified": s.last_modified, "created": s.created_at,
                        "background": s.session_id in self.detached or bool(
                            s.session_id in self.live and self.live[s.session_id].running_tasks()),
                        "branch": s.git_branch, "cwd": cwd, "tag": s.tag, "source": m.get("source", "claude code"),
                        "pinned": bool(m.get("pinned")), "group": m.get("group"), "unseen": bool(m.get("unseen")),
                        "live": s.session_id in self.live, "busy": s.session_id in self.work})
        for s in self.live.values():   # brand-new sessions not written to disk yet
            if s.id not in seen and same_folder(s.cwd, cwd):
                out.append({"id": s.id, "title": "New session", "modified": s.last_used * 1000,
                            "created": s.last_used * 1000, "cwd": cwd, "source": "yoclaude", "pinned": False,
                            "group": None, "live": True, "busy": s.id in self.work})
        out.sort(key=lambda x: x["modified"] or 0, reverse=True)
        return out

    def sessions_changed(self, cwd):
        self.emit("sessions", cwd=cwd, sessions=self.list(cwd))

    # --- opening / creating ---
    def set_folder(self, folder):
        """The folder voice's "new session" uses (follows the session you're in)."""
        self.folder = folder or None
        if folder:
            self.meta.add_folder(folder)

    def workspaces(self):
        return [f for f in self.meta.data["workspaces"] if os.path.isdir(f)]

    def set_workspace(self, folder, present):
        """Add or remove a folder in the sidebar tree (its files and sessions are never touched)."""
        self.meta.set_workspace(folder, present)
        self.emit("workspaces", workspaces=self.workspaces())

    def new_session(self, cwd="current", picked=False):
        cwd = self.folder if cwd == "current" else cwd
        if cwd:
            self.meta.add_folder(cwd)
            if not any(same_folder(cwd, w) for w in self.meta.data["workspaces"]):
                self.set_workspace(cwd, True)
        s = Session(self, cwd)
        s.picked = picked
        self.live[s.id] = s
        self.active = s
        self.folder = cwd
        self.ensure_baseline(s, "start")
        self.emit("opened", session=self.describe(s), items=[])
        self.sessions_changed(cwd)
        return s

    def open(self, sid, cwd):
        s = self.live.get(sid)
        if s is None:
            s = Session(self, cwd, sid, resumed=True)
            s.load_history()
            for t in self.detached.get(sid, []):   # from before a restart: still running, or finished since
                item = {"kind": "task", "status": "running", "detached": True, **t}
                if t.get("ended"):
                    item.update(finished_card(t.get("exit_code")), detached=False)
                s.tasks[t["task_id"]] = item
                s.add(item)
            self.live[sid] = s
        s.picked = True
        self.active = s
        self.folder = s.cwd
        if self.meta.session(sid).get("unseen"):
            self.meta.update(sid, unseen=False)
            self.sessions_changed(cwd)
        self.ensure_baseline(s, "opened")
        self.emit("opened", session=self.describe(s), items=s.items)
        return s

    def ensure_baseline(self, s, kind):
        """Snapshot the folder (in the background: git can take a moment on big repos)."""
        if not s.cwd or s.baseline:
            return
        saved = self.meta.session(s.id).get("baseline")
        if saved:
            s.baseline, s.baseline_kind = saved, self.meta.session(s.id).get("baseline_kind", "opened")
            return
        threading.Thread(target=self.take_baseline, args=(s, kind), daemon=True).start()

    def take_baseline(self, s, kind):
        if s.baseline or not s.cwd:
            return
        try:
            snap = workspace.snapshot(s.cwd)
        except Exception as e:
            log.warning("Snapshot of %s failed: %s", s.cwd, e)
            return
        if snap and not s.baseline:
            s.baseline, s.baseline_kind = snap, kind
            self.meta.update(s.id, baseline=snap, baseline_kind=kind, cwd=s.cwd)
            self.emit("baseline", session=s.id)

    def describe(self, s):
        return {"id": s.id, "cwd": s.cwd, "mode": s.mode, "permission_mode": s.permission_mode, "busy": s.busy,
                "model": s.model or "", "effort": s.effort or "", "extra_dirs": list(s.extra_dirs),
                "context": s.context}

    def set_extra_dirs(self, sid, dirs):
        """Folders a session may also read and write. Takes effect from its next message (a start-up option)."""
        s = self.live.get(sid)
        if not s:
            return "Open the session first."
        s.extra_dirs = [d for d in dict.fromkeys(dirs) if os.path.isdir(d) and not same_folder(d, s.cwd)]
        self.meta.update(sid, extra_dirs=s.extra_dirs)
        if s.client and not s.busy:
            self.run(s.disconnect())
        elif s.client:
            s.reconnect_after = True
        self.emit("session_info", session=self.describe(s))
        return None

    # --- talking ---
    def send(self, text, voice=False, sid=None, context="", attachments=(), images=(), origin="user"):
        """Send a message to a session (default: the active one). Returns a concurrent Future with the reply.
        `context` is extra prompt text (attached files); `images` are (media_type, base64) pairs. origin="system" is
        Yo Claude itself writing (shown as a note, not as you)."""
        s = self.live.get(sid) if sid else self.active
        if s is None:
            s = self.new_session()
        if origin == "user":
            s.add({"kind": "user", "text": text, "voice": voice, "attachments": list(attachments),
                   "image_paths": [save_image(s.id, mt, data) for mt, data in images]})
        prompt = (f"[voice] {text}" if voice else text) + (f"\n\n{context}" if context else "")
        if origin == "system":
            prompt = f"[Yo Claude] {text}"
        if images:
            content = [{"type": "text", "text": prompt}] + [
                {"type": "image", "source": {"type": "base64", "media_type": mt, "data": data}} for mt, data in images]

            async def message():
                yield {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None,
                       "session_id": s.id}
            prompt = message()
        return self.run(s.turn(prompt, voice))

    def interrupt(self, sid=None):
        s = self.live.get(sid) if sid else self.active
        if not s:
            return
        for future in list(s.approvals.values()):
            self.loop.call_soon_threadsafe(lambda f=future: f.done() or f.set_result((False, False)))
        if s.client and s.busy:
            self.run(s.client.interrupt())

    def approve(self, sid, aid, allow, always=False):
        s = self.live.get(sid)
        future = s and s.approvals.get(aid)
        if future:
            self.loop.call_soon_threadsafe(lambda: future.done() or future.set_result((allow, always)))

    def set_permission_mode(self, sid, mode):
        if mode not in ("auto", "default", "acceptEdits", "plan"):
            return
        s = self.live.get(sid)   # this session only: new sessions always start in auto
        if not s:
            return
        s.permission_mode = mode
        if s.client:
            self.run(s.client.set_permission_mode(mode))

    def set_model(self, sid, model):
        """Per session; also the default for new sessions. A live session switches at once."""
        model = model or None
        self.settings["model"] = model or ""
        self.settings.save()
        s = self.live.get(sid)
        if s:
            s.model = model
            if s.client:
                self.run(s.client.set_model(model or (None if s.cwd else CHAT_MODEL)))

    def set_effort(self, sid, effort):
        """Per session; also the default for new sessions. Applies from the next message (it's a start-up option)."""
        effort = effort if effort in ("low", "medium", "high", "xhigh", "max") else None
        self.settings["effort"] = effort or ""
        self.settings.save()
        s = self.live.get(sid)
        if s:
            s.effort = effort
            if s.client and not s.busy:
                self.run(s.disconnect())

    def reconnect_all(self):
        """Settings that change the CLI's options (PC control) apply from the next turn."""
        for s in self.live.values():
            if s.client and not s.busy:
                self.run(s.disconnect())

    # --- management ---
    def rename(self, sid, cwd, title):
        try:
            sdk.rename_session(sid, title, directory=cwd or CHAT_DIR)
        except Exception as e:
            log.warning("rename_session failed (%s); keeping the name in Yo Claude only", e)
        self.meta.update(sid, title=title)
        self.sessions_changed(cwd)

    def pin(self, sid, cwd, pinned):
        self.meta.update(sid, pinned=bool(pinned))
        self.sessions_changed(cwd)

    def group(self, sid, cwd, group):
        self.meta.update(sid, group=group or None)
        self.sessions_changed(cwd)

    def session_file(self, sid, cwd):
        folder = os.path.join(PROJECTS_DIR, sdk.project_key_for_directory(cwd or CHAT_DIR))
        return folder, os.path.join(folder, f"{sid}.jsonl")

    def stale(self):
        """Sessions worth cleaning up, oldest first: empty ones, short ones a week old, and anything untouched for
        STALE_DAYS. Never pinned, open, busy, or touched in the last QUIET_DAYS."""
        now = time.time() * 1000
        out = []
        for cwd in [None] + self.workspaces():
            try:
                infos = sdk.list_sessions(directory=cwd or CHAT_DIR)
            except Exception as e:
                log.warning("list_sessions failed for %s: %s", cwd, e)
                continue
            for s in infos:
                m = self.meta.data["sessions"].get(s.session_id, {})
                if m.get("pinned") or s.session_id in self.live or s.session_id in self.work:
                    continue
                days = (now - (s.last_modified or now)) / 86_400_000
                if days < QUIET_DAYS:
                    continue
                size = s.file_size or 0
                if size < EMPTY_BYTES or not (s.first_prompt or s.custom_title or s.summary):
                    reason = "empty"
                elif size < SMALL_BYTES:
                    reason = f"short, untouched for {int(days)} days"
                elif days >= STALE_DAYS:
                    reason = f"untouched for {int(days)} days"
                else:
                    continue
                out.append({"id": s.session_id, "cwd": cwd, "reason": reason, "modified": s.last_modified,
                            "size": size, "source": m.get("source", "claude code"),
                            "title": m.get("title") or s.custom_title or s.summary or s.first_prompt or "(empty)"})
        out.sort(key=lambda x: x["modified"] or 0)
        return out[:200]

    def delete_many(self, items):
        """Move several sessions to the trash; returns the ones that couldn't be moved, with why."""
        failed, folders = [], set()
        for it in items:
            err = self.delete(it["id"], it.get("cwd"), notify=False)
            if err:
                failed.append({"id": it["id"], "error": err})
            folders.add(it.get("cwd"))
        for cwd in folders:
            self.sessions_changed(cwd)
        return failed

    def delete(self, sid, cwd, notify=True):
        """Move a session to Yo Claude's trash (restorable). Refused while it's busy or was written in the last minute,
        which probably means it's open in another Claude Code window."""
        s = self.live.get(sid)
        if s and s.busy:
            return "It's still working."
        folder, path = self.session_file(sid, cwd)
        if not os.path.exists(path):
            return "Couldn't find that session's file."
        if time.time() - os.path.getmtime(path) < 60 and not s:
            return "It changed in the last minute, so it may be open somewhere else."
        if s:
            self.run(s.disconnect()).result(10)
            self.live.pop(sid, None)
            if self.active is s:
                self.active = None
        dest = os.path.join(TRASH_DIR, os.path.basename(folder))
        os.makedirs(dest, exist_ok=True)
        shutil.move(path, os.path.join(dest, f"{sid}.jsonl"))
        if os.path.isdir(os.path.join(folder, sid)):   # its subagent transcripts
            shutil.move(os.path.join(folder, sid), os.path.join(dest, sid))
        self.meta.update(sid, deleted={"at": time.time(), "from": folder}, cwd=cwd)
        if notify:
            self.sessions_changed(cwd)
        return None

    def trash(self):
        out = []
        for sid, m in self.meta.data["sessions"].items():
            if m.get("deleted"):
                out.append({"id": sid, "title": m.get("title") or sid[:8], "cwd": m.get("cwd"),
                            "deleted": m["deleted"]["at"]})
        return sorted(out, key=lambda x: x["deleted"], reverse=True)

    def restore(self, sid):
        m = self.meta.session(sid)
        info = m.get("deleted")
        if not info:
            return "Not in the trash."
        folder = info["from"]
        src = os.path.join(TRASH_DIR, os.path.basename(folder))
        os.makedirs(folder, exist_ok=True)
        shutil.move(os.path.join(src, f"{sid}.jsonl"), os.path.join(folder, f"{sid}.jsonl"))
        if os.path.isdir(os.path.join(src, sid)):
            shutil.move(os.path.join(src, sid), os.path.join(folder, sid))
        m.pop("deleted", None)
        self.meta.save()
        self.sessions_changed(m.get("cwd"))
        return None

    def fork(self, sid, cwd):
        try:
            result = sdk.fork_session(sid, directory=cwd or CHAT_DIR)
        except Exception as e:
            return None, str(e)
        new_id = getattr(result, "session_id", None) or getattr(result, "new_session_id", None)
        if new_id:
            self.meta.update(new_id, source="yoclaude", cwd=cwd)
        self.sessions_changed(cwd)
        return new_id, None


def pc_control_server():
    """The screen-control server bundled in pc_control/ (its own environment: its packages clash with the SDK's)."""
    python = os.path.join(HERE, "pc_control", ".venv", "Scripts", "python.exe")
    if not os.path.exists(python):
        return None
    os.makedirs(PC_CONTROL_DATA, exist_ok=True)
    return {"type": "stdio", "command": python, "args": [os.path.join(HERE, "pc_control", "server.py")],
            "env": {"SCREEN_CONTROL_LOG": os.path.join(PC_CONTROL_DATA, "screen-control.log"),
                    "SCREEN_CONTROL_MACROS": os.path.join(PC_CONTROL_DATA, "macros"),
                    "SCREEN_CONTROL_KILL_FILE": os.path.join(PC_CONTROL_DATA, "DISABLED")}}


def exit_code(path):
    """Claude Code ends a background command's output file with "[exited with code N]": N, or None while it runs."""
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - 200))
            found = re.findall(rb"\[exited with code (-?\d+)\]", f.read())
    except OSError:
        return None
    return int(found[-1]) if found else None


def running_shells():
    """Command lines of the shells running now (Claude Code runs background commands in Git Bash), or None if
    Windows couldn't say."""
    try:
        import win32com.client
        wmi = win32com.client.GetObject("winmgmts:")
        return [p.CommandLine or "" for p in wmi.ExecQuery(
            "SELECT CommandLine FROM Win32_Process WHERE Name='bash.exe' OR Name='sh.exe'")]
    except Exception as e:
        log.debug("Couldn't list shells: %s", e)
        return None


def task_command(t):
    """A background command's text. Tasks saved before it was recorded have it as their description, unless Claude
    gave one."""
    if t.get("command"):
        return t["command"]
    d = t.get("description") or ""
    return d if t.get("type") == "local_bash" and re.search(r"[|;&>]|^\S+ -", d) else None


def command_running(command, shells):
    """Whether one of those shells is running this command. Its longest stretch without quotes or backslashes is
    matched, since the shell's command line has the command quoted inside it."""
    if not command or not shells:
        return False
    parts = sorted(re.split(r"[\\'\"`]", command), key=len, reverse=True)
    key = parts[0].strip() if parts else ""
    return len(key) >= 12 and any(key in c for c in shells)


def finished_card(code):
    """How a background command's card should read once its output shows how it ended."""
    if code is None:
        return {"status": "stopped", "summary": "Its process has ended, but how it ended isn't known."}
    return {"status": "completed" if code == 0 else "failed", "summary": f"Ran to the end (exit code {code})."}


def pid_alive(pid):
    if not pid:
        return False
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))   # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(handle)
    return code.value == 259   # STILL_ACTIVE


def same_folder(a, b):
    if not a or not b:
        return not a and not b
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
