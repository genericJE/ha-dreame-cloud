"""Fixtures: a live dreame-mocker cloud on localhost and HA wired to this repo's integration."""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
import uvicorn
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from dreame_mocker.auth import TokenStore
from dreame_mocker.server import create_app
from dreame_mocker.state import DeviceRegistry, VacuumDevice

REPO_ROOT = Path(__file__).resolve().parents[1]


def _expose_integration() -> None:
    """Let HA's loader find custom_components/dreame_cloud from this repo.

    pytest-homeassistant-custom-component ships its own ``custom_components``
    package, which wins the import; HA scans every entry of its ``__path__``.
    """
    import custom_components

    ours = str(REPO_ROOT / "custom_components")
    if ours not in custom_components.__path__:
        custom_components.__path__.append(ours)


_expose_integration()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class MockCloud:
    """dreame-mocker's FastAPI app served by uvicorn in a background thread."""

    def __init__(self) -> None:
        self.port = _free_port()
        self.tokens = TokenStore()
        registry = DeviceRegistry()
        registry.add(VacuumDevice(did="1234567890"))
        config = uvicorn.Config(
            create_app(registry, self.tokens), host="127.0.0.1", port=self.port, log_level="warning",
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True)

    def start(self) -> None:
        self._thread.start()
        deadline = time.monotonic() + 10
        while not self._server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("mock cloud did not start")
            time.sleep(0.02)

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(5)

    @property
    def entry_data(self) -> dict[str, Any]:
        return {"username": "tester", "password": "pw", "region": "eu", "host": "127.0.0.1", "port": self.port}


@pytest.fixture(scope="session")
def mock_cloud() -> Iterator[MockCloud]:
    cloud = MockCloud()
    cloud.start()
    yield cloud
    cloud.stop()


@pytest.fixture(autouse=True)
def _isolate_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Never let a token cache land in the developer's real ~/.config."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))


@pytest.fixture(autouse=True)
async def _ha(
    socket_enabled: None, hass: HomeAssistant, enable_custom_integrations: None,
) -> AsyncIterator[None]:
    assert await async_setup_component(hass, "http", {})
    await hass.async_block_till_done()
    yield
    for name in (".storage/dreame_cloud_map_cache.json",):
        Path(hass.config.path(name)).unlink(missing_ok=True)
    for p in Path(hass.config.path(".storage")).glob("dreame_cloud_tokens_*.json"):
        p.unlink()
