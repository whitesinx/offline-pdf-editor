"""Find a full font file that matches a (usually subsetted) font name from a PDF.

Lookup order:
  1. cache        fonts/cache/ (previous downloads/extractions, works offline)
  2. system       fonts installed on this computer, matched by PostScript name or family
  3. google       the same family on Google Fonts
  4. substitute   a metric-compatible / look-alike family on Google Fonts
"""

import io
import logging
import json
import os
import re
import sys
import threading
import urllib.parse
import urllib.request

from fontTools.ttLib import TTCollection, TTFont

logging.getLogger("fontTools").setLevel(logging.ERROR)

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "fonts", "cache")

FONT_DIRS = {
    "darwin": ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", "~/Library/Fonts"],
    "linux": ["/usr/share/fonts", "/usr/local/share/fonts", "~/.local/share/fonts", "~/.fonts"],
    "win32": [os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts"), "~/AppData/Local/Microsoft/Windows/Fonts"],
}

# Proprietary fonts common in PDFs -> freely available look-alikes on Google Fonts.
# The first few are metric-compatible (same glyph widths), so text keeps its length.
SUBSTITUTES = {
    "calibri": "Carlito",
    "cambria": "Caladea",
    "arial": "Arimo",
    "helvetica": "Arimo",
    "helveticaneue": "Arimo",
    "liberationsans": "Arimo",
    "timesnewroman": "Tinos",
    "times": "Tinos",
    "timesroman": "Tinos",
    "liberationserif": "Tinos",
    "couriernew": "Cousine",
    "courier": "Cousine",
    "liberationmono": "Cousine",
    "georgia": "Gelasio",
    "segoeui": "Open Sans",
    "verdana": "PT Sans",
    "tahoma": "PT Sans",
    "trebuchetms": "Fira Sans",
    "gillsans": "Lato",
    "gillsansmt": "Lato",
    "centurygothic": "Questrial",
    "futura": "Jost",
    "garamond": "EB Garamond",
    "adobegaramond": "EB Garamond",
    "adobegaramondpro": "EB Garamond",
    "bookantiqua": "Gentium Book Plus",
    "palatino": "Gentium Book Plus",
    "palatinolinotype": "Gentium Book Plus",
    "minionpro": "Crimson Pro",
    "myriadpro": "PT Sans",
    "frutiger": "Hind",
    "univers": "Roboto",
    "franklingothic": "Libre Franklin",
    "consolas": "Inconsolata",
    "lucidaconsole": "Cousine",
    "menlo": "Cousine",
    "sfpro": "Inter",
    "sfprotext": "Inter",
    "sfprodisplay": "Inter",
}

GENERIC = {"serif": "Tinos", "sans": "Arimo", "mono": "Cousine"}

WEIGHTS = [
    ("extralight", 200), ("ultralight", 200), ("semibold", 600), ("demibold", 600), ("extrabold", 800),
    ("ultrabold", 800), ("hairline", 100), ("thin", 100), ("light", 300), ("medium", 500), ("demi", 600),
    ("bold", 700), ("heavy", 800), ("black", 900), ("book", 400), ("regular", 400), ("normal", 400),
]


def key(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def parse_pdf_font_name(name, bold=False, italic=False):
    """'ABCDEF+TimesNewRomanPS-BoldItalicMT' -> ('Times New Roman', 700, True, 'TimesNewRomanPS-BoldItalicMT')"""
    ps = re.sub(r"^[A-Z]{6}\+", "", name.strip())
    fam, style = (re.split(r"[-,]", ps, maxsplit=1) + [""])[:2]
    fam = re.sub(r"(PSMT|PS|MT|Std|LT)$", "", fam)
    # Style words glued onto the family (e.g. "ArialBoldItalic", "Calibri Light").
    words = [w for w, _ in WEIGHTS] + ["italic", "oblique"]
    stripped = True
    while stripped:
        stripped = False
        for word in words:
            m = re.search(word + r"\s*$", fam, re.I)
            if m and len(fam) > len(word) + 2:
                style = fam[m.start():] + style
                fam = fam[: m.start()]
                stripped = True
    fam = re.sub(r"(?<=[a-z])(?=[A-Z0-9])|(?<=[A-Z])(?=[A-Z][a-z])", " ", fam).strip()

    s = style.lower()
    weight = next((w for word, w in WEIGHTS if word in s), 700 if bold else 400)
    if bold and weight < 600:
        weight = 700
    is_italic = italic or "italic" in s or "oblique" in s or s.endswith("it")
    return fam, weight, is_italic, ps


# ---- system fonts ------------------------------------------------------------

_index = None
_index_lock = threading.Lock()


def _read_faces(path):
    faces = []
    if path.lower().endswith((".ttc", ".otc")):
        fonts = list(enumerate(TTCollection(path, lazy=True).fonts))
    else:
        fonts = [(None, TTFont(path, lazy=True))]
    for idx, f in fonts:
        if "name" not in f:
            continue
        n = f["name"]
        family = n.getDebugName(16) or n.getDebugName(1) or ""
        os2 = f["OS/2"] if "OS/2" in f else None
        faces.append({
            "path": path,
            "index": idx,
            "ps": n.getDebugName(6) or "",
            "family": family,
            "weight": os2.usWeightClass if os2 else 400,
            "italic": bool(os2.fsSelection & 1) if os2 else "italic" in (n.getDebugName(2) or "").lower(),
        })
    return faces


def system_index():
    global _index
    with _index_lock:
        if _index is not None:
            return _index
        faces = []
        for d in FONT_DIRS.get(sys.platform, FONT_DIRS["linux"]):
            d = os.path.expanduser(d)
            for dirpath, _dirs, files in os.walk(d):
                for fn in files:
                    if fn.lower().endswith((".ttf", ".otf", ".ttc", ".otc")):
                        try:
                            faces.extend(_read_faces(os.path.join(dirpath, fn)))
                        except Exception:
                            pass
        _index = {"ps": {key(f["ps"]): f for f in faces}, "family": {}}
        for f in faces:
            _index["family"].setdefault(key(f["family"]), []).append(f)
        return _index


def _closest(faces, weight, italic):
    return min(faces, key=lambda f: (f["italic"] != italic, abs(f["weight"] - weight)))


def _face_bytes(face):
    if face["index"] is None:
        with open(face["path"], "rb") as fh:
            data = fh.read()
    else:
        buf = io.BytesIO()
        TTCollection(face["path"]).fonts[face["index"]].save(buf)
        data = buf.getvalue()
    return _to_sfnt(data)


def _to_sfnt(data):
    """MuPDF embeds the raw file, so WOFF/WOFF2 must become plain TTF/OTF."""
    if data[:4] in (b"wOFF", b"wOF2"):
        f = TTFont(io.BytesIO(data))
        f.flavor = None
        buf = io.BytesIO()
        f.save(buf)
        return buf.getvalue()
    return data


# Ranges kept when slimming a font for embedding: Latin (incl. Vietnamese),
# combining marks, Greek, Cyrillic, punctuation, currency, symbols, arrows, math.
KEEP_RANGES = [(0x20, 0x24F), (0x2B0, 0x36F), (0x370, 0x3FF), (0x400, 0x52F), (0x1E00, 0x1EFF),
               (0x2000, 0x206F), (0x20A0, 0x20CF), (0x2100, 0x22FF), (0x25A0, 0x25FF), (0xFB00, 0xFB06)]


def slim(data):
    """Shrink a full font before it is embedded: drop hinting and scripts outside
    KEEP_RANGES. CJK fonts are left whole since their glyphs are the point."""
    from fontTools import subset

    font = TTFont(io.BytesIO(data))
    cps = set(font.getBestCmap() or {})
    if sum(1 for cp in cps if 0x3000 <= cp <= 0x9FFF or 0xAC00 <= cp <= 0xD7AF) > 100:
        return data
    keep = {cp for cp in cps if any(a <= cp <= b for a, b in KEEP_RANGES)}
    opts = subset.Options()
    opts.hinting = False
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.layout_features = ["kern", "liga", "clig", "calt", "ccmp", "locl", "mark", "mkmk"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=keep)
    sub.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def find_system(family, weight, italic, ps):
    idx = system_index()
    face = idx["ps"].get(key(ps))
    if face:
        return face
    faces = idx["family"].get(key(family))
    return _closest(faces, weight, italic) if faces else None


# ---- Google Fonts ----------------------------------------------------------

def _google_css(family, weight, italic):
    q = urllib.parse.quote(family) + ":ital,wght@%d,%d" % (1 if italic else 0, weight)
    req = urllib.request.Request(
        "https://fonts.googleapis.com/css2?family=" + q,
        headers={"User-Agent": "Mozilla/4.0"},  # old UA -> full TrueType files, not woff2 subsets
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode()


def find_google(family, weight, italic):
    tries = [(weight, italic), (700 if weight >= 600 else 400, italic), (weight, False), (400, False)]
    for w, it in dict.fromkeys(tries):
        try:
            css = _google_css(family, w, it)
        except urllib.error.HTTPError:
            continue  # family or style not on Google Fonts
        m = re.search(r"url\((https://[^)]+)\)", css)
        if m:
            with urllib.request.urlopen(m.group(1), timeout=20) as r:
                return _to_sfnt(r.read()), w, it
    return None


# ---- entry point -------------------------------------------------------------

def resolve(name, bold=False, italic=False, serif=False, mono=False, online=True):
    """Return (font_bytes, info_dict) or (None, info_dict)."""
    family, weight, italic, ps = parse_pdf_font_name(name, bold, italic)
    info = {"requested": name, "family": family, "weight": weight, "italic": italic}
    cache_key = "%s-%d%s" % (key(family) or "generic" + ("mono" if mono else "serif" if serif else "sans"), weight, "i" if italic else "")
    os.makedirs(CACHE_DIR, exist_ok=True)
    cached = os.path.join(CACHE_DIR, cache_key + ".ttf")
    meta = cached[:-4] + ".json"
    if os.path.exists(cached) and os.path.exists(meta):
        with open(cached, "rb") as fh, open(meta) as mh:
            return fh.read(), {**json.load(mh), "cached": True}

    data = None
    face = find_system(family, weight, italic, ps) if family else None
    if face:
        data = _face_bytes(face)
        info.update(source="system", match=face["ps"] or face["family"], file=face["path"])

    sub = SUBSTITUTES.get(key(family)) or GENERIC["mono" if mono else "serif" if serif else "sans"]
    candidates = [(family, "google")] if family else []
    candidates.append((sub, "substitute"))
    for fam, source in candidates if data is None and online else []:
        try:
            hit = find_google(fam, weight, italic)
        except Exception as err:
            info["error"] = str(err)
            break  # offline or blocked: don't try further downloads
        if hit:
            data = hit[0]
            info.update(source=source, match=fam, weight=hit[1], italic=hit[2])
            break

    if data is None:
        info["source"] = "none"
        return None, info

    try:
        data = slim(data)
    except Exception as err:
        info["slim_error"] = str(err)

    with open(cached, "wb") as fh:
        fh.write(data)
    with open(meta, "w") as mh:
        json.dump(info, mh)
    return data, info


if __name__ == "__main__":
    for n in sys.argv[1:]:
        data, info = resolve(n)
        print(n, "->", info, len(data or b""))
