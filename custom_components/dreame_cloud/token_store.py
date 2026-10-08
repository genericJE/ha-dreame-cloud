"""Where the dreame-mocker client keeps its login token."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from homeassistant.util import slugify

from .const import DOMAIN

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant


def token_path(hass: HomeAssistant, username: str) -> Path:
    """Return the token file for *username* inside HA's ``.storage``.

    dreame-mocker defaults to ``~/.config/dreame-mocker/tokens.json``, which
    lives outside ``/config`` in the HA container and is wiped on every
    core update. One file per account keeps two config entries from
    overwriting each other's token. The client reads and writes it in a
    worker thread, so nothing here blocks the event loop.
    """
    return Path(hass.config.path(".storage", f"{DOMAIN}_tokens_{slugify(username)}.json"))
