# RPF support in the WebGL viewer (browser)

This viewer historically only loaded **pre-extracted** assets from `assets/` over HTTP.  
We’ve now added an **experimental in-browser RPF explorer** that can mount a local `*.rpf` file and extract a file by path.

## What works now

- **Mount a local `.rpf`** via file picker
- **Parse RPF7** header + entry table + names table (CodeWalker-compatible)
- **Directory/file path lookup** (case-insensitive; `\` or `/` accepted)
- **Extract a file** and trigger a browser download
- **Deflate decompression** when the browser supports `DecompressionStream('deflate')`

## What does NOT work yet

- **TOC encryption** (RPF header `Encryption` = AES or NG)  
  This requires GTA5 keys (CodeWalker derives them from `gta5.exe` / `gta5_enhanced.exe` or a provided key).
- **Encrypted file payloads** (some file entries are flagged encrypted)
- **Nested RPFs** (RPFs inside RPFs)
- **Direct “play the game from RPF”**  
  The current rendering pipeline still expects the **pre-exported** mesh/texture formats in `assets/`.

## How to use

1. Run/open the viewer.
2. In the left controls panel, open **“RPF (experimental)”**.
3. Click **“Mount .rpf file…”** and select an RPF (e.g. `update.rpf`, `x64a.rpf`).
4. In **“Extract file (path inside RPF)”**, enter a path such as:
   - `common\data\levels\gta5\...`
   - or `update.rpf\common\data\levels\gta5\...`
5. Click **“Extract to download”**.

## Files added/changed

- `webgl/webgl_viewer/js/rpf/rpf_archive.js`: RPF7 parser + extractor
- `webgl/webgl_viewer/js/vfs/readers.js`: random-access readers (local Blob/File + HTTP Range)
- `webgl/webgl_viewer/index.html`: UI controls for mounting/extracting
- `webgl/webgl_viewer/js/main.js`: wiring for the UI
- `webgl/webgl_viewer/js/manifest_worker.js`: uses `asset_fetcher.js` instead of raw `fetch()`


