"""Config flow for Dreame Cloud Vacuum."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from typing import Any

import httpx
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME
from homeassistant.core import HomeAssistant

from dreame_mocker.client import AuthenticationError, DreameCloud, DreameError
from dreame_mocker.client.tokens import TokenStore

from .const import CONF_HOST, CONF_PORT, CONF_REGION, DEFAULT_PORT, DEFAULT_REGION, DOMAIN
from .token_store import token_path

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

STEP_REAUTH_DATA_SCHEMA = vol.Schema({vol.Required(CONF_PASSWORD): str})


async def _async_get_devices(hass: HomeAssistant, data: Mapping[str, Any]) -> list[Any]:
    """Log in with *data* and return the account's devices.

    Any cached token for the account is discarded first so the password is
    actually checked — otherwise a still-valid token would make a wrong
    password look fine. Library and transport errors propagate; the caller
    maps them to form errors.
    """
    store = TokenStore(token_path(hass, data[CONF_USERNAME]))
    await store.async_clear()
    cloud = DreameCloud(
        username=data[CONF_USERNAME],
        password=data[CONF_PASSWORD],
        region=data.get(CONF_REGION, DEFAULT_REGION),
        host=data.get(CONF_HOST) or None,
        port=data.get(CONF_PORT, DEFAULT_PORT),
        token_store=store,
    )
    async with cloud, asyncio.timeout(30):
        await cloud.connect()
        return await cloud.get_devices()


class DreameCloudConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Dreame Cloud Vacuum."""

    VERSION = 1

    async def _async_validate(self, data: Mapping[str, Any]) -> str | None:
        """Try the credentials; return a form error key or None on success."""
        try:
            devices = await _async_get_devices(self.hass, data)
        except AuthenticationError:
            return "invalid_auth"
        except (DreameError, httpx.HTTPError, TimeoutError):
            return "cannot_connect"
        except Exception:
            _LOGGER.exception("Unexpected error during config flow")
            return "unknown"
        return None if devices else "no_devices"

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            if (error := await self._async_validate(user_input)) is not None:
                errors["base"] = error
            else:
                unique = user_input[CONF_USERNAME]
                if host := user_input.get(CONF_HOST):
                    unique = f"{unique}_{host}"
                await self.async_set_unique_id(unique)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"Dreame ({user_input[CONF_USERNAME]})",
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Handle re-authentication after the coordinator reports bad credentials."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for the new password and reload the entry with it."""
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()

        if user_input is not None:
            data = {**entry.data, CONF_PASSWORD: user_input[CONF_PASSWORD]}
            if (error := await self._async_validate(data)) is not None:
                errors["base"] = error
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_PASSWORD: user_input[CONF_PASSWORD]}
                )

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=STEP_REAUTH_DATA_SCHEMA,
            description_placeholders={CONF_USERNAME: entry.data[CONF_USERNAME]},
            errors=errors,
        )
