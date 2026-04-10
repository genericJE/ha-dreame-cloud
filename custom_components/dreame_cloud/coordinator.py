"""Data update coordinator for Dreame Cloud Vacuum."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from dreame_mocker.client import (
    AuthenticationError,
    DeviceStatus,
    DreameCloud,
    DreameDevice,
    DreameError,
    DreameMap,
    MapHeader,
)
from dreame_mocker.const import STATES, DeviceState, Property

from .const import DEFAULT_PORT, DEFAULT_SCAN_INTERVAL, MAP_FAST_POLL_INTERVAL_CLEANING

_LOGGER = logging.getLogger(__name__)


@dataclass
class DreameCloudData:
    """Data from the Dreame cloud API."""

    status: DeviceStatus
    map_data: DreameMap | None = None
    consumables: dict[str, int] = field(default_factory=lambda: {})  # noqa: PIE807
    dnd_enabled: bool = False
    volume: int = 50


class DreameCloudCoordinator(DataUpdateCoordinator[DreameCloudData]):
    """Coordinate data updates from Dreame cloud."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry[DreameCloudData],
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
            config_entry=entry,
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
        self._pending_zone_update: dict[str, Any] | None = None
        self._last_good_data: DreameCloudData | None = None
        self._cached_device_model: str | None = None
        self._cached_device_name: str | None = None
        self._cached_device_id: str | None = None
        self._fast_map_unsub: CALLBACK_TYPE | None = None
        self._seeded_this_connect: bool = False

    @property
    def device(self) -> DreameDevice:
        """Return the device."""
        if self._device is None:
            raise RuntimeError("Device not initialized; coordinator setup has not completed")
        return self._device

    @property
    def device_model(self) -> str:
        """Return device model."""
        if self._device is not None:
            return self._device.model
        if self._cached_device_model is not None:
            return self._cached_device_model
        raise RuntimeError("Device not initialized and no cache available")

    @property
    def device_name(self) -> str:
        """Return device name."""
        if self._device is not None:
            return self._device.name
        if self._cached_device_name is not None:
            return self._cached_device_name
        raise RuntimeError("Device not initialized and no cache available")

    @property
    def device_id(self) -> str:
        """Return device ID."""
        if self._device is not None:
            return self._device.did
        if self._cached_device_id is not None:
            return self._cached_device_id
        raise RuntimeError("Device not initialized and no cache available")

    @property
    def _cache_path(self) -> Path:
        """Return the path for the map cache file."""
        return Path(self.hass.config.path(".storage/dreame_cloud_map_cache.json"))

    async def async_load_map_cache(self) -> None:
        """Load the cached map and device info from disk (called before first refresh)."""
        path = self._cache_path
        try:
            result = await self.hass.async_add_executor_job(self._read_map_cache, path)
        except (OSError, json.JSONDecodeError, KeyError, ValueError):
            _LOGGER.debug("No usable map cache at %s", path)
            return
        if result is None:
            return
        map_data, device_info = result
        self._map_data = map_data
        self._last_good_data = DreameCloudData(
            status=DeviceStatus(
                state=0, state_name="Offline", battery=0, error=0,
                suction_level=0, water_volume=0, cleaning_mode=0,
                cleaning_time=0, cleaning_area=0,
            ),
            map_data=map_data,
        )
        if device_info:
            self._cached_device_model = device_info.get("model")
            self._cached_device_name = device_info.get("name")
            self._cached_device_id = device_info.get("did")
        _LOGGER.info("Loaded cached map from disk (%s)", path)

    @staticmethod
    def _read_map_cache(path: Path) -> tuple[DreameMap, dict[str, str]] | None:
        """Deserialize a DreameMap and device info from a JSON cache file."""
        if not path.is_file():
            return None
        raw = json.loads(path.read_text())
        header = MapHeader.__new__(MapHeader)
        for k, v in raw["header"].items():
            setattr(header, k, v)
        pixels = base64.b64decode(raw["pixels"])
        rooms: dict[int, Any] = {int(k): v for k, v in raw["rooms"].items()}
        metadata: dict[str, Any] = raw["metadata"]
        m = DreameMap.__new__(DreameMap)
        m.header = header
        m.pixels = pixels
        m.rooms = rooms
        m.raw_metadata = metadata
        device_info: dict[str, str] = raw.get("device", {})
        return m, device_info

    def _write_map_cache(self, map_data: DreameMap) -> None:
        """Serialize a DreameMap and device info to the JSON cache file."""
        h = map_data.header
        header_dict = {k: v for k, v in vars(h).items() if not k.startswith("_")}
        payload: dict[str, Any] = {
            "header": header_dict,
            "pixels": base64.b64encode(map_data.pixels).decode(),
            "rooms": map_data.rooms,
            "metadata": map_data.raw_metadata,
        }
        if self._device is not None:
            payload["device"] = {
                "model": self._device.model,
                "name": self._device.name,
                "did": self._device.did,
            }
        path = self._cache_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload))

    async def _async_save_map_cache(self, map_data: DreameMap) -> None:
        """Save map data to disk in the executor."""
        try:
            await self.hass.async_add_executor_job(self._write_map_cache, map_data)
        except OSError:
            _LOGGER.warning("Failed to write map cache to %s", self._cache_path)

    async def _async_setup(self) -> None:
        """Set up the coordinator — connect and find the device."""
        try:
            async with asyncio.timeout(30):
                await self._cloud.connect()
                self._device = await self._cloud.get_device()
            self._connected = True
            self._seeded_this_connect = False
        except TimeoutError as err:
            raise UpdateFailed("Connection to Dreame cloud timed out") from err
        except AuthenticationError as err:
            raise ConfigEntryAuthFailed(f"Authentication failed: {err}") from err
        except DreameError as err:
            raise UpdateFailed(f"Failed to connect: {err}") from err

    async def _async_update_data(self) -> DreameCloudData:
        """Fetch data from the device."""
        if not self._connected:
            try:
                await self._async_setup()
            except ConfigEntryAuthFailed:
                raise
            except UpdateFailed:
                if self._last_good_data is not None:
                    _LOGGER.debug("Connection failed, returning cached data")
                    return self._last_good_data
                if self._map_data is not None:
                    _LOGGER.debug("Connection failed, returning cached map only")
                    return DreameCloudData(
                        status=DeviceStatus(
                            state=0, state_name="Offline", battery=0, error=0,
                            suction_level=0, water_volume=0, cleaning_mode=0,
                            cleaning_time=0, cleaning_area=0,
                        ),
                        map_data=self._map_data,
                    )
                raise

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

            is_cleaning = status.state in (
                DeviceState.SWEEPING,
                DeviceState.MOPPING,
                DeviceState.SWEEP_AND_MOP,
            )

            # Seed the map once per connect.  After that the fast
            # poll loop refreshes it while cleaning, and we leave it
            # alone while the robot is dormant.  Note: we don't gate
            # this on `_map_data is None` because the disk cache may
            # have already populated it; we still want a live fetch
            # the first time we successfully reach the cloud.
            if not self._seeded_this_connect:
                try:
                    async with asyncio.timeout(15):
                        self._map_data = await self.device.get_map()
                    self._last_map_update = time.monotonic()
                    self._seeded_this_connect = True
                    await self._async_save_map_cache(self._map_data)
                except (DreameError, TimeoutError):
                    _LOGGER.debug("Initial map fetch failed")

            # Toggle the fast map poll loop based on cleaning state.
            if is_cleaning:
                self._start_fast_map_poll()
            else:
                self._stop_fast_map_poll()

            data = DreameCloudData(
                status=status,
                map_data=self._map_data,
                consumables=consumables,
                dnd_enabled=dnd_enabled,
                volume=volume,
            )
        except AuthenticationError as err:
            self._connected = False
            raise ConfigEntryAuthFailed(f"Authentication failed: {err}") from err
        except Exception as err:
            self._connected = False
            if self._last_good_data is not None:
                _LOGGER.debug("Update failed, returning cached data: %s", err)
                return self._last_good_data
            raise UpdateFailed(f"Update failed: {err}") from err
        else:
            self._last_good_data = data
            return data

    @property
    def pending_zone_update(self) -> dict[str, Any] | None:
        """Return the pending zone update overlay (used by image rendering)."""
        return self._pending_zone_update

    def set_pending_zone_update(self, update: dict[str, Any] | None) -> None:
        """Cache zone data sent to the vacuum for immediate rendering.

        The cloud's saved map blob (rism) updates lazily, so the image
        entity uses this overlay to show the user's edits immediately.
        """
        self._pending_zone_update = update

    def reset_map_cache(self) -> None:
        """Force the next fast tick to re-fetch map data."""
        self._last_map_update = 0

    def set_map_data(self, map_data: DreameMap) -> None:
        """Replace the cached map data (used by request_map for investigation)."""
        self._map_data = map_data

    def _start_fast_map_poll(self) -> None:
        """Start the fast map poll loop if not already running."""
        if self._fast_map_unsub is not None:
            return
        self._fast_map_unsub = async_track_time_interval(
            self.hass,
            self._async_fast_map_tick,
            timedelta(seconds=MAP_FAST_POLL_INTERVAL_CLEANING),
        )

    def _stop_fast_map_poll(self) -> None:
        """Stop the fast map poll loop if running."""
        if self._fast_map_unsub is None:
            return
        self._fast_map_unsub()
        self._fast_map_unsub = None

    async def _async_fast_map_tick(self, _now: datetime) -> None:
        """Fetch the map and push fresh data to listeners."""
        if self.data is None or self._device is None:
            return
        try:
            async with asyncio.timeout(15):
                new_map = await self.device.get_map()
        except (DreameError, TimeoutError):
            _LOGGER.debug("Fast map poll fetch failed")
            return
        self._map_data = new_map
        self._last_map_update = time.monotonic()
        await self._async_save_map_cache(new_map)
        self.async_set_updated_data(
            DreameCloudData(
                status=self.data.status,
                map_data=new_map,
                consumables=self.data.consumables,
                dnd_enabled=self.data.dnd_enabled,
                volume=self.data.volume,
            )
        )

    async def async_disconnect(self) -> None:
        """Disconnect from the cloud."""
        self._stop_fast_map_poll()
        await self._cloud.disconnect()
        self._connected = False
