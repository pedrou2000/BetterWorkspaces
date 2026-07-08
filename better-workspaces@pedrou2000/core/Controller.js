/*
 * BetterWorkspaces — core/Controller.js
 *
 * The brain (Design Doc §3.C). Owns State, uses mapping.js to translate the
 * deck-of-strips model onto the flat workspace list, and drives the WM wrapper.
 * Every user intent ("switch to project X", "next workspace within project",
 * "previous project") lands here and is turned into concrete WM calls.
 *
 * M2 scope: correctness of the model and its mapping, driven from a hardcoded
 * project list. No Notion, no UI yet.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const StateModule = AppletDir.core.State;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;

// Map an xdg default-web-browser .desktop id -> the binary to launch with
// --new-window. Mainstream browsers all accept --new-window. Anything not
// listed falls back to xdg-open (default browser, but a new tab).
const BROWSER_BINARIES = [
    { match: "firefox",  bin: "firefox" },
    { match: "chrome",   bin: "google-chrome" },
    { match: "chromium", bin: "chromium" },
    { match: "brave",    bin: "brave-browser" },
    { match: "edge",     bin: "microsoft-edge" },
    { match: "vivaldi",  bin: "vivaldi" },
    { match: "opera",    bin: "opera" },
];

// How long to wait after requesting window closes before rechecking (ms).
const CLOSE_GRACE_MS = 700;

function log(msg) { global.log(UUID + " [ctrl]: " + msg); }
function logError(msg) { global.logError(UUID + " [ctrl]: " + msg); }

function Controller(wm) {
    this._init(wm);
}

Controller.prototype = {

    _init: function (wm) {
        this.wm = wm;                       // wm/WorkspaceManager instance
        this.state = new StateModule.State();
    },

    // Seed the deck (M2: hardcoded). Ensures the WM has exactly as many flat
    // workspaces as the model requires, then activates project 0 / local 0.
    loadProjects: function (defs) {
        this.state.setProjects(defs);
        this._reconcileWorkspaceCount();
        this.goToProject(0);
    },

    // Make the real flat workspace count equal the sum of all project strips.
    _reconcileWorkspaceCount: function () {
        let need = Mapping.totalWorkspaces(this.state.counts());
        let have = this.wm.getWorkspaceCount();
        while (this.wm.getWorkspaceCount() < need) this.wm.createWorkspace();
        while (this.wm.getWorkspaceCount() > need) this.wm.removeLastWorkspace();
        log("_reconcileWorkspaceCount: need " + need + ", had " + have
            + ", now " + this.wm.getWorkspaceCount());
    },

    // ---- Deriving "where am I" --------------------------------------------

    // Ask the WM for the true active flat index, reverse-map to (project,local).
    // This keeps us correct even if the user switched via some external means.
    currentLocation: function () {
        let flat = this.wm.getActiveIndex();
        let loc = Mapping.locationOf(this.state.counts(), flat);
        return loc; // {projectIdx, localIdx} or null
    },

    // ---- Intents: switching projects --------------------------------------

    // Switch to a project, landing on the local workspace we last used there.
    goToProject: function (projectIdx) {
        if (!this.state.setActiveProject(projectIdx)) {
            log("goToProject: invalid project " + projectIdx);
            return false;
        }
        let local = this.state.getLastLocal(projectIdx);
        let p = this.state.getProject(projectIdx);
        if (local > p.wsCount - 1) local = p.wsCount - 1; // clamp defensively
        let flat = Mapping.globalIndex(this.state.counts(), projectIdx, local);
        log("goToProject: project " + projectIdx + " (" + p.name
            + ") -> local " + local + " -> flat " + flat);
        return this.wm.goToWorkspace(flat);
    },

    // Alt-Tab-style flip to the most-recent other project.
    goToPreviousProject: function () {
        return this.goToProject(this.state.previousProjectIdx());
    },

    // Open the active project's Notion page in a NEW browser window, so it
    // lands on the current (home) workspace instead of adding a tab to an
    // existing browser window on some other workspace. Manual by design.
    openActiveProjectHome: function () {
        let p = this.state.activeProject();
        if (!p || !p.notionUrl) {
            log("openActiveProjectHome: no Notion URL for active project");
            return false;
        }
        this._openUrlNewWindow(p.notionUrl);
        log("openActiveProjectHome: opened " + p.notionUrl + " in a new window");
        return true;
    },

    // Cycle to the next/previous project in *project order* (not MRU) — useful
    // as a simple deterministic navigation for testing.
    goToNextProjectInOrder: function () {
        let n = this.state.projectCount();
        if (n === 0) return false;
        return this.goToProject((this.state.activeProjectIdx + 1) % n);
    },

    goToPrevProjectInOrder: function () {
        let n = this.state.projectCount();
        if (n === 0) return false;
        return this.goToProject((this.state.activeProjectIdx + n - 1) % n);
    },

    // ---- Intents: navigating within the active project ---------------------

    _syncLastLocalFromReality: function () {
        let loc = this.currentLocation();
        if (loc) this.state.setLastLocal(loc.projectIdx, loc.localIdx);
    },

    goToLocalWorkspace: function (localIdx) {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p || localIdx < 0 || localIdx > p.wsCount - 1) {
            log("goToLocalWorkspace: local " + localIdx + " out of range for "
                + (p ? p.name : "?"));
            return false;
        }
        let flat = Mapping.globalIndex(this.state.counts(), pIdx, localIdx);
        this.state.setLastLocal(pIdx, localIdx);
        return this.wm.goToWorkspace(flat);
    },

    nextLocalWorkspace: function () {
        let loc = this.currentLocation();
        if (!loc) return false;
        let p = this.state.getProject(loc.projectIdx);
        // At the project's last workspace: grow the strip and land on the new one.
        if (p && loc.localIdx >= p.wsCount - 1) {
            return this.addWorkspaceToActiveProject();
        }
        return this.goToLocalWorkspace(loc.localIdx + 1);
    },

    prevLocalWorkspace: function () {
        let loc = this.currentLocation();
        if (!loc) return false;
        return this.goToLocalWorkspace(loc.localIdx - 1);
    },

    // ---- Intents: moving the focused window --------------------------------

    // Move the focused window to a local workspace within the CURRENT project,
    // then follow it there. Bounds-checked against the active project's strip.
    moveWindowToLocalWorkspace: function (localIdx) {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p || localIdx < 0 || localIdx > p.wsCount - 1) {
            log("moveWindowToLocalWorkspace: local " + localIdx + " out of range");
            return false;
        }
        let flat = Mapping.globalIndex(this.state.counts(), pIdx, localIdx);
        if (this.wm.moveFocusedWindowTo(flat)) {
            this.state.setLastLocal(pIdx, localIdx);
            this.wm.goToWorkspace(flat);
            return true;
        }
        return false;
    },

    moveWindowToNextLocal: function () {
        let loc = this.currentLocation();
        if (!loc) return false;
        let p = this.state.getProject(loc.projectIdx);
        // At the project's last workspace: create a new one, then move the
        // focused window there (and follow it).
        if (p && loc.localIdx >= p.wsCount - 1) {
            let pIdx = this.state.activeProjectIdx;
            this._growActiveProjectStrip();
            return this.moveWindowToLocalWorkspace(this.state.getProject(pIdx).wsCount - 1);
        }
        return this.moveWindowToLocalWorkspace(loc.localIdx + 1);
    },

    moveWindowToPrevLocal: function () {
        let loc = this.currentLocation();
        if (!loc) return false;
        return this.moveWindowToLocalWorkspace(loc.localIdx - 1);
    },

    // Move the focused window to another PROJECT (landing on that project's
    // last-used local workspace), and switch there with it.
    moveWindowToProject: function (projectIdx) {
        let p = this.state.getProject(projectIdx);
        if (!p) {
            log("moveWindowToProject: invalid project " + projectIdx);
            return false;
        }
        let local = this.state.getLastLocal(projectIdx);
        if (local > p.wsCount - 1) local = p.wsCount - 1;
        let flat = Mapping.globalIndex(this.state.counts(), projectIdx, local);
        if (this.wm.moveFocusedWindowTo(flat)) {
            this.state.setActiveProject(projectIdx);
            this.state.setLastLocal(projectIdx, local);
            this.wm.goToWorkspace(flat);
            log("moveWindowToProject: moved window to " + p.name + " local " + local);
            return true;
        }
        return false;
    },

    // Move the focused window to the next/previous project in LIST order
    // (wrapping), following it there.
    moveWindowToNextProjectInOrder: function () {
        let n = this.state.projectCount();
        if (n === 0) return false;
        return this.moveWindowToProject((this.state.activeProjectIdx + 1) % n);
    },

    moveWindowToPrevProjectInOrder: function () {
        let n = this.state.projectCount();
        if (n === 0) return false;
        return this.moveWindowToProject((this.state.activeProjectIdx + n - 1) % n);
    },

    // ---- Intents: adding/removing a workspace to the active project --------

    // Add a workspace at the end of a project's strip. Projects are contiguous
    // partitions, so the new workspace must land at flat index
    // insertAt = offset(P) + count(P). Cinnamon only appends at the very end,
    // so we append there and then rotate the empty slot down into position by
    // shifting each later workspace's windows one index up. This keeps every
    // OTHER project's partition intact (fixes the M2 last-project-only limit).
    // Grow the active project's strip by one workspace WITHOUT navigating.
    // Returns the new last local index, or -1 on failure. Shared by the explicit
    // add action and the auto-create-on-overflow navigation.
    _growActiveProjectStrip: function () {
        let pIdx = this.state.activeProjectIdx;
        let counts = this.state.counts();
        let oldTotal = Mapping.totalWorkspaces(counts);
        let insertAt = Mapping.offsetOf(counts, pIdx) + counts[pIdx];

        // 1) Append a new (empty) workspace at the global end (index oldTotal).
        if (this.wm.createWorkspace() < 0) return -1;

        // 2) Rotate the empty slot from the end down to insertAt: move windows
        //    high -> low so nothing is overwritten.
        for (let i = oldTotal - 1; i >= insertAt; i--) {
            this.wm.moveAllWindows(i, i + 1);
        }

        // 3) Grow the model (count now matches reality; reconcile is a no-op).
        this.state.incWorkspaceCount(pIdx);
        this._reconcileWorkspaceCount();

        log("_growActiveProjectStrip: " + this.state.getProject(pIdx).name
            + " now " + this.state.getProject(pIdx).wsCount
            + " (inserted at flat " + insertAt + ")");
        return this.state.getProject(pIdx).wsCount - 1;
    },

    addWorkspaceToActiveProject: function () {
        let newLocal = this._growActiveProjectStrip();
        if (newLocal < 0) return false;
        return this.goToLocalWorkspace(newLocal);
    },

    // Remove the last workspace of a project's strip. Move its windows into the
    // previous workspace (same project — safe, since we keep >=1 home), then
    // remove that specific flat index. Cinnamon reindexes; other partitions
    // stay intact.
    removeLastWorkspaceOfActiveProject: function () {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p) return false;
        if (p.wsCount <= 1) {
            log("removeLastWorkspaceOfActiveProject: " + p.name
                + " keeps its home workspace (>=1)");
            return false;
        }
        let counts = this.state.counts();
        let removeAt = Mapping.offsetOf(counts, pIdx) + (p.wsCount - 1);

        // Preserve windows: fold them into the previous workspace of the strip.
        this.wm.moveAllWindows(removeAt, removeAt - 1);
        // Remove that exact workspace (not just the global last).
        this.wm.removeWorkspace(removeAt);

        this.state.decWorkspaceCount(pIdx);
        this._reconcileWorkspaceCount();

        // Ensure we're sitting on a valid local workspace of this project.
        let last = this.state.getProject(pIdx).wsCount - 1;
        let loc = this.currentLocation();
        if (!loc || loc.projectIdx !== pIdx || loc.localIdx > last) {
            this.goToLocalWorkspace(last);
        }
        log("removeLastWorkspaceOfActiveProject: " + p.name + " now "
            + this.state.getProject(pIdx).wsCount + " (removed flat " + removeAt + ")");
        return true;
    },

    // On-demand: collapse TRAILING empty workspaces of the active project, from
    // the end inward, stopping at the first workspace that has windows. Never
    // removes the home workspace (local 0) or the one currently focused. Trailing
    // -only keeps indices simple (no mid-partition reshuffling). Returns count.
    removeEmptyWorkspacesOfActiveProject: function () {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p) return 0;
        let activeFlat = this.wm.getActiveIndex();
        let removed = 0;

        // Diagnostic: dump the partition's window counts + active index so we
        // can see exactly why the loop stops.
        let counts0 = this.state.counts();
        let base = Mapping.offsetOf(counts0, pIdx);
        let dump = [];
        for (let l = 0; l < p.wsCount; l++) {
            dump.push("f" + (base + l) + "=" + this.wm.countWindows(base + l) + "w");
        }
        log("removeEmpty: " + p.name + " activeFlat=" + activeFlat
            + " partition[" + dump.join(",") + "]");

        while (this.state.getProject(pIdx).wsCount > 1) {
            let counts = this.state.counts();
            let lastFlat = Mapping.offsetOf(counts, pIdx)
                + (this.state.getProject(pIdx).wsCount - 1);
            let nWin = this.wm.countWindows(lastFlat);
            if (lastFlat === activeFlat) { log("removeEmpty: stop, lastFlat " + lastFlat + " is active"); break; }
            if (nWin > 0) { log("removeEmpty: stop, lastFlat " + lastFlat + " has " + nWin + " windows"); break; }
            this.wm.removeWorkspace(lastFlat);
            this.state.decWorkspaceCount(pIdx);
            removed++;
        }
        if (removed > 0) this._reconcileWorkspaceCount();
        log("removeEmptyWorkspacesOfActiveProject: " + p.name + " removed "
            + removed + ", now " + this.state.getProject(pIdx).wsCount);
        return removed;
    },

    // The user's default browser binary, or null if we can't determine one that
    // we know how to open with --new-window. Cached after first lookup.
    _defaultBrowserBin: function () {
        if (this._browserBin !== undefined) return this._browserBin;
        this._browserBin = null;
        try {
            // xdg-settings returns e.g. "firefox.desktop" / "google-chrome.desktop".
            let [ok, out] = GLib.spawn_command_line_sync("xdg-settings get default-web-browser");
            if (ok && out) {
                let desktop = (out instanceof Uint8Array
                    ? imports.byteArray.toString(out) : String(out)).trim().toLowerCase();
                for (let i = 0; i < BROWSER_BINARIES.length; i++) {
                    if (desktop.indexOf(BROWSER_BINARIES[i].match) !== -1) {
                        this._browserBin = BROWSER_BINARIES[i].bin;
                        break;
                    }
                }
                log("_defaultBrowserBin: default=" + desktop + " -> " + this._browserBin);
            }
        } catch (e) {
            logError("_defaultBrowserBin: " + e.toString());
        }
        return this._browserBin;
    },

    // Open a URL in a new window of the DEFAULT browser on the CURRENT
    // workspace. Falls back to xdg-open (default browser, new tab) if we don't
    // recognize the browser or the launch fails.
    _openUrlNewWindow: function (url) {
        let bin = this._defaultBrowserBin();
        let cmd = bin ? [bin, "--new-window", url] : ["xdg-open", url];
        try {
            Util.spawn(cmd);
        } catch (e) {
            logError("_openUrlNewWindow: spawn failed: " + e.toString() + " — trying xdg-open");
            try { Util.spawn(["xdg-open", url]); } catch (e2) {}
        }
    },

    // ---- M9: live add / remove of whole projects ---------------------------

    // Add a project to the live deck: append its partition at the end of the
    // flat list (safe — no window shifting), grow the model. Stays put; open the
    // project's Notion page manually with the keybinding when you want it.
    addProjectLive: function (def) {
        let idx = this.state.appendProject(def);
        // The new project's single home workspace goes at the global end, which
        // is exactly where Cinnamon appends — so a plain reconcile is correct.
        this._reconcileWorkspaceCount();
        log("addProjectLive: " + def.name + " (index " + idx + ")");
        return idx;
    },

    // Remove a project from the live deck (destructive). Requests a graceful
    // close of every window in the project's partition, waits, then:
    //   - if any window survives -> ABORT (cb receives the surviving windows'
    //     titles); the project stays.
    //   - else -> remove the partition's workspaces and the project from the
    //     model, landing on the MRU-previous project if we removed the active one.
    // cb(err, info): err null on success; err "windows-open" with
    // info.openTitles when aborted.
    removeProjectLive: function (projectIdx, cb) {
        let p = this.state.getProject(projectIdx);
        if (!p) { cb && cb("invalid-project"); return; }

        let counts = this.state.counts();
        let offset = Mapping.offsetOf(counts, projectIdx);
        let indices = [];
        for (let i = 0; i < p.wsCount; i++) indices.push(offset + i);

        // 1) Request graceful close of all windows in this partition.
        let windows = this.wm.listWindowsOnWorkspaces(indices);
        log("removeProjectLive: " + p.name + " has " + windows.length
            + " windows across workspaces [" + indices.join(",") + "]");
        for (let i = 0; i < windows.length; i++) this.wm.requestCloseWindow(windows[i]);

        // 2) After a grace period, recheck.
        Mainloop.timeout_add(CLOSE_GRACE_MS, () => {
            let remaining = this.wm.listWindowsOnWorkspaces(indices);
            if (remaining.length > 0) {
                let titles = remaining.map(function (w) {
                    try { return w.get_title(); } catch (e) { return "(window)"; }
                });
                log("removeProjectLive: ABORT — " + remaining.length + " window(s) still open");
                cb && cb("windows-open", { openTitles: titles });
                return false;
            }

            // 3) All closed — remove the partition's workspaces high->low so
            //    indices stay valid, then remove the project from the model.
            let curCounts = this.state.counts();
            let curOffset = Mapping.offsetOf(curCounts, projectIdx);
            for (let i = p.wsCount - 1; i >= 0; i--) {
                this.wm.removeWorkspace(curOffset + i);
            }
            let wasActive = (this.state.activeProjectIdx === projectIdx);
            // MRU-previous is captured as an OLD index; removeProject() shifts
            // every index above projectIdx down by one, so adjust to match.
            let mruPrev = this.state.previousProjectIdx();
            if (mruPrev > projectIdx) mruPrev -= 1;
            this.state.removeProject(projectIdx);
            this._reconcileWorkspaceCount();

            // 4) If we removed the active project, land on the MRU-previous one
            //    (clamped to a valid index after the reindex).
            if (wasActive && this.state.projectCount() > 0) {
                let target = mruPrev;
                if (target < 0 || target >= this.state.projectCount()) target = 0;
                this.goToProject(target);
            }
            log("removeProjectLive: removed " + p.name);
            cb && cb(null);
            return false;
        });
    },

    // ---- Introspection for logging / future UI -----------------------------

    describe: function () {
        let loc = this.currentLocation();
        let p = this.state.activeProject();
        let where = loc
            ? (this.state.getProject(loc.projectIdx).name + " / local " + loc.localIdx)
            : "(unknown)";
        return "active project=" + (p ? p.name : "?")
            + " | reality=" + where
            + " | flat=" + this.wm.getActiveIndex() + "/" + this.wm.getWorkspaceCount()
            + " | counts=[" + this.state.counts().join(",") + "]"
            + " | mru=[" + this.state.mruOrder().join(",") + "]";
    },

    destroy: function () {
        this.state = null;
        this.wm = null;
    },
};
