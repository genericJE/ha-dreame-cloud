"""Dreame Cloud integration for Home Assistant."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME
from homeassistant.core import HomeAssistant

from .const import CONF_HOST, CONF_PORT, CONF_REGION, DEFAULT_PORT, PLATFORMS
from .coordinator import DreameCloudCoordinator

type DreameCloudConfigEntry = ConfigEntry[DreameCloudCoordinator]


async def async_setup_entry(
    hass: HomeAssistant, entry: DreameCloudConfigEntry
) -> bool:
    """Set up Dreame Cloud from a config entry."""
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
