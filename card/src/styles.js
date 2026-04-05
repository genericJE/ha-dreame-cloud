export function getStyles() {
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
        position: relative;
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
      .header-icon-btn,
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
      .header-icon-btn:hover,
      .settings-btn:hover {
        background: var(--surface);
      }
      .header-icon-btn ha-icon,
      .settings-btn ha-icon {
        --mdc-icon-size: 20px;
      }
      .header-icon-btn.active {
        color: var(--accent);
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
      .map-toast {
        display: none;
        position: fixed;
        bottom: 40px;
        left: 50%;
        transform: translateX(-50%);
        background: #d32f2f;
        color: white;
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 13px;
        z-index: 1000;
        max-width: 90%;
        text-align: center;
        transition: opacity 0.5s;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      }
      .action-btn.secondary {
        background: var(--surface);
        color: var(--text-primary);
      }
      .action-btn.secondary:hover {
        background: var(--border);
      }

      /* Dock Menu */
      .dock-menu {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .dock-action-btn {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 12px 8px;
        border: none;
        border-radius: var(--radius-sm);
        background: var(--surface);
        color: var(--text-primary);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
      }
      .dock-action-btn:hover {
        background: var(--border);
      }
      .dock-action-btn ha-icon {
        --mdc-icon-size: 24px;
        color: var(--text-secondary);
      }

      /* Settings Panel */
      .settings-panel {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        max-height: 0;
        overflow: hidden;
        transition: max-height 0.3s ease;
        background: var(--card-bg);
        z-index: 10;
      }
      .settings-panel.open {
        max-height: 70vh;
        overflow-y: auto;
        border-top: 1px solid var(--border);
        box-shadow: 0 -4px 12px rgba(0,0,0,0.3);
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

      /* Room aliases in settings */
      .settings-alias-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .settings-alias-name {
        font-size: 13px;
        color: var(--text-secondary);
        min-width: 70px;
        flex-shrink: 0;
      }
      .settings-alias-input {
        flex: 1;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        font-size: 13px;
        background: var(--surface);
        color: var(--text-primary);
        outline: none;
      }
      .settings-alias-input:focus {
        border-color: var(--accent);
      }
      .settings-alias-vis {
        background: none;
        border: none;
        cursor: pointer;
        padding: 6px;
        border-radius: 6px;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }
      .settings-alias-vis:hover {
        background: var(--surface);
      }
      .settings-alias-vis ha-icon {
        --mdc-icon-size: 18px;
        pointer-events: none;
      }
      .settings-alias-row.settings-alias-hidden {
        opacity: 0.45;
      }
      .settings-alias-row.settings-alias-hidden .settings-alias-input {
        text-decoration: line-through;
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
      .furniture-actions {
        display: flex;
        gap: 6px;
        margin-bottom: 6px;
      }
      .furniture-delete-btn {
        border-color: #f44336 !important;
        color: #f44336 !important;
      }
      .furniture-picker {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px;
        margin: 6px 0;
      }
      .furniture-picker-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
      .furniture-picker-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }
      .furniture-type-btn {
        padding: 4px 8px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text-secondary);
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .furniture-type-btn:hover {
        border-color: #ffc107;
        color: #ffc107;
      }
      .furniture-picker-cancel {
        padding: 4px 12px;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
      }
      .action-btn.disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `;
}
