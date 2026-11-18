/* core/ProjectCreator.js — create a project (or sub-project) in Notion, carefully. */

// Creating a page is the one write that cannot be undone from here and is not
// idempotent, so the rules are strict:
//   - One POST per create() and never an automatic retry. When the outcome is
//     unknown (no answer, a server error) we say so rather than send again: the
//     page may exist, and a second POST would duplicate it. The next sync shows.
//   - The local catalog and deck change only from the page Notion returned,
//     never from what we meant to create.
//   - A sub-project gets exactly what describeParent() reported, which the
//     caller reads before the user confirms.
// Collaborators are injected, so this has no GJS dependency.

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("creator");

// kind: "invalid-name" | "not-configured" | "busy" | "parent-unreadable"
//     | "permission" | "refused" | "unclear"
// Only "unclear" can have left a page behind in Notion.
function _fail(kind, userMessage) {
    const e = new Error(kind);
    e.kind = kind;
    e.userMessage = userMessage;
    return e;
}

var ProjectCreator = class ProjectCreator {
    // One line, for the log, saying what a sub-project will copy from its
    // parent (describeParent()'s result). Relations the integration can't see
    // come back empty, indistinguishable from "the parent has none", so say so.
    static summarize(inherited) {
        const parts = [];
        if (inherited.type) parts.push("Type: " + inherited.type);
        const hidden = [];
        for (const name in inherited.relations) {
            const n = inherited.relations[name].length;
            if (n > 0) parts.push(name + ": " + n);
            else hidden.push(name);
        }
        let text = parts.length
            ? "Copies from the parent — " + parts.join(" · ") + "."
            : "Copies nothing from the parent besides the link to it.";
        if (hidden.length) {
            text +=
                " " +
                hidden.join(" and ") +
                ": none visible to the applet's Notion connection, so none will be copied.";
        }
        if (inherited.truncated) text += " A long list was cut at 25 entries.";
        return text;
    }

    // deps: {
    //   notion: {getDatabaseId(), getProjectPage(id), createProject(body)},
    //   mapper: ProjectMapper,
    //   store: {maxOrder()},
    //   deck: {adoptCreated(project)},
    // }
    constructor(deps) {
        this._notion = deps.notion;
        this._mapper = deps.mapper;
        this._store = deps.store;
        this._deck = deps.deck;
        this._busy = false;
    }

    // Fresh read of the parent: what a sub-project of it would inherit. Nothing
    // is written, so a failure here is always safe to retry.
    async describeParent(parentId) {
        let page;
        try {
            page = await this._notion.getProjectPage(parentId);
        } catch (e) {
            L.error("describeParent: " + (e && e.message ? e.message : e));
            throw _fail(
                "parent-unreadable",
                "Couldn't read the parent project from Notion. Nothing was created.",
            );
        }
        return this._mapper.inheritedFrom(page);
    }

    // opts: {name, parentId?, inherited?}. Resolves the created project record.
    async create(opts) {
        const name = String((opts && opts.name) || "").trim();
        if (!name) throw _fail("invalid-name", "Type a name first.");
        const databaseId = this._notion.getDatabaseId();
        if (!databaseId) {
            throw _fail("not-configured", "Notion isn't configured (no Projects database ID).");
        }
        if (this._busy) throw _fail("busy", "A project is already being created.");

        const body = this._mapper.buildCreateBody({
            databaseId: databaseId,
            name: name,
            order: this._store.maxOrder() + 1,
            parentId: opts.parentId || null,
            inherited: opts.inherited || null,
        });

        this._busy = true;
        let page;
        try {
            page = await this._notion.createProject(body);
        } catch (e) {
            throw this._classify(e);
        } finally {
            this._busy = false;
        }

        const project = this._mapper.mapPage(page);
        if (!project) {
            throw _fail(
                "unclear",
                "Notion answered, but not with a usable project. Check Notion before trying again.",
            );
        }
        this._deck.adoptCreated(project);
        L.log("created " + project.name + " (" + project.id + ")");
        return project;
    }

    // A 4xx is Notion saying no: nothing was created. Anything else (no answer,
    // 5xx, an unreadable reply) leaves the outcome unknown.
    _classify(e) {
        const status = e && typeof e.status === "number" ? e.status : 0;
        const detail = e && e.notionMessage ? " Notion said: " + e.notionMessage : "";
        L.error("create failed: " + (e && e.message ? e.message : e) + detail);
        if (e && e.message === "no-token") {
            return _fail("not-configured", "Notion isn't configured (no token).");
        }
        if (status === 401 || status === 403) {
            return _fail(
                "permission",
                "Notion refused: this integration isn't allowed to create pages there. " +
                    'It needs the "Insert content" capability and access to the Projects database. ' +
                    "Nothing was created.",
            );
        }
        if (status >= 400 && status < 500 && status !== 408 && status !== 409) {
            return _fail("refused", "Notion refused the request. Nothing was created." + detail);
        }
        return _fail(
            "unclear",
            "No clear answer from Notion, so the project may or may not exist. " +
                "Check Notion before trying again.",
        );
    }
};
