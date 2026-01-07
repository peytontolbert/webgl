"""
Shared texture naming / path heuristics for the WebGL viewer pipeline.

These helpers are used by multiple offline tools to mirror the viewer runtime behavior.
Keep behavior stable: callers should not need to re-implement these in each tool.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Optional

from .hash_utils import joaat


_EXT_RE = re.compile(r"\.(png|ktx2|jpg|jpeg|webp|dds|gif|bmp)$", re.IGNORECASE)
_RE_MODEL_TEX_PREFIX = re.compile(r"^(model_texture|model_textures|models_texture)/", re.IGNORECASE)
_RE_MODELS_TEXTURES = re.compile(
    r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?(?P<ext>\.(png|dds|ktx2|jpg|jpeg|webp))$",
    re.IGNORECASE,
)
_RE_MODELS_TEXTURES_KTX2 = re.compile(
    r"^models_textures_ktx2/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?(?P<ext>\.(ktx2))$",
    re.IGNORECASE,
)


def normalize_asset_rel(rel: str) -> str:
    """
    Mirror viewer-side TexturePathResolver normalization for candidate generation:
    - strip leading slashes
    - strip leading "assets/"
    - normalize legacy prefixes:
        model_texture/... -> models_textures/...
        model_textures/... -> models_textures/...
        models_texture/... -> models_textures/...
    Returns an asset-relative path WITHOUT leading "assets/".
    """
    r0 = str(rel or "").strip()
    if not r0:
        return ""
    r = re.sub(r"^/+", "", r0)
    r = re.sub(r"^assets/", "", r, flags=re.IGNORECASE)
    r = _RE_MODEL_TEX_PREFIX.sub("models_textures/", r)
    return r


def looks_like_path_or_file(s: str) -> bool:
    """
    Heuristic used by viewer tooling: if it looks like a path/filename, treat it as an explicit path.
    """
    t = str(s or "").strip()
    if not t:
        return False
    if "/" in t or "\\" in t:
        return True
    if _EXT_RE.search(t):
        return True
    return False


def slugify_texture_name(name: str) -> str:
    """
    Match viewer-side ModelManager._slugifyTextureName.
    """
    s = str(name or "").strip().lower()
    if not s:
        return ""
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"^_+", "", s)
    s = re.sub(r"_+$", "", s)
    return s


def texture_rel_from_shader_param_value(v: str) -> Optional[str]:
    """
    Mirrors viewer-side ModelManager._textureRelFromShaderParamValue:
      - if v looks like a path or file, treat as manifest-relative and strip leading "assets/"
      - else treat as a texture name and map to models_textures/<joaat(name)>_<slug>.png (preferring hash+slug)
    """
    s0 = str(v or "").strip()
    if not s0:
        return None
    s = s0.replace("\\", "/")
    if looks_like_path_or_file(s):
        # Treat as an explicit asset-relative path (normalized like runtime).
        r = normalize_asset_rel(s)
        return r or None
    slug = slugify_texture_name(s0)
    h = joaat(s0, lower=True)
    if slug:
        return f"models_textures/{int(h) & 0xFFFFFFFF}_{slug}.png"
    return f"models_textures/{int(h) & 0xFFFFFFFF}.png"


def _index_entry_fields(ent: Any) -> tuple[str, Optional[bool]]:
    """
    Extract viewer index.json entry fields:
      { preferredFile: "...", hashOnly: bool, files: [...] }
    Returns (preferred_file, has_hash_only) where has_hash_only can be None if unknown.
    """
    if not isinstance(ent, dict):
        return "", None
    preferred = str(ent.get("preferredFile") or "").strip()
    has_hash_only = None
    if "hashOnly" in ent:
        try:
            has_hash_only = bool(ent.get("hashOnly"))
        except Exception:
            has_hash_only = None
    return preferred, has_hash_only


def iter_texture_candidate_rels_like_viewer(
    rel: str,
    *,
    base_index_entry: Any = None,
    pack_entries: Optional[Iterable[tuple[str, Any]]] = None,
) -> list[str]:
    """
    Generate candidate asset-relative paths in the same order as viewer-side TexturePathResolver.chooseTextureUrl,
    but without performing any network I/O.

    - `rel` may include leading "assets/" and legacy "model_textures/" prefixes; we normalize it.
    - `base_index_entry` is the base `assets/models_textures/index.json.byHash[hash]` object (or None).
    - `pack_entries` is an optional iterable of (rootRel, entry) for packs in priority order, where rootRel is
      relative to the assets mount WITHOUT the leading "assets/" (e.g. "packs/patchday27ng").
      Only the first pack entry is considered (highest priority), matching runtime behavior.
    """
    r = normalize_asset_rel(rel)
    if not r:
        return []

    candidates: list[str] = []

    def _dedupe_extend(items: Iterable[str]) -> None:
        for it in items:
            s = str(it or "")
            if not s:
                continue
            candidates.append(s)

    # 1) models_textures
    m = _RE_MODELS_TEXTURES.match(r)
    if m:
        h = str(m.group("hash") or "")
        ext = str(m.group("ext") or ".png")
        has_slug = bool(m.group("slug"))
        hash_only_rel = f"models_textures/{h}{ext}"

        # Packs (highest priority only, if provided with an entry)
        pack0 = None
        if pack_entries is not None:
            for root_rel, ent in pack_entries:
                root_rel = str(root_rel or "").strip().strip("/").lstrip("/")
                if not root_rel:
                    continue
                pack0 = (root_rel, ent)
                break
        if pack0 is not None:
            root_rel, ent = pack0
            preferred_file, has_hash_only = _index_entry_fields(ent)
            pref = f"{root_rel}/" if root_rel else ""
            if not has_slug:
                if preferred_file and (has_hash_only is False):
                    _dedupe_extend([f"{pref}models_textures/{preferred_file}"])
                _dedupe_extend([f"{pref}{hash_only_rel}"])
                if preferred_file and (f"{pref}models_textures/{preferred_file}" not in candidates):
                    _dedupe_extend([f"{pref}models_textures/{preferred_file}"])
            else:
                if preferred_file and (has_hash_only is False):
                    _dedupe_extend([f"{pref}models_textures/{preferred_file}"])
                _dedupe_extend([f"{pref}{hash_only_rel}", f"{pref}{r}"])
                if preferred_file and (f"{pref}models_textures/{preferred_file}" not in candidates) and (has_hash_only is False):
                    _dedupe_extend([f"{pref}models_textures/{preferred_file}"])

        # Base candidates
        preferred_file, has_hash_only = _index_entry_fields(base_index_entry)
        if not has_slug:
            if preferred_file and (has_hash_only is False) and (preferred_file != f"{h}{ext}"):
                _dedupe_extend([f"models_textures/{preferred_file}"])
            _dedupe_extend([hash_only_rel])
            if preferred_file and (f"models_textures/{preferred_file}" not in candidates) and (preferred_file != f"{h}{ext}"):
                _dedupe_extend([f"models_textures/{preferred_file}"])
        else:
            if preferred_file and (has_hash_only is False):
                _dedupe_extend([f"models_textures/{preferred_file}"])
            _dedupe_extend([hash_only_rel])

    # 2) models_textures_ktx2
    mk = _RE_MODELS_TEXTURES_KTX2.match(r)
    if mk:
        h = str(mk.group("hash") or "")
        ext = str(mk.group("ext") or ".ktx2")
        has_slug = bool(mk.group("slug"))
        hash_only_rel = f"models_textures_ktx2/{h}{ext}"

        pack0 = None
        if pack_entries is not None:
            for root_rel, ent in pack_entries:
                root_rel = str(root_rel or "").strip().strip("/").lstrip("/")
                if not root_rel:
                    continue
                pack0 = (root_rel, ent)
                break
        if pack0 is not None:
            root_rel, ent = pack0
            preferred_file, has_hash_only = _index_entry_fields(ent)
            pref = f"{root_rel}/" if root_rel else ""
            if not has_slug:
                if preferred_file and (has_hash_only is False):
                    _dedupe_extend([f"{pref}models_textures_ktx2/{preferred_file}"])
                _dedupe_extend([f"{pref}{hash_only_rel}"])
                if preferred_file and (f"{pref}models_textures_ktx2/{preferred_file}" not in candidates):
                    _dedupe_extend([f"{pref}models_textures_ktx2/{preferred_file}"])
            else:
                if preferred_file and (has_hash_only is False):
                    _dedupe_extend([f"{pref}models_textures_ktx2/{preferred_file}"])
                _dedupe_extend([f"{pref}{hash_only_rel}", f"{pref}{r}"])

        preferred_file, has_hash_only = _index_entry_fields(base_index_entry)
        if not has_slug:
            if preferred_file and (has_hash_only is False) and (preferred_file != f"{h}{ext}"):
                _dedupe_extend([f"models_textures_ktx2/{preferred_file}"])
            _dedupe_extend([hash_only_rel])
            if preferred_file and (f"models_textures_ktx2/{preferred_file}" not in candidates) and (preferred_file != f"{h}{ext}"):
                _dedupe_extend([f"models_textures_ktx2/{preferred_file}"])
        else:
            if preferred_file and (has_hash_only is False):
                _dedupe_extend([f"models_textures_ktx2/{preferred_file}"])
            _dedupe_extend([hash_only_rel])

    # Always include the normalized input at the end, like runtime.
    _dedupe_extend([r])

    # De-dupe preserving order.
    uniq: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        uniq.append(c)
    return uniq



