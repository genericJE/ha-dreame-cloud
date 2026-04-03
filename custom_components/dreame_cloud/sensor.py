"""Sensor platform for Dreame Cloud."""

from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DreameCloudConfigEntry
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity

SENSOR_DESCRIPTIONS: list[SensorEntityDescription] = [
    SensorEntityDescription(
        key="battery",
        translation_key="battery",
        device_class=SensorDeviceClass.BATTERY,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="cleaning_time",
        translation_key="cleaning_time",
        device_class=SensorDeviceClass.DURATION,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="cleaning_area",
        translation_key="cleaning_area",
        native_unit_of_measurement="m\u00b2",
        state_class=SensorStateClass.MEASUREMENT,
        icon="mdi:texture-box",
    ),
    SensorEntityDescription(
        key="state",
        translation_key="device_state",
        icon="mdi:robot-vacuum",
    ),
    SensorEntityDescription(
        key="main_brush_life",
        translation_key="main_brush_life",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        icon="mdi:brush",
        entity_registry_enabled_default=False,
    ),
    SensorEntityDescription(
        key="side_brush_life",
        translation_key="side_brush_life",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        icon="mdi:brush",
        entity_registry_enabled_default=False,
    ),
    SensorEntityDescription(
        key="filter_life",
        translation_key="filter_life",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        icon="mdi:air-filter",
        entity_registry_enabled_default=False,
    ),
    SensorEntityDescription(
        key="mop_pad_life",
        translation_key="mop_pad_life",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        icon="mdi:spray-bottle",
        entity_registry_enabled_default=False,
    ),
]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up sensor entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities(
        DreameCloudSensor(coordinator, desc) for desc in SENSOR_DESCRIPTIONS
    )


class DreameCloudSensor(DreameCloudEntity, SensorEntity):
    """Dreame Cloud sensor."""

    entity_description: SensorEntityDescription

    def __init__(
        self,
        coordinator: DreameCloudCoordinator,
        description: SensorEntityDescription,
    ) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{coordinator.device_id}_{description.key}"

    @property
    def native_value(self) -> int | str | None:
        """Return the sensor value."""
        status = self.coordinator.data.status
        key = self.entity_description.key

        if key == "battery":
            return status.battery
        if key == "cleaning_time":
            return status.cleaning_time
        if key == "cleaning_area":
            return status.cleaning_area
        if key == "state":
            return status.state_name
        if key == "main_brush_life":
            return self.coordinator.data.consumables.get("main_brush")
        if key == "side_brush_life":
            return self.coordinator.data.consumables.get("side_brush")
        if key == "filter_life":
            return self.coordinator.data.consumables.get("filter")
        if key == "mop_pad_life":
            return self.coordinator.data.consumables.get("mop_pad")
        return None
