"""Camera platform for Dreame Cloud Vacuum map."""

from __future__ import annotations

import io
import logging
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

from homeassistant.components.camera import Camera
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from dreame_mocker.client import DreameMap, MapHeader

from . import DreameCloudConfigEntry
from .const import (
    COLOR_BACKGROUND,
    COLOR_CHARGER,
    COLOR_ROBOT,
    COLOR_WALL,
    CONF_MAP_FLIP_X,
    CONF_MAP_FLIP_Y,
    CONF_MAP_ROTATION,
    ROOM_COLORS,
)
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the camera platform."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([DreameCloudMapCamera(coordinator)])


class DreameCloudMapCamera(DreameCloudEntity, Camera):
    """Camera entity showing the vacuum map."""

    _attr_translation_key = "map"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        DreameCloudEntity.__init__(self, coordinator)
        Camera.__init__(self)
        self._attr_unique_id = f"{coordinator.device_id}_map"
        self._image: bytes | None = None
        self._map_attrs: dict[str, Any] = {}
        self._last_frame_id: int | None = None
        self._last_opts: tuple[int, bool, bool] | None = None

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
    def frame_interval(self) -> float:
        """Return the polling interval for the camera."""
        return 1.0

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return map metadata for the frontend card."""
        return self._map_attrs

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """Return the current map image."""
        map_data = (
            self.coordinator.data.map_data if self.coordinator.data else None
        )
        if map_data is None:
            return self._image

        frame_id = map_data.header.frame_id
        options = self.coordinator.config_entry.options
        opts_key = (
            options.get(CONF_MAP_ROTATION, 0),
            options.get(CONF_MAP_FLIP_X, False),
            options.get(CONF_MAP_FLIP_Y, False),
        )
        if frame_id != self._last_frame_id or opts_key != self._last_opts:
            self._image, self._map_attrs = await self.hass.async_add_executor_job(
                _render_map, map_data, *opts_key
            )
            self._last_frame_id = frame_id
            self._last_opts = opts_key
            self.async_write_ha_state()
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
    pixel_array: "np.ndarray[Any, np.dtype[np.uint8]]",
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
    rooms: dict[int, Any],
) -> dict[str, dict[str, Any]]:
    """Compute room bounding boxes in final image coordinates."""
    room_ids = pixel_array & 0x3F
    is_wall = (pixel_array & 0x80).astype(bool)

    result: dict[str, dict[str, Any]] = {}
    # Only emit rooms that appear in the map metadata (seg_inf).
    # Pixel data can contain stale segment IDs from earlier map versions;
    # the metadata dict is the canonical set of active rooms.
    valid_ids = set(rooms.keys()) if rooms else None
    for seg_id in range(1, 64):
        if valid_ids is not None and seg_id not in valid_ids:
            continue
        mask = (room_ids == seg_id) & ~is_wall
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
        name = (room_info.name if room_info and room_info.name else "") or f"Room {seg_id}"
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
    vw = metadata.get("vw", {})
    zones: list[Any] = []
    if isinstance(vw, dict):
        zones = vw.get("rect", [])
    # Flat list format: vw is [x1,y1,x2,y2,...] line segments, not zones
    if not zones:
        return []

    result = []
    for zone in zones:
        roi = zone.get("roi", []) if isinstance(zone, dict) else zone
        if not isinstance(roi, list) or len(roi) != 8:
            continue
        points = []
        for i in range(0, 8, 2):
            ix, iy = _vacuum_to_image(
                roi[i], roi[i + 1], header, w, h, flip_x, flip_y, rotation, scale,
            )
            points.append({"x": ix, "y": iy})
        result.append({
            "id": zone.get("id") if isinstance(zone, dict) else None,
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
    vw = metadata.get("vw", {})
    line_list: list[Any] = []
    if isinstance(vw, dict):
        line_list = vw.get("line", [])
    elif isinstance(vw, list):
        # Legacy flat format: each entry is [x1, y1, x2, y2]
        line_list = vw

    for wall in line_list:
        if isinstance(wall, list) and len(wall) >= 4:
            p1 = _vacuum_to_image(
                wall[0], wall[1], header, w, h, flip_x, flip_y, rotation, scale,
            )
            p2 = _vacuum_to_image(
                wall[2], wall[3], header, w, h, flip_x, flip_y, rotation, scale,
            )
            walls.append({
                "x1": p1[0], "y1": p1[1],
                "x2": p2[0], "y2": p2[1],
                "vacuum_coords": wall[:4],
            })

    # User-defined outborders
    for border in metadata.get("ai_outborders_user", []):
        if isinstance(border, dict):
            roi = border.get("roi", [])
            if len(roi) >= 4:
                p1 = _vacuum_to_image(
                    roi[0], roi[1], header, w, h, flip_x, flip_y, rotation, scale,
                )
                p2 = _vacuum_to_image(
                    roi[2], roi[3], header, w, h, flip_x, flip_y, rotation, scale,
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
    zones = metadata.get(key, [])
    if not zones:
        return []

    result = []
    for zone in zones:
        # hide: 0 = visible, 1 = auto-hidden, 2 = manually hidden
        if zone.get("hide", 0):
            continue
        roi = zone.get("roi", [])
        if len(roi) != 8:
            continue
        points = []
        for i in range(0, 8, 2):
            ix, iy = _vacuum_to_image(
                roi[i], roi[i + 1], header, w, h, flip_x, flip_y, rotation, scale,
            )
            points.append({"x": ix, "y": iy})
        result.append({
            "id": zone.get("id"),
            "type": zone.get("type", 0),  # 0 = auto-detected, 1 = manual
            "points": points,
            "roi": roi,
        })
    return result


def _compute_carpet_zones(
    pixel_array: np.ndarray,
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


# Furniture type names from Dreame firmware
_FURNITURE_TYPES: dict[int, str] = {
    3: "Chair",
    4: "Table",
    6: "Sofa",
    7: "Trash Can",
    14: "Shoe Rack",
    18: "Shelf",
    20: "Curtain",
    21: "TV Stand",
}


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
    items = metadata.get("ai_furniture_user", [])
    if not items:
        return []

    result = []
    for item in items:
        if not isinstance(item, list) or len(item) < 8:
            continue
        # [cx, cy, type, flag, cx2, cy2, width, height, user_flag?]
        cx, cy = item[4], item[5]  # center position
        fw, fh = item[6], item[7]  # dimensions in vacuum coords
        ftype = item[2]

        # Compute corners and transform
        half_w = fw // 2
        half_h = fh // 2
        corners = [
            (cx - half_w, cy - half_h),
            (cx + half_w, cy - half_h),
            (cx + half_w, cy + half_h),
            (cx - half_w, cy + half_h),
        ]
        points = []
        for vx, vy in corners:
            ix, iy = _vacuum_to_image(
                vx, vy, header, w, h, flip_x, flip_y, rotation, scale,
            )
            points.append({"x": ix, "y": iy})

        # Compute bounding box from transformed points
        xs = [p["x"] for p in points]
        ys = [p["y"] for p in points]

        result.append({
            "type": ftype,
            "name": _FURNITURE_TYPES.get(ftype, f"Object {ftype}"),
            "x": min(xs),
            "y": min(ys),
            "w": max(xs) - min(xs),
            "h": max(ys) - min(ys),
            "center_x": (min(xs) + max(xs)) // 2,
            "center_y": (min(ys) + max(ys)) // 2,
        })
    return result


def _render_map(
    map_data: DreameMap,
    rotation: int = 0,
    flip_x: bool = False,
    flip_y: bool = False,
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

    # Draw charger
    cx, cy = _vacuum_to_image(
        header.charger_x, header.charger_y, header, w, h, flip_x, flip_y, rotation, 1
    )
    if 0 <= cx < w_out and 0 <= cy < h_out:
        r = max(3, min(w_out, h_out) // 60)
        draw.rectangle([cx - r, cy - r, cx + r, cy + r], fill=COLOR_CHARGER)

    # Draw robot
    rx, ry = _vacuum_to_image(
        header.robot_x, header.robot_y, header, w, h, flip_x, flip_y, rotation, 1
    )
    if 0 <= rx < w_out and 0 <= ry < h_out:
        r = max(3, min(w_out, h_out) // 50)
        draw.ellipse([rx - r, ry - r, rx + r, ry + r], fill=COLOR_ROBOT)

    # Scale up for better visibility
    if scale > 1:
        img = img.resize((w_out * scale, h_out * scale), Image.Resampling.NEAREST)

    buf = io.BytesIO()
    img.save(buf, format="PNG")

    # Compute metadata attributes for the frontend card
    room_bboxes = _compute_room_bboxes(
        pixel_array, w, h, flip_x, flip_y, rotation, scale, map_data.rooms
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
            {"x": rx * scale, "y": ry * scale}
            if 0 <= rx < w_out and 0 <= ry < h_out
            else None
        ),
        "charger_position": (
            {"x": cx * scale, "y": cy * scale}
            if 0 <= cx < w_out and 0 <= cy < h_out
            else None
        ),
        "rooms": room_bboxes,
        "no_go_zones": _transform_no_go_zones(
            map_data.raw_metadata, header, w, h, flip_x, flip_y, rotation, scale,
        ),
        "virtual_walls": _transform_virtual_walls(
            map_data.raw_metadata, header, w, h, flip_x, flip_y, rotation, scale,
        ),
        "furniture": _transform_furniture(
            map_data.raw_metadata, header, w, h, flip_x, flip_y, rotation, scale,
        ),
        "carpet_zones": _compute_carpet_zones(
            pixel_array, w, h, flip_x, flip_y, rotation, scale,
        ),
        # Low-clearance / low-lying areas (sneak_areas in Dreame protocol).
        "low_clearance_zones": _transform_rect_zones(
            map_data.raw_metadata, "sneak_areas", header, w, h,
            flip_x, flip_y, rotation, scale,
        ),
    }

    return buf.getvalue(), attrs
