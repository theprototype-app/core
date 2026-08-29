import { writable, get } from 'svelte/store';

/**
 * Session-connection state (roadmap #14 CN). STORE-ONLY module (svelte/store only)
 * so peerHandler, commandsHandler and UI can all import it without closing a module
 * cycle — the peerApproval.js precedent.
 *
 * "Host" = the peer whose session we JOINED: set when our outbound connection
 * request gets approved (their side opens a connection back to us and our
 * waitingForApproval entry flips to 'approved'). Stays null when WE are the one
 * approving others — null while connected means "you are hosting".
 */

/** @type {import('svelte/store').Writable<string|null>} */
export const sessionHost = writable(null);

/** @type {import('svelte/store').Writable<Record<string, number>>} peerId -> joined-at ms */
export const peerJoinedAt = writable({});

/** Record when a peer's connection actually OPENED (first time only). @param {string} peerId */
export function markPeerJoined(peerId) {
	const map = get(peerJoinedAt);
	if (map[peerId]) return;
	peerJoinedAt.set({ ...map, [peerId]: Date.now() });
}

/** Forget a departed peer. @param {string} peerId */
export function dropPeerJoined(peerId) {
	const map = get(peerJoinedAt);
	if (!(peerId in map)) return;
	const next = { ...map };
	delete next[peerId];
	peerJoinedAt.set(next);
}

/** Full reset — leaving the session / cancelling out. */
export function resetSession() {
	sessionHost.set(null);
	peerJoinedAt.set({});
}

/**
 * R22 round 33 — THE CONNECT DECISION, WHILE IT IS OPEN.
 *
 * `{peerId}` from the moment the host approves us and we are asked what to do with the
 * work we are holding, until that question is truly answered — which INCLUDES the
 * Explorer naming interlude behind "Save scene & connect", because a scene half-named is
 * a decision half-made. Null the rest of the time.
 *
 * It lives here rather than in `sessions.js` for the reason this module exists at all: it
 * is read from the far side of the app (`sharedLibrary` holds its automatic downloads
 * while it is set — "it should not share or download any changes unless I choose") and a
 * store-only leaf is importable from anywhere without closing a cycle.
 * @type {import('svelte/store').Writable<{peerId: string} | null>}
 */
export const pendingConnectDecision = writable(null);

/**
 * R22 round 33 — THE OLD MERGE, KEPT AS AN OPT-IN.
 *
 * Two people both standing in UNTITLED scenes holding unmerged objects is a state with no
 * use, so connecting from one now asks the question that has an answer — save this scene,
 * or dismiss it — rather than the one that does not: merge two worlds neither of which has
 * a name. Turning this ON restores the classic Share / Stash ask verbatim.
 *
 * LOCAL and per-device, like every other preference about how this machine behaves: the
 * wire enforces nothing either way, and the round-30/31/32 gates are untouched by it —
 * they are the enforcement layer, and this only chooses which question is put.
 *
 * Default FALSE. It sits beside `sessionHost` because that is the fact it modifies the
 * handling of: the decision only ever applies to the peer whose session we joined.
 * @type {import('svelte/store').Writable<boolean>}
 */
export const mergeOnConnect = writable(readMergeOnConnect());

/** localStorage can throw (SSR, a locked-down profile) — an unreadable pref is the
 * default, never a crash. The `readFlag` idiom from sharedLibrary. */
function readMergeOnConnect() {
	try {
		return localStorage.getItem('connect:mergeOnConnect') === 'true';
	} catch {
		return false;
	}
}

// Declared BELOW everything it reads (the module-level-subscribe rule) — though this
// callback only ever reads its own argument, so it is safe wherever it sits.
mergeOnConnect.subscribe((v) => {
	try {
		localStorage.setItem('connect:mergeOnConnect', String(v));
	} catch {}
});
