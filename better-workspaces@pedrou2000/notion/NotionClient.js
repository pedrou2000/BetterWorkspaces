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
    // An http error also carries .status and, when Notion sent one, .notionMessage.
    async _request(method, path, bodyObj) {
        if (!this.hasToken()) throw new Error("no-token");

        const opts = {
            headers: {
                Authorization: "Bearer " + this.token,
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
        };
        if (method !== "GET") opts.body = JSON.stringify(bodyObj || {});
        const res = await Http.request(method, NOTION_BASE + path, opts);

        if (res.status < 200 || res.status >= 300) {
            L.error("HTTP " + res.status + " — " + (res.text || "").slice(0, 300));
            const err = new Error("http-" + res.status);
            err.status = res.status;
            try {
                err.notionMessage = JSON.parse(res.text).message || null;
            } catch (e) {
                err.notionMessage = null;
            }
            throw err;
        }
        try {
            return JSON.parse(res.text);
        } catch (e) {
            L.error("JSON parse: " + e.toString());
            throw new Error("bad-json");
        }
    }

    // One page of results (up to 100); the caller follows has_more/next_cursor.
    queryDatabase(dbId, body) {
        return this._request("POST", "/databases/" + dbId + "/query", body);
    }

    getPage(pageId) {
        return this._request("GET", "/pages/" + pageId);
    }

    // Resolves the created page object. NOT idempotent: never retry a call whose
    // outcome is unknown, or the page may exist twice.
    createPage(body) {
        return this._request("POST", "/pages", body);
    }

    // Moves the page to Notion's trash (restorable there). Idempotent, so a
    // call whose outcome is unknown may be repeated.
    trashPage(pageId) {
        return this._request("PATCH", "/pages/" + pageId, { archived: true });
    }

    updatePageCheckbox(pageId, propName, value) {
        const props = {};
        props[propName] = { checkbox: !!value };
        return this._request("PATCH", "/pages/" + pageId, { properties: props });
    }

    updatePageNumber(pageId, propName, value) {
        const props = {};
        props[propName] = { number: value };
        return this._request("PATCH", "/pages/" + pageId, { properties: props });
    }
};
