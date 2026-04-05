export function fireEvent(node, type, detail) {
  const event = new Event(type, { bubbles: true, composed: true });
  event.detail = detail;
  node.dispatchEvent(event);
}

export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function batteryIcon(level) {
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
