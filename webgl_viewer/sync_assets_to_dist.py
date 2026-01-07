import shutil
from pathlib import Path
import re
import os


def _copy_newer(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            return
    except Exception:
        pass
    shutil.copy2(src, dst)


_HASH_SLUG_PNG_RE = re.compile(r"^(?P<h>\d+)_.*\.png$", re.IGNORECASE)
_HASH_SLUG_KTX2_RE = re.compile(r"^(?P<h>\d+)_.*\.ktx2$", re.IGNORECASE)


def _ensure_hash_only_aliases(dir_path: Path) -> tuple[int, int]:
    """
    Ensure `<hash>.png` (and `<hash>.ktx2`) aliases exist for `<hash>_<slug>.*` exports.

    Why:
    - Some exports name files `models_textures/<hash>_<slug>.png` for readability.
    - The runtime often requests the hash-only form `models_textures/<hash>.png`.
    - Creating aliases avoids a huge volume of 404s.

    We prefer hardlinks to avoid duplicating disk usage; fall back to symlink, then copy.
    Returns (created_png, created_ktx2).
    """
    if not dir_path.exists() or not dir_path.is_dir():
        return 0, 0

    created_png = 0
    created_ktx2 = 0

    # Deterministic ordering: stable results across runs.
    for p in sorted(dir_path.glob("*")):
        if not p.is_file():
            continue
        name = p.name

        m_png = _HASH_SLUG_PNG_RE.match(name)
        if m_png:
            h = m_png.group("h")
            out = dir_path / f"{h}.png"
            if not out.exists():
                try:
                    os.link(p, out)
                except Exception:
                    try:
                        # Relative symlink is nicer for moving directories around.
                        out.symlink_to(p.name)
                    except Exception:
                        shutil.copy2(p, out)
                created_png += 1
            continue

        m_ktx2 = _HASH_SLUG_KTX2_RE.match(name)
        if m_ktx2:
            h = m_ktx2.group("h")
            out = dir_path / f"{h}.ktx2"
            if not out.exists():
                try:
                    os.link(p, out)
                except Exception:
                    try:
                        out.symlink_to(p.name)
                    except Exception:
                        shutil.copy2(p, out)
                created_ktx2 += 1
            continue

    return created_png, created_ktx2


def main() -> None:
    viewer_dir = Path(__file__).parent.resolve()
    src_root = viewer_dir / "assets"
    dist_root = viewer_dir / "dist"
    dst_root = dist_root / "assets"

    if not dist_root.exists():
        raise SystemExit(f"Missing {dist_root}. Run `npm run build` first.")
    if not src_root.exists():
        raise SystemExit(f"Missing {src_root}. Run `python setup_assets.py` first (or export assets).")

    copied = 0
    skipped_broken_symlinks = 0
    skipped_non_files = 0
    for p in src_root.rglob("*"):
        # Skip dirs early.
        if p.is_dir():
            continue

        # Linux gotcha: rglob() yields symlinks too. A broken symlink is not a dir, but copy2()
        # will fail when it tries to open the missing target. Treat broken symlinks as optional assets.
        if p.is_symlink() and not p.exists():
            skipped_broken_symlinks += 1
            continue

        # Only copy real files (avoid special entries / unexpected filesystem objects).
        if not p.is_file():
            skipped_non_files += 1
            continue

        rel = p.relative_to(src_root)
        out = dst_root / rel
        _copy_newer(p, out)
        copied += 1

    # After syncing, create hash-only aliases in dist to match runtime expectations.
    # Also do it in the source assets folder so local dev servers behave the same.
    src_mt = src_root / "models_textures"
    src_mt2 = src_root / "models_textures_ktx2"
    dst_mt = dst_root / "models_textures"
    dst_mt2 = dst_root / "models_textures_ktx2"
    src_png, src_ktx2 = _ensure_hash_only_aliases(src_mt)
    src_png2, src_ktx22 = _ensure_hash_only_aliases(src_mt2)
    dst_png, dst_ktx2 = _ensure_hash_only_aliases(dst_mt)
    dst_png2, dst_ktx22 = _ensure_hash_only_aliases(dst_mt2)

    msg = f"Synced runtime assets to dist: {copied} files -> {dst_root}"
    if skipped_broken_symlinks or skipped_non_files:
        msg += f" (skipped broken_symlinks={skipped_broken_symlinks}, non_files={skipped_non_files})"
    if (src_png + src_png2 + dst_png + dst_png2) or (src_ktx2 + src_ktx22 + dst_ktx2 + dst_ktx22):
        msg += (
            f" | hash-only aliases created:"
            f" src_png={src_png} src_png_ktx2dir={src_png2} dst_png={dst_png} dst_png_ktx2dir={dst_png2}"
            f" src_ktx2={src_ktx2 + src_ktx22} dst_ktx2={dst_ktx2 + dst_ktx22}"
        )
    print(msg)


if __name__ == "__main__":
    main()


