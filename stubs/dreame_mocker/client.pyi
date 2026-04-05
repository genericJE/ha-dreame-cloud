"""Type stubs for dreame_mocker.client."""

from __future__ import annotations

from dataclasses import dataclass
from types import TracebackType
from typing import Any, Self


class DreameError(Exception): ...
class AuthenticationError(DreameError): ...


class DreameCloud:
    def __init__(
        self,
        username: str,
        password: str,
        region: str = ...,
        host: str = ...,
        port: int = ...,
    ) -> None: ...
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def get_device(self) -> DreameDevice: ...
    async def get_devices(self) -> list[DreameDevice]: ...
    async def __aenter__(self) -> Self: ...
    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None: ...


class DreameDevice:
    @property
    def model(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def did(self) -> str: ...

    async def start(self) -> None: ...
    async def pause(self) -> None: ...
    async def stop(self) -> None: ...
    async def return_to_dock(self) -> None: ...
    async def set_suction_level(self, level: int) -> None: ...
    async def set_water_volume(self, volume: int) -> None: ...
    async def set_cleaning_mode(self, mode: int) -> None: ...
    async def set_dnd(self, enabled: bool) -> None: ...
    async def set_volume(self, volume: int) -> None: ...
    async def get_properties(
        self, properties: list[Any],
    ) -> list[dict[str, Any]]: ...
    async def get_map(self, req_type: int = ...) -> DreameMap: ...
    async def send_action(
        self, siid: int, aiid: int, params: list[Any] | None = ...,
    ) -> dict[str, Any]: ...
    async def start_mop_wash(self) -> None: ...
    async def start_mop_dry(self) -> None: ...
    async def start_dust_collection(self) -> None: ...


@dataclass
class DeviceStatus:
    state: int
    state_name: str
    battery: int
    error: int
    suction_level: int
    water_volume: int
    cleaning_mode: int
    cleaning_time: int
    cleaning_area: int


@dataclass
class MapHeader:
    width: int
    height: int
    pixel_size: float
    left: int
    top: int
    robot_x: int
    robot_y: int
    robot_angle: int
    charger_x: int
    charger_y: int
    frame_id: int


class DreameMap:
    header: MapHeader
    pixels: bytes
    rooms: dict[int, Any]
    raw_metadata: dict[str, Any]
