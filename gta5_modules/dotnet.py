"""
.NET / Python.NET bootstrap helpers.

Why this exists:
- The project depends on pythonnet, which provides a `clr` extension module with
  `clr.AddReference(...)`.
- There is also a PyPI package named `clr` which *shadows* pythonnet's `clr`
  and does NOT have `AddReference`, causing:
    AttributeError: module 'clr' has no attribute 'AddReference'

This module makes loading robust and provides a single import point:
    from .dotnet import clr
"""

from __future__ import annotations

import importlib
import importlib.machinery
import importlib.util
import os
import sys
from types import ModuleType


def _load_clr_from_path(clr_path: str) -> ModuleType:
    """Force-load pythonnet's extension module from an explicit path (e.g. clr.pyd)."""
    loader = importlib.machinery.ExtensionFileLoader("clr", clr_path)
    spec = importlib.util.spec_from_file_location("clr", clr_path, loader=loader)
    if spec is None:
        raise ImportError(f"Unable to create import spec for pythonnet clr at: {clr_path}")
    module = importlib.util.module_from_spec(spec)
    # Register before exec to avoid re-entrancy issues during import.
    sys.modules["clr"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _try_import_pythonnet_clr() -> ModuleType:
    """
    Try to obtain pythonnet's `clr` even if a conflicting `clr` package is installed.
    """
    # 1) Ensure pythonnet runtime is loaded (pythonnet>=3 exposes pythonnet.load()).
    # This is important because pythonnet installs the namespace import hook during load.
    # Without that, `clr.AddReference(...)` can succeed but `import Some.Namespace` fails.
    try:
        import pythonnet  # type: ignore

        if hasattr(pythonnet, "load"):
            runtime = os.environ.get("PYTHONNET_RUNTIME")
            # Default to CoreCLR on Windows so we can load modern net7+ assemblies.
            if not runtime and os.name == "nt":
                runtime = "coreclr"
            try:
                pythonnet.load(runtime) if runtime else pythonnet.load()
            except TypeError:
                # Some builds expose load() without args.
                pythonnet.load()
            except Exception:
                # Fall back to default load if the explicit runtime name isn't available.
                pythonnet.load()
    except Exception:
        pythonnet = None  # continue

    # 2) Fast path: normal import works and has expected API.
    try:
        clr_mod = importlib.import_module("clr")
        if hasattr(clr_mod, "AddReference"):
            return clr_mod
    except Exception:
        clr_mod = None  # continue

    # 3) If `import clr` still yields the wrong module, force-load clr.pyd.
    try:
        clr_mod = importlib.import_module("clr")
        if hasattr(clr_mod, "AddReference"):
            return clr_mod
    except Exception:
        pass

    # 3) If `import clr` still yields the wrong module, force-load pythonnet's extension module.
    #
    # On Windows this is typically `clr.pyd`.
    # On Linux/macOS this is typically `clr<suffix>.so` (e.g. clr.cpython-311-x86_64-linux-gnu.so).
    #
    # Use Python's extension suffixes so we don't hard-code platform naming.
    suffixes = list(getattr(importlib.machinery, "EXTENSION_SUFFIXES", []) or [])
    # Keep common fallback names even if EXTENSION_SUFFIXES is missing/mangled.
    for sfx in [".pyd", ".so", ".dylib"]:
        if sfx not in suffixes:
            suffixes.append(sfx)

    candidates: list[str] = []

    def _add_candidates_from_dir(base: str) -> None:
        if not base:
            return
        for sfx in suffixes:
            candidates.append(os.path.join(base, "clr" + sfx))

    # Prefer pythonnet installation location if available.
    try:
        import pythonnet  # type: ignore

        pythonnet_dir = os.path.dirname(getattr(pythonnet, "__file__", "") or "")
        for base in [pythonnet_dir, os.path.dirname(pythonnet_dir)]:
            _add_candidates_from_dir(base)
    except Exception:
        pass

    # Fall back to searching sys.path (site-packages).
    for p in sys.path:
        _add_candidates_from_dir(p)

    for clr_path in candidates:
        if os.path.isfile(clr_path):
            forced = _load_clr_from_path(clr_path)
            if hasattr(forced, "AddReference"):
                return forced

    # 4) Give a clear error that tells the user exactly what to fix.
    # If we did manage to import some `clr`, include where it came from for debugging.
    imported_where = getattr(clr_mod, "__file__", None) if clr_mod is not None else None
    where_msg = f"\nDetected `clr` module at: {imported_where}" if imported_where else ""
    fix_lines = [
        "Failed to load Python.NET's `clr` module.",
        "This project requires `pythonnet` so that `clr.AddReference(...)` works.",
        "Common cause: the PyPI package named `clr` is installed and shadows pythonnet.",
    ]
    if where_msg:
        fix_lines.append(where_msg.strip("\n"))
    fix_lines += [
        "",
        "Fix:",
        "  python -m pip uninstall -y clr",
        "  python -m pip install -U pythonnet",
        "",
    ]
    if os.name != "nt":
        fix_lines += [
            "Linux note:",
            "  CodeWalker (and SharpDX) are commonly run under Mono on Linux.",
            "  Try one of these before running again:",
            "    export PYTHONNET_RUNTIME=mono",
            "    unset PYTHONNET_RUNTIME",
            "",
        ]
    raise RuntimeError("\n".join(fix_lines))


# Public, canonical `clr` handle for the rest of the codebase.
clr = _try_import_pythonnet_clr()


