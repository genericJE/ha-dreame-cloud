"""Switch platform for Dreame Cloud Vacuum."""

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
        DreameCloudSelfCleanSwitch(coordinator),
        DreameCloudAutoWaterRefillingSwitch(coordinator),
        DreameCloudAutoMountMopSwitch(coordinator),
        DreameCloudIntelligentRecognitionSwitch(coordinator),
        DreameCloudCustomizedCleaningSwitch(coordinator),
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


class DreameCloudSelfCleanSwitch(DreameCloudEntity, SwitchEntity):
    """Toggle the dock's mid/post-cleaning auto mop wash.

    Off = pure-dry run when mop pads are still attached. Same MIoT
    property the Dreame app's "Self-Clean" toggle controls (siid 4
    piid 34).
    """

    _attr_icon = "mdi:water-sync"
    _attr_translation_key = "self_clean"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_self_clean"

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.self_clean

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_self_clean(True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_self_clean(False)
        await self.coordinator.async_request_refresh()


class DreameCloudAutoWaterRefillingSwitch(DreameCloudEntity, SwitchEntity):
    """Auto-refill the clean-water tank from the dock."""

    _attr_icon = "mdi:water-pump"
    _attr_translation_key = "auto_water_refilling"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_auto_water_refilling"

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.auto_water_refilling

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_auto_water_refilling(True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_auto_water_refilling(False)
        await self.coordinator.async_request_refresh()


class DreameCloudAutoMountMopSwitch(DreameCloudEntity, SwitchEntity):
    """Auto-attach mop pads at cycle start."""

    _attr_icon = "mdi:robot-vacuum-variant"
    _attr_translation_key = "auto_mount_mop"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.device_id}_auto_mount_mop"

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.auto_mount_mop

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_auto_mount_mop(True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_auto_mount_mop(False)
        await self.coordinator.async_request_refresh()


class DreameCloudIntelligentRecognitionSwitch(DreameCloudEntity, SwitchEntity):
    """Smart carpet/zone recognition during cleaning."""

    _attr_icon = "mdi:auto-fix"
    _attr_translation_key = "intelligent_recognition"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = (
            f"{coordinator.device_id}_intelligent_recognition"
        )

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.intelligent_recognition

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_intelligent_recognition(True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_intelligent_recognition(False)
        await self.coordinator.async_request_refresh()


class DreameCloudCustomizedCleaningSwitch(DreameCloudEntity, SwitchEntity):
    """Apply per-room cleanset (mode/suction/water) from the saved map.

    When off, every clean runs in the global cleaning_mode regardless of
    the per-room preferences set in the Dreame app. Mirrors the app's
    "Customized cleaning" toggle (siid 4 piid 26).
    """

    _attr_icon = "mdi:home-edit"
    _attr_translation_key = "customized_cleaning"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DreameCloudCoordinator) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self._attr_unique_id = (
            f"{coordinator.device_id}_customized_cleaning"
        )

    @property
    def is_on(self) -> bool:
        return self.coordinator.data.customized_cleaning

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_customized_cleaning(True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.device.set_customized_cleaning(False)
        await self.coordinator.async_request_refresh()
