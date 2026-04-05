// Cleaning parameter maps (name -> numeric value for service calls)
export const SUCTION_MAP = { Quiet: 0, Standard: 1, Strong: 2, Turbo: 3 };
export const WATER_MAP = { Low: 1, Medium: 2, High: 3 };
export const CLEANING_MODE_MAP = { Sweeping: 0, Mopping: 1, "Sweep & Mop": 2 };

// Cleaning parameter option lists (for settings UI)
export const SUCTION_OPTIONS = ["Quiet", "Standard", "Strong", "Turbo"];
export const WATER_OPTIONS = ["Low", "Medium", "High"];
export const CLEANING_MODE_OPTIONS = ["Sweeping", "Mopping", "Sweep & Mop"];

// Drawing preview colors per tool
export const RECT_TOOL_COLORS = {
  no_go: "#f44336", carpet: "#9c27b0", low_clearance: "#2196f3", ramp: "#ff9800",
};
export const LINE_TOOL_COLORS = {
  wall: "#f44336", threshold: "#4caf50", impassable: "#ff5722", cliff: "#795548",
};

// Tool categories
export const RECT_TOOLS = ["no_go", "carpet", "low_clearance", "ramp"];
export const LINE_TOOLS = ["wall", "threshold", "impassable", "cliff"];

// Furniture types with default vacuum-coord dimensions (mm)
export const FURNITURE_TYPES = {
  1: { name: "Single Bed", w: 2000, h: 1000 },
  2: { name: "Double Bed", w: 2000, h: 1600 },
  3: { name: "Armchair", w: 800, h: 800 },
  4: { name: "Two Seat Sofa", w: 1400, h: 800 },
  5: { name: "Three Seat Sofa", w: 2000, h: 800 },
  6: { name: "Dining Table", w: 1200, h: 800 },
  7: { name: "Nightstand", w: 500, h: 500 },
  8: { name: "Coffee Table", w: 1000, h: 500 },
  9: { name: "Toilet", w: 400, h: 600 },
  10: { name: "Litter Box", w: 500, h: 400 },
  11: { name: "Pet Bed", w: 600, h: 500 },
  12: { name: "Food Bowl", w: 300, h: 300 },
  13: { name: "Pet Toilet", w: 500, h: 400 },
  14: { name: "Refrigerator", w: 600, h: 700 },
  15: { name: "Washing Machine", w: 600, h: 600 },
  16: { name: "Enclosed Litter Box", w: 500, h: 500 },
  17: { name: "Air Conditioner", w: 800, h: 300 },
  18: { name: "TV Cabinet", w: 1600, h: 400 },
  19: { name: "Bookshelf", w: 800, h: 400 },
  20: { name: "Shoe Cabinet", w: 800, h: 400 },
  21: { name: "Wardrobe", w: 1600, h: 600 },
  22: { name: "Greenery", w: 400, h: 400 },
  23: { name: "Floor Mirror", w: 400, h: 300 },
  24: { name: "L-Shaped Sofa", w: 2400, h: 1600 },
  25: { name: "Round Coffee Table", w: 600, h: 600 },
  26: { name: "Table", w: 1000, h: 800 },
};

// Edit toolbar tool definitions
export const EDIT_TOOLS = [
  { id: "no_go", icon: "mdi:cancel", label: "No-Go" },
  { id: "wall", icon: "mdi:wall", label: "Wall" },
  { id: "carpet", icon: "mdi:rug", label: "Carpet" },
  { id: "low_clearance", icon: "mdi:human-male-height", label: "Low Clear." },
  { id: "threshold", icon: "mdi:door-open", label: "Passable" },
  { id: "impassable", icon: "mdi:door-closed-lock", label: "Impass." },
  { id: "ramp", icon: "mdi:slope-uphill", label: "Ramp" },
  { id: "cliff", icon: "mdi:stairs", label: "Cliff" },
  { id: "furniture", icon: "mdi:sofa", label: "Furniture" },
];

// Edit tool hint text
export const EDIT_TOOL_HINTS = {
  no_go: "Draw to add. Tap to select, drag to move, handles to resize.",
  wall: "Draw a line for a virtual wall. Tap an existing wall to delete.",
  carpet: "Draw to add. Tap to select, drag to move, handles to resize.",
  low_clearance: "Draw to add. Tap to select, drag to move, handles to resize.",
  threshold: "Draw a line for a passable threshold. Tap to delete.",
  impassable: "Draw a line for an impassable threshold. Tap to delete.",
  ramp: "Draw to add. Tap to select, drag to move, handles to resize.",
  cliff: "Draw a line for a cliff edge. Tap to delete.",
  furniture: "Tap to select. Drag to move, handles to resize. Tap empty space to add.",
};

// Status display labels
export const STATUS_LABELS = {
  cleaning: "Cleaning",
  docked: "Docked",
  idle: "Idle",
  paused: "Paused",
  returning: "Returning",
  error: "Error",
  unavailable: "Unavailable",
};

// Vacuum service action mapping
export const VACUUM_SERVICE_MAP = {
  start: ["vacuum", "start"],
  pause: ["vacuum", "pause"],
  stop: ["vacuum", "stop"],
  return_to_base: ["vacuum", "return_to_base"],
};

// Dock menu actions
export const DOCK_ACTIONS = [
  { key: "mop_wash", label: "Wash Mop", icon: "mdi:water" },
  { key: "mop_dry", label: "Dry Mop", icon: "mdi:fan" },
  { key: "dust_collection", label: "Empty Bin", icon: "mdi:delete-variant" },
];

// Settings panel consumable definitions
export const CONSUMABLE_DEFS = [
  { key: "main_brush", label: "Main Brush", icon: "mdi:brush" },
  { key: "side_brush", label: "Side Brush", icon: "mdi:brush" },
  { key: "filter", label: "Filter", icon: "mdi:air-filter" },
  { key: "mop_pad", label: "Mop Pad", icon: "mdi:square-rounded" },
];

// Save-result attribute mapping (zone type key -> entity attribute name)
export const SAVE_RESULT_ATTR_MAP = {
  passable: "passable_thresholds",
  impassable: "impassable_thresholds",
  ramp: "ramps",
  cliff: "cliffs",
  no_go: "no_go_zones",
  wall: "virtual_walls",
  low_clearance: "low_clearance_zones",
  furniture: "furniture",
};
