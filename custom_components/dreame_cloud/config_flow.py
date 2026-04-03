"""Config flow for Dreame Cloud."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME

from dreame_mocker.client import AuthenticationError, DreameCloud, DreameError

from .const import (
    CONF_HOST,
    CONF_MAP_FLIP_X,
    CONF_MAP_FLIP_Y,
    CONF_MAP_ROTATION,
    CONF_PORT,
    CONF_REGION,
    DEFAULT_PORT,
    DEFAULT_REGION,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_USERNAME): str,
        vol.Required(CONF_PASSWORD): str,
        vol.Optional(CONF_REGION, default=DEFAULT_REGION): vol.In(
            ["eu", "us", "cn"]
        ),
        vol.Optional(CONF_HOST): str,
        vol.Optional(CONF_PORT, default=DEFAULT_PORT): int,
    }
)


class DreameCloudOptionsFlow(OptionsFlow):
    """Handle options for Dreame Cloud."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage map display options."""
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        current = self.config_entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Optional(
                    CONF_MAP_ROTATION,
                    default=current.get(CONF_MAP_ROTATION, 0),
                ): vol.In({0: "0°", 90: "90°", 180: "180°", 270: "270°"}),
                vol.Optional(
                    CONF_MAP_FLIP_X,
                    default=current.get(CONF_MAP_FLIP_X, False),
                ): bool,
                vol.Optional(
                    CONF_MAP_FLIP_Y,
                    default=current.get(CONF_MAP_FLIP_Y, False),
                ): bool,
            }),
        )


class DreameCloudConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Dreame Cloud."""

    VERSION = 1

    @staticmethod
    def async_get_options_flow(config_entry: ConfigEntry) -> DreameCloudOptionsFlow:
        """Get the options flow."""
        return DreameCloudOptionsFlow(config_entry)

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            host: str | None = user_input.get(CONF_HOST) or None
            port: int = user_input.get(CONF_PORT, DEFAULT_PORT)

            try:
                cloud = DreameCloud(
                    username=user_input[CONF_USERNAME],
                    password=user_input[CONF_PASSWORD],
                    region=user_input.get(CONF_REGION, DEFAULT_REGION),
                    host=host,
                    port=port,
                )
                async with cloud:
                    await cloud.connect()
                    devices = await cloud.get_devices()

                if not devices:
                    errors["base"] = "no_devices"
                else:
                    host_tag = host or "cloud"
                    await self.async_set_unique_id(
                        f"{user_input[CONF_USERNAME]}_{host_tag}"
                    )
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title=f"Dreame ({user_input[CONF_USERNAME]})",
                        data=user_input,
                    )
            except AuthenticationError:
                errors["base"] = "invalid_auth"
            except DreameError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error during config flow")
                errors["base"] = "unknown"

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            errors=errors,
        )
