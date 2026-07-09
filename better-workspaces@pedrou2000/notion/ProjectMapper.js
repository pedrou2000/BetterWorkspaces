/* notion/ProjectMapper.js — raw Notion pages -> project records; the only file
   that knows the Projects DB schema. Keeps all non-archived projects; the deck
   filters to inWorkspace. */

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("mapper");

const TITLE_PROP = "Project";
const WORKSPACE_PROP = "Workspace";
const ARCHIVE_PROP = "Archive";
const ORDER_PROP = "Workspace Order";

function buildQueryBody() {
    return {
        page_size: 100,
        filter: {
            and: [{ property: ARCHIVE_PROP, checkbox: { equals: false } }],
        },
        sorts: [{ property: TITLE_PROP, direction: "ascending" }],
    };
}

function _plainTitle(page) {
    try {
        const prop = page.properties[TITLE_PROP];
        if (!prop || !prop.title) return "(untitled)";
        return (
            prop.title
                .map(function (t) {
                    return t.plain_text;
                })
                .join("") || "(untitled)"
        );
    } catch (e) {
        return "(untitled)";
    }
}

function _checkbox(page, propName) {
    try {
        const prop = page.properties[propName];
        return !!(prop && prop.checkbox === true);
    } catch (e) {
        return false;
    }
}

function _number(page, propName) {
    try {
        const prop = page.properties[propName];
        if (prop && prop.type === "number" && prop.number !== null && prop.number !== undefined) {
            return prop.number;
        }
    } catch (e) {}
    return null;
}

// Either Notion's page-level archive or our own Archive checkbox.
function _isArchived(page) {
    if (page.archived === true) return true;
    return _checkbox(page, ARCHIVE_PROP);
}

function _wantsWorkspace(page) {
    return _checkbox(page, WORKSPACE_PROP);
}

// Normalize to {type:"emoji"|"url", value} | null.
function _icon(page) {
    try {
        const ic = page.icon;
        if (!ic) return null;
        if (ic.type === "emoji" && ic.emoji) return { type: "emoji", value: ic.emoji };
        if (ic.type === "external" && ic.external) return { type: "url", value: ic.external.url };
        if (ic.type === "file" && ic.file) return { type: "url", value: ic.file.url };
        if (ic.type === "custom_emoji" && ic.custom_emoji) {
            return { type: "url", value: ic.custom_emoji.url };
        }
        // Built-in gallery icon {name,color} -> predictable SVG URL, e.g.
        // brain+blue -> /icons/brain_blue.svg.
        if (ic.type === "icon" && ic.icon && ic.icon.name) {
            const color = ic.icon.color || "gray";
            return {
                type: "url",
                value: "https://www.notion.so/icons/" + ic.icon.name + "_" + color + ".svg",
            };
        }
    } catch (e) {
        L.error("_icon: " + e.toString());
    }
    return null;
}

function mapPage(page) {
    if (_isArchived(page)) return null;

    return {
        id: page.id,
        name: _plainTitle(page),
        icon: _icon(page),
        notionUrl: page.url || null,
        inWorkspace: _wantsWorkspace(page),
        order: _number(page, ORDER_PROP),
    };
}

// Ascending Workspace Order; unset orders sort last, tie-broken by title.
function sortByOrder(projects) {
    return projects.slice().sort(function (a, b) {
        const ao = a.order === null || a.order === undefined ? Infinity : a.order;
        const bo = b.order === null || b.order === undefined ? Infinity : b.order;
        if (ao !== bo) return ao - bo;
        return (a.name || "").localeCompare(b.name || "");
    });
}

function mapResults(result) {
    if (!result || !result.results) return [];
    let out = [];
    for (let i = 0; i < result.results.length; i++) {
        const p = mapPage(result.results[i]);
        if (p) out.push(p);
    }
    out = sortByOrder(out);
    L.log("mapResults: " + result.results.length + " pages -> " + out.length + " projects kept");
    return out;
}

var ProjectMapper = {
    buildQueryBody: buildQueryBody,
    mapPage: mapPage,
    mapResults: mapResults,
    sortByOrder: sortByOrder,
    TITLE_PROP: TITLE_PROP,
    WORKSPACE_PROP: WORKSPACE_PROP,
    ARCHIVE_PROP: ARCHIVE_PROP,
    ORDER_PROP: ORDER_PROP,
};
