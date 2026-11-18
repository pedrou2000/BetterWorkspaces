/* ui/DialogStyle.js — which look the dialogs and overlays wear (a user setting). */

// "classic" is the original look (Cinnamon's stock dialog, our black overlays);
// "notion" restyles them in Notion's dark-mode language. A look is one style
// class on each surface — every rule for it in stylesheet.css is scoped under
// that class — plus the few places where the widgets themselves differ (a
// sliding toggle instead of an ON/OFF pill), which ask is(). A surface takes the
// look in force when it opens. The panel bar is not part of this.
//
// The Notion look also has a choice of background (its "tone"): one more class
// on the same surfaces, whose rule comes last in the stylesheet and so wins over
// the default gray. Tones don't apply to the classic look.

const STYLE_CLASS = {
    classic: null,
    notion: "better-workspaces-dialog-notion",
};

// tone -> extra class; the default gray needs none.
const TONE_CLASS = {
    gray: null,
    darker: "better-workspaces-tone-darker",
    glass: "better-workspaces-tone-glass",
    blue: "better-workspaces-tone-blue",
};

let _current = "notion";
let _tone = "gray";

function set(name) {
    _current = Object.prototype.hasOwnProperty.call(STYLE_CLASS, name) ? name : "notion";
}

function setTone(name) {
    _tone = Object.prototype.hasOwnProperty.call(TONE_CLASS, name) ? name : "gray";
}

function is(name) {
    return _current === name;
}

// " tone-class" for the Notion look when a non-default tone is chosen, else "".
function _toneSuffix() {
    const toneClass = _current === "notion" ? TONE_CLASS[_tone] : null;
    return toneClass ? " " + toneClass : "";
}

// The style class for one of our own surfaces (switcher, on-screen display):
// `base` in the classic look, `base-notion` in the Notion one.
function className(base) {
    return _current === "classic" ? base : base + "-" + _current + _toneSuffix();
}

// The params object for `new ModalDialog.ModalDialog(...)`.
function dialogParams() {
    const styleClass = STYLE_CLASS[_current];
    return styleClass ? { styleClass: styleClass + _toneSuffix() } : {};
}

var DialogStyle = {
    set: set,
    setTone: setTone,
    is: is,
    className: className,
    dialogParams: dialogParams,
};
