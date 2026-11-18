"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

const ProjectMapper = loadGjsModule("notion/ProjectMapper.js", "ProjectMapper");

// Build a fake Notion page with our schema. opts: name, workspace, archive,
// pageArchived, order, icon, url.
function page(id, opts) {
    opts = opts || {};
    const properties = {
        [ProjectMapper.TITLE_PROP]: {
            title:
                opts.name === undefined
                    ? [{ plain_text: id }]
                    : opts.name === null
                      ? []
                      : [{ plain_text: opts.name }],
        },
        [ProjectMapper.WORKSPACE_PROP]: { checkbox: !!opts.workspace },
        [ProjectMapper.ARCHIVE_PROP]: { checkbox: !!opts.archive },
    };
    if (opts.order !== undefined) {
        properties[ProjectMapper.ORDER_PROP] = { type: "number", number: opts.order };
    }
    return {
        id: id,
        url: opts.url !== undefined ? opts.url : "https://notion.so/" + id,
        archived: !!opts.pageArchived,
        icon: opts.icon || null,
        properties: properties,
    };
}

// mapPage

test("mapPage maps the basic fields", () => {
    const p = ProjectMapper.mapPage(page("p1", { name: "Web App", workspace: true, order: 2 }));
    assert.deepEqual(p, {
        id: "p1",
        name: "Web App",
        icon: null,
        notionUrl: "https://notion.so/p1",
        inWorkspace: true,
        order: 2,
        priority: null,
    });
});

test("mapPage drops archived pages (checkbox or page-level flag)", () => {
    assert.equal(ProjectMapper.mapPage(page("p1", { archive: true })), null);
    assert.equal(ProjectMapper.mapPage(page("p2", { pageArchived: true })), null);
});

test("mapPage keeps non-workspace projects, tagged inWorkspace=false", () => {
    const p = ProjectMapper.mapPage(page("p1", { workspace: false }));
    assert.notEqual(p, null);
    assert.equal(p.inWorkspace, false);
});

test("mapPage title fallbacks", () => {
    assert.equal(ProjectMapper.mapPage(page("p1", { name: null })).name, "(untitled)");
    const noTitle = page("p2", {});
    delete noTitle.properties[ProjectMapper.TITLE_PROP];
    assert.equal(ProjectMapper.mapPage(noTitle).name, "(untitled)");
});

test("mapPage multi-segment titles are joined", () => {
    const pg = page("p1", {});
    pg.properties[ProjectMapper.TITLE_PROP].title = [
        { plain_text: "Job " },
        { plain_text: "2026" },
    ];
    assert.equal(ProjectMapper.mapPage(pg).name, "Job 2026");
});

test("mapPage order is null when the property is unset", () => {
    const p = ProjectMapper.mapPage(page("p1", {}));
    assert.equal(p.order, null);
    const withNull = ProjectMapper.mapPage(page("p2", { order: null }));
    assert.equal(withNull.order, null);
});

test("mapPage order 0 survives (not treated as falsy)", () => {
    assert.equal(ProjectMapper.mapPage(page("p1", { order: 0 })).order, 0);
});

test("mapPage missing url becomes null", () => {
    assert.equal(ProjectMapper.mapPage(page("p1", { url: null })).notionUrl, null);
});

// icons

test("mapPage emoji icon", () => {
    const p = ProjectMapper.mapPage(page("p1", { icon: { type: "emoji", emoji: "🗂️" } }));
    assert.deepEqual(p.icon, { type: "emoji", value: "🗂️" });
});

test("mapPage external / file / custom_emoji icons normalize to url", () => {
    const ext = ProjectMapper.mapPage(
        page("p1", {
            icon: { type: "external", external: { url: "https://x/e.png" } },
        }),
    );
    assert.deepEqual(ext.icon, { type: "url", value: "https://x/e.png" });

    const file = ProjectMapper.mapPage(
        page("p2", {
            icon: { type: "file", file: { url: "https://x/f.png" } },
        }),
    );
    assert.deepEqual(file.icon, { type: "url", value: "https://x/f.png" });

    const custom = ProjectMapper.mapPage(
        page("p3", {
            icon: { type: "custom_emoji", custom_emoji: { url: "https://x/c.png" } },
        }),
    );
    assert.deepEqual(custom.icon, { type: "url", value: "https://x/c.png" });
});

test("mapPage built-in gallery icon becomes the predictable SVG url", () => {
    const p = ProjectMapper.mapPage(
        page("p1", {
            icon: { type: "icon", icon: { name: "brain", color: "blue" } },
        }),
    );
    assert.deepEqual(p.icon, { type: "url", value: "https://www.notion.so/icons/brain_blue.svg" });
    // Color defaults to gray.
    const noColor = ProjectMapper.mapPage(
        page("p2", {
            icon: { type: "icon", icon: { name: "brain" } },
        }),
    );
    assert.equal(noColor.icon.value, "https://www.notion.so/icons/brain_gray.svg");
});

test("mapPage unknown or missing icon becomes null", () => {
    assert.equal(ProjectMapper.mapPage(page("p1", { icon: { type: "mystery" } })).icon, null);
    assert.equal(ProjectMapper.mapPage(page("p2", {})).icon, null);
});

// sortByOrder

test("sortByOrder: ascending order, nulls last, title tie-break; input untouched", () => {
    const input = [
        { id: "d", name: "Delta", order: null },
        { id: "b", name: "Bravo", order: 1 },
        { id: "a", name: "Alpha", order: null },
        { id: "c", name: "Charlie", order: 0 },
    ];
    const snapshot = input.map((p) => p.id);
    const sorted = ProjectMapper.sortByOrder(input);
    assert.deepEqual(
        sorted.map((p) => p.id),
        ["c", "b", "a", "d"],
    );
    assert.deepEqual(
        input.map((p) => p.id),
        snapshot,
    ); // non-mutating
});

test("sortByOrder ties on the same order break by title", () => {
    const sorted = ProjectMapper.sortByOrder([
        { id: "b", name: "Bravo", order: 1 },
        { id: "a", name: "Alpha", order: 1 },
    ]);
    assert.deepEqual(
        sorted.map((p) => p.id),
        ["a", "b"],
    );
});

// mapResults

test("mapResults filters archived and sorts by order", () => {
    const result = {
        results: [
            page("p1", { name: "Zulu", order: 1 }),
            page("p2", { name: "Kilo", archive: true }),
            page("p3", { name: "Alpha" }), // no order -> last
            page("p4", { name: "Mike", order: 0 }),
        ],
    };
    const projects = ProjectMapper.mapResults(result);
    assert.deepEqual(
        projects.map((p) => p.name),
        ["Mike", "Zulu", "Alpha"],
    );
});

test("mapResults tolerates empty or malformed results", () => {
    assert.deepEqual(ProjectMapper.mapResults(null), []);
    assert.deepEqual(ProjectMapper.mapResults({}), []);
    assert.deepEqual(ProjectMapper.mapResults({ results: [] }), []);
});

// buildQueryBody

test("buildQueryBody filters out archived and requests up to 100 pages", () => {
    const body = ProjectMapper.buildQueryBody();
    assert.equal(body.page_size, 100);
    assert.deepEqual(body.filter.and, [
        { property: ProjectMapper.ARCHIVE_PROP, checkbox: { equals: false } },
    ]);
});

// creating projects

test("buildCreateBody for a top-level project sets only title, Workspace and order", () => {
    assert.deepEqual(ProjectMapper.buildCreateBody({ databaseId: "db", name: "X", order: 0 }), {
        parent: { database_id: "db" },
        properties: {
            Project: { title: [{ text: { content: "X" } }] },
            Workspace: { checkbox: true },
            "Workspace Order": { number: 0 },
        },
    });
});

test("buildCreateBody for a sub-project adds Parent and only the non-empty inherited values", () => {
    const body = ProjectMapper.buildCreateBody({
        databaseId: "db",
        name: "Child",
        order: 3,
        parentId: "p1",
        inherited: { type: "Job", relations: { Areas: ["a1"], "Lifetime Periods": [] } },
    });
    assert.deepEqual(body.properties.Parent, { relation: [{ id: "p1" }] });
    assert.deepEqual(body.properties.Type, { select: { name: "Job" } });
    assert.deepEqual(body.properties.Areas, { relation: [{ id: "a1" }] });
    assert.equal("Lifetime Periods" in body.properties, false);
});

test("buildCreateBody ignores inherited values when there is no parent", () => {
    const body = ProjectMapper.buildCreateBody({
        databaseId: "db",
        name: "X",
        order: 1,
        inherited: { type: "Job", relations: { Areas: ["a1"] } },
    });
    assert.deepEqual(Object.keys(body.properties).sort(), [
        "Project",
        "Workspace",
        "Workspace Order",
    ]);
});

test("inheritedFrom reads Type and the inherited relations, tolerating missing ones", () => {
    const inherited = ProjectMapper.inheritedFrom({
        properties: {
            Type: { select: { name: "Studies" } },
            Areas: { relation: [{ id: "a1" }, { id: "a2" }], has_more: false },
        },
    });
    assert.equal(inherited.type, "Studies");
    assert.deepEqual(Array.from(inherited.relations.Areas), ["a1", "a2"]);
    assert.deepEqual(Array.from(inherited.relations["Lifetime Periods"]), []);
    assert.equal(inherited.truncated, false);

    const empty = ProjectMapper.inheritedFrom({});
    assert.equal(empty.type, null);
    assert.deepEqual(Array.from(empty.relations.Areas), []);
});

// priority

function withPriority(id, name, priority) {
    const pg = page(id, { name: name });
    pg.properties[ProjectMapper.PRIORITY_PROP] = { select: priority ? { name: priority } : null };
    return pg;
}

test("mapPage reads the Current Priority option's name, or null when unset or absent", () => {
    assert.equal(ProjectMapper.mapPage(withPriority("a", "A", "High")).priority, "High");
    assert.equal(ProjectMapper.mapPage(withPriority("b", "B", null)).priority, null);
    assert.equal(ProjectMapper.mapPage(page("c")).priority, null);
});

test("sortByPriority: highest first, the database's own order, unset last, title tie-break", () => {
    const input = [
        { name: "Zeta", priority: "Low" },
        { name: "None B", priority: null },
        { name: "Alpha", priority: "Vey Low" },
        { name: "Mid", priority: "Medium" },
        { name: "Top 2", priority: "Top" },
        { name: "None A" }, // a cache written before priorities were read
        { name: "Hi", priority: "High" },
        { name: "Top 1", priority: "Top" },
        { name: "Odd", priority: "Someday" }, // an option added later in Notion
    ];
    const names = ProjectMapper.sortByPriority(input).map((p) => p.name);
    assert.deepEqual(names, [
        "Top 1",
        "Top 2",
        "Hi",
        "Mid",
        "Zeta",
        "Alpha",
        "None A",
        "None B",
        "Odd",
    ]);
    assert.equal(input[0].name, "Zeta"); // input untouched
});

test("buildQueryBody asks for the next page only when given a cursor", () => {
    assert.equal("start_cursor" in ProjectMapper.buildQueryBody(), false);
    assert.equal(ProjectMapper.buildQueryBody("abc").start_cursor, "abc");
});
