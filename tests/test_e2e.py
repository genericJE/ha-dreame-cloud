"""End-to-end tests: the integration against an in-process dreame-mocker cloud."""

from __future__ import annotations

import logging
from http import HTTPStatus
from pathlib import Path
from typing import Any

import pytest
from homeassistant.config_entries import SOURCE_REAUTH, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import issue_registry as ir
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .conftest import MockCloud

DOMAIN = "dreame_cloud"
pytestmark = pytest.mark.allow_hosts(["127.0.0.1"])


def _dead(cloud: MockCloud) -> dict[str, Any]:
    return {**cloud.entry_data, "port": 1}  # nothing listens here


def _our_problems(caplog: pytest.LogCaptureFixture) -> list[str]:
    """WARNING+ records from our code, plus HA-reported misbehaviour about us."""
    out: list[str] = []
    for rec in caplog.records:
        msg = rec.getMessage()
        ours = rec.name.startswith("custom_components.dreame_cloud")
        reported = DOMAIN in msg and any(
            s in msg for s in ("Detected", "update listener", "did not return", "Unexpected error", "Traceback")
        )
        if (ours and rec.levelno >= logging.WARNING) or reported:
            out.append(f"{rec.levelname} {rec.name}: {msg[:200]}")
    return out


async def _setup(hass: HomeAssistant, data: dict[str, Any]) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, data=data, unique_id=f"{data['username']}_{data['host']}")
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def _entity(hass: HomeAssistant, entry: MockConfigEntry, suffix: str) -> str:
    return next(
        e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
        if e.unique_id.endswith(suffix)
    )


async def test_config_flow(hass: HomeAssistant, mock_cloud: MockCloud, caplog: pytest.LogCaptureFixture) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] is FlowResultType.FORM

    bad = await hass.config_entries.flow.async_configure(result["flow_id"], _dead(mock_cloud))
    assert bad["type"] is FlowResultType.FORM
    assert bad["errors"] == {"base": "cannot_connect"}

    ok = await hass.config_entries.flow.async_configure(result["flow_id"], mock_cloud.entry_data)
    assert ok["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert list(Path(hass.config.path(".storage")).glob("dreame_cloud_tokens_*.json"))

    again = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    dup = await hass.config_entries.flow.async_configure(again["flow_id"], mock_cloud.entry_data)
    assert dup["type"] is FlowResultType.ABORT
    assert dup["reason"] == "already_configured"
    assert _our_problems(caplog) == []


async def test_setup_entities_services_unload(
    hass: HomeAssistant, mock_cloud: MockCloud, hass_client: Any, hass_ws_client: Any,
    caplog: pytest.LogCaptureFixture,
) -> None:
    entry = await _setup(hass, mock_cloud.entry_data)
    assert entry.state is ConfigEntryState.LOADED

    ent_reg = er.async_get(hass)
    domains = {e.domain for e in er.async_entries_for_config_entry(ent_reg, entry.entry_id)}
    assert domains == {"vacuum", "image", "sensor", "binary_sensor", "switch", "button", "number", "select"}

    vac = _entity(hass, entry, "_vacuum")
    img = _entity(hass, entry, "_floor_plan")
    assert hass.states.get(vac).state not in ("unavailable", "unknown")

    # The map is served right after setup, without waiting for the next poll.
    client = await hass_client()
    resp = await client.get(f"/api/image_proxy/{img}")
    assert resp.status == HTTPStatus.OK
    assert (await resp.read())[:4] == b"\x89PNG"
    assert (await client.get("/dreame_cloud/dreame-vacuum-map-card.js")).status == HTTPStatus.OK

    for svc, data in (
        ("clean_segment", {"segments": [1, "2"]}),
        ("clean_zone", {"zones": [[0, 0, 1000, 1000]]}),
        ("goto", {"x": "100", "y": 200}),
        ("update_map", {"no_go_zones": [{"roi": [0, 0, 100, 0, 100, 100, 0, 100]}], "virtual_walls": [[0, 0, 10, 10]]}),
        ("request_map", {}),
    ):
        await hass.services.async_call(DOMAIN, svc, {"entity_id": vac, **data}, blocking=True)
    for svc, data in (
        ("start", {}), ("pause", {}), ("return_to_base", {}), ("stop", {}),
        ("set_fan_speed", {"fan_speed": "Turbo"}), ("send_command", {"command": "app_start"}),
    ):
        await hass.services.async_call("vacuum", svc, {"entity_id": vac, **data}, blocking=True)
    await hass.async_block_till_done()

    # Clean by area, then a stale mapping raises the segments repair issue.
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "vacuum/get_segments", "entity_id": vac})
    segments = (await ws.receive_json())["result"]["segments"]
    assert segments
    area = ar.async_get(hass).async_create("Kitchen test")
    ent_reg.async_update_entity_options(
        vac, "vacuum", {"area_mapping": {area.id: [segments[0]["id"]]}, "last_seen_segments": segments},
    )
    await hass.services.async_call(
        "vacuum", "clean_area", {"entity_id": vac, "cleaning_area_id": [area.id]}, blocking=True,
    )
    ent_reg.async_update_entity_options(
        vac, "vacuum", {"area_mapping": {area.id: ["999"]}, "last_seen_segments": [{"id": "999", "name": "Gone"}]},
    )
    entry.runtime_data.async_set_updated_data(entry.runtime_data.data)
    await hass.async_block_till_done()
    assert any(domain == "vacuum" for domain, _ in ir.async_get(hass).issues)

    # Orientation option -> repaint, with no config entry update listener.
    before = hass.states.get(img).state
    flip = _entity(hass, entry, "_map_flip_x")
    await hass.services.async_call("switch", "turn_on", {"entity_id": flip}, blocking=True)
    await hass.async_block_till_done()
    assert entry.options.get("map_flip_x") is True
    assert hass.states.get(img).state != before
    assert not entry.update_listeners

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert _our_problems(caplog) == []


async def test_null_property_does_not_knock_device_offline(
    hass: HomeAssistant, mock_cloud: MockCloud, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from dreame_mocker.client import DreameDevice

    orig = DreameDevice.get_properties

    async def with_nulls(self: DreameDevice, props: Any) -> list[dict[str, Any]]:
        res = await orig(self, props)
        return [{**r, "value": None} if r.get("piid") in (41, 45) else r for r in res]

    monkeypatch.setattr(DreameDevice, "get_properties", with_nulls)
    entry = await _setup(hass, mock_cloud.entry_data)
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(_entity(hass, entry, "_state")).state != "Offline"


async def test_offline_startup(
    hass: HomeAssistant, mock_cloud: MockCloud, hass_client: Any, caplog: pytest.LogCaptureFixture,
) -> None:
    # No cache and no cloud: HA retries setup instead of creating entities.
    dead = await _setup(hass, _dead(mock_cloud))
    assert dead.state is ConfigEntryState.SETUP_RETRY
    assert "Unexpected error" not in caplog.text
    await hass.config_entries.async_remove(dead.entry_id)

    # One good run writes the map cache.
    good = await _setup(hass, mock_cloud.entry_data)
    assert good.state is ConfigEntryState.LOADED
    assert await hass.config_entries.async_unload(good.entry_id)
    await hass.config_entries.async_remove(good.entry_id)
    await hass.async_block_till_done()

    # Cache present, cloud unreachable: loads as Offline and still serves the map.
    caplog.clear()
    entry = await _setup(hass, _dead(mock_cloud))
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(_entity(hass, entry, "_state")).state == "Offline"
    client = await hass_client()
    resp = await client.get(f"/api/image_proxy/{_entity(hass, entry, '_floor_plan')}")
    assert resp.status == HTTPStatus.OK
    assert "Unexpected error" not in caplog.text


async def test_stale_token_recovers(hass: HomeAssistant, mock_cloud: MockCloud) -> None:
    """The cloud forgetting our token (e.g. revoked) costs one re-login, not an Offline device."""
    entry = await _setup(hass, mock_cloud.entry_data)
    assert entry.state is ConfigEntryState.LOADED
    assert await hass.config_entries.async_unload(entry.entry_id)

    mock_cloud.tokens.clear()
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(_entity(hass, entry, "_state")).state != "Offline"


async def test_reauth_flow(hass: HomeAssistant, mock_cloud: MockCloud, caplog: pytest.LogCaptureFixture) -> None:
    entry = await _setup(hass, mock_cloud.entry_data)
    entry.async_start_reauth(hass)
    await hass.async_block_till_done()
    flows = [f for f in hass.config_entries.flow.async_progress() if f["context"]["source"] == SOURCE_REAUTH]
    assert len(flows) == 1
    assert flows[0]["step_id"] == "reauth_confirm"

    result = await hass.config_entries.flow.async_configure(flows[0]["flow_id"], {"password": "new-pw"})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    await hass.async_block_till_done()
    assert entry.data["password"] == "new-pw"
    assert entry.state is ConfigEntryState.LOADED
    assert _our_problems(caplog) == []
