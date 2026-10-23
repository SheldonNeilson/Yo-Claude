"""Yo Claude's voice engine: wake word, speech detection, transcription, the voice, and the conversation loop.

Say "yo claude" (or click the bar / tray icon), Claude greets you, you speak, the speech is transcribed locally
(faster-whisper) and sent to the app's active Claude session (sessions.py), and the answer is read aloud in a
Microsoft neural voice (edge-tts). Raw audio never leaves the PC; only the transcribed text goes to Claude.
app.py runs it. Everything it writes lives in ~/.yoclaude (settings.json, yo_claude.log, models).
"""

import asyncio
import difflib
import io
import json
import logging
import os
import queue
import random
import re
import threading
import time
import wave
import winsound
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# Not under AppData: apps from the Microsoft Store (like the Claude desktop app) get a private copy of AppData,
# so files written there from their child processes are invisible to everything else.
DATA_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude")

# --- settings -----------------------------------------------------------------
WAKE_PHRASE = "yo claude"
VOSK_MODEL = os.path.join(DATA_DIR, "models", "vosk-model-small-en-us-0.15")
WHISPER_MODEL = "small.en"   # tiny.en / base.en / small.en / medium.en
VOICE_TURN_TIMEOUT_S = 1800  # coding tasks can take a while
CONVERSATION_WINDOW_S = 300  # a voice conversation older than this starts a new session (unless picked in the app)
FOLLOWUP_LISTEN_S = 6        # after answering, listen this long for a follow-up without the wake word
APPROVAL_LISTEN_S = 8
SPEECH_START_TIMEOUT_S = 7
END_SILENCE_S = 1.5          # pause that ends your request
MAX_UTTERANCE_S = 30
VAD_ON, VAD_OFF = 0.5, 0.35  # Silero speech probability thresholds
NEURAL_VOICE = "en-US-AvaNeural"   # `edge-tts --list-voices` for others
NEURAL_RATE = "+5%"
TEXT_HOLD_S = 12             # how long a reply stays on the bar when voice replies are off

DEFAULT_SETTINGS = {"listening": True, "voice_replies": True, "pc_control": False, "bar_when_idle": True,
                    "launch_at_login": True, "show_bar": True, "show_window": True}

GREETINGS = ["Hey, how can I help?", "Yo! What do you need?", "How can I help?", "What's up?", "I'm listening."]
DIDNT_HEAR = "I didn't hear anything."
DIDNT_CATCH = "Sorry, I didn't catch that."
OKAY = "Okay."
STOP_PHRASES = {"never mind", "nevermind", "cancel", "stop", "nothing", "no thanks", "thats all", "goodbye", "bye"}

SAMPLE_RATE = 16000
FRAME_LENGTH = 512
FPS = SAMPLE_RATE / FRAME_LENGTH
TTS_RATE = 24000
IDLE, PAUSED, LISTENING, THINKING, SPEAKING = "idle", "paused", "listening", "thinking", "speaking"

log = logging.getLogger("yo_claude")


class Settings(dict):
    path = os.path.join(DATA_DIR, "settings.json")

    def __init__(self):
        super().__init__(DEFAULT_SETTINGS)
        try:
            with open(self.path, encoding="utf-8") as f:
                self.update(json.load(f))
        except (OSError, ValueError):
            pass

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self, f, indent=2)


# --- audio in -----------------------------------------------------------------
def rms(frame):
    return float(np.sqrt(np.mean(frame.astype(np.float32) ** 2))) if len(frame) else 0.0


class Mic:
    def __init__(self):
        from pvrecorder import PvRecorder
        self.rec = PvRecorder(frame_length=FRAME_LENGTH, device_index=-1)
        log.info("Mic: %s", self.rec.selected_device)

    @property
    def running(self):
        return self.rec.is_recording

    def start(self):
        if not self.rec.is_recording:
            self.rec.start()

    def stop(self):
        if self.rec.is_recording:
            self.rec.stop()

    def read(self):
        return np.array(self.rec.read(), dtype=np.int16)


class Vad:
    """Silero speech probability for the latest frame (the model ships with faster-whisper)."""

    def __init__(self):
        from faster_whisper.vad import get_vad_model
        self.model = get_vad_model()
        self.reset()

    def reset(self):
        self.window = np.zeros(FRAME_LENGTH * 16, np.float32)

    def __call__(self, frame):
        self.window = np.roll(self.window, -FRAME_LENGTH)
        self.window[-FRAME_LENGTH:] = frame / 32768.0
        return float(self.model(self.window)[-1])


class VoskWake:
    """Free offline wake word: a recognizer that only knows WAKE_PHRASE plus sound-alike decoys.

    The decoys give near-misses ("yo, close the door", "your cloud bill") something else to match. Only finished
    utterances count (partials jump to the phrase too eagerly); since background noise can stop Vosk ever noticing
    that you stopped talking, the VAD's pause forces the result.
    """

    DECOYS = ["yo", "you", "your", "close", "closed", "cloud", "claudia", "clod", "clause", "claws", "loud", "go",
              "load", "though", "hello", "what", "the", "a", "it", "is", "to", "glad", "called"]

    def __init__(self, phrase=WAKE_PHRASE):
        import vosk
        vosk.SetLogLevel(-1)
        self.phrase = phrase
        grammar = [phrase] + self.DECOYS + ["[unk]"]
        self.rec = vosk.KaldiRecognizer(vosk.Model(VOSK_MODEL), SAMPLE_RATE, json.dumps(grammar))
        self.speech = self.quiet = 0
        self.last_text = None   # text of the utterance that just finished, if one did on this frame

    def feed(self, frame, speech_prob):
        self.last_text = None
        if self.rec.AcceptWaveform(frame.tobytes()):
            text = json.loads(self.rec.Result())["text"]
            self.speech = self.quiet = 0
        else:
            if speech_prob > VAD_ON:
                self.speech, self.quiet = self.speech + 1, 0
            elif self.speech:
                self.quiet += 1
            if not self.speech or (self.quiet < 8 and self.speech < 4 * FPS):
                return False
            text = json.loads(self.rec.FinalResult())["text"]
            self.speech = self.quiet = 0
        if text:
            log.debug("Wake engine heard: %s", text)
        self.last_text = text
        return self.phrase in text

    def reset(self):
        self.rec.Reset()
        self.speech = self.quiet = 0


class Utterance:
    """Collects one spoken request: starts when the VAD hears speech, ends after END_SILENCE_S of non-speech."""

    def __init__(self, start_timeout_s, followup):
        self.start_timeout_s, self.followup = start_timeout_s, followup
        self.pre = deque(maxlen=int(FPS * 0.5))
        self.audio, self.on, self.off, self.waited = [], 0, 0, 0

    def feed(self, frame, p):
        """None while still listening, ("timeout", None) if nobody spoke, ("done", pcm) when finished."""
        if not self.audio:
            self.pre.append(frame)
            self.on = self.on + 1 if p > VAD_ON else 0
            if self.on >= 3:
                self.audio = list(self.pre)
            else:
                self.waited += 1
                if self.waited > self.start_timeout_s * FPS:
                    return "timeout", None
            return None
        self.audio.append(frame)
        self.off = self.off + 1 if p < VAD_OFF else 0
        if self.off >= END_SILENCE_S * FPS or len(self.audio) >= MAX_UTTERANCE_S * FPS:
            return "done", np.concatenate(self.audio)
        return None


class Transcriber:
    def __init__(self):
        from faster_whisper import WhisperModel
        t = time.time()
        try:   # no network check on every start once the model is downloaded
            self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", local_files_only=True)
        except Exception:
            self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        list(self.model.transcribe(np.zeros(SAMPLE_RATE, np.float32), language="en")[0])   # first run is ~5x slower
        log.info("Whisper %s loaded in %.1fs", WHISPER_MODEL, time.time() - t)

    def __call__(self, pcm):
        t = time.time()
        segments, _ = self.model.transcribe(pcm.astype(np.float32) / 32768.0, language="en", beam_size=1)
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()
        log.info("Heard (%.1fs): %r", time.time() - t, text)
        return text


# --- audio out ----------------------------------------------------------------
def neural_tts(text, voice=NEURAL_VOICE, rate=TTS_RATE):
    """Microsoft neural voice (online) -> mono int16 PCM at `rate`."""
    import av
    import edge_tts

    async def fetch():
        mp3 = bytearray()
        async for chunk in edge_tts.Communicate(text, voice, rate=NEURAL_RATE).stream():
            if chunk["type"] == "audio":
                mp3 += chunk["data"]
        return bytes(mp3)

    container = av.open(io.BytesIO(asyncio.run(fetch())))
    resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
    frames = [f for frame in container.decode(audio=0) for f in resampler.resample(frame)]
    frames += resampler.resample(None)
    return np.concatenate([f.to_ndarray().reshape(-1) for f in frames]).astype(np.int16)


def write_wav(path, pcm, rate):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


class Speaker:
    """Always the same neural voice; if the voice service can't be reached the reply is shown as text instead."""

    def __init__(self):
        self.cache = {}
        self.pcm = None
        self.started = self.until = 0.0
        self.n = 0

    def synth(self, text):
        if text in self.cache:
            return self.cache[text]
        for attempt in range(3):
            try:
                return neural_tts(text)
            except Exception as e:
                log.warning("Voice attempt %d failed: %s", attempt + 1, e)
                time.sleep(0.3)
        return None

    def warm(self, phrases):
        for p in phrases:
            pcm = self.synth(p)
            if pcm is not None:
                self.cache[p] = pcm

    def play(self, pcm):
        self.n += 1
        path = os.path.join(DATA_DIR, f"speech-{self.n % 3}.wav")
        write_wav(path, pcm, TTS_RATE)
        winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
        self.pcm, self.started = pcm, time.time()
        self.until = self.started + len(pcm) / TTS_RATE + 0.15

    @property
    def busy(self):
        return time.time() < self.until

    def level(self):
        """Loudness of what's playing right now, for the waveform."""
        i = int((time.time() - self.started) * TTS_RATE)
        return rms(self.pcm[i:i + 768]) if self.pcm is not None else 0.0

    def stop(self):
        winsound.PlaySound(None, 0)
        self.until = 0.0


def speakable(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^\s*(#+|[-*•]|\d+\.)\s+", "", text, flags=re.M)
    text = re.sub(r"[*_`#>|]", "", text)
    return re.sub(r"\s+", " ", text).strip()


# --- the assistant ------------------------------------------------------------
def is_stop(text):
    return re.sub(r"[^a-z ]", "", text.lower()).strip() in STOP_PHRASES


def approval_verdict(text):
    """True for an explicit go-ahead, False for a no, None if it's unclear (then the click decides)."""
    t = re.sub(r"[^a-z ]", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    if re.search(r"\b(go ahead|do it|approve|approved|proceed|allow it|yes please)\b", t):
        return True
    if re.search(r"\b(no|nope|don t|do not|deny|stop|cancel|never mind|wait)\b", t):
        return False
    return None


def voice_command(text):
    """("new", folder?) / ("switch", name) for app commands said out loud, else None."""
    t = re.sub(r"[^a-z0-9 ]", " ", text.lower()).strip()
    t = re.sub(r"\s+", " ", t)
    if re.fullmatch(r"(please )?(start |open |make )?(a )?(new|fresh) (chat|conversation)( please)?", t):
        return ("new", None)
    if re.fullmatch(r"(please )?(start |open |make )?(a )?(new|fresh) session( please)?|start over", t):
        return ("new", "current")
    m = re.fullmatch(r"(switch|go|change) (back )?to (the )?(.+?)( session| chat)?", t)
    if m:
        return ("switch", m.group(4))
    return None


def spoken_part(text):
    """What to read aloud: the plain opening of the reply; the rest stays on screen."""
    head = re.split(r"\n\s*\n|```|\n\s*[-*#|]|\n\s*\d+\.", text.strip(), maxsplit=1)[0]
    head = speakable(head)
    sentences = re.split(r"(?<=[.!?])\s+", head)
    spoken = " ".join(sentences[:3])
    if len(spoken) > 420:
        spoken = spoken[:420].rsplit(" ", 1)[0] + "…"
    if len(speakable(text)) > len(spoken) + 40:
        spoken += " The rest is on screen."
    return spoken or "Done. It's on screen."


class Assistant:
    """Runs on its own thread: reads the mic continuously and moves between idle/listening/thinking/speaking.

    `emit(kind, **data)` reports to the UI ("state", "level"); `commands` takes "talk", "stop", "settings", "quit",
    and ("approval", session, id, summary) from the router when Claude asks permission during a voice turn.
    """

    def __init__(self, settings, emit, commands, router, save_samples=False, collect=False):
        self.settings, self.emit, self.commands, self.router = settings, emit, commands, router
        self.save_samples = save_samples or collect
        self.collect = collect   # --collect: only judge and save what it hears, never reply
        self.hits = self.tries = 0
        self.recent = deque(maxlen=int(FPS * 6))
        self.heard_speech = False
        self.emit("state", state="starting", text="")
        self.mic = Mic()
        self.vad = Vad()
        self.wake = VoskWake()
        self.stt = Transcriber()
        self.speaker = Speaker()
        self.worker = ThreadPoolExecutor(2)   # one for the Claude turn, one to transcribe approvals meanwhile
        self.job = self.utterance = None
        self.approval = None         # (session, id, summary) being asked about by voice
        self.approval_job = None
        self.generation = 0          # bumps on stop, so a cancelled job's late result is ignored
        self.after_speaking = None
        self.state = None
        self.quit = False
        router.on_voice_approval = lambda sid, aid, summary: commands.put(("approval", sid, aid, summary))
        threading.Thread(target=self.speaker.warm, args=(GREETINGS + [DIDNT_HEAR, DIDNT_CATCH, OKAY],),
                         daemon=True).start()
        self.go_idle()
        log.info("Ready.")

    # state changes
    def set_state(self, state, text="", hold=0.0):
        if state != self.state or text:
            log.info("[%s] %s", state, text)
        self.state = state
        self.emit("state", state=state, text=text, hold=hold)

    def go_idle(self, text="", hold=0.0):
        self.wake.reset()
        self.set_state(IDLE if self.settings["listening"] else PAUSED, text, hold)

    def listen(self, timeout_s=SPEECH_START_TIMEOUT_S, followup=False, text="", approval=False):
        self.vad.reset()
        self.utterance = Utterance(timeout_s, followup)
        self.utterance.text = text
        self.utterance.approval = approval
        self.set_state(LISTENING, text)

    def say(self, text, then, pcm=None):
        """Speak `text` (or just show it when voice replies are off / the voice is unavailable), then call `then`."""
        if self.settings["voice_replies"] and pcm is None:
            pcm = self.speaker.synth(text)
        if self.settings["voice_replies"] and pcm is not None:
            self.speaker.play(pcm)
            self.after_speaking = lambda: then(text)
            self.set_state(SPEAKING, text)
        else:
            then(text)

    def start_conversation(self):
        self.mic.start()
        self.say(random.choice(GREETINGS), lambda _: self.listen())

    def stop(self):
        self.generation += 1
        self.router.interrupt()
        self.speaker.stop()
        self.job = self.approval = self.approval_job = None
        self.go_idle()

    # main loop
    def run(self):
        try:
            while not self.quit:
                self.handle_commands()
                if self.state == PAUSED:
                    self.mic.stop()
                    time.sleep(0.05)
                    continue
                self.mic.start()
                frame = self.mic.read()
                p = self.vad(frame)
                level = self.speaker.level() if self.state == SPEAKING else rms(frame)
                self.emit("level", level=level, speech=p > VAD_ON)
                getattr(self, "on_" + self.state)(frame, p)
        except Exception:
            log.exception("Assistant crashed")
            self.set_state("error", "Something broke. See the log (tray menu).")
        finally:
            self.speaker.stop()
            self.mic.stop()

    def handle_commands(self):
        while True:
            try:
                cmd = self.commands.get_nowait()
            except queue.Empty:
                return
            if cmd == "quit":
                self.quit = True
            elif cmd == "stop":
                self.stop()
            elif cmd == "talk" and self.state in (IDLE, PAUSED):   # while active, only "stop" stops it
                self.start_conversation()
            elif cmd == "settings" and self.state in (IDLE, PAUSED):
                self.go_idle()
            elif isinstance(cmd, tuple) and cmd[0] == "approval" and self.job and self.state == THINKING:
                self.approval = cmd[1:]
                self.say(f"Claude wants to {cmd[3]}. Say yes, go ahead, or no.",
                         lambda _: self.listen(APPROVAL_LISTEN_S, approval=True))

    def on_idle(self, frame, p):
        self.recent.append(frame)
        self.heard_speech = self.heard_speech or p > VAD_ON
        woke = self.wake.feed(frame, p)
        if self.save_samples and self.wake.last_text is not None and self.heard_speech:
            self.save_sample(self.wake.last_text or "nothing")
            self.heard_speech = False
            if self.collect:   # show every judgement instead of replying
                self.hits += woke
                self.tries += 1
                self.set_state(IDLE, f"Heard “{self.wake.last_text or '(nothing)'}” – "
                                     f"woke {self.hits} of {self.tries} times", hold=30)
        if woke and self.collect:
            winsound.MessageBeep(winsound.MB_OK)
        elif woke:
            log.info("Wake word heard")
            self.start_conversation()

    def save_sample(self, label):
        """--debug: keep what the wake engine just judged, to tune it against real voices."""
        folder = os.path.join(DATA_DIR, "samples")
        os.makedirs(folder, exist_ok=True)
        name = time.strftime("%Y%m%d-%H%M%S-") + re.sub(r"\W+", "_", label)[:40] + ".wav"
        write_wav(os.path.join(folder, name), np.concatenate(self.recent), SAMPLE_RATE)
        self.recent.clear()

    def on_listening(self, frame, p):
        result = self.utterance.feed(frame, p)
        if result is None:
            return
        kind, pcm = result
        if self.utterance.approval:
            if kind == "timeout":
                self.say("Okay, it's waiting for you on screen.", lambda _: self.set_state(THINKING))
            else:
                self.approval_job = self.worker.submit(self.stt, pcm)
                self.set_state(THINKING)
            return
        if kind == "timeout":
            if self.utterance.followup:   # leave the last reply on the bar a little longer
                self.go_idle(self.utterance.text, TEXT_HOLD_S)
            else:
                self.say(DIDNT_HEAR, lambda _: self.go_idle())
            return
        self.set_state(THINKING, "")
        self.job = (self.generation, self.worker.submit(self.think, pcm, self.generation))

    def think(self, pcm, generation):
        """Worker thread: transcribe, run voice commands or ask Claude, render the voice.
        Returns (reply, next step, pcm)."""
        heard = self.stt(pcm)
        if not heard:
            return DIDNT_CATCH, "idle", None
        if is_stop(heard):
            return OKAY, "idle", None
        command = voice_command(heard)
        if command:
            return self.run_command(command), "followup", None
        self.emit("state", state=THINKING, text=f"“{heard}”", hold=0.0)
        s = self.router.active
        if s is not None and not s.picked and time.time() - s.last_used > CONVERSATION_WINDOW_S:
            self.router.new_session()   # an old voice conversation: start afresh
        try:
            reply = self.router.send(heard, voice=True).result(VOICE_TURN_TIMEOUT_S)
        except Exception as e:
            log.warning("Voice turn failed: %s", e)
            reply = None
        if generation != self.generation:
            return None
        if not reply:
            return "Sorry, something went wrong. It's on screen.", "idle", None
        spoken = spoken_part(reply)
        pcm = self.speaker.synth(spoken) if self.settings["voice_replies"] else None
        return spoken, "followup", pcm

    def run_command(self, command):
        if command[0] == "new":
            s = self.router.new_session(command[1])
            return "Okay, new " + ("session in " + os.path.basename(s.cwd) if s.cwd else "chat") + "."
        name = command[1]
        sessions = self.router.list(self.router.folder)
        titles = [x["title"].lower() for x in sessions]
        match = difflib.get_close_matches(name, titles, n=1, cutoff=0.4) or [t for t in titles if name in t][:1]
        if not match:
            return f"I couldn't find a session called {name}."
        target = sessions[titles.index(match[0])]
        self.router.open(target["id"], target["cwd"])
        return f"Switched to {target['title'][:60]}."

    def on_thinking(self, frame, p):
        if self.approval_job is not None:
            if not self.approval_job.done():
                return
            heard, self.approval_job = self.approval_job.result(), None
            (sid, aid, _), self.approval = self.approval, None
            verdict = approval_verdict(heard)
            if verdict is None:
                return self.say("I didn't get a clear yes or no, so it's waiting on screen.",
                                lambda _: self.set_state(THINKING))
            self.router.approve(sid, aid, verdict)
            return self.say("Going ahead." if verdict else "Okay, I won't.", lambda _: self.set_state(THINKING))
        if self.job is None:
            return self.go_idle()
        generation, future = self.job
        if not future.done():
            return
        self.job = None
        result = future.result() if generation == self.generation else None
        if result is None:
            return self.go_idle()
        reply, step, pcm = result
        if step == "idle":
            self.say(reply, lambda _: self.go_idle())
        else:   # after an answer, keep the reply on screen and listen briefly for a follow-up
            self.say(reply, lambda text: self.listen(FOLLOWUP_LISTEN_S, followup=True, text=text), pcm)

    def on_speaking(self, frame, p):
        if not self.speaker.busy:
            then, self.after_speaking = self.after_speaking, None
            then()
