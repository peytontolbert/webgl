"""
Trace a model texture through the WebGL viewer pipeline.

This tool is meant for debugging "TextureStreamer: failed to load texture ... returned HTML"
or "all textures are placeholders".

It answers:
- Given a missing/requested texture (URL, filename, hash, or texture name),
  where does it exist across stages?
    - webgl/output/... (extract/export stage)
    - webgl/webgl_viewer/assets/... (runtime assets stage)
    - webgl/webgl_viewer/dist/assets/... (built/preview stage)
- If not found, does a *variant* exist? (hash-only vs hash_slug naming)

Examples (from repo root):
  python webgl/webgl_viewer/tools/trace_texture_pipeline.py 1004931005_im_kerbs03_lod.png
  python webgl/webgl_viewer/tools/trace_texture_pipeline.py http://localhost:4173/assets/models_textures/1004931005_im_kerbs03_lod.png
  python webgl/webgl_viewer/tools/trace_texture_pipeline.py IM_Kerbs03_LOD
  python webgl/webgl_viewer/tools/trace_texture_pipeline.py --scan-by-hash 1004931005

Notes:
- By default, this tool does NOT parse `.ytd` to prove which RPF contains the texture.
  However, this repo includes a CodeWalker-backed GTA resource stack under `webgl/gta5_modules/`.
  If you pass `--game-path`, the tool can optionally attempt to locate the source `.ytd` + owning `.rpf`
  that contains a given texture name (best-effort, bounded scan).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import urlparse


PNG_SIG = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class FileSig:
    kind: str
    detail: str


def _read_head(p: Path, n: int = 64) -> bytes:
    try:
        with p.open("rb") as f:
            return f.read(n)
    except Exception:
        return b""


def _strip_leading_ws(b: bytes) -> bytes:
    i = 0
    while i < len(b) and b[i] in (9, 10, 13, 32):  # \t \n \r space
        i += 1
    return b[i:]


def sniff_bytes(head: bytes) -> FileSig:
    if not head:
        return FileSig("unreadable_or_empty", "no bytes read")

    b = _strip_leading_ws(head)
    if not b:
        return FileSig("empty_or_whitespace", "only whitespace")

    if b.startswith(b"<"):
        return FileSig("html", "starts with '<' (SPA fallback / wrong file)")

    if b.startswith(b"DDS "):
        return FileSig("dds", "DDS magic")

    if len(b) >= 12 and b[:12] == b"\xABKTX 20\xBB\r\n\x1A\n":
        return FileSig("ktx2", "KTX2 magic")

    if b.startswith(PNG_SIG):
        if len(b) < 16:
            return FileSig("png_truncated", "signature present but too short for IHDR header")
        ihdr_type = b[12:16]
        if ihdr_type != b"IHDR":
            return FileSig("png_suspicious", f"signature ok but first chunk type={ihdr_type!r} (expected b'IHDR')")
        return FileSig("png", "signature ok (IHDR present)")

    if len(b) >= 3 and b[0:3] == b"\xFF\xD8\xFF":
        return FileSig("jpeg", "SOI header")

    if b.startswith(b"GIF87a") or b.startswith(b"GIF89a"):
        return FileSig("gif", "GIF header")

    if len(b) >= 2 and b[0:2] == b"BM":
        return FileSig("bmp", "BM header")

    if len(b) >= 12 and b[0:4] == b"RIFF" and b[8:12] == b"WEBP":
        return FileSig("webp", "RIFF WEBP header")

    return FileSig("unknown", f"head={b[:16].hex(' ')}")


def joaat(input_str: str) -> int:
    """
    GTA "joaat" (Jenkins one-at-a-time) hash.
    Matches `webgl/webgl_viewer/js/joaat.js`.
    """
    s = str(input_str or "").lower()
    h = 0
    for ch in s:
        h = (h + ord(ch)) & 0xFFFFFFFF
        h = (h + ((h << 10) & 0xFFFFFFFF)) & 0xFFFFFFFF
        h ^= (h >> 6)
    h = (h + ((h << 3) & 0xFFFFFFFF)) & 0xFFFFFFFF
    h ^= (h >> 11)
    h = (h + ((h << 15) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return h & 0xFFFFFFFF


def slugify_texture_name(name: str) -> str:
    s = str(name or "").strip().lower()
    if not s:
        return ""
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"^_+", "", s)
    s = re.sub(r"_+$", "", s)
    return s


def normalize_input_to_basename(s: str) -> str:
    t = str(s or "").strip()
    if not t:
        return ""
    if "://" in t:
        try:
            u = urlparse(t)
            t = u.path or t
        except Exception:
            pass
    t = t.replace("\\", "/")
    # strip any leading assets prefix the viewer uses
    t = re.sub(r"^/+", "", t)
    if "/" in t:
        t = t.split("/")[-1]
    return t


@dataclass
class ParsedWanted:
    raw: str
    basename: str
    hash_u32: Optional[int]
    slug: str
    is_numeric_hash_only: bool
    is_texture_name: bool


def parse_wanted(raw: str) -> ParsedWanted:
    basename = normalize_input_to_basename(raw)
    is_texture_name = False
    h: Optional[int] = None
    slug = ""

    # Cases:
    # - "123.png" or "123_slug.png"
    # - "123" (hash only)
    # - "IM_Kerbs03_LOD" (texture name)
    m_png = re.match(r"^(\d+)(?:_([^\.]+))?\.(png|jpg|jpeg|webp|gif|bmp)$", basename, re.IGNORECASE)
    if m_png:
        h = int(m_png.group(1)) & 0xFFFFFFFF
        slug = str(m_png.group(2) or "")
        return ParsedWanted(raw=raw, basename=basename, hash_u32=h, slug=slug, is_numeric_hash_only=False, is_texture_name=False)

    m_hash = re.match(r"^(\d+)$", basename)
    if m_hash:
        h = int(m_hash.group(1)) & 0xFFFFFFFF
        return ParsedWanted(raw=raw, basename=basename, hash_u32=h, slug="", is_numeric_hash_only=True, is_texture_name=False)

    # Assume it's a texture name; compute joaat.
    is_texture_name = True
    slug = slugify_texture_name(basename)
    if slug:
        h = joaat(basename)
    return ParsedWanted(raw=raw, basename=basename, hash_u32=h, slug=slug, is_numeric_hash_only=False, is_texture_name=is_texture_name)


def candidate_filenames(p: ParsedWanted) -> list[str]:
    out: list[str] = []
    seen = set()

    def add(x: str) -> None:
        x = str(x or "").strip()
        if not x or x in seen:
            return
        seen.add(x)
        out.append(x)

    # If input had an extension already, keep it.
    if "." in p.basename:
        add(p.basename)
    else:
        # default browser format for this pipeline
        if p.hash_u32 is not None and p.is_numeric_hash_only:
            add(f"{p.hash_u32}.png")
        else:
            add(f"{p.basename}.png")

    if p.hash_u32 is not None:
        # Hash-only candidate (very common in your assets/models_textures folder)
        add(f"{p.hash_u32}.png")

        # Hash + slug candidate
        if p.slug:
            add(f"{p.hash_u32}_{p.slug}.png")

    return out


def iter_stage_dirs(viewer_root: Path) -> list[tuple[str, Path]]:
    webgl_dir = viewer_root.parent
    out_dir = webgl_dir / "output"

    # We include a few common export layouts; not all will exist.
    # (The repo has historically used both `models_textures/` and `models/models_textures/` naming.)
    return [
        ("output (export)", out_dir / "models_textures"),
        ("output (export)", out_dir / "models" / "models_textures"),
        ("output (export)", out_dir / "models_textures_png"),
        ("viewer assets", viewer_root / "assets" / "models_textures"),
        ("viewer assets (legacy)", viewer_root / "assets" / "models" / "models_textures"),
        ("dist assets", viewer_root / "dist" / "assets" / "models_textures"),
        ("dist assets (legacy)", viewer_root / "dist" / "assets" / "models" / "models_textures"),
    ]


def _fmt_size(n: int) -> str:
    if n < 0:
        return "?"
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def check_candidates_in_dir(stage: str, d: Path, cands: Iterable[str]) -> list[Path]:
    found: list[Path] = []
    if not d.exists() or not d.is_dir():
        return found
    for name in cands:
        p = d / name
        if p.exists() and p.is_file():
            found.append(p)
    return found


def scan_by_hash_in_dir(d: Path, hash_u32: int, limit: int = 25) -> list[Path]:
    if not d.exists() or not d.is_dir():
        return []
    pref = str(int(hash_u32) & 0xFFFFFFFF)
    out: list[Path] = []
    try:
        for e in d.iterdir():
            if not e.is_file():
                continue
            n = e.name
            if n.startswith(pref + ".") or n.startswith(pref + "_"):
                out.append(e)
                if len(out) >= max(1, int(limit)):
                    break
    except Exception:
        return []
    return out


def scan_by_substring_in_dir(d: Path, needle: str, limit: int = 25) -> list[Path]:
    """
    Fast-ish scan of a huge flat directory for filenames containing a substring.
    Uses os.scandir and stops after `limit` hits.
    """
    if not d.exists() or not d.is_dir():
        return []
    q = str(needle or "").strip().lower()
    if not q:
        return []
    out: list[Path] = []
    try:
        with os.scandir(d) as it:
            for ent in it:
                try:
                    if not ent.is_file():
                        continue
                    name = ent.name
                    if q in name.lower():
                        out.append(Path(ent.path))
                        if len(out) >= max(1, int(limit)):
                            break
                except Exception:
                    continue
    except Exception:
        return []
    return out


def _iter_cw_dict_items(d: object) -> Iterable[object]:
    """
    Iterate a pythonnet Dictionary-like object (CodeWalker dicts).
    Yields kv pairs (objects with .Key/.Value) or raw items.
    """
    if d is None:
        return []
    try:
        return list(d)
    except Exception:
        return []


def _safe_attr(obj: object, name: str, default=None):
    try:
        return getattr(obj, name, default)
    except Exception:
        return default


def _ytd_texture_names_lower(ytd_file: object) -> set[str]:
    """
    Enumerate texture names in a loaded CodeWalker YtdFile without decoding pixels.
    Returns a lowercase set.
    """
    out: set[str] = set()
    td = _safe_attr(ytd_file, "TextureDict", None)
    if td is None:
        return out

    # Try the same shapes as gta5_modules.rpf_reader.get_ytd_textures but without GetPixels().
    items = None
    tex_list = _safe_attr(td, "Textures", None)
    if tex_list is not None:
        items = _safe_attr(tex_list, "data_items", None) or None
        if not items:
            try:
                items = list(tex_list)
            except Exception:
                items = None

    if not items:
        d = _safe_attr(td, "Dict", None)
        if d is not None:
            vals = _safe_attr(d, "Values", None)
            if vals is not None:
                try:
                    items = list(vals)
                except Exception:
                    items = None
            if not items:
                try:
                    kvs = list(d)
                    extracted = []
                    for kv in kvs:
                        v = _safe_attr(kv, "Value", None)
                        if v is not None:
                            extracted.append(v)
                    items = extracted or None
                except Exception:
                    items = None

    if not items:
        return out

    for tex in items:
        try:
            n = str(_safe_attr(tex, "Name", "") or "").strip()
        except Exception:
            n = ""
        if n:
            out.add(n.lower())
    return out


def _norm_gta_path(p: str) -> str:
    return (str(p or "").replace("/", "\\").replace("\\\\", "\\").strip().lower())


def _cw_entry_source_info(entry: object) -> dict:
    """
    Best-effort extraction of the "where did this file come from" metadata.
    Mirrors webgl/gta5_modules/provenance_tools.py::entry_source_info but kept local
    so this tool can run standalone.
    """
    try:
        epath = str(_safe_attr(entry, "Path", "") or "")
    except Exception:
        epath = ""
    try:
        ename = str(_safe_attr(entry, "Name", "") or "")
    except Exception:
        ename = ""
    try:
        f = _safe_attr(entry, "File", None)
        rpf_path = str(_safe_attr(f, "Path", "") or "") if f is not None else ""
        rpf_name = str(_safe_attr(f, "Name", "") or "") if f is not None else ""
    except Exception:
        rpf_path = ""
        rpf_name = ""
    return {
        "source_rpf": rpf_path or None,
        "source_rpf_name": rpf_name or None,
        "source_path": _norm_gta_path(epath) or None,
        "name": ename or None,
    }


def _trace_source_ytd_best_effort(
    *,
    repo_root: Path,
    game_path: str,
    want_names: list[str],
    ytd_name_hint: str,
    max_ytd_scan: int,
    max_ytd_load: int,
) -> None:
    """
    Best-effort: locate which YTD contains a texture name.
    Uses the repo's CodeWalker-backed pythonnet stack (DllManager + GameFileCache).
    """
    want = [str(x or "").strip().lower() for x in want_names if str(x or "").strip()]
    if not want:
        print("\n[source] (skipped) no texture names to search")
        return

    # Import lazily so this script still runs without pythonnet/CodeWalker present.
    try:
        sys.path.insert(0, str(repo_root / "webgl"))
        from gta5_modules.dll_manager import DllManager  # type: ignore
        from gta5_modules.rpf_reader import RpfReader  # type: ignore
    except Exception as e:
        print("\n[source] FAILED to import gta5_modules (pythonnet/CodeWalker stack).")
        print("         error:", str(e))
        return

    print("\n[source] CodeWalker lookup enabled")
    print("  - game_path:", game_path)
    print("  - want texture names:", ", ".join(want[:6]) + (" ..." if len(want) > 6 else ""))

    try:
        # CodeWalker key loading expects gta5.exe (or gta5_enhanced.exe) to exist under game_path.
        gp = Path(game_path)
        exe = gp / "gta5.exe"
        exe_enh = gp / "gta5_enhanced.exe"
        if not exe.exists() and not exe_enh.exists():
            print("  - FAILED: could not find gta5.exe under --game-path")
            print("    Expected one of:")
            print(f"      - {exe}")
            print(f"      - {exe_enh}")
            print("    Fix: pass your real GTA install folder (the one that contains gta5.exe).")
            print("    Example:")
            print('      --game-path "C:\\\\Program Files (x86)\\\\Steam\\\\steamapps\\\\common\\\\Grand Theft Auto V"')
            return

        dm = DllManager(game_path)
        if not getattr(dm, "initialized", False):
            print("  - FAILED: DllManager not initialized (CodeWalker DLL load failed)")
            return
        ok = dm.init_game_file_cache()
        if not ok:
            print("  - FAILED: GameFileCache.Init() failed (required for YtdDict)")
            return
        gfc = dm.get_game_file_cache()
        ytd_dict = getattr(gfc, "YtdDict", None)
        if ytd_dict is None:
            print("  - FAILED: GameFileCache.YtdDict unavailable")
            return

        rr = RpfReader(str(game_path), dm)

        hint = str(ytd_name_hint or "").strip().lower()
        scanned = 0
        candidate_entries: list[object] = []
        for kv in _iter_cw_dict_items(ytd_dict):
            if scanned >= int(max_ytd_scan):
                break
            scanned += 1
            entry = _safe_attr(kv, "Value", None) or kv
            if entry is None:
                continue
            # Heuristic prefilter: only load YTDs whose entry name/path contains a hint token,
            # otherwise the scan can be very slow.
            if hint:
                try:
                    nm = str(_safe_attr(entry, "Name", "") or "").lower()
                    pth = str(_safe_attr(entry, "Path", "") or "").lower()
                    if hint not in nm and hint not in pth:
                        continue
                except Exception:
                    continue
            candidate_entries.append(entry)
            if len(candidate_entries) >= int(max_ytd_load):
                break

        print(f"  - YtdDict scanned={scanned} candidates={len(candidate_entries)} (hint='{hint}')")
        if not candidate_entries:
            print("  - No candidate YTD entries matched the hint; try passing a broader --ytd-hint (e.g. 'road' or 'im_').")
            return

        hits = 0
        for entry in candidate_entries:
            try:
                epath = str(_safe_attr(entry, "Path", "") or "")
                if not epath:
                    continue
                ytd = rr.get_ytd(epath)
                if not ytd:
                    continue
                names = _ytd_texture_names_lower(ytd)
                if not names:
                    continue
                if any(w in names for w in want):
                    hits += 1
                    info = _cw_entry_source_info(entry)
                    print("\n  HIT:")
                    print("    - ytd_path:", info.get("source_path") or _norm_gta_path(epath))
                    print("    - source_rpf:", info.get("source_rpf") or info.get("source_rpf_name"))
                    present = [w for w in want if w in names]
                    print("    - present textures:", ", ".join(present[:12]) + (" ..." if len(present) > 12 else ""))
            except Exception:
                continue

        if hits == 0:
            print("\n  - No YTD candidates contained the wanted texture names.")
            print("    This usually means either:")
            print("    - the hint is too narrow (didn't load the right YTD), or")
            print("    - the texture exists but under a different name than expected (naming mismatch).")
            print("    Try a broader --ytd-hint.")

    except Exception as e:
        print("\n[source] FAILED during CodeWalker lookup:", str(e))


def print_file_info(p: Path, viewer_root: Path) -> None:
    try:
        rel = p.relative_to(viewer_root).as_posix()
    except Exception:
        rel = str(p)
    try:
        size = p.stat().st_size
    except Exception:
        size = -1
    sig = sniff_bytes(_read_head(p, 64))
    print(f"    - {rel}  size={_fmt_size(size)}  sig={sig.kind}  ({sig.detail})")


def main() -> int:
    ap = argparse.ArgumentParser(description="Trace a model texture across export -> assets -> dist.")
    ap.add_argument("wanted", type=str, help="Texture URL/name/hash/filename (e.g. 123_slug.png, IM_Kerbs03_LOD, or a full URL)")
    ap.add_argument("--viewer-root", default="webgl/webgl_viewer", help="Viewer root containing assets/ and dist/ (default: webgl/webgl_viewer)")
    ap.add_argument("--scan-by-hash", action="store_true", help="If not found by exact candidate names, scan for any files starting with the hash prefix")
    ap.add_argument("--scan-limit", type=int, default=25, help="Max files to print per stage during hash-prefix scan (default: 25)")
    ap.add_argument("--no-suggest", action="store_true", help="Disable substring-based suggestions (useful for very slow disks)")
    ap.add_argument("--game-path", default="", help="Optional: GTA5 install path. Enables CodeWalker-backed lookup for source YTD/RPF.")
    ap.add_argument("--ytd-hint", default="", help="Optional: substring hint to filter YTD candidates (e.g. 'road', 'im_', 'sidewalk').")
    ap.add_argument("--max-ytd-scan", type=int, default=200000, help="Max YtdDict entries to scan (default: 200000)")
    ap.add_argument("--max-ytd-load", type=int, default=250, help="Max candidate YTDs to actually load/check (default: 250)")
    args = ap.parse_args()

    viewer_root = Path(args.viewer_root).resolve()
    if not viewer_root.exists():
        raise SystemExit(f"Missing viewer root: {viewer_root}")

    p = parse_wanted(args.wanted)
    cands = candidate_filenames(p)

    print("[trace] wanted:", p.raw)
    print("[trace] basename:", p.basename)
    if p.hash_u32 is not None:
        print(f"[trace] hash_u32: {p.hash_u32} (0x{p.hash_u32:08x})")
    else:
        print("[trace] hash_u32: (none)")
    if p.slug:
        print("[trace] slug:", p.slug)
    if p.is_texture_name and p.hash_u32 is not None:
        print("[trace] interpreted as texture name -> joaat hash")

    print("\n[candidates]")
    for x in cands:
        print("  -", x)

    any_found = False
    token_for_suggest = ""
    print("\n[stages]")
    for stage, d in iter_stage_dirs(viewer_root):
        if not d.exists():
            # Keep output concise; only mention missing dirs when they're likely relevant.
            continue
        found = check_candidates_in_dir(stage, d, cands)
        if found:
            any_found = True
            try:
                rel_dir = d.relative_to(viewer_root).as_posix()
            except Exception:
                rel_dir = str(d)
            print(f"\n  {stage}: {rel_dir}")
            for fp in found:
                print_file_info(fp, viewer_root)
        elif args.scan_by_hash and p.hash_u32 is not None:
            matches = scan_by_hash_in_dir(d, p.hash_u32, limit=args.scan_limit)
            if matches:
                any_found = True
                try:
                    rel_dir = d.relative_to(viewer_root).as_posix()
                except Exception:
                    rel_dir = str(d)
                print(f"\n  {stage}: {rel_dir}  (hash-prefix scan)")
                for fp in matches:
                    print_file_info(fp, viewer_root)

    print("\n[analysis]")
    if any_found:
        # Most common mismatch: requested hash_slug.png but only hash.png exists.
        if p.hash_u32 is not None:
            wanted_slugged = None
            if p.slug:
                wanted_slugged = f"{p.hash_u32}_{p.slug}.png"
            wanted_hash_only = f"{p.hash_u32}.png"
            if wanted_slugged and wanted_slugged in cands and wanted_hash_only in cands:
                print("  - If the viewer requested the slugged filename but only the hash-only variant exists,")
                print("    you have a naming mismatch between exporter and runtime resolver.")
                print("    Fix by exporting/copying the slugged filenames OR by adding a runtime fallback (slugged -> hash-only).")
        print("  - If dist has the file but assets doesn't: your sync/copy step is wrong (or stale build artifacts).")
        print("  - If assets has it but dist doesn't: your build sync step (sync_assets_to_dist.py) isn't copying it.")
        print("  - If output has it but assets doesn't: setup/copy step is missing that directory.")
    else:
        print("  - Not found in known stages.")
        if p.hash_u32 is not None and not args.scan_by_hash:
            print("  - Try re-run with --scan-by-hash to list any variants for this hash in each stage.")
        print("  - If this was a TextureStreamer URL that returned HTML, the server/router is likely rewriting /assets/... to index.html.")
        print("    (In Vite, ensure /assets is served as static files, not SPA fallback.)")

        # Helpful: when a requested *_n / *_s file is missing, it’s common that only *_lod / *_s_lod exists.
        # Suggest close matches by substring (bounded, so it won't crawl forever).
        if not args.no_suggest:
            # Derive a "base" token like "im_road_004" from "im_road_004_n".
            token = ""
            if p.slug:
                token = re.sub(r"(_n|_s|_d|_dif|_diffuse|_normal|_spec|_ao|_em|_emissive)$", "", p.slug)
                token = token or p.slug
            else:
                # If the basename is something like "123_slug.png", use the slug part.
                m = re.match(r"^\d+_([^\.]+)\.(png|jpg|jpeg|webp|gif|bmp)$", p.basename, re.IGNORECASE)
                if m:
                    token = str(m.group(1) or "")
            token = token.strip().lower()
            token_for_suggest = token
            if token:
                print(f"\n  - Suggestions (files containing '{token}'):")
                shown = 0
                for stage, d in iter_stage_dirs(viewer_root):
                    if shown >= 3:
                        break
                    if not d.exists() or not d.is_dir():
                        continue
                    matches = scan_by_substring_in_dir(d, token, limit=min(12, max(1, int(args.scan_limit))))
                    if not matches:
                        continue
                    shown += 1
                    try:
                        rel_dir = d.relative_to(viewer_root).as_posix()
                    except Exception:
                        rel_dir = str(d)
                    print(f"    {stage}: {rel_dir}")
                    for fp in matches:
                        print_file_info(fp, viewer_root)

    # Optional: trace back to source YTD/RPF using CodeWalker-backed parser.
    game_path = str(args.game_path or "").strip().strip('"').strip("'")
    if game_path:
        # Build a robust set of candidate texture names to look for in YTDs.
        #
        # Important: many of your missing URLs are for *_n / *_s variants, but the exporter may have only
        # produced *_lod / *_s_lod variants. So we search base-name variants too.
        want_set: set[str] = set()

        def add_name(x: str) -> None:
            xx = str(x or "").strip().lower()
            if xx:
                want_set.add(xx)

        # Prefer the parsed slug (from filenames or texture names).
        if p.slug:
            add_name(p.slug)
            # If slug is "im_road_004_n", base becomes "im_road_004".
            base = re.sub(r"(_n|_s|_d|_dif|_diffuse|_normal|_spec|_ao|_em|_emissive|_lod)$", "", p.slug)
            base = base or p.slug
            add_name(base)
            add_name(base + "_lod")
            add_name(base + "_n")
            add_name(base + "_s")
            add_name(base + "_d")

            # Some exports use *_s_lod naming.
            add_name(base + "_s_lod")
            add_name(base + "_n_lod")

        # If the input was a texture name (not a file), include that exact string too.
        if p.is_texture_name:
            add_name(p.basename)

        want_names = sorted(want_set)

        ytd_hint = str(args.ytd_hint or "").strip()
        if not ytd_hint:
            ytd_hint = token_for_suggest
            if ytd_hint and len(ytd_hint) > 24:
                ytd_hint = ytd_hint[:24]

        repo_root = viewer_root.parent.parent.resolve()  # .../webglgta
        _trace_source_ytd_best_effort(
            repo_root=repo_root,
            game_path=game_path,
            want_names=want_names,
            ytd_name_hint=ytd_hint,
            max_ytd_scan=int(args.max_ytd_scan or 200000),
            max_ytd_load=int(args.max_ytd_load or 250),
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


