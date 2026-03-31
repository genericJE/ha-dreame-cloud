"""Select platform for Dreame Cloud."""

from __future__ import annotations

from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CLEANING_MODE_TO_INT,
    CLEANING_MODES,
    FAN_SPEEDS,
    FAN_SPEED_TO_SUCTION,
    INT_TO_CLEANING_MODE,
    INT_TO_WATER_VOLUME,
    SUCTION_TO_FAN_SPEED,
    WATER_VOLUME_TO_INT,
    WATER_VOLUMES,
)
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: Any,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up select entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([
        DreameCloudSuctionSelect(coordinator),
        DreameCloudWaterVolumeSelect(coordinator),
        DreameCloudCleaningModeSelect(coordinator),
    ])


class DreameCloudSuctionSelect(DreameCloudEntity, SelectEntity):
    """Select entity for suction level."""

    _attr_icon = "mdi:fan"
    _attr_translation_key = "suction_level"
    _attr_options = FAN_SPEEDS

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_suction_level"

    @property
    def current_option(self) -> str | None:
        """Return the current suction level."""
        if self.coordinator.data is None:
            return None
        return SUCTION_TO_FAN_SPEED.get(
            self.coordinator.data.status.suction_level
        )

    async def async_select_option(self, option: str) -> None:
        """Set the suction level."""
        if option in FAN_SPEED_TO_SUCTION:
            await self.coordinator.device.set_suction_level(
                FAN_SPEED_TO_SUCTION[option]
            )
            await self.coordinator.async_request_refresh()


class DreameCloudWaterVolumeSelect(DreameCloudEntity, SelectEntity):
    """Select entity for water volume."""

    _attr_icon = "mdi:water"
    _attr_translation_key = "water_volume"
    _attr_options = WATER_VOLUMES

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_water_volume"

    @property
    def current_option(self) -> str | None:
        """Return the current water volume."""
        if self.coordinator.data is None:
            return None
        return INT_TO_WATER_VOLUME.get(
            self.coordinator.data.status.water_volume
        )

    async def async_select_option(self, option: str) -> None:
        """Set the water volume."""
        if option in WATER_VOLUME_TO_INT:
            await self.coordinator.device.set_water_volume(
                WATER_VOLUME_TO_INT[option]
            )
            await self.coordinator.async_request_refresh()


class DreameCloudCleaningModeSelect(DreameCloudEntity, SelectEntity):
    """Select entity for cleaning mode."""

    _attr_icon = "mdi:broom"
    _attr_translation_key = "cleaning_mode"
    _attr_options = CLEANING_MODES

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_cleaning_mode"

    @property
    def current_option(self) -> str | None:
        """Return the current cleaning mode."""
        if self.coordinator.data is None:
            return None
        return INT_TO_CLEANING_MODE.get(
            self.coordinator.data.status.cleaning_mode
        )

    async def async_select_option(self, option: str) -> None:
        """Set the cleaning mode."""
        if option in CLEANING_MODE_TO_INT:
            await self.coordinator.device.set_cleaning_mode(
                CLEANING_MODE_TO_INT[option]
            )
            await self.coordinator.async_request_refresh()
