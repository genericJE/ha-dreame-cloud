"""Select platform for Dreame Cloud Vacuum."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DreameCloudConfigEntry
from .const import (
    CLEANING_MODE_TO_INT,
    CLEANING_MODES,
    CONF_MAP_ROTATION,
    INT_TO_CLEANING_MODE,
    INT_TO_WATER_VOLUME,
    WATER_VOLUME_TO_INT,
    WATER_VOLUMES,
)
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity

_ROTATION_OPTIONS = ["0°", "90°", "180°", "270°"]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up select entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([
        DreameCloudWaterVolumeSelect(coordinator),
        DreameCloudCleaningModeSelect(coordinator),
        DreameCloudMapRotationSelect(coordinator),
    ])


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
        """Return the current cleaning mode.

        The real device returns a composite value where the lower byte
        is the cleaning mode and upper bytes encode wash/humidity settings.
        """
        raw = self.coordinator.data.status.cleaning_mode
        return INT_TO_CLEANING_MODE.get(raw & 0xFF)

    async def async_select_option(self, option: str) -> None:
        """Set the cleaning mode, preserving the upper bytes."""
        if option in CLEANING_MODE_TO_INT:
            raw = self.coordinator.data.status.cleaning_mode
            new_value = (raw & ~0xFF) | CLEANING_MODE_TO_INT[option]
            await self.coordinator.device.set_cleaning_mode(new_value)
            await self.coordinator.async_request_refresh()


class DreameCloudMapRotationSelect(DreameCloudEntity, SelectEntity):
    """Select entity for map rotation."""

    _attr_icon = "mdi:rotate-right"
    _attr_translation_key = "map_rotation"
    _attr_options = _ROTATION_OPTIONS
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_map_rotation"

    @property
    def current_option(self) -> str:
        """Return the current rotation."""
        rotation = self.coordinator.config_entry.options.get(CONF_MAP_ROTATION, 0)
        return f"{rotation}°"

    async def async_select_option(self, option: str) -> None:
        """Set the map rotation."""
        rotation = int(option.rstrip("°"))
        new_options = dict(self.coordinator.config_entry.options)
        new_options[CONF_MAP_ROTATION] = rotation
        self.hass.config_entries.async_update_entry(
            self.coordinator.config_entry, options=new_options
        )
        self.async_write_ha_state()
