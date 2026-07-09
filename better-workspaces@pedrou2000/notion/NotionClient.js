/*
 * BetterWorkspaces — notion/NotionClient.js
 *
 * Raw HTTP against the Notion REST API via libsoup (Design Doc §3.A). Knows
 * about tokens, endpoints, JSON, and libsoup version differences (Soup 2.4 vs
 * 3.0) — nothing about "projects". Exposes async queryDatabase(dbId, body)
 * which POSTs to /v1/databases/{id}/query and resolves to the parsed result
 * (rejecting with Error("no-token" | "http-<status>" | "bad-json") on failure).
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

// Detect libsoup major version once (3.x exposes Soup.MAJOR_VERSION). Exported
// so other modules (e.g. IconRenderer) can branch on it.
var SOUP3 = (typeof Soup.MAJOR_VERSION !== "undefined" && Soup.MAJOR_VERSION >= 3);

var NotionClient = class NotionClient {

    constructor(token) {
        this.token = token || "";
        this.session = new Soup.Session();
        // A short timeout so we never hang the shell waiting on the network.
        try { this.session.timeout = 15; } catch (e) {}
    }

    setToken(token) {
        this.token = token || "";
    }

    hasToken() {
        return this.token && this.token.length > 0;
    }

    _headers(msg) {
        let h = SOUP3 ? msg.get_request_headers() : msg.request_headers;
        h.append("Authorization", "Bearer " + this.token);
        h.append("Notion-Version", NOTION_VERSION);
        h.append("Content-Type", "application/json");
    }

    // Send a JSON request with the given HTTP method. Resolves to the parsed
    // response object; rejects with Error("no-token"|"http-<status>"|"bad-json").
    async _request(method, path, bodyObj) {
        if (!this.hasToken()) throw new Error("no-token");

        let url = NOTION_BASE + path;
        let bodyText = JSON.stringify(bodyObj || {});
        let msg = Soup.Message.new(method, url);
        this._headers(msg);

        // Bridge libsoup's GAsync callbacks to a Promise; both branches resolve
        // to [status, dataString].
        let [status, data] = await new Promise((resolve, reject) => {
            try {
                if (SOUP3) {
                    let bytes = GLib.Bytes.new(ByteArray.fromString(bodyText));
                    msg.set_request_body_from_bytes("application/json", bytes);
                    this.session.send_and_read_async(
                        msg, GLib.PRIORITY_DEFAULT, null,
                        (session, res) => {
                            try {
                                let gbytes = session.send_and_read_finish(res);
                                let text = gbytes ? ByteArray.toString(gbytes.get_data()) : "";
                                resolve([msg.get_status(), text]);
                            } catch (e) {
                                L.error("send_and_read_finish: " + e.toString());
                                reject(e);
                            }
                        });
                } else {
                    // Soup 2.4
                    msg.set_request("application/json", Soup.MemoryUse.COPY, bodyText);
                    this.session.queue_message(msg, (session, message) => {
                        let text = message.response_body ? message.response_body.data : "";
                        resolve([message.status_code, text]);
                    });
                }
            } catch (e) {
                L.error("_request(" + path + "): " + e.toString());
                reject(e);
            }
        });

        if (status < 200 || status >= 300) {
            L.error("HTTP " + status + " — " + (data || "").slice(0, 300));
            throw new Error("http-" + status);
        }
        try {
            return JSON.parse(data);
        } catch (e) {
            L.error("JSON parse: " + e.toString());
            throw new Error("bad-json");
        }
    }

    // Query a database. `body` is the Notion query payload (filter/sorts).
    // Handles a single page of results (up to 100); pagination can be added
    // later if the project list ever exceeds that.
    queryDatabase(dbId, body) {
        return this._request("POST", "/databases/" + dbId + "/query", body);
    }

    // Set a checkbox property on a page.
    // Requires the integration to have update-content capability.
    updatePageCheckbox(pageId, propName, value) {
        let props = {};
        props[propName] = { checkbox: !!value };
        return this._request("PATCH", "/pages/" + pageId, { properties: props });
    }

    // Set a number property on a page.
    updatePageNumber(pageId, propName, value) {
        let props = {};
        props[propName] = { number: value };
        return this._request("PATCH", "/pages/" + pageId, { properties: props });
    }
};
