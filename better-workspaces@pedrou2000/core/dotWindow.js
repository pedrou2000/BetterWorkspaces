/* core/dotWindow.js — which workspaces the panel's fixed row of dots shows. */

// The panel always draws `slots` dots, so a longer strip is seen through a
// window of `slots` consecutive workspaces. e.g. slots=4, count=6, current=3:
// start=1 -> shows [1 2 3 4], with more before and after.

// The window containing `current`, moved as little as possible from `prevStart`.
// While workspaces lie beyond an edge, `current` is kept off that edge slot, so
// the edge always shows a neighbour to step (or click) onto.
function place(count, current, prevStart, slots) {
    if (count <= slots) return { start: 0, moreBefore: false, moreAfter: false };

    const maxStart = count - slots;
    const clamp = (s) => Math.min(Math.max(s, 0), maxStart);

    let start = clamp(prevStart || 0);
    if (current <= start) start = current - 1;
    else if (current >= start + slots - 1) start = current - (slots - 2);
    start = clamp(start);

    return { start: start, moreBefore: start > 0, moreAfter: start < maxStart };
}

var DotWindow = {
    place: place,
};
