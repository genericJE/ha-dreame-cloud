"""Base entity for Dreame Cloud Vacuum."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import DreameCloudCoordinator


class DreameCloudEntity(CoordinatorEntity[DreameCloudCoordinator]):
    """Base entity for Dreame Cloud Vacuum."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.device_id)},
            name=coordinator.device_name,
            manufacturer="Dreame",
            model=coordinator.device_model,
        )
