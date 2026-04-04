"""Vacuum platform for Dreame Cloud Vacuum."""

from __future__ import annotations

import json
import logging
from typing import Any

from homeassistant.components.vacuum import (
    StateVacuumEntity,
    VacuumEntityFeature,
)
from homeassistant.components.vacuum.const import VacuumActivity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_platform
from homeassistant.helpers.entity_platform import AddEntitiesCallback
import voluptuous as vol

from dreame_mocker.const import DeviceState

from . import DreameCloudConfigEntry
from .const import (
    FAN_SPEEDS,
    FAN_SPEED_TO_SUCTION,
    SUCTION_TO_FAN_SPEED,
)
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity

_LOGGER = logging.getLogger(__name__)

# Map Dreame device state to HA VacuumActivity
STATE_MAP: dict[int, VacuumActivity] = {
    DeviceState.SWEEPING: VacuumActivity.CLEANING,
    DeviceState.IDLE: VacuumActivity.IDLE,
    DeviceState.PAUSED: VacuumActivity.PAUSED,
    DeviceState.ERROR: VacuumActivity.ERROR,
    DeviceState.RETURNING: VacuumActivity.RETURNING,
    DeviceState.CHARGING: VacuumActivity.DOCKED,
    DeviceState.MOPPING: VacuumActivity.CLEANING,
    DeviceState.DRYING: VacuumActivity.DOCKED,
    DeviceState.WASHING: VacuumActivity.DOCKED,
    DeviceState.SWEEP_AND_MOP: VacuumActivity.CLEANING,
    DeviceState.CHARGE_COMPLETE: VacuumActivity.DOCKED,
    DeviceState.MOP_WASHING: VacuumActivity.DOCKED,
    DeviceState.MOP_WASHING_PAUSED: VacuumActivity.PAUSED,
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the vacuum platform."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([DreameCloudVacuum(coordinator)])

    # Register custom services
    platform = entity_platform.async_get_current_platform()
    platform.async_register_entity_service(
        "clean_segment",
        {
            vol.Required("segments"): vol.All(
                vol.Coerce(list), [vol.Coerce(int)]
            ),
            vol.Optional("suction_level", default=1): vol.All(
                int, vol.Range(min=0, max=3)
            ),
            vol.Optional("water_volume", default=2): vol.All(
                int, vol.Range(min=1, max=3)
            ),
            vol.Optional("repeat", default=1): vol.All(
                int, vol.Range(min=1, max=3)
            ),
            vol.Optional("cleaning_mode", default=2): vol.All(
                int, vol.Range(min=0, max=2)
            ),
        },
        "async_clean_segment",
    )
    _zone_schema = vol.All(
        vol.Coerce(list),
        [
            vol.Schema(
                {
                    vol.Optional("id"): int,
                    vol.Optional("type", default=0): int,
                    vol.Optional("hide", default=0): int,
                    vol.Required("roi"): vol.All(
                        vol.Coerce(list), [vol.Coerce(int)]
                    ),
                }
            )
        ],
    )
    platform.async_register_entity_service(
        "update_map",
        {
            vol.Optional("no_go_zones"): _zone_schema,
            vol.Optional("virtual_walls"): vol.All(
                vol.Coerce(list),
                [vol.All(vol.Coerce(list), [vol.Coerce(int)])],
            ),
            vol.Optional("low_clearance_zones"): _zone_schema,
            vol.Optional("thresholds"): vol.Schema(
                {
                    vol.Optional("vwsl"): vol.All(
                        vol.Coerce(list),
                        [vol.All(vol.Coerce(list), [vol.Coerce(int)])],
                    ),
                    vol.Optional("npthrsd"): vol.All(
                        vol.Coerce(list),
                        [vol.All(vol.Coerce(list), [vol.Coerce(int)])],
                    ),
                    vol.Optional("ramp"): vol.All(
                        vol.Coerce(list),
                        [vol.All(vol.Coerce(list), [vol.Coerce(int)])],
                    ),
                    vol.Optional("cliff"): vol.All(
                        vol.Coerce(list),
                        [vol.All(vol.Coerce(list), [vol.Coerce(int)])],
                    ),
                }
            ),
        },
        "async_update_map",
    )
    platform.async_register_entity_service(
        "clean_zone",
        {
            vol.Required("zones"): vol.All(
                vol.Coerce(list),
                [vol.All(vol.Coerce(list), [vol.Coerce(int)])],
            ),
            vol.Optional("suction_level", default=1): vol.All(
                int, vol.Range(min=0, max=3)
            ),
            vol.Optional("water_volume", default=2): vol.All(
                int, vol.Range(min=1, max=3)
            ),
            vol.Optional("repeat", default=1): vol.All(
                int, vol.Range(min=1, max=3)
            ),
            vol.Optional("cleaning_mode", default=2): vol.All(
                int, vol.Range(min=0, max=2)
            ),
        },
        "async_clean_zone",
    )
    platform.async_register_entity_service(
        "goto",
        {
            vol.Required("x"): vol.Coerce(int),
            vol.Required("y"): vol.Coerce(int),
        },
        "async_goto",
    )
    platform.async_register_entity_service(
        "request_map",
        {
            vol.Optional("req_type", default=1): vol.All(
                int, vol.Range(min=1, max=10)
            ),
        },
        "async_request_map",
    )


class DreameCloudVacuum(DreameCloudEntity, StateVacuumEntity):
    """Dreame vacuum entity."""

    _attr_supported_features = (
        VacuumEntityFeature.START
        | VacuumEntityFeature.PAUSE
        | VacuumEntityFeature.STOP
        | VacuumEntityFeature.RETURN_HOME
        | VacuumEntityFeature.FAN_SPEED
        | VacuumEntityFeature.STATE
        | VacuumEntityFeature.SEND_COMMAND
    )
    _attr_fan_speed_list = FAN_SPEEDS
    _attr_translation_key = "vacuum"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_vacuum"

    @property
    def activity(self) -> VacuumActivity | None:
        """Return the current vacuum activity."""
        return STATE_MAP.get(self.coordinator.data.status.state)

    @property
    def battery_level(self) -> int | None:
        """Return the battery level."""
        return self.coordinator.data.status.battery

    @property
    def fan_speed(self) -> str | None:
        """Return the current fan speed."""
        return SUCTION_TO_FAN_SPEED.get(
            self.coordinator.data.status.suction_level
        )

    async def async_start(self) -> None:
        """Start cleaning."""
        await self.coordinator.device.start()
        await self.coordinator.async_request_refresh()

    async def async_pause(self) -> None:
        """Pause cleaning."""
        await self.coordinator.device.pause()
        await self.coordinator.async_request_refresh()

    async def async_stop(self, **kwargs: Any) -> None:
        """Stop cleaning."""
        await self.coordinator.device.stop()
        await self.coordinator.async_request_refresh()

    async def async_return_to_base(self, **kwargs: Any) -> None:
        """Return to dock."""
        await self.coordinator.device.return_to_dock()
        await self.coordinator.async_request_refresh()

    async def async_set_fan_speed(self, fan_speed: str, **kwargs: Any) -> None:
        """Set fan speed."""
        if fan_speed in FAN_SPEED_TO_SUCTION:
            await self.coordinator.device.set_suction_level(
                FAN_SPEED_TO_SUCTION[fan_speed]
            )
            await self.coordinator.async_request_refresh()

    async def async_send_command(
        self, command: str, params: dict[str, Any] | list[Any] | None = None, **kwargs: Any
    ) -> None:
        """Send a raw command."""
        cmd_params = params if isinstance(params, dict) else {}
        if command == "clean_segment":
            await self.async_clean_segment(**cmd_params)
        elif command == "clean_zone":
            await self.async_clean_zone(**cmd_params)
        elif command == "request_map":
            await self.coordinator.device.get_map()
            await self.coordinator.async_request_refresh()
        elif command == "app_start":
            await self.coordinator.device.start()
        elif command == "app_pause":
            await self.coordinator.device.pause()
        elif command == "app_stop":
            await self.coordinator.device.stop()
        elif command == "app_charge":
            await self.coordinator.device.return_to_dock()
        else:
            _LOGGER.warning("Unknown command: %s", command)

    async def async_clean_segment(
        self,
        segments: list[int] | None = None,
        suction_level: int = 1,
        water_volume: int = 2,
        repeat: int = 1,
        cleaning_mode: int = 2,
        **kwargs: Any,
    ) -> None:
        """Clean specific room segments."""
        if not segments:
            return

        selects = [
            [seg, suction_level, water_volume, repeat, cleaning_mode]
            for seg in segments
        ]
        value = json.dumps({"selects": selects})

        await self.coordinator.device.send_action(
            4, 1, params=[{"piid": 1, "value": value}]
        )
        await self.coordinator.async_request_refresh()

    async def async_update_map(
        self,
        no_go_zones: list[dict[str, Any]] | None = None,
        virtual_walls: list[list[int]] | None = None,
        low_clearance_zones: list[dict[str, Any]] | None = None,
        thresholds: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """Update map data (no-go zones, virtual walls, low-clearance zones, thresholds).

        Sends an UPDATE_MAP_DATA action (siid 6, aiid 2) with piid 4
        containing the zone data in Dreame protocol format.
        """
        update: dict[str, Any] = {}

        # Virtual walls and no-go zones use the "vw" dict with sub-keys
        vw: dict[str, Any] = {}
        if virtual_walls is not None:
            vw["line"] = virtual_walls
        if no_go_zones is not None:
            vw["rect"] = no_go_zones
        if vw:
            update["vw"] = vw

        if low_clearance_zones is not None:
            update["sneak_areas"] = low_clearance_zones

        if thresholds is not None:
            # Cliffs belong under vw, not vws (the camera reads vw.cliff)
            cliff = thresholds.get("cliff")
            if cliff is not None:
                vw["cliff"] = cliff
                update["vw"] = vw
            vws_data = {k: v for k, v in thresholds.items() if k != "cliff"}
            if vws_data:
                update["vws"] = vws_data

        if not update:
            return

        value = json.dumps(update)
        await self.coordinator.device.send_action(
            6, 2, params=[{"piid": 4, "value": value}]
        )
        # Force next refresh to re-fetch map data (bypass idle throttle)
        self.coordinator._last_map_update = 0  # noqa: SLF001
        await self.coordinator.async_request_refresh()

    async def async_clean_zone(
        self,
        zones: list[list[int]] | None = None,
        suction_level: int = 1,
        water_volume: int = 2,
        repeat: int = 1,
        cleaning_mode: int = 2,
        **kwargs: Any,
    ) -> None:
        """Clean specific zones by coordinates."""
        if not zones:
            return

        value = json.dumps({
            "areas": [
                [*zone, suction_level, water_volume, repeat, cleaning_mode]
                for zone in zones
            ],
        })

        await self.coordinator.device.send_action(
            4, 1, params=[{"piid": 1, "value": value}]
        )
        await self.coordinator.async_request_refresh()

    async def async_goto(
        self,
        x: int,
        y: int,
        **kwargs: Any,
    ) -> None:
        """Send the vacuum to a specific point on the map.

        Uses spot cleaning at the target coordinate. The Dreame protocol
        requires piid 1 = 20 (spot cleaning status) and piid 10 with a
        points array containing [x, y, repeats, suction, water].
        """
        status = self.coordinator.data.status
        suction = status.suction_level if status else 1
        water = status.water_volume if status else 2
        value = json.dumps({"points": [[x, y, 1, suction, water]]})
        await self.coordinator.device.send_action(
            4, 1, params=[
                {"piid": 1, "value": 20},
                {"piid": 10, "value": value},
            ],
        )
        await self.coordinator.async_request_refresh()

    async def async_request_map(
        self,
        req_type: int = 1,
        **kwargs: Any,
    ) -> None:
        """Request a map with a specific req_type for investigation.

        req_type 1 = current map, 2 = saved map. Other values are untested.
        The resulting metadata is logged at INFO level for inspection.
        Updates the coordinator's cached map so the camera re-renders.
        """
        map_data = await self.coordinator.device.get_map(req_type=req_type)
        meta_keys = sorted(map_data.raw_metadata.keys())
        _LOGGER.info(
            "Map req_type=%d: %d rooms, %d metadata keys: %s",
            req_type, len(map_data.rooms), len(meta_keys), meta_keys,
        )
        # Update the coordinator's cached map data so the camera renders it
        self.coordinator._map_data = map_data  # noqa: SLF001
        await self.coordinator.async_request_refresh()

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return extra state attributes."""
        attrs: dict[str, Any] = {
            "error_code": self.coordinator.data.status.error,
        }
        if self.coordinator.data.map_data:
            rooms = self.coordinator.data.map_data.rooms
            attrs["rooms"] = {
                str(seg_id): room.name for seg_id, room in rooms.items()
            }
        return attrs
