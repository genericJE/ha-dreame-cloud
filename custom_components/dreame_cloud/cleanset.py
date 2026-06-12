"""Per-room cleanset parsing and serialization.

The robot stores per-room cleaning preferences in the map metadata under the
``cleanset`` key: a JSON object mapping a room/segment id to a small int
array. On the X50 Ultra Complete (and other CleanGenius / fine-wetness
models) the stored per-room array is::

    [suction, mop_wetness, cleaning_times, cleaning_order, cleaning_mode, mopping_settings]
      idx 0      idx 1         idx 2           idx 3           idx 4           idx 5

The official Dreame app's per-room **Mop Wetness** slider (1-32) is index 1.

Writing the cleanset back uses a *different* array shape — the ``customeClean``
write envelope — where the room id is prepended and the cleaning_order field
is dropped::

    [room_id, suction, mop_wetness, cleaning_times, cleaning_mode, mopping_settings]

The order asymmetry is deliberate and matches Tasshack/dreame-vacuum's
serializer: cleaning order is persisted through a separate ``cleanOrder``
write, not through ``customeClean``. Round-tripping the stored array by
naively prepending the room id would shove ``order`` into the
``cleaning_mode`` slot and corrupt the room, so the conversion goes through
:func:`to_custome_clean`, which drops index 3.

This module is pure (stdlib only) so it can be unit-tested in isolation and
later lifted into the ``dreame_mocker`` client library verbatim.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

# Per-room mop wetness slider range (max-32 / WETNESS_LEVEL model family).
WETNESS_MIN = 1
WETNESS_MAX = 32
WETNESS_DEFAULT = 16


def clamp_wetness(wetness: int) -> int:
    """Clamp a wetness value into the valid 1-32 range."""
    return max(WETNESS_MIN, min(WETNESS_MAX, int(wetness)))


@dataclass
class SegmentCleanset:
    """One room's stored cleaning preferences.

    ``cleaning_mode`` and ``mopping_settings`` are ``None`` when the stored
    array did not include them, so :func:`to_custome_clean` can reproduce the
    exact field width the device emitted (minus the dropped order field).
    """

    segment_id: int
    suction: int = 1
    wetness: int = WETNESS_DEFAULT
    cleaning_times: int = 1
    order: int | None = None
    cleaning_mode: int | None = 2
    mopping_settings: int | None = None
    extra: list[int] = field(default_factory=list)
    # The exact stored array as the device emitted it, kept so the stored
    # form can be reproduced byte-for-byte (see :func:`to_stored`).
    raw: list[int] = field(default_factory=list)


def parse_cleanset(raw: str | dict[str, Any] | None) -> dict[int, SegmentCleanset]:
    """Parse the stored ``cleanset`` (JSON string or dict) into segments.

    Returns ``{}`` for missing or unparseable input. Tolerant of short
    arrays: absent trailing fields become ``None`` so a round-trip preserves
    the original field width.
    """
    if not raw:
        return {}
    if isinstance(raw, str):
        try:
            data: Any = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    else:
        data = raw
    if not isinstance(data, dict):
        return {}

    out: dict[int, SegmentCleanset] = {}
    for key, value in data.items():
        try:
            seg_id = int(key)
            arr = [int(x) for x in value]
        except (ValueError, TypeError):
            continue
        out[seg_id] = SegmentCleanset(
            segment_id=seg_id,
            suction=arr[0] if len(arr) > 0 else 1,
            wetness=arr[1] if len(arr) > 1 else WETNESS_DEFAULT,
            cleaning_times=arr[2] if len(arr) > 2 else 1,
            order=arr[3] if len(arr) > 3 else None,
            cleaning_mode=arr[4] if len(arr) > 4 else None,
            mopping_settings=arr[5] if len(arr) > 5 else None,
            extra=arr[6:],
            raw=list(arr),
        )
    return out


def to_stored(segments: dict[int, SegmentCleanset]) -> dict[str, list[int]]:
    """Serialize segments back into the stored ``cleanset`` dict form.

    Reproduces the device's native read shape (room id key -> array
    *including* the cleaning_order field) so an optimistic in-memory update
    stays consistent with what a fresh map fetch would return. Fields are
    taken from the preserved :attr:`SegmentCleanset.raw` array, with the
    structured attributes patched over the top.
    """
    out: dict[str, list[int]] = {}
    for seg_id in sorted(segments):
        seg = segments[seg_id]
        arr = list(seg.raw) if seg.raw else [
            seg.suction,
            seg.wetness,
            seg.cleaning_times,
        ]
        if len(arr) > 0:
            arr[0] = seg.suction
        if len(arr) > 1:
            arr[1] = seg.wetness
        if len(arr) > 2:
            arr[2] = seg.cleaning_times
        out[str(seg_id)] = arr
    return out


def to_custome_clean(segments: dict[int, SegmentCleanset]) -> list[list[int]]:
    """Serialize segments into ``customeClean`` write rows.

    Each row is ``[room_id, suction, wetness, cleaning_times, cleaning_mode?,
    mopping_settings?, *extra]`` — the cleaning_order field is intentionally
    dropped (see module docstring). Rows are emitted in ascending room id so
    the payload is stable/diffable.
    """
    rows: list[list[int]] = []
    for seg_id in sorted(segments):
        seg = segments[seg_id]
        row = [seg.segment_id, seg.suction, seg.wetness, seg.cleaning_times]
        if seg.cleaning_mode is not None:
            row.append(seg.cleaning_mode)
        if seg.mopping_settings is not None:
            row.append(seg.mopping_settings)
        row.extend(seg.extra)
        rows.append(row)
    return rows


def apply_wetness(
    segments: dict[int, SegmentCleanset],
    segment_ids: Iterable[int],
    wetness: int,
) -> list[int]:
    """Set ``wetness`` (clamped) on the given segments in place.

    Returns the segment ids that were actually present and updated.
    """
    value = clamp_wetness(wetness)
    updated: list[int] = []
    for seg_id in segment_ids:
        seg = segments.get(int(seg_id))
        if seg is not None:
            seg.wetness = value
            if len(seg.raw) > 1:
                seg.raw[1] = value
            updated.append(seg.segment_id)
    return updated
