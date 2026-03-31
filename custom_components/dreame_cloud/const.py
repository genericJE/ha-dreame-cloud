"""Constants for the Dreame Cloud integration."""

from homeassistant.const import Platform

DOMAIN = "dreame_cloud"

PLATFORMS = [
    Platform.VACUUM,
    Platform.CAMERA,
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.SWITCH,
    Platform.BUTTON,
    Platform.NUMBER,
    Platform.SELECT,
]

CONF_REGION = "region"
CONF_HOST = "host"
CONF_PORT = "port"
DEFAULT_REGION = "eu"
DEFAULT_PORT = 13267
DEFAULT_SCAN_INTERVAL = 30  # seconds
MAP_UPDATE_INTERVAL_CLEANING = 5  # seconds
MAP_UPDATE_INTERVAL_IDLE = 300  # seconds (5 minutes)

# Fan speed names
FAN_SPEED_QUIET = "Quiet"
FAN_SPEED_STANDARD = "Standard"
FAN_SPEED_STRONG = "Strong"
FAN_SPEED_TURBO = "Turbo"

FAN_SPEEDS = [FAN_SPEED_QUIET, FAN_SPEED_STANDARD, FAN_SPEED_STRONG, FAN_SPEED_TURBO]

FAN_SPEED_TO_SUCTION: dict[str, int] = {
    FAN_SPEED_QUIET: 0,
    FAN_SPEED_STANDARD: 1,
    FAN_SPEED_STRONG: 2,
    FAN_SPEED_TURBO: 3,
}

SUCTION_TO_FAN_SPEED: dict[int, str] = {v: k for k, v in FAN_SPEED_TO_SUCTION.items()}

# Cleaning modes
CLEANING_MODE_SWEEPING = "Sweeping"
CLEANING_MODE_MOPPING = "Mopping"
CLEANING_MODE_SWEEP_AND_MOP = "Sweep & Mop"

CLEANING_MODES = [CLEANING_MODE_SWEEPING, CLEANING_MODE_MOPPING, CLEANING_MODE_SWEEP_AND_MOP]

CLEANING_MODE_TO_INT: dict[str, int] = {
    CLEANING_MODE_SWEEPING: 0,
    CLEANING_MODE_MOPPING: 1,
    CLEANING_MODE_SWEEP_AND_MOP: 2,
}

INT_TO_CLEANING_MODE: dict[int, str] = {v: k for k, v in CLEANING_MODE_TO_INT.items()}

# Water volume
WATER_VOLUME_LOW = "Low"
WATER_VOLUME_MEDIUM = "Medium"
WATER_VOLUME_HIGH = "High"

WATER_VOLUMES = [WATER_VOLUME_LOW, WATER_VOLUME_MEDIUM, WATER_VOLUME_HIGH]

WATER_VOLUME_TO_INT: dict[str, int] = {
    WATER_VOLUME_LOW: 1,
    WATER_VOLUME_MEDIUM: 2,
    WATER_VOLUME_HIGH: 3,
}

INT_TO_WATER_VOLUME: dict[int, str] = {v: k for k, v in WATER_VOLUME_TO_INT.items()}

# Room colors for map rendering (RGB)
ROOM_COLORS: list[tuple[int, int, int]] = [
    (135, 206, 235),
    (144, 238, 144),
    (255, 182, 193),
    (255, 218, 185),
    (221, 160, 221),
    (176, 224, 230),
    (255, 255, 180),
    (245, 222, 179),
    (216, 191, 216),
    (152, 251, 152),
    (255, 228, 196),
    (173, 216, 230),
    (250, 250, 210),
    (255, 192, 203),
    (224, 255, 255),
    (255, 228, 225),
]

COLOR_WALL = (80, 80, 80)
COLOR_BACKGROUND = (32, 32, 32)
COLOR_ROBOT = (255, 60, 60)
COLOR_CHARGER = (60, 220, 60)
