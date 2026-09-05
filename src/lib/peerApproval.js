import { get } from 'svelte/store';
import { peers, userdata, pendingApprovals, waitingForApproval, showToast } from '../stores/appStore';
import { sessionHost } from './connectionState';

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
	pendingApprovals.set(get(pendingApprovals).filter((/** @type {any} */ p) => p.peerId !== peerId));
	const users = /** @type {any[]} */ (get(userdata));
	if (!users.some((/** @type {any} */ u) => u[0] === peerId)) users.push([peerId, '', '']);
	userdata.set(/** @type {any} */ (users));
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	peer.send({ type: 'userdata', userdata: get(userdata) });
	peer.connectToPeer(peerId, true);
}

/**
 * Deny a pending request: drop it from the queue and close any lingering incoming
 * connection. The peer stays off the whitelist. @param {string} peerId
 */
export function denyPeer(peerId) {
	pendingApprovals.set(get(pendingApprovals).filter((/** @type {any} */ p) => p.peerId !== peerId));
	/** @type {any} */
	const peer = get(peers);
	peer?.connections?.[peerId]?.close?.();
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
 * @param {string} rawId @returns {Promise<void>}
 */
export async function requestConnect(rawId) {
	const peerId = String(rawId || '').toLowerCase();
	/** @type {any} */
	const peer = get(peers);
	if (!peer || !peerId) return;
	if (!peer.peer?.open) {
		showToast('Not connected to a signaling server yet — try again in a moment.');
		return;
	}
	dial(peerId);
}

/**
 * The dial itself: whitelist + broadcast the roster + open the DataConnection + queue the
 * pending entry. Split out of `requestConnect` so the guard above reads as one decision
 * and this stays exactly what it always did. @param {string} peerId
 */
function dial(peerId) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const users = /** @type {any[]} */ (get(userdata));
	if (!users.some((/** @type {any} */ u) => u[0] === peerId)) {
		users.push([peerId, '', '']);
		userdata.set(/** @type {any} */ (users));
		peer.send({ type: 'userdata', userdata: get(userdata) });
		peer.connectToPeer(peerId, true);
		const waiting = /** @type {any[]} */ (get(waitingForApproval));
		if (!waiting.some((/** @type {any} */ w) => w[0] === peerId)) waiting.push([peerId, 'pending']);
		waitingForApproval.set(/** @type {any} */ (waiting));
	} else {
		const pend = /** @type {any[]} */ (get(pendingApprovals));
		pend.push({ peerId, status: 'retry' });
		pendingApprovals.set(/** @type {any} */ (pend));
	}
}

/**
 * Cancel OUR pending outbound request (CN, roadmap #14): drop the
 * waitingForApproval entry, close + forget the never-opened conn (onConnClose sees
 * !openedPeers.has -> just re-checks locks), and un-whitelist the peer we
 * optimistically added at dial time. Deleting from `connections` stops the
 * restoreConnection retry loop too (its stale-conn guard). @param {string} peerId
 */
export function cancelOutboundRequest(peerId) {
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
