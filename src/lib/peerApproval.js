import { get } from 'svelte/store';
import { peers, userdata, pendingApprovals, waitingForApproval } from '../stores/appStore';
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
