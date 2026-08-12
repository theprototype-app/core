import { beginHistorySession, endHistorySession } from './history';

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
 * @param {'vertex'|'face'} kind @param {string} uuid
 */
export function noteEditEnter(kind, uuid) {
	if (kind === 'vertex') vertexOn = uuid;
	else faceOn = uuid;
	if (active && sessionUuid !== uuid) sealEditHistorySession();
	if (!active) {
		active = true;
		sessionUuid = uuid;
		colliderSession = false;
		beginHistorySession();
	}
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
	const resolved = mode ?? (colliderSession ? 'discard' : 'collapse');
	colliderSession = false;
	sessionUuid = null;
	endHistorySession(resolved);
}

/** test/debug view */
export function editSessionDebug() {
	return { active, sessionUuid, colliderSession, vertexOn, faceOn };
}
