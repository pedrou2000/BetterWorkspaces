/* lib/emojiImage.js — emoji string -> URL of its Twemoji image. */

// Notion's web app draws emoji with the Twemoji image set, not the system font,
// so the same character looks different in the panel unless we use those images
// too. Pinned to one release so a cached image never changes under us.
// Artwork is CC-BY 4.0 (jdecked/twemoji) — attribute it if this ships.

// Served from the project's own repository on GitHub's raw host: one fewer
// third-party host, and it is commonly reachable where CDNs are filtered.
const BASE = "https://raw.githubusercontent.com/jdecked/twemoji/v17.0.3/assets/svg/";

// Twemoji's own file-naming rule: code points in hex joined by "-", with the
// U+FE0F variation selector dropped unless the sequence is a ZWJ (U+200D) one.
function codePoints(emoji) {
    let chars = Array.from(emoji || "");
    if (chars.indexOf("\u200d") === -1) chars = chars.filter((ch) => ch !== "\ufe0f");
    return chars.map((ch) => ch.codePointAt(0).toString(16)).join("-");
}

// null for an empty string.
function urlFor(emoji) {
    const name = codePoints(emoji);
    return name ? BASE + name + ".svg" : null;
}

var EmojiImage = {
    codePoints: codePoints,
    urlFor: urlFor,
};
