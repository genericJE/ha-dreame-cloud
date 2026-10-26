"""Data update coordinator for Dreame Cloud Vacuum."""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import httpx
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
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
    SegmentCleanset,
    apply_cleaning_times,
    apply_wetness,
    parse_cleanset,
    to_custome_clean,
    to_stored,
)
from .const import (
    DEFAULT_PORT,
    DEFAULT_SCAN_INTERVAL,
    EXTRA_STATES,
    LOW_WATER_WARNING,
    MAP_FAST_POLL_INTERVAL_CLEANING,
    OFFLINE_THRESHOLD_SECONDS,
)
from .token_store import token_path

_LOGGER = logging.getLogger(__name__)

CLEANING_STATES = frozenset({
    DeviceState.SWEEPING,
    DeviceState.MOPPING,
    DeviceState.SWEEP_AND_MOP,
})

# While cleaning the coordinator ticks every MAP_FAST_POLL_INTERVAL_CLEANING
# seconds for the map and refreshes the properties every this many ticks, so
# the property RPC rate stays at one per DEFAULT_SCAN_INTERVAL.
FAST_TICKS_PER_PROPERTY_POLL = DEFAULT_SCAN_INTERVAL // MAP_FAST_POLL_INTERVAL_CLEANING

OFFLINE_STATUS = DeviceStatus(
    state=0, state_name="Offline", battery=0, error=0,
    suction_level=0, water_volume=0, cleaning_mode=0,
    cleaning_time=0, cleaning_area=0,
)

STATE_NAMES: dict[int, str] = {**STATES, **EXTRA_STATES}

POLLED_PROPERTIES: list[Any] = [
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
]

CONSUMABLE_PROPERTIES: dict[str, Any] = {
    "main_brush": Property.MAIN_BRUSH_LIFE_LEVEL,
    "side_brush": Property.SIDE_BRUSH_LIFE_LEVEL,
    "filter": Property.FILTER_LIFE_LEVEL,
    "mop_pad": Property.MOP_PAD_LIFE_LEVEL,
}


def _as_int(values: dict[tuple[int, int], Any], key: Any, default: int) -> int:
    """``int()`` a property value, treating ``None`` as absent.

    The cloud answers ``value: null`` for properties a model doesn't
    support; a bare ``int(None)`` would fail the whole update.
    """
    val = values.get(key)
    return default if val is None else int(val)


def _as_bool(values: dict[tuple[int, int], Any], key: Any, default: bool) -> bool:
    """``bool()`` a property value, treating ``None`` as absent."""
    val = values.get(key)
    return default if val is None else bool(val)


@dataclass(frozen=True)
class DeviceIdentity:
    """What the entities need to exist, available live or from the cache."""

    model: str
    name: str
    did: str


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

    @property
    def is_cleaning(self) -> bool:
        """True while the robot is actively sweeping and/or mopping."""
        return self.status.state in CLEANING_STATES


def _parse_properties(props: list[dict[str, Any]]) -> DreameCloudData:
    """Turn one ``get_properties`` answer into a payload (without the map)."""
    values: dict[tuple[int, int], Any] = {
        (p.get("siid", 0), p.get("piid", 0)): p.get("value", 0) for p in props
    }
    state = _as_int(values, Property.STATE, 0)
    return DreameCloudData(
        status=DeviceStatus(
            state=state,
            state_name=STATE_NAMES.get(state, str(state)),
            battery=_as_int(values, Property.BATTERY_LEVEL, 0),
            error=_as_int(values, Property.ERROR, 0),
            suction_level=_as_int(values, Property.SUCTION_LEVEL, 0),
            water_volume=_as_int(values, Property.WATER_VOLUME, 0),
            cleaning_mode=_as_int(values, Property.CLEANING_MODE, 0),
            cleaning_time=_as_int(values, Property.CLEANING_TIME, 0),
            cleaning_area=_as_int(values, Property.CLEANING_AREA, 0),
        ),
        consumables={
            name: int(values[key])
            for name, key in CONSUMABLE_PROPERTIES.items()
            if values.get(key) is not None
        },
        dnd_enabled=_as_bool(values, Property.DND_ENABLED, False),
        volume=_as_int(values, Property.VOLUME, 50),
        self_clean=_as_bool(values, Property.SELF_CLEAN, True),
        auto_water_refilling=_as_bool(values, Property.AUTO_WATER_REFILLING, True),
        auto_mount_mop=_as_bool(values, Property.AUTO_MOUNT_MOP, True),
        intelligent_recognition=_as_bool(values, Property.INTELLIGENT_RECOGNITION, True),
        mop_wash_level=_as_int(values, Property.MOP_WASH_LEVEL, 1),
        mop_in_station=_as_bool(values, Property.MOP_IN_STATION, False),
        mop_pad_installed=_as_bool(values, Property.MOP_PAD_INSTALLED, False),
        customized_cleaning=_as_bool(values, Property.CUSTOMIZED_CLEANING, False),
        low_water_warning=_as_int(values, LOW_WATER_WARNING, 0),
    )


class DreameCloudCoordinator(DataUpdateCoordinator[DreameCloudData]):
    """Coordinate data updates from Dreame cloud.

    One scheduled loop does everything. Idle, it ticks every
    ``DEFAULT_SCAN_INTERVAL`` seconds and fetches the properties. While the
    robot cleans, ``update_interval`` drops to
    ``MAP_FAST_POLL_INTERVAL_CLEANING`` so the map follows the robot, and the
    properties are refreshed every ``FAST_TICKS_PER_PROPERTY_POLL`` ticks or
    whenever a refresh is requested (entity commands, ``update_entity``).
    """

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
            token_path=token_path(hass, username),
        )
        self._device: DreameDevice | None = None
        self._identity: DeviceIdentity | None = None
        self._connected = False
        self._map_data: DreameMap | None = None
        self._map_current = False  # a live map was fetched since (re)connecting
        self._pending_zone_update: dict[str, Any] | None = None
        self._last_good_data: DreameCloudData | None = None
        self._last_successful_update: float = 0.0
        self._properties_due = True
        self._fast_ticks = 0

    # ------------------------------------------------------------------
    # Device identity
    # ------------------------------------------------------------------

    @property
    def device(self) -> DreameDevice:
        """Return the device."""
        if self._device is None:
            raise RuntimeError("Device not initialized; coordinator setup has not completed")
        return self._device

    def _require_identity(self) -> DeviceIdentity:
        if self._identity is None:
            raise RuntimeError("Device not initialized and no cache available")
        return self._identity

    @property
    def device_model(self) -> str:
        """Return device model."""
        return self._require_identity().model

    @property
    def device_name(self) -> str:
        """Return device name."""
        return self._require_identity().name

    @property
    def device_id(self) -> str:
        """Return device ID."""
        return self._require_identity().did

    # ------------------------------------------------------------------
    # Offline map cache
    # ------------------------------------------------------------------

    @property
    def _cache_path(self) -> Path:
        """Return the path for the map cache file."""
        return Path(self.hass.config.path(".storage/dreame_cloud_map_cache.json"))

    async def async_load_map_cache(self) -> None:
        """Load the cached map and device identity from disk (before the first refresh)."""
        path = self._cache_path
        try:
            result = await self.hass.async_add_executor_job(self._read_map_cache, path)
        except (OSError, json.JSONDecodeError, KeyError, ValueError, TypeError):
            _LOGGER.debug("No usable map cache at %s", path)
            return
        if result is None:
            return
        self._map_data, self._identity = result
        self._last_good_data = DreameCloudData(status=OFFLINE_STATUS, map_data=self._map_data)
        _LOGGER.info("Loaded cached map from disk (%s)", path)

    @staticmethod
    def _read_map_cache(path: Path) -> tuple[DreameMap, DeviceIdentity | None] | None:
        """Deserialize a DreameMap and device identity from a JSON cache file."""
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
            d = cast(dict[str, Any], v) if isinstance(v, dict) else None
            if d is not None and "segment_id" in d and "name" in d:
                rooms[seg_id] = RoomInfo(
                    segment_id=int(d.get("segment_id", seg_id)),
                    room_id=int(d.get("room_id", seg_id)),
                    name=str(d.get("name", "")),
                    room_type=int(d.get("room_type", -1)),
                    neighbors=list(d.get("neighbors", [])),
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
        rism_b64 = metadata.get("rism")
        m.rism = MapDecoder._decode_rism(rism_b64) if rism_b64 else None  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
        device: dict[str, str] = raw.get("device", {})
        identity = DeviceIdentity(**device) if device.keys() >= {"model", "name", "did"} else None
        return m, identity

    def _write_map_cache(self, map_data: DreameMap) -> None:
        """Serialize a DreameMap and device identity to the JSON cache file."""
        h = map_data.header
        rooms: dict[int, Any] = map_data.rooms
        payload: dict[str, Any] = {
            "header": {k: v for k, v in vars(h).items() if not k.startswith("_")},
            "pixels": base64.b64encode(map_data.pixels).decode(),
            # RoomInfo is a dataclass; pre-v0.3.6 caches may hold opaque values.
            "rooms": {
                k: dataclasses.asdict(v) if isinstance(v, RoomInfo) else v
                for k, v in rooms.items()
            },
            "metadata": map_data.raw_metadata,
        }
        if self._identity is not None:
            payload["device"] = dataclasses.asdict(self._identity)
        path = self._cache_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload))

    async def _async_save_map_cache(self, map_data: DreameMap) -> None:
        """Save map data to disk in the executor."""
        try:
            await self.hass.async_add_executor_job(self._write_map_cache, map_data)
        except OSError:
            _LOGGER.warning("Failed to write map cache to %s", self._cache_path)

    # ------------------------------------------------------------------
    # Polling
    # ------------------------------------------------------------------

    async def _async_connect(self) -> None:
        """Connect to the cloud and resolve the device.

        Deliberately not named ``_async_setup``: that is a
        DataUpdateCoordinator hook HA runs itself during the first refresh,
        outside the offline-cache handling below, so a cold start with the
        cloud down would never reach the cached map.
        """
        try:
            async with asyncio.timeout(30):
                await self._cloud.connect()
                device = await self._cloud.get_device()
        except TimeoutError as err:
            raise UpdateFailed("Connection to Dreame cloud timed out") from err
        except AuthenticationError as err:
            raise ConfigEntryAuthFailed(f"Authentication failed: {err}") from err
        except (DreameError, httpx.HTTPError) as err:
            # dreame-mocker lets httpx transport errors (DNS, refused,
            # reset) escape unwrapped.
            raise UpdateFailed(f"Failed to connect: {err}") from err
        self._device = device
        self._identity = DeviceIdentity(device.model, device.name, device.did)
        self._connected = True
        self._map_current = False
        self._properties_due = True

    async def _async_update_data(self) -> DreameCloudData:
        """One tick of the single polling loop."""
        try:
            if not self._connected:
                await self._async_connect()
            data = await self._async_poll()
        except ConfigEntryAuthFailed:
            raise
        except AuthenticationError as err:
            self._connected = False
            raise ConfigEntryAuthFailed(f"Authentication failed: {err}") from err
        except Exception as err:  # any cloud failure means "unreachable"
            return self._unreachable(err)
        self._last_good_data = data
        self._last_successful_update = time.monotonic()
        return data

    async def _async_poll(self) -> DreameCloudData:
        """Fetch the properties when due and the map while cleaning."""
        self._fast_ticks += 1
        if (
            self._properties_due
            or not self.data.is_cleaning
            or self._fast_ticks >= FAST_TICKS_PER_PROPERTY_POLL
        ):
            data = _parse_properties(await self.device.get_properties(POLLED_PROPERTIES))
            self._properties_due = False
            self._fast_ticks = 0
        else:
            data = self.data

        if data.is_cleaning or not self._map_current:
            await self._async_fetch_map()
        self.update_interval = timedelta(
            seconds=MAP_FAST_POLL_INTERVAL_CLEANING if data.is_cleaning else DEFAULT_SCAN_INTERVAL,
        )
        return dataclasses.replace(data, map_data=self._map_data)

    async def _async_fetch_map(self) -> None:
        """Fetch the live map; a bad frame is logged, never fatal for the tick."""
        try:
            async with asyncio.timeout(15):
                self._map_data = await self.device.get_map()
        except Exception as err:  # decoder errors included
            _LOGGER.debug("Map fetch failed: %s", err)
            return
        self._map_current = True
        await self._async_save_map_cache(self._map_data)

    def _unreachable(self, err: Exception) -> DreameCloudData:
        """Ride out a short blip on the last payload, then surface Offline.

        Raises ``UpdateFailed`` when there is nothing to show: no cache and
        never connected. HA then retries setup rather than creating entities
        with no device identity.
        """
        self._connected = False
        # Back off to the idle cadence; a 2 s reconnect loop would hammer the cloud.
        self.update_interval = timedelta(seconds=DEFAULT_SCAN_INTERVAL)
        if self._last_good_data is None or self._identity is None:
            raise UpdateFailed(f"Update failed: {err}") from err
        if (
            self._last_successful_update
            and time.monotonic() - self._last_successful_update <= OFFLINE_THRESHOLD_SECONDS
        ):
            _LOGGER.debug("Update failed; keeping last data within the blip window: %s", err)
            return self._last_good_data
        _LOGGER.debug("Update failed past threshold; surfacing Offline: %s", err)
        # Volatile fields (battery, cleaning time/area) are zeroed with the
        # status; the map, consumables and preferences survive.
        return dataclasses.replace(
            self._last_good_data,
            status=OFFLINE_STATUS,
            map_data=self._map_data,
            consumables=dict(self._last_good_data.consumables),
        )

    async def async_refresh(self) -> None:
        """Refresh now, including the properties even mid-clean.

        Covers ``async_request_refresh`` too (HA debounces it into this
        method), so entity commands and ``homeassistant.update_entity`` never
        wait for the next property tick. Only scheduled ticks skip properties.
        """
        self._properties_due = True
        await super().async_refresh()

    async def async_disconnect(self) -> None:
        """Disconnect from the cloud."""
        await self._cloud.disconnect()
        self._connected = False

    # ------------------------------------------------------------------
    # Map helpers used by the entities
    # ------------------------------------------------------------------

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

    def invalidate_map(self) -> None:
        """Make the next refresh fetch the map even while the robot is idle."""
        self._map_current = False

    def set_map_data(self, map_data: DreameMap) -> None:
        """Replace the cached map data (used by request_map for investigation)."""
        self._map_data = map_data

    @callback
    def async_map_options_changed(self) -> None:
        """Repaint the map after a rotation/flip option changed.

        Notifies the listeners without touching the data or the schedule so
        the image entity re-reads ``config_entry.options``. This replaces a
        config entry update listener on purpose: HA 2026.12 turns "update
        listener plus ``async_update_reload_and_abort``" (which the reauth
        flow uses) into an error.
        """
        self.async_update_listeners()

    # ------------------------------------------------------------------
    # Per-room cleanset
    # ------------------------------------------------------------------

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

        Persists into the saved-map ``cleanset`` via :meth:`_async_write_cleanset`
        so it applies to every subsequent clean of those rooms, matching the
        per-room Mop Wetness slider in the Dreame app.

        Returns the segment ids that were actually updated.
        """
        return await self._async_write_cleanset(
            "mop wetness",
            lambda segments: apply_wetness(segments, segment_ids, wetness),
            segment_ids,
        )

    async def async_set_segment_cleaning_times(
        self, segment_ids: list[int], cleaning_times: int,
    ) -> list[int]:
        """Set per-room cleaning passes (1-3) for the given segments.

        Persists into the saved-map ``cleanset`` via :meth:`_async_write_cleanset`
        so it applies to every subsequent clean of those rooms, matching the
        per-room Cleaning Times setting in the Dreame app. With Customized
        Cleaning on, the firmware uses this stored value and ignores the
        ``repeat`` field of ``clean_segment``.

        Returns the segment ids that were actually updated.
        """
        return await self._async_write_cleanset(
            "cleaning times",
            lambda segments: apply_cleaning_times(
                segments, segment_ids, cleaning_times,
            ),
            segment_ids,
        )

    async def _async_write_cleanset(
        self,
        what: str,
        apply: Callable[[dict[int, SegmentCleanset]], list[int]],
        segment_ids: list[int],
    ) -> list[int]:
        """Update per-room settings in the saved-map ``cleanset``.

        Reads the current per-room ``cleanset``, lets ``apply`` mutate the
        named segments, and writes the *whole* set back via the map-update
        action (siid 6, aiid 2, piid 4) wrapped under ``customeClean`` — the
        same mechanism the Dreame app uses. The remaining rooms are written
        back unchanged. For the device to honour these values during a clean,
        the ``Customized Cleaning`` switch (siid 4 piid 26) must be on.

        ``what`` names the setting for error and warning messages. Returns
        the segment ids that were actually updated.
        """
        segments = parse_cleanset(self.current_cleanset())
        if not segments:
            raise HomeAssistantError(
                "No per-room cleaning data is loaded yet — the robot's map "
                f"must be available before {what} can be set.",
            )
        updated = apply(segments)
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
                "Per-room %s updated for rooms %s, but Customized Cleaning is "
                "off — the robot will keep using its global settings until "
                "the Customized Cleaning switch is turned on.",
                what,
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
