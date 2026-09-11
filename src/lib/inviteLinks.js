// 24-D1: an invite link pasted INTO THE OPEN TAB. `https://…#75F41~srv=host` used to
// do nothing there: a hash-only navigation never reloads, and the hash was read exactly
// twice, both at startup (the PeerConnection constructor for `~srv`, `peer.on('open')`
// for the dial). This is the third reader — a `hashchange` listener that decides:
//   · nothing / our own writes            → ignore (`location.hash = ''` fires too)
//   · our own id                          → say so
//   · the host we are already with        → say so
//   · a different server named           → ask, naming the host (a `~srv=` link can point
//                                           at ANY signaling server; the load-time path
//                                           switches silently, the live one says where)
//   · already in a session               → ask to leave first (the user's rule)
//   · else                               → dial through requestConnect (its own guards)
// The hash is CONSUMED first (replaceState, so no second hashchange and no trailing `#`):
// a runtime server switch rebuilds the Peer, and its `open` handler would otherwise read
// `#id~srv=…` back as a peer id. Store-only + peerServer + peerApproval; started from
// App.svelte like startTrackpadNav.
import { get } from 'svelte/store';
import { peers, showToast, waitingForApproval } from '../stores/appStore';
import { parseInviteHash, decodeInviteServer, peerServerStatus, sameServer } from './peerServer';
import { requestConnect, cancelOutboundRequest } from './peerApproval';
import { sessionHost } from './connectionState';
import { nameOf } from './lockControl';

/** @param {any} target the decoded override */
function serverLabel(target) {
	if (!target) return '';
	if (target.forcePublic) return 'the public PeerJS cloud';
	const c = target.custom || {};
	const port = c.port && Number(c.port) !== 443 ? ':' + c.port : '';
	return String(c.host || '') + port;
}

/** @param {string} peerId */
function peerLabel(peerId) {
	let name = '';
	try {
		name = nameOf(peerId) || '';
	} catch {}
	const id = peerId.toUpperCase();
	return name && name.toLowerCase() !== peerId ? name + ' (' + id + ')' : id;
}

/** Drop the hash without a navigation and without a second hashchange. */
function consumeHash() {
	if (typeof history === 'undefined' || typeof location === 'undefined') return;
	if (!location.hash) return;
	try {
		history.replaceState(history.state, '', location.pathname + location.search);
	} catch {
		location.hash = '';
	}
}

/**
 * Decide what a pasted invite hash means and act on it. Exported so the suite can
 * drive it directly as well as through a real `hashchange`.
 * @param {string} hash e.g. `#75f41~srv=peerjs.example`
 * @returns {Promise<'none'|'startup'|'self'|'already'|'ask-leave'|'ask-server'|'dial'|'no-switch'>}
 */
export async function handleInviteHash(hash) {
	const { peerId: raw, srv } = parseInviteHash(hash || '');
	const peerId = String(raw || '').trim().toLowerCase();
	if (!peerId) return 'none';
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.peer) return 'none';
	// the signaling link has never opened: the startup path (`peer.on('open')`) owns
	// the hash and will dial it — nothing to do live, and no "not connected yet" toast
	if (!peer.hasOpened) return 'startup';
	consumeHash();
	const myId = String(peer.peer.id || peer.myId || '').toLowerCase();
	if (peerId === myId) {
		showToast("That's your own invite link — send it to somebody else to have them join you.");
		return 'self';
	}
	const host = String(get(sessionHost) || '').toLowerCase();
	const open = peer.openedPeers ?? new Set();
	if (peerId === host || open.has(peerId)) {
		showToast('Already connected to ' + peerLabel(peerId) + '.');
		return 'already';
	}
	const target = srv ? decodeInviteServer(srv) : null;
	if (srv && !target) {
		showToast('That invite link names a server this app cannot read (' + srv + ').');
		return 'none';
	}
	const needSwitch = !!target && !sameServer(target, get(peerServerStatus));
	const inSession = open.size > 0 || !!host;

	const proceed = async () => {
		if (needSwitch) {
			if (typeof peer.switchServer !== 'function') {
				showToast('This link uses another server (' + serverLabel(target) + ') — Settings ▸ Connection to switch.');
				return;
			}
			const ok = await peer.switchServer(target);
			if (!ok) return; // switchServer said why
		}
		// a dial still waiting on somebody else is superseded by this one
		for (const entry of get(waitingForApproval)) {
			if (entry?.[1] === 'pending' && entry[0] !== peerId) cancelOutboundRequest(entry[0]);
		}
		await requestConnect(peerId);
	};

	if (inSession) {
		const who = host ? peerLabel(host) : open.size === 1 ? peerLabel([...open][0]) : open.size + ' peers';
		const where = needSwitch ? ' on ' + serverLabel(target) : '';
		showToast("You're in a session with " + who + '. Leave it and join ' + peerLabel(peerId) + where + '?', [
			{
				label: 'Leave & join',
				action: () => {
					try {
						peer.leaveSession();
					} catch {}
					proceed();
				}
			},
			{ label: 'Stay', action: () => {} }
		]);
		return 'ask-leave';
	}
	if (needSwitch) {
		// one extra tap only in the uncommon case, and the user sees where they are going
		showToast('Join ' + peerLabel(peerId) + ' on ' + serverLabel(target) + '?', [
			{ label: 'Join', action: () => proceed() },
			{ label: 'Cancel', action: () => {} }
		]);
		return 'ask-server';
	}
	await proceed();
	return 'dial';
}

let started = false;

/** Install the live listener once (App.svelte boot). */
export function startInviteLinks() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('hashchange', () => {
		handleInviteHash(location.hash);
	});
}
