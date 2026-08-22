#!/usr/bin/env node

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants as zlibConstants, createBrotliCompress } from 'node:zlib';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const root = path.resolve(option('--root', '.'));
const quality = Math.max(0, Math.min(11, Number(option('--quality', '7')) || 7));
const minBytes = Math.max(0, Number(option('--min-bytes', '16384')) || 0);
const extensions = new Set(String(option('--extensions', '.bin,.json,.js,.html,.css'))
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile() && !entry.name.endsWith('.br')) yield file;
  }
}

let sourceBytes = 0;
let outputBytes = 0;
let written = 0;
let reused = 0;

for await (const file of files(root)) {
  if (!extensions.has(path.extname(file).toLowerCase())) continue;
  const sourceStat = await stat(file);
  if (sourceStat.size < minBytes) continue;
  const output = `${file}.br`;
  try {
    const outputStat = await stat(output);
    if (outputStat.mtimeMs >= sourceStat.mtimeMs) {
      sourceBytes += sourceStat.size;
      outputBytes += outputStat.size;
      reused++;
      continue;
    }
  } catch { /* encode below */ }

  const temporary = `${output}.${process.pid}.tmp`;
  await mkdir(path.dirname(output), { recursive: true });
  try {
    await pipeline(
      createReadStream(file),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: sourceStat.size,
        },
      }),
      createWriteStream(temporary),
    );
    await rename(temporary, output);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  const outputStat = await stat(output);
  sourceBytes += sourceStat.size;
  outputBytes += outputStat.size;
  written++;
  console.log(`${path.relative(root, file)} ${sourceStat.size} -> ${outputStat.size}`);
}

console.log(JSON.stringify({ root, quality, minBytes, written, reused, sourceBytes, outputBytes,
  reduction: sourceBytes ? Number((1 - outputBytes / sourceBytes).toFixed(4)) : 0 }, null, 2));
