# ha-dreame-cloud

Custom Home Assistant integration for Dreame robot vacuums via the Dreame cloud API.

## Architecture

- `custom_components/dreame_cloud/` is the HA integration
- `dreame_mocker` package (pip-installed) provides the cloud API client and map decoder
- The map card is a vanilla JS custom Lovelace card at `custom_components/dreame_cloud/www/dreame-vacuum-map-card.js`

## Map data pipeline

1. Vacuum stores map in Dreame cloud as an encrypted binary blob
2. `dreame_mocker.client.MapDecoder` downloads, decrypts (AES-256-CBC), decompresses (zlib), and parses it
3. Binary format: 27-byte header (`<2hb11h`) + pixel grid (1 byte/pixel) + trailing JSON metadata
4. `camera.py` renders the pixel grid to PNG and exposes metadata as entity attributes
5. The JS card reads the camera entity's image + attributes to draw the interactive map

## Offline map cache

The coordinator persists map data and device info to `.storage/dreame_cloud_map_cache.json` on every successful map fetch. This enables the integration to display the last known map when the robot is offline.

- **Cache format**: JSON with `header` (MapHeader fields), `pixels` (base64), `rooms`, `metadata` (raw map JSON), and `device` (model, name, did)
- **Startup**: `async_load_map_cache()` is called before the first coordinator refresh. If the cloud is unreachable but a cache exists, the coordinator returns an "Offline" status with the cached map instead of raising `UpdateFailed`
- **Mid-session disconnect**: If property fetches fail after a successful connection, the coordinator returns `_last_good_data` (in-memory) rather than marking entities unavailable
- **Auth errors are not cached**: `ConfigEntryAuthFailed` always propagates (bad credentials should not be silently ignored)
- **First-ever setup**: Still requires a live connection to discover the device. The cache only helps on subsequent startups

## Pixel encoding

Each pixel byte uses bitmask encoding:
- Bits 0-5 (0x3F): room/segment ID (0 = unassigned, 1-63 = room)
- Bit 6 (0x40): carpet flag
- Bit 7 (0x80): wall flag

## Map metadata keys (from real X50 Ultra Complete)

The trailing JSON contains these zone-related keys:

| Key | Contents | Notes |
|-----|----------|-------|
| `sneak_areas` | `[{id, type, hide, roi: [x1,y1,...x4,y4]}]` | Low-lying/low-clearance zones (areas under furniture). NOT no-go zones. |
| `sneak_areas_end` | Same as sneak_areas + `area`, `ms` fields | End-of-clean snapshot with timing data |
| `vw` | `{line: [[x1,y1,x2,y2],...], rect: [...], mop: [...]}` | Virtual walls (line), no-go zones (rect), no-mop zones (mop). Currently absent on this vacuum. |
| `ai_outborders_user` | User-defined out-of-bounds | Currently empty |
| `ai_furniture` | `[[cx, cy, type, flag, cx2, cy2, w, h], ...]` | AI-detected furniture (8 values per item) |
| `ai_furniture_user` | `[[cx, cy, type, flag, cx2, cy2, w, h, user_flag], ...]` | User-confirmed furniture (9 values, adds user_flag) |
| `ai_furniture_new` | (null on this device) | Newly detected furniture not yet confirmed |
| `carpetcleanset` | `[[mode, room, ...]]` | Per-room carpet cleaning settings (not zones) |
| `cleanset` | `{"room_id": [settings...]}` (JSON string) | Per-room cleaning parameters |
| `seg_inf` | `{"id": {name, type, roomID, nei_id}}` | Room info (names are base64). Not always present in every frame. |

### sneak_areas field meanings

- `hide`: 0 = visible, 1 = auto-hidden by firmware, 2 = manually hidden by user. Hidden zones are not rendered.
- `type`: 0 = auto-detected by robot, 1 = manually added by user. Affects outline color only.
- `roi`: 8 ints = 4 corners [x1,y1, x2,y2, x3,y3, x4,y4] in vacuum coords

### Keys NOT present in live map frame metadata

These keys are absent from the live map frame (req_type=1) but some exist in the `rism` saved map blob:

- `vw` — absent in live frame; present in `rism` with `line`, `rect`, `cliff` sub-keys
- `vws` — absent in live frame; present in `rism` with `vwsl` (3 passable thresholds on this device)
- `cpt.addcpt` / `cpt.nocpt` (manual carpet zones) — not found anywhere
- `carpet_polygon` / `carpet_info` (auto-detected carpet polygons) — not found anywhere

### Saved map blob (`rism` key)

The live map frame (req_type=1) omits zone configuration (virtual walls, no-go zones, thresholds). This data lives inside the `rism` key — an embedded saved map blob:

- **Encoding**: URL-safe base64 → zlib decompress → same binary format (27-byte header + pixels + trailing JSON)
- **Contains**: `vw` (virtual walls, no-go zones, cliffs), `vws` (passable/impassable thresholds, ramps), `sneak_areas` (low-clearance zones)
- `camera.py` decodes `rism` and merges its zone data when the live frame lacks it

### Zone configuration data locations

| Data | Key | Location |
|------|-----|----------|
| Passable thresholds | `vws.vwsl` | `rism` saved map metadata |
| Impassable thresholds | `vws.npthrsd` | `rism` saved map metadata |
| Ramps | `vws.ramp` | `rism` saved map metadata |
| Cliffs | `vw.cliff` | `rism` saved map metadata (inside `vw`, not `vws`) |
| Virtual walls | `vw.line` | `rism` saved map metadata |
| No-go zones | `vw.rect` | `rism` saved map metadata |
| Low-clearance zones | `sneak_areas` | Both live frame and `rism` |

Note: `vw.rect` no-go zones in the saved map use a 5-value format `[x1,y1,x2,y2,flag]` (2 corners + flag), unlike the live map's 8-value format `[x1,y1,...x4,y4]` (4 corners). The renderer currently only handles the 8-value format.

Carpet detection on this model is pixel-level only (0x40 bitmask), not metadata-based.

## Coordinate systems

- **Vacuum coords**: millimeters from map origin. `header.left` and `header.top` are in vacuum coords (not pixel indices).
- **Pixel indices**: `px = (vac_x - header.left) / pixel_size`, `py = (vac_y - header.top) / pixel_size`
- **Image coords**: pixel indices after flip/rotation transforms, then scaled

### Coordinate transform pipeline

Python (`camera.py`): vacuum → pixel → flip → rotate → scale = image coords
JS (`_imageToVacuumCoords`): image → reverse scale → reverse rotate → reverse flip → pixel → vacuum coords

The forward transform applies `flip_x → flip_y → rotate(N steps) → scale`.
The reverse applies `÷scale → rotate(N inverse steps) → reverse flip_y → reverse flip_x → to vacuum`.
The rotation inverse step `(x,y) → (y, curW-1-x)` is iterated `rotation/90` times (not `(360-rotation)/90`, which would apply the forward step instead).

## CI and tooling

GitHub Actions CI (`.github/workflows/ci.yml`) runs on every push and PR to `main`. Four parallel jobs:

| Job | Blocking | What it does |
|-----|----------|--------------|
| **lint** | yes | Runs `ruff check` via `astral-sh/ruff-action@v3`. Config is `select = ["ALL"]` in `pyproject.toml` with ignores for rules incompatible with HA conventions (docstrings, boolean traps, type-checking imports, complexity, etc.). |
| **typecheck** | no | Runs `pyright` in strict mode. Installs public deps plus `dreame-mocker` via HTTPS into a fresh venv. Non-blocking (`continue-on-error: true`) because ~114 strict violations exist, mostly `reportUnknownMemberType` cascading from HA's partially-typed base classes. Type stubs for `dreame-mocker` live in `stubs/` and are used as a fallback when the real package isn't installed. |
| **js-build** | yes | Syntax-checks each source module in `card/src/*.js`, runs `npm run build` (esbuild), syntax-checks the output bundle, then verifies the committed bundle matches the build output (`git diff --exit-code`). Catches forgotten rebuilds. |
| **version-sync** | yes | Reads version from both `pyproject.toml` and `manifest.json` and fails if they differ. |

### Local development

```bash
# Python linting (must pass before push)
ruff check custom_components/

# Type checking (informational, not required to pass)
pyright custom_components/

# JS build (from card/ directory)
cd card && npm run build
```

Dev dependencies: `pyright`, `ruff` (install via `uv sync`). JS build requires Node 22+ and `npm ci` in `card/`.

## Deployment to HA

Python file changes require HA restart. JS changes require resource URL version bump + new browser tab.

```bash
# Deploy Python files (files are root-owned, need sudo)
cat file.py | ssh hassio@homeassistant.local "cat > /tmp/file.py && sudo cp /tmp/file.py /config/custom_components/dreame_cloud/file.py"

# Deploy JS
scp -O www/dreame-vacuum-map-card.js hassio@homeassistant.local:/config/www/dreame-vacuum-map-card.js

# Restart HA (for Python changes)
curl -s -X POST http://homeassistant.local:8123/api/services/homeassistant/restart \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"
```

## Entity naming

Entity IDs are derived from the device name, not the integration domain:
- `vacuum.x50_ultra_complete_vacuum` (not `vacuum.dreame_cloud_vacuum`)
- `camera.x50_ultra_complete_map` (not `camera.dreame_cloud_vacuum_map`)

## Furniture detection

The vacuum's AI detects furniture and stores it in three metadata keys:

- `ai_furniture` — auto-detected items (8 values per item)
- `ai_furniture_user` — user-confirmed items (9 values, appends `user_flag`)
- `ai_furniture_new` — newly detected items pending confirmation (null when empty)

### Item array format

```
[cx, cy, type, flag, cx2, cy2, width, height, user_flag?]
```

- `cx, cy` and `cx2, cy2`: identical center coordinates in vacuum coords (mm)
- `type`: furniture type ID (see FurnitureType enum below)
- `flag`: always 0 in observed data
- `width, height`: dimensions in vacuum coords (mm)
- `user_flag` (index 8, only in `ai_furniture_user`): always 0 in observed data

### FurnitureType enum (from Dreame firmware)

| ID | Name | ID | Name |
|----|------|----|------|
| 1 | Single Bed | 14 | Refrigerator |
| 2 | Double Bed | 15 | Washing Machine |
| 3 | Armchair | 16 | Enclosed Litter Box |
| 4 | Two Seat Sofa | 17 | Air Conditioner |
| 5 | Three Seat Sofa | 18 | TV Cabinet |
| 6 | Dining Table | 19 | Bookshelf |
| 7 | Nightstand | 20 | Shoe Cabinet |
| 8 | Coffee Table | 21 | Wardrobe |
| 9 | Toilet | 22 | Greenery |
| 10 | Litter Box | 23 | Floor Mirror |
| 11 | Pet Bed | 24 | L-Shaped Sofa |
| 12 | Food Bowl | 25 | Round Coffee Table |
| 13 | Pet Toilet | 26 | Table |

Source: Tasshack/dreame-vacuum dev branch `FurnitureType` enum. Types 27-31 exist on newer models (armchairs, multi-seat sofas) but are not yet mapped.

### Current rendering

`camera.py` transforms `ai_furniture_user` items to image coordinates and exposes them as entity attributes. The JS card draws dashed rectangles with centered name labels. No editing support yet (place, move, resize, rotate, delete).

## Zone editing data flow

The map card's edit mode lets users draw/delete zones (no-go, virtual walls, thresholds, etc.). The save flow:

1. JS card converts drawn image coords to vacuum coords via `_imageToVacuumCoords`
2. Calls `dreame_cloud.update_map` service with zone arrays
3. `vacuum.py` sends `send_action(6, 2)` to the vacuum and caches the sent data via `coordinator.set_pending_zone_update()`
4. `coordinator.reset_map_cache()` is called to bypass the idle throttle
5. `camera.py`'s `_handle_coordinator_update` re-renders the map, overlaying `coordinator.pending_zone_update` onto stale `rism` data
6. The entity updates immediately with the new zone positions

The pending overlay is necessary because the cloud's `rism` blob updates lazily (minutes to hours). Without it, deleted zones reappear from stale `rism` data.

## Services

Custom services registered on the vacuum platform:
- `dreame_cloud.clean_segment` (room IDs + settings)
- `dreame_cloud.clean_zone` (coordinate rectangles + settings)
- `dreame_cloud.goto` (x, y vacuum coords; uses spot cleaning at target point)
- `dreame_cloud.update_map` (no-go zones, virtual walls, low-clearance zones, thresholds)
- `dreame_cloud.request_map` (req_type parameter for investigation; logs metadata keys)

## Key constants

- `send_action(4, 1, ...)` = cleaning commands (start segment, zone, spot/goto)
  - Segment clean: `piid 1 = json({"selects": [[seg, suction, water, repeat, mode]]})`
  - Zone clean: `piid 1 = json({"areas": [[x1,y1,x2,y2, suction, water, repeat, mode]]})`
  - Goto/spot: `piid 1 = 20` (spot status) + `piid 10 = json({"points": [[x, y, repeats, suction, water]]})`
- `send_action(6, 2, ...)` = map updates, piid 4 = `json({"vw": {"line": [...], "rect": [...], "cliff": [...]}, "vws": {"vwsl": [...], "npthrsd": [...], "ramp": [...]}, "sneak_areas": [...]})`
- `send_action(6, 1, ...)` = request map data, piid 2 = `json({"req_type": 1, "frame_type": "I", "force_type": 1})`
- Pixel size: typically 50 (= 5cm per pixel)
