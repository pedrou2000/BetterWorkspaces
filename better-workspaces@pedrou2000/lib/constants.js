/*
 * BetterWorkspaces — lib/constants.js
 *
 * Centralized TUNABLES — the timing/size/default knobs a maintainer might want
 * to adjust in one place. Deliberately NOT a god-config: values that belong to
 * a single module and its meaning (Notion property names, gsettings schema
 * lists, the bootstrap UUID) stay where they're used. Version lives in
 * metadata.json (read from the object Cinnamon passes to main()).
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

var Constants = {
    // Timings (ms)
    CLOSE_GRACE_MS: 700,     // wait after requesting window closes before recheck
    COMMIT_DELAY_MS: 600,    // Super+Tab: commit after last press
    OSD_HIDE_MS: 900,        // project-aware OSD auto-hide

    // Sizes (px)
    PANEL_ICON_SIZE: 22,     // project icons in the panel
    ROW_ICON_SIZE: 20,       // project icons in the toggle panel rows

    // Defaults
    DEFAULT_WS_PER_PROJECT: 1,   // workspaces a project starts with (the home)
    DEFAULT_SYNC_INTERVAL_S: 300, // background Notion sync interval (seconds)
};
