/*
 * BetterWorkspaces — notion/NotionClient.js
 *
 * Raw HTTP against the Notion REST API via libsoup (Design Doc §3.A). Knows
 * about tokens, endpoints, JSON, and libsoup version differences (Soup 2.4 vs
 * 3.0) — nothing about "projects". Exposes queryDatabase(dbId, body, cb) which
 * POSTs to /v1/databases/{id}/query and calls cb(errorOrNull, resultObj).
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("notion-http");

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28"; // Notion API version header

// Detect libsoup major version once (3.x exposes Soup.MAJOR_VERSION).
const SOUP3 = (typeof Soup.MAJOR_VERSION !== "undefined" && Soup.MAJOR_VERSION >= 3);

function NotionClient(token) {
    this._init(token);
}

NotionClient.prototype = {

    _init: function (token) {
        this.token = token || "";
        this.session = new Soup.Session();
        // A short timeout so we never hang the shell waiting on the network.
        try { this.session.timeout = 15; } catch (e) {}
    },

    setToken: function (token) {
        this.token = token || "";
    },

    hasToken: function () {
        return this.token && this.token.length > 0;
    },

    _headers: function (msg) {
        let h = SOUP3 ? msg.get_request_headers() : msg.request_headers;
        h.append("Authorization", "Bearer " + this.token);
        h.append("Notion-Version", NOTION_VERSION);
        h.append("Content-Type", "application/json");
    },

    // POST JSON to `path` (relative to base). Calls cb(err, parsedObjOrNull).
    _post: function (path, bodyObj, cb) {
        if (!this.hasToken()) {
            cb("no-token", null);
            return;
        }

        let url = NOTION_BASE + path;
        let bodyText = JSON.stringify(bodyObj || {});

        try {
            let msg = SOUP3
                ? Soup.Message.new("POST", url)
                : Soup.Message.new("POST", url);
            this._headers(msg);

            if (SOUP3) {
                let bytes = GLib.Bytes.new(ByteArray.fromString(bodyText));
                msg.set_request_body_from_bytes("application/json", bytes);
                this.session.send_and_read_async(
                    msg, GLib.PRIORITY_DEFAULT, null,
                    (session, res) => {
                        try {
                            let gbytes = session.send_and_read_finish(res);
                            let status = msg.get_status();
                            let data = gbytes ? ByteArray.toString(gbytes.get_data()) : "";
                            this._handleResponse(status, data, cb);
                        } catch (e) {
                            L.error("send_and_read_finish: " + e.toString());
                            cb(e.toString(), null);
                        }
                    });
            } else {
                // Soup 2.4
                msg.set_request(
                    "application/json", Soup.MemoryUse.COPY, bodyText);
                this.session.queue_message(msg, (session, message) => {
                    try {
                        let status = message.status_code;
                        let data = message.response_body
                            ? message.response_body.data : "";
                        this._handleResponse(status, data, cb);
                    } catch (e) {
                        L.error("queue_message cb: " + e.toString());
                        cb(e.toString(), null);
                    }
                });
            }
        } catch (e) {
            L.error("_post(" + path + "): " + e.toString());
            cb(e.toString(), null);
        }
    },

    _handleResponse: function (status, data, cb) {
        if (status < 200 || status >= 300) {
            L.error("HTTP " + status + " — " + (data || "").slice(0, 300));
            cb("http-" + status, null);
            return;
        }
        try {
            let parsed = JSON.parse(data);
            cb(null, parsed);
        } catch (e) {
            L.error("JSON parse: " + e.toString());
            cb("bad-json", null);
        }
    },

    // Query a database. `body` is the Notion query payload (filter/sorts).
    // Handles a single page of results (up to 100); pagination can be added
    // later if the project list ever exceeds that.
    queryDatabase: function (dbId, body, cb) {
        this._post("/databases/" + dbId + "/query", body, cb);
    },
};

var NotionClientModule = { NotionClient: NotionClient, SOUP3: SOUP3 };
