"""Data update coordinator for Dreame Cloud Vacuum."""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

if TYPE_CHECKING:
    from . import DreameCloudConfigEntry

from dreame_mocker.client import (
    AuthenticationError,
    DeviceStatus,
    DreameCloud,
    DreameDevice,
    DreameError,
    DreameMap,
    MapHeader,
    RoomInfo,
)
from dreame_mocker.client.map_decoder import MapDecoder
from dreame_mocker.const import STATES, DeviceState, Property

from .cleanset import (
    apply_wetness,
    parse_cleanset,
    to_custome_clean,
    to_stored,
)
from .const import (
    DEFAULT_PORT,
    DEFAULT_SCAN_INTERVAL,
    LOW_WATER_WARNING,
    MAP_FAST_POLL_INTERVAL_CLEANING,
    OFFLINE_THRESHOLD_SECONDS,
)

_LOGGER = logging.getLogger(__name__)


@dataclass
class DreameCloudData:
    """Data from the Dreame cloud API."""

    status: DeviceStatus
    map_data: DreameMap | None = None
    consumables: dict[str, int] = field(default_factory=lambda: {})  # noqa: PIE807
    dnd_enabled: bool = False
    volume: int = 50
    # SIID 4 wash / mop preferences
    self_clean: bool = True
    auto_water_refilling: bool = True
    auto_mount_mop: bool = True
    intelligent_recognition: bool = True
    mop_wash_level: int = 1
    mop_in_station: bool = True
    mop_pad_installed: bool = True
    customized_cleaning: bool = False
    # Onboard clean-water low-level warning (siid 4 piid 41); 0 = OK.
    low_water_warning: int = 0


class DreameCloudCoordinator(DataUpdateCoordinator[DreameCloudData]):
    """Coordinate data updates from Dreame cloud."""

    config_entry: DreameCloudConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        entry: DreameCloudConfigEntry,
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
        self._last_successful_update: float = 0.0
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
        # rooms may be cached as RoomInfo dicts (post-v0.3.6 format) or as
        # opaque values (pre-v0.3.6, when seg_inf was always empty here).
        # Reconstruct RoomInfo when the dict carries the expected keys.
        rooms: dict[int, Any] = {}
        for k, v in raw["rooms"].items():
            seg_id = int(k)
            if isinstance(v, dict) and "segment_id" in v and "name" in v:
                rooms[seg_id] = RoomInfo(
                    segment_id=int(v.get("segment_id", seg_id)),
                    room_id=int(v.get("room_id", seg_id)),
                    name=str(v.get("name", "")),
                    room_type=int(v.get("room_type", -1)),
                    neighbors=list(v.get("neighbors", [])),
                )
            else:
                rooms[seg_id] = v
        metadata: dict[str, Any] = raw["metadata"]
        m = DreameMap.__new__(DreameMap)
        m.header = header
        m.pixels = pixels
        m.rooms = rooms
        m.raw_metadata = metadata
        # Rehydrate the rism (saved-map) blob so image.py can fall back to
        # the dock's saved coordinates when the live header carries the
        # firmware's "I'm asleep" sentinel positions (32766/32767), and so
        # _compute_room_bboxes can group live pixel-grid IDs by rism ID.
        # Without this, restarting from cache renders the map with no
        # robot/charger marker and only the live IDs that coincidentally
        # fall within the rism ID range.
        rism_b64 = metadata.get("rism") if isinstance(metadata, dict) else None
        m.rism = MapDecoder._decode_rism(rism_b64) if rism_b64 else None  # noqa: SLF001
        device_info: dict[str, str] = raw.get("device", {})
        return m, device_info

    def _write_map_cache(self, map_data: DreameMap) -> None:
        """Serialize a DreameMap and device info to the JSON cache file."""
        h = map_data.header
        header_dict = {k: v for k, v in vars(h).items() if not k.startswith("_")}
        # RoomInfo is a dataclass; convert each entry to a dict so json.dumps
        # works. Pre-rism-fallback (dreame-mocker <0.1.2) this dict was always
        # empty, so the previous direct json.dumps happened to succeed.
        rooms_serializable: dict[int, Any] = {
            k: dataclasses.asdict(v) if isinstance(v, RoomInfo) else v
            for k, v in map_data.rooms.items()
        }
        payload: dict[str, Any] = {
            "header": header_dict,
            "pixels": base64.b64encode(map_data.pixels).decode(),
            "rooms": rooms_serializable,
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

    def _build_offline_data(self) -> DreameCloudData:
        """Synthesize a DreameCloudData payload for an unreachable device.

        Volatile fields (battery, cleaning time/area) are zeroed because they
        cannot be trusted while the device is offline. Map and consumables
        survive — they don't change while the device is offline, and the user
        wants the map to keep rendering even if status is unknown.
        """
        consumables: dict[str, int] = {}
        dnd_enabled = False
        volume = 50
        prefs: dict[str, Any] = {
            "self_clean": True,
            "auto_water_refilling": True,
            "auto_mount_mop": True,
            "intelligent_recognition": True,
            "mop_wash_level": 1,
            "mop_in_station": True,
            "mop_pad_installed": True,
            "customized_cleaning": False,
        }
        if self._last_good_data is not None:
            consumables = dict(self._last_good_data.consumables)
            dnd_enabled = self._last_good_data.dnd_enabled
            volume = self._last_good_data.volume
            for k in prefs:
                prefs[k] = getattr(self._last_good_data, k)
        return DreameCloudData(
            status=DeviceStatus(
                state=0, state_name="Offline", battery=0, error=0,
                suction_level=0, water_volume=0, cleaning_mode=0,
                cleaning_time=0, cleaning_area=0,
            ),
            map_data=self._map_data,
            consumables=consumables,
            dnd_enabled=dnd_enabled,
            volume=volume,
            **prefs,
        )

    def _should_surface_offline(self) -> bool:
        """Return True once the device has been unreachable past the threshold."""
        if self._last_successful_update == 0.0:
            # Never had a successful update this session — surface Offline
            # immediately rather than masking with stale cache data.
            return True
        return (
            time.monotonic() - self._last_successful_update
            > OFFLINE_THRESHOLD_SECONDS
        )

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
                if self._should_surface_offline():
                    _LOGGER.debug(
                        "Reconnect failed past threshold; surfacing Offline"
                    )
                    return self._build_offline_data()
                if self._last_good_data is not None:
                    _LOGGER.debug(
                        "Reconnect failed; returning cached data (within "
                        "blip-tolerance window)"
                    )
                    return self._last_good_data
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
                Property.SELF_CLEAN,
                Property.AUTO_WATER_REFILLING,
                Property.AUTO_MOUNT_MOP,
                Property.INTELLIGENT_RECOGNITION,
                Property.MOP_WASH_LEVEL,
                Property.MOP_IN_STATION,
                Property.MOP_PAD_INSTALLED,
                Property.CUSTOMIZED_CLEANING,
                LOW_WATER_WARNING,
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

            self_clean = bool(values.get(Property.SELF_CLEAN, 1))
            auto_water_refilling = bool(
                values.get(Property.AUTO_WATER_REFILLING, 1),
            )
            auto_mount_mop = bool(values.get(Property.AUTO_MOUNT_MOP, 1))
            intelligent_recognition = bool(
                values.get(Property.INTELLIGENT_RECOGNITION, 1),
            )
            mop_wash_level = int(values.get(Property.MOP_WASH_LEVEL, 1))
            mop_in_station = bool(values.get(Property.MOP_IN_STATION, False))
            mop_pad_installed = bool(
                values.get(Property.MOP_PAD_INSTALLED, False),
            )
            customized_cleaning = bool(
                values.get(Property.CUSTOMIZED_CLEANING, False),
            )
            low_water_warning = int(values.get(LOW_WATER_WARNING, 0))

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
                self_clean=self_clean,
                auto_water_refilling=auto_water_refilling,
                auto_mount_mop=auto_mount_mop,
                intelligent_recognition=intelligent_recognition,
                mop_wash_level=mop_wash_level,
                mop_in_station=mop_in_station,
                mop_pad_installed=mop_pad_installed,
                customized_cleaning=customized_cleaning,
                low_water_warning=low_water_warning,
            )
        except AuthenticationError as err:
            self._connected = False
            raise ConfigEntryAuthFailed(f"Authentication failed: {err}") from err
        except Exception as err:
            self._connected = False
            if self._should_surface_offline():
                _LOGGER.debug(
                    "Update failed past threshold; surfacing Offline: %s", err,
                )
                return self._build_offline_data()
            if self._last_good_data is not None:
                _LOGGER.debug(
                    "Update failed; returning cached data (within "
                    "blip-tolerance window): %s",
                    err,
                )
                return self._last_good_data
            raise UpdateFailed(f"Update failed: {err}") from err
        else:
            self._last_good_data = data
            self._last_successful_update = time.monotonic()
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

    def current_cleanset(self) -> str | dict[str, Any] | None:
        """Return the best-available stored ``cleanset`` (live frame, then rism).

        The live map frame usually carries ``cleanset`` in its trailing JSON;
        when it is absent (e.g. a partial frame) we fall back to the embedded
        rism saved map, which is the canonical home of per-room settings.
        """
        md = self._map_data
        if md is None:
            return None
        cleanset = md.raw_metadata.get("cleanset")
        if cleanset:
            return cleanset
        rism = getattr(md, "rism", None)
        if rism is not None:
            return rism.raw_metadata.get("cleanset")
        return None

    async def async_set_segment_wetness(
        self, segment_ids: list[int], wetness: int,
    ) -> list[int]:
        """Set per-room mop wetness (1-32) for the given segments.

        Reads the current per-room ``cleanset``, updates the wetness of the
        named segments, and writes the *whole* set back via the map-update
        action (siid 6, aiid 2, piid 4) wrapped under ``customeClean`` — the
        same mechanism the Dreame app uses. The remaining rooms are written
        back unchanged. For the device to honour these values during a clean,
        the ``Customized Cleaning`` switch (siid 4 piid 26) must be on.

        Returns the segment ids that were actually updated.
        """
        segments = parse_cleanset(self.current_cleanset())
        if not segments:
            raise HomeAssistantError(
                "No per-room cleaning data is loaded yet — the robot's map "
                "must be available before mop wetness can be set.",
            )
        updated = apply_wetness(segments, segment_ids, wetness)
        if not updated:
            raise HomeAssistantError(
                f"None of segments {list(segment_ids)} exist in the saved map "
                f"(known rooms: {sorted(segments)}).",
            )

        value = json.dumps(
            {"customeClean": to_custome_clean(segments)},
            separators=(",", ":"),
        )
        await self.device.send_action(
            6, 2, params=[{"piid": 4, "value": value}],
        )

        if not self.data.customized_cleaning:
            _LOGGER.warning(
                "Mop wetness updated for rooms %s, but Customized Cleaning is "
                "off — the robot will keep using the global water level until "
                "the Customized Cleaning switch is turned on.",
                updated,
            )

        # Optimistically reflect the change in the cached map so the card and
        # the image entity's per-room attributes update immediately. The
        # cloud's saved-map cleanset reconciles on the next live map fetch.
        if self._map_data is not None:
            self._map_data.raw_metadata["cleanset"] = json.dumps(
                to_stored(segments), separators=(",", ":"),
            )
            await self._async_save_map_cache(self._map_data)
        await self.async_request_refresh()
        return updated

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
        if self._device is None:
            return
        try:
            async with asyncio.timeout(15):
                new_map = await self.device.get_map()
        except Exception as err:
            _LOGGER.debug("Fast map poll fetch failed: %s", err)
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
                self_clean=self.data.self_clean,
                auto_water_refilling=self.data.auto_water_refilling,
                auto_mount_mop=self.data.auto_mount_mop,
                intelligent_recognition=self.data.intelligent_recognition,
                mop_wash_level=self.data.mop_wash_level,
                mop_in_station=self.data.mop_in_station,
                mop_pad_installed=self.data.mop_pad_installed,
                customized_cleaning=self.data.customized_cleaning,
                low_water_warning=self.data.low_water_warning,
            )
        )

    async def async_disconnect(self) -> None:
        """Disconnect from the cloud."""
        self._stop_fast_map_poll()
        await self._cloud.disconnect()
        self._connected = False
