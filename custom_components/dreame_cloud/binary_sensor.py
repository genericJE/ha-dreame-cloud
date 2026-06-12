"""Binary sensor platform for Dreame Cloud Vacuum."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from dreame_mocker.const import DeviceState

from . import DreameCloudConfigEntry
from .const import LOW_WATER_PROBLEM_CODES, LOW_WATER_WARNINGS
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up binary sensor entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities([
        DreameCloudChargingSensor(coordinator),
        DreameCloudMopInStationSensor(coordinator),
        DreameCloudMopPadInstalledSensor(coordinator),
        DreameCloudLowWaterSensor(coordinator),
    ])


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


class DreameCloudMopInStationSensor(DreameCloudEntity, BinarySensorEntity):
    """Mop pads detected at the base station (read-only)."""

    _attr_icon = "mdi:tray-full"
    _attr_translation_key = "mop_in_station"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_mop_in_station"

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.mop_in_station


class DreameCloudMopPadInstalledSensor(DreameCloudEntity, BinarySensorEntity):
    """Mop pads currently mounted on the robot (read-only)."""

    _attr_icon = "mdi:water-circle"
    _attr_translation_key = "mop_pad_installed"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_mop_pad_installed"

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.mop_pad_installed


class DreameCloudLowWaterSensor(DreameCloudEntity, BinarySensorEntity):
    """On when the onboard clean-water tank is low/empty.

    When this fires during a mop run the robot drops to vacuum-only and the
    pads run dry. Only meaningful without the plumbed water hookup; the
    firmware reports no warning when the dock auto-refills.
    """

    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_icon = "mdi:water-alert"
    _attr_translation_key = "low_water"

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_low_water"

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.low_water_warning in LOW_WATER_PROBLEM_CODES

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the raw warning code and its description."""
        code = self.coordinator.data.low_water_warning
        return {
            "warning_code": code,
            "warning": LOW_WATER_WARNINGS.get(code, "Unknown"),
        }
