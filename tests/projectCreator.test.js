"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

const ProjectMapper = loadGjsModule("notion/ProjectMapper.js", "ProjectMapper");
const ProjectCreator = loadGjsModule("core/ProjectCreator.js", "ProjectCreator");

const DB = "db-1";

// The page Notion returns for a create: the request's properties, plus an id.
function pageFor(body, id) {
    const props = JSON.parse(JSON.stringify(body.properties));
    props[ProjectMapper.TITLE_PROP] = {
        title: [{ plain_text: props[ProjectMapper.TITLE_PROP].title[0].text.content }],
    };
    props[ProjectMapper.ORDER_PROP].type = "number";
    return { id: id, url: "https://notion.so/" + id, icon: null, properties: props };
}

function httpError(status, message) {
    const e = new Error("http-" + status);
    e.status = status;
    e.notionMessage = message || null;
    return e;
}

// opts.create / opts.getPage: (arg) => page | throws. Records every call.
function makeStack(opts) {
    opts = opts || {};
    const calls = { create: [], getPage: [], adopted: [] };
    const notion = {
        getDatabaseId: () => (opts.databaseId === undefined ? DB : opts.databaseId),
        async getProjectPage(id) {
            calls.getPage.push(id);
            return opts.getPage ? opts.getPage(id) : { id: id, properties: {} };
        },
        async createProject(body) {
            calls.create.push(body);
            return opts.create ? opts.create(body) : pageFor(body, "new-" + calls.create.length);
        },
    };
    const store = { maxOrder: () => (opts.maxOrder === undefined ? 4 : opts.maxOrder) };
    const deck = { adoptCreated: (p) => calls.adopted.push(p) };
    const creator = new ProjectCreator({ notion, mapper: ProjectMapper, store, deck });
    return { creator, calls };
}

const PARENT_PAGE = {
    id: "parent-1",
    properties: {
        Type: { type: "select", select: { name: "Personal" } },
        Areas: {
            type: "relation",
            relation: [{ id: "area-1" }, { id: "area-2" }],
            has_more: false,
        },
        "Lifetime Periods": { type: "relation", relation: [{ id: "period-1" }], has_more: false },
    },
};

// create: top-level

test("a top-level project is created ON at the end of the deck, with nothing else set", async () => {
    const { creator, calls } = makeStack({ maxOrder: 4 });
    const project = await creator.create({ name: "  New Thing  " });

    assert.equal(calls.create.length, 1);
    assert.deepEqual(calls.create[0], {
        parent: { database_id: DB },
        properties: {
            Project: { title: [{ text: { content: "New Thing" } }] },
            Workspace: { checkbox: true },
            "Workspace Order": { number: 5 },
        },
    });
    assert.equal(project.name, "New Thing");
    assert.equal(project.inWorkspace, true);
    assert.equal(project.order, 5);
    assert.deepEqual(calls.adopted, [project]); // local state comes from Notion's reply
});

// create: sub-project

test("a sub-project gets Parent plus exactly what describeParent reported", async () => {
    const { creator, calls } = makeStack({ getPage: () => PARENT_PAGE });
    const inherited = await creator.describeParent("parent-1");
    assert.deepEqual(JSON.parse(JSON.stringify(inherited)), {
        type: "Personal",
        relations: { Areas: ["area-1", "area-2"], "Lifetime Periods": ["period-1"] },
        truncated: false,
    });

    await creator.create({ name: "Child", parentId: "parent-1", inherited });
    const props = calls.create[0].properties;
    assert.deepEqual(props.Parent, { relation: [{ id: "parent-1" }] });
    assert.deepEqual(props.Type, { select: { name: "Personal" } });
    assert.deepEqual(props.Areas, { relation: [{ id: "area-1" }, { id: "area-2" }] });
    assert.deepEqual(props["Lifetime Periods"], { relation: [{ id: "period-1" }] });
});

test("a parent with nothing visible to inherit yields a sub-project with only Parent", async () => {
    const { creator, calls } = makeStack({
        getPage: () => ({
            id: "p",
            properties: { Areas: { relation: [] }, Type: { select: null } },
        }),
    });
    const inherited = await creator.describeParent("p");
    await creator.create({ name: "Child", parentId: "p", inherited });
    assert.deepEqual(Object.keys(calls.create[0].properties).sort(), [
        "Parent",
        "Project",
        "Workspace",
        "Workspace Order",
    ]);
});

test("describeParent flags a relation Notion truncated", async () => {
    const { creator } = makeStack({
        getPage: () => ({
            id: "p",
            properties: { Areas: { relation: [{ id: "a" }], has_more: true } },
        }),
    });
    assert.equal((await creator.describeParent("p")).truncated, true);
});

test("an unreadable parent fails before anything is sent", async () => {
    const { creator, calls } = makeStack({
        getPage: () => {
            throw new Error("network down");
        },
    });
    await assert.rejects(
        () => creator.describeParent("p"),
        (e) => e.kind === "parent-unreadable",
    );
    assert.equal(calls.create.length, 0);
});

// validation: nothing leaves the machine

test("an empty name or a missing database id sends nothing", async () => {
    const a = makeStack();
    await assert.rejects(
        () => a.creator.create({ name: "   " }),
        (e) => e.kind === "invalid-name",
    );
    const b = makeStack({ databaseId: "" });
    await assert.rejects(
        () => b.creator.create({ name: "X" }),
        (e) => e.kind === "not-configured",
    );
    assert.equal(a.calls.create.length + b.calls.create.length, 0);
});

// failures: exactly one POST, and no local change

test("a refusal from Notion (4xx) means nothing was created and nothing changes locally", async () => {
    const { creator, calls } = makeStack({
        create: () => {
            throw httpError(400, "Type is not a valid option");
        },
    });
    await assert.rejects(
        () => creator.create({ name: "X" }),
        (e) => e.kind === "refused" && /Type is not a valid option/.test(e.userMessage),
    );
    assert.equal(calls.create.length, 1); // not retried
    assert.equal(calls.adopted.length, 0);
});

test("a permission error is reported as such", async () => {
    for (const status of [401, 403]) {
        const { creator } = makeStack({
            create: () => {
                throw httpError(status);
            },
        });
        await assert.rejects(
            () => creator.create({ name: "X" }),
            (e) => e.kind === "permission",
        );
    }
});

test("no answer, a server error or a conflict is 'unclear': one POST, never retried", async () => {
    const outcomes = [
        new Error("Socket I/O timed out"),
        httpError(500),
        httpError(502),
        httpError(409),
    ];
    for (const failure of outcomes) {
        const { creator, calls } = makeStack({
            create: () => {
                throw failure;
            },
        });
        await assert.rejects(
            () => creator.create({ name: "X" }),
            (e) => e.kind === "unclear",
            String(failure.message),
        );
        assert.equal(calls.create.length, 1, String(failure.message));
        assert.equal(calls.adopted.length, 0);
    }
});

test("a reply that isn't a usable project is 'unclear', not adopted", async () => {
    const { creator, calls } = makeStack({ create: () => ({ id: "x", archived: true }) });
    await assert.rejects(
        () => creator.create({ name: "X" }),
        (e) => e.kind === "unclear",
    );
    assert.equal(calls.adopted.length, 0);
});

// one at a time

test("a second create while one is in flight is refused without a second POST", async () => {
    // Only the first POST is held open; later ones answer at once.
    let release = null;
    const { creator, calls } = makeStack({
        create: (body) =>
            release
                ? pageFor(body, "later")
                : new Promise((resolve) => (release = () => resolve(pageFor(body, "n1")))),
    });
    const first = creator.create({ name: "First" });
    await assert.rejects(
        () => creator.create({ name: "Second" }),
        (e) => e.kind === "busy",
    );
    release();
    await first;
    assert.equal(calls.create.length, 1);

    await creator.create({ name: "Third" }); // and it frees up afterwards
    assert.equal(calls.create.length, 2);
});

// summarize (the line the dialog shows before the user confirms)

test("summarize lists what will be copied", () => {
    assert.equal(
        ProjectCreator.summarize({
            type: "Personal",
            relations: { Areas: ["a", "b"], "Lifetime Periods": ["p"] },
            truncated: false,
        }),
        "Copies from the parent — Type: Personal · Areas: 2 · Lifetime Periods: 1.",
    );
});

test("summarize says so when relations aren't visible, or nothing is copied", () => {
    assert.equal(
        ProjectCreator.summarize({
            type: "Job",
            relations: { Areas: [], "Lifetime Periods": [] },
            truncated: false,
        }),
        "Copies from the parent — Type: Job. Areas and Lifetime Periods: " +
            "none visible to the applet's Notion connection, so none will be copied.",
    );
    assert.match(
        ProjectCreator.summarize({ type: null, relations: { Areas: [] }, truncated: false }),
        /^Copies nothing from the parent besides the link to it\./,
    );
    assert.match(
        ProjectCreator.summarize({ type: null, relations: { Areas: ["a"] }, truncated: true }),
        /cut at 25 entries\.$/,
    );
});
