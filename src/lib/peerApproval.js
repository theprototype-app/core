import { get } from 'svelte/store';
import { peers, userdata, pendingApprovals, waitingForApproval, showToast } from '../stores/appStore';
import {
	sessionHost,
	APPROVAL_WINDOW_MS,
	HARD_PEER_CAP,
	noteApprovalStarted,
	clearApprovalStarted,
	roomIsFull,
	isRefusal,
	noteJoinRefusal,
	clearJoinRefusal
} from './connectionState';

// Pending-connection approval (211). Kept in its own store-only module so VR
// (vrControls -> executeVRMenuAction) can call it WITHOUT statically importing
// peerHandler, which would close a module cycle and TDZ-crash the SSR prerender
// (see CLAUDE.md "Module cycles"). Mirrors the desktop Toasts approval card so
// both routes accept/reject through the same steps.

/**
 * Approve a pending request: whitelist the peer, broadcast the updated whitelist
 * and connect back (the requester already whitelisted us). @param {string} peerId
 */
export function approvePeer(peerId) {
	/** @type {any} */
	const peer = get(peers);
	// 25-F: past the hard cap an approval is a refusal the joiner can HEAR. The desktop card
	// offers "Tell them it's full" itself; this is the path every other caller takes (the
	// VR panel's yes, a plugin), which used to approve straight past the cap.
	if (peer && roomIsFull(peer)) {
		denyPeer(peerId, 'full');
		showToast('This session is full (' + HARD_PEER_CAP + ' people) — ' + label(peerId) + ' was told.');
		return;
	}
	pendingApprovals.set(get(pendingApprovals).filter((/** @type {any} */ p) => p.peerId !== peerId));
	clearApprovalStarted(peerId);
	const users = /** @type {any[]} */ (get(userdata));
	if (!users.some((/** @type {any} */ u) => u[0] === peerId)) users.push([peerId, '', '']);
	userdata.set(/** @type {any} */ (users));
	if (!peer) return;
	peer.send({ type: 'userdata', userdata: get(userdata) });
	// 25-F: the dial-back SAYS it is an approval (older peers still read the conn alone)
	if (typeof peer.approveDialBack === 'function') peer.approveDialBack(peerId);
	else peer.connectToPeer(peerId, true);
}

/** @param {string} peerId */
function label(peerId) {
	return String(peerId).slice(0, 6).toUpperCase();
}

/**
 * Deny a pending request: drop it from the queue and close any lingering incoming
 * connection. The peer stays off the whitelist.
 *
 * 25-F: and TELL them, when their dial said they can hear it (`hearsNo` on the card) — a
 * short refusal dial whose metadata is the answer. A joiner that did not say so is an
 * older build, which reads ANY incoming conn from the host as an approval, so it gets the
 * old silence and its own 90 s expiry rather than a false "approved".
 * @param {string} peerId @param {'denied' | 'full'} [result]
 */
export function denyPeer(peerId, result = 'denied') {
	const card = /** @type {any[]} */ (get(pendingApprovals)).find((p) => p.peerId === peerId);
	pendingApprovals.set(get(pendingApprovals).filter((/** @type {any} */ p) => p.peerId !== peerId));
	clearApprovalStarted(peerId);
	/** @type {any} */
	const peer = get(peers);
	peer?.connections?.[peerId]?.close?.();
	if (card?.hearsNo && typeof peer?.sendJoinResult === 'function') peer.sendJoinResult(peerId, result);
}

/**
 * 25-F — the JOINER's half: the host said no (or that the room is full). End the request
 * exactly as a cancel does (the waiting row, the optimistic whitelist row, the timer, the
 * never-open conn) and say which it was. A refusal from a peer we are NOT waiting on —
 * a second approver after we joined, or an answer that outlived our own 90 s expiry — is
 * ignored: nothing is pending, so there is nothing to end and nobody to tell.
 * @param {string} peerId @param {any} result @returns {boolean} whether it ended a request
 */
export function applyJoinRefusal(peerId, result) {
	if (!isRefusal(result)) return false;
	const waiting = /** @type {any[]} */ (get(waitingForApproval));
	if (!waiting.some((/** @type {any} */ w) => w[0] === peerId && w[1] === 'pending')) return false;
	cancelOutboundRequest(peerId);
	noteJoinRefusal(peerId, result);
	if (result === 'full') {
		showToast(label(peerId) + "'s session is full (" + HARD_PEER_CAP + ' people). Try again when someone leaves.', [
			{ label: 'Try again', action: () => requestConnect(peerId) }
		]);
	} else {
		showToast(label(peerId) + ' declined your connection request.');
	}
	return true;
}

/**
 * Wait for the scene to acquire a NAME, which is what the Explorer's inline save writes
 * into `currentLevel`. Resolves true the moment one lands, false if the user walks away
 * from the naming — nothing proceeds on a scene that was never saved.
 *
 * The subscribe fires immediately with the CURRENT value, which the caller has already
 * established is unnamed, so the first callback can never settle this. The unsubscribe is
 * deferred a microtask anyway, because settling from inside that synchronous first call
 * would reach `unsub` before the assignment.
 *
 * R22 round 33 — EXPORTED. The dial-time ask this was written for is gone (see
 * `requestConnect`), and the naming handoff it implements moved to the far end of the
 * connection, where `sessions.js` runs it for "Save scene & connect". The machinery is
 * unchanged; only its caller moved.
 * @param {import('svelte/store').Readable<any>} currentLevel
 * @returns {Promise<boolean>}
 */
export function waitForSceneName(currentLevel) {
	return new Promise((resolve) => {
		/** @type {(() => void) | null} */
		let unsub = null;
		let settled = false;
		/** @param {boolean} ok */
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			queueMicrotask(() => {
				try {
					unsub?.();
				} catch {
					/* already gone */
				}
			});
			resolve(ok);
		};
		// a cap, so an abandoned naming eventually drops the subscription instead of
		// holding it for the life of the tab. Generously long: this is somebody typing.
		const timer = setTimeout(() => finish(false), 5 * 60 * 1000);
		unsub = currentLevel.subscribe((at) => {
			if (String(at?.name ?? '').trim()) finish(true);
		});
	});
}

/**
 * WAIT FOR THE MODAL TO REALLY BE GONE, because closing a <dialog> RESTORES FOCUS to
 * whatever held it before — and ConfirmModal is the app's one truly modal dialog. Arm the
 * naming card before that restore lands and the user is handed a field that looks ready
 * and swallows every keystroke: measured, the card mounted with document.activeElement on
 * BODY, while the identical arm with no modal in the way focuses every time.
 *
 * Waiting on the DOM rather than on a timer because a timer is a bet on load: two frames
 * lost everywhere, and 300ms won on an idle page and in a two-page probe but lost again
 * inside the full suite, which is the shape of a bet. The modal's own
 * Cancel button is the signal — it is minted by ConfirmModal and by nothing else, so its
 * absence IS "unmounted", and by then close() has already moved the focus. Capped, so a
 * dialog that somehow lingers costs a beat and not the connection.
 *
 * R22 round 33 — EXPORTED for the same reason as `waitForSceneName` above: the modal that
 * hands over to the naming card is the CONNECT DECISION now, and it lives in sessions.js.
 * The measurement and the reasoning are unchanged.
 * @returns {Promise<void>}
 */
export function modalClosed() {
	return new Promise((resolve) => {
		if (typeof document === 'undefined') return resolve(undefined);
		const started = Date.now();
		const poll = () => {
			if (!document.getElementById('confirm-dialog-cancel') || Date.now() - started > 3000) {
				resolve(undefined);
				return;
			}
			setTimeout(poll, 30); // not rAF: a backgrounded tab would stop polling entirely
		};
		poll();
	});
}

/**
 * R22 round 33 — THE DIAL ASKS NOTHING. THE DECISION MOVED TO THE APPROVAL.
 *
 * Round 31 put a question here: dialing with WORK in an UNNAMED scene asked Save & connect
 * / Connect anyway / Cancel, so that the unresolvable room ("nobody can be somewhere
 * else") became a named one while there was still a person there to answer. The question
 * was right and the MOMENT was wrong, in three ways that only showed up in use:
 *
 *   · it asked before there was anything to decide about. A dial is a request; the answer
 *     may be minutes away, may be a refusal, and until it lands there is no other world.
 *     Being made to name a scene to ASK is a toll on a door that may not open.
 *   · "Connect anyway" was an answer to nothing — the merge it waved through is decided on
 *     the far side, by the share-or-stash gate, seconds later.
 *   · the invite LINK never came through here at all, so the two ways into a session put
 *     two different questions. One path now, and it is the same for both.
 *
 * So this dials, and the decision is taken where the facts are known: when the host has
 * APPROVED and its handshake tells us whose scene we are about to stand in
 * (`deferUntilShareChoice` in sessions.js — "<name> approved your connection": Save scene
 * & connect / Dismiss changes / Disconnect). The naming machinery above is unchanged and
 * is now exported for that caller.
 *
 * The peers/signaling guards stay exactly here: an offline dial must still say so
 * immediately, and it costs nothing to ask before opening a connection that cannot open.
 * Still `async` so the cloud plugin's `connectToPeer` keeps returning a promise; the body
 * has no awaits, so every dial happens in the same tick.
 * @param {string} rawId @param {any} [cloudMeta] 29: a cloud plugin's dial data (see dialOptions)
 * @returns {Promise<void>}
 */
export async function requestConnect(rawId, cloudMeta) {
	const peerId = String(rawId || '').toLowerCase();
	/** @type {any} */
	const peer = get(peers);
	if (!peer || !peerId) return;
	if (!peer.peer?.open) {
		showToast('Not connected to a signaling server yet — try again in a moment.');
		return;
	}
	dial(peerId, cloudMeta);
}

/**
 * The dial itself: whitelist + broadcast the roster + open the DataConnection + queue the
 * pending entry. Split out of `requestConnect` so the guard above reads as one decision
 * and this stays exactly what it always did. @param {string} peerId
 * @param {any} [cloudMeta] 29: the plugin's dial data, remembered per peer for re-dials
 */
function dial(peerId, cloudMeta) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	// 29: remember the plugin's dial data for this peer's join dials (and their restores)
	const cloud = boundCloudMeta(cloudMeta);
	if (cloud !== undefined) (peer.dialCloud ??= new Map()).set(peerId, cloud);
	else peer.dialCloud?.delete(peerId);
	clearJoinRefusal(); // 25-F: a new request replaces the last answer on the pill
	const users = /** @type {any[]} */ (get(userdata));
	if (!users.some((/** @type {any} */ u) => u[0] === peerId)) {
		users.push([peerId, '', '']);
		userdata.set(/** @type {any} */ (users));
		peer.send({ type: 'userdata', userdata: get(userdata) });
		peer.connectToPeer(peerId, true);
		const waiting = /** @type {any[]} */ (get(waitingForApproval));
		if (!waiting.some((/** @type {any} */ w) => w[0] === peerId)) waiting.push([peerId, 'pending']);
		waitingForApproval.set(/** @type {any} */ (waiting));
		// 27-E: a request that can hang forever is the worst of the three states a dial can
		// be in — "no" at least ends. Stamp the shared clock (the pill's countdown reads it)
		// and arm the expiry.
		noteApprovalStarted(peerId);
		armApprovalTimeout(peerId);
	} else {
		const pend = /** @type {any[]} */ (get(pendingApprovals));
		pend.push({ peerId, status: 'retry' });
		pendingApprovals.set(/** @type {any} */ (pend));
	}
}

/** 29: a plugin's dial data, bounded — plain JSON under 1 KB, else nothing.
 * @param {any} cloud @returns {any} */
function boundCloudMeta(cloud) {
	if (cloud === undefined || cloud === null) return undefined;
	try {
		const s = JSON.stringify(cloud);
		return s && s.length <= 1024 ? JSON.parse(s) : undefined;
	} catch {
		return undefined;
	}
}

/** @type {Map<string, any>} one expiry timer per outbound request */
const approvalTimers = new Map();

/**
 * 27-E: end the wait. The window is the SAME constant the host's card ages against, so
 * the two sides never disagree about whether a request is still live.
 * @param {string} peerId
 */
function armApprovalTimeout(peerId) {
	clearApprovalTimeout(peerId);
	approvalTimers.set(
		peerId,
		setTimeout(() => {
			approvalTimers.delete(peerId);
			// still pending? (approval clears the row, so this is the only way to be here)
			const waiting = /** @type {any[]} */ (get(waitingForApproval));
			if (!waiting.some((/** @type {any} */ w) => w[0] === peerId && w[1] === 'pending')) return;
			cancelOutboundRequest(peerId);
			const label = String(peerId).slice(0, 6).toUpperCase();
			showToast(label + ' did not answer in ' + Math.round(APPROVAL_WINDOW_MS / 1000) + 's.', [
				{ label: 'Try again', action: () => requestConnect(peerId) }
			]);
		}, APPROVAL_WINDOW_MS)
	);
}

/** @param {string} peerId */
export function clearApprovalTimeout(peerId) {
	const t = approvalTimers.get(peerId);
	if (t) clearTimeout(t);
	approvalTimers.delete(peerId);
	// 27-E: cancelling a TIMER is not ending a REQUEST, so the clock STAYS here.
	// `armApprovalTimeout` calls this defensively to avoid a duplicate timer, and
	// clearing the stamp here deleted it one line after `dial` wrote it — so every
	// outbound request lost its countdown, and the two sides disagreed about the
	// age of the same request. The paths that really END a request clear it.
}

/**
 * 27-E: the peer is not online at all — peerjs says so through `peer-unavailable`. The
 * pill used to stay on "Requesting" beside a toast saying the opposite, and the whitelist
 * row we added optimistically at dial time stayed forever. End it now; the caller owns
 * the message, since only it knows whether this id was ever plausible.
 * @param {string} peerId
 */
export function abandonOutboundRequest(peerId) {
	const waiting = /** @type {any[]} */ (get(waitingForApproval));
	if (!waiting.some((/** @type {any} */ w) => w[0] === peerId)) return false;
	cancelOutboundRequest(peerId);
	return true;
}

/**
 * Cancel OUR pending outbound request (CN, roadmap #14): drop the
 * waitingForApproval entry, close + forget the never-opened conn (onConnClose sees
 * !openedPeers.has -> just re-checks locks), and un-whitelist the peer we
 * optimistically added at dial time. Deleting from `connections` stops the
 * restoreConnection retry loop too (its stale-conn guard). @param {string} peerId
 */
export function cancelOutboundRequest(peerId) {
	clearApprovalTimeout(peerId); // 27-E: no orphan timer, no stale countdown
	clearApprovalStarted(peerId); // and the request really is over, so drop the clock
	waitingForApproval.set(
		get(waitingForApproval).filter((/** @type {any} */ w) => w[0] !== peerId)
	);
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (peer && conn) delete peer.connections[peerId]; // BEFORE close: stale-guard no-ops the event
	try { conn?.close?.(); } catch { /* already gone */ }
	userdata.set(get(userdata).filter((/** @type {any} */ u) => u[0] !== peerId));
	if (get(sessionHost) === peerId) sessionHost.set(null);
	if (peer) peers.update((v) => v);
}
