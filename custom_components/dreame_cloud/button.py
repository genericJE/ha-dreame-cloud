"""Button platform for Dreame Cloud."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from homeassistant.components.button import ButtonEntity, ButtonEntityDescription
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from dreame_mocker.client import DreameDevice

from . import DreameCloudConfigEntry
from .coordinator import DreameCloudCoordinator
from .entity import DreameCloudEntity


@dataclass(frozen=True, kw_only=True)
class DreameButtonDescription(ButtonEntityDescription):
    """Describe a Dreame button."""

    press_fn: Callable[[DreameDevice], Coroutine[Any, Any, None]]


BUTTON_DESCRIPTIONS: list[DreameButtonDescription] = [
    DreameButtonDescription(
        key="mop_wash",
        translation_key="mop_wash",
        icon="mdi:water-sync",
        press_fn=lambda device: device.start_mop_wash(),
    ),
    DreameButtonDescription(
        key="mop_dry",
        translation_key="mop_dry",
        icon="mdi:fan",
        press_fn=lambda device: device.start_mop_dry(),
    ),
    DreameButtonDescription(
        key="dust_collection",
        translation_key="dust_collection",
        icon="mdi:delete-empty",
        press_fn=lambda device: device.start_dust_collection(),
    ),
]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DreameCloudConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up button entities."""
    coordinator: DreameCloudCoordinator = entry.runtime_data
    async_add_entities(
        DreameCloudButton(coordinator, desc) for desc in BUTTON_DESCRIPTIONS
    )


class DreameCloudButton(DreameCloudEntity, ButtonEntity):
    """Dreame Cloud button."""

    entity_description: DreameButtonDescription

    def __init__(
        self,
        coordinator: DreameCloudCoordinator,
        description: DreameButtonDescription,
    ) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{coordinator.device_id}_{description.key}"

    async def async_press(self) -> None:
        """Handle the button press."""
        await self.entity_description.press_fn(self.coordinator.device)
        await self.coordinator.async_request_refresh()
