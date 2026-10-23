"""Windows' built-in OCR (WinRT)."""
import asyncio
import concurrent.futures

from .app import _logged, mcp
from .capture import _box, _grab
from .coords import _mon, _scale
from .safety import _guard_read


def _ocr_lines(img) -> list:
    """Windows' built-in OCR on a PIL image: [(line text, [(word, x, y, w, h), ...])] in image pixels."""
    from winrt.windows.graphics.imaging import BitmapPixelFormat, SoftwareBitmap
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage.streams import DataWriter

    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("Windows OCR has no language installed for this user (Settings > Language)")
    orig_w = img.width
    if max(img.size) > OcrEngine.max_image_dimension:
        img = img.resize((round(img.width * OcrEngine.max_image_dimension / max(img.size)),
                          round(img.height * OcrEngine.max_image_dimension / max(img.size))))
    f = img.width / orig_w  # 1.0 unless shrunk above; word boxes are mapped back to the original pixels

    async def run():
        writer = DataWriter()
        writer.write_bytes(img.convert("RGBA").tobytes("raw", "BGRA"))
        bmp = SoftwareBitmap.create_copy_from_buffer(writer.detach_buffer(), BitmapPixelFormat.BGRA8,
                                                     img.width, img.height)
        result = await engine.recognize_async(bmp)
        return [(ln.text, [(w.text, w.bounding_rect.x / f, w.bounding_rect.y / f, w.bounding_rect.width / f,
                            w.bounding_rect.height / f) for w in ln.words]) for ln in result.lines]

    # the MCP server's own event loop owns this thread, so the WinRT call gets a private loop on a worker thread
    with concurrent.futures.ThreadPoolExecutor(1) as ex:
        return ex.submit(asyncio.run, run()).result()


@mcp.tool(structured_output=False)
@_logged
def ocr(window: str | None = None, region: list[int] | None = None, text: str | None = None) -> str:
    """Read on-screen text with Windows' built-in OCR (screen, window or region as for screenshot). Without
    `text`: every text line and its position - often enough instead of a screenshot. With `text`: only where that
    text appears (case-insensitive, may span words), each with a centre point to click."""
    _guard_read()
    box, label = _box(window, region)
    lines = _ocr_lines(_grab(box))
    mon = _mon()
    s = _scale(mon)

    def rect(words):
        l, t = min(w[1] for w in words), min(w[2] for w in words)
        r, b = max(w[1] + w[3] for w in words), max(w[2] + w[4] for w in words)
        return (round((box["left"] + l - mon["left"]) * s), round((box["top"] + t - mon["top"]) * s),
                round((r - l) * s), round((b - t) * s))

    out = []
    if text:
        q = text.lower()
        for _, words in lines:
            i = 0
            while i < len(words):
                for j in range(i, len(words)):
                    joined = " ".join(w[0] for w in words[i:j + 1]).lower()
                    if q in joined:
                        x, y, w, h = rect(words[i:j + 1])
                        out.append(f"{' '.join(w[0] for w in words[i:j + 1])!r} center=({x + w // 2},{y + h // 2}) "
                                   f"box=({x},{y},{w},{h})")
                        i = j
                        break
                    if len(joined) > len(q) + 40:
                        break
                i += 1
        head = f"{len(out)} match(es) for {text!r}"
    else:
        for line_text, words in lines[:300]:
            if words:
                x, y, w, h = rect(words)
                out.append(f"{line_text!r} @({x},{y}) {w}x{h}")
        head = f"{len(lines)} line(s)"
    return f"{head} in {label or 'screen'}" + ("\n" + "\n".join(out) if out else "")
