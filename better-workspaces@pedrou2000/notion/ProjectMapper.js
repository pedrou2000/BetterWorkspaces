/* notion/ProjectMapper.js — raw Notion pages -> project records; the only file
   that knows the Projects DB schema. Keeps all non-archived projects; the deck
   filters to inWorkspace. */

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("mapper");

const TITLE_PROP = "Project";
const WORKSPACE_PROP = "Workspace";
const ARCHIVE_PROP = "Archive";
const ORDER_PROP = "Workspace Order";
const PARENT_PROP = "Parent";
const PRIORITY_PROP = "Current Priority";
// Highest first, as the options are ordered in the Projects database (including
// its "Vey Low" spelling; "Very Low" is accepted in case that gets fixed).
// A page object carries only the chosen option's name, not the options' order.
const PRIORITY_ORDER = ["Top", "High", "Medium", "Low", "Vey Low", "Very Low"];
const TYPE_PROP = "Type";
// What a sub-project copies from its parent, mirroring the Projects database's
// own "Create Sub-Project" button: Type, and these relations.
const INHERITED_RELATIONS = ["Areas", "Lifetime Periods"];

// One page of the query; pass the previous page's next_cursor for the next one.
function buildQueryBody(startCursor) {
    const body = {
        page_size: 100,
        filter: {
            and: [{ property: ARCHIVE_PROP, checkbox: { equals: false } }],
        },
        sorts: [{ property: TITLE_PROP, direction: "ascending" }],
    };
    if (startCursor) body.start_cursor = startCursor;
    return body;
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

// The chosen option's name of a select property, or null.
function _select(page, propName) {
    try {
        const prop = page.properties[propName];
        return prop && prop.select && prop.select.name ? prop.select.name : null;
    } catch (e) {
        return null;
    }
}

// Notion's page-level archive / trash, or our own Archive checkbox.
function _isArchived(page) {
    if (page.archived === true || page.in_trash === true) return true;
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

// What a new sub-project of `parentPage` inherits: {type, relations:{name:[ids]},
// truncated}. A relation only lists pages our integration can see, so a parent's
// Areas come back empty unless that database is shared with it; `truncated` is
// set when Notion had more than it returned inline (25 per relation).
function inheritedFrom(parentPage) {
    const props = (parentPage && parentPage.properties) || {};
    const out = { type: null, relations: {}, truncated: false };
    const type = props[TYPE_PROP];
    if (type && type.select && type.select.name) out.type = type.select.name;
    for (let i = 0; i < INHERITED_RELATIONS.length; i++) {
        const name = INHERITED_RELATIONS[i];
        const rel = props[name];
        const ids = [];
        if (rel && Array.isArray(rel.relation)) {
            for (let k = 0; k < rel.relation.length; k++) {
                if (rel.relation[k] && rel.relation[k].id) ids.push(rel.relation[k].id);
            }
            if (rel.has_more) out.truncated = true;
        }
        out.relations[name] = ids;
    }
    return out;
}

// The POST /pages body for a new project: on the deck from the start (Workspace
// ticked, at `order`), and for a sub-project its Parent plus what it inherits.
// Everything else is left for the user to fill in in Notion.
function buildCreateBody(opts) {
    const props = {};
    props[TITLE_PROP] = { title: [{ text: { content: opts.name } }] };
    props[WORKSPACE_PROP] = { checkbox: true };
    props[ORDER_PROP] = { number: opts.order };
    if (opts.parentId) {
        props[PARENT_PROP] = { relation: [{ id: opts.parentId }] };
        const inherited = opts.inherited || { type: null, relations: {} };
        if (inherited.type) props[TYPE_PROP] = { select: { name: inherited.type } };
        for (let i = 0; i < INHERITED_RELATIONS.length; i++) {
            const name = INHERITED_RELATIONS[i];
            const ids = (inherited.relations || {})[name] || [];
            if (ids.length > 0) {
                props[name] = {
                    relation: ids.map(function (id) {
                        return { id: id };
                    }),
                };
            }
        }
    }
    return { parent: { database_id: opts.databaseId }, properties: props };
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
        priority: _select(page, PRIORITY_PROP),
    };
}

// Position of a priority name, highest first; unknown or unset sorts last.
function _priorityRank(name) {
    const i = PRIORITY_ORDER.indexOf(name);
    return i === -1 ? PRIORITY_ORDER.length : i;
}

// Highest priority first; no priority last; ties broken by title.
function sortByPriority(projects) {
    return projects.slice().sort(function (a, b) {
        const d = _priorityRank(a.priority) - _priorityRank(b.priority);
        if (d !== 0) return d;
        return (a.name || "").localeCompare(b.name || "");
    });
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
    inheritedFrom: inheritedFrom,
    buildCreateBody: buildCreateBody,
    INHERITED_RELATIONS: INHERITED_RELATIONS,
    PARENT_PROP: PARENT_PROP,
    TYPE_PROP: TYPE_PROP,
    mapResults: mapResults,
    sortByOrder: sortByOrder,
    sortByPriority: sortByPriority,
    PRIORITY_PROP: PRIORITY_PROP,
    TITLE_PROP: TITLE_PROP,
    WORKSPACE_PROP: WORKSPACE_PROP,
    ARCHIVE_PROP: ARCHIVE_PROP,
    ORDER_PROP: ORDER_PROP,
};
