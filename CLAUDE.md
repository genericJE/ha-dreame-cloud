# ha-dreame-cloud

Custom Home Assistant integration for Dreame robot vacuums via the Dreame cloud API.

## Architecture

- `custom_components/dreame_cloud/` is the HA integration
- `dreame_mocker` package (pip-installed) provides the cloud API client and map decoder
- The map card is a vanilla JS custom Lovelace card at `www/dreame-vacuum-map-card.js`

## Map data pipeline

1. Vacuum stores map in Dreame cloud as an encrypted binary blob
2. `dreame_mocker.client.MapDecoder` downloads, decrypts (AES-256-CBC), decompresses (zlib), and parses it
3. Binary format: 27-byte header (`<2hb11h`) + pixel grid (1 byte/pixel) + trailing JSON metadata
4. `camera.py` renders the pixel grid to PNG and exposes metadata as entity attributes
5. The JS card reads the camera entity's image + attributes to draw the interactive map

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
| `ai_furniture_user` | `[[x, y, type, ...]]` | Detected/confirmed furniture |
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

- **Vacuum coords**: millimeters from map origin. Origin = `metadata["origin"]` or `[header.left * pixel_size, header.top * pixel_size]`
- **Pixel indices**: `px = (vac_x - left * pixel_size) / pixel_size`, `py = (vac_y - top * pixel_size) / pixel_size`
- **Image coords**: pixel indices after flip/rotation transforms, then scaled

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

## Services

Custom services registered on the vacuum platform:
- `dreame_cloud.clean_segment` (room IDs + settings)
- `dreame_cloud.clean_zone` (coordinate rectangles + settings)
- `dreame_cloud.goto` (x, y vacuum coords; uses spot cleaning at target point)
- `dreame_cloud.update_map` (no-go zones, virtual walls, low-clearance zones)
- `dreame_cloud.request_map` (req_type parameter for investigation; logs metadata keys)

## Key constants

- `send_action(4, 1, ...)` = cleaning commands (start segment, zone, spot/goto)
  - Segment clean: `piid 1 = json({"selects": [[seg, suction, water, repeat, mode]]})`
  - Zone clean: `piid 1 = json({"areas": [[x1,y1,x2,y2, suction, water, repeat, mode]]})`
  - Goto/spot: `piid 1 = 20` (spot status) + `piid 10 = json({"points": [[x, y, repeats, suction, water]]})`
- `send_action(6, 2, ...)` = map updates, piid 4 = `json({"vw": {"line": [...], "rect": [...]}, "sneak_areas": [...]})`
- `send_action(6, 1, ...)` = request map data, piid 2 = `json({"req_type": 1, "frame_type": "I", "force_type": 1})`
- Pixel size: typically 50 (= 5cm per pixel)
