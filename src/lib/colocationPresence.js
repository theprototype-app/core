// CO5 — WHO IS IN THE ROOM WITH ME, and what stops being rendered because of it.
//
// CO1 computes each device's private tracking -> room transform and CO2 runs the ritual
// that mints it. Both are about GEOMETRY. This module is about the consequence: once two
// peers are standing in the same physical room, their avatars and their voices are
// DUPLICATES of the real people in front of them — a floating head hanging where the
// actual person's head is, and their words arriving twice (once through the air, ~5ms,
// once through WebRTC, ~60ms, which is late enough to read as an echo rather than as a
// voice). So a colocated pair hides only EACH OTHER.
//
// THE INVARIANT, and it is the whole design. Everything here is LOCAL RECEIVE-SIDE
// FILTERING keyed by MY roomKey matching THEIRS. Nothing about what a peer BROADCASTS
// changes: two colocated peers still send full presence, full hand poses and full audio,
// so a REMOTE third peer sees both bodies and hears both voices exactly as before. A
// suite asserts that three-peer shape, because the tempting alternative — "stop sending
// presence to my room-mate" — would have been cheaper on the wire and would have made
// the remote peer's view depend on a private fact about two other people's furniture.
//
// THE WIRE IS `gamePresence.js`'s SHAPE, deliberately, down to the details that look
// like details:
//   · a tiny per-peer message (`{type:'colocated', peerId, roomKey}`) sent ON CHANGE
//     only, latest-wins per peer;
//   · ABSENT MEANS NOT COLOCATED, so the map records only real keys and a peer running
//     an older build (which never sends one) reads as not colocated, which is what it is;
//   · the late-joiner reply rides the `getmodulestate` request, beside
//     `sendPlayModeState` / `sendPeerVarsState` / `sendCameraPreviewState` — that request
//     is already the app's one PER-PEER presence vehicle and carries three non-module
//     payloads today, so this needs no new handshake `get*`;
//   · dropped at all THREE disconnect sites (the relayed `disconnected` rumor,
//     `finalizeDisconnect`, `leaveSession`), because presence is per-peer state and
//     golden rule 3 asks for the cleanup.
// The one difference from playmode is the payload: a MODE is an enum, a roomKey is an
// opaque string, so the compare is `===` against my own key rather than a whitelist.
//
// WHY THE KEY AND NOT THE ANCHOR. `roomAnchor` is scene state — where the room origin
// sits in content coords — and two peers can share it while standing in different
// buildings (a joiner inherits it from the handshake). Being in the same ROOM is
// `roomAlignment.roomKey` matching, which is exactly the fact CO1 kept local and CO2
// makes the user confirm. Anchor equality would have hidden avatars between peers who
// have never met.
//
// NO `canApply` ENTRY, which is mirroring `playmode` exactly rather than forgetting it:
// the ALWAYS_ALLOWED floor exists for full-state REQUESTS a peer cannot sync without, and
// presence is ordinary gateable content. A gated peer simply is not hidden or muted for
// us, which is the same conservative failure the rest of the presence family has.
//
// A LEAF: svelte stores plus `colocation` (itself a leaf) and appStore. Nothing here is
// reachable from history's import subtree and nothing here registers a history kind —
// colocated presence is runtime device state, so there is nothing to undo and nothing to
// save (the CO1 ruling, restated one domain over).

import { writable, derived, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { roomAlignment, roomKey } from './colocation';

/** REMOTE peers only, `peerId -> roomKey`. A peer NOT in this map is not colocated —
 * absence is the single representation of that, so nothing ever writes a null row.
 * @type {import('svelte/store').Writable<Record<string, string>>} */
export const peerColocation = writable({});

/**
 * FAINT GHOST HANDS for a colocated peer: ON by default (the locked fork), local
 * preference. Hands are the one part of a colocated avatar worth keeping — a controller
 * or a tracked hand is where a person is POINTING, which is how you say "that one" about
 * a virtual object standing on a real table, and in passthrough your partner's real
 * hands are visible but the thing they hold is not.
 * @type {import('svelte/store').Writable<boolean>} */
export const colocatedGhostHands = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('colocatedGhostHands') !== 'false'
);

/** How faint. Low enough to read as a hint rather than as an avatar, high enough to
 * survive passthrough's washed-out contrast (the number itself is the user's on-device
 * check — there is no headless judgement of "faint"). */
export const GHOST_HAND_OPACITY = 0.28;

// ---- my own state ---------------------------------------------------------------

/**
 * THE room key that makes me colocated, or null.
 *
 * Read off `roomAlignment`, not off the `roomKey` store: a key with no alignment means
 * a ritual is being SET UP (CO2 mints the key first) and nothing is aligned yet, so
 * hiding a peer's body then would blank an avatar before the world had moved. Alignment
 * with no key is equally not colocation — there is nothing for a peer to match.
 * @returns {string|null}
 */
export function myRoomKey() {
	const alignment = /** @type {any} */ (get(roomAlignment));
	const key = alignment?.roomKey;
	return typeof key === 'string' && key ? key : null;
}

/** @param {string} peerId @returns {string|null} that peer's room, or null */
export function roomOf(peerId) {
	const key = get(peerColocation)[peerId];
	return typeof key === 'string' && key ? key : null;
}

/**
 * Am I colocated with this peer? The ONE decision every consumer asks, non-reactively
 * (voiceChat reads it from a subscriber; the components read the derived set below).
 * @param {string} peerId
 */
export function isColocatedWith(peerId) {
	const mine = myRoomKey();
	return !!mine && roomOf(peerId) === mine;
}

/**
 * THE SET the renderers filter against: peers whose key is non-null AND equal to mine.
 * My key being null makes it empty by construction, which is the "a remote peer is
 * completely unaffected" half of the invariant — a peer who never colocated computes an
 * empty set no matter how many colocated pairs it is watching.
 *
 * Derived over BOTH stores because both can move the answer: a row arriving/leaving, and
 * my own alignment being installed or dropped.
 * @type {import('svelte/store').Readable<Set<string>>} */
export const colocatedPeers = derived([peerColocation, roomAlignment], ([map, alignment]) => {
	/** @type {Set<string>} */
	const out = new Set();
	const mine = /** @type {any} */ (alignment)?.roomKey;
	if (typeof mine !== 'string' || !mine) return out;
	for (const [peerId, key] of Object.entries(map)) if (key === mine) out.add(peerId);
	return out;
});

// ---- outbound -------------------------------------------------------------------

/** What we last put on the wire, so a two-store write (setRoomAlignment writes the
 * alignment AND the key) is ONE message. It starts null — the state every session starts
 * in — so the subscribes' immediate first callback publishes NOTHING: absent already
 * means not colocated, and announcing it at boot would put a message on the wire for
 * every peer in the app's overwhelmingly common state.
 * @type {string|null} */
let sentKey = null;

/** @param {string|null} key */
function broadcast(key) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.peer?.id) return;
	peer.send({ type: 'colocated', peerId: peer.peer.id, roomKey: key });
}

/**
 * Publish our room when it CHANGES. Leaving colocation is an explicit `roomKey: null`
 * rather than silence, because a peer already holding our row has to hear that it is
 * gone — the same reason `clearRoomAnchor` writes an identity record instead of deleting.
 * @param {boolean} [force] send even if unchanged
 */
export function publishColocation(force = false) {
	const key = myRoomKey();
	if (!force && key === sentKey) return false;
	sentKey = key;
	broadcast(key);
	return true;
}

/**
 * Tell a newly connected peer where we are — only while COLOCATED, since absent already
 * means not colocated and an unconditional reply would put a message on the wire for the
 * common case that carries no information. Rides `getmodulestate`, the app's one
 * per-peer presence vehicle (beside sendPlayModeState / sendPeerVarsState).
 */
export function sendColocationState() {
	const key = myRoomKey();
	if (key) broadcast(key);
}

// ---- inbound --------------------------------------------------------------------

/** @param {any} data @returns {boolean} whether it was applied */
export function applyRemoteColocation(data) {
	if (!data?.peerId) return false;
	const key = typeof data.roomKey === 'string' && data.roomKey ? data.roomKey : null;
	peerColocation.update((map) => {
		// not-colocated is recorded by DELETING the row: one representation instead of
		// two that can disagree (the applyRemotePlayMode rule)
		if (!key) {
			if (!(data.peerId in map)) return map;
			const next = { ...map };
			delete next[data.peerId];
			return next;
		}
		if (map[data.peerId] === key) return map;
		return { ...map, [data.peerId]: key };
	});
	return true;
}

/** A peer left the SESSION. @param {string} peerId */
export function dropPeerColocation(peerId) {
	peerColocation.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

// ---- wiring ---------------------------------------------------------------------

/** @type {(()=>void)[]} */
let disposers = [];

/**
 * Install the presence broadcast. Idempotent, and the subscribes live HERE rather than
 * at module scope: a module-level subscribe runs its callback SYNCHRONOUSLY at module
 * eval, and anything it reads that is declared below TDZ-crashes the SSR prerender (the
 * documented meshEdit/faceEdit trap). Both stores are watched because
 * `setRoomAlignment` writes them in sequence and either could be the one that changes
 * the answer; the `sentKey` gate collapses the pair into one message.
 */
export function startColocationPresence() {
	if (disposers.length) return;
	disposers.push(roomAlignment.subscribe(() => publishColocation()));
	disposers.push(roomKey.subscribe(() => publishColocation()));
}

/** Test seam. */
export function stopColocationPresence() {
	for (const dispose of disposers) dispose();
	disposers = [];
}

/** test/debug view */
export function colocationPresenceDebug() {
	return {
		wired: disposers.length > 0,
		mine: myRoomKey(),
		sentKey,
		peers: { ...get(peerColocation) },
		colocated: [...get(colocatedPeers)],
		ghostHands: get(colocatedGhostHands)
	};
}

/** Test seam: forget the map and the sent-state without touching the wire. */
export function resetColocationPresence() {
	peerColocation.set({});
	sentKey = null;
}

// LOCAL preference, persisted like every other view/VR pref (the showColliders shape).
// Declared last so nothing above it can be read by this subscriber before its `let`s
// exist — the same TDZ rule the wiring comment states.
colocatedGhostHands.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('colocatedGhostHands', String(value));
});
