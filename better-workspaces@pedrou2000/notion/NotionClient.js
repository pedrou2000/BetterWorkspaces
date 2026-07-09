/* notion/NotionClient.js — Notion REST surface (tokens, endpoints, JSON). */

// The HTTP transport (incl. libsoup version differences) lives in lib/http.js.

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

    // Resolves the parsed body; rejects Error("no-token"|"http-<status>"|"bad-json").
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

    // One page of results (up to 100); pagination TODO if the list ever exceeds it.
    queryDatabase(dbId, body) {
        return this._request("POST", "/databases/" + dbId + "/query", body);
    }

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
