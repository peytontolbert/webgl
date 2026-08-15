#!/usr/bin/env python3
"""Import collection-safe clothing and chain contracts from a remote FiveM server."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path


DEFAULT_ROOT = "/data/NexusAI/fivem_server"


def ssh(remote: str, command: str) -> str:
    result = subprocess.run(
        ["ssh", remote, command], capture_output=True, text=True, check=True, encoding="utf-8"
    )
    return result.stdout


def remote_files(remote: str, path: str) -> list[dict]:
    output = ssh(remote, f"find '{path}' -type f -printf '%P\\t%s\\n'")
    rows = []
    for line in output.splitlines():
        relative, separator, size = line.rpartition("\t")
        if not separator:
            continue
        suffix = Path(relative).suffix.lower().lstrip(".")
        rows.append({"path": relative.replace("\\", "/"), "bytes": int(size), "type": suffix})
    return sorted(rows, key=lambda row: row["path"].lower())


def parse_chain_items(source: str) -> dict[str, dict]:
    pattern = re.compile(
        r"\['(?P<id>chain_[^']+)'\].*?\['label'\]\s*=\s*'(?P<label>[^']+)'.*?"
        r"\['image'\]\s*=\s*'(?P<image>[^']+)'",
        re.DOTALL,
    )
    return {
        match.group("id"): {
            "id": match.group("id"),
            "label": match.group("label").strip(),
            "image": match.group("image").strip(),
        }
        for match in pattern.finditer(source)
    }


def parse_server_events(source: str) -> dict[str, str]:
    pattern = re.compile(
        r'CreateUseableItem\("(?P<item>chain_[^"]+)".*?'
        r'TriggerClientEvent\("(?P<event>chains:client:[^"]+)"',
        re.DOTALL,
    )
    return {match.group("event"): match.group("item") for match in pattern.finditer(source)}


def parse_chain_variations(client: str, event_items: dict[str, str], items: dict[str, dict]) -> list[dict]:
    pattern = re.compile(
        r"RegisterNetEvent\(['\"](?P<event>chains:client:[^'\"]+)['\"].*?"
        r"SetPedComponentVariation\(ped,\s*(?P<component>\d+),\s*(?P<drawable>\d+)"
        r"(?:,\s*(?P<texture>\d+))?",
        re.DOTALL,
    )
    result = []
    for match in pattern.finditer(client):
        event = match.group("event")
        item_id = event_items.get(event)
        if not item_id:
            continue
        row = dict(items.get(item_id, {"id": item_id, "label": item_id, "image": None}))
        row.update({
            "event": event,
            "componentId": int(match.group("component")),
            "drawable": int(match.group("drawable")),
            "texture": int(match.group("texture") or 0),
        })
        result.append(row)
    return sorted(result, key=lambda row: row["id"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", default="peyton@192.168.0.85")
    parser.add_argument("--fivem-root", default=DEFAULT_ROOT)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "assets" / "fivem_appearance_contracts.json",
    )
    args = parser.parse_args()

    clothing_root = f"{args.fivem_root}/resources/[clothing]/clothingpack5m"
    chains_root = f"{args.fivem_root}/resources/[nx]/nx-mod-chains"
    clothing_files = remote_files(args.remote, clothing_root)
    chain_files = remote_files(args.remote, chains_root)
    items_source = ssh(args.remote, f"cat '{chains_root}/items.txt'")
    client_source = ssh(args.remote, f"cat '{chains_root}/client.lua'")
    server_source = ssh(args.remote, f"cat '{chains_root}/server.lua'")
    items = parse_chain_items(items_source)
    chains = parse_chain_variations(client_source, parse_server_events(server_source), items)

    payload = {
        "schema": "webglgta-fivem-appearance-contracts-v1",
        "source": {"remote": args.remote, "fivemRoot": args.fivem_root},
        "clothingpack5m": {
            "collectionQualified": True,
            "renderStatus": "requires_ydd_ytd_conversion",
            "files": clothing_files,
        },
        "nxChains": {
            "componentId": 7,
            "renderStatus": "requires_ydd_ytd_conversion",
            "items": chains,
            "files": chain_files,
        },
        "summary": {
            "clothingFiles": len(clothing_files),
            "clothingBytes": sum(row["bytes"] for row in clothing_files),
            "clothingYdd": sum(row["type"] == "ydd" for row in clothing_files),
            "clothingYtd": sum(row["type"] == "ytd" for row in clothing_files),
            "chainFiles": len(chain_files),
            "chainBytes": sum(row["bytes"] for row in chain_files),
            "chainItems": len(chains),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
