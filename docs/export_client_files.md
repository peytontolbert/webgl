# Export “client-loaded” files with CodeWalker

This repo includes a toolchain to **extract files from GTA V `.rpf` archives** using CodeWalker.

In practice, “client-loaded files” usually means assets your viewer/client needs (eg `.ymap`, `.ytyp`, `.ybn`, `.ytd`, `.ydr`, etc.), or sometimes compiled scripts (`.ysc`).

---

## Option A: export arbitrary files by glob (built-in)

Use `CodeWalker.Cli extract` to export any file type from a specific `.rpf`.

Example (export all `.ymap` from `update.rpf` into a folder):

```bash
/data/webglgta/webgl-gta/CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli extract \
  --game /data/webglgta/webgl-gta/gtav \
  --rpf /data/webglgta/webgl-gta/gtav/update/update.rpf \
  --glob "**\\*.ymap" \
  --outdir /data/webglgta/webgl-gta/output/_exported_ymaps \
  --preserve-paths true
```

Notes:
- `--glob` matches CodeWalker “entry paths” and therefore uses **backslashes**.
- `--preserve-paths true` keeps the internal folder structure.

---

## Option B: export compiled scripts (`.ysc`) (decrypt + decompress)

Raw extraction of `.ysc` bytes is usually not enough (scripts are typically encrypted/compressed in RPFS).

This repo adds a dedicated command:
- `CodeWalker.Cli extract-ysc` (alias: `extract-scripts`)

Example:

```bash
/data/webglgta/webgl-gta/CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli extract-ysc \
  --game /data/webglgta/webgl-gta/gtav \
  --rpf /data/webglgta/webgl-gta/gtav/update/update.rpf \
  --outdir /data/webglgta/webgl-gta/output/_exported_ysc \
  --glob "**\\*.ysc" \
  --preserve-paths true
```

---

## Option C: batch export scripts across many RPFS (Python wrapper)

Run:

```bash
python3 /data/webglgta/webgl-gta/scripts/export_client_scripts.py \
  --game /data/webglgta/webgl-gta/gtav \
  --outdir /data/webglgta/webgl-gta/output/client_scripts \
  --skip-empty
```

This will:
- scan for `.rpf` files under `--game`
- run `extract-ysc` per RPF into a per-RPF output subfolder
- write a manifest JSON: `export_client_scripts_manifest.json`

---

## If you meant “files the client *actually requests* at runtime”

Tell me what signal you have for that (eg a log file of requested paths, or a list of asset names),
and I can add a second exporter that reads that list and pulls *exactly* those files from the RPFS.


