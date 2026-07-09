/*
 * BetterWorkspaces — lib/http.js
 *
 * The one place that knows libsoup, including the Soup 2.4 vs 3.0 API split
 * (session setup, send_and_read_async vs queue_message, status extraction,
 * byte decoding). Callers get a Promise API and never touch Soup:
 *
 *   await Http.request("GET", url)                          -> {status, bytes, text}
 *   await Http.request("POST", url, {headers, body})        -> body is a string
 *
 * `bytes` is a Uint8Array (for binary payloads like icons); `text` is the
 * UTF-8 decode (for JSON). The Promise rejects only on transport errors;
 * HTTP error statuses resolve normally — status handling is the caller's
 * semantics, not the transport's.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("http");

// Detect the libsoup major version once (3.x exposes Soup.MAJOR_VERSION).
var SOUP3 = (typeof Soup.MAJOR_VERSION !== "undefined" && Soup.MAJOR_VERSION >= 3);

// One shared session; a short timeout so we never hang the shell on network.
let _session = null;
function _getSession() {
    if (!_session) {
        _session = new Soup.Session();
        try { _session.timeout = 15; } catch (e) {}
    }
    return _session;
}

// Send an HTTP request. opts (all optional):
//   headers: {name: value} appended to the request
//   body:    string request body (its Content-Type should be in headers)
// Resolves {status, bytes, text}; rejects on transport failure.
function request(method, url, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        try {
            let session = _getSession();
            let msg = Soup.Message.new(method, url);
            if (!msg) { reject(new Error("bad-url")); return; }

            let h = SOUP3 ? msg.get_request_headers() : msg.request_headers;
            for (let name in (opts.headers || {})) h.append(name, opts.headers[name]);

            let contentType = (opts.headers || {})["Content-Type"] || "application/octet-stream";

            if (SOUP3) {
                if (opts.body !== undefined) {
                    let bytes = GLib.Bytes.new(ByteArray.fromString(opts.body));
                    msg.set_request_body_from_bytes(contentType, bytes);
                }
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                    (s, res) => {
                        try {
                            let gbytes = s.send_and_read_finish(res);
                            let data = gbytes ? gbytes.get_data() : new Uint8Array(0);
                            resolve(_result(msg.get_status(), data));
                        } catch (e) {
                            L.error("send_and_read_finish: " + e.toString());
                            reject(e);
                        }
                    });
            } else {
                // Soup 2.4
                if (opts.body !== undefined) {
                    msg.set_request(contentType, Soup.MemoryUse.COPY, opts.body);
                }
                session.queue_message(msg, (s, message) => {
                    let data = (message.response_body && message.response_body.data !== null)
                        ? message.response_body.data
                        : new Uint8Array(0);
                    resolve(_result(message.status_code, data));
                });
            }
        } catch (e) {
            L.error("request(" + method + " " + url + "): " + e.toString());
            reject(e);
        }
    });
}

// Normalize a raw payload (Uint8Array on Soup3, string on Soup2) into
// {status, bytes, text}.
function _result(status, data) {
    let bytes, text;
    if (data instanceof Uint8Array) {
        bytes = data;
        text = ByteArray.toString(data);
    } else {
        text = data || "";
        bytes = ByteArray.fromString(text);
    }
    return { status: status, bytes: bytes, text: text };
}

var Http = {
    SOUP3: SOUP3,
    request: request,
};
