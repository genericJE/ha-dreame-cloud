import { fireEvent } from "./helpers.js";

export class DreameVacuumMapCardEditor extends HTMLElement {
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
              <button class="alias-vis-btn" data-seg-id="${segId}" title="${hidden ? "Show room" : "Hide room"}" aria-label="${hidden ? "Show room" : "Hide room"}">
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
