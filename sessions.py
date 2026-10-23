"""Claude sessions for Yo Claude, on the Claude Agent SDK.

A session is either a **chat** (no folder: web tools only, cheap) or **code** (a folder: Claude Code's full toolset,
your user + project settings minus hooks). The router runs every session on one asyncio loop in its own thread,
keeps a live connection per open session so follow-ups skip the CLI start-up, turns SDK messages into transcript
items for the UI, and routes tool approvals to the UI and to voice.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

import anyio
import claude_agent_sdk as sdk

log = logging.getLogger("yo_claude")

DATA_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude")
CHAT_DIR = os.path.join(DATA_DIR, "home")       # cwd for chats: outside any project, so nothing project-level loads
TRASH_DIR = os.path.join(DATA_DIR, "trash")
META_PATH = os.path.join(DATA_DIR, "sessions.json")
PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
PC_CONTROL_SERVER = "screen-control"
WEB_TOOLS = ["WebSearch", "WebFetch"]
CHAT_MODEL = "sonnet"
MAX_LIVE = 3              # connected sessions kept warm
RESULT_PREVIEW = 4000     # characters of a tool result kept for the transcript

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


# --- metadata the SDK doesn't keep: groups, pins, where a session came from -----------------------------------
class Meta:
    def __init__(self):
        self.data = {"sessions": {}, "groups": [], "recent_folders": []}
        try:
            with open(META_PATH, encoding="utf-8") as f:
                self.data.update(json.load(f))
        except (OSError, ValueError):
            pass
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


# --- transcript items -------------------------------------------------------------------------------------------
def result_text(content):
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
    else:
        text = "" if content is None else str(content)
    return text if len(text) <= RESULT_PREVIEW else text[:RESULT_PREVIEW] + f"\n… ({len(text) - RESULT_PREVIEW} more)"


def is_noise(text):
    """Claude Code bookkeeping that isn't part of the conversation."""
    t = text.lstrip()
    return t.startswith(("<command-", "<local-command", "Caveat:", "<system-reminder", "[Request interrupted"))


def approval_summary(tool, inp):
    """What Claude wants to do, said in a few words (for the card and for voice)."""
    path = inp.get("file_path") or inp.get("notebook_path") or inp.get("path") or ""
    name = os.path.basename(path) if path else ""
    if tool == "Bash":
        return "run the command " + (inp.get("description") or inp.get("command", ""))[:120]
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
        self.permission_mode = "default"
        self.model = router.settings.get("model") or None     # None = your Claude Code default (chats: CHAT_MODEL)
        self.effort = router.settings.get("effort") or None
        self.approvals = {}                 # approval id -> asyncio future
        self.always = set()                 # tools allowed for the rest of this session
        self.voice_turn = False
        self.picked = False                 # chosen in the app: voice keeps talking to it however old it is
        self.stream_item = None
        self.last_used = time.time()
        self.lock = None                    # asyncio.Lock, made on the loop

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
                    self.add({"kind": role if role in ("user", "assistant") else "assistant",
                              "text": text[8:] if voice else text, "voice": voice})
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
            opts.update(setting_sources=["project", "local"], tools=WEB_TOOLS, allowed_tools=list(WEB_TOOLS),
                        model=CHAT_MODEL)
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
            await self.client.connect()
            self.router.evict(keep=self)

    async def disconnect(self):
        client, self.client = self.client, None
        if client:
            try:
                await client.disconnect()
            except Exception as e:
                log.debug("disconnect %s: %s", self.id, e)
        if self.items:
            self.resumed = True   # reconnecting must resume, not start over

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
                await self.connect()
                await self.client.query(prompt)
                final = ""
                async for m in self.client.receive_response():
                    final = self.handle(m) or final
                return final
            except Exception as e:
                log.exception("Turn failed")
                self.add({"kind": "error", "text": f"{type(e).__name__}: {e}"})
                await self.disconnect()
                return None
            finally:
                self.busy = False
                self.voice_turn = False
                self.stream_item = None
                self.router.set_work(self, "idle")
                self.router.sessions_changed(self.cwd)

    def handle(self, m):
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
                            self.changed(item)
                            self.router.emit("tool_done", session=self.id, name=item["name"], input=item["input"])
                if self.router.work_state(self) == "using_pc":
                    self.router.set_work(self, "thinking")
            return None
        if isinstance(m, sdk.ResultMessage):
            self.resumed = True
            self.router.meta.update(self.id, source="yoclaude", cwd=self.cwd)
            u = m.usage or {}
            tokens = sum(u.get(k, 0) or 0 for k in ("input_tokens", "cache_creation_input_tokens",
                                                     "cache_read_input_tokens"))
            self.add({"kind": "result", "cost": m.total_cost_usd, "tokens": tokens,
                      "cached": u.get("cache_read_input_tokens", 0), "duration": m.duration_ms,
                      "error": m.is_error})
            log.info("Turn done in %.1fs: %d context tokens (%d cached), $%.4f api-equivalent",
                     (m.duration_ms or 0) / 1000, tokens, u.get("cache_read_input_tokens", 0) or 0,
                     m.total_cost_usd or 0)
            return m.result or ""
        return None


# --- the router -------------------------------------------------------------------------------------------------
class Router:
    """Owns the sessions. Thread-safe entry points; everything SDK runs on its own event loop."""

    def __init__(self, settings, emit):
        self.settings = settings
        self._emit = emit
        self.meta = Meta()
        self.live = {}                      # session id -> Session (open in the app this run)
        self.active = None                  # the session voice and the input box talk to
        self.folder = None                  # folder new sessions use; None = chat
        self.work = {}                      # session id -> "thinking" | "using_pc" | "awaiting_approval"
        self.on_voice_approval = None       # set by the voice assistant
        os.makedirs(CHAT_DIR, exist_ok=True)
        os.makedirs(TRASH_DIR, exist_ok=True)
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name="sessions", daemon=True).start()

    def emit(self, kind, **data):
        self._emit(kind, data)

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    # --- state for the icons ---
    def set_work(self, session, state):
        if state == "idle":
            self.work.pop(session.id, None)
        else:
            self.work[session.id] = state
        self.emit("work", state=self.work_summary(), session=session.id, session_state=state)

    def work_state(self, session):
        return self.work.get(session.id, "idle")

    def work_summary(self):
        states = set(self.work.values())
        for s in ("awaiting_approval", "using_pc", "thinking"):
            if s in states:
                return s
        return "idle"

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
        if self.settings.get("pc_control") and PC_CONTROL_SERVER in user:
            servers[PC_CONTROL_SERVER] = user[PC_CONTROL_SERVER]
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
                        "branch": s.git_branch, "cwd": cwd, "tag": s.tag, "source": m.get("source", "claude code"),
                        "pinned": bool(m.get("pinned")), "group": m.get("group"),
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
        self.folder = folder or None
        if folder:
            self.meta.add_folder(folder)
        self.sessions_changed(self.folder)

    def new_session(self, cwd="current", picked=False):
        cwd = self.folder if cwd == "current" else cwd
        s = Session(self, cwd)
        s.picked = picked
        self.live[s.id] = s
        self.active = s
        self.emit("opened", session=self.describe(s), items=[])
        self.sessions_changed(cwd)
        return s

    def open(self, sid, cwd):
        s = self.live.get(sid)
        if s is None:
            s = Session(self, cwd, sid, resumed=True)
            s.load_history()
            self.live[sid] = s
        s.picked = True
        self.active = s
        self.emit("opened", session=self.describe(s), items=s.items)
        return s

    def describe(self, s):
        return {"id": s.id, "cwd": s.cwd, "mode": s.mode, "permission_mode": s.permission_mode, "busy": s.busy,
                "model": s.model or "", "effort": s.effort or ""}

    def evict(self, keep):
        """Keep at most MAX_LIVE sessions connected."""
        connected = sorted((s for s in self.live.values() if s.client and s is not keep and not s.busy),
                           key=lambda s: s.last_used)
        while len(connected) >= MAX_LIVE:
            asyncio.ensure_future(connected.pop(0).disconnect())

    # --- talking ---
    def send(self, text, voice=False, sid=None):
        """Send a message to a session (default: the active one). Returns a concurrent Future with the reply."""
        s = self.live.get(sid) if sid else self.active
        if s is None:
            s = self.new_session()
        s.add({"kind": "user", "text": text, "voice": voice})
        prompt = f"[voice] {text}" if voice else text
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
        s = self.live.get(sid)
        if not s or mode not in ("default", "acceptEdits", "plan"):
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

    def delete(self, sid, cwd):
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
        self.meta.update(sid, deleted={"at": time.time(), "from": folder})
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


def same_folder(a, b):
    if not a or not b:
        return not a and not b
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
