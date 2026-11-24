import { beginHistorySession, endHistorySession } from './history';
import { session } from './editSessionState';

export { session };

// 15-F: ONE mesh-edit session = ONE undo entry after Done (history.js keeps
// the live barrier; this module decides when a session starts and ends).
//
// Deliberately NOTIFICATION-driven, not store-subscribing: meshEdit/faceEdit/
// colliderEdit call in (they import us — we import only history, an edge they
// all already have, so no cycle can close back through their subtrees). The
// planned store-watcher would need editSession → meshEdit imports, and
// meshEdit → editSession → meshEdit is the TDZ-cycle family: this module's
// eval-time subscribe would read `editingObject` before meshEdit's body ran.

/** @type {string|null} uuid vertex-editing, or null */
let vertexOn = null;
/** @type {string|null} uuid face-editing, or null */
let faceOn = null;
/** a history session is open */
let active = false;
/** @type {string|null} the uuid the open session belongs to */
let sessionUuid = null;
/** the open session edits a collider PROXY — sealed with 'discard' (its
 * meshgeo entries target a disposed proxy and can never replay) */
let colliderSession = false;

/**
 * An edit mode engaged. Same uuid = the session continues (Vertices↔Faces
 * switches, the collider piece-add exit/enter dance); a DIFFERENT uuid seals
 * the old session first, so entries never mix across objects.
 * 99 K3: the same moments open and close the ONE edit session's shared part (`session`).
 * @param {'vertex'|'face'} kind @param {string} uuid @param {any} [object] the edited mesh
 */
export function noteEditEnter(kind, uuid, object) {
	if (kind === 'vertex') vertexOn = uuid;
	else faceOn = uuid;
	if (active && sessionUuid !== uuid) sealEditHistorySession();
	if (!active) {
		active = true;
		sessionUuid = uuid;
		colliderSession = false;
		beginHistorySession();
	}
	if (session.uuid !== uuid) openSession(uuid, object);
}

/** An edit mode disengaged. Deferred a tick — mode switches and the collider
 * piece-add dance exit one mode and re-enter within the same call chain, which
 * must NOT read as a session end (the colliderEdit watcher pattern).
 * @param {'vertex'|'face'} kind */
export function noteEditExit(kind) {
	if (kind === 'vertex') vertexOn = null;
	else faceOn = null;
	if (!active) return;
	setTimeout(() => {
		if (active && !vertexOn && !faceOn) sealEditHistorySession();
	}, 0);
}

/** colliderEdit marks its session right after entering face mode on the proxy */
export function markColliderHistorySession() {
	colliderSession = true;
}

/**
 * Seal the open session NOW (Done buttons, Escape handlers, the VR done path
 * and commitColliderEdit call this synchronously — the deferred watcher above
 * is only the backstop, so `exit…; undo()` back-to-back stays deterministic).
 * @param {'collapse'|'keep'|'discard'} [mode] default: 'discard' for collider
 * sessions, else 'collapse'
 */
export function sealEditHistorySession(mode) {
	if (!active) return;
	active = false;
	closeSession();
	const resolved = mode ?? (colliderSession ? 'discard' : 'collapse');
	colliderSession = false;
	sessionUuid = null;
	endHistorySession(resolved);
}

/** test/debug view */
export function editSessionDebug() {
	return {
		active,
		sessionUuid,
		colliderSession,
		vertexOn,
		faceOn,
		session: {
			uuid: session.uuid,
			hasEntry: !!session.entry,
			edited: sessionEdited(),
			kernel: !!session.kernelMaps,
			kernelMs: session.kernelMaps?.ms ?? null,
			selection: session.selection
		},
		lastLeave
	};
}

// ---- 99 K3: the shared part of the session ----------------------------------------------------
//
// ENTRY IS LOSSLESS. The session keeps the geometry it was entered on (the object, and each
// attribute with its `version`): a leave with nothing edited re-emits exactly those arrays —
// never the kernel's welded rebuild of them, which is equal only within the weld. "Edited" is any
// geometry swap (every commit, undo and peer apply goes through applyMeshGeo /
// applyGeometrySnapshot, which build a new geometry) or any in-place write (a vertex drag, a UV
// drag: their `needsUpdate` bumps the attribute's version).
//
// THE KERNEL is built after entry, off the main thread (meshSession.js, lazy), so entering costs
// what it did before. It is kept only while the geometry is still the one it was built from.

/** the last session's leave, for tests: { uuid, source: 'entry' | 'live', edited } */
/** @type {any} */
let lastLeave = null;
/** @type {any} the lazy kernel module once loaded */
let kernelModule = null;
/** @type {Promise<any> | null} the open session's kernel build (null when none was started) */
let kernelBuild = null;

/** @param {any} geometry @returns {any} */
export function captureEntry(geometry) {
	if (!geometry?.attributes?.position) return null;
	/** @type {Record<string, [any, number]>} */
	const attributes = {};
	for (const [name, attr] of Object.entries(geometry.attributes)) attributes[name] = [attr, /** @type {any} */ (attr).version];
	return { geometry, attributes, index: geometry.index ? [geometry.index, geometry.index.version] : null };
}

/** has `geometry` moved on from the entry snapshot? @param {any} entry @param {any} geometry */
export function geometryChanged(entry, geometry) {
	if (!entry) return false;
	if (geometry !== entry.geometry) return true;
	const names = Object.keys(geometry.attributes);
	if (names.length !== Object.keys(entry.attributes).length) return true;
	for (const name of names) {
		const held = entry.attributes[name];
		const attr = geometry.attributes[name];
		if (!held || held[0] !== attr || held[1] !== attr.version) return true;
	}
	const index = geometry.index;
	if (!!index !== !!entry.index) return true;
	return !!index && (entry.index[0] !== index || entry.index[1] !== index.version);
}

/** anything edited since the session opened */
export function sessionEdited() {
	return session.edited || geometryChanged(session.entry, session.object?.geometry);
}

/**
 * What a leave emits: the ENTRY geometry when nothing was edited (byte-identical to what was
 * entered, whatever the session built from it), else the live geometry.
 * @returns {{ source: 'entry' | 'live', edited: boolean, geometry: any }}
 */
export function leaveOutput() {
	const edited = sessionEdited();
	return edited
		? { source: 'live', edited, geometry: session.object?.geometry ?? null }
		: { source: 'entry', edited, geometry: session.entry?.geometry ?? null };
}

/** @param {string} uuid @param {any} object */
function openSession(uuid, object) {
	session.uuid = uuid;
	session.object = object ?? null;
	session.entry = captureEntry(object?.geometry);
	session.edited = false;
	session.kernel = null;
	session.kernelMaps = null;
	session.selection = { faces: [], verts: [], edges: [] };
	session.kernelStamp = null;
	session.opMesh = null;
	kernelBuild = null;
	loadKernelOps(); // 99 K4: the operators run on the kernel; load them while the user picks
	startKernel(uuid, object?.geometry);
}

/** @type {Promise<any> | null} */
let opsLoad = null;
/**
 * 99 K4: load the kernel operators (lazy chunk) onto the session. Every edit session starts it; the
 * agent tools and the debug hooks await it, so their synchronous operator calls always find it.
 * @returns {Promise<any>} the module
 */
export function loadKernelOps() {
	if (session.ops) return Promise.resolve(session.ops);
	opsLoad ??= import('./meshOps/index.js').then((m) => (session.ops = m));
	return opsLoad;
}

function closeSession() {
	if (!session.uuid) return;
	// a leave with nothing edited re-emits the entry arrays. Until the operators work on the kernel
	// (K4) nothing but an edit replaces the object's geometry, so they ARE the live geometry: the
	// re-emit writes nothing, and K4's kernel-backed apply inherits the rule
	const out = leaveOutput();
	lastLeave = { uuid: session.uuid, source: out.source, edited: out.edited };
	session.uuid = null;
	session.object = null;
	session.entry = null;
	session.edited = false;
	session.kernel = null;
	session.kernelMaps = null;
	session.kernelStamp = null;
	session.opMesh = null;
	kernelBuild = null;
}

/** the kernel build lives in the lazy meshSession.js (worker, size gate, keep-if-still-current)
 * @param {string} uuid @param {any} geometry */
function startKernel(uuid, geometry) {
	if (!geometry?.attributes?.position || typeof Worker === 'undefined') return;
	kernelBuild = import('./meshSession.js')
		.then((m) => (kernelModule = m).startSessionKernel(session, uuid, geometry, geometryChanged))
		.catch(() => null);
}

/** the open session's ID maps once built (null: none, superseded, or no Worker here) */
export function whenSessionKernel() {
	return kernelBuild ?? Promise.resolve(null);
}

/**
 * Store the selection being stashed as element IDs (99 K3) — on the session, via the lazy
 * meshSession.js. The index stash the caller keeps is still what restore reads (K4 moves restore
 * onto the IDs); a no-op until the kernel is ready, and once the geometry moved on.
 * @param {{ tris?: number[], handles?: number[][], edgeKeys?: string[] }} selection
 * @param {(x: number, y: number, z: number) => string} [keyOf] the editor's position key (edges)
 */
export function noteSelectionIds(selection, keyOf) {
	if (session.kernelMaps && kernelModule && !geometryChanged(session.kernelStamp ?? session.entry, session.object?.geometry))
		kernelModule.storeSelectionIds(session, selection, keyOf);
}
