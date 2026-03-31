"""Number platform for Dreame Cloud."""

from __future__ import annotations

from typing import Any

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: Any,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up number entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([DreameCloudVolumeNumber(coordinator)])


class DreameCloudVolumeNumber(DreameCloudEntity, NumberEntity):
    """Number entity for speaker volume."""

    _attr_icon = "mdi:volume-high"
    _attr_translation_key = "volume"
    _attr_native_min_value = 0
    _attr_native_max_value = 100
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_volume"

    @property
    def native_value(self) -> float | None:
        """Return the current volume."""
        if self.coordinator.data is None:
            return None
        return float(self.coordinator.data.volume)

    async def async_set_native_value(self, value: float) -> None:
        """Set the volume."""
        await self.coordinator.device.set_volume(int(value))
        await self.coordinator.async_request_refresh()
