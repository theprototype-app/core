// The mesh-edit WIREFRAME overlay is the one editor helper that is not at the
// scene root: it is a LineSegments CHILD of the edited mesh, because that is how
// it follows the object's transform for free (see `buildEditWireframe`). The
// price is that it lives inside `objectsGroup` — the replicated, serialized tree
// — for the duration of a session, and golden rule 5 exists precisely because
// that tree is written to four different places.
//
// It leaked. A save taken while an edit session was open wrote the overlay into
// the file as a real object, and every load brought it back as a permanent
// wireframe that no session owns, cannot update, and cannot be turned off. They
// ACCUMULATE: a user's reported scene had two of them on one mesh (plus an
// `edit-overlay_1` from the name uniquifier on a third), drawn on top of each
// other and baked from a geometry several edits old — the reported "wireframe
// glitch". Proven directly: `box.toJSON()` taken during a session contains
// `["Box", "edit-overlay"]`.
//
// Two halves, and both are needed: PARK stops new files carrying it (hooked into
// `parkAnimatedAtBase`, the ritual every serializer already performs), STRIP
// heals the files that already do (the object-parse sites on the way in).
//
// Deliberately imports NOTHING — not even three. It is reachable from
// flowRuntime, which sits inside the history import cycle, and a pure module
// cannot close one. It also means it needs no scene access: every caller hands
// it the root it cares about.

/** the name `buildEditWireframe` stamps on the overlay */
export const EDIT_OVERLAY_NAME = 'edit-overlay';

/** parks nest (a serializer inside a serializer), so this is a DEPTH, not a flag */
let parkedDepth = 0;

/** Is a serializer currently reading the scene without the overlays?
 * `tickEditWireframe` asks, so its per-frame heal cannot re-add one mid-export
 * (the GLTF path is async — frames pass between park and restore). */
export function editOverlaysParked() {
	return parkedDepth > 0;
}

/** @param {any} node */
function isEditOverlay(node) {
	if (!node?.isLineSegments || typeof node.name !== 'string') return false;
	// `edit-overlay`, plus the `edit-overlay_1` shape the name uniquifier makes
	// when a second one lands on the same object. NOT `edge-edit-overlay` /
	// `face-edit-overlay`: those are scene-root meshes and were never affected.
	return node.name === EDIT_OVERLAY_NAME || node.name.startsWith(EDIT_OVERLAY_NAME + '_');
}

/**
 * Remove every edit wireframe from a tree. For trees arriving from OUTSIDE a
 * live session — a loaded scene, a restored autosave, a peer's `object`
 * message, an undo snapshot — and for a fresh `clone(true)`, where the copy
 * inherited the original's overlay as a child.
 *
 * Deliberately DETACHES without disposing. Every caller hands over a tree that
 * has never been rendered, so there is no GPU resource to free — and `clone()`
 * SHARES geometry and material with its source, so disposing the copy's
 * overlay would tear down the buffers the LIVE wireframe is still drawing with.
 * @param {any} root @returns {number} how many were removed
 */
export function stripEditOverlays(root) {
	if (!root?.traverse) return 0;
	/** @type {any[]} */
	const doomed = [];
	root.traverse((/** @type {any} */ node) => {
		if (isEditOverlay(node)) doomed.push(node);
	});
	for (const node of doomed) node.parent?.remove(node);
	return doomed.length;
}

/**
 * Detach the LIVE overlays for the duration of a serialize and return an
 * idempotent restore — the `parkAnimatedAtBase` contract, and called from it.
 * Never disposes: the same object goes back on the same parent afterwards.
 * @param {any} root @returns {() => void}
 */
export function parkEditOverlays(root) {
	/** @type {{node: any, parent: any}[]} */
	const parked = [];
	if (root?.traverse)
		root.traverse((/** @type {any} */ node) => {
			if (isEditOverlay(node) && node.parent) parked.push({ node, parent: node.parent });
		});
	for (const entry of parked) entry.parent.remove(entry.node);
	parkedDepth++;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		parkedDepth = Math.max(0, parkedDepth - 1);
		for (const entry of parked) entry.parent.add(entry.node);
	};
}
