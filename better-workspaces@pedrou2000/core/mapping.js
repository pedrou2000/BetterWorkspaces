/* core/mapping.js — project strips <-> flat workspace-list index math. */

// Projects are consecutive partitions of one flat list; counts[i] = project i's
// workspace count. e.g. counts=[3,2,2] -> flat [0 1 2][3 4][5 6].

function totalWorkspaces(counts) {
    let sum = 0;
    for (let i = 0; i < counts.length; i++) sum += counts[i];
    return sum;
}

function offsetOf(counts, projectIdx) {
    let sum = 0;
    for (let i = 0; i < projectIdx; i++) sum += counts[i];
    return sum;
}

function globalIndex(counts, projectIdx, localIdx) {
    return offsetOf(counts, projectIdx) + localIdx;
}

// Reverse map, so "where am I" is correct even after external navigation.
function locationOf(counts, globalIdx) {
    if (globalIdx < 0) return null;
    let base = 0;
    for (let p = 0; p < counts.length; p++) {
        if (globalIdx < base + counts[p]) {
            return { projectIdx: p, localIdx: globalIdx - base };
        }
        base += counts[p];
    }
    return null; // beyond the last partition
}

var Mapping = {
    totalWorkspaces: totalWorkspaces,
    offsetOf: offsetOf,
    globalIndex: globalIndex,
    locationOf: locationOf,
};
