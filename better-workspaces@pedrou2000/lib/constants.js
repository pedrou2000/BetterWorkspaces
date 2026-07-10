/* lib/constants.js — shared tunables (timings, sizes, defaults) only. */

// Deliberately not a god-config: single-module values (Notion prop names,
// gsettings schemas, the UUID) stay where they're used.

var Constants = {
    // Timings (ms)
    CLOSE_GRACE_MS: 700, // wait after requesting window closes before recheck
    OSD_HIDE_MS: 900, // project-aware OSD auto-hide

    // Sizes (px)
    PANEL_ICON_SIZE: 22, // project icons in the panel
    PANEL_PROJECT_SPACING: 2, // px of horizontal margin each side of a project icon
    PANEL_DOT_SIZE: 15, // font-size (px) of the workspace ●/· dots
    ROW_ICON_SIZE: 20, // project icons in the toggle panel rows

    // Defaults
    DEFAULT_WS_PER_PROJECT: 1, // workspaces a project starts with (the home)
    DEFAULT_SYNC_INTERVAL_S: 300, // background Notion sync interval (seconds)
};
