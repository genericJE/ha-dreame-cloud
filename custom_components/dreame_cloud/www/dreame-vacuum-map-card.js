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
    this._mode = "all"; // all | room | zone
    this._roomView = "map"; // map | list
    this._settingsOpen = false;
    this._zone = null; // {x1, y1, x2, y2} in image px during drawing
    this._zoneFinalized = null; // finalized zone
    this._drawing = false;
    this._lastEntityPicture = null;
    this._entities = {};
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
    this._config = { ...config };
    this._deriveEntities();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._updateContent();
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
        this._mode = tab.dataset.mode;
        this._selectedRooms.clear();
        this._zoneFinalized = null;
        this._zone = null;
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
    if (this._mode === "room") {
      for (const [segId, room] of Object.entries(rooms)) {
        const selected = this._selectedRooms.has(parseInt(segId, 10));
        const [r, g, b] = room.color || [135, 206, 235];
        const opacity = selected ? 0.5 : 0.15;
        const strokeWidth = selected ? 3 : 1;
        const strokeColor = selected ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},0.4)`;

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
              ${room.name}
            </text>
          </g>
        `;
      }
    }

    // Robot position
    const robotPos = camera.attributes.robot_position;
    if (robotPos) {
      svgContent += `
        <circle cx="${robotPos.x}" cy="${robotPos.y}" r="10"
          fill="#ff3c3c" stroke="white" stroke-width="2" />
      `;
    }

    // Charger position
    const chargerPos = camera.attributes.charger_position;
    if (chargerPos) {
      svgContent += `
        <rect x="${chargerPos.x - 8}" y="${chargerPos.y - 8}" width="16" height="16"
          fill="#3cdc3c" stroke="white" stroke-width="2" rx="3" />
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

    mapOverlay.innerHTML = svgContent;

    // Bind room click handlers
    if (this._mode === "room") {
      mapOverlay.querySelectorAll(".room-overlay").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const segId = parseInt(el.dataset.segId, 10);
          if (this._selectedRooms.has(segId)) {
            this._selectedRooms.delete(segId);
          } else {
            this._selectedRooms.add(segId);
          }
          this._updateContent();
        });
      });
    }
  }

  _onPointerDown(e) {
    if (this._mode !== "zone") return;
    const svg = this.shadowRoot.querySelector(".map-overlay");
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const svgWidth = parseFloat(svg.getAttribute("viewBox")?.split(" ")[2] || "800");
    const svgHeight = parseFloat(svg.getAttribute("viewBox")?.split(" ")[3] || "600");

    const x = ((e.clientX - rect.left) / rect.width) * svgWidth;
    const y = ((e.clientY - rect.top) / rect.height) * svgHeight;

    this._drawing = true;
    this._zone = { x1: x, y1: y, x2: x, y2: y };
    this._zoneFinalized = null;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this._drawing || !this._zone) return;
    const svg = this.shadowRoot.querySelector(".map-overlay");
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const svgWidth = parseFloat(svg.getAttribute("viewBox")?.split(" ")[2] || "800");
    const svgHeight = parseFloat(svg.getAttribute("viewBox")?.split(" ")[3] || "600");

    this._zone.x2 = Math.max(0, Math.min(svgWidth, ((e.clientX - rect.left) / rect.width) * svgWidth));
    this._zone.y2 = Math.max(0, Math.min(svgHeight, ((e.clientY - rect.top) / rect.height) * svgHeight));

    this._updateMap(this.shadowRoot.querySelector("ha-card"));
    e.preventDefault();
  }

  _onPointerUp(e) {
    if (!this._drawing || !this._zone) return;
    this._drawing = false;

    const dx = Math.abs(this._zone.x2 - this._zone.x1);
    const dy = Math.abs(this._zone.y2 - this._zone.y1);

    if (dx > 10 && dy > 10) {
      this._zoneFinalized = { ...this._zone };
    }
    this._zone = null;
    this._updateContent();
    e.preventDefault();
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
    const rawW = attrs.raw_width || 1;
    const rawH = attrs.raw_height || 1;

    // Reverse scale
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

    // Add map offsets
    return [Math.round(x + mapLeft), Math.round(y + mapTop)];
  }

  _updateModeTabs(card) {
    card.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === this._mode);
    });
  }

  _updateRoomList(card) {
    const container = card.querySelector(".room-list-container");
    if (this._mode !== "room") {
      container.innerHTML = "";
      return;
    }

    const camera = this._getState(this._entities.map);
    const rooms = camera?.attributes?.rooms || {};
    const roomEntries = Object.entries(rooms);
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
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([segId, room]) => {
          const checked = this._selectedRooms.has(parseInt(segId, 10));
          const [r, g, b] = room.color || [135, 206, 235];
          return `
            <label class="room-item ${checked ? "selected" : ""}" data-seg-id="${segId}">
              <span class="room-color" style="background:rgb(${r},${g},${b})"></span>
              <span class="room-name">${room.name}</span>
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
          } else {
            this._selectedRooms.add(segId);
          }
          this._updateContent();
        });
      });
    } else {
      // Map view: show selected room names
      const selectedNames = roomEntries
        .filter(([segId]) => this._selectedRooms.has(parseInt(segId, 10)))
        .map(([, room]) => room.name);
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
      (this._mode === "room" && this._selectedRooms.size > 0) ||
      (this._mode === "zone" && this._zoneFinalized) ||
      this._mode === "all";

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
          segments: [...this._selectedRooms],
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
        padding-bottom: 8px;
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
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
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

  _render() {
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
