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

/**
 * 27-F: the signaling link's retry state, for the Connect pill's chip (audit H2).
 * A STORE rather than a toast per attempt: an unbounded retry toasting each time is
 * spam, while a chip is a state you can look at. peerHandler already imports this
 * leaf, so surfacing it costs no new module edge.
 * @type {import('svelte/store').Writable<{retrying: boolean, attempt: number}>}
 */
export const signalingRetry = writable({ retrying: false, attempt: 0 });

/** @param {number} attempt */
export function noteSignalingRetry(attempt) {
	signalingRetry.set({ retrying: true, attempt });
}

/** The link is back (or we gave the peer up) — clear the chip. */
export function clearSignalingRetry() {
	const now = get(signalingRetry);
	if (!now.retrying && now.attempt === 0) return;
	signalingRetry.set({ retrying: false, attempt: 0 });
}

/**
 * 27-E (roadmap 25) — HOW LONG AN APPROVAL MAY HANG, on BOTH sides of it.
 *
 * Today it hangs forever: a joiner sits on "Requesting AB12" with no countdown and no
 * end, and a host who walked away collects cards without bound. 90 s is a human act — the
 * host may be in a headset, on another tab, or mid-gesture — while past about two minutes
 * the joiner has stopped watching and a dial-back lands in a tab that has moved on. ONE
 * constant, so the pill's countdown and the card's age can never disagree.
 */
export const APPROVAL_WINDOW_MS = 90_000;

/** Beyond this many cards the oldest EXPIRED ones are dropped first, then the oldest
 * pending — bounding the array `handleConnection` pushes into (audit H3). */
export const MAX_PENDING_APPROVALS = 12;

/**
 * 27-E — SESSION SIZE. The mesh is FULL: every peer holds N-1 data connections and, with
 * voice on, N-1 media connections, and every mutation fans out N-1 times. 10 is the
 * tested target; 8 is the default because the costs that bite first (voice encoders,
 * presence streams) are per-peer and land hardest on the slowest device in the room.
 * SOFT warns and still approves; HARD refuses, because past it the session degrades for
 * everyone rather than only for the person who just joined.
 */
export const SOFT_PEER_CAP_DEFAULT = 8;
export const HARD_PEER_CAP = 16;

/**
 * How many people are in the session, counting YOURSELF.
 *
 * `openedPeers` is the set of peers whose data channel is actually open. `userdata` is
 * the WHITELIST, and it is written at DIAL time — so it counts everyone who was ever
 * invited, including people who never arrived and people who have since left. Counting
 * it means a host who dialled sixteen names refuses every approval while sitting alone.
 * That trap is documented in this repo and this batch walked straight into it in four
 * places, which is why the arithmetic now lives here and nowhere else.
 *
 * Pure and peer-SHAPED rather than a derived store, so every caller can pass whatever it
 * already holds: the store value in a component, or `this` inside PeerConnection.
 * @param {{ openedPeers?: { size?: number } } | null | undefined} peers
 */
export function sessionSize(peers) {
	return (peers?.openedPeers?.size ?? 0) + 1;
}

/** True when one more person would take the mesh past what it can carry (audit L7).
 * @param {{ openedPeers?: { size?: number } } | null | undefined} peers */
export function roomIsFull(peers) {
	return sessionSize(peers) >= HARD_PEER_CAP;
}

function readSoftCap() {
	if (typeof localStorage === 'undefined') return SOFT_PEER_CAP_DEFAULT;
	const raw = Number(localStorage.getItem('connect:softPeerCap'));
	return Number.isFinite(raw) && raw >= 2 && raw <= HARD_PEER_CAP ? raw : SOFT_PEER_CAP_DEFAULT;
}

/** LOCAL, like every other connection preference. @type {import('svelte/store').Writable<number>} */
export const softPeerCap = writable(readSoftCap());
softPeerCap.subscribe((v) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('connect:softPeerCap', String(v));
});

/**
 * When each pending request started, keyed by peer id — the ONE clock the joiner's
 * countdown and the host's card age both read. A map rather than a field on the request
 * rows, because those rows are plain arrays and objects that several modules already write.
 * @type {import('svelte/store').Writable<Record<string, number>>}
 */
export const approvalStartedAt = writable({});

/** @param {string} peerId */
export function noteApprovalStarted(peerId) {
	approvalStartedAt.update((m) => (m[peerId] ? m : { ...m, [peerId]: Date.now() }));
}

/** @param {string} peerId */
export function clearApprovalStarted(peerId) {
	approvalStartedAt.update((m) => {
		if (!(peerId in m)) return m;
		const next = { ...m };
		delete next[peerId];
		return next;
	});
}

/** Milliseconds left in a request's window, 0 once it has expired.
 * Takes `undefined` because callers look the stamp up in `approvalStartedAt` BY PEER ID
 * and a miss is ordinary — an absent stamp reads as expired, which is the safe direction.
 * @param {number | undefined} startedAt */
export function approvalRemaining(startedAt) {
	return Math.max(0, APPROVAL_WINDOW_MS - (Date.now() - (startedAt || 0)));
}

/** Full reset — leaving the session / cancelling out. */
export function resetSession() {
	sessionHost.set(null);
	peerJoinedAt.set({});
	approvalStartedAt.set({}); // 27-E: no request survives leaving the session
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
