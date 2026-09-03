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
//
// ---------------------------------------------------------------------------
// R22 — THE SECOND MEMBER: THE SELECTION OUTLINE'S RENDER LAYER.
//
// The module's remit is therefore wider than its name: it is LOCAL EDITOR
// DECORATION THAT MUST NOT ENTER THE SERIALIZED TREE. The wireframe leaks as a
// CHILD OBJECT; the outline leaks as a PROPERTY, and it is the same bug with the
// same two halves and the same seventeen call sites, which is the whole reason
// it lives here rather than in a module of its own.
//
// postprocessing's `Selection` marks a selected object by ENABLING A RENDER
// LAYER on it (`object.layers.enable(2)`) and the OutlineEffect draws its mask
// by pointing the camera at that layer alone. THREE's `Object3D.toJSON` writes
// `layers` as a plain mask and `ObjectLoader.parse` restores it — so a scene
// SAVED WHILE SOMETHING WAS SELECTED bakes the outline layer into the file
// (measured in a user's own project: `layers: 5` = bits 0 and 2), and the object
// comes back wearing it while sitting in NOBODY'S selection.
//
// That is unreachable state: `Selection.clear()` only disables the layer on its
// own members, so nothing will ever take it off again. The visible result is the
// reported GHOST. The OutlineEffect re-renders its target only while its set is
// non-empty (plus ONE `forceUpdate` frame after it empties), and on exactly that
// clearing frame the tainted object is what the mask picks up — so the outline
// target freezes holding an outline of an object nobody selected, and that
// frozen SCREEN-SPACE image is then blended into every later frame. It survives
// deselecting, replacing the whole scene and moving the camera (proven: the
// camera moved, every object moved, the outline stayed on the same pixels).
//
// The same taint rides `clone()`, which copies the layer mask — so duplicating a
// selected object made the copy wear it too.
//
// Nothing in `src/` touches `Object3D.layers` anywhere else (grepped), so the
// only bits that can be set are the outline passes' own. Which ones those are is
// not knowable here — postprocessing assigns them at construction — so
// `Outline.svelte` REGISTERS them, keeping this module import-free.

/** the name `buildEditWireframe` stamps on the overlay */
export const EDIT_OVERLAY_NAME = 'edit-overlay';

/** The render layers the outline passes mark their selections with, published by
 *  `Outline.svelte` (which owns the effects and therefore the numbers). A Set, so
 *  a component remount that mints fresh layers only ever adds to what we scrub. */
const outlineLayers = new Set();

/**
 * Tell this module which render layer an outline selection marks its members
 * with. Called by `Outline.svelte` for each of its two passes.
 * @param {number} layer @returns {() => void} deregister
 */
export function registerOutlineLayer(layer) {
	if (Number.isInteger(layer) && layer > 0 && layer < 32) outlineLayers.add(layer);
	return () => {
		outlineLayers.delete(layer);
	};
}

/** Test seam: which layers are scrubbed. @returns {number[]} */
export function outlineLayerList() {
	return [...outlineLayers].sort((a, b) => a - b);
}

/**
 * Clear the registered outline layers from a tree, optionally recording the
 * masks so a park can put them back verbatim.
 * @param {any} root @param {{node: any, mask: number}[]|null} [record]
 * @returns {number} how many objects were carrying one
 */
function scrubOutlineLayers(root, record = null) {
	if (!root?.traverse || outlineLayers.size === 0) return 0;
	let touched = 0;
	root.traverse((/** @type {any} */ node) => {
		const layers = node?.layers;
		if (!layers || typeof layers.isEnabled !== 'function') return;
		let carries = false;
		for (const layer of outlineLayers) {
			if (layers.isEnabled(layer)) {
				carries = true;
				break;
			}
		}
		if (!carries) return;
		if (record) record.push({ node, mask: layers.mask });
		for (const layer of outlineLayers) layers.disable(layer);
		touched++;
	});
	return touched;
}

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
 *
 * ALSO clears the outline render layer (see the header): every caller here is a
 * tree arriving from outside the live selection — parsed from a file, from a
 * peer, from an undo snapshot, or freshly cloned — so an outline layer on it can
 * only be baked-in taint. A genuinely selected object gets its layer back from
 * the outline effect itself, which re-derives the whole selection from the
 * stores whenever `objectsGroup` is poked.
 * @param {any} root @returns {number} how many overlays were removed
 */
export function stripEditOverlays(root) {
	if (!root?.traverse) return 0;
	/** @type {any[]} */
	const doomed = [];
	root.traverse((/** @type {any} */ node) => {
		if (isEditOverlay(node)) doomed.push(node);
	});
	for (const node of doomed) node.parent?.remove(node);
	scrubOutlineLayers(root);
	return doomed.length;
}

/**
 * Detach the LIVE overlays for the duration of a serialize and return an
 * idempotent restore — the `parkAnimatedAtBase` contract, and called from it.
 * Never disposes: the same object goes back on the same parent afterwards.
 *
 * ALSO parks the outline render layer, which is the half that stops NEW files
 * carrying the taint. The mask is put back VERBATIM, so a selected object keeps
 * its outline across the save: every toJSON caller parks and restores inside one
 * tick, and the async GLTF path behaves exactly as it already does for the
 * wireframe.
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
	/** @type {{node: any, mask: number}[]} */
	const masks = [];
	scrubOutlineLayers(root, masks);
	parkedDepth++;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		parkedDepth = Math.max(0, parkedDepth - 1);
		for (const entry of parked) entry.parent.add(entry.node);
		for (const entry of masks) entry.node.layers.mask = entry.mask;
	};
}
