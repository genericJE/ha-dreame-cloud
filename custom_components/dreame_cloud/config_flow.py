"""Config flow for Dreame Cloud Vacuum."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME

from dreame_mocker.client import AuthenticationError, DreameCloud, DreameError

from .const import CONF_HOST, CONF_PORT, CONF_REGION, DEFAULT_PORT, DEFAULT_REGION, DOMAIN

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


class DreameCloudConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Dreame Cloud Vacuum."""

    VERSION = 1

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
                async with cloud, asyncio.timeout(30):
                    await cloud.connect()
                    devices = await cloud.get_devices()

                if not devices:
                    errors["base"] = "no_devices"
                else:
                    unique = user_input[CONF_USERNAME]
                    if host:
                        unique = f"{unique}_{host}"
                    await self.async_set_unique_id(unique)
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title=f"Dreame ({user_input[CONF_USERNAME]})",
                        data=user_input,
                    )
            except AuthenticationError:
                errors["base"] = "invalid_auth"
            except (DreameError, TimeoutError):
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error during config flow")
                errors["base"] = "unknown"

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            errors=errors,
        )
