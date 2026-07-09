/* lib/http.js — the one place that knows libsoup (incl. the Soup 2.4/3.0 split). */

// Http.request(method, url, {headers, body}) -> Promise<{status, bytes, text}>.
// Rejects only on transport errors; HTTP error statuses resolve (status handling
// is the caller's semantics). `bytes` is for binary (icons), `text` for JSON.

const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("http");

// 3.x exposes Soup.MAJOR_VERSION; 2.4 doesn't.
var SOUP3 = typeof Soup.MAJOR_VERSION !== "undefined" && Soup.MAJOR_VERSION >= 3;

// One shared session; a short timeout so we never hang the shell on network.
let _session = null;
function _getSession() {
    if (!_session) {
        _session = new Soup.Session();
        try {
            _session.timeout = 15;
        } catch (e) {}
    }
    return _session;
}

// opts: {headers:{name:value}, body:string}. body's Content-Type comes from headers.
function request(method, url, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        try {
            const session = _getSession();
            const msg = Soup.Message.new(method, url);
            if (!msg) {
                reject(new Error("bad-url"));
                return;
            }

            const h = SOUP3 ? msg.get_request_headers() : msg.request_headers;
            for (const name in opts.headers || {}) h.append(name, opts.headers[name]);

            const contentType = (opts.headers || {})["Content-Type"] || "application/octet-stream";

            if (SOUP3) {
                if (opts.body !== undefined) {
                    const bytes = GLib.Bytes.new(ByteArray.fromString(opts.body));
                    msg.set_request_body_from_bytes(contentType, bytes);
                }
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                    try {
                        const gbytes = s.send_and_read_finish(res);
                        const data = gbytes ? gbytes.get_data() : new Uint8Array(0);
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
                    const data =
                        message.response_body && message.response_body.data !== null
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

// Soup3 hands back a Uint8Array, Soup2 a string; expose both shapes.
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
