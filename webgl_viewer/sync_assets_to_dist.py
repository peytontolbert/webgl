import shutil
from pathlib import Path
import argparse
import re
import os


def _iter_runtime_files(root: Path, skip_counts: dict[str, int] | None = None):
    """Yield (relative path string, absolute Path, stat) using scandir for large Windows trees."""
    stack: list[tuple[str, str]] = [("", os.fspath(root))]
    while stack:
        rel_dir, abs_dir = stack.pop()
        try:
            with os.scandir(abs_dir) as it:
                entries = list(it)
        except FileNotFoundError:
            continue
        except OSError:
            if skip_counts is not None:
                skip_counts["non_files"] = skip_counts.get("non_files", 0) + 1
            continue

        for entry in entries:
            rel = entry.name if not rel_dir else rel_dir + os.sep + entry.name
            try:
                if entry.is_dir(follow_symlinks=False):
                    # Local Assetto Corsa-derived profiles are developer-only
                    # calibration data. Keep them available to a local Vite
                    # server but never copy them into a deployment bundle.
                    if rel.replace("\\", "/") == "physics/assetto-corsa":
                        continue
                    stack.append((rel, entry.path))
                    continue
                if entry.is_symlink() and not os.path.exists(entry.path):
                    if skip_counts is not None:
                        skip_counts["broken_symlinks"] = skip_counts.get("broken_symlinks", 0) + 1
                    continue
                if not entry.is_file(follow_symlinks=True):
                    if skip_counts is not None:
                        skip_counts["non_files"] = skip_counts.get("non_files", 0) + 1
                    continue
                yield rel, Path(entry.path), entry.stat(follow_symlinks=True)
            except FileNotFoundError:
                if skip_counts is not None:
                    skip_counts["broken_symlinks"] = skip_counts.get("broken_symlinks", 0) + 1
            except OSError:
                if skip_counts is not None:
                    skip_counts["non_files"] = skip_counts.get("non_files", 0) + 1


def _collect_dst_tree(root: Path) -> tuple[dict[str, os.stat_result | None], list[Path]]:
    files: dict[str, os.stat_result | None] = {}
    dirs: list[Path] = []
    stack: list[tuple[str, str]] = [("", os.fspath(root))]
    while stack:
        rel_dir, abs_dir = stack.pop()
        try:
            with os.scandir(abs_dir) as it:
                entries = list(it)
        except FileNotFoundError:
            continue
        except OSError:
            continue

        for entry in entries:
            rel = entry.name if not rel_dir else rel_dir + os.sep + entry.name
            try:
                if entry.is_dir(follow_symlinks=False):
                    dirs.append(Path(entry.path))
                    stack.append((rel, entry.path))
                    continue
                try:
                    files[rel] = entry.stat(follow_symlinks=True)
                except OSError:
                    files[rel] = None
            except OSError:
                files[rel] = None
    return files, dirs


def _copy_newer(src: Path, dst: Path, src_stat: os.stat_result, dst_stat: os.stat_result | None) -> bool:
    if dst_stat is not None:
        try:
            if dst_stat.st_size == src_stat.st_size and dst_stat.st_mtime >= src_stat.st_mtime:
                return False
        except Exception:
            pass
    shutil.copy2(src, dst)
    return True


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
    ap = argparse.ArgumentParser()
    ap.add_argument("--prune", action="store_true", help="Delete files from dist/assets that no longer exist in assets")
    ap.add_argument("--only", action="append", default=[], help="Sync only this relative assets path (repeatable; cannot be combined with --prune)")
    args = ap.parse_args()
    if args.prune and args.only:
        ap.error("--only cannot be combined with --prune")

    viewer_dir = Path(__file__).parent.resolve()
    src_root = viewer_dir / "assets"
    dist_root = viewer_dir / "dist"
    dst_root = dist_root / "assets"

    if not dist_root.exists():
        raise SystemExit(f"Missing {dist_root}. Run `npm run build` first.")
    if not src_root.exists():
        raise SystemExit(f"Missing {src_root}. Run `python setup_assets.py` first (or export assets).")

    dst_files, dst_dirs = _collect_dst_tree(dst_root) if dst_root.exists() else ({}, [])
    scanned = 0
    updated = 0
    skip_counts = {"broken_symlinks": 0, "non_files": 0}
    seen = set()
    selected_roots: list[tuple[str, Path]] = []
    for raw in args.only:
        rel = str(raw).replace("\\", "/").strip("/")
        if not rel or rel.startswith("../") or "/../" in rel:
            ap.error(f"--only must stay below assets/: {raw!r}")
        source = (src_root / rel).resolve()
        try:
            source.relative_to(src_root.resolve())
        except ValueError:
            ap.error(f"--only must stay below assets/: {raw!r}")
        if not source.exists():
            ap.error(f"--only path does not exist: {rel}")
        selected_roots.append((rel, source))
    if not selected_roots:
        selected_roots.append(("", src_root))

    for prefix, selected in selected_roots:
        if selected.is_file():
            rows = [(prefix, selected, selected.stat())]
        else:
            rows = ((f"{prefix}{os.sep if prefix else ''}{rel}", p, src_stat) for rel, p, src_stat in _iter_runtime_files(selected, skip_counts))
        for rel, p, src_stat in rows:
            seen.add(rel)
            out = dst_root / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            if _copy_newer(p, out, src_stat, dst_files.get(rel)):
                updated += 1
            scanned += 1

    # After syncing, create hash-only aliases in dist to match runtime expectations.
    # Also do it in the source assets folder so local dev servers behave the same.
    if args.only:
        src_png = src_ktx2 = src_png2 = src_ktx22 = dst_png = dst_ktx2 = dst_png2 = dst_ktx22 = 0
    else:
        src_mt = src_root / "models_textures"
        src_mt2 = src_root / "models_textures_ktx2"
        dst_mt = dst_root / "models_textures"
        dst_mt2 = dst_root / "models_textures_ktx2"
        src_png, src_ktx2 = _ensure_hash_only_aliases(src_mt)
        src_png2, src_ktx22 = _ensure_hash_only_aliases(src_mt2)
        dst_png, dst_ktx2 = _ensure_hash_only_aliases(dst_mt)
        dst_png2, dst_ktx22 = _ensure_hash_only_aliases(dst_mt2)

    msg = f"Synced runtime assets to dist: scanned={scanned} updated={updated} -> {dst_root}"
    if skip_counts["broken_symlinks"] or skip_counts["non_files"]:
        msg += f" (skipped broken_symlinks={skip_counts['broken_symlinks']}, non_files={skip_counts['non_files']})"
    if (src_png + src_png2 + dst_png + dst_png2) or (src_ktx2 + src_ktx22 + dst_ktx2 + dst_ktx22):
        msg += (
            f" | hash-only aliases created:"
            f" src_png={src_png} src_png_ktx2dir={src_png2} dst_png={dst_png} dst_png_ktx2dir={dst_png2}"
            f" src_ktx2={src_ktx2 + src_ktx22} dst_ktx2={dst_ktx2 + dst_ktx22}"
        )

    # Alias creation can add new files after the first copy pass. Re-scan the source tree
    # before pruning so freshly created aliases are treated as live runtime assets.
    created_aliases = src_png + src_png2 + src_ktx2 + src_ktx22
    if created_aliases:
        seen = set()
        for rel, _p, _src_stat in _iter_runtime_files(src_root):
            seen.add(rel)

    pruned = 0
    if args.prune and dst_root.exists():
        for rel in dst_files:
            if rel in seen:
                continue
            try:
                (dst_root / rel).unlink()
            except FileNotFoundError:
                pass
            pruned += 1
        for d in sorted(dst_dirs, key=lambda p: len(p.parts), reverse=True):
            try:
                d.rmdir()
            except OSError:
                pass

    print(msg)
    if args.prune:
        print(f"Pruned stale dist assets: {pruned} files")


if __name__ == "__main__":
    main()


