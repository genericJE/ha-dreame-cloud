"""Dreame Cloud Vacuum integration for Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from .const import CONF_HOST, CONF_PORT, CONF_REGION, DEFAULT_PORT, DOMAIN, PLATFORMS
from .coordinator import DreameCloudCoordinator

_LOGGER = logging.getLogger(__name__)

type DreameCloudConfigEntry = ConfigEntry[DreameCloudCoordinator]

CARD_URL = f"/{DOMAIN}/dreame-vacuum-map-card.js"
CARD_PATH = str(Path(__file__).parent / "www" / "dreame-vacuum-map-card.js")


async def async_setup_entry(
    hass: HomeAssistant, entry: DreameCloudConfigEntry
) -> bool:
    """Set up Dreame Cloud Vacuum from a config entry."""
    if not hass.data.get(f"{DOMAIN}_card_registered"):
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, CARD_PATH, cache_headers=False)]
        )
        hass.data[f"{DOMAIN}_card_registered"] = True

    coordinator = DreameCloudCoordinator(
        hass,
        username=entry.data[CONF_USERNAME],
        password=entry.data[CONF_PASSWORD],
        region=entry.data.get(CONF_REGION, "eu"),
        host=entry.data.get(CONF_HOST),
        port=entry.data.get(CONF_PORT, DEFAULT_PORT),
    )
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: DreameCloudConfigEntry
) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        await entry.runtime_data.async_disconnect()
    return unload_ok


async def async_remove_config_entry_device(
    hass: HomeAssistant,
    config_entry: DreameCloudConfigEntry,
    device_entry: dr.DeviceEntry,
) -> bool:
    """Allow removal of orphaned devices."""
    return True
