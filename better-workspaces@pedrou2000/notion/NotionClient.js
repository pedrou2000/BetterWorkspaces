/*
 * BetterWorkspaces — notion/NotionClient.js
 *
 * The Notion REST API surface (Design Doc §3.A). Knows tokens, endpoints, and
 * JSON semantics — the HTTP transport (including libsoup version differences)
 * lives in lib/http.js. Exposes async queryDatabase(dbId, body) which POSTs to
 * /v1/databases/{id}/query and resolves to the parsed result (rejecting with
 * Error("no-token" | "http-<status>" | "bad-json") on failure).
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const Http = AppletDir.lib.http.Http;
const L = AppletDir.lib.logger.Logger.makeLogger("notion-http");

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28"; // Notion API version header

var NotionClient = class NotionClient {

    constructor(token) {
        this.token = token || "";
    }

    setToken(token) {
        this.token = token || "";
    }

    hasToken() {
        return this.token && this.token.length > 0;
    }

    // Send a JSON request with the given HTTP method. Resolves to the parsed
    // response object; rejects with Error("no-token"|"http-<status>"|"bad-json").
    async _request(method, path, bodyObj) {
        if (!this.hasToken()) throw new Error("no-token");

        let res = await Http.request(method, NOTION_BASE + path, {
            headers: {
                "Authorization": "Bearer " + this.token,
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(bodyObj || {}),
        });

        if (res.status < 200 || res.status >= 300) {
            L.error("HTTP " + res.status + " — " + (res.text || "").slice(0, 300));
            throw new Error("http-" + res.status);
        }
        try {
            return JSON.parse(res.text);
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
