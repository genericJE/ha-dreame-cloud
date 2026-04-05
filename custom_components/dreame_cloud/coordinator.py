"""Data update coordinator for Dreame Cloud Vacuum."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from dreame_mocker.client import (
    AuthenticationError,
    DeviceStatus,
    DreameCloud,
    DreameDevice,
    DreameError,
    DreameMap,
)
from dreame_mocker.const import STATES, DeviceState, Property

from .const import DEFAULT_PORT, DEFAULT_SCAN_INTERVAL, MAP_UPDATE_INTERVAL_CLEANING, MAP_UPDATE_INTERVAL_IDLE

_LOGGER = logging.getLogger(__name__)


@dataclass
class DreameCloudData:
    """Data from the Dreame cloud API."""

    status: DeviceStatus
    map_data: DreameMap | None = None
    consumables: dict[str, int] = field(default_factory=dict)
    dnd_enabled: bool = False
    volume: int = 50


class DreameCloudCoordinator(DataUpdateCoordinator[DreameCloudData]):
    """Coordinate data updates from Dreame cloud."""

    def __init__(
        self,
        hass: HomeAssistant,
        username: str,
        password: str,
        region: str,
        host: str | None = None,
        port: int = DEFAULT_PORT,
    ) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name="Dreame Cloud Vacuum",
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL),
        )
        self._cloud = DreameCloud(
            username=username,
            password=password,
            region=region,
            host=host,
            port=port,
        )
        self._device: DreameDevice | None = None
        self._map_data: DreameMap | None = None
        self._last_map_update: float = 0
        self._connected = False
        self._pending_zone_update: dict | None = None

    @property
    def device(self) -> DreameDevice:
        """Return the device."""
        if self._device is None:
            raise RuntimeError("Device not initialized; coordinator setup has not completed")
        return self._device

    @property
    def device_model(self) -> str:
        """Return device model."""
        return self.device.model

    @property
    def device_name(self) -> str:
        """Return device name."""
        return self.device.name

    @property
    def device_id(self) -> str:
        """Return device ID."""
        return self.device.did

    async def _async_setup(self) -> None:
        """Set up the coordinator — connect and find the device."""
        try:
            async with asyncio.timeout(30):
                await self._cloud.connect()
                self._device = await self._cloud.get_device()
            self._connected = True
        except TimeoutError as err:
            raise UpdateFailed("Connection to Dreame cloud timed out") from err
        except AuthenticationError as err:
            raise ConfigEntryAuthFailed(f"Authentication failed: {err}") from err
        except DreameError as err:
            raise UpdateFailed(f"Failed to connect: {err}") from err

    async def _async_update_data(self) -> DreameCloudData:
        """Fetch data from the device."""
        if not self._connected:
            await self._async_setup()

        try:
            # Single RPC call for all properties (status + consumables + extras).
            all_props = await self.device.get_properties([
                Property.STATE,
                Property.BATTERY_LEVEL,
                Property.ERROR,
                Property.SUCTION_LEVEL,
                Property.WATER_VOLUME,
                Property.CLEANING_MODE,
                Property.CLEANING_TIME,
                Property.CLEANING_AREA,
                Property.MAIN_BRUSH_LIFE_LEVEL,
                Property.SIDE_BRUSH_LIFE_LEVEL,
                Property.FILTER_LIFE_LEVEL,
                Property.MOP_PAD_LIFE_LEVEL,
                Property.DND_ENABLED,
                Property.VOLUME,
            ])

            # Index results by (siid, piid) for easy lookup.
            values: dict[tuple[int, int], Any] = {}
            for prop in all_props:
                key = (prop.get("siid", 0), prop.get("piid", 0))
                values[key] = prop.get("value", 0)

            state = int(values.get(Property.STATE, 0))
            status = DeviceStatus(
                state=state,
                state_name=STATES.get(state, str(state)),
                battery=int(values.get(Property.BATTERY_LEVEL, 0)),
                error=int(values.get(Property.ERROR, 0)),
                suction_level=int(values.get(Property.SUCTION_LEVEL, 0)),
                water_volume=int(values.get(Property.WATER_VOLUME, 0)),
                cleaning_mode=int(values.get(Property.CLEANING_MODE, 0)),
                cleaning_time=int(values.get(Property.CLEANING_TIME, 0)),
                cleaning_area=int(values.get(Property.CLEANING_AREA, 0)),
            )

            consumables: dict[str, int] = {}
            for prop_key, name in (
                (Property.MAIN_BRUSH_LIFE_LEVEL, "main_brush"),
                (Property.SIDE_BRUSH_LIFE_LEVEL, "side_brush"),
                (Property.FILTER_LIFE_LEVEL, "filter"),
                (Property.MOP_PAD_LIFE_LEVEL, "mop_pad"),
            ):
                val = values.get(prop_key)
                if val is not None:
                    consumables[name] = int(val)

            dnd_enabled = bool(values.get(Property.DND_ENABLED, False))
            volume = int(values.get(Property.VOLUME, 50))

            # Update map periodically
            now = time.monotonic()
            is_cleaning = status.state in (
                DeviceState.SWEEPING,
                DeviceState.MOPPING,
                DeviceState.SWEEP_AND_MOP,
            )
            map_interval = (
                MAP_UPDATE_INTERVAL_CLEANING if is_cleaning else MAP_UPDATE_INTERVAL_IDLE
            )

            if now - self._last_map_update >= map_interval:
                try:
                    async with asyncio.timeout(15):
                        self._map_data = await self.device.get_map()
                    self._last_map_update = now
                except (DreameError, TimeoutError):
                    _LOGGER.debug("Map update failed, using cached map")

            return DreameCloudData(
                status=status,
                map_data=self._map_data,
                consumables=consumables,
                dnd_enabled=dnd_enabled,
                volume=volume,
            )
        except AuthenticationError as err:
            self._connected = False
            raise ConfigEntryAuthFailed(f"Authentication failed: {err}") from err
        except DreameError as err:
            self._connected = False
            raise UpdateFailed(f"Update failed: {err}") from err

    @property
    def pending_zone_update(self) -> dict | None:
        """Return the pending zone update overlay (used by camera rendering)."""
        return self._pending_zone_update

    def set_pending_zone_update(self, update: dict | None) -> None:
        """Cache zone data sent to the vacuum for immediate rendering.

        The cloud's saved map blob (rism) updates lazily, so the camera
        uses this overlay to show the user's edits immediately.
        """
        self._pending_zone_update = update

    def reset_map_cache(self) -> None:
        """Force the next refresh to re-fetch map data (bypass idle throttle)."""
        self._last_map_update = 0

    def set_map_data(self, map_data: DreameMap) -> None:
        """Replace the cached map data (used by request_map for investigation)."""
        self._map_data = map_data

    async def async_disconnect(self) -> None:
        """Disconnect from the cloud."""
        await self._cloud.disconnect()
        self._connected = False
