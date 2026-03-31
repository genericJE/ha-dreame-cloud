"""Data update coordinator for Dreame Cloud."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from dreame_mocker.client import (
    AuthenticationError,
    DeviceStatus,
    DreameCloud,
    DreameDevice,
    DreameError,
    DreameMap,
)

from .const import DEFAULT_PORT, DEFAULT_SCAN_INTERVAL, MAP_UPDATE_INTERVAL_CLEANING, MAP_UPDATE_INTERVAL_IDLE

_LOGGER = logging.getLogger(__name__)


@dataclass
class DreameCloudData:
    """Data from the Dreame Cloud API."""

    status: DeviceStatus
    map_data: DreameMap | None = None
    consumables: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    dnd_enabled: bool = False
    volume: int = 50


class DreameCloudCoordinator(DataUpdateCoordinator[DreameCloudData]):
    """Coordinate data updates from Dreame Cloud."""

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
            name="Dreame Cloud",
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

    @property
    def device(self) -> DreameDevice:
        """Return the device."""
        assert self._device is not None
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
            await self._cloud.connect()
            self._device = await self._cloud.get_device()
            self._connected = True
        except AuthenticationError as err:
            raise UpdateFailed(f"Authentication failed: {err}") from err
        except DreameError as err:
            raise UpdateFailed(f"Failed to connect: {err}") from err

    async def _async_update_data(self) -> DreameCloudData:
        """Fetch data from the device."""
        if not self._connected:
            await self._async_setup()

        try:
            status = await self.device.get_status()

            # Fetch additional properties (consumables, DND, volume)
            extra_props = await self.device.get_properties([
                (9, 2),   # Main brush life level
                (10, 2),  # Side brush life level
                (11, 2),  # Filter life level
                (16, 2),  # Mop pad life level
                (12, 1),  # DND enabled
                (7, 1),   # Volume
            ])

            consumables: dict[str, int] = {}
            dnd_enabled = False
            volume = 50

            for prop in extra_props:
                siid = prop.get("siid", 0)
                piid = prop.get("piid", 0)
                value: Any = prop.get("value")
                if value is None:
                    continue
                if (siid, piid) == (9, 2):
                    consumables["main_brush"] = int(value)
                elif (siid, piid) == (10, 2):
                    consumables["side_brush"] = int(value)
                elif (siid, piid) == (11, 2):
                    consumables["filter"] = int(value)
                elif (siid, piid) == (16, 2):
                    consumables["mop_pad"] = int(value)
                elif (siid, piid) == (12, 1):
                    dnd_enabled = bool(value)
                elif (siid, piid) == (7, 1):
                    volume = int(value)

            # Update map periodically
            now = time.monotonic()
            is_cleaning = status.state in (1, 7, 12)
            map_interval = (
                MAP_UPDATE_INTERVAL_CLEANING if is_cleaning else MAP_UPDATE_INTERVAL_IDLE
            )

            if now - self._last_map_update >= map_interval:
                try:
                    self._map_data = await self.device.get_map()
                    self._last_map_update = now
                except DreameError:
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
            raise UpdateFailed(f"Authentication failed: {err}") from err
        except DreameError as err:
            raise UpdateFailed(f"Update failed: {err}") from err

    async def async_disconnect(self) -> None:
        """Disconnect from the cloud."""
        await self._cloud.disconnect()
        self._connected = False
