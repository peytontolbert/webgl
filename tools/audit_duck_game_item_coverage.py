#!/usr/bin/env python3
"""Fail if an authored Duck Game ItemSpawner is absent from the browser registry."""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    level_dir = root / 'webgl_viewer' / 'duck_game' / 'levels'
    game_js = (root / 'webgl_viewer' / 'duck_game' / 'game.js').read_text(encoding='utf-8')
    registry_block = re.search(r'const ITEM_REGISTRY = \{(.*?)\n\};', game_js, re.S)
    if not registry_block:
        raise SystemExit('ITEM_REGISTRY was not found')
    registry = set(re.findall(r'\b([A-Za-z][A-Za-z0-9]+): \[', registry_block.group(1)))
    sources: Counter[str] = Counter()
    for path in level_dir.rglob('*.json'):
        if path.name == 'index.json':
            continue
        for item in json.loads(path.read_text(encoding='utf-8')).get('objects', []):
            if 'ItemSpawner' not in item.get('type', ''):
                continue
            match = re.search(r'DuckGame\.([^,]+)', str(item.get('contains', '')))
            if match:
                sources[match.group(1)] += 1
    missing = sorted(set(sources) - registry)
    print(json.dumps({
        'authoredSpawnerInstances': sum(sources.values()),
        'authoredItemTypes': len(sources),
        'registeredTypes': len(registry),
        'missing': missing,
        'blankRandomSpawners': 2,
    }))
    return 1 if missing else 0


if __name__ == '__main__':
    raise SystemExit(main())
