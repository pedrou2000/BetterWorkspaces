/* core/ProjectStore.js — single owner of the project catalog + disk cache. */

// Catalog = {id -> {id,name,icon,notionUrl,inWorkspace,order}}. Sole writer of
// the cache, so setFlag/setOrder have no read-modify-write races. Mutations are
// optimistic (store+cache update now) and pushed via a serialized FIFO queue:
//   - transient failure (network/5xx/429) HOLDS the write, pauses the queue, and
//     retryPending() resumes it on reconnect — offline edits land later.
//   - permanent rejection (4xx/no-token) reverts the field and fires onWriteError.
// merge(): catalog fields take remote; deck fields (inWorkspace/order) take remote
// only when no local write is pending (local wins while dirty). Pending writes
// are not persisted across unload — next pull restores remote truth.

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
        this._paused = false;     // held after a transient failure; retryPending() resumes

        let cached = persistence.readJSON(CACHE_FILE, null);
        let projects = (cached && cached.projects) ? cached.projects : [];
        for (let i = 0; i < projects.length; i++) this._byId.set(projects[i].id, projects[i]);
        L.log("loaded " + this._byId.size + " projects from cache");
    }

    setWriter(writer) { this._writer = writer; }
    onChange(cb) { this._onChange = cb; }
    onWriteError(cb) { this._onWriteError = cb; }

    // Sorted by Workspace Order (nulls last, title tiebreak).
    all() {
        return ProjectMapper.sortByOrder(Array.from(this._byId.values()));
    }

    get(id) {
        return this._byId.get(id) || null;
    }

    // Highest order, or -1 (for append-at-bottom).
    maxOrder() {
        let max = -1;
        for (let p of this._byId.values()) {
            if (typeof p.order === "number" && p.order > max) max = p.order;
        }
        return max;
    }

    setInWorkspace(id, value) {
        this._set(id, "inWorkspace", !!value);
    }

    setOrder(id, order) {
        this._set(id, "order", order);
    }

    // Order = 0,1,2,... following the deck order; one queued push per id.
    setOrders(orderedIds) {
        for (let i = 0; i < orderedIds.length; i++) this._set(orderedIds[i], "order", i);
    }

    // No-op when the value is already current and nothing is pending.
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

    // One write in flight, FIFO. Pauses on transient failure, reverts on permanent.
    _pump() {
        if (this._inFlight || this._paused || this._queue.length === 0 || !this._writer) return;
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
            if (this._isTransient(e)) {
                // Hold: requeue at the head (unless a newer value is queued) and
                // pause; the field stays dirty so merge() keeps protecting it.
                L.log("push held (transient " + (e && e.message ? e.message : e)
                    + "): " + entry.field + " " + entry.id);
                if (!this._queuedFor(key)) this._queue.unshift(entry);
                this._paused = true;
            } else {
                L.error("push rejected (" + entry.field + " " + entry.id + "): "
                    + (e && e.message ? e.message : e));
                this._revert(entry.id, entry.field, key);
            }
            if (this._onWriteError) {
                try { this._onWriteError(entry.id, entry.field, e); } catch (err) {}
            }
        }).then(() => {
            this._inFlight = false;
            this._pump();
        });
    }

    // Transient (retry): transport/GLib errors, 5xx, 429. Permanent (revert):
    // no-token or a real 4xx rejection.
    _isTransient(e) {
        let msg = (e && e.message) ? e.message : String(e);
        if (msg === "no-token") return false;
        let m = msg.match(/^http-(\d+)$/);
        if (!m) return true;                    // transport/GLib error: retry
        let status = parseInt(m[1], 10);
        if (status < 100) return true;          // libsoup transport pseudo-codes
                                                // (0 none, 2 can't-resolve, 4 can't-connect, ...)
        if (status >= 500) return true;         // server hiccup: retry
        if (status === 429) return true;        // rate limited: retry
        return false;                            // real 4xx rejection: revert
    }

    // Resume a queue paused by a transient failure; the applet calls this when
    // sync recovers. No-op when nothing is held.
    retryPending() {
        if (!this._paused) return;
        this._paused = false;
        L.log("retryPending: resuming " + this._queue.length + " held write(s)");
        this._pump();
    }

    hasPendingWrites() {
        return this._queue.length > 0 || this._inFlight;
    }

    // Revert to the last acknowledged value and drop queued newer pushes for it.
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

    // Fold a remote pull into the catalog. protectedIds survive even if missing
    // from remote (the live deck). Returns {added, removed, newlyInWorkspace} —
    // newlyInWorkspace = records flipped off->on here, for the applet to append.
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
            // Catalog fields: remote wins (they can't move workspaces).
            local.name = r.name;
            local.icon = r.icon;
            local.notionUrl = r.notionUrl;
            // Deck fields: remote wins unless a local write is pending.
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
