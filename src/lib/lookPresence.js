// P2 (per-camera looks follow-up) — WATCH ADOPTS THE WATCHED PEER'S LOOK.
//
// THE GAP THIS FILLS. Watching a peer adopts their CAMERA (spectator mode parents our
// camera to their avatar) but not their LOOK STATE, so "watch" showed their viewpoint
// through OUR grading rules: our view mode, our local post kill switch, the camera WE
// were previewing (none, while watching) and our own `lookOverride` map. A peer looking
// through a hero camera with a `replace` look, or one whose Set Look node had switched
// the scene look off, was invisible from outside — and that silence is the P1 lesson
// exactly: a feature scoped to a viewpoint does nothing until that viewpoint is active,
// and from the watcher's seat it was never active.
//
// SO PRESENCE GAINS THE LOOK STATE, and it is deliberately the `campreview` shape (the
// `gamePresence` precedent, one domain over): a tiny per-peer message, a map keyed by
// peer id, a reply riding the `getmodulestate` request, dropped at every disconnect
// site. Ephemeral, never saved, never undone. ADDITIVE: a peer running an older build
// never sends one, its row stays ABSENT, and the watcher falls back to its own state —
// which is what it did before this module existed.
//
// WHAT IS DELIBERATELY NOT REPLICATED: adoption is scoped to the WATCH SESSION. Nothing
// here writes `viewMode`, `viewportOverrides` or `lookOverride` on the watcher — those
// are this viewer's own comfort settings — and leaving the watch restores the watcher's
// own resolution simply because Outline stops consulting the row. A watched peer in
// `wireframe` is adopted for the CHAIN only (post skips, as it does for them); the
// wireframe override material itself stays a local diagnostic.
//
// A LEAF as far as the history cycle is concerned: stores plus scenePost (which history's
// own subtree does not reach) and cameraPreview. Nothing here registers a history kind.

import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { viewMode } from '../stores/sceneStore';
import { viewportOverrides } from './viewportOverrides';
import { lookOverride } from './scenePost';
import { cameraPreview } from './cameraPreview';

/**
 * @typedef {{camera: string|null, mode: string, overrides: Record<string, boolean>, look: Record<string, boolean>}} LookState
 */

/** REMOTE peers only, `peerId -> LookState`. Absent = unknown = use our own.
 * @type {import('svelte/store').Writable<Record<string, LookState>>} */
export const peerLooks = writable({});

/** What we last put on the wire, so a store poke that changes nothing sends nothing.
 * Declared ABOVE the module-level subscribes below (the TDZ rule). */
let sentSignature = '';

/**
 * ONE normalizer at the boundary (the normalizeScenePost rule): a row from a newer
 * build keeps fields we do not know, a malformed one still reads as a usable state.
 * @param {any} raw @returns {LookState}
 */
export function normalizeLookState(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const overrides = source.overrides && typeof source.overrides === 'object' ? source.overrides : {};
	const look = source.look && typeof source.look === 'object' ? source.look : {};
	return {
		...source,
		camera: typeof source.camera === 'string' && source.camera ? source.camera : null,
		mode: typeof source.mode === 'string' && source.mode ? source.mode : 'shaded',
		overrides: { ...overrides },
		look: { ...look }
	};
}

/** This peer's OWN look state — the row a watcher would resolve from. */
export function myLookState() {
	const over = get(viewportOverrides);
	return normalizeLookState({
		camera: get(cameraPreview)?.uuid ?? null,
		mode: get(viewMode),
		// only the two layers a look is made of; the HUD is its own presence story
		overrides: { post: over.post !== false, shaders: over.shaders !== false },
		look: { ...get(lookOverride) }
	});
}

/** @param {LookState} state */
function broadcast(state) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.peer?.id) return;
	peer.send({ type: 'lookstate', peerId: peer.peer.id, ...state });
}

/** Publish our state when it CHANGES. @param {boolean} [force] send even if unchanged */
export function publishLookState(force = false) {
	const state = myLookState();
	const signature = JSON.stringify(state);
	if (!force && signature === sentSignature) return false;
	sentSignature = signature;
	broadcast(state);
	return true;
}

/**
 * Tell a newly connected peer how we are looking at the scene. Rides `getmodulestate`,
 * beside `sendCameraPreviewState`. Unconditional, unlike play mode: there is no state
 * that "absent" already describes here — a watcher with no row uses its OWN settings,
 * which may differ from ours in every field — and the message is under 200 bytes.
 */
export function sendLookState() {
	broadcast(myLookState());
}

/** Remote peer's state arrived (live change or handshake reply). @param {any} data */
export function applyRemoteLookState(data) {
	if (!data?.peerId) return;
	const state = normalizeLookState(data);
	peerLooks.update((map) => ({ ...map, [data.peerId]: state }));
}

/** A peer left: drop its row, so a watcher of a departed peer is never stranded on
 * their look. @param {string} peerId */
export function dropPeerLook(peerId) {
	peerLooks.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

/** The row a watcher resolves from, or null when the peer never told us (an older
 * build, or a peer we have not met) — in which case the caller uses its own state.
 * @param {string} peerId @returns {LookState|null} */
export function lookOf(peerId) {
	return get(peerLooks)[peerId] ?? null;
}

/**
 * One line for the watch banner, or '' when there is nothing to say. The P1 rule —
 * a scoped feature must say on its own surface when it cannot take effect — applied to
 * the two silent cases: the peer never shared a look state, or they have the scene look
 * switched off locally, so what we see through their eyes is deliberately ungraded.
 * @param {string} peerId
 */
export function watchLookNote(peerId) {
	const row = lookOf(peerId);
	if (!row) return 'showing your own look — they have not shared theirs';
	if (row.overrides.post === false) return 'they have the scene look switched off';
	return '';
}

// ---- outbound, on change ------------------------------------------------------
// Module-level subscribes run their callback SYNCHRONOUSLY at eval, which is why
// `sentSignature` is declared above them. Every callback is signature-gated, so the
// first (boot) run and any no-op poke send nothing; there is no peer at boot anyway.
if (typeof window !== 'undefined') {
	viewMode.subscribe(() => publishLookState());
	viewportOverrides.subscribe(() => publishLookState());
	lookOverride.subscribe(() => publishLookState());
	cameraPreview.subscribe(() => publishLookState());
}

/** test/debug view */
export function lookPresenceDebug() {
	return { mine: myLookState(), peers: { ...get(peerLooks) } };
}
