/* ui/DialogStyle.js — which look the dialogs and overlays wear (a user setting). */

// "classic" is the original look (Cinnamon's stock dialog, our black overlays);
// "notion" restyles them in Notion's dark-mode language. A look is one style
// class on each surface — every rule for it in stylesheet.css is scoped under
// that class — plus the few places where the widgets themselves differ (a
// sliding toggle instead of an ON/OFF pill), which ask is(). A surface takes the
// look in force when it opens. The panel bar is not part of this.

const STYLE_CLASS = {
    classic: null,
    notion: "better-workspaces-dialog-notion",
};

let _current = "notion";

function set(name) {
    _current = Object.prototype.hasOwnProperty.call(STYLE_CLASS, name) ? name : "notion";
}

function is(name) {
    return _current === name;
}

// The style class for one of our own surfaces (switcher, on-screen display):
// `base` in the classic look, `base-notion` in the Notion one.
function className(base) {
    return _current === "classic" ? base : base + "-" + _current;
}

// The params object for `new ModalDialog.ModalDialog(...)`.
function dialogParams() {
    const styleClass = STYLE_CLASS[_current];
    return styleClass ? { styleClass: styleClass } : {};
}

var DialogStyle = {
    set: set,
    is: is,
    className: className,
    dialogParams: dialogParams,
};
