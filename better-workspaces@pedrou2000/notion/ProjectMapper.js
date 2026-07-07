/*
 * BetterWorkspaces — notion/ProjectMapper.js
 *
 * Turns raw Notion pages into our domain object and owns ALL schema knowledge
 * (Design Doc §3.A). If the Notion schema changes, only this file changes.
 *
 * Projects DB schema:
 *   - title property:      "Project"
 *   - workspace (checkbox):"Workspace"  <- decides if a project appears here
 *   - archive (checkbox):  "Archive"
 *   - icon:                page-level "icon" (emoji | external | file |
 *                          custom_emoji | built-in {name,color})
 *
 * We cache ALL non-archived projects, each tagged with `inWorkspace` (its
 * Workspace checkbox). The DECK is derived downstream by filtering to
 * inWorkspace=true; the Project Toggle Panel (M9) shows the full list.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("mapper");

const TITLE_PROP = "Project";
const WORKSPACE_PROP = "Workspace";
const ARCHIVE_PROP = "Archive";

// Notion API query body: fetch all non-archived projects (we tag each with its
// Workspace flag in the mapper rather than filtering it out server-side).
function buildQueryBody() {
    return {
        page_size: 100,
        filter: {
            and: [
                { property: ARCHIVE_PROP, checkbox: { equals: false } },
            ],
        },
        sorts: [
            { property: TITLE_PROP, direction: "ascending" },
        ],
    };
}

function _plainTitle(page) {
    try {
        let prop = page.properties[TITLE_PROP];
        if (!prop || !prop.title) return "(untitled)";
        return prop.title.map(function (t) { return t.plain_text; }).join("") || "(untitled)";
    } catch (e) {
        return "(untitled)";
    }
}

function _checkbox(page, propName) {
    try {
        let prop = page.properties[propName];
        return !!(prop && prop.checkbox === true);
    } catch (e) { return false; }
}

function _isArchived(page) {
    // Page-level archived flag OR our Archive checkbox = true.
    if (page.archived === true) return true;
    return _checkbox(page, ARCHIVE_PROP);
}

function _wantsWorkspace(page) {
    return _checkbox(page, WORKSPACE_PROP);
}

// Extract the icon into a normalized shape:
//   { type: "emoji", value: "🗂️" }
//   { type: "url",   value: "https://..." }
//   null
function _icon(page) {
    try {
        let ic = page.icon;
        if (!ic) return null;
        if (ic.type === "emoji" && ic.emoji) return { type: "emoji", value: ic.emoji };
        if (ic.type === "external" && ic.external) return { type: "url", value: ic.external.url };
        if (ic.type === "file" && ic.file) return { type: "url", value: ic.file.url };
        // Notion "custom_emoji" (uploaded emoji) carries an image URL.
        if (ic.type === "custom_emoji" && ic.custom_emoji)
            return { type: "url", value: ic.custom_emoji.url };
        // Notion built-in gallery icon: {name, color}. Served as SVGs at a
        // predictable URL, e.g. brain+blue -> /icons/brain_blue.svg.
        if (ic.type === "icon" && ic.icon && ic.icon.name) {
            let color = ic.icon.color || "gray";
            return {
                type: "url",
                value: "https://www.notion.so/icons/" + ic.icon.name + "_" + color + ".svg",
            };
        }
    } catch (e) { L.error("_icon: " + e.toString()); }
    return null;
}

// Map one raw page -> Project{} or null. We keep every non-archived project and
// record its Workspace checkbox as `inWorkspace`; the deck is derived downstream.
function mapPage(page) {
    if (_isArchived(page)) return null;

    return {
        id: page.id,
        name: _plainTitle(page),
        icon: _icon(page),
        notionUrl: page.url || null,
        inWorkspace: _wantsWorkspace(page),
    };
}

// Map a full query result -> array of Project{}.
function mapResults(result) {
    if (!result || !result.results) return [];
    let out = [];
    for (let i = 0; i < result.results.length; i++) {
        let p = mapPage(result.results[i]);
        if (p) out.push(p);
    }
    L.log("mapResults: " + result.results.length + " pages -> " + out.length + " projects kept");
    return out;
}

var ProjectMapper = {
    buildQueryBody: buildQueryBody,
    mapPage: mapPage,
    mapResults: mapResults,
    // exported for reference/testing
    TITLE_PROP: TITLE_PROP,
    WORKSPACE_PROP: WORKSPACE_PROP,
    ARCHIVE_PROP: ARCHIVE_PROP,
};
