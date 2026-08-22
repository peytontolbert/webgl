#!/usr/bin/env python3
"""Regression checks for the Walmart native-shell takeover."""

from import_fivem_mlo_demo import _filter_mlo_takeover_records, _pack_ent1_record


def main() -> int:
    native_shell = _pack_ent1_record(
        2185785507,
        [70.8994, -1773.2747, 35.4353],
        [0, 0, 0, 1],
        [1, 1, 1],
    )
    unrelated_shell = _pack_ent1_record(
        2185785507,
        [170.8994, -1773.2747, 35.4353],
        [0, 0, 0, 1],
        [1, 1, 1],
    )
    roots = [{
        "archetypeHash": 3384310300,
        "position": [69.274155, -1776.3516, 28.290794],
        "parentGuid": 1513757628,
    }]

    retained, stats = _filter_mlo_takeover_records([native_shell, unrelated_shell], roots)
    assert retained == [unrelated_shell]
    assert stats["suppressedBaseInstanceCount"] == 1
    assert stats["suppressedBaseInstances"][0]["reason"] == "authored_override"
    print("Walmart MLO takeover: native shell suppressed without hiding unrelated instances")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
