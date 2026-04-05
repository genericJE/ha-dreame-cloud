import { fireEvent, formatDuration, batteryIcon } from "./helpers.js";
import {
  SUCTION_MAP, WATER_MAP, CLEANING_MODE_MAP,
  SUCTION_OPTIONS, WATER_OPTIONS, CLEANING_MODE_OPTIONS,
  RECT_TOOL_COLORS, LINE_TOOL_COLORS, RECT_TOOLS, LINE_TOOLS,
  FURNITURE_TYPES, EDIT_TOOLS, EDIT_TOOL_HINTS,
  STATUS_LABELS, VACUUM_SERVICE_MAP, DOCK_ACTIONS,
  CONSUMABLE_DEFS, SAVE_RESULT_ATTR_MAP,
} from "./constants.js";
import { getStyles } from "./styles.js";
import { DreameVacuumMapCardEditor } from "./editor.js";

const CARD_VERSION = "1.0.0";

// ── Card Definition ──────────────────────────────────────────────────
class DreameVacuumMapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._selectedRooms = new Set();
    this._roomOrder = []; // ordered list of selected room segment IDs
    this._mode = DreameVacuumMapCard._persistedMode || "all"; // all | room | zone | edit | goto
    this._roomView = "map"; // map | list
    this._settingsOpen = false;
    this._dockMenuOpen = false;
    this._zone = null; // {x1, y1, x2, y2} in image px during drawing
    this._zoneFinalized = null; // finalized zone
    this._drawing = false;
    this._lastEntityPicture = null;
    this._entities = {};
    // Edit mode state
    this._editTool = "no_go"; // no_go | wall | carpet | low_clearance | threshold | impassable | ramp | cliff | furniture
    this._editNoGoZones = [];
    this._editVirtualWalls = [];
    this._editCarpetZones = [];
    this._editLowClearanceZones = [];
    this._editPassableThresholds = [];
    this._editImpassableThresholds = [];
    this._editRamps = [];
    this._editCliffs = [];
    this._editFurniture = [];
    this._selectedFurnitureIdx = -1;
    this._furnitureDragAction = null; // null | "move" | "resize-tl" | "resize-tr" | "resize-bl" | "resize-br"
    this._furnitureDragStart = null; // {x, y, origItem: {...}}
    this._furniturePickerOpen = false;
    this._furniturePlacePoint = null; // {x, y} SVG coords where new item goes
    // Zone selection/move/resize state (for rect tools: no_go, carpet, low_clearance, ramp)
    this._selectedZoneIdx = -1;
    this._zoneDragAction = null; // null | "move" | "resize-tl" | "resize-tr" | "resize-bl" | "resize-br"
    this._zoneDragStart = null; // {x, y, origPoints: [...], origBBox: {x,y,w,h}}
    this._editDirty = false;
    this._drawingWall = null; // {x1, y1, x2, y2} during wall drawing
    this._drawingRect = null; // {x1, y1, x2, y2} during rect drawing (no-go, carpet, low-clearance)
    this._pointerStart = null; // {x, y} for tap detection
    // Pin and Go state
    this._gotoPin = null; // {x, y} in SVG coords
    // Lifecycle cleanup
    this._abortController = null;
    this._timeoutIds = new Set();
  }

  disconnectedCallback() {
    this._abortController?.abort();
    for (const id of this._timeoutIds) clearTimeout(id);
    this._timeoutIds.clear();
  }

  _setTimeout(fn, ms) {
    const id = setTimeout(() => {
      this._timeoutIds.delete(id);
      fn();
    }, ms);
    this._timeoutIds.add(id);
    return id;
  }

  static getConfigElement() {
    return document.createElement("dreame-vacuum-map-card-editor");
  }

  static getStubConfig() {
    return { entity: "" };
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Please define an entity");
    }
    const needsRender = !this._rendered
      || config.entity !== this._config?.entity
      || config.map_entity !== this._config?.map_entity;
    this._config = { ...config };
    // Merge localStorage overrides for room aliases and hidden rooms
    const stored = this._loadRoomSettings();
    this._config.room_aliases = { ...(config.room_aliases || {}), ...(stored.room_aliases || {}) };
    this._config.hidden_rooms = stored.hidden_rooms || config.hidden_rooms || [];
    this._deriveEntities();
    if (needsRender) {
      this._render();
      this._rendered = true;
    } else {
      this._updateContent();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._rendered) this._updateContent();
  }

  _deriveEntities() {
    const entity = this._config.entity;
    // vacuum.dreame_x50_ultra_complete_vacuum -> dreame_x50_ultra_complete
    const base = entity.replace("vacuum.", "").replace(/_vacuum$/, "");
    this._entities = {
      vacuum: entity,
      map: this._config.map_entity || `camera.${base}_map`,
      battery: `sensor.${base}_battery`,
      cleaning_time: `sensor.${base}_cleaning_time`,
      cleaning_area: `sensor.${base}_cleaning_area`,
      state: `sensor.${base}_state`,
      cleaning_mode: `select.${base}_cleaning_mode`,
      water_volume: `select.${base}_water_volume`,
      suction_level: `select.${base}_suction_level`,
      dnd: `switch.${base}_do_not_disturb`,
      volume: `number.${base}_volume`,
      main_brush: `sensor.${base}_main_brush_life`,
      side_brush: `sensor.${base}_side_brush_life`,
      filter: `sensor.${base}_filter_life`,
      mop_pad: `sensor.${base}_mop_pad_life`,
      mop_wash: `button.${base}_start_mop_wash`,
      mop_dry: `button.${base}_start_mop_dry`,
      dust_collection: `button.${base}_start_dust_collection`,
    };
  }

  _getRoomName(segId, room) {
    const alias = this._config.room_aliases?.[String(segId)];
    if (alias) return alias;
    return room?.name || `Room ${segId}`;
  }

  _roomSettingsKey() {
    return `dreame-map-rooms-${this._config.entity || "default"}`;
  }

  _loadRoomSettings() {
    try {
      const raw = localStorage.getItem(this._roomSettingsKey());
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  _saveRoomSettings() {
    const data = {
      room_aliases: this._config.room_aliases || {},
      hidden_rooms: this._config.hidden_rooms || [],
    };
    localStorage.setItem(this._roomSettingsKey(), JSON.stringify(data));
  }

  _fireConfigChanged() {
    this._saveRoomSettings();
  }

  _getState(entityId) {
    if (!this._hass || !this._hass.states[entityId]) return null;
    return this._hass.states[entityId];
  }

  _getVacuumState() {
    const s = this._getState(this._entities.vacuum);
    if (!s) return "unavailable";
    return s.state;
  }

  _isActive() {
    const state = this._getVacuumState();
    return ["cleaning", "returning"].includes(state);
  }

  _render() {
    const shadow = this.shadowRoot;
    shadow.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = getStyles();
    shadow.appendChild(style);

    const card = document.createElement("ha-card");
    card.innerHTML = `
      <div class="card-content">
        <div class="header"></div>
        <div class="map-container">
          <img class="map-image" crossorigin="anonymous" />
          <svg class="map-overlay"></svg>
          <div class="map-placeholder">No map data</div>
        </div>
        <div class="mode-tabs">
          <button class="tab" data-mode="all">All</button>
          <button class="tab" data-mode="room">Room</button>
          <button class="tab" data-mode="zone">Zone</button>
        </div>
        <div class="room-list-container"></div>
        <div class="config-section"></div>
        <div class="actions"></div>
        <div class="settings-panel"></div>
      </div>
    `;
    shadow.appendChild(card);

    // Bind mode tabs
    card.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const newMode = tab.dataset.mode;
        this._mode = newMode;
        DreameVacuumMapCard._persistedMode = newMode;
        this._selectedRooms.clear();
        this._roomOrder = [];
        this._zoneFinalized = null;
        this._zone = null;
        this._gotoPin = null;
        if (newMode === "edit") {
          this._enterEditMode();
        } else {
          this._exitEditMode();
        }
        this._updateContent();
      });
    });

    // Bind map interaction (use AbortController for cleanup on re-render/disconnect)
    this._abortController?.abort();
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const mapContainer = card.querySelector(".map-container");
    mapContainer.addEventListener("pointerdown", (e) => this._onPointerDown(e), { signal });
    mapContainer.addEventListener("pointermove", (e) => this._onPointerMove(e), { signal });
    mapContainer.addEventListener("pointerup", (e) => this._onPointerUp(e), { signal });

    this._updateContent();
  }

  _updateContent() {
    if (!this._hass || !this.shadowRoot) return;

    const card = this.shadowRoot.querySelector("ha-card");
    if (!card) return;

    this._updateHeader(card);
    this._updateMap(card);
    this._updateModeTabs(card);
    this._updateRoomList(card);
    this._updateConfigSection(card);
    this._updateActions(card);
    // Only rebuild settings panel when toggling open/close, not on every hass update.
    // This prevents races where a service call re-renders the panel before HA
    // processes a prior state change (e.g. DND toggle reverts visually).
    if (!this._settingsOpen) {
      this._updateSettingsPanel(card);
    }
  }

  _updateHeader(card) {
    const header = card.querySelector(".header");
    const vacuum = this._getState(this._entities.vacuum);
    if (!vacuum) {
      header.innerHTML = `<div class="header-left"><span class="device-name">Unavailable</span></div>`;
      return;
    }

    const name = vacuum.attributes.friendly_name || "Vacuum";
    const activity = vacuum.state;
    const batteryEntity = this._getState(this._entities.battery);
    const battery = batteryEntity ? parseInt(batteryEntity.state, 10) : (vacuum.attributes.battery_level ?? 0);
    const battIcon = batteryIcon(battery);
    const isActive = this._isActive();

    const cleaningTime = this._getState(this._entities.cleaning_time);
    const cleaningArea = this._getState(this._entities.cleaning_area);

    let statsHtml = "";
    if (isActive) {
      const time = cleaningTime ? formatDuration(parseInt(cleaningTime.state, 10)) : "";
      const area = cleaningArea ? `${cleaningArea.state} m\u00b2` : "";
      statsHtml = `
        <div class="stats">
          ${time ? `<span class="stat"><ha-icon icon="mdi:clock-outline"></ha-icon> ${time}</span>` : ""}
          ${area ? `<span class="stat"><ha-icon icon="mdi:texture-box"></ha-icon> ${area}</span>` : ""}
        </div>
      `;
    }

    const statusLabel = this._formatStatus(activity);

    header.innerHTML = `
      <div class="header-top">
        <div class="header-left">
          <span class="device-name">${name}</span>
          <span class="status-text">${statusLabel}</span>
        </div>
        <div class="header-right">
          <div class="battery">
            <ha-icon icon="${battIcon}"></ha-icon>
            <span>${battery}%</span>
          </div>
          <button class="header-icon-btn ${this._mode === "goto" ? "active" : ""}" data-mode="goto" title="Go To">
            <ha-icon icon="mdi:map-marker"></ha-icon>
          </button>
          <button class="header-icon-btn ${this._mode === "edit" ? "active" : ""}" data-mode="edit" title="Edit Map">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </button>
          <button class="settings-btn" title="Settings">
            <ha-icon icon="mdi:cog"></ha-icon>
          </button>
        </div>
      </div>
      ${statsHtml}
      ${isActive ? '<div class="progress-bar"><div class="progress-bar-fill"></div></div>' : ""}
    `;

    const settingsBtn = header.querySelector(".settings-btn");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", () => {
        this._settingsOpen = !this._settingsOpen;
        this._updateSettingsPanel(card);
      });
    }

    header.querySelectorAll(".header-icon-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newMode = btn.dataset.mode;
        if (this._mode === newMode) {
          this._mode = "all";
          DreameVacuumMapCard._persistedMode = "all";
          if (newMode === "edit") this._exitEditMode();
        } else {
          this._mode = newMode;
          DreameVacuumMapCard._persistedMode = newMode;
          if (newMode === "edit") {
            this._enterEditMode();
          } else {
            this._exitEditMode();
          }
        }
        this._selectedRooms.clear();
        this._roomOrder = [];
        this._zoneFinalized = null;
        this._zone = null;
        this._gotoPin = null;
        this._updateContent();
      });
    });
  }

  _formatStatus(activity) {
    return STATUS_LABELS[activity] || activity;
  }

  _updateMap(card) {
    const mapImg = card.querySelector(".map-image");
    const mapOverlay = card.querySelector(".map-overlay");
    const placeholder = card.querySelector(".map-placeholder");
    const camera = this._getState(this._entities.map);

    if (!camera || !camera.attributes.entity_picture) {
      mapImg.style.display = "none";
      mapOverlay.style.display = "none";
      placeholder.style.display = "flex";
      return;
    }

    placeholder.style.display = "none";
    mapImg.style.display = "block";
    mapOverlay.style.display = "block";

    // Update image src only when entity_picture changes
    const pic = camera.attributes.entity_picture;
    if (pic !== this._lastEntityPicture) {
      mapImg.src = pic;
      this._lastEntityPicture = pic;
    }

    // Set SVG dimensions from attributes
    const mapWidth = camera.attributes.map_width || 800;
    const mapHeight = camera.attributes.map_height || 600;
    mapOverlay.setAttribute("viewBox", `0 0 ${mapWidth} ${mapHeight}`);

    // Build SVG content
    let svgContent = "";

    // Room overlays (only in room mode)
    const rooms = camera.attributes.rooms || {};
    const hiddenRooms = this._config.hidden_rooms || [];
    if (this._mode === "room") {
      for (const [segId, room] of Object.entries(rooms)) {
        if (hiddenRooms.includes(parseInt(segId, 10))) continue;
        const selected = this._selectedRooms.has(parseInt(segId, 10));
        const [r, g, b] = room.color || [135, 206, 235];
        const opacity = selected ? 0.5 : 0.15;
        const strokeWidth = selected ? 3 : 1;
        const strokeColor = selected ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},0.4)`;

        const orderIdx = this._roomOrder.indexOf(parseInt(segId, 10));
        const badgeY = room.center_y - (Math.min(room.w, room.h) > 80 ? 24 : 18);
        const orderBadge = selected && orderIdx >= 0 ? `
            <circle cx="${room.center_x}" cy="${badgeY}" r="14"
              fill="none" stroke="rgba(0,0,0,0.5)" stroke-width="2" />
            <circle cx="${room.center_x}" cy="${badgeY}" r="12"
              fill="rgb(${r},${g},${b})" stroke="white" stroke-width="2" />
            <text x="${room.center_x}" y="${badgeY}"
              text-anchor="middle" dominant-baseline="central"
              fill="white" font-size="12" font-weight="700"
              font-family="system-ui, sans-serif"
              paint-order="stroke" stroke="rgba(0,0,0,0.6)" stroke-width="3">
              ${orderIdx + 1}
            </text>
          ` : "";

        svgContent += `
          <g class="room-overlay" data-seg-id="${segId}" style="cursor:pointer">
            <rect x="${room.x}" y="${room.y}" width="${room.w}" height="${room.h}"
              fill="rgba(${r},${g},${b},${opacity})"
              stroke="${strokeColor}" stroke-width="${strokeWidth}"
              rx="4" ry="4" />
            <text x="${room.center_x}" y="${room.center_y}"
              text-anchor="middle" dominant-baseline="middle"
              fill="white" font-size="${Math.min(room.w, room.h) > 80 ? 14 : 10}"
              font-family="system-ui, sans-serif" font-weight="500"
              paint-order="stroke" stroke="rgba(0,0,0,0.6)" stroke-width="3">
              ${this._getRoomName(segId, room)}
            </text>
            <text x="${room.x + 6}" y="${room.y + 12}"
              fill="rgba(255,255,255,0.5)" font-size="9"
              font-family="system-ui, sans-serif" font-weight="600"
              paint-order="stroke" stroke="rgba(0,0,0,0.4)" stroke-width="2">
              #${segId}
            </text>
            ${orderBadge}
          </g>
        `;
      }
    }

    // Zone type rendering config: [editArray, attrKey, fill, stroke, toolId]
    const _zoneStyles = [
      [this._editNoGoZones, "no_go_zones", "rgba(244,67,54,0.2)", "#f44336", "no_go"],
      [this._editCarpetZones, "carpet_zones", "rgba(156,39,176,0.2)", "#9c27b0", "carpet"],
      [this._editLowClearanceZones, "low_clearance_zones", "rgba(33,150,243,0.2)", "#2196f3", "low_clearance"],
    ];
    for (const [editZones, attrKey, fill, stroke, toolId] of _zoneStyles) {
      const zones = this._mode === "edit" ? editZones : (camera.attributes[attrKey] || []);
      for (let zi = 0; zi < zones.length; zi++) {
        const zone = zones[zi];
        if (!zone.points || zone.points.length !== 4) continue;
        const isSelectedZone = this._mode === "edit" && this._editTool === toolId
          && zi === this._selectedZoneIdx;
        const pts = zone.points.map((p) => `${p.x},${p.y}`).join(" ");
        svgContent += `
          <polygon points="${pts}"
            fill="${isSelectedZone ? "rgba(255,193,7,0.25)" : fill}"
            stroke="${isSelectedZone ? "#ffc107" : stroke}"
            stroke-width="${isSelectedZone ? 3 : 2}"
            stroke-dasharray="6 3"
            style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
        `;
        if (isSelectedZone) {
          const bb = this._zoneBBox(zone);
          if (bb) {
            const hs = 5;
            const corners = [
              [bb.x, bb.y], [bb.x + bb.w, bb.y],
              [bb.x, bb.y + bb.h], [bb.x + bb.w, bb.y + bb.h],
            ];
            for (const [hx, hy] of corners) {
              svgContent += `
                <rect x="${hx - hs}" y="${hy - hs}" width="${hs * 2}" height="${hs * 2}"
                  fill="#ffc107" stroke="#fff" stroke-width="1" rx="1"
                  style="cursor:nwse-resize" />
              `;
            }
          }
        }
      }
    }

    // Drawing preview for rect zones
    if (this._mode === "edit" && this._drawingRect) {
      const d = this._drawingRect;
      const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2);
      const w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
      const color = RECT_TOOL_COLORS[this._editTool] || "#f44336";
      svgContent += `
        <rect x="${x}" y="${y}" width="${w}" height="${h}"
          fill="${color}26" stroke="${color}" stroke-width="2"
          stroke-dasharray="4 2" />
      `;
    }

    // Virtual walls (use edit working copy in edit mode)
    const virtualWalls = this._mode === "edit" ? this._editVirtualWalls : (camera.attributes.virtual_walls || []);
    for (let i = 0; i < virtualWalls.length; i++) {
      const wall = virtualWalls[i];
      svgContent += `
        <line x1="${wall.x1}" y1="${wall.y1}" x2="${wall.x2}" y2="${wall.y2}"
          stroke="#f44336" stroke-width="3" stroke-dasharray="8 4" stroke-linecap="round"
          style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
      `;
    }

    // Passable thresholds (green dashed lines)
    const passableThresholds = this._mode === "edit"
      ? this._editPassableThresholds
      : (camera.attributes.passable_thresholds || []);
    for (const t of passableThresholds) {
      svgContent += `
        <line x1="${t.x1}" y1="${t.y1}" x2="${t.x2}" y2="${t.y2}"
          stroke="#4caf50" stroke-width="3" stroke-dasharray="8 4" stroke-linecap="round"
          style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
      `;
    }

    // Impassable thresholds (red dashed lines, thinner than virtual walls)
    const impassableThresholds = this._mode === "edit"
      ? this._editImpassableThresholds
      : (camera.attributes.impassable_thresholds || []);
    for (const t of impassableThresholds) {
      svgContent += `
        <line x1="${t.x1}" y1="${t.y1}" x2="${t.x2}" y2="${t.y2}"
          stroke="#ff5722" stroke-width="3" stroke-dasharray="6 4" stroke-linecap="round"
          style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
      `;
    }

    // Cliffs (brown dashed lines)
    const cliffs = this._mode === "edit"
      ? this._editCliffs
      : (camera.attributes.cliffs || []);
    for (const t of cliffs) {
      svgContent += `
        <line x1="${t.x1}" y1="${t.y1}" x2="${t.x2}" y2="${t.y2}"
          stroke="#795548" stroke-width="3" stroke-dasharray="6 3" stroke-linecap="round"
          style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
      `;
    }

    // Ramps (orange filled rectangles)
    const ramps = this._mode === "edit"
      ? this._editRamps
      : (camera.attributes.ramps || []);
    for (let ri = 0; ri < ramps.length; ri++) {
      const ramp = ramps[ri];
      if (!ramp.points || ramp.points.length !== 4) continue;
      const isSelectedRamp = this._mode === "edit" && this._editTool === "ramp"
        && ri === this._selectedZoneIdx;
      const pts = ramp.points.map((p) => `${p.x},${p.y}`).join(" ");
      svgContent += `
        <polygon points="${pts}"
          fill="${isSelectedRamp ? "rgba(255,193,7,0.25)" : "rgba(255,152,0,0.2)"}"
          stroke="${isSelectedRamp ? "#ffc107" : "#ff9800"}"
          stroke-width="${isSelectedRamp ? 3 : 2}"
          stroke-dasharray="6 3"
          style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
      `;
      if (isSelectedRamp) {
        const bb = this._zoneBBox(ramp);
        if (bb) {
          const hs = 5;
          const corners = [
            [bb.x, bb.y], [bb.x + bb.w, bb.y],
            [bb.x, bb.y + bb.h], [bb.x + bb.w, bb.y + bb.h],
          ];
          for (const [hx, hy] of corners) {
            svgContent += `
              <rect x="${hx - hs}" y="${hy - hs}" width="${hs * 2}" height="${hs * 2}"
                fill="#ffc107" stroke="#fff" stroke-width="1" rx="1"
                style="cursor:nwse-resize" />
            `;
          }
        }
      }
    }

    // Drawing preview for line tools (wall, threshold, impassable, cliff)
    if (this._mode === "edit" && this._drawingWall) {
      const d = this._drawingWall;
      const lineColor = LINE_TOOL_COLORS[this._editTool] || "#f44336";
      svgContent += `
        <line x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}"
          stroke="${lineColor}" stroke-width="3" stroke-dasharray="4 2"
          stroke-linecap="round" opacity="0.7" />
      `;
    }

    // Furniture
    const furnitureItems = (this._mode === "edit" && this._editTool === "furniture")
      ? this._editFurniture
      : (camera.attributes.furniture || []);
    for (let fi = 0; fi < furnitureItems.length; fi++) {
      const item = furnitureItems[fi];
      const isSelected = this._mode === "edit" && this._editTool === "furniture"
        && fi === this._selectedFurnitureIdx;
      const strokeColor = isSelected ? "#ffc107" : "rgba(158, 158, 158, 0.5)";
      const fillColor = isSelected ? "rgba(255, 193, 7, 0.15)" : "rgba(158, 158, 158, 0.15)";
      const strokeWidth = isSelected ? 2 : 1;
      svgContent += `
        <rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}"
          fill="${fillColor}" stroke="${strokeColor}"
          stroke-width="${strokeWidth}" stroke-dasharray="4 2" rx="2"
          style="${this._mode === "edit" && this._editTool === "furniture" ? "cursor:pointer" : ""}" />
        <text x="${item.x + item.w / 2}" y="${item.y + item.h / 2}"
          text-anchor="middle" dominant-baseline="middle"
          fill="rgba(255,255,255,0.6)" font-size="9"
          font-family="system-ui, sans-serif" pointer-events="none"
          paint-order="stroke" stroke="rgba(0,0,0,0.4)" stroke-width="2">
          ${item.name}
        </text>
      `;
      // Resize handles for selected furniture
      if (isSelected) {
        const hs = 5;
        const corners = [
          [item.x, item.y],
          [item.x + item.w, item.y],
          [item.x, item.y + item.h],
          [item.x + item.w, item.y + item.h],
        ];
        for (const [hx, hy] of corners) {
          svgContent += `
            <rect x="${hx - hs}" y="${hy - hs}" width="${hs * 2}" height="${hs * 2}"
              fill="#ffc107" stroke="#fff" stroke-width="1" rx="1"
              style="cursor:nwse-resize" />
          `;
        }
      }
    }

    // SVG defs for gradients/filters (only add once)
    svgContent += `
      <defs>
        <radialGradient id="robotBody" cx="40%" cy="35%" r="60%">
          <stop offset="0%" stop-color="#505060" />
          <stop offset="100%" stop-color="#252530" />
        </radialGradient>
        <radialGradient id="lidarTurret" cx="45%" cy="40%" r="55%">
          <stop offset="0%" stop-color="#6a6a7a" />
          <stop offset="100%" stop-color="#3a3a48" />
        </radialGradient>
        <filter id="robotShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.5)" />
        </filter>
        <radialGradient id="chargerGrad" cx="40%" cy="35%" r="60%">
          <stop offset="0%" stop-color="#43a047" />
          <stop offset="100%" stop-color="#2e7d32" />
        </radialGradient>
      </defs>
    `;

    // Robot position (top-down robot vacuum)
    const robotPos = camera.attributes.robot_position;
    if (robotPos) {
      const rx = robotPos.x, ry = robotPos.y;
      const R = 16;
      // Vacuum angle: 0=east, CCW+. SVG robot faces up (90deg in math).
      // SVG rotate is CW, so: svgAngle = 90 - angle.
      const svgAngle = robotPos.angle != null ? 90 - robotPos.angle : 0;
      svgContent += `
        <g transform="translate(${rx}, ${ry}) rotate(${svgAngle})" filter="url(#robotShadow)">
          <!-- Body -->
          <circle cx="0" cy="0" r="${R}" fill="url(#robotBody)" />
          <!-- Edge ring -->
          <circle cx="0" cy="0" r="${R}" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5" />
          <!-- Front bumper (top of robot = forward) -->
          <path d="M${-R + 3},${-4} A${R - 3},${R - 3} 0 0,1 ${R - 3},${-4}"
            fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2.5" stroke-linecap="round" />
          <!-- LiDAR turret -->
          <circle cx="0" cy="0" r="8" fill="url(#lidarTurret)" />
          <circle cx="0" cy="0" r="8" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="0.8" />
          <!-- LiDAR slit -->
          <rect x="-5" y="-1" width="10" height="2" rx="1" fill="rgba(100,180,255,0.5)" />
          <!-- Side brush indicator (bottom-left) -->
          <g transform="translate(${-R + 8}, ${R - 8})">
            <line x1="-4" y1="0" x2="4" y2="0" stroke="rgba(255,255,255,0.3)" stroke-width="1" />
            <line x1="0" y1="-4" x2="0" y2="4" stroke="rgba(255,255,255,0.3)" stroke-width="1" />
            <line x1="-3" y1="-3" x2="3" y2="3" stroke="rgba(255,255,255,0.3)" stroke-width="1" />
            <line x1="3" y1="-3" x2="-3" y2="3" stroke="rgba(255,255,255,0.3)" stroke-width="1" />
          </g>
          <!-- Forward direction dot -->
          <circle cx="0" cy="${-R + 7}" r="2.5" fill="rgba(66,165,245,0.8)" />
        </g>
      `;
    }

    // Charger position (dock icon)
    const chargerPos = camera.attributes.charger_position;
    if (chargerPos) {
      const cx = chargerPos.x, cy = chargerPos.y;
      svgContent += `
        <g transform="translate(${cx}, ${cy})" filter="url(#robotShadow)">
          <rect x="-14" y="-14" width="28" height="28" rx="6"
            fill="url(#chargerGrad)" />
          <rect x="-14" y="-14" width="28" height="28" rx="6"
            fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1" />
          <path d="M-4,-8 L4,-8 L1.5,-1.5 L5.5,-1.5 L-2.5,8 L0,1.5 L-5.5,1.5 Z"
            fill="white" opacity="0.85" />
        </g>
      `;
    }

    // Zone rectangle
    const zone = this._zone || this._zoneFinalized;
    if (zone && this._mode === "zone") {
      const zx = Math.min(zone.x1, zone.x2);
      const zy = Math.min(zone.y1, zone.y2);
      const zw = Math.abs(zone.x2 - zone.x1);
      const zh = Math.abs(zone.y2 - zone.y1);
      svgContent += `
        <rect x="${zx}" y="${zy}" width="${zw}" height="${zh}"
          fill="rgba(66, 133, 244, 0.2)" stroke="#4285f4" stroke-width="2"
          stroke-dasharray="8 4" rx="2" ry="2" />
      `;
      // Corner handles
      for (const [hx, hy] of [[zx, zy], [zx + zw, zy], [zx, zy + zh], [zx + zw, zy + zh]]) {
        svgContent += `<circle cx="${hx}" cy="${hy}" r="6" fill="#4285f4" stroke="white" stroke-width="2" />`;
      }
    }

    // Goto pin
    if (this._gotoPin && this._mode === "goto") {
      const gx = this._gotoPin.x, gy = this._gotoPin.y;
      svgContent += `
        <g transform="translate(${gx}, ${gy})">
          <circle cx="0" cy="0" r="14" fill="rgba(33, 150, 243, 0.3)" />
          <circle cx="0" cy="0" r="8" fill="#2196f3" stroke="white" stroke-width="2" />
          <circle cx="0" cy="0" r="3" fill="white" />
          <!-- Pin stem and head -->
          <line x1="0" y1="-8" x2="0" y2="-28" stroke="#2196f3" stroke-width="2.5" />
          <circle cx="0" cy="-28" r="6" fill="#2196f3" stroke="white" stroke-width="2" />
        </g>
      `;
    }

    mapOverlay.innerHTML = svgContent;

    // Bind room click handlers
    if (this._mode === "room") {
      mapOverlay.querySelectorAll(".room-overlay").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const segId = parseInt(el.dataset.segId, 10);
          if (this._selectedRooms.has(segId)) {
            this._selectedRooms.delete(segId);
            this._roomOrder = this._roomOrder.filter((id) => id !== segId);
          } else {
            this._selectedRooms.add(segId);
            this._roomOrder.push(segId);
          }
          this._updateContent();
        });
      });
    }

    // (Edit mode deletion is handled via tap detection in _onPointerUp)
  }

  _onPointerDown(e) {
    const pt = this._getSvgCoords(e);
    if (!pt) return;
    const svg = this.shadowRoot.querySelector(".map-overlay");

    if (this._mode === "zone") {
      this._drawing = true;
      this._zone = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      this._zoneFinalized = null;
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (this._mode === "goto") {
      this._pointerStart = { x: pt.x, y: pt.y };
      e.preventDefault();
      return;
    }

    if (this._mode === "edit") {
      this._pointerStart = { x: pt.x, y: pt.y };

      if (this._editTool === "furniture") {
        // Check if pointer is on a resize handle of the selected item
        const handle = this._furnitureHandleHitTest(pt.x, pt.y);
        if (handle) {
          this._furnitureDragAction = handle;
          this._furnitureDragStart = {
            x: pt.x, y: pt.y,
            origItem: { ...this._editFurniture[this._selectedFurnitureIdx] },
          };
          this._drawing = true;
          svg.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
        // Check if pointer is on a furniture item (move)
        const hitIdx = this._furnitureHitTest(pt.x, pt.y);
        if (hitIdx >= 0) {
          this._selectedFurnitureIdx = hitIdx;
          this._furnitureDragAction = "move";
          this._furnitureDragStart = {
            x: pt.x, y: pt.y,
            origItem: { ...this._editFurniture[hitIdx] },
          };
          this._drawing = true;
          svg.setPointerCapture(e.pointerId);
          e.preventDefault();
          this._updateContent();
          return;
        }
        // Tap on empty space will be handled in pointerUp (open picker or deselect)
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }

      if (LINE_TOOLS.includes(this._editTool)) {
        this._drawing = true;
        this._drawingWall = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      } else {
        // Rect-based tools: no_go, carpet, low_clearance, ramp
        // Check for resize handle on selected zone
        const zHandle = this._zoneHandleHitTest(pt.x, pt.y);
        if (zHandle) {
          const zone = this._getEditZonesForTool()[this._selectedZoneIdx];
          this._zoneDragAction = zHandle;
          this._zoneDragStart = {
            x: pt.x, y: pt.y,
            origPoints: zone.points.map((p) => ({ ...p })),
            origBBox: this._zoneBBox(zone),
          };
          this._drawing = true;
          svg.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
        // Check for hit on existing zone (start move)
        const zHitIdx = this._zoneHitTest(pt.x, pt.y);
        if (zHitIdx >= 0) {
          this._selectedZoneIdx = zHitIdx;
          const zone = this._getEditZonesForTool()[zHitIdx];
          this._zoneDragAction = "move";
          this._zoneDragStart = {
            x: pt.x, y: pt.y,
            origPoints: zone.points.map((p) => ({ ...p })),
            origBBox: this._zoneBBox(zone),
          };
          this._drawing = true;
          svg.setPointerCapture(e.pointerId);
          e.preventDefault();
          this._updateContent();
          return;
        }
        // Empty space: start drawing new rect
        this._selectedZoneIdx = -1;
        this._drawing = true;
        this._drawingRect = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      }
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  _onPointerMove(e) {
    const pt = this._getSvgCoords(e);
    if (!pt) return;

    if (this._mode === "zone" && this._drawing && this._zone) {
      this._zone.x2 = pt.x;
      this._zone.y2 = pt.y;
      this._updateMap(this.shadowRoot.querySelector("ha-card"));
      e.preventDefault();
      return;
    }

    if (this._mode === "edit" && this._drawing) {
      if (this._editTool === "furniture" && this._furnitureDragAction && this._furnitureDragStart) {
        const f = this._editFurniture[this._selectedFurnitureIdx];
        const orig = this._furnitureDragStart.origItem;
        const dx = pt.x - this._furnitureDragStart.x;
        const dy = pt.y - this._furnitureDragStart.y;
        if (this._furnitureDragAction === "move") {
          f.x = orig.x + dx;
          f.y = orig.y + dy;
          f.center_x = orig.center_x + dx;
          f.center_y = orig.center_y + dy;
        } else {
          // Resize: adjust the appropriate corner while keeping min size
          const minSize = 10;
          if (this._furnitureDragAction === "resize-br") {
            f.w = Math.max(minSize, orig.w + dx);
            f.h = Math.max(minSize, orig.h + dy);
          } else if (this._furnitureDragAction === "resize-bl") {
            const newW = Math.max(minSize, orig.w - dx);
            f.x = orig.x + orig.w - newW;
            f.w = newW;
            f.h = Math.max(minSize, orig.h + dy);
          } else if (this._furnitureDragAction === "resize-tr") {
            f.w = Math.max(minSize, orig.w + dx);
            const newH = Math.max(minSize, orig.h - dy);
            f.y = orig.y + orig.h - newH;
            f.h = newH;
          } else if (this._furnitureDragAction === "resize-tl") {
            const newW = Math.max(minSize, orig.w - dx);
            const newH = Math.max(minSize, orig.h - dy);
            f.x = orig.x + orig.w - newW;
            f.y = orig.y + orig.h - newH;
            f.w = newW;
            f.h = newH;
          }
          f.center_x = f.x + f.w / 2;
          f.center_y = f.y + f.h / 2;
        }
        this._updateMap(this.shadowRoot.querySelector("ha-card"));
        e.preventDefault();
      } else if (this._zoneDragAction && this._zoneDragStart) {
        this._applyZoneDrag(pt);
        this._updateMap(this.shadowRoot.querySelector("ha-card"));
        e.preventDefault();
      } else if (this._drawingRect) {
        this._drawingRect.x2 = pt.x;
        this._drawingRect.y2 = pt.y;
        this._updateMap(this.shadowRoot.querySelector("ha-card"));
        e.preventDefault();
      } else if (this._drawingWall) {
        this._drawingWall.x2 = pt.x;
        this._drawingWall.y2 = pt.y;
        this._updateMap(this.shadowRoot.querySelector("ha-card"));
        e.preventDefault();
      }
    }
  }

  _onPointerUp(e) {
    // Handle goto tap (no drawing involved)
    if (this._mode === "goto" && this._pointerStart) {
      const pt = this._getSvgCoords(e);
      if (pt) {
        const dist = Math.hypot(pt.x - this._pointerStart.x, pt.y - this._pointerStart.y);
        if (dist < 8) {
          this._gotoPin = { x: pt.x, y: pt.y };
          this._updateContent();
        }
      }
      this._pointerStart = null;
      e.preventDefault();
      return;
    }

    // Furniture tool: handle drag-end and taps separately from zone tools
    if (this._mode === "edit" && this._editTool === "furniture") {
      const pt = this._getSvgCoords(e);
      const start = this._pointerStart;
      const tapDist = start && pt ? Math.hypot(pt.x - start.x, pt.y - start.y) : Infinity;
      const isTap = tapDist < 8;

      if (this._drawing && this._furnitureDragAction) {
        // End of drag (move or resize)
        this._drawing = false;
        if (!isTap) {
          // Recompute vacuum coords from new image position
          const f = this._editFurniture[this._selectedFurnitureIdx];
          if (f) {
            const [vcx, vcy] = this._imageToVacuumCoords(f.center_x, f.center_y);
            // Compute vacuum dimensions from two edge points
            const [vlx, vly] = this._imageToVacuumCoords(f.x, f.y);
            const [vrx, vry] = this._imageToVacuumCoords(f.x + f.w, f.y + f.h);
            f.vacuum_cx = vcx;
            f.vacuum_cy = vcy;
            f.vacuum_w = Math.abs(vrx - vlx);
            f.vacuum_h = Math.abs(vry - vly);
          }
          this._editDirty = true;
        }
        this._furnitureDragAction = null;
        this._furnitureDragStart = null;
        this._pointerStart = null;
        this._updateContent();
        e.preventDefault();
        return;
      }

      // Tap handling
      if (isTap && pt) {
        const hitIdx = this._furnitureHitTest(pt.x, pt.y);
        if (hitIdx >= 0) {
          // Select the tapped item
          this._selectedFurnitureIdx = hitIdx;
        } else {
          // Tap on empty space: deselect or open picker
          if (this._selectedFurnitureIdx >= 0) {
            this._selectedFurnitureIdx = -1;
          } else {
            // Open the type picker to add new furniture here
            this._furniturePlacePoint = { x: pt.x, y: pt.y };
            this._furniturePickerOpen = true;
          }
        }
      }
      this._drawing = false;
      this._furnitureDragAction = null;
      this._furnitureDragStart = null;
      this._pointerStart = null;
      this._updateContent();
      e.preventDefault();
      return;
    }

    if (!this._drawing) return;
    this._drawing = false;

    if (this._mode === "zone" && this._zone) {
      const dx = Math.abs(this._zone.x2 - this._zone.x1);
      const dy = Math.abs(this._zone.y2 - this._zone.y1);
      if (dx > 10 && dy > 10) {
        this._zoneFinalized = { ...this._zone };
      }
      this._zone = null;
      this._updateContent();
      e.preventDefault();
      return;
    }

    if (this._mode === "edit") {
      const pt = this._getSvgCoords(e);
      const start = this._pointerStart;
      const tapDist = start && pt ? Math.hypot(pt.x - start.x, pt.y - start.y) : Infinity;
      const isTap = tapDist < 8;
      const isRectTool = RECT_TOOLS.includes(this._editTool);

      // Zone drag end (move/resize) for rect tools
      if (isRectTool && this._zoneDragAction && this._zoneDragStart) {
        if (!isTap) {
          this._applyZoneDrag(pt);
          this._finalizeZoneDrag();
        } else {
          // Restore original points (was a tap, not a real drag)
          const zones = this._getEditZonesForTool();
          const zone = zones[this._selectedZoneIdx];
          if (zone) {
            zone.points = this._zoneDragStart.origPoints;
          }
        }
        this._zoneDragAction = null;
        this._zoneDragStart = null;
        this._pointerStart = null;
        this._updateContent();
        e.preventDefault();
        return;
      }

      if (isTap) {
        this._drawingRect = null;
        this._drawingWall = null;
        if (isRectTool) {
          // Rect tools: tap to select/deselect zones
          const hitIdx = this._zoneHitTest(pt.x, pt.y);
          if (hitIdx >= 0) {
            this._selectedZoneIdx = hitIdx;
          } else {
            this._selectedZoneIdx = -1;
          }
        } else {
          // Line tools: tap to delete
          const deleted = this._tryDeleteAtPoint(pt.x, pt.y);
          if (deleted) {
            this._editDirty = true;
          }
        }
      } else if (this._drawingRect) {
        const d = this._drawingRect;
        const dx = Math.abs(d.x2 - d.x1);
        const dy = Math.abs(d.y2 - d.y1);
        if (dx > 10 && dy > 10) {
          const x1 = Math.min(d.x1, d.x2), y1 = Math.min(d.y1, d.y2);
          const x2 = Math.max(d.x1, d.x2), y2 = Math.max(d.y1, d.y2);
          const [vx1, vy1] = this._imageToVacuumCoords(x1, y1);
          const [vx2, vy2] = this._imageToVacuumCoords(x2, y1);
          const [vx3, vy3] = this._imageToVacuumCoords(x2, y2);
          const [vx4, vy4] = this._imageToVacuumCoords(x1, y2);
          const newZone = {
            points: [
              { x: Math.round(x1), y: Math.round(y1) },
              { x: Math.round(x2), y: Math.round(y1) },
              { x: Math.round(x2), y: Math.round(y2) },
              { x: Math.round(x1), y: Math.round(y2) },
            ],
            roi: [vx1, vy1, vx2, vy2, vx3, vy3, vx4, vy4],
          };
          // Ramps use 4-coord format (two opposite corners), not 8-coord roi
          if (this._editTool === "ramp") {
            newZone.vacuum_coords = [vx1, vy1, vx3, vy3];
            newZone.type = 0;
          }
          this._getEditZonesForTool().push(newZone);
          this._selectedZoneIdx = this._getEditZonesForTool().length - 1;
          this._editDirty = true;
        }
        this._drawingRect = null;
      } else if (this._drawingWall) {
        const d = this._drawingWall;
        const dist = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
        if (dist > 10) {
          const [vx1, vy1] = this._imageToVacuumCoords(d.x1, d.y1);
          const [vx2, vy2] = this._imageToVacuumCoords(d.x2, d.y2);
          const newLine = {
            x1: Math.round(d.x1), y1: Math.round(d.y1),
            x2: Math.round(d.x2), y2: Math.round(d.y2),
            vacuum_coords: [vx1, vy1, vx2, vy2],
          };
          this._getEditLinesForTool().push(newLine);
          this._editDirty = true;
        }
        this._drawingWall = null;
      }
      this._pointerStart = null;
      this._updateContent();
      e.preventDefault();
    }
  }

  _getEditZonesForTool() {
    switch (this._editTool) {
      case "no_go": return this._editNoGoZones;
      case "carpet": return this._editCarpetZones;
      case "low_clearance": return this._editLowClearanceZones;
      case "ramp": return this._editRamps;
      default: return this._editNoGoZones;
    }
  }

  _getEditLinesForTool() {
    switch (this._editTool) {
      case "wall": return this._editVirtualWalls;
      case "threshold": return this._editPassableThresholds;
      case "impassable": return this._editImpassableThresholds;
      case "cliff": return this._editCliffs;
      default: return this._editVirtualWalls;
    }
  }

  _tryDeleteAtPoint(px, py) {
    // Only check line types (rect zones use select+delete instead of tap-to-delete)
    // Check all line types (virtual walls, thresholds, cliffs)
    const allLineArrays = [
      this._editVirtualWalls,
      this._editPassableThresholds,
      this._editImpassableThresholds,
      this._editCliffs,
    ];
    const tapThreshold = 12;
    for (const lines of allLineArrays) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const w = lines[i];
        const dist = this._pointToSegmentDist(px, py, w.x1, w.y1, w.x2, w.y2);
        if (dist <= tapThreshold) {
          lines.splice(i, 1);
          return true;
        }
      }
    }
    return false;
  }

  _pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // ── Furniture editing ──────────────────────────��───────────────────

  _renderFurniturePicker() {
    const types = FURNITURE_TYPES;
    const buttons = Object.entries(types).map(([id, info]) =>
      `<button class="furniture-type-btn" data-type="${id}">${info.name}</button>`
    ).join("");
    return `
      <div class="furniture-picker">
        <div class="furniture-picker-title">Select furniture type:</div>
        <div class="furniture-picker-grid">${buttons}</div>
        <button class="furniture-picker-cancel">Cancel</button>
      </div>
    `;
  }

  _furnitureHitTest(px, py) {
    // Returns index of furniture item at point, or -1. Tests in reverse order (top-most first).
    for (let i = this._editFurniture.length - 1; i >= 0; i--) {
      const f = this._editFurniture[i];
      if (px >= f.x && px <= f.x + f.w && py >= f.y && py <= f.y + f.h) {
        return i;
      }
    }
    return -1;
  }

  _furnitureHandleHitTest(px, py) {
    if (this._selectedFurnitureIdx < 0) return null;
    const f = this._editFurniture[this._selectedFurnitureIdx];
    if (!f) return null;
    const hs = 8; // handle size (half)
    const corners = {
      "resize-tl": { x: f.x, y: f.y },
      "resize-tr": { x: f.x + f.w, y: f.y },
      "resize-bl": { x: f.x, y: f.y + f.h },
      "resize-br": { x: f.x + f.w, y: f.y + f.h },
    };
    for (const [action, pt] of Object.entries(corners)) {
      if (Math.abs(px - pt.x) <= hs && Math.abs(py - pt.y) <= hs) {
        return action;
      }
    }
    return null;
  }

  _deleteFurniture() {
    if (this._selectedFurnitureIdx >= 0) {
      this._editFurniture.splice(this._selectedFurnitureIdx, 1);
      this._selectedFurnitureIdx = -1;
      this._editDirty = true;
      this._updateContent();
    }
  }

  _addFurniture(typeId) {
    const typeInfo = FURNITURE_TYPES[typeId];
    if (!typeInfo || !this._furniturePlacePoint) return;
    const pt = this._furniturePlacePoint;

    // Convert default vacuum dimensions to image dimensions
    const camera = this._getState(this._entities.map);
    const attrs = camera?.attributes || {};
    const scale = attrs.scale || 1;
    const pixelSize = attrs.pixel_size || 50;
    const imgW = (typeInfo.w / pixelSize) * scale;
    const imgH = (typeInfo.h / pixelSize) * scale;

    // Convert placement point to vacuum coords for vacuum_cx/cy
    const [vcx, vcy] = this._imageToVacuumCoords(pt.x, pt.y);

    const newItem = {
      type: typeId,
      name: typeInfo.name,
      x: pt.x - imgW / 2,
      y: pt.y - imgH / 2,
      w: imgW,
      h: imgH,
      center_x: pt.x,
      center_y: pt.y,
      vacuum_cx: vcx,
      vacuum_cy: vcy,
      vacuum_w: typeInfo.w,
      vacuum_h: typeInfo.h,
    };
    this._editFurniture.push(newItem);
    this._selectedFurnitureIdx = this._editFurniture.length - 1;
    this._furniturePickerOpen = false;
    this._furniturePlacePoint = null;
    this._editDirty = true;
    this._updateContent();
  }

  // ── Zone editing (rect tools: no_go, carpet, low_clearance, ramp) ──

  _zoneBBox(zone) {
    if (!zone.points || zone.points.length < 3) return null;
    const xs = zone.points.map((p) => p.x);
    const ys = zone.points.map((p) => p.y);
    return {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }

  _zoneHitTest(px, py) {
    const zones = this._getEditZonesForTool();
    for (let i = zones.length - 1; i >= 0; i--) {
      const bb = this._zoneBBox(zones[i]);
      if (bb && px >= bb.x && px <= bb.x + bb.w && py >= bb.y && py <= bb.y + bb.h) {
        return i;
      }
    }
    return -1;
  }

  _zoneHandleHitTest(px, py) {
    if (this._selectedZoneIdx < 0) return null;
    const zones = this._getEditZonesForTool();
    const zone = zones[this._selectedZoneIdx];
    if (!zone) return null;
    const bb = this._zoneBBox(zone);
    if (!bb) return null;
    const hs = 8;
    const corners = {
      "resize-tl": { x: bb.x, y: bb.y },
      "resize-tr": { x: bb.x + bb.w, y: bb.y },
      "resize-bl": { x: bb.x, y: bb.y + bb.h },
      "resize-br": { x: bb.x + bb.w, y: bb.y + bb.h },
    };
    for (const [action, pt] of Object.entries(corners)) {
      if (Math.abs(px - pt.x) <= hs && Math.abs(py - pt.y) <= hs) {
        return action;
      }
    }
    return null;
  }

  _deleteSelectedZone() {
    if (this._selectedZoneIdx >= 0) {
      const zones = this._getEditZonesForTool();
      zones.splice(this._selectedZoneIdx, 1);
      this._selectedZoneIdx = -1;
      this._editDirty = true;
      this._updateContent();
    }
  }

  _applyZoneDrag(pt) {
    const zones = this._getEditZonesForTool();
    const zone = zones[this._selectedZoneIdx];
    if (!zone || !this._zoneDragStart) return;
    const dx = pt.x - this._zoneDragStart.x;
    const dy = pt.y - this._zoneDragStart.y;
    const orig = this._zoneDragStart.origPoints;
    const obb = this._zoneDragStart.origBBox;

    if (this._zoneDragAction === "move") {
      for (let i = 0; i < zone.points.length; i++) {
        zone.points[i] = { x: orig[i].x + dx, y: orig[i].y + dy };
      }
    } else {
      // Resize: compute new bbox from dragged corner, then remap points
      let nx = obb.x, ny = obb.y, nw = obb.w, nh = obb.h;
      const minSize = 10;
      if (this._zoneDragAction === "resize-br") {
        nw = Math.max(minSize, obb.w + dx);
        nh = Math.max(minSize, obb.h + dy);
      } else if (this._zoneDragAction === "resize-bl") {
        nw = Math.max(minSize, obb.w - dx);
        nx = obb.x + obb.w - nw;
        nh = Math.max(minSize, obb.h + dy);
      } else if (this._zoneDragAction === "resize-tr") {
        nw = Math.max(minSize, obb.w + dx);
        nh = Math.max(minSize, obb.h - dy);
        ny = obb.y + obb.h - nh;
      } else if (this._zoneDragAction === "resize-tl") {
        nw = Math.max(minSize, obb.w - dx);
        nh = Math.max(minSize, obb.h - dy);
        nx = obb.x + obb.w - nw;
        ny = obb.y + obb.h - nh;
      }
      zone.points = [
        { x: nx, y: ny },
        { x: nx + nw, y: ny },
        { x: nx + nw, y: ny + nh },
        { x: nx, y: ny + nh },
      ];
    }
  }

  _finalizeZoneDrag() {
    const zones = this._getEditZonesForTool();
    const zone = zones[this._selectedZoneIdx];
    if (!zone) return;
    // Recompute vacuum coords from the new image-space points
    const pts = zone.points;
    const [vx1, vy1] = this._imageToVacuumCoords(pts[0].x, pts[0].y);
    const [vx2, vy2] = this._imageToVacuumCoords(pts[1].x, pts[1].y);
    const [vx3, vy3] = this._imageToVacuumCoords(pts[2].x, pts[2].y);
    const [vx4, vy4] = this._imageToVacuumCoords(pts[3].x, pts[3].y);
    zone.roi = [vx1, vy1, vx2, vy2, vx3, vy3, vx4, vy4];
    if (this._editTool === "ramp") {
      zone.vacuum_coords = [vx1, vy1, vx3, vy3];
    }
    this._editDirty = true;
    this._zoneDragAction = null;
    this._zoneDragStart = null;
  }

  _enterEditMode() {
    const camera = this._getState(this._entities.map);
    const a = camera?.attributes || {};
    this._editNoGoZones = JSON.parse(JSON.stringify(a.no_go_zones || []));
    this._editVirtualWalls = JSON.parse(JSON.stringify(a.virtual_walls || []));
    this._editCarpetZones = JSON.parse(JSON.stringify(a.carpet_zones || []));
    this._editLowClearanceZones = JSON.parse(JSON.stringify(a.low_clearance_zones || []));
    this._editPassableThresholds = JSON.parse(JSON.stringify(a.passable_thresholds || []));
    this._editImpassableThresholds = JSON.parse(JSON.stringify(a.impassable_thresholds || []));
    this._editRamps = JSON.parse(JSON.stringify(a.ramps || []));
    this._editCliffs = JSON.parse(JSON.stringify(a.cliffs || []));
    this._editFurniture = JSON.parse(JSON.stringify(a.furniture || []));
    this._selectedFurnitureIdx = -1;
    this._furnitureDragAction = null;
    this._furnitureDragStart = null;
    this._furniturePickerOpen = false;
    this._furniturePlacePoint = null;
    this._selectedZoneIdx = -1;
    this._zoneDragAction = null;
    this._zoneDragStart = null;
    this._editTool = "no_go";
    this._editDirty = false;
    this._drawingRect = null;
    this._drawingWall = null;
    this._pointerStart = null;
  }

  _exitEditMode() {
    this._editNoGoZones = [];
    this._editVirtualWalls = [];
    this._editCarpetZones = [];
    this._editLowClearanceZones = [];
    this._editPassableThresholds = [];
    this._editImpassableThresholds = [];
    this._editRamps = [];
    this._editCliffs = [];
    this._editFurniture = [];
    this._selectedFurnitureIdx = -1;
    this._furnitureDragAction = null;
    this._furnitureDragStart = null;
    this._furniturePickerOpen = false;
    this._furniturePlacePoint = null;
    this._selectedZoneIdx = -1;
    this._zoneDragAction = null;
    this._zoneDragStart = null;
    this._editDirty = false;
    this._drawingRect = null;
    this._drawingWall = null;
    this._pointerStart = null;
  }

  _getSvgCoords(e) {
    const svg = this.shadowRoot.querySelector(".map-overlay");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const svgWidth = parseFloat(svg.getAttribute("viewBox")?.split(" ")[2] || "800");
    const svgHeight = parseFloat(svg.getAttribute("viewBox")?.split(" ")[3] || "600");
    return {
      x: ((e.clientX - rect.left) / rect.width) * svgWidth,
      y: ((e.clientY - rect.top) / rect.height) * svgHeight,
    };
  }

  _imageToVacuumCoords(imgX, imgY) {
    const camera = this._getState(this._entities.map);
    if (!camera) return [0, 0];
    const attrs = camera.attributes;
    const scale = attrs.scale || 1;
    const rotation = attrs.rotation || 0;
    const flipX = attrs.flip_x || false;
    const flipY = attrs.flip_y || false;
    const mapLeft = attrs.map_left || 0;
    const mapTop = attrs.map_top || 0;
    const pixelSize = attrs.pixel_size || 1;
    const rawW = attrs.raw_width || 1;
    const rawH = attrs.raw_height || 1;

    // Reverse scale to get pixel coords in the rotated/flipped frame
    let x = imgX / scale;
    let y = imgY / scale;

    // Reverse rotation
    let curW, curH;
    if (rotation === 90 || rotation === 270) {
      curW = rawH;
      curH = rawW;
    } else {
      curW = rawW;
      curH = rawH;
    }
    for (let i = 0; i < rotation / 90; i++) {
      const newX = y;
      const newY = curW - 1 - x;
      x = newX;
      y = newY;
      const tmp = curW;
      curW = curH;
      curH = tmp;
    }

    // Reverse flips
    if (flipY) y = (rawH - 1) - y;
    if (flipX) x = (rawW - 1) - x;

    // Convert pixel indices to vacuum coords:
    // vacuum_coord = pixel_index * pixel_size + header_offset
    return [Math.round(x * pixelSize + mapLeft), Math.round(y * pixelSize + mapTop)];
  }

  _updateModeTabs(card) {
    card.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === this._mode);
    });
  }

  _updateRoomList(card) {
    const container = card.querySelector(".room-list-container");

    if (this._mode === "edit") {
      const counts = [
        [this._editNoGoZones.length, "no-go"],
        [this._editVirtualWalls.length, "wall"],
        [this._editCarpetZones.length, "carpet"],
        [this._editLowClearanceZones.length, "low-clear."],
        [this._editPassableThresholds.length, "passable"],
        [this._editImpassableThresholds.length, "impass."],
        [this._editRamps.length, "ramp"],
        [this._editCliffs.length, "cliff"],
        [this._editFurniture.length, "furniture"],
      ].filter(([c]) => c > 0).map(([c, l]) => `${c} ${l}`).join(" \u00b7 ");

      // Sub-toolbar: delete button for selected furniture or zone
      const showZoneDelete = RECT_TOOLS.includes(this._editTool) && this._selectedZoneIdx >= 0;
      const showFurnitureDelete = this._editTool === "furniture" && this._selectedFurnitureIdx >= 0;
      const furnitureActions = (this._editTool === "furniture" || showZoneDelete) ? `
        <div class="furniture-actions">
          ${showFurnitureDelete ? `
            <button class="edit-tool-btn furniture-delete-btn" data-action="furniture-delete">
              <ha-icon icon="mdi:delete"></ha-icon> Delete
            </button>
          ` : ""}
          ${showZoneDelete ? `
            <button class="edit-tool-btn furniture-delete-btn" data-action="zone-delete">
              <ha-icon icon="mdi:delete"></ha-icon> Delete
            </button>
          ` : ""}
        </div>
      ` : "";

      container.innerHTML = `
        <div class="edit-toolbar">
          <div class="edit-tool-selector">
            ${EDIT_TOOLS.map((t) => `
              <button class="edit-tool-btn ${this._editTool === t.id ? "active" : ""}" data-tool="${t.id}">
                <ha-icon icon="${t.icon}"></ha-icon> ${t.label}
              </button>
            `).join("")}
          </div>
          <div class="edit-hint">${EDIT_TOOL_HINTS[this._editTool]}</div>
          ${furnitureActions}
          ${this._furniturePickerOpen ? this._renderFurniturePicker() : ""}
          ${counts ? `<div class="edit-counts">${counts}</div>` : ""}
        </div>
      `;
      container.querySelectorAll(".edit-tool-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.action === "furniture-delete") {
            this._deleteFurniture();
            return;
          }
          if (btn.dataset.action === "zone-delete") {
            this._deleteSelectedZone();
            return;
          }
          this._editTool = btn.dataset.tool;
          this._selectedFurnitureIdx = -1;
          this._selectedZoneIdx = -1;
          this._furniturePickerOpen = false;
          this._updateContent();
        });
      });
      // Bind furniture type picker buttons
      container.querySelectorAll(".furniture-type-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._addFurniture(parseInt(btn.dataset.type, 10));
        });
      });
      container.querySelector(".furniture-picker-cancel")?.addEventListener("click", () => {
        this._furniturePickerOpen = false;
        this._furniturePlacePoint = null;
        this._updateContent();
      });
      return;
    }

    if (this._mode === "goto") {
      container.innerHTML = `
        <div class="selected-rooms-text" style="padding:10px 0">
          ${this._gotoPin ? "Pin placed. Tap Send to navigate." : "Tap on the map to place a pin."}
        </div>
      `;
      return;
    }

    if (this._mode !== "room") {
      container.innerHTML = "";
      return;
    }

    const camera = this._getState(this._entities.map);
    const rooms = camera?.attributes?.rooms || {};
    const hiddenRooms = this._config.hidden_rooms || [];
    const roomEntries = Object.entries(rooms).filter(([segId]) => !hiddenRooms.includes(parseInt(segId, 10)));
    if (roomEntries.length === 0) {
      container.innerHTML = "";
      return;
    }

    // Toggle button for list/map view
    const viewToggle = `
      <div class="room-view-toggle">
        <button class="view-btn ${this._roomView === "map" ? "active" : ""}" data-view="map">
          <ha-icon icon="mdi:map"></ha-icon>
        </button>
        <button class="view-btn ${this._roomView === "list" ? "active" : ""}" data-view="list">
          <ha-icon icon="mdi:format-list-bulleted"></ha-icon>
        </button>
      </div>
    `;

    if (this._roomView === "list") {
      const listItems = roomEntries
        .sort(([idA, a], [idB, b]) => this._getRoomName(idA, a).localeCompare(this._getRoomName(idB, b)))
        .map(([segId, room]) => {
          const sid = parseInt(segId, 10);
          const checked = this._selectedRooms.has(sid);
          const [r, g, b] = room.color || [135, 206, 235];
          const orderIdx = this._roomOrder.indexOf(sid);
          const orderLabel = checked && orderIdx >= 0
            ? `<span class="room-order" style="background:rgb(${r},${g},${b})">${orderIdx + 1}</span>`
            : "";
          return `
            <label class="room-item ${checked ? "selected" : ""}" data-seg-id="${segId}">
              <span class="room-color" style="background:rgb(${r},${g},${b})"></span>
              <span class="room-name">${this._getRoomName(segId, room)}</span>
              ${orderLabel}
              <input type="checkbox" ${checked ? "checked" : ""} />
            </label>
          `;
        })
        .join("");

      container.innerHTML = `${viewToggle}<div class="room-list">${listItems}</div>`;

      container.querySelectorAll(".room-item").forEach((item) => {
        item.addEventListener("click", (e) => {
          e.preventDefault();
          const segId = parseInt(item.dataset.segId, 10);
          if (this._selectedRooms.has(segId)) {
            this._selectedRooms.delete(segId);
            this._roomOrder = this._roomOrder.filter((id) => id !== segId);
          } else {
            this._selectedRooms.add(segId);
            this._roomOrder.push(segId);
          }
          this._updateContent();
        });
      });
    } else {
      // Map view: show selected room names
      const selectedNames = roomEntries
        .filter(([segId]) => this._selectedRooms.has(parseInt(segId, 10)))
        .map(([segId, room]) => this._getRoomName(segId, room));
      const selText = selectedNames.length > 0
        ? selectedNames.join(", ")
        : "Tap rooms on the map to select";

      container.innerHTML = `
        ${viewToggle}
        <div class="selected-rooms-text">${selText}</div>
      `;
    }

    container.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._roomView = btn.dataset.view;
        this._updateContent();
      });
    });
  }

  _updateConfigSection(card) {
    const section = card.querySelector(".config-section");
    section.innerHTML = "";
  }

  _updateActions(card) {
    const actions = card.querySelector(".actions");

    if (this._mode === "goto") {
      const hasPin = !!this._gotoPin;
      actions.innerHTML = `
        <div class="action-buttons">
          <button class="action-btn secondary" data-action="goto_clear" ${hasPin ? "" : "disabled"}>
            <ha-icon icon="mdi:close"></ha-icon> Clear
          </button>
          <button class="action-btn primary ${hasPin ? "" : "disabled"}" data-action="goto_send" ${hasPin ? "" : "disabled"}>
            <ha-icon icon="mdi:map-marker-right"></ha-icon> Send
          </button>
        </div>
      `;
      actions.querySelector('[data-action="goto_clear"]')?.addEventListener("click", () => {
        this._gotoPin = null;
        this._updateContent();
      });
      actions.querySelector('[data-action="goto_send"]')?.addEventListener("click", () => {
        if (!this._gotoPin) return;
        const [vx, vy] = this._imageToVacuumCoords(this._gotoPin.x, this._gotoPin.y);
        this._hass.callService("dreame_cloud", "goto", {
          entity_id: this._entities.vacuum,
          x: vx,
          y: vy,
        });
        this._gotoPin = null;
        this._mode = "all";
        DreameVacuumMapCard._persistedMode = "all";
        this._updateContent();
      });
      return;
    }

    if (this._mode === "edit") {
      actions.innerHTML = `
        <div class="action-buttons">
          <button class="action-btn secondary" data-action="edit_cancel">
            <ha-icon icon="mdi:close"></ha-icon> Cancel
          </button>
          <button class="action-btn primary ${this._editDirty ? "" : "disabled"}" data-action="edit_save" ${this._editDirty ? "" : "disabled"}>
            <ha-icon icon="mdi:content-save"></ha-icon> Save
          </button>
        </div>
      `;
      actions.querySelector('[data-action="edit_cancel"]')?.addEventListener("click", () => {
        this._mode = "all";
        DreameVacuumMapCard._persistedMode = "all";
        this._exitEditMode();
        this._updateContent();
      });
      actions.querySelector('[data-action="edit_save"]')?.addEventListener("click", () => {
        this._saveMapEdits();
      });
      return;
    }

    const state = this._getVacuumState();
    let buttons = "";
    if (state === "cleaning" || state === "returning") {
      buttons = `
        <button class="action-btn secondary" data-action="pause">
          <ha-icon icon="mdi:pause"></ha-icon> Pause
        </button>
        <button class="action-btn secondary" data-action="stop">
          <ha-icon icon="mdi:stop"></ha-icon> Stop
        </button>
      `;
    } else if (state === "paused") {
      buttons = `
        <button class="action-btn primary" data-action="start">
          <ha-icon icon="mdi:play"></ha-icon> Resume
        </button>
        <button class="action-btn secondary" data-action="return_to_base">
          <ha-icon icon="mdi:home"></ha-icon> Dock
        </button>
      `;
    } else {
      // Idle / docked / error
      const label = this._getCleanButtonLabel();
      buttons = `
        <button class="action-btn primary" data-action="clean">
          <ha-icon icon="mdi:play"></ha-icon> ${label}
        </button>
        <button class="action-btn secondary" data-action="dock_menu">
          <ha-icon icon="mdi:home-variant"></ha-icon> Dock
        </button>
      `;
    }

    const dockMenuHtml = this._dockMenuOpen ? `
      <div class="dock-menu">
        ${DOCK_ACTIONS.map((a) => `
          <button class="dock-action-btn" data-entity="${this._entities[a.key]}">
            <ha-icon icon="${a.icon}"></ha-icon>
            <span>${a.label}</span>
          </button>
        `).join("")}
        ${state !== "docked" ? `
        <button class="dock-action-btn" data-action="return_to_base">
          <ha-icon icon="mdi:home"></ha-icon>
          <span>Return</span>
        </button>` : ""}
      </div>
    ` : "";

    actions.innerHTML = `<div class="action-buttons">${buttons}</div>${dockMenuHtml}`;

    actions.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.action === "dock_menu") {
          this._dockMenuOpen = !this._dockMenuOpen;
          this._updateActions(card);
          return;
        }
        this._executeAction(btn.dataset.action);
      });
    });

    actions.querySelectorAll(".dock-action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.action === "return_to_base") {
          this._executeAction("return_to_base");
        } else {
          this._hass.callService("button", "press", {
            entity_id: btn.dataset.entity,
          });
        }
      });
    });
  }

  _getCleanButtonLabel() {
    if (this._mode === "room" && this._selectedRooms.size > 0) {
      return `Clean ${this._selectedRooms.size} room${this._selectedRooms.size > 1 ? "s" : ""}`;
    }
    if (this._mode === "zone" && this._zoneFinalized) {
      return "Zone clean";
    }
    return "Clean all";
  }

  _executeAction(action) {
    if (!this._hass) return;

    if (action === "clean") {
      if (this._mode === "room" && this._selectedRooms.size > 0) {
        // Clean selected rooms
        const suction = SUCTION_MAP[this._getState(this._entities.suction_level)?.state] ?? 1;
        const water = WATER_MAP[this._getState(this._entities.water_volume)?.state] ?? 2;
        const mode = CLEANING_MODE_MAP[this._getState(this._entities.cleaning_mode)?.state] ?? 2;

        this._hass.callService("dreame_cloud", "clean_segment", {
          entity_id: this._entities.vacuum,
          segments: this._roomOrder.length > 0 ? [...this._roomOrder] : [...this._selectedRooms],
          suction_level: suction,
          water_volume: water,
          cleaning_mode: mode,
        });
      } else if (this._mode === "zone" && this._zoneFinalized) {
        // Clean zone
        const z = this._zoneFinalized;
        const [x1, y1] = this._imageToVacuumCoords(Math.min(z.x1, z.x2), Math.min(z.y1, z.y2));
        const [x2, y2] = this._imageToVacuumCoords(Math.max(z.x1, z.x2), Math.max(z.y1, z.y2));

        const suction = SUCTION_MAP[this._getState(this._entities.suction_level)?.state] ?? 1;
        const water = WATER_MAP[this._getState(this._entities.water_volume)?.state] ?? 2;
        const mode = CLEANING_MODE_MAP[this._getState(this._entities.cleaning_mode)?.state] ?? 2;

        this._hass.callService("dreame_cloud", "clean_zone", {
          entity_id: this._entities.vacuum,
          zones: [[Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]],
          suction_level: suction,
          water_volume: water,
          cleaning_mode: mode,
        });
      } else {
        // Clean all
        this._hass.callService("vacuum", "start", {
          entity_id: this._entities.vacuum,
        });
      }
      return;
    }

    const [domain, service] = VACUUM_SERVICE_MAP[action] || [];
    if (domain && service) {
      this._hass.callService(domain, service, {
        entity_id: this._entities.vacuum,
      });
    }
  }

  async _saveMapEdits() {
    if (!this._hass || !this._editDirty) return;

    const buildZonePayload = (zones) => zones.map((zone, i) => ({
      id: i + 1,
      type: zone.type ?? 0,
      hide: zone.hide ?? 0,
      roi: zone.roi,
    }));

    try {
      const serviceData = {
        entity_id: this._entities.vacuum,
        no_go_zones: buildZonePayload(this._editNoGoZones),
        virtual_walls: this._editVirtualWalls.map((wall) => wall.vacuum_coords),
        low_clearance_zones: buildZonePayload(this._editLowClearanceZones),
      };

      // Always send thresholds so deletions persist
      serviceData.thresholds = {
        vwsl: this._editPassableThresholds.map((t) => t.vacuum_coords),
        npthrsd: this._editImpassableThresholds.map((t) => t.vacuum_coords),
        ramp: this._editRamps.map((r) => {
          const vc = r.vacuum_coords || [];
          return r.type != null ? [...vc, r.type] : vc;
        }),
        cliff: this._editCliffs.map((t) => t.vacuum_coords),
      };

      // Furniture: convert each item back to [cx, cy, type, flag, cx2, cy2, w, h, user_flag]
      serviceData.furniture = this._editFurniture.map((f) => {
        const cx = Math.round(f.vacuum_cx);
        const cy = Math.round(f.vacuum_cy);
        return [cx, cy, f.type, 0, cx, cy, Math.round(f.vacuum_w), Math.round(f.vacuum_h), 0];
      });

      const sentCounts = {
        passable: serviceData.thresholds.vwsl.length,
        impassable: serviceData.thresholds.npthrsd.length,
        ramp: serviceData.thresholds.ramp.length,
        cliff: serviceData.thresholds.cliff.length,
        no_go: serviceData.no_go_zones.length,
        wall: serviceData.virtual_walls.length,
        low_clearance: serviceData.low_clearance_zones.length,
        furniture: serviceData.furniture.length,
      };
      await this._hass.callService("dreame_cloud", "update_map", serviceData);
      this._mode = "all";
      DreameVacuumMapCard._persistedMode = "all";
      this._exitEditMode();
      this._updateContent();

      // Wait for entity to update, then check if the vacuum rejected zones
      const preSaveTs =
        this._hass?.states?.[this._entities.map]?.last_updated || "";
      this._pollForSaveResult(sentCounts, preSaveTs, 0);
    } catch (err) {
      console.error("Failed to save map edits:", err);
      this._showToast("Save failed: " + err.message);
    }
  }

  _pollForSaveResult(sentCounts, preSaveTs, attempt) {
    const maxAttempts = 20; // ~40 seconds total
    const camera = this._hass?.states?.[this._entities.map];
    if (camera && camera.last_updated !== preSaveTs) {
      this._checkSaveResult(sentCounts);
      return;
    }
    if (attempt >= maxAttempts) {
      // Give up waiting -- check with whatever data we have
      this._checkSaveResult(sentCounts);
      return;
    }
    this._setTimeout(() => {
      this._pollForSaveResult(sentCounts, preSaveTs, attempt + 1);
    }, 2000);
  }

  _checkSaveResult(sentCounts) {
    if (!this._hass) return;
    const camera = this._hass.states[this._entities.map];
    if (!camera) return;
    const a = camera.attributes;
    const rejected = [];
    for (const [key, sent] of Object.entries(sentCounts)) {
      if (!sent) continue;
      const got = (a[SAVE_RESULT_ATTR_MAP[key]] || []).length;
      if (got < sent) {
        rejected.push(`${sent - got} ${key}`);
      }
    }
    if (rejected.length) {
      this._showToast(`Vacuum rejected ${rejected.join(", ")}. Zones may need to be at valid doorways.`);
    }
  }

  _showToast(message) {
    const card = this.shadowRoot?.querySelector("ha-card");
    if (!card) return;
    let toast = card.querySelector(".map-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "map-toast";
      card.querySelector(".card-content")?.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.display = "block";
    toast.style.opacity = "1";
    this._setTimeout(() => {
      toast.style.opacity = "0";
      this._setTimeout(() => { toast.style.display = "none"; }, 500);
    }, 5000);
  }

  _updateSettingsPanel(card) {
    const panel = card.querySelector(".settings-panel");
    if (!this._settingsOpen) {
      panel.innerHTML = "";
      panel.classList.remove("open");
      return;
    }

    panel.classList.add("open");

    // Consumables
    const availableConsumables = CONSUMABLE_DEFS.filter((c) => this._getState(this._entities[c.key]));
    const consumableHtml = availableConsumables
      .map((c) => {
        const entity = this._getState(this._entities[c.key]);
        const value = parseInt(entity.state, 10) || 0;
        const barColor = value > 20 ? "var(--success-color, #4caf50)" : "var(--error-color, #f44336)";
        return `
          <div class="consumable">
            <div class="consumable-header">
              <ha-icon icon="${c.icon}"></ha-icon>
              <span>${c.label}</span>
              <span class="consumable-value">${value}%</span>
            </div>
            <div class="consumable-bar">
              <div class="consumable-bar-fill" style="width:${value}%;background:${barColor}"></div>
            </div>
          </div>
        `;
      })
      .join("");

    // Volume
    const volumeEntity = this._getState(this._entities.volume);
    const volume = volumeEntity ? parseFloat(volumeEntity.state) : 50;

    // DND
    const dndEntity = this._getState(this._entities.dnd);
    const dndOn = dndEntity?.state === "on";

    // Cleaning config
    const suctionEntity = this._getState(this._entities.suction_level);
    const suctionLevel = suctionEntity?.state || "Standard";
    const cleaningModeEntity = this._getState(this._entities.cleaning_mode);
    const waterVolumeEntity = this._getState(this._entities.water_volume);
    const currentMode = cleaningModeEntity?.state || "Sweep & Mop";
    const currentWater = waterVolumeEntity?.state || "Medium";

    // Room aliases & visibility
    const camera = this._getState(this._entities.map);
    const rooms = camera?.attributes?.rooms || {};
    const aliases = this._config.room_aliases || {};
    const hiddenRooms = this._config.hidden_rooms || [];
    const roomEntries = Object.entries(rooms).sort(([, a], [, b]) => a.name.localeCompare(b.name));
    const roomAliasesHtml = roomEntries.length > 0
      ? roomEntries.map(([segId, room]) => {
          const alias = aliases[segId] || "";
          const hidden = hiddenRooms.includes(parseInt(segId, 10));
          return `
            <div class="settings-alias-row ${hidden ? "settings-alias-hidden" : ""}">
              <span class="settings-alias-name">${room.name}</span>
              <input type="text" class="settings-alias-input" data-seg-id="${segId}"
                placeholder="${room.name}" value="${alias}" />
              <button class="settings-alias-vis" data-seg-id="${segId}" title="${hidden ? "Show room" : "Hide room"}">
                <ha-icon icon="${hidden ? "mdi:eye-off" : "mdi:eye"}"></ha-icon>
              </button>
            </div>
          `;
        }).join("")
      : '<div style="font-size:12px;color:var(--text-secondary)">No rooms detected yet.</div>';

    panel.innerHTML = `
      <div class="settings-header">
        <span>Settings</span>
        <button class="close-settings">
          <ha-icon icon="mdi:close"></ha-icon>
        </button>
      </div>

      ${availableConsumables.length > 0 ? `
      <div class="settings-section">
        <h3>Consumables</h3>
        ${consumableHtml}
      </div>
      ` : ""}

      <div class="settings-section">
        <h3>Volume</h3>
        <div class="volume-control">
          <ha-icon icon="mdi:volume-low"></ha-icon>
          <input type="range" class="volume-slider" min="0" max="100" value="${volume}" />
          <ha-icon icon="mdi:volume-high"></ha-icon>
          <span class="volume-value">${Math.round(volume)}</span>
        </div>
      </div>

      <div class="settings-section">
        <h3>Do Not Disturb</h3>
        <label class="dnd-toggle">
          <span>DND Mode</span>
          <input type="checkbox" class="dnd-checkbox" ${dndOn ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="settings-section">
        <h3>Cleaning</h3>
        <div class="config-row">
          <div class="config-group">
            <span class="config-label">Suction</span>
            <div class="segmented-control" data-type="suction">
              ${SUCTION_OPTIONS.map((o) => `<button class="seg-btn ${o === suctionLevel ? "active" : ""}" data-value="${o}">${o}</button>`).join("")}
            </div>
          </div>
          <div class="config-group">
            <span class="config-label">Water</span>
            <div class="segmented-control" data-type="water">
              ${WATER_OPTIONS.map((o) => `<button class="seg-btn ${o === currentWater ? "active" : ""}" data-value="${o}">${o}</button>`).join("")}
            </div>
          </div>
          <div class="config-group">
            <span class="config-label">Mode</span>
            <div class="segmented-control" data-type="mode">
              ${CLEANING_MODE_OPTIONS.map((o) => `<button class="seg-btn ${o === currentMode ? "active" : ""}" data-value="${o}">${o}</button>`).join("")}
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Room Names</h3>
        ${roomAliasesHtml}
      </div>
    `;

    panel.querySelector(".close-settings").addEventListener("click", () => {
      this._settingsOpen = false;
      this._updateSettingsPanel(card);
    });

    const slider = panel.querySelector(".volume-slider");
    let volumeTimeout = null;
    slider.addEventListener("input", () => {
      panel.querySelector(".volume-value").textContent = slider.value;
      clearTimeout(volumeTimeout);
      volumeTimeout = setTimeout(() => {
        this._hass.callService("number", "set_value", {
          entity_id: this._entities.volume,
          value: parseFloat(slider.value),
        });
      }, 300);
    });

    panel.querySelector(".dnd-checkbox").addEventListener("change", (e) => {
      this._hass.callService("switch", e.target.checked ? "turn_on" : "turn_off", {
        entity_id: this._entities.dnd,
      });
    });

    panel.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.closest(".segmented-control").dataset.type;
        const value = btn.dataset.value;
        if (type === "suction") {
          this._hass.callService("select", "select_option", {
            entity_id: this._entities.suction_level,
            option: value,
          });
        } else if (type === "water") {
          this._hass.callService("select", "select_option", {
            entity_id: this._entities.water_volume,
            option: value,
          });
        } else if (type === "mode") {
          this._hass.callService("select", "select_option", {
            entity_id: this._entities.cleaning_mode,
            option: value,
          });
        }
      });
    });

    // Room alias inputs
    panel.querySelectorAll(".settings-alias-input").forEach((input) => {
      input.addEventListener("input", (e) => {
        const segId = e.target.dataset.segId;
        const val = e.target.value.trim();
        const newAliases = { ...(this._config.room_aliases || {}) };
        if (val) {
          newAliases[segId] = val;
        } else {
          delete newAliases[segId];
        }
        this._config = { ...this._config, room_aliases: newAliases };
        this._fireConfigChanged();
        this._updateContent();
      });
    });

    // Room visibility toggles
    panel.querySelectorAll(".settings-alias-vis").forEach((btn) => {
      btn.addEventListener("click", () => {
        const segId = parseInt(btn.dataset.segId, 10);
        const hidden = [...(this._config.hidden_rooms || [])];
        const idx = hidden.indexOf(segId);
        const isNowHidden = idx < 0;
        if (idx >= 0) {
          hidden.splice(idx, 1);
        } else {
          hidden.push(segId);
        }
        const icon = btn.querySelector("ha-icon");
        if (icon) icon.setAttribute("icon", isNowHidden ? "mdi:eye-off" : "mdi:eye");
        btn.title = isNowHidden ? "Show room" : "Hide room";
        const row = btn.closest(".settings-alias-row");
        if (row) row.classList.toggle("settings-alias-hidden", isNowHidden);

        this._config = { ...this._config, hidden_rooms: hidden };
        this._fireConfigChanged();
        this._updateContent();
      });
    });
  }

  getCardSize() {
    return 6;
  }
}

// ── Register ─────────────────────────────────────────────────────────
customElements.define("dreame-vacuum-map-card", DreameVacuumMapCard);
customElements.define("dreame-vacuum-map-card-editor", DreameVacuumMapCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "dreame-vacuum-map-card",
  name: "Dreame Vacuum Map Card",
  description: "Interactive map card for Dreame Cloud Vacuum",
  preview: true,
});

console.info(`%c DREAME-VACUUM-MAP-CARD %c v${CARD_VERSION} `, "background:#007aff;color:white;font-weight:bold", "background:#333;color:white");
