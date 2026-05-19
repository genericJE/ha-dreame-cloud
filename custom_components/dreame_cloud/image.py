"""Image platform for Dreame Cloud Vacuum floor plan."""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import struct
import zlib
from datetime import UTC, datetime
from typing import Any, cast

import numpy as np
from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from PIL import Image, ImageDraw

from dreame_mocker.client import DreameMap, MapHeader

from . import DreameCloudConfigEntry
from .const import (
    COLOR_BACKGROUND,
    COLOR_CHARGER,
    COLOR_WALL,
    CONF_MAP_FLIP_X,
    CONF_MAP_FLIP_Y,
    CONF_MAP_ROTATION,
    ROOM_COLORS,
    default_room_name,
)
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the image platform."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([DreameCloudMapImage(hass, coordinator)])


class DreameCloudMapImage(DreameCloudEntity, ImageEntity):
    """Image entity showing the vacuum floor plan."""

    _attr_translation_key = "floor_plan"
    _attr_content_type = "image/png"

    def __init__(
        self, hass: HomeAssistant, coordinator: DreameCloudCoordinator
    ) -> None:
        """Initialize."""
        DreameCloudEntity.__init__(self, coordinator)
        ImageEntity.__init__(self, hass)
        self._attr_unique_id = f"{coordinator.device_id}_floor_plan"
        self._image: bytes | None = None
        self._map_attrs: dict[str, Any] = {}
        self._last_frame_id: int | None = None
        self._last_opts: tuple[int, bool, bool] | None = None
        self._last_pending: dict[str, Any] | None = None

    async def async_added_to_hass(self) -> None:
        """Register for option updates when added to hass."""
        await super().async_added_to_hass()
        self.async_on_remove(
            self.coordinator.config_entry.add_update_listener(
                self._async_options_updated
            )
        )

    @staticmethod
    async def _async_options_updated(
        hass: HomeAssistant, entry: DreameCloudConfigEntry
    ) -> None:
        """Trigger a coordinator update when map options change."""
        coordinator: DreameCloudCoordinator = entry.runtime_data
        coordinator.async_set_updated_data(coordinator.data)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return map metadata for the frontend card."""
        return self._map_attrs

    def _handle_coordinator_update(self) -> None:
        """Re-render map when coordinator data changes."""
        self.hass.async_create_task(self._async_rerender())

    async def _async_rerender(self) -> None:
        """Re-render the map image and update state if anything changed."""
        map_data = (
            self.coordinator.data.map_data if self.coordinator.data else None
        )
        if map_data is None:
            return

        frame_id = map_data.header.frame_id
        options = self.coordinator.config_entry.options
        opts_key = (
            options.get(CONF_MAP_ROTATION, 0),
            options.get(CONF_MAP_FLIP_X, False),
            options.get(CONF_MAP_FLIP_Y, False),
        )
        pending = self.coordinator.pending_zone_update
        pending_changed = pending is not self._last_pending
        if frame_id != self._last_frame_id or opts_key != self._last_opts or pending_changed:
            self._image, self._map_attrs = await self.hass.async_add_executor_job(
                _render_map, map_data, *opts_key, pending,
            )
            self._last_frame_id = frame_id
            self._last_opts = opts_key
            self._last_pending = pending
            self._attr_image_last_updated = datetime.now(UTC)
        self.async_write_ha_state()

    async def async_image(self) -> bytes | None:
        """Return the current map image."""
        return self._image


def _transform_pixel(
    x: int,
    y: int,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> tuple[int, int]:
    """Transform a 0-based pixel coordinate to final image coords."""
    cur_w, cur_h = w, h
    if flip_x:
        x = (cur_w - 1) - x
    if flip_y:
        y = (cur_h - 1) - y
    for _ in range(rotation // 90):
        x, y = cur_h - 1 - y, x
        cur_w, cur_h = cur_h, cur_w
    return x * scale, y * scale


def _compute_room_bboxes(
    pixel_array: np.ndarray[Any, np.dtype[np.uint8]],
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
    rooms: dict[int, Any],
    live_to_rism: dict[int, int] | None = None,
) -> dict[str, dict[str, Any]]:
    """Compute room bounding boxes in final image coordinates.

    When ``live_to_rism`` is provided and non-empty, live pixel-grid
    segments are grouped by the rism ID they map to and a single bbox
    per rism ID is emitted. This is needed on devices (X50 family)
    where the firmware allocates volatile SLAM-internal IDs in the
    live grid that bear no relation to the user-facing IDs in the
    saved map. Without this grouping, one user room can render as
    multiple disjoint rectangles, and the IDs sent back via
    ``clean_segment`` won't match what the device's cleanset expects.

    When ``live_to_rism`` is empty, falls back to one bbox per live
    segment (the legacy behavior, correct when seg_inf is in the live
    frame).
    """
    room_ids = pixel_array & 0x3F
    is_wall = (pixel_array & 0x80).astype(bool)

    # Decide which IDs to emit and how to group live pixels.
    use_rism = bool(live_to_rism)
    if use_rism:
        # Group: rism_id -> list of live_ids that map to it.
        groups: dict[int, list[int]] = {}
        for live_id, rism_id in live_to_rism.items():
            groups.setdefault(rism_id, []).append(live_id)
        emit_ids: list[int] = sorted(groups.keys())
    else:
        # Legacy: one entry per live ID present in the pixel grid.
        emit_ids = list(range(1, 64))
        groups = {sid: [sid] for sid in emit_ids}

    valid_ids = set(rooms.keys()) if rooms and not use_rism else None

    result: dict[str, dict[str, Any]] = {}
    for seg_id in emit_ids:
        if valid_ids is not None and seg_id not in valid_ids:
            continue
        # Union mask over all live IDs in this group.
        group_live_ids = groups[seg_id]
        mask = np.zeros_like(is_wall)
        for live_id in group_live_ids:
            mask |= room_ids == live_id
        mask &= ~is_wall
        if not mask.any():
            continue

        pixel_count = int(mask.sum())
        ys, xs = np.where(mask)
        min_x, max_x = int(xs.min()), int(xs.max())
        min_y, max_y = int(ys.min()), int(ys.max())

        # Transform all four corners to image coords
        corners = [
            (min_x, min_y),
            (max_x, min_y),
            (min_x, max_y),
            (max_x, max_y),
        ]
        transformed = [
            _transform_pixel(cx, cy, w, h, flip_x, flip_y, rotation, scale)
            for cx, cy in corners
        ]
        txs = [t[0] for t in transformed]
        tys = [t[1] for t in transformed]
        bx = min(txs)
        by = min(tys)
        bw = max(txs) - bx
        bh = max(tys) - by

        room_info = rooms.get(seg_id)
        name = default_room_name(
            seg_id,
            getattr(room_info, "name", "") or "",
            getattr(room_info, "room_type", -1),
        )
        color = list(ROOM_COLORS[(seg_id - 1) % len(ROOM_COLORS)])

        result[str(seg_id)] = {
            "name": name,
            "segment_id": seg_id,
            "color": color,
            "x": bx,
            "y": by,
            "w": bw,
            "h": bh,
            "center_x": bx + bw // 2,
            "center_y": by + bh // 2,
            "pixel_count": pixel_count,
        }

    return result


def _vacuum_to_image(
    vx: int,
    vy: int,
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> tuple[int, int]:
    """Convert vacuum coordinates to final image coordinates.

    Vacuum coords and header.left/top share the same coordinate system.
    Pixel index = (vac_coord - header.left) / pixel_size.
    """
    px = round((vx - header.left) / header.pixel_size)
    py = round((vy - header.top) / header.pixel_size)
    return _transform_pixel(px, py, w, h, flip_x, flip_y, rotation, scale)


def _transform_no_go_zones(
    metadata: dict[str, Any],
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> list[dict[str, Any]]:
    """Transform no-go zones (vw.rect) to image coordinates.

    No-go zones use the ``vw.rect`` key in the Dreame protocol. This is
    distinct from ``sneak_areas`` which are low-clearance/low-lying zones.
    """
    vw: Any = metadata.get("vw", {})
    zones: list[Any] = []
    if isinstance(vw, dict):
        vw_d = cast(dict[str, Any], vw)
        zones = cast(list[Any], vw_d.get("rect", []))
    # Flat list format: vw is [x1,y1,x2,y2,...] line segments, not zones
    if not zones:
        return []

    result: list[dict[str, Any]] = []
    for zone in zones:
        zone_d = cast(dict[str, Any], zone) if isinstance(zone, dict) else None
        roi: list[int] = cast(list[int], zone_d.get("roi", [])) if zone_d else cast(list[int], zone)
        if not isinstance(roi, list):  # pyright: ignore[reportUnnecessaryIsInstance]
            continue
        # Saved map uses 5-value format [x1,y1,x2,y2,flag] (2 corners).
        # Expand to 8-value format [x1,y1,x2,y1,x2,y2,x1,y2] (4 corners).
        if len(roi) >= 4 and len(roi) < 8:
            x1, y1, x2, y2 = int(roi[0]), int(roi[1]), int(roi[2]), int(roi[3])
            roi = [x1, y1, x2, y1, x2, y2, x1, y2]
        elif len(roi) != 8:
            continue
        points: list[dict[str, int]] = []
        for i in range(0, 8, 2):
            ix, iy = _vacuum_to_image(
                int(roi[i]), int(roi[i + 1]), header, w, h, flip_x, flip_y, rotation, scale,
            )
            points.append({"x": ix, "y": iy})
        result.append({
            "id": zone_d.get("id") if zone_d else None,
            "points": points,
            "roi": roi,
        })
    return result


def _transform_virtual_walls(
    metadata: dict[str, Any],
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> list[dict[str, Any]]:
    """Transform virtual walls (vw.line and ai_outborders_user) to image coordinates."""
    walls: list[dict[str, Any]] = []

    # Virtual wall lines from "vw.line" (Dreame protocol)
    vw: Any = metadata.get("vw", {})
    line_list: list[Any] = []
    if isinstance(vw, dict):
        vw_d = cast(dict[str, Any], vw)
        line_list = cast(list[Any], vw_d.get("line", []))
    elif isinstance(vw, list):
        # Legacy flat format: each entry is [x1, y1, x2, y2]
        line_list = cast(list[Any], vw)

    for wall_raw in line_list:
        if not isinstance(wall_raw, list):
            continue
        wall: list[Any] = cast(list[Any], wall_raw)
        if len(wall) >= 4:
            wall: list[Any] = cast(list[Any], wall_raw)
            p1 = _vacuum_to_image(
                int(wall[0]), int(wall[1]), header, w, h, flip_x, flip_y, rotation, scale,
            )
            p2 = _vacuum_to_image(
                int(wall[2]), int(wall[3]), header, w, h, flip_x, flip_y, rotation, scale,
            )
            walls.append({
                "x1": p1[0], "y1": p1[1],
                "x2": p2[0], "y2": p2[1],
                "vacuum_coords": wall[:4],
            })

    # User-defined outborders
    borders: list[Any] = cast(list[Any], metadata.get("ai_outborders_user", []))
    for border in borders:
        if isinstance(border, dict):
            border_d = cast(dict[str, Any], border)
            roi: list[int] = cast(list[int], border_d.get("roi", []))
            if len(roi) >= 4:
                p1 = _vacuum_to_image(
                    int(roi[0]), int(roi[1]), header, w, h, flip_x, flip_y, rotation, scale,
                )
                p2 = _vacuum_to_image(
                    int(roi[2]), int(roi[3]), header, w, h, flip_x, flip_y, rotation, scale,
                )
                walls.append({
                    "x1": p1[0], "y1": p1[1],
                    "x2": p2[0], "y2": p2[1],
                    "vacuum_coords": roi[:4],
                })

    return walls


def _transform_rect_zones(
    metadata: dict[str, Any],
    key: str,
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> list[dict[str, Any]]:
    """Transform rectangular zones (same format as sneak_areas) to image coords."""
    zones: list[Any] = cast(list[Any], metadata.get(key, []))
    if not zones:
        return []

    result: list[dict[str, Any]] = []
    for zone in zones:
        if not isinstance(zone, dict):
            continue
        zone_d = cast(dict[str, Any], zone)
        # hide: 0 = visible, 1 = auto-hidden, 2 = manually hidden
        if zone_d.get("hide", 0):
            continue
        roi: list[int] = cast(list[int], zone_d.get("roi", []))
        if len(roi) != 8:
            continue
        points: list[dict[str, int]] = []
        for i in range(0, 8, 2):
            ix, iy = _vacuum_to_image(
                int(roi[i]), int(roi[i + 1]), header, w, h, flip_x, flip_y, rotation, scale,
            )
            points.append({"x": ix, "y": iy})
        result.append({
            "id": cast(int | None, zone_d.get("id")),
            "type": cast(int, zone_d.get("type", 0)),  # 0 = auto-detected, 1 = manual
            "points": points,
            "roi": roi,
        })
    return result


def _compute_carpet_zones(
    pixel_array: np.ndarray[Any, Any],
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> list[dict[str, Any]]:
    """Compute carpet zone bounding boxes from pixel-level carpet flags (0x40)."""
    is_carpet = (pixel_array & 0x40).astype(bool) & ~(pixel_array & 0x80).astype(bool)
    if not is_carpet.any():
        return []

    # Simple connected-component labeling via flood fill
    visited = np.zeros_like(is_carpet)
    zones: list[dict[str, Any]] = []
    zone_id = 0

    for start_y in range(h):
        for start_x in range(w):
            if not is_carpet[start_y, start_x] or visited[start_y, start_x]:
                continue
            # BFS flood fill
            zone_id += 1
            min_x, max_x, min_y, max_y = start_x, start_x, start_y, start_y
            stack = [(start_y, start_x)]
            pixel_count = 0
            while stack:
                cy, cx = stack.pop()
                if cy < 0 or cy >= h or cx < 0 or cx >= w:
                    continue
                if visited[cy, cx] or not is_carpet[cy, cx]:
                    continue
                visited[cy, cx] = True
                pixel_count += 1
                min_x = min(min_x, cx)
                max_x = max(max_x, cx)
                min_y = min(min_y, cy)
                max_y = max(max_y, cy)
                stack.extend([
                    (cy - 1, cx), (cy + 1, cx),
                    (cy, cx - 1), (cy, cx + 1),
                ])

            # Skip tiny carpet blobs (< 20 pixels)
            if pixel_count < 20:
                continue

            # Apply transforms matching room bbox computation
            def _tx(px: int, py: int) -> tuple[int, int]:
                if flip_x:
                    px = w - 1 - px
                if flip_y:
                    py = h - 1 - py
                if rotation == 90:
                    px, py = h - 1 - py, px
                elif rotation == 180:
                    px, py = w - 1 - px, h - 1 - py
                elif rotation == 270:
                    px, py = py, w - 1 - px
                return px * scale, py * scale

            p1 = _tx(min_x, min_y)
            p2 = _tx(max_x, max_y)
            x1 = min(p1[0], p2[0])
            y1 = min(p1[1], p2[1])
            x2 = max(p1[0], p2[0])
            y2 = max(p1[1], p2[1])

            zones.append({
                "id": zone_id,
                "points": [
                    {"x": x1, "y": y1},
                    {"x": x2, "y": y1},
                    {"x": x2, "y": y2},
                    {"x": x1, "y": y2},
                ],
                "pixel_count": pixel_count,
            })

    return zones


# Furniture type IDs from Dreame firmware (FurnitureType enum).
# Reference: Tasshack/dreame-vacuum dev branch types.py
_FURNITURE_TYPES: dict[int, str] = {
    1: "Single Bed",
    2: "Double Bed",
    3: "Armchair",
    4: "Two Seat Sofa",
    5: "Three Seat Sofa",
    6: "Dining Table",
    7: "Nightstand",
    8: "Coffee Table",
    9: "Toilet",
    10: "Litter Box",
    11: "Pet Bed",
    12: "Food Bowl",
    13: "Pet Toilet",
    14: "Refrigerator",
    15: "Washing Machine",
    16: "Enclosed Litter Box",
    17: "Air Conditioner",
    18: "TV Cabinet",
    19: "Bookshelf",
    20: "Shoe Cabinet",
    21: "Wardrobe",
    22: "Greenery",
    23: "Floor Mirror",
    24: "L-Shaped Sofa",
    25: "Round Coffee Table",
    26: "Table",
}


def _transform_threshold_lines(
    vws: dict[str, Any],
    sub_key: str,
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> list[dict[str, Any]]:
    """Transform threshold line segments (vws.vwsl, vws.npthrsd, vws.cliff) to image coords."""
    lines: list[Any] = cast(list[Any], vws.get(sub_key, []))
    if not lines:
        return []

    result: list[dict[str, Any]] = []
    for line_raw in lines:
        if not isinstance(line_raw, list):
            continue
        line: list[Any] = cast(list[Any], line_raw)
        if len(line) < 4:
            continue
        p1 = _vacuum_to_image(
            int(line[0]), int(line[1]), header, w, h, flip_x, flip_y, rotation, scale,
        )
        p2 = _vacuum_to_image(
            int(line[2]), int(line[3]), header, w, h, flip_x, flip_y, rotation, scale,
        )
        result.append({
            "x1": p1[0], "y1": p1[1],
            "x2": p2[0], "y2": p2[1],
            "vacuum_coords": line[:4],
        })
    return result


def _transform_ramps(
    vws: dict[str, Any],
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> list[dict[str, Any]]:
    """Transform ramp areas (vws.ramp) to image coordinates.

    Each ramp entry is [x1, y1, x2, y2, type] where the coords define a
    rectangular area and type indicates the ramp kind.
    """
    ramps: list[Any] = cast(list[Any], vws.get("ramp", []))
    if not ramps:
        return []

    result: list[dict[str, Any]] = []
    for ramp_raw in ramps:
        if not isinstance(ramp_raw, list):
            continue
        ramp: list[Any] = cast(list[Any], ramp_raw)
        if len(ramp) < 4:
            continue
        # Transform the two corners that define the rectangle
        p1 = _vacuum_to_image(
            int(ramp[0]), int(ramp[1]), header, w, h, flip_x, flip_y, rotation, scale,
        )
        p2 = _vacuum_to_image(
            int(ramp[2]), int(ramp[3]), header, w, h, flip_x, flip_y, rotation, scale,
        )
        x1 = min(p1[0], p2[0])
        y1 = min(p1[1], p2[1])
        x2 = max(p1[0], p2[0])
        y2 = max(p1[1], p2[1])
        result.append({
            "points": [
                {"x": x1, "y": y1},
                {"x": x2, "y": y1},
                {"x": x2, "y": y2},
                {"x": x1, "y": y2},
            ],
            "type": ramp[4] if len(ramp) > 4 else 0,
            "vacuum_coords": ramp[:4],
        })
    return result


def _transform_furniture(
    metadata: dict[str, Any],
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> list[dict[str, Any]]:
    """Transform ai_furniture_user to image coordinates."""
    items: list[Any] = cast(list[Any], metadata.get("ai_furniture_user", []))
    if not items:
        return []

    result: list[dict[str, Any]] = []
    for item_raw in items:
        if not isinstance(item_raw, list):
            continue
        item: list[Any] = cast(list[Any], item_raw)
        if len(item) < 8:
            continue
        # [cx, cy, type, flag, cx2, cy2, width, height, user_flag?]
        cx: int = int(item[4])
        cy: int = int(item[5])  # center position
        fw: int = int(item[6])
        fh: int = int(item[7])  # dimensions in vacuum coords
        ftype: int = int(item[2])

        # Compute corners and transform
        half_w = fw // 2
        half_h = fh // 2
        corners: list[tuple[int, int]] = [
            (cx - half_w, cy - half_h),
            (cx + half_w, cy - half_h),
            (cx + half_w, cy + half_h),
            (cx - half_w, cy + half_h),
        ]
        points: list[dict[str, int]] = []
        for vx, vy in corners:
            ix, iy = _vacuum_to_image(
                vx, vy, header, w, h, flip_x, flip_y, rotation, scale,
            )
            points.append({"x": ix, "y": iy})

        # Compute bounding box from transformed points
        xs: list[int] = [p["x"] for p in points]
        ys: list[int] = [p["y"] for p in points]

        result.append({
            "type": ftype,
            "name": _FURNITURE_TYPES.get(ftype, f"Object {ftype}"),
            "x": min(xs),
            "y": min(ys),
            "w": max(xs) - min(xs),
            "h": max(ys) - min(ys),
            "center_x": (min(xs) + max(xs)) // 2,
            "center_y": (min(ys) + max(ys)) // 2,
            "vacuum_cx": cx,
            "vacuum_cy": cy,
            "vacuum_w": fw,
            "vacuum_h": fh,
        })
    return result


def _decode_rism_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Decode the ``rism`` (saved map) blob and return its JSON metadata.

    The live map frame often omits zone configuration (vw, vws).  The
    saved map embedded in ``rism`` contains the authoritative copy of
    these settings.  Returns an empty dict if rism is absent or invalid.

    Decode pipeline: URL-safe base64 -> zlib decompress -> skip 27-byte
    header + pixel grid -> parse trailing JSON.
    """
    rism = metadata.get("rism")
    if not rism or not isinstance(rism, str):
        return {}
    try:
        # URL-safe base64 decode
        b64 = rism.replace("-", "+").replace("_", "/")
        pad = 4 - (len(b64) % 4)
        if pad != 4:
            b64 += "=" * pad
        decoded = base64.b64decode(b64)
        decompressed = zlib.decompress(decoded)

        # Skip 27-byte header, then width*height pixel bytes
        hdr_fmt = "<2hb11h"
        hdr_size = struct.calcsize(hdr_fmt)  # 27
        if len(decompressed) < hdr_size:
            return {}
        vals = struct.unpack_from(hdr_fmt, decompressed)
        width, height = vals[10], vals[11]
        pixel_end = hdr_size + width * height
        if len(decompressed) <= pixel_end:
            return {}

        return dict(json.loads(decompressed[pixel_end:]))
    except Exception:
        _LOGGER.debug("Failed to decode rism saved map", exc_info=True)
        return {}


# Dreame path ("tr") format: a string of operator-prefixed coordinate
# pairs. Each point is `<op><x>,<y>` where op is one letter.
#
# Op letters:
#   - M, S, W: absolute coords; sets the cleaning mode for following
#     points (Mop, Sweep, sWeep+mop). Each occurrence starts a NEW
#     cleaning run, so consumers should split segments here.
#   - L: relative offset from previous point; inherits the cleaning
#     mode of the most recent S/M/W marker (it's a continuation line
#     within the same run, not a separate "travel" path).
#   - l: absolute coords, used in P-frames only to connect across map
#     frames; carries the current type forward.
#
# Capital L is relative, lowercase l is absolute — opposite of standard
# SVG. Coordinates are in vacuum coords (same mm space as
# header.left/top). Reference: Tasshack/dreame-vacuum dreame/map.py
# (DreameMapVacuumMapDecoder + map_renderer path emit logic).
_PATH_POINT_RE = re.compile(r"(?P<op>[MWSLl])(?P<x>-?\d+),(?P<y>-?\d+)")

# Single source of truth for path-type ordering (consumer loops).
_PATH_TYPE_NAMES: tuple[str, ...] = ("sweep", "mop", "sweep_and_mop")
_PATH_OP_TO_TYPE: dict[str, str] = {
    "S": "sweep",
    "M": "mop",
    "W": "sweep_and_mop",
}


def _parse_path_string(tr: str) -> list[tuple[str, str, int, int]]:
    """Parse the ``tr`` path string into ``(op, type, x, y)`` points.

    The input is a concatenated string of ``<op><x>,<y>`` tokens. Returns
    one tuple per point in traversal order with absolute coords. The raw
    ``op`` is preserved so callers can tell ``S``/``M``/``W`` markers
    (each starts a new cleaning run) apart from ``L`` continuations
    inside the current run.

    ``L`` ops carry relative offsets; everything else is absolute.
    Cleaning type is inherited from the most recent ``S``/``M``/``W``.
    """
    points: list[tuple[str, str, int, int]] = []
    cur_x, cur_y = 0, 0
    cur_type = "sweep"  # default if path starts mid-stream without marker
    for m in _PATH_POINT_RE.finditer(tr):
        op = m.group("op")
        x = int(m.group("x"))
        y = int(m.group("y"))
        if op == "L":
            cur_x += x
            cur_y += y
        elif op == "l":
            cur_x, cur_y = x, y
        else:
            cur_x, cur_y = x, y
            cur_type = _PATH_OP_TO_TYPE[op]
        points.append((op, cur_type, cur_x, cur_y))
    return points


def _transform_path(
    metadata: dict[str, Any],
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> dict[str, list[list[dict[str, int]]]]:
    """Transform the ``tr`` path to image coords, grouped by type.

    Returns a dict of ``{type: [segment, ...]}`` where each segment is a
    list of ``{x, y}`` image-coord points. A new segment starts whenever
    the path type changes, so consumers can draw each type with its own
    style (e.g. dashed travel vs. solid cleaning) without mixing them.
    """
    tr = metadata.get("tr")
    result: dict[str, list[list[dict[str, int]]]] = {
        name: [] for name in _PATH_TYPE_NAMES
    }
    if not isinstance(tr, str) or not tr:
        return result

    points = _parse_path_string(tr)
    if not points:
        return result

    # Each S/M/W marker starts a NEW cleaning run; subsequent L points
    # extend the current run. We render runs as separate polylines so
    # the gap between them isn't drawn as a fake "travel" line across
    # the map. (This matches Tasshack's renderer.)
    current_type: str | None = None
    current_segment: list[dict[str, int]] = []
    for op, ptype, vx, vy in points:
        ix, iy = _vacuum_to_image(
            vx, vy, header, w, h, flip_x, flip_y, rotation, scale,
        )
        point = {"x": ix, "y": iy}
        # A non-L op (S/M/W/l) starts a new run. L extends the current.
        if op != "L":
            if current_segment and current_type is not None:
                result[current_type].append(current_segment)
            current_type = ptype
            current_segment = [point]
        else:
            current_segment.append(point)

    if current_segment and current_type is not None:
        result[current_type].append(current_segment)

    return result


def _render_map(
    map_data: DreameMap,
    rotation: int = 0,
    flip_x: bool = False,
    flip_y: bool = False,
    pending_zone_update: dict[str, Any] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """Render map data to a PNG image and compute metadata attributes."""
    header = map_data.header
    w, h = header.width, header.height

    if w == 0 or h == 0:
        img = Image.new("RGB", (1, 1), COLOR_BACKGROUND)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue(), {}

    # Parse pixel data into numpy array
    raw = map_data.pixels[: w * h]
    pixel_array = np.frombuffer(raw, dtype=np.uint8).reshape(h, w)
    room_ids = pixel_array & 0x3F
    is_wall = (pixel_array & 0x80).astype(bool)
    is_carpet = (pixel_array & 0x40).astype(bool)

    # Build RGB image array
    img_array = np.full((h, w, 3), COLOR_BACKGROUND, dtype=np.uint8)

    # Color rooms
    for room_id in range(1, 64):
        mask = (room_ids == room_id) & ~is_wall
        if not mask.any():
            continue
        color = ROOM_COLORS[(room_id - 1) % len(ROOM_COLORS)]
        img_array[mask] = color

        # Darken carpet areas
        carpet_mask = mask & is_carpet
        if carpet_mask.any():
            img_array[carpet_mask] = np.clip(
                img_array[carpet_mask].astype(np.int16) - 30, 0, 255
            ).astype(np.uint8)

    # Color walls
    img_array[is_wall] = COLOR_WALL

    # Apply orientation transforms
    if flip_x:
        img_array = np.flip(img_array, axis=1)
    if flip_y:
        img_array = np.flip(img_array, axis=0)
    if rotation:
        img_array = np.rot90(img_array, k=-(rotation // 90))

    h_out, w_out = img_array.shape[:2]

    # Compute scale factor
    scale = max(1, 800 // max(w_out, h_out))

    img = Image.fromarray(img_array, "RGB")
    draw = ImageDraw.Draw(img)

    # The X50 reports sentinel positions (32766/32767) when the device is
    # idle on the dock — the lidar is asleep so it has no live-localized
    # position to share. Fall back to the rism saved map's charger coords
    # (the dock doesn't move) and treat a sentinel robot as "at dock"
    # rather than rendering nothing.
    sentinel_threshold = 32000
    rism = map_data.rism
    cx_v, cy_v = header.charger_x, header.charger_y
    if (abs(cx_v) >= sentinel_threshold or abs(cy_v) >= sentinel_threshold) and rism is not None:
        cx_v, cy_v = rism.header.charger_x, rism.header.charger_y

    rx_v, ry_v, robot_angle_raw = header.robot_x, header.robot_y, header.robot_angle
    if abs(rx_v) >= sentinel_threshold or abs(ry_v) >= sentinel_threshold:
        # Robot is at the dock; place it on the charger.
        rx_v, ry_v = cx_v, cy_v
        if rism is not None:
            robot_angle_raw = rism.header.charger_angle

    # Draw charger
    cx, cy = _vacuum_to_image(
        cx_v, cy_v, header, w, h, flip_x, flip_y, rotation, 1
    )
    if 0 <= cx < w_out and 0 <= cy < h_out:
        r = max(3, min(w_out, h_out) // 60)
        draw.rectangle([cx - r, cy - r, cx + r, cy + r], fill=COLOR_CHARGER)

    # Robot position (for frontend overlay, not drawn on PNG)
    rx, ry = _vacuum_to_image(
        rx_v, ry_v, header, w, h, flip_x, flip_y, rotation, 1
    )

    # Transform robot angle through the same flip/rotation pipeline.
    # Vacuum angle: 0 = east, CCW positive (standard math convention).
    robot_angle = robot_angle_raw
    if flip_x:
        robot_angle = 180 - robot_angle
    if flip_y:
        robot_angle = -robot_angle
    robot_angle += rotation
    robot_angle %= 360

    # Scale up for better visibility
    if scale > 1:
        img = img.resize((w_out * scale, h_out * scale), Image.Resampling.NEAREST)

    buf = io.BytesIO()
    img.save(buf, format="PNG")

    # Compute metadata attributes for the frontend card.
    # The X50 firmware allocates volatile SLAM-internal segment IDs in
    # the live pixel grid that don't match the user-facing IDs the
    # device's cleanset/clean_segment expect — translate via the rism
    # saved-map mapping when dreame-mocker exposes it (>=v0.1.2).
    mapper = getattr(map_data, "live_to_rism_segment_map", None)
    live_to_rism = mapper() if callable(mapper) else {}
    room_bboxes = _compute_room_bboxes(
        pixel_array, w, h, flip_x, flip_y, rotation, scale,
        map_data.rooms, live_to_rism,
    )

    attrs: dict[str, Any] = {
        "map_width": w_out * scale,
        "map_height": h_out * scale,
        "scale": scale,
        "rotation": rotation,
        "flip_x": flip_x,
        "flip_y": flip_y,
        "pixel_size": header.pixel_size,
        "map_left": header.left,
        "map_top": header.top,
        "raw_width": w,
        "raw_height": h,
        "robot_position": (
            {"x": rx * scale, "y": ry * scale, "angle": robot_angle}
            if 0 <= rx < w_out and 0 <= ry < h_out
            else None
        ),
        "charger_position": (
            {"x": cx * scale, "y": cy * scale}
            if 0 <= cx < w_out and 0 <= cy < h_out
            else None
        ),
        "rooms": room_bboxes,
        "carpet_zones": _compute_carpet_zones(
            pixel_array, w, h, flip_x, flip_y, rotation, scale,
        ),
    }

    # The live map frame (req_type=1) often lacks zone config data like
    # vws (thresholds) and vw (no-go/virtual walls).  This data lives in
    # the saved map embedded in the "rism" metadata key.  Decode it to
    # get the authoritative zone configuration.
    saved_meta = _decode_rism_metadata(map_data.raw_metadata)

    # Merge saved-map zones into live metadata.  The live map's vw/vws
    # take precedence if present; fall back to saved map data.
    if saved_meta:
        effective_meta = dict(map_data.raw_metadata)
        for zone_key in ("vw", "vws"):
            if not effective_meta.get(zone_key) and saved_meta.get(zone_key):
                effective_meta[zone_key] = saved_meta[zone_key]
    else:
        effective_meta = map_data.raw_metadata

    # If the user just saved zones via update_map, overlay that data
    # instead of stale rism data.  The cloud's rism blob updates lazily
    # so without this, deletions appear to revert.
    if pending_zone_update:
        effective_meta = dict(effective_meta)
        for zone_key in ("vw", "vws", "sneak_areas", "ai_furniture_user"):
            if zone_key in pending_zone_update:
                effective_meta[zone_key] = pending_zone_update[zone_key]

    transform_args = (header, w, h, flip_x, flip_y, rotation, scale)

    attrs["furniture"] = _transform_furniture(
        effective_meta, *transform_args,
    )

    # Low-clearance zones use effective_meta so pending overlay applies
    attrs["low_clearance_zones"] = _transform_rect_zones(
        effective_meta, "sneak_areas", header, w, h,
        flip_x, flip_y, rotation, scale,
    )

    attrs["no_go_zones"] = _transform_no_go_zones(
        effective_meta, *transform_args,
    )
    attrs["virtual_walls"] = _transform_virtual_walls(
        effective_meta, *transform_args,
    )

    # Thresholds from vws: passable (vwsl), impassable (npthrsd), ramps
    vws_raw: Any = effective_meta.get("vws", {})
    vws: dict[str, Any] = cast(dict[str, Any], vws_raw) if isinstance(vws_raw, dict) else {}
    attrs["passable_thresholds"] = _transform_threshold_lines(
        vws, "vwsl", *transform_args,
    )
    attrs["impassable_thresholds"] = _transform_threshold_lines(
        vws, "npthrsd", *transform_args,
    )
    attrs["ramps"] = _transform_ramps(vws, *transform_args)

    # Cliffs live under vw.cliff, not vws
    vw_raw: Any = effective_meta.get("vw", {})
    vw: dict[str, Any] = cast(dict[str, Any], vw_raw) if isinstance(vw_raw, dict) else {}
    attrs["cliffs"] = _transform_threshold_lines(
        {"cliff": vw.get("cliff", [])}, "cliff", *transform_args,
    )

    # Path trail ("tr") — the robot's cleaning history. Uses raw_metadata
    # (not effective_meta) because tr only appears in live frames, and
    # the pending overlay never sets it.
    attrs["path"] = _transform_path(map_data.raw_metadata, *transform_args)

    return buf.getvalue(), attrs
