/*
 * BetterWorkspaces — core/mapping.js
 *
 * The strips <-> flat-list mapping (Design Doc §4), as PURE functions with no
 * Cinnamon dependency so the crux logic is trivially testable. The model:
 * projects are laid out as consecutive partitions in one flat workspace list,
 * in project order. `counts` is the per-project workspace count array.
 *
 *   counts = [3, 2, 2]   ->   flat [0 1 2][3 4][5 6]
 *                                   WebApp  Blog Research
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

// Total number of flat workspaces across all projects.
function totalWorkspaces(counts) {
    let sum = 0;
    for (let i = 0; i < counts.length; i++) sum += counts[i];
    return sum;
}

// Flat index where project `projectIdx`'s partition begins.
function offsetOf(counts, projectIdx) {
    let sum = 0;
    for (let i = 0; i < projectIdx; i++) sum += counts[i];
    return sum;
}

// (project, local) -> flat index.
function globalIndex(counts, projectIdx, localIdx) {
    return offsetOf(counts, projectIdx) + localIdx;
}

// flat index -> {projectIdx, localIdx}, or null if out of range.
// This is the reverse map that answers "where am I" for any active workspace,
// including one reached by external navigation.
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

// Exported as a namespace object (GJS module convention).
var Mapping = {
    totalWorkspaces: totalWorkspaces,
    offsetOf: offsetOf,
    globalIndex: globalIndex,
    locationOf: locationOf,
};
