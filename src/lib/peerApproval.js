import { get } from 'svelte/store';
import { peers, userdata, pendingApprovals, waitingForApproval, showToast, explorerClose, armExplorerSceneSave } from '../stores/appStore';
import { objectsGroup } from '../stores/sceneStore';
import { bottomDockActive } from './bottomDock';
import { showChoice } from './confirmDialog';
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
 * from the naming — nothing is dialled on a scene that was never saved.
 *
 * The subscribe fires immediately with the CURRENT value, which the caller has already
 * established is unnamed, so the first callback can never settle this. The unsubscribe is
 * deferred a microtask anyway, because settling from inside that synchronous first call
 * would reach `unsub` before the assignment.
 * @param {import('svelte/store').Readable<any>} currentLevel
 * @returns {Promise<boolean>}
 */
function waitForSceneName(currentLevel) {
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
 * `levels` is reached through a DYNAMIC import: this module is deliberately store-only
 * (vrControls reaches it without importing peerHandler — see the header), and levels
 * pulls in the whole sessions/history family, which a static edge would drag in with it.
 *
 * PRIMED, and memoised, for the reason the Inspector primes carveActions: the press that
 * needs it is a button press, and a cold import measured 0.3-0.9s on an idle box and
 * longer on a loaded one — long enough that Connect would feel dead before the question
 * appears. Nothing awaits it here, and the app loads levels at boot anyway.
 * @type {Promise<any> | null}
 */
let levelsPrimed = null;
const loadLevels = () => (levelsPrimed ??= import('./levels'));
if (typeof window !== 'undefined') void loadLevels().catch(() => {});

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
 * @returns {Promise<void>}
 */
function modalClosed() {
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
 * The dial-time question: may we connect from here? See `requestConnect` for why it
 * exists. Returns true for "dial now", false for "the user said no, or is still naming".
 * @returns {Promise<boolean>}
 */
async function settleSceneIdentity() {
	const group = /** @type {any} */ (get(objectsGroup));
	const count = group?.children?.length ?? 0;
	if (count === 0) return true; // nothing at stake, and adoption will name us
	/** @type {any} */
	let levels;
	try {
		levels = await loadLevels();
	} catch {
		return true; // never let a failed import stop somebody connecting
	}
	if (String(get(levels.currentLevel)?.name ?? '').trim()) return true;

	const objects = count + ' object' + (count === 1 ? '' : 's');
	const answer = await showChoice({
		title: 'This scene has no name yet',
		message:
			'You have ' +
			objects +
			' in an unsaved scene. Peers tell worlds apart by scene NAME, so until this one is saved you and everybody you connect to count as one shared room — nobody can be somewhere else.',
		choices: [
			{ value: 'save', label: 'Save & connect' },
			{ value: 'anyway', label: 'Connect anyway' }
		],
		cancelLabel: 'Cancel'
	});
	if (answer === 'anyway') return true;
	if (answer !== 'save') return false; // Cancel, Esc, outside-close — dial nothing

	await modalClosed();
	// The naming is the EXISTING flow, armed the way projectFile's bootstrap arms it:
	// open the Explorer and make it the VISIBLE dock panel (its comment: "if it is docked,
	// make it the visible panel" — the card is useless behind the Flow tab), then hand it
	// the write-once request and let it own the input. Inventing a default name here would
	// be worse than not asking.
	explorerClose.set(false);
	bottomDockActive.set('explorer');
	armExplorerSceneSave(null);
	showToast('Name your scene in the Explorer — the connection request goes out as soon as it is saved.');
	return waitForSceneName(levels.currentLevel);
}

/**
 * R22 round 31 — RESOLVE THE UNNAMED ROOM BEFORE THE DIAL.
 *
 * REPORTED: a peer edits an untitled scene, connects to a host standing in a saved one,
 * and both peer lists go on offering Watch as though the two shared a world. Nothing is
 * broken — a room IS a scene NAME, and an unnamed side is no evidence of a split, so
 * only-on-evidence correctly declines to gate. What is missing is that nobody is TOLD:
 * the joiner does not know its scene has no identity, and the host cannot see why the
 * person it is offered Watch on is standing in "Untitled scene".
 *
 * The honest fix is not to guess a room. It is to turn the unresolvable case into a named
 * one AT THE ENTRY POINT, while there is still a person there to answer: dialing with WORK
 * in an UNNAMED scene asks first. "Save & connect" names the scene through the Explorer's
 * own inline naming — no name is ever invented here — and dials once the save lands;
 * "Connect anyway" is today's behaviour verbatim, and the far-side share-or-stash ask
 * still catches the merge question it always did; Cancel dials nothing.
 *
 * SCOPE, deliberately narrow: unnamed AND holding objects. An empty world dials in
 * silence because ADOPTION will name it (A1); a named scene dials in silence because
 * every room-aware read already works. Both ordinary paths are untouched.
 *
 * WHAT THIS COVERS: the Connect pill and the cloud plugin's "join room"
 * (cloudApi.connectToPeer), which is the whole of `requestConnect`'s caller list. The
 * invite-link auto-dial does NOT come through here — it hand-rolls the same whitelist
 * inside `peer.on('open')` in peerHandler — and is left alone on purpose: it fires at
 * signaling-open, i.e. seconds into a fresh tab, where the scene is empty and the guard
 * would have nothing to say anyway.
 *
 * THAT ASSUMPTION HELD ONLY AT THE DIAL MOMENT, and round 32 is the report that found the
 * gap: the invited peer edits WHILE WAITING FOR APPROVAL, so by the time the host answers
 * there is work in a scene the dial guard saw empty. The window between dial and approval
 * is now covered where it belongs — on the far end of it, by the share-or-stash gate,
 * which withholds in BOTH directions (`gateHolds` in sessions/peerHandler) so no world
 * lands until the question is answered. So this guard genuinely only has to be right about
 * the dial moment, which is the one thing it can be right about.
 *
 * Async as a consequence of the ask, but the no-question paths still reach `dial` in the
 * SAME TICK: an empty scene never awaits at all, and the peers/signaling guards below
 * stay ahead of every await, so an offline dial still toasts immediately.
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
	if (!(await settleSceneIdentity())) return;
	// naming a scene is a real interaction, so the link is re-read AFTER the ask rather
	// than trusted across it
	if (!(/** @type {any} */ (get(peers))?.peer?.open)) {
		showToast('Lost the signaling link while you were saving — press Connect again.');
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
