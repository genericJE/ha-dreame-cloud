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


def _transform_point(
    px: int,
    py: int,
    header: MapHeader,
    w: int,
    h: int,
    flip_x: bool,
    flip_y: bool,
    rotation: int,
    scale: int,
) -> tuple[int, int]:
    """Transform a point from map-absolute coords to final image coords."""
    x = px - header.left
    y = py - header.top
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
    header: MapHeader,
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
            (min_x + header.left, min_y + header.top),
            (max_x + header.left, min_y + header.top),
            (min_x + header.left, max_y + header.top),
            (max_x + header.left, max_y + header.top),
        ]
        transformed = [
            _transform_point(cx, cy, header, w, h, flip_x, flip_y, rotation, scale)
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
    cx, cy = _transform_point(
        header.charger_x, header.charger_y, header, w, h, flip_x, flip_y, rotation, 1
    )
    if 0 <= cx < w_out and 0 <= cy < h_out:
        r = max(3, min(w_out, h_out) // 60)
        draw.rectangle([cx - r, cy - r, cx + r, cy + r], fill=COLOR_CHARGER)

    # Draw robot
    rx, ry = _transform_point(
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
        pixel_array, header, w, h, flip_x, flip_y, rotation, scale, map_data.rooms
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
    }

    return buf.getvalue(), attrs
