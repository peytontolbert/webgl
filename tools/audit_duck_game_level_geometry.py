#!/usr/bin/env python3
"""Check browser level data for geometry and authored-spawn safety."""
from __future__ import annotations

import json
import math
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1] / 'webgl_viewer' / 'duck_game' / 'levels'
    maps = [path for path in root.rglob('*.json') if path.name != 'index.json']
    invalid: list[str] = []
    unsupported_spawns: list[str] = []
    counts = {'maps': 0, 'tiles': 0, 'spawns': 0, 'hazards': 0, 'springs': 0, 'teleporters': 0}
    for path in maps:
        level = json.loads(path.read_text(encoding='utf-8'))
        tiles = level.get('things', [])
        objects = level.get('objects', [])
        counts['maps'] += 1
        counts['tiles'] += len(tiles)
        if not tiles:
            invalid.append(f'{path.name}: no tiles')
            continue
        for tile in tiles:
            if not math.isfinite(tile.get('x', float('nan'))) or not math.isfinite(tile.get('y', float('nan'))):
                invalid.append(f'{path.name}: non-finite tile coordinate')
                break
        for spawn in (obj for obj in objects if 'FreeSpawn' in obj.get('type', '')):
            counts['spawns'] += 1
            supported = any(spawn['x'] >= tile['x'] - 8 and spawn['x'] <= tile['x'] + 24 and tile['y'] >= spawn['y'] - 8 for tile in tiles)
            if not supported:
                unsupported_spawns.append(f"{path.name}: ({spawn['x']}, {spawn['y']})")
        counts['hazards'] += sum(bool(__import__('re').search(r'Spikes|Icicles|Mine', obj.get('type', ''))) for obj in objects)
        counts['springs'] += sum('Spring' in obj.get('type', '') for obj in objects)
        counts['teleporters'] += sum('Teleporter' in obj.get('type', '') for obj in objects)
    print(json.dumps({**counts, 'invalid': invalid, 'unsupportedSpawns': unsupported_spawns}))
    return 1 if invalid or unsupported_spawns else 0


if __name__ == '__main__':
    raise SystemExit(main())
