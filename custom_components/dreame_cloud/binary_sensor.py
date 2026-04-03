"""Binary sensor platform for Dreame Cloud."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from dreame_mocker.const import DeviceState

from . import DreameCloudConfigEntry
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up binary sensor entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([DreameCloudChargingSensor(coordinator)])


class DreameCloudChargingSensor(DreameCloudEntity, BinarySensorEntity):
    """Binary sensor for charging state."""

    _attr_device_class = BinarySensorDeviceClass.BATTERY_CHARGING
    _attr_translation_key = "charging"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_charging"

    @property
    def is_on(self) -> bool:
        """Return true if charging."""
        return self.coordinator.data.status.state == DeviceState.CHARGING
