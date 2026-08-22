#!/usr/bin/env python3
"""Extract browser map manifests from Duck Game LevelData (.lev) files.

This is a standalone binary reader. It consumes only the user's local Duck
Game Content files and writes JSON structural data; it never loads or runs the
desktop game executable.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import struct
from collections import Counter
from pathlib import Path
from typing import Any


PRIMITIVES = {
    1: '<i', 2: '<I', 3: '<h', 4: '<H', 5: '<b', 6: '<B',
    7: '<d', 8: '<f', 9: '<q', 10: '<Q', 12: '<?',
}


class LevelReadError(ValueError):
    pass


class Reader:
    def __init__(self, data: bytes, pos: int = 0, end: int | None = None):
        self.data, self.pos, self.end = data, pos, len(data) if end is None else end

    def take(self, count: int) -> bytes:
        if count < 0 or self.pos + count > self.end:
            raise LevelReadError(f"truncated binary data at {self.pos} (need {count} bytes)")
        value = self.data[self.pos:self.pos + count]
        self.pos += count
        return value

    def number(self, fmt: str) -> Any:
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def u8(self) -> int: return self.number('<B')
    def u16(self) -> int: return self.number('<H')
    def u32(self) -> int: return self.number('<I')
    def i32(self) -> int: return self.number('<i')
    def f32(self) -> float: return self.number('<f')

    def string(self) -> str:
        length = self.u16()
        if length == 0xFFFF:
            checkpoint = self.pos
            if self.u16() == 42252:
                length = self.i32()
            else:
                self.pos = checkpoint
        return self.take(length).decode('utf-8', 'replace')

    def bitbuffer(self, limit: int) -> bytes:
        length = self.u16()
        if length == 0xFFFF:
            length = self.i32()
        if length < 0 or self.pos + length > limit:
            raise LevelReadError('invalid BitBuffer length')
        return self.take(length)


def parse_array(reader: Reader, end: int) -> list[Any]:
    count = reader.i32()
    if count < 0 or count > 1_000_000:
        raise LevelReadError(f'invalid array size {count}')
    values: list[Any] = []
    for _ in range(count):
        if not reader.u8():
            values.append(None)
        else:
            values.append(parse_chunk(reader, root=False, class_name='DuckGame.BinaryClassChunk'))
    if reader.pos != end:
        reader.pos = end
    return values


def parse_value(reader: Reader, end: int, type_id: int | None, type_name: str | None) -> Any:
    type_base = type_name.split(',', 1)[0] if type_name else None
    if type_id == 11:
        return reader.string()
    if type_id in PRIMITIVES:
        return reader.number(PRIMITIVES[type_id])
    if type_base and type_base.endswith('BitBuffer'):
        return {'$bitbuffer': base64.b64encode(reader.bitbuffer(end)).decode('ascii')}
    if type_base and ('[]' in type_base or 'List`1' in type_base):
        return parse_array(reader, end)
    if type_base and type_base.startswith('DuckGame.'):
        return parse_chunk(reader, root=False, class_name=type_base)
    raw = reader.take(end - reader.pos)
    return {'$raw': base64.b64encode(raw).decode('ascii'), '$type': type_name or 'unknown'}


def parse_chunk(reader: Reader, root: bool, class_name: str = 'DuckGame.LevelData') -> dict[str, Any]:
    if root:
        magic = reader.number('<q')
        checksum = reader.u32()
    else:
        magic = checksum = None
    version = reader.u16()
    # Version 2 LevelData optionally contains an extra header chunk. Current
    # installed maps are v1, but preserving the header lets the reader fail
    # safely on future content instead of desynchronizing.
    if root and version > 1 and class_name.endswith('LevelData') and reader.u8():
        extra_type = reader.string()
        parse_chunk(reader, root=False, class_name=extra_type)
    size = reader.u32()
    end = reader.pos + size
    if end > reader.end:
        raise LevelReadError('chunk exceeds enclosing buffer')
    count = reader.u16()
    props: dict[str, Any] = {}
    for _ in range(count):
        name = reader.string()
        type_id = None
        type_name = None
        is_extra = name.startswith('@')
        if is_extra:
            name = name[1:]
            marker = reader.u8()
            if marker == 0xFF:
                props[name] = None
                continue
            if marker & 1:
                type_id = marker >> 1
            else:
                type_name = reader.string()
        length = reader.u32()
        value_end = reader.pos + length
        if value_end > end:
            raise LevelReadError(f'property {name} exceeds chunk')
        # These declared members omit their type marker.  Supply the type from
        # the owning game class so the stream stays aligned.
        try:
            if class_name.endswith('LevelData') and name == 'objects' and not is_extra:
                props[name] = parse_chunk(reader, root=False, class_name='DuckGame.LevelObjects')
            # LevelObjects has a strongly-typed List<BinaryClassChunk> property.
            elif class_name.endswith('LevelObjects') and name == 'objects' and not is_extra:
                props[name] = parse_array(reader, value_end)
            else:
                props[name] = parse_value(reader, value_end, type_id, type_name)
        except LevelReadError as error:
            raise LevelReadError(f'{class_name}.{name} at {reader.pos}: {error}') from error
        reader.pos = value_end
    reader.pos = end
    result = {'$class': class_name, '$version': version, 'properties': props}
    if root:
        result['$magic'] = magic
        result['$checksum'] = checksum
    return result


def container_things(chunk: dict[str, Any]) -> list[dict[str, Any]]:
    props = chunk.get('properties', {})
    if 'ThingContainer' not in str(props.get('type', '')):
        return []
    data = props.get('data', {})
    encoded = data.get('$bitbuffer') if isinstance(data, dict) else None
    block_type = str(props.get('blockType', 'DuckGame.Unknown'))
    if not encoded:
        return []
    binary = base64.b64decode(encoded)
    reader = Reader(binary)
    count = reader.i32()
    records = []
    # AutoBlock subclasses (including CityTileset) serialize four adjacency
    # shorts after each tile.  The concrete class name is not AutoBlock, but
    # its accompanying groupData payload is the reliable on-disk indicator.
    auto_block = 'groupData' in props
    for _ in range(max(0, min(count, 100_000))):
        x, y, frame = reader.f32(), reader.f32(), reader.u8()
        flip = frame == 255
        if flip:
            frame = reader.u8()
        if auto_block:
            reader.take(8)  # N/S/E/W adjacency indices
        if math.isfinite(x) and math.isfinite(y):
            records.append({'type': block_type, 'x': round(x, 4), 'y': round(y, 4), 'frame': frame, 'flipHorizontal': flip})
    return records


def level_object(chunk: dict[str, Any]) -> dict[str, Any] | None:
    """Return a browser-safe representation of a non-container level object."""
    props = chunk.get('properties', {})
    kind = props.get('type')
    if not isinstance(kind, str) or 'ThingContainer' in kind:
        return None
    value: dict[str, Any] = {'type': kind}
    for key, item in props.items():
        if key in {'type', 'ignore'} or isinstance(item, (dict, list)):
            continue
        if isinstance(item, float) and not math.isfinite(item):
            continue
        value[key] = item
    return value


def manifest(source: Path, level_root: Path) -> dict[str, Any]:
    tree = parse_chunk(Reader(source.read_bytes()), root=True)
    objects_chunk = tree['properties'].get('objects', {})
    roots = objects_chunk.get('properties', {}).get('objects', []) if isinstance(objects_chunk, dict) else []
    things = [thing for root in roots if isinstance(root, dict) for thing in container_things(root)]
    objects = [item for root in roots if isinstance(root, dict) if (item := level_object(root))]
    types = Counter(thing['type'] for thing in things)
    return {
        'schema': 'duck-game-level-v1',
        'source': source.relative_to(level_root).as_posix(),
        'rootChunks': len(roots),
        'objects': objects,
        'things': things,
        'thingCounts': dict(sorted(types.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('levels_dir', type=Path)
    parser.add_argument('output_dir', type=Path)
    parser.add_argument('--glob', default='deathmatch/**/*.lev')
    args = parser.parse_args()
    levels_dir, output_dir = args.levels_dir.resolve(), args.output_dir.resolve()
    failures: list[str] = []
    catalog: list[dict[str, str]] = []
    exported = 0
    for source in sorted(levels_dir.glob(args.glob)):
        if not source.is_file():
            continue
        try:
            result = manifest(source, levels_dir)
            destination = output_dir / source.relative_to(levels_dir).with_suffix('.json')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(result, separators=(',', ':')), encoding='utf-8')
            catalog.append({
                'name': source.stem,
                'source': result['source'],
                'path': destination.relative_to(output_dir).as_posix(),
            })
            exported += 1
        except Exception as error:
            failures.append(f'{source.name}: {error}')
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'index.json').write_text(json.dumps({
        'schema': 'duck-game-level-index-v1', 'maps': catalog,
    }, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({'exported': exported, 'failed': len(failures), 'failures': failures[:20]}))
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
