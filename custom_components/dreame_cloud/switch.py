"""Switch platform for Dreame Cloud."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DreameCloudConfigEntry
from .const import CONF_MAP_FLIP_X, CONF_MAP_FLIP_Y
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up switch entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([
        DreameCloudDNDSwitch(coordinator),
        DreameCloudMapFlipXSwitch(coordinator),
        DreameCloudMapFlipYSwitch(coordinator),
    ])


class DreameCloudDNDSwitch(DreameCloudEntity, SwitchEntity):
    """Switch for Do Not Disturb mode."""

    _attr_icon = "mdi:minus-circle"
    _attr_translation_key = "dnd"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_dnd"

    @property
    def is_on(self) -> bool:
        """Return true if DND is enabled."""
        return self.coordinator.data.dnd_enabled

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn on DND."""
        await self.coordinator.device.set_dnd(True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn off DND."""
        await self.coordinator.device.set_dnd(False)
        await self.coordinator.async_request_refresh()


class _MapFlipSwitch(DreameCloudEntity, SwitchEntity):
    """Base switch for map flip options."""

    _attr_entity_category = EntityCategory.CONFIG
    _flip_key: str

    @property
    def is_on(self) -> bool:
        """Return true if flip is enabled."""
        return self.coordinator.config_entry.options.get(self._flip_key, False)

    def _set_flip(self, value: bool) -> None:
        new_options = dict(self.coordinator.config_entry.options)
        new_options[self._flip_key] = value
        self.hass.config_entries.async_update_entry(
            self.coordinator.config_entry, options=new_options
        )
        self.async_write_ha_state()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable flip."""
        self._set_flip(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable flip."""
        self._set_flip(False)


class DreameCloudMapFlipXSwitch(_MapFlipSwitch):
    """Switch for horizontal map flip."""

    _attr_icon = "mdi:flip-horizontal"
    _attr_translation_key = "map_flip_x"
    _flip_key = CONF_MAP_FLIP_X

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_map_flip_x"


class DreameCloudMapFlipYSwitch(_MapFlipSwitch):
    """Switch for vertical map flip."""

    _attr_icon = "mdi:flip-vertical"
    _attr_translation_key = "map_flip_y"
    _flip_key = CONF_MAP_FLIP_Y

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_map_flip_y"
