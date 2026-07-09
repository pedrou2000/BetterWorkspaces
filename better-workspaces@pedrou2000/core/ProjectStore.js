/*
 * BetterWorkspaces — core/ProjectStore.js
 *
 * The single owner of the project CATALOG: every non-archived Notion project
 * ({id, name, icon, notionUrl, inWorkspace, order}), loaded once from the disk
 * cache at construction and persisted back on every change. Everything else is
 * a reader or a transport:
 *
 *   - disk cache: written ONLY here (single writer — no read-modify-write races)
 *   - Notion:     mutations are applied optimistically (store + cache update
 *                 immediately) and pushed through a writer via a serialized
 *                 FIFO queue; on push failure the field reverts to its last
 *                 acknowledged value and onWriteError fires
 *   - sync pulls: merge(remote, protectedIds) folds a fresh pull into the
 *                 catalog — catalog fields (name/icon/url) always take the
 *                 remote value; deck-relevant fields (inWorkspace/order) take
 *                 it only when no local write is pending (local wins while
 *                 dirty). Ids missing from remote are dropped unless protected
 *                 (i.e. currently in the live deck).
 *
 * Pending writes are NOT persisted: if Cinnamon unloads mid-queue the write is
 * lost and the next session's pull restores remote truth (by design).
 *
 * No Cinnamon/GTK dependencies — persistence and writer are injected, so this
 * is fully testable under Node.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const ProjectMapper = AppletDir.notion.ProjectMapper.ProjectMapper;
const L = AppletDir.lib.logger.Logger.makeLogger("store");

var CACHE_FILE = "projects-cache.json";

var ProjectStore = class ProjectStore {

    // persistence: lib/persistence-shaped {readJSON, writeJSON}.
    constructor(persistence) {
        this._persistence = persistence;
        this._writer = null;      // {setWorkspaceFlag(id,v), setWorkspaceOrder(id,o)} -> Promise
        this._onChange = null;    // cb(reason) after any catalog change
        this._onWriteError = null;// cb(id, field, error) after a failed+reverted push

        this._byId = new Map();   // id -> project record (the catalog)
        this._dirty = new Set();  // "id\0field" with a not-yet-acknowledged local write
        this._acked = new Map();  // "id\0field" -> last remote-acknowledged value
        this._queue = [];         // [{id, field, value}] pending pushes, FIFO
        this._inFlight = false;

        let cached = persistence.readJSON(CACHE_FILE, null);
        let projects = (cached && cached.projects) ? cached.projects : [];
        for (let i = 0; i < projects.length; i++) this._byId.set(projects[i].id, projects[i]);
        L.log("loaded " + this._byId.size + " projects from cache");
    }

    setWriter(writer) { this._writer = writer; }
    onChange(cb) { this._onChange = cb; }
    onWriteError(cb) { this._onWriteError = cb; }

    // ---- reads ---------------------------------------------------------------

    // The whole catalog, sorted by Workspace Order (nulls last, title tiebreak).
    all() {
        return ProjectMapper.sortByOrder(Array.from(this._byId.values()));
    }

    get(id) {
        return this._byId.get(id) || null;
    }

    // Highest numeric order in the catalog, or -1 (for append-at-bottom).
    maxOrder() {
        let max = -1;
        for (let p of this._byId.values()) {
            if (typeof p.order === "number" && p.order > max) max = p.order;
        }
        return max;
    }

    // ---- optimistic mutations --------------------------------------------------

    setInWorkspace(id, value) {
        this._set(id, "inWorkspace", !!value);
    }

    setOrder(id, order) {
        this._set(id, "order", order);
    }

    // Assign Workspace Order = 0,1,2,... following `orderedIds` (the deck order
    // after a reorder). One queued push per changed id.
    setOrders(orderedIds) {
        for (let i = 0; i < orderedIds.length; i++) this._set(orderedIds[i], "order", i);
    }

    // Apply a field change locally (store + cache + notify), then queue the
    // Notion push. No-ops when the value is already current and nothing is
    // pending (avoids redundant writes on repeated calls).
    _set(id, field, value) {
        let p = this._byId.get(id);
        if (!p) { L.error("_set: unknown project " + id); return; }
        let key = id + "\0" + field;
        if (p[field] === value && !this._dirty.has(key) && !this._queuedFor(key)) return;

        if (!this._acked.has(key)) this._acked.set(key, p[field]);
        p[field] = value;
        this._dirty.add(key);
        this._persist();
        this._notify("set:" + field);

        // Coalesce: a queued (not in-flight) push for the same id+field is
        // superseded by this newer value.
        let queued = this._queuedFor(key);
        if (queued) queued.value = value;
        else this._queue.push({ id: id, field: field, value: value });
        this._pump();
    }

    _queuedFor(key) {
        for (let i = 0; i < this._queue.length; i++) {
            let e = this._queue[i];
            if (e.id + "\0" + e.field === key) return e;
        }
        return null;
    }

    // Push queue: strictly one write in flight; FIFO order.
    _pump() {
        if (this._inFlight || this._queue.length === 0 || !this._writer) return;
        let entry = this._queue.shift();
        let key = entry.id + "\0" + entry.field;
        this._inFlight = true;

        let push = entry.field === "inWorkspace"
            ? this._writer.setWorkspaceFlag(entry.id, entry.value)
            : this._writer.setWorkspaceOrder(entry.id, entry.value);

        push.then(() => {
            this._acked.set(key, entry.value);
            // Field is clean only if no newer push for it is still queued.
            if (!this._queuedFor(key)) this._dirty.delete(key);
        }).catch((e) => {
            L.error("push failed (" + entry.field + " " + entry.id + "): "
                + (e && e.message ? e.message : e));
            this._revert(entry.id, entry.field, key);
            if (this._onWriteError) {
                try { this._onWriteError(entry.id, entry.field, e); } catch (err) {}
            }
        }).then(() => {
            this._inFlight = false;
            this._pump();
        });
    }

    // Revert a field to its last acknowledged value after a failed push, and
    // drop any queued newer pushes for it (they'd fail the same way).
    _revert(id, field, key) {
        this._queue = this._queue.filter((e) => e.id + "\0" + e.field !== key);
        this._dirty.delete(key);
        let p = this._byId.get(id);
        if (p && this._acked.has(key)) {
            p[field] = this._acked.get(key);
            this._persist();
            this._notify("revert:" + field);
        }
    }

    // ---- sync merge -----------------------------------------------------------

    // Fold a fresh remote pull into the catalog. `protectedIds` (array) are ids
    // that must survive even if missing from remote (the live deck's projects).
    // Returns {added, removed, newlyInWorkspace}: newlyInWorkspace lists project
    // records whose inWorkspace went false/absent -> true via THIS merge (the
    // applet may auto-append them to the deck).
    merge(remoteProjects, protectedIds) {
        let keep = new Set(protectedIds || []);
        let remoteIds = new Set();
        let added = [], newlyOn = [];

        for (let i = 0; i < remoteProjects.length; i++) {
            let r = remoteProjects[i];
            remoteIds.add(r.id);
            let local = this._byId.get(r.id);
            if (!local) {
                this._byId.set(r.id, Object.assign({}, r));
                added.push(r.id);
                if (r.inWorkspace) newlyOn.push(this._byId.get(r.id));
                continue;
            }
            // Catalog fields: remote wins unconditionally (they can't move
            // workspaces, and Notion is their source of truth).
            local.name = r.name;
            local.icon = r.icon;
            local.notionUrl = r.notionUrl;
            // Deck-relevant fields: remote wins unless a local write is pending.
            if (!this._dirty.has(r.id + "\0inWorkspace")) {
                if (!local.inWorkspace && r.inWorkspace) newlyOn.push(local);
                local.inWorkspace = r.inWorkspace;
                this._acked.set(r.id + "\0inWorkspace", r.inWorkspace);
            }
            if (!this._dirty.has(r.id + "\0order")) {
                local.order = r.order;
                this._acked.set(r.id + "\0order", r.order);
            }
        }

        // Drop ids gone from remote, unless protected (in the live deck).
        let removed = [];
        for (let id of Array.from(this._byId.keys())) {
            if (remoteIds.has(id)) continue;
            if (keep.has(id)) {
                L.log("merge: keeping deck project missing from remote: " + id);
                continue;
            }
            this._byId.delete(id);
            removed.push(id);
        }

        this._persist();
        this._notify("merge");
        L.log("merge: " + remoteProjects.length + " remote, +" + added.length
            + " -" + removed.length + ", newly-on " + newlyOn.length);
        return { added: added, removed: removed, newlyInWorkspace: newlyOn };
    }

    // ---- internals ------------------------------------------------------------

    _persist() {
        this._persistence.writeJSON(CACHE_FILE, { projects: Array.from(this._byId.values()) });
    }

    _notify(reason) {
        if (this._onChange) {
            try { this._onChange(reason); } catch (e) { L.error("onChange cb: " + e.toString()); }
        }
    }

    destroy() {
        // Pending pushes are dropped by design; next session's pull re-syncs.
        this._queue = [];
        this._writer = null;
        this._onChange = null;
        this._onWriteError = null;
    }
};
