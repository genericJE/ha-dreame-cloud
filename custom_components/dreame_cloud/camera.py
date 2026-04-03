"""Camera platform for Dreame Cloud map."""

from __future__ import annotations

import io
import logging
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

from homeassistant.components.camera import Camera
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from dreame_mocker.client import DreameMap

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
    entry: Any,
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
        self._last_frame_id: int | None = None

    @property
    def frame_interval(self) -> float:
        """Return the polling interval for the camera."""
        return 1.0

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
        if frame_id != self._last_frame_id:
            options = self.coordinator.config_entry.options
            self._image = await self.hass.async_add_executor_job(
                _render_map,
                map_data,
                options.get(CONF_MAP_ROTATION, 0),
                options.get(CONF_MAP_FLIP_X, False),
                options.get(CONF_MAP_FLIP_Y, False),
            )
            self._last_frame_id = frame_id
        return self._image


def _render_map(
    map_data: DreameMap,
    rotation: int = 0,
    flip_x: bool = False,
    flip_y: bool = False,
) -> bytes:
    """Render map data to a PNG image."""
    header = map_data.header
    w, h = header.width, header.height

    if w == 0 or h == 0:
        img = Image.new("RGB", (1, 1), COLOR_BACKGROUND)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

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

    img = Image.fromarray(img_array, "RGB")
    draw = ImageDraw.Draw(img)

    # Transform marker coordinates through the same flip/rotate operations
    def transform(px: int, py: int) -> tuple[int, int]:
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
        return x, y

    # Draw charger
    cx, cy = transform(header.charger_x, header.charger_y)
    if 0 <= cx < w_out and 0 <= cy < h_out:
        r = max(3, min(w_out, h_out) // 60)
        draw.rectangle([cx - r, cy - r, cx + r, cy + r], fill=COLOR_CHARGER)

    # Draw robot
    rx, ry = transform(header.robot_x, header.robot_y)
    if 0 <= rx < w_out and 0 <= ry < h_out:
        r = max(3, min(w_out, h_out) // 50)
        draw.ellipse([rx - r, ry - r, rx + r, ry + r], fill=COLOR_ROBOT)

    # Scale up for better visibility
    scale = max(1, 800 // max(w_out, h_out))
    if scale > 1:
        img = img.resize((w_out * scale, h_out * scale), Image.Resampling.NEAREST)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
