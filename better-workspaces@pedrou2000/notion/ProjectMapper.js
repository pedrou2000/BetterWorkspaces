/*
 * BetterWorkspaces — notion/ProjectMapper.js
 *
 * Turns raw Notion pages into our domain object and owns ALL schema knowledge
 * (Design Doc §3.A). If the Notion schema changes, only this file changes.
 *
 * Projects DB schema (as of M4):
 *   - title property:    "Project"
 *   - priority (select): "Current Priority"  options: Top/High/Medium/Low/Vey Low
 *   - archive (checkbox):"Archive"
 *   - icon:              page-level "icon" (emoji | external | file)
 *
 * Filter (UX doc §4): keep projects that are NOT archived AND whose priority is
 * NOT low-ish. We match "low" case-insensitively so both "Low" and the literal
 * Notion typo "Vey Low" are excluded, future-proof against fixing the typo.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("mapper");

const TITLE_PROP = "Project";
const PRIORITY_PROP = "Current Priority";
const ARCHIVE_PROP = "Archive";

// Notion API query body implementing the filter server-side where possible.
// (We also re-check client-side in map(), so this is an optimization.)
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

function _priorityName(page) {
    try {
        let prop = page.properties[PRIORITY_PROP];
        if (prop && prop.select && prop.select.name) return prop.select.name;
    } catch (e) {}
    return null;
}

function _isArchived(page) {
    // Page-level archived flag OR our Archive checkbox = true.
    if (page.archived === true) return true;
    try {
        let prop = page.properties[ARCHIVE_PROP];
        if (prop && prop.checkbox === true) return true;
    } catch (e) {}
    return false;
}

// Extract the icon into a normalized shape:
//   { type: "emoji", value: "🗂️" }
//   { type: "url",   value: "https://..." }   (external or uploaded file)
//   null
function _icon(page) {
    try {
        let ic = page.icon;
        if (!ic) return null;
        if (ic.type === "emoji") return { type: "emoji", value: ic.emoji };
        if (ic.type === "external" && ic.external) return { type: "url", value: ic.external.url };
        if (ic.type === "file" && ic.file) return { type: "url", value: ic.file.url };
    } catch (e) {}
    return null;
}

// Priority is "low-ish" if its name contains "low" (case-insensitive).
function _isLowPriority(name) {
    if (!name) return false; // no priority set -> not explicitly low -> keep
    return name.toLowerCase().indexOf("low") !== -1;
}

// Map one raw page -> Project{} or null if it should be filtered out.
function mapPage(page) {
    if (_isArchived(page)) return null;
    let priority = _priorityName(page);
    if (_isLowPriority(priority)) return null;

    return {
        id: page.id,
        name: _plainTitle(page),
        priority: priority,
        icon: _icon(page),
        notionUrl: page.url || null,
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
    PRIORITY_PROP: PRIORITY_PROP,
    ARCHIVE_PROP: ARCHIVE_PROP,
};
