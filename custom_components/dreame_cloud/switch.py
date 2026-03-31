"""Switch platform for Dreame Cloud."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: Any,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up switch entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([DreameCloudDNDSwitch(coordinator)])


class DreameCloudDNDSwitch(DreameCloudEntity, SwitchEntity):
    """Switch for Do Not Disturb mode."""

    _attr_icon = "mdi:minus-circle"
    _attr_translation_key = "dnd"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_dnd"

    @property
    def is_on(self) -> bool | None:
        """Return true if DND is enabled."""
        if self.coordinator.data is None:
            return None
        return self.coordinator.data.dnd_enabled

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn on DND."""
        await self.coordinator.device.set_dnd(True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn off DND."""
        await self.coordinator.device.set_dnd(False)
        await self.coordinator.async_request_refresh()
