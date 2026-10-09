"""Unit tests for the pure per-room cleanset helpers."""

from __future__ import annotations

import json

from custom_components.dreame_cloud.cleanset import (
    apply_cleaning_times,
    apply_wetness,
    parse_cleanset,
    to_custome_clean,
    to_stored,
)

# Real X50 Ultra Complete cleanset: [suction, wetness, times, order, mode, flag].
STORED = json.dumps({
    "1": [1, 28, 3, 2, 2, 1],
    "2": [1, 28, 2, 3, 2, 1],
    "4": [3, 16, 3, 4, 0, 1],
})


def test_parse_round_trip() -> None:
    segments = parse_cleanset(STORED)
    assert sorted(segments) == [1, 2, 4]
    assert segments[1].cleaning_times == 3
    assert segments[4].cleaning_mode == 0
    assert to_stored(segments) == json.loads(STORED)
    # The write envelope prepends the id and drops the order field.
    assert to_custome_clean(segments)[0] == [1, 1, 28, 3, 2, 1]


def test_apply_cleaning_times() -> None:
    segments = parse_cleanset(STORED)
    assert apply_cleaning_times(segments, [1, 4, 99], 1) == [1, 4]
    assert to_stored(segments) == {
        "1": [1, 28, 1, 2, 2, 1],
        "2": [1, 28, 2, 3, 2, 1],
        "4": [3, 16, 1, 4, 0, 1],
    }
    assert to_custome_clean(segments) == [
        [1, 1, 28, 1, 2, 1],
        [2, 1, 28, 2, 2, 1],
        [4, 3, 16, 1, 0, 1],
    ]
    # Clamped to the 1-3 range the firmware accepts.
    apply_cleaning_times(segments, [2], 7)
    assert segments[2].cleaning_times == 3


def test_apply_wetness_keeps_other_fields() -> None:
    segments = parse_cleanset(STORED)
    assert apply_wetness(segments, ["2"], 40) == [2]
    assert to_stored(segments)["2"] == [1, 32, 2, 3, 2, 1]


def test_parse_tolerates_garbage() -> None:
    assert parse_cleanset(None) == {}
    assert parse_cleanset("not json") == {}
    assert parse_cleanset('{"x": "nope", "3": [2, 16]}')[3].cleaning_mode is None
