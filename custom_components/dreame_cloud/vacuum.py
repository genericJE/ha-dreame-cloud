"""Vacuum platform for Dreame Cloud."""

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
    1: VacuumActivity.CLEANING,   # Sweeping
    2: VacuumActivity.IDLE,       # Idle
    3: VacuumActivity.PAUSED,     # Paused
    4: VacuumActivity.ERROR,      # Error
    5: VacuumActivity.RETURNING,  # Returning
    6: VacuumActivity.DOCKED,     # Charging
    7: VacuumActivity.CLEANING,   # Mopping
    8: VacuumActivity.DOCKED,     # Drying
    9: VacuumActivity.DOCKED,     # Washing
    12: VacuumActivity.CLEANING,  # Sweep+Mop
    13: VacuumActivity.DOCKED,    # Charge Complete
    20: VacuumActivity.DOCKED,    # Mop Washing
    21: VacuumActivity.PAUSED,    # Mop Washing Paused
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: Any,
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

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return extra state attributes."""
        status = self.coordinator.data.status
        attrs: dict[str, Any] = {
            "state_name": status.state_name,
            "cleaning_time": status.cleaning_time,
            "cleaning_area": status.cleaning_area,
            "error_code": status.error,
            "suction_level": status.suction_level,
            "water_volume": status.water_volume,
            "cleaning_mode": status.cleaning_mode,
        }
        if self.coordinator.data.map_data:
            rooms = self.coordinator.data.map_data.rooms
            attrs["rooms"] = {
                str(seg_id): room.name for seg_id, room in rooms.items()
            }
        return attrs
