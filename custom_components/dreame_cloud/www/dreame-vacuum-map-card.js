/**
 * Dreame Vacuum Map Card
 * Custom Lovelace card for Dreame Cloud Vacuum integration.
 */

const CARD_VERSION = "1.0.0";

// ── Helpers ──────────────────────────────────────────────────────────
function fireEvent(node, type, detail) {
  const event = new Event(type, { bubbles: true, composed: true });
  event.detail = detail;
  node.dispatchEvent(event);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function batteryIcon(level) {
  if (level >= 95) return "mdi:battery";
  if (level >= 85) return "mdi:battery-90";
  if (level >= 75) return "mdi:battery-80";
  if (level >= 65) return "mdi:battery-70";
  if (level >= 55) return "mdi:battery-60";
  if (level >= 45) return "mdi:battery-50";
  if (level >= 35) return "mdi:battery-40";
  if (level >= 25) return "mdi:battery-30";
  if (level >= 15) return "mdi:battery-20";
  if (level >= 5) return "mdi:battery-10";
  return "mdi:battery-alert";
}

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
    this._zone = null; // {x1, y1, x2, y2} in image px during drawing
    this._zoneFinalized = null; // finalized zone
    this._drawing = false;
    this._lastEntityPicture = null;
    this._entities = {};
    // Edit mode state
    this._editTool = "no_go"; // no_go | wall | carpet | low_clearance | threshold | impassable | ramp | cliff
    this._editNoGoZones = [];
    this._editVirtualWalls = [];
    this._editCarpetZones = [];
    this._editLowClearanceZones = [];
    this._editPassableThresholds = [];
    this._editImpassableThresholds = [];
    this._editRamps = [];
    this._editCliffs = [];
    this._editDirty = false;
    this._drawingWall = null; // {x1, y1, x2, y2} during wall drawing
    this._drawingRect = null; // {x1, y1, x2, y2} during rect drawing (no-go, carpet, low-clearance)
    this._pointerStart = null; // {x, y} for tap detection
    // Pin and Go state
    this._gotoPin = null; // {x, y} in SVG coords
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
    if (!this._config.room_aliases) this._config.room_aliases = {};
    if (!this._config.hidden_rooms) this._config.hidden_rooms = [];
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
    style.textContent = this._getStyles();
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
          <button class="tab" data-mode="goto">Go To</button>
          <button class="tab" data-mode="edit">Edit</button>
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

    // Bind map interaction
    const mapContainer = card.querySelector(".map-container");
    mapContainer.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    mapContainer.addEventListener("pointermove", (e) => this._onPointerMove(e));
    mapContainer.addEventListener("pointerup", (e) => this._onPointerUp(e));

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
  }

  _formatStatus(activity) {
    const map = {
      cleaning: "Cleaning",
      docked: "Docked",
      idle: "Idle",
      paused: "Paused",
      returning: "Returning",
      error: "Error",
      unavailable: "Unavailable",
    };
    return map[activity] || activity;
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
        const orderBadge = selected && orderIdx >= 0 ? `
            <circle cx="${room.x + room.w - 6}" cy="${room.y + 6}" r="10"
              fill="rgb(${r},${g},${b})" stroke="white" stroke-width="2" />
            <text x="${room.x + room.w - 6}" y="${room.y + 6}"
              text-anchor="middle" dominant-baseline="central"
              fill="white" font-size="11" font-weight="700"
              font-family="system-ui, sans-serif">
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

    // Zone type rendering config: [editArray, attrKey, fill, stroke]
    const _zoneStyles = [
      [this._editNoGoZones, "no_go_zones", "rgba(244,67,54,0.2)", "#f44336"],
      [this._editCarpetZones, "carpet_zones", "rgba(156,39,176,0.2)", "#9c27b0"],
      [this._editLowClearanceZones, "low_clearance_zones", "rgba(33,150,243,0.2)", "#2196f3"],
    ];
    for (const [editZones, attrKey, fill, stroke] of _zoneStyles) {
      const zones = this._mode === "edit" ? editZones : (camera.attributes[attrKey] || []);
      for (const zone of zones) {
        if (!zone.points || zone.points.length !== 4) continue;
        const pts = zone.points.map((p) => `${p.x},${p.y}`).join(" ");
        svgContent += `
          <polygon points="${pts}"
            fill="${fill}" stroke="${stroke}" stroke-width="2"
            stroke-dasharray="6 3"
            style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
        `;
      }
    }

    // Drawing preview for rect zones
    if (this._mode === "edit" && this._drawingRect) {
      const d = this._drawingRect;
      const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2);
      const w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
      const toolColors = {
        no_go: "#f44336", carpet: "#9c27b0", low_clearance: "#2196f3", ramp: "#ff9800",
      };
      const color = toolColors[this._editTool] || "#f44336";
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
    for (const ramp of ramps) {
      if (!ramp.points || ramp.points.length !== 4) continue;
      const pts = ramp.points.map((p) => `${p.x},${p.y}`).join(" ");
      svgContent += `
        <polygon points="${pts}"
          fill="rgba(255,152,0,0.2)" stroke="#ff9800" stroke-width="2"
          stroke-dasharray="6 3"
          style="${this._mode === "edit" ? "cursor:pointer" : ""}" />
      `;
    }

    // Drawing preview for line tools (wall, threshold, impassable, cliff)
    if (this._mode === "edit" && this._drawingWall) {
      const d = this._drawingWall;
      const lineColors = {
        wall: "#f44336", threshold: "#4caf50", impassable: "#ff5722", cliff: "#795548",
      };
      const lineColor = lineColors[this._editTool] || "#f44336";
      svgContent += `
        <line x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}"
          stroke="${lineColor}" stroke-width="3" stroke-dasharray="4 2"
          stroke-linecap="round" opacity="0.7" />
      `;
    }

    // Furniture
    const furniture = camera.attributes.furniture || [];
    for (const item of furniture) {
      svgContent += `
        <rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}"
          fill="rgba(158, 158, 158, 0.15)" stroke="rgba(158, 158, 158, 0.5)"
          stroke-width="1" stroke-dasharray="4 2" rx="2" />
        <text x="${item.center_x}" y="${item.center_y}"
          text-anchor="middle" dominant-baseline="middle"
          fill="rgba(255,255,255,0.6)" font-size="9"
          font-family="system-ui, sans-serif"
          paint-order="stroke" stroke="rgba(0,0,0,0.4)" stroke-width="2">
          ${item.name}
        </text>
      `;
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
      const R = 22;
      svgContent += `
        <g transform="translate(${rx}, ${ry})" filter="url(#robotShadow)">
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
      const lineTools = ["wall", "threshold", "impassable", "cliff"];
      if (lineTools.includes(this._editTool)) {
        this._drawing = true;
        this._drawingWall = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      } else {
        // All rect-based tools: no_go, carpet, low_clearance, ramp
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
      if (this._drawingRect) {
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

      if (isTap) {
        // Tap: try to delete an existing zone or wall under the pointer
        this._drawingRect = null;
        this._drawingWall = null;
        const deleted = this._tryDeleteAtPoint(pt.x, pt.y);
        if (deleted) {
          this._editDirty = true;
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
    // Check all rect zone types
    const allRectZones = [
      this._editNoGoZones,
      this._editCarpetZones,
      this._editLowClearanceZones,
      this._editRamps,
    ];
    for (const zones of allRectZones) {
      for (let i = zones.length - 1; i >= 0; i--) {
        const zone = zones[i];
        if (!zone.points || zone.points.length < 3) continue;
        const xs = zone.points.map((p) => p.x);
        const ys = zone.points.map((p) => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
          zones.splice(i, 1);
          return true;
        }
      }
    }
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
    for (let i = 0; i < (360 - rotation) % 360 / 90; i++) {
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
      const tools = [
        { id: "no_go", icon: "mdi:cancel", label: "No-Go" },
        { id: "wall", icon: "mdi:wall", label: "Wall" },
        { id: "carpet", icon: "mdi:rug", label: "Carpet" },
        { id: "low_clearance", icon: "mdi:human-male-height", label: "Low Clear." },
        { id: "threshold", icon: "mdi:door-open", label: "Passable" },
        { id: "impassable", icon: "mdi:door-closed-lock", label: "Impass." },
        { id: "ramp", icon: "mdi:slope-uphill", label: "Ramp" },
        { id: "cliff", icon: "mdi:stairs", label: "Cliff" },
      ];
      const hints = {
        no_go: "Draw a rectangle for a no-go zone. Tap an existing zone to delete.",
        wall: "Draw a line for a virtual wall. Tap an existing wall to delete.",
        carpet: "Draw a rectangle to mark a carpet area. Tap to delete.",
        low_clearance: "Draw a rectangle for a low-clearance area. Tap to delete.",
        threshold: "Draw a line for a passable threshold. Tap to delete.",
        impassable: "Draw a line for an impassable threshold. Tap to delete.",
        ramp: "Draw a rectangle for a ramp area. Tap to delete.",
        cliff: "Draw a line for a cliff edge. Tap to delete.",
      };
      const counts = [
        [this._editNoGoZones.length, "no-go"],
        [this._editVirtualWalls.length, "wall"],
        [this._editCarpetZones.length, "carpet"],
        [this._editLowClearanceZones.length, "low-clear."],
        [this._editPassableThresholds.length, "passable"],
        [this._editImpassableThresholds.length, "impass."],
        [this._editRamps.length, "ramp"],
        [this._editCliffs.length, "cliff"],
      ].filter(([c]) => c > 0).map(([c, l]) => `${c} ${l}`).join(" · ");

      container.innerHTML = `
        <div class="edit-toolbar">
          <div class="edit-tool-selector">
            ${tools.map((t) => `
              <button class="edit-tool-btn ${this._editTool === t.id ? "active" : ""}" data-tool="${t.id}">
                <ha-icon icon="${t.icon}"></ha-icon> ${t.label}
              </button>
            `).join("")}
          </div>
          <div class="edit-hint">${hints[this._editTool]}</div>
          ${counts ? `<div class="edit-counts">${counts}</div>` : ""}
        </div>
      `;
      container.querySelectorAll(".edit-tool-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._editTool = btn.dataset.tool;
          this._updateContent();
        });
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
    const showConfig =
      this._mode !== "edit" && this._mode !== "goto" && (
        (this._mode === "room" && this._selectedRooms.size > 0) ||
        (this._mode === "zone" && this._zoneFinalized) ||
        this._mode === "all"
      );

    if (!showConfig) {
      section.innerHTML = "";
      return;
    }

    const suctionEntity = this._getState(this._entities.suction_level);
    const suctionLevel = suctionEntity?.state || "Standard";
    const cleaningModeEntity = this._getState(this._entities.cleaning_mode);
    const waterVolumeEntity = this._getState(this._entities.water_volume);
    const currentMode = cleaningModeEntity?.state || "Sweep & Mop";
    const currentWater = waterVolumeEntity?.state || "Medium";

    const suctionOptions = ["Quiet", "Standard", "Strong", "Turbo"];
    const modeOptions = ["Sweeping", "Mopping", "Sweep & Mop"];
    const waterOptions = ["Low", "Medium", "High"];

    section.innerHTML = `
      <div class="config-row">
        <div class="config-group">
          <span class="config-label">Suction</span>
          <div class="segmented-control" data-type="suction">
            ${suctionOptions.map((o) => `<button class="seg-btn ${o === suctionLevel ? "active" : ""}" data-value="${o}">${o}</button>`).join("")}
          </div>
        </div>
        <div class="config-group">
          <span class="config-label">Water</span>
          <div class="segmented-control" data-type="water">
            ${waterOptions.map((o) => `<button class="seg-btn ${o === currentWater ? "active" : ""}" data-value="${o}">${o}</button>`).join("")}
          </div>
        </div>
        <div class="config-group">
          <span class="config-label">Mode</span>
          <div class="segmented-control" data-type="mode">
            ${modeOptions.map((o) => `<button class="seg-btn ${o === currentMode ? "active" : ""}" data-value="${o}">${o}</button>`).join("")}
          </div>
        </div>
      </div>
    `;

    // Bind segmented control clicks
    section.querySelectorAll(".seg-btn").forEach((btn) => {
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
        ${state !== "docked" ? `
        <button class="action-btn secondary" data-action="return_to_base">
          <ha-icon icon="mdi:home"></ha-icon> Dock
        </button>` : ""}
      `;
    }

    actions.innerHTML = `<div class="action-buttons">${buttons}</div>`;

    actions.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._executeAction(btn.dataset.action);
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
        const suctionMap = { Quiet: 0, Standard: 1, Strong: 2, Turbo: 3 };
        const waterMap = { Low: 1, Medium: 2, High: 3 };
        const modeMap = { Sweeping: 0, Mopping: 1, "Sweep & Mop": 2 };

        const suction = suctionMap[this._getState(this._entities.suction_level)?.state] ?? 1;
        const water = waterMap[this._getState(this._entities.water_volume)?.state] ?? 2;
        const mode = modeMap[this._getState(this._entities.cleaning_mode)?.state] ?? 2;

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

        const suctionMap = { Quiet: 0, Standard: 1, Strong: 2, Turbo: 3 };
        const waterMap = { Low: 1, Medium: 2, High: 3 };
        const modeMap = { Sweeping: 0, Mopping: 1, "Sweep & Mop": 2 };

        const suction = suctionMap[this._getState(this._entities.suction_level)?.state] ?? 1;
        const water = waterMap[this._getState(this._entities.water_volume)?.state] ?? 2;
        const mode = modeMap[this._getState(this._entities.cleaning_mode)?.state] ?? 2;

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

    const serviceMap = {
      start: ["vacuum", "start"],
      pause: ["vacuum", "pause"],
      stop: ["vacuum", "stop"],
      return_to_base: ["vacuum", "return_to_base"],
    };

    const [domain, service] = serviceMap[action] || [];
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

      // Include threshold data if any exist
      const hasThresholds = this._editPassableThresholds.length > 0
        || this._editImpassableThresholds.length > 0
        || this._editRamps.length > 0
        || this._editCliffs.length > 0;
      if (hasThresholds) {
        const vws = {};
        if (this._editPassableThresholds.length > 0) {
          vws.vwsl = this._editPassableThresholds.map((t) => t.vacuum_coords);
        }
        if (this._editImpassableThresholds.length > 0) {
          vws.npthrsd = this._editImpassableThresholds.map((t) => t.vacuum_coords);
        }
        if (this._editRamps.length > 0) {
          vws.ramp = this._editRamps.map((r) => {
            const vc = r.vacuum_coords || [];
            return r.type != null ? [...vc, r.type] : vc;
          });
        }
        if (this._editCliffs.length > 0) {
          vws.cliff = this._editCliffs.map((t) => t.vacuum_coords);
        }
        serviceData.thresholds = vws;
      }

      await this._hass.callService("dreame_cloud", "update_map", serviceData);
      this._mode = "all";
      DreameVacuumMapCard._persistedMode = "all";
      this._exitEditMode();
      this._updateContent();
    } catch (err) {
      console.error("Failed to save map edits:", err);
    }
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
    const consumables = [
      { key: "main_brush", label: "Main Brush", icon: "mdi:brush" },
      { key: "side_brush", label: "Side Brush", icon: "mdi:brush" },
      { key: "filter", label: "Filter", icon: "mdi:air-filter" },
      { key: "mop_pad", label: "Mop Pad", icon: "mdi:square-rounded" },
    ];

    const availableConsumables = consumables.filter((c) => this._getState(this._entities[c.key]));
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

    // Buttons
    const actionBtns = [
      { key: "mop_wash", label: "Wash Mop", icon: "mdi:water" },
      { key: "mop_dry", label: "Dry Mop", icon: "mdi:fan" },
      { key: "dust_collection", label: "Empty Bin", icon: "mdi:delete-variant" },
    ];

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
        <h3>Actions</h3>
        <div class="settings-actions">
          ${actionBtns.map((a) => `
            <button class="settings-action-btn" data-entity="${this._entities[a.key]}">
              <ha-icon icon="${a.icon}"></ha-icon>
              <span>${a.label}</span>
            </button>
          `).join("")}
        </div>
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

    panel.querySelectorAll(".settings-action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._hass.callService("button", "press", {
          entity_id: btn.dataset.entity,
        });
      });
    });
  }

  _getStyles() {
    return `
      :host {
        --card-bg: var(--ha-card-background, var(--card-background-color, #fff));
        --text-primary: var(--primary-text-color, #1a1a1a);
        --text-secondary: var(--secondary-text-color, #6e6e73);
        --accent: var(--primary-color, #007aff);
        --surface: var(--secondary-background-color, #f5f5f7);
        --border: var(--divider-color, rgba(0,0,0,0.08));
        --radius: 12px;
        --radius-sm: 8px;
      }

      ha-card {
        display: block;
        overflow: hidden;
        border-radius: var(--ha-card-border-radius, var(--radius));
        background: var(--card-bg);
        color: var(--text-primary);
        box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,0.1));
      }

      .card-content {
        padding: 0;
      }

      /* Header */
      .header {
        padding: 16px 16px 12px;
      }
      .header-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .header-left {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .device-name {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
        line-height: 1.2;
      }
      .status-text {
        font-size: 13px;
        color: var(--text-secondary);
        font-weight: 400;
      }
      .header-right {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .battery {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
      }
      .battery ha-icon {
        --mdc-icon-size: 20px;
        color: var(--text-secondary);
      }
      .settings-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        color: var(--text-secondary);
        border-radius: 50%;
        display: flex;
        align-items: center;
      }
      .settings-btn:hover {
        background: var(--surface);
      }
      .settings-btn ha-icon {
        --mdc-icon-size: 20px;
      }

      .stats {
        display: flex;
        gap: 16px;
        margin-top: 8px;
      }
      .stat {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 13px;
        color: var(--text-secondary);
      }
      .stat ha-icon {
        --mdc-icon-size: 16px;
      }

      .progress-bar {
        height: 3px;
        background: var(--surface);
        margin-top: 10px;
        border-radius: 2px;
        overflow: hidden;
      }
      .progress-bar-fill {
        height: 100%;
        background: var(--accent);
        width: 30%;
        border-radius: 2px;
        animation: progress-pulse 2s ease-in-out infinite;
      }
      @keyframes progress-pulse {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 1; }
      }

      /* Map */
      .map-container {
        position: relative;
        background: #1a1a2e;
        margin: 0 12px;
        border-radius: var(--radius);
        overflow: hidden;
        min-height: 200px;
        touch-action: none;
      }
      .map-image {
        width: 100%;
        height: auto;
        display: block;
      }
      .map-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: all;
      }
      .map-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 250px;
        color: rgba(255,255,255,0.4);
        font-size: 14px;
      }

      /* Mode Tabs */
      .mode-tabs {
        display: flex;
        margin: 12px 12px 0;
        background: var(--surface);
        border-radius: var(--radius-sm);
        padding: 3px;
      }
      .tab {
        flex: 1;
        padding: 8px 0;
        border: none;
        background: none;
        color: var(--text-secondary);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.2s ease;
      }
      .tab.active {
        background: var(--card-bg);
        color: var(--text-primary);
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      }

      /* Room List */
      .room-list-container {
        margin: 0 12px;
      }
      .room-view-toggle {
        display: flex;
        justify-content: flex-end;
        gap: 4px;
        padding: 8px 0 4px;
      }
      .view-btn {
        background: none;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
      }
      .view-btn.active {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      .view-btn ha-icon {
        --mdc-icon-size: 18px;
      }
      .selected-rooms-text {
        font-size: 13px;
        color: var(--text-secondary);
        padding: 4px 0 8px;
        text-align: center;
      }

      .room-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 180px;
        overflow-y: auto;
        padding: 2px 2px 8px;
      }
      .room-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        background: var(--surface);
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: background 0.15s;
      }
      .room-item:hover {
        background: var(--border);
      }
      .room-item.selected {
        background: color-mix(in srgb, var(--accent) 12%, var(--surface));
        outline: 2px solid var(--accent);
      }
      .room-color {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        flex-shrink: 0;
      }
      .room-name {
        flex: 1;
        font-size: 14px;
        color: var(--text-primary);
      }
      .room-order {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        color: white;
        font-size: 12px;
        font-weight: 700;
        flex-shrink: 0;
      }
      .room-item input[type="checkbox"] {
        display: none;
      }

      /* Config */
      .config-section {
        margin: 0 12px;
      }
      .config-row {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 0;
      }
      .config-group {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .config-label {
        font-size: 13px;
        color: var(--text-secondary);
        font-weight: 500;
        min-width: 56px;
      }
      .segmented-control {
        display: flex;
        flex: 1;
        background: var(--surface);
        border-radius: 6px;
        padding: 2px;
      }
      .seg-btn {
        flex: 1;
        padding: 6px 4px;
        border: none;
        background: none;
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 5px;
        transition: all 0.2s;
        white-space: nowrap;
      }
      .seg-btn.active {
        background: var(--card-bg);
        color: var(--text-primary);
        box-shadow: 0 1px 2px rgba(0,0,0,0.08);
      }

      /* Actions */
      .actions {
        padding: 12px;
      }
      .action-buttons {
        display: flex;
        gap: 8px;
      }
      .action-btn {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 12px 16px;
        border: none;
        border-radius: var(--radius-sm);
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .action-btn ha-icon {
        --mdc-icon-size: 20px;
      }
      .action-btn.primary {
        background: var(--accent);
        color: white;
      }
      .action-btn.primary:hover {
        filter: brightness(1.1);
      }
      .action-btn.primary:active {
        transform: scale(0.98);
      }
      .action-btn.secondary {
        background: var(--surface);
        color: var(--text-primary);
      }
      .action-btn.secondary:hover {
        background: var(--border);
      }

      /* Settings Panel */
      .settings-panel {
        max-height: 0;
        overflow: hidden;
        transition: max-height 0.3s ease;
      }
      .settings-panel.open {
        max-height: 800px;
        border-top: 1px solid var(--border);
      }
      .settings-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .close-settings {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--text-secondary);
        padding: 4px;
        border-radius: 50%;
        display: flex;
      }
      .close-settings:hover {
        background: var(--surface);
      }
      .close-settings ha-icon {
        --mdc-icon-size: 20px;
      }

      .settings-section {
        padding: 0 16px 16px;
      }
      .settings-section h3 {
        margin: 0 0 10px;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      /* Consumables */
      .consumable {
        margin-bottom: 10px;
      }
      .consumable-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
        font-size: 14px;
        color: var(--text-primary);
      }
      .consumable-header ha-icon {
        --mdc-icon-size: 18px;
        color: var(--text-secondary);
      }
      .consumable-value {
        margin-left: auto;
        font-weight: 500;
        font-size: 13px;
        color: var(--text-secondary);
      }
      .consumable-bar {
        height: 6px;
        background: var(--surface);
        border-radius: 3px;
        overflow: hidden;
      }
      .consumable-bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      /* Volume */
      .volume-control {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .volume-control ha-icon {
        --mdc-icon-size: 20px;
        color: var(--text-secondary);
      }
      .volume-slider {
        flex: 1;
        -webkit-appearance: none;
        height: 6px;
        background: var(--surface);
        border-radius: 3px;
        outline: none;
      }
      .volume-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 18px;
        height: 18px;
        background: var(--accent);
        border-radius: 50%;
        cursor: pointer;
      }
      .volume-value {
        min-width: 28px;
        text-align: right;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
      }

      /* DND Toggle */
      .dnd-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 0;
        cursor: pointer;
        font-size: 14px;
        color: var(--text-primary);
      }
      .dnd-checkbox {
        display: none;
      }
      .toggle-slider {
        width: 44px;
        height: 24px;
        background: var(--surface);
        border-radius: 12px;
        position: relative;
        transition: background 0.2s;
      }
      .toggle-slider::after {
        content: "";
        position: absolute;
        width: 20px;
        height: 20px;
        background: white;
        border-radius: 50%;
        top: 2px;
        left: 2px;
        transition: transform 0.2s;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      }
      .dnd-checkbox:checked + .toggle-slider {
        background: var(--accent);
      }
      .dnd-checkbox:checked + .toggle-slider::after {
        transform: translateX(20px);
      }

      /* Settings Actions */
      .settings-actions {
        display: flex;
        gap: 8px;
      }
      .settings-action-btn {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 12px 8px;
        background: var(--surface);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        color: var(--text-primary);
        font-size: 12px;
        font-weight: 500;
        transition: background 0.15s;
      }
      .settings-action-btn:hover {
        background: var(--border);
      }
      .settings-action-btn ha-icon {
        --mdc-icon-size: 22px;
        color: var(--accent);
      }

      /* Edit Mode */
      .edit-toolbar {
        padding: 10px 0;
      }
      .edit-tool-selector {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }
      .edit-tool-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 6px 10px;
        border: 2px solid var(--border);
        background: var(--surface);
        color: var(--text-secondary);
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .edit-tool-btn ha-icon {
        --mdc-icon-size: 16px;
      }
      .edit-tool-btn.active {
        border-color: #f44336;
        background: rgba(244, 67, 54, 0.08);
        color: #f44336;
      }
      .edit-hint {
        font-size: 12px;
        color: var(--text-secondary);
        margin-bottom: 6px;
      }
      .edit-counts {
        display: flex;
        gap: 16px;
        font-size: 12px;
        color: var(--text-secondary);
        font-weight: 500;
      }
      .action-btn.disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `;
  }

  getCardSize() {
    return 6;
  }
}

// ── Card Editor ──────────────────────────────────────────────────────
class DreameVacuumMapCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    const needsRender = !this._rendered
      || config.entity !== this._config.entity
      || config.map_entity !== this._config.map_entity;
    this._config = { ...config };
    if (needsRender) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // Only render once; after that hass updates don't change the editor UI
    if (!this._rendered) this._render();
  }

  _getVacuumEntities() {
    if (!this._hass) return [];
    return Object.keys(this._hass.states)
      .filter((id) => id.startsWith("vacuum."))
      .map((id) => ({
        id,
        name: this._hass.states[id].attributes.friendly_name || id,
        isDreame: id.includes("dreame"),
      }))
      .sort((a, b) => {
        if (a.isDreame !== b.isDreame) return a.isDreame ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  _getMapEntities() {
    if (!this._hass) return [];
    return Object.keys(this._hass.states)
      .filter((id) => id.startsWith("camera.") && id.includes("map"))
      .map((id) => ({
        id,
        name: this._hass.states[id].attributes.friendly_name || id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _getCameraEntityId() {
    const entity = this._config.entity || "";
    if (this._config.map_entity) return this._config.map_entity;
    const base = entity.replace("vacuum.", "").replace(/_vacuum$/, "");
    return base ? `camera.${base}_map` : "";
  }

  _getRooms() {
    if (!this._hass) return {};
    const camId = this._getCameraEntityId();
    const cam = camId ? this._hass.states[camId] : null;
    return cam?.attributes?.rooms || {};
  }

  _render() {
    if (!this._hass) return;

    const vacuums = this._getVacuumEntities();
    const maps = this._getMapEntities();
    const currentEntity = this._config.entity || "";
    const currentMap = this._config.map_entity || "";

    // Auto-select first Dreame vacuum if no entity is configured
    if (!currentEntity && vacuums.length > 0) {
      const dreame = vacuums.find((v) => v.isDreame);
      if (dreame) {
        this._config = { ...this._config, entity: dreame.id };
        fireEvent(this, "config-changed", { config: this._config });
      }
    }

    const vacuumOptions = vacuums.map((v) => {
      const selected = v.id === (this._config.entity || "") ? "selected" : "";
      const label = v.isDreame ? `★ ${v.name}` : v.name;
      return `<option value="${v.id}" ${selected}>${label}</option>`;
    }).join("");

    const mapOptions = maps.map((m) => {
      const selected = m.id === currentMap ? "selected" : "";
      return `<option value="${m.id}" ${selected}>${m.name}</option>`;
    }).join("");

    // Room aliases
    const rooms = this._getRooms();
    const aliases = this._config.room_aliases || {};
    const roomEntries = Object.entries(rooms).sort(([, a], [, b]) => a.name.localeCompare(b.name));
    const hiddenRooms = this._config.hidden_rooms || [];
    const roomAliasesHtml = roomEntries.length > 0
      ? roomEntries.map(([segId, room]) => {
          const alias = aliases[segId] || "";
          const hidden = hiddenRooms.includes(parseInt(segId, 10));
          return `
            <div class="alias-row ${hidden ? "alias-hidden" : ""}">
              <span class="alias-room-name">${room.name}</span>
              <input type="text" class="alias-input" data-seg-id="${segId}"
                placeholder="${room.name}" value="${alias}" />
              <button class="alias-vis-btn" data-seg-id="${segId}" title="${hidden ? "Show room" : "Hide room"}">
                <ha-icon icon="${hidden ? "mdi:eye-off" : "mdi:eye"}"></ha-icon>
              </button>
            </div>
          `;
        }).join("")
      : '<div class="hint">No rooms detected yet. Rooms will appear here after the map loads.</div>';

    this.shadowRoot.innerHTML = `
      <style>
        .editor { padding: 16px; }
        .field { margin-bottom: 12px; }
        label { display: block; font-weight: 500; margin-bottom: 4px; font-size: 14px; color: var(--primary-text-color, #1a1a1a); }
        select, input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 6px;
          font-size: 14px;
          box-sizing: border-box;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #1a1a1a);
          -webkit-appearance: none;
          appearance: none;
        }
        select {
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
          padding-right: 28px;
          cursor: pointer;
        }
        .hint { font-size: 12px; color: var(--secondary-text-color, #888); margin-top: 4px; }
        .section-label {
          font-weight: 600;
          font-size: 14px;
          color: var(--primary-text-color, #1a1a1a);
          margin: 16px 0 8px;
          padding-top: 12px;
          border-top: 1px solid var(--divider-color, #eee);
        }
        .alias-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }
        .alias-room-name {
          font-size: 13px;
          color: var(--secondary-text-color, #888);
          min-width: 70px;
          flex-shrink: 0;
        }
        .alias-input {
          flex: 1;
        }
        .alias-vis-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 8px;
          border-radius: 6px;
          color: var(--secondary-text-color, #888);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          min-width: 36px;
          min-height: 36px;
          position: relative;
          z-index: 1;
        }
        .alias-vis-btn:hover {
          background: var(--divider-color, #eee);
        }
        .alias-vis-btn ha-icon {
          --mdc-icon-size: 20px;
          pointer-events: none;
        }
        .alias-row.alias-hidden {
          opacity: 0.45;
        }
        .alias-row.alias-hidden .alias-input {
          text-decoration: line-through;
        }
      </style>
      <div class="editor">
        <div class="field">
          <label>Vacuum Entity</label>
          <select id="entity">
            <option value="">Select a vacuum...</option>
            ${vacuumOptions}
          </select>
          ${vacuums.some((v) => v.isDreame) ? '<div class="hint">★ = Dreame vacuum</div>' : ""}
        </div>
        <div class="field">
          <label>Map Entity (optional)</label>
          <select id="map_entity">
            <option value="">Auto-detect from vacuum</option>
            ${mapOptions}
          </select>
          <div class="hint">Leave on auto-detect unless you have multiple maps</div>
        </div>
        <div class="section-label">Room Names</div>
        <div class="hint" style="margin-bottom:8px">Override the default room names from the vacuum</div>
        ${roomAliasesHtml}
      </div>
    `;

    this.shadowRoot.getElementById("entity").addEventListener("change", (e) => {
      this._config = { ...this._config, entity: e.target.value };
      fireEvent(this, "config-changed", { config: this._config });
    });

    this.shadowRoot.getElementById("map_entity").addEventListener("change", (e) => {
      const val = e.target.value.trim();
      this._config = { ...this._config };
      if (val) {
        this._config.map_entity = val;
      } else {
        delete this._config.map_entity;
      }
      fireEvent(this, "config-changed", { config: this._config });
    });

    this.shadowRoot.querySelectorAll(".alias-input").forEach((input) => {
      input.addEventListener("input", (e) => {
        const segId = e.target.dataset.segId;
        const val = e.target.value.trim();
        const aliases = { ...(this._config.room_aliases || {}) };
        if (val) {
          aliases[segId] = val;
        } else {
          delete aliases[segId];
        }
        this._config = { ...this._config, room_aliases: aliases };
        fireEvent(this, "config-changed", { config: this._config });
      });
    });

    this.shadowRoot.querySelectorAll(".alias-vis-btn").forEach((btn) => {
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
        // Update DOM directly since editor uses render-once
        const icon = btn.querySelector("ha-icon");
        if (icon) icon.setAttribute("icon", isNowHidden ? "mdi:eye-off" : "mdi:eye");
        btn.title = isNowHidden ? "Show room" : "Hide room";
        const row = btn.closest(".alias-row");
        if (row) row.classList.toggle("alias-hidden", isNowHidden);

        this._config = { ...this._config, hidden_rooms: hidden };
        fireEvent(this, "config-changed", { config: this._config });
      });
    });

    this._rendered = true;
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
