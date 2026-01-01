import shutil
from pathlib import Path


def _copy_newer(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            return
    except Exception:
        pass
    shutil.copy2(src, dst)


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
    for p in src_root.rglob("*"):
        if p.is_dir():
            continue
        rel = p.relative_to(src_root)
        out = dst_root / rel
        _copy_newer(p, out)
        copied += 1

    print(f"Synced runtime assets to dist: {copied} files -> {dst_root}")


if __name__ == "__main__":
    main()


