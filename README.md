# Dreame Cloud Vacuum for Home Assistant

If anything here ends up being useful to you and you feel like saying thanks, my PayPal is https://paypal.me/genericJE. Truly no expectation either way, just leaving the option here in case.

> **Work in progress** -- This integration is under active development and not ready for general use. APIs, configuration, and behavior may change without notice. Do not install unless you are contributing to development.

[![HACS](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://hacs.xyz)

A Home Assistant custom integration for Dreame robot vacuums via the Dreame Cloud API. Uses the [dreame-mocker](https://github.com/genericJE/dreame-mocker) client library to communicate directly with Dreame's cloud infrastructure -- no Xiaomi cloud dependency.

Built for the **Dreame X50 Ultra Complete**, but should work with other Dreame cloud-connected vacuums.

## Features

### Vacuum entity
- Start, pause, stop, return to dock
- Fan speed control (Quiet / Standard / Strong / Turbo)
- Room-specific cleaning via `clean_segment` service
- Send raw commands via `send_command`
- State attributes: error code, room list

### Map camera
- Live map rendering from decoded Dreame map data
- Color-coded rooms, walls, and carpet zones
- Robot and charger position markers
- Configurable rotation (0/90/180/270) and horizontal/vertical flip
- Auto-refresh during cleaning (5s) and idle (5min)

### Sensors
- Battery level
- Cleaning time and area
- Device state (human-readable)
- Consumable life: main brush, side brush, filter, mop pad (disabled by default)

#### State sensor values in practice

All 13 firmware-level state codes (`Sweeping`, `Idle`, `Paused`, `Error`, `Returning`, `Charging`, `Mopping`, `Drying`, `Washing`, `Sweep+Mop`, `Charge Complete`, `Mop Washing`, `Mop Washing Paused`) emit through the cloud and reach HA — provided the device's Wi‑Fi is on while the state is active. On a real X50 Ultra Complete with Wi‑Fi held on through the whole cycle the observed sequence is:

```
Charge Complete > Washing > Sweep+Mop > Returning > Charging > Washing > Drying
```

Plus `Offline` — a synthetic state the coordinator emits when the device has been unreachable for >90 seconds (see below). It does **not** mean the firmware reported anything — it's a stand-in for "we lost the device."

If your production history shows `Sweep+Mop > Offline` with no intermediate states, it's because Wi‑Fi was cut between phases — either by the X50's own dock-disconnect, or by a user automation that turns off Wi‑Fi when the robot is "done." With Wi‑Fi held on, every phase is observable.

The cleanest "robot finished active cleaning" trigger is `to: Drying`. If your setup has already cut Wi‑Fi by then, `from: [Sweep+Mop, Sweeping, Mopping]` `to: Offline` is the fallback, but it's a workaround — `to: Drying` is the real signal.

### Offline detection

When the device is unreachable, the coordinator transitions the state sensor to `Offline` and zeroes the volatile fields (battery, cleaning time, cleaning area). The map and consumable sensors keep their last known values — the map doesn't change while the device is offline, and a frozen map is more useful in the dashboard than an unavailable camera entity.

A 90-second tolerance window absorbs brief network blips before flipping to `Offline`. Configurable via `OFFLINE_THRESHOLD_SECONDS` in `const.py`.

### Controls
- **Selects**: Water volume, cleaning mode, map rotation
- **Switches**: Do Not Disturb, map flip horizontal, map flip vertical
- **Number**: Speaker volume (0-100)
- **Buttons**: Start mop wash, start mop dry, start dust collection
- **Binary sensor**: Charging state

Map orientation controls (rotation, flip) appear under the **Configuration** section on the device page.

## Installation

### HACS (recommended)

1. Open HACS in Home Assistant
2. Click the three dots menu > **Custom repositories**
3. Add `https://github.com/genericJE/ha-dreame-cloud` as an **Integration**
4. Search for "Dreame Cloud Vacuum" and install
5. Restart Home Assistant

### Manual

1. Copy `custom_components/dreame_cloud/` to your HA `config/custom_components/` directory
2. Restart Home Assistant

## Configuration

1. Go to **Settings > Devices & Services > Add Integration**
2. Search for **Dreame Cloud Vacuum**
3. Enter your Dreame account email and password
4. Select your region (EU / US / CN)

### Authentication notes

- **Password login is required.** Email code login authenticates to a separate identity from Google/Apple-linked accounts, so devices won't appear.
- If your Dreame account is linked via Google or Apple, set a password first: **Dreame app > Settings > Account & Security > Password**.
- The integration auto-detects the correct device region from your account's country setting.

### Mock server

For offline development, point the integration at the [dreame-mocker](https://github.com/genericJE/dreame-mocker) mock server by entering `localhost` as the host during setup.

## Services

### `dreame_cloud.clean_segment`

Clean specific rooms with custom settings.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `segments` | list[int] | required | Room segment IDs to clean |
| `suction_level` | int (0-3) | 1 | 0=Quiet, 1=Standard, 2=Strong, 3=Turbo |
| `water_volume` | int (1-3) | 2 | 1=Low, 2=Medium, 3=High |
| `repeat` | int (1-3) | 1 | Number of cleaning passes |
| `cleaning_mode` | int (0-2) | 2 | 0=Sweeping, 1=Mopping, 2=Sweep & Mop |

**Example automation:**
```yaml
service: dreame_cloud.clean_segment
target:
  entity_id: vacuum.x50_ultra_complete_vacuum
data:
  segments: [1, 3, 5]
  suction_level: 2
  water_volume: 3
  cleaning_mode: 2
  repeat: 2
```

Room segment IDs are available in the vacuum entity's `rooms` state attribute.

## Architecture

```
Config Flow > DreameCloud.connect() > auth + device discovery
     |
Coordinator (30s poll) > single get_properties() call (14 properties)
     |                 > DreameDevice.get_map() (periodic)
     |
Entities < DreameCloudData (status + map + consumables + dnd + volume)
```

The coordinator fetches all device properties in a single RPC call, then distributes the data to all entities via `DreameCloudData`. Map updates happen on a separate cadence: every 5 seconds during cleaning, every 5 minutes when idle.

The integration uses the `dreame-mocker` client library which handles:
- Password authentication with MD5 hashing
- Token caching and auto-refresh
- Region auto-detection (auth on EU, devices on US, etc.)
- Map download, AES decryption, and binary parsing
- Retry with exponential backoff on transient failures

## Requirements

- Home Assistant 2025.1+
- Python 3.13+
- A Dreame account with password authentication enabled
- A cloud-connected Dreame vacuum (tested with X50 Ultra Complete)

## License

[MIT](LICENSE)
