import { writable, get } from 'svelte/store';
import { notifyOn } from './notifyPrefs';
import { peers, userdata, pendingApprovals, waitingForApproval, showToast } from '../stores/appStore';
import { sessionHost, noteJoinRefusal, clearApprovalStarted } from './connectionState';
import { rolesInfo, roomAccess } from './cloudHooks';
import { createModerationState, kickDecision, canModerateWith, isKickMessage } from './peerModerationCore';

// Roadmap 55 A9 — remove / remove-and-block / allow back, the store half. Store-only like
// peerApproval.js (VR and the Users menu reach it without importing peerHandler, which
// would close a module cycle). The rules live in peerModerationCore.js; read its header.

const state = createModerationState();

/**
 * 71 AS3: "Require approval to join" FOR THIS SESSION, on the host's device. On, nothing joins by
 * itself: a working invite link, a plugin's automatic admit (guests, a room code) — each becomes
 * the ordinary approval card. A guest's re-dial after a block carries a NEW peer id, which the
 * session block list cannot know; this is what makes that re-dial a card instead of a way back in.
 * Leaving the session turns it off (resetModeration), like the block list it backs up.
 * @type {import('svelte/store').Writable<boolean>} */
export const requireApproval = writable(false);

/** @param {boolean} on @param {{quiet?: boolean}} [opt] */
export function setRequireApproval(on, opt = {}) {
	requireApproval.set(!!on);
	if (opt.quiet) return;
	showToast(on ? 'Everyone now needs your approval to join this session, invite links included.' : 'Joins work as before: invite links and automatic joins let people in.', on ? [{ label: 'Undo', action: () => setRequireApproval(false) }] : undefined);
}

/** what a plugin's room-access provider says, never trusted to be well-formed @param {string} name @param {...any} args */
function access(name, ...args) {
	const p = get(roomAccess);
	if (!p || typeof p[name] !== 'function') return undefined;
	try {
		return p[name](...args);
	} catch (e) {
		console.error('roomAccess.' + name + ' threw', e);
		return undefined;
	}
}

/**
 * 71 AS3: the block toast. A signed-in person (the plugin says so) is held by the account block
 * list across sessions, so their toast is the plain one. A GUEST rejoins with a fresh id — the
 * toast says so and offers the fix: Require approval to join (core; the plugin also makes the room
 * ask), and Signed-in people only where the plugin can do it. Only the HOST is offered a fix: the
 * host is who decides a join (an admin elsewhere in the mesh would set a flag nobody reads).
 * @param {string} peerId @param {string} name
 * @returns {{text: string, actions: {label: string, action: () => void}[]}}
 */
export function blockToast(peerId, name) {
	/** @type {{label: string, action: () => void}[]} */
	const actions = [{ label: 'Allow back', action: () => allowBack(peerId) }];
	const plain = { text: name + ' was removed and blocked for this session.', actions };
	if (access('isGuest', peerId) === false || get(sessionHost)) return plain;
	const st = access('state') ?? {};
	const gated = get(requireApproval);
	if (!gated)
		actions.push({
			label: 'Require approval to join',
			action: () => {
				setRequireApproval(true);
				void Promise.resolve(access('requireApproval')).catch((e) => showToast('Could not change the room: ' + (e?.message || e)));
			}
		});
	const p = get(roomAccess);
	if (p && typeof p.signedInOnly === 'function' && !st.signedInOnly)
		actions.push({
			label: 'Signed-in people only',
			action: () =>
				void Promise.resolve(access('signedInOnly'))
					.then(() => showToast('Only signed-in people can join your room now.'))
					.catch((e) => showToast('Could not change the room: ' + (e?.message || e)))
		});
	return {
		text: name + ' was removed and blocked for this session. As a guest they can come back with a new id' + (gated ? ', and that lands on an approval card.' : ': to stop that, choose who may join.'),
		actions
	};
}

/** The session's block list for the Users panel's "Blocked" section.
 * @type {import('svelte/store').Writable<{peerId: string, name: string, at: number, by: string}[]>} */
export const blockedPeers = writable([]);
const publish = () => blockedPeers.set(state.list());

/** 55 A4's invite store, when that lane is on this build (a glob, so a build without it
 * resolves to nothing instead of failing to import). Removing someone who came by an
 * invite USES UP that invite. */
const inviteModules = import.meta.glob('./inviteStore.js');
/** @returns {Promise<any | null>} */
export async function inviteStoreModule() {
	const load = Object.values(inviteModules)[0];
	if (!load) return null;
	try {
		return await load();
	} catch {
		return null;
	}
}

/** @param {string} peerId */
export function peerLabel(peerId) {
	const row = /** @type {any[]} */ (get(userdata)).find((u) => u[0] === peerId);
	return (row && row[1]) || String(peerId).slice(0, 6).toUpperCase();
}

function ctx() {
	const ri = get(rolesInfo);
	return { host: get(sessionHost), roleOf: ri && typeof ri.roleOf === 'function' ? ri.roleOf : null };
}

/** May WE remove peers (the menu's Moderation group)? */
export function canModerate() {
	const ri = get(rolesInfo);
	/** @type {any} */
	const pc = get(peers);
	return canModerateWith({ host: get(sessionHost), amAdmin: ri?.amAdmin, hasRoles: !!ri, connected: !!pc?.openedPeers?.size });
}

/** @param {string} peerId */
export function isBlocked(peerId) {
	return state.isBlocked(peerId);
}
/** Blocked, or removed moments ago: the roster and mesh-fill paths skip them. @param {string} peerId */
export function isHeldOut(peerId) {
	return state.isHeldOut(peerId);
}
/** An approval lets them in: the short removal hold goes (a block does not). @param {string} peerId */
export function forgetRemoved(peerId) {
	state.forget(peerId);
}

/** Drop a peer on THIS machine: whitelist, approval cards, connection. @param {any} pc @param {string} peerId */
function dropLocally(pc, peerId) {
	userdata.set(/** @type {any} */ (get(userdata)).filter((/** @type {any} */ u) => u[0] !== peerId));
	pendingApprovals.set(/** @type {any} */ (get(pendingApprovals)).filter((/** @type {any} */ p) => p.peerId !== peerId));
	waitingForApproval.set(/** @type {any} */ (get(waitingForApproval)).filter((/** @type {any} */ w) => w[0] !== peerId));
	clearApprovalStarted(peerId);
	if (!pc) return;
	if (pc.openedPeers?.has(peerId) || pc.connections?.[peerId]) pc.finalizeDisconnect?.(peerId, false);
	else pc.reconnecting?.delete?.(peerId);
}

/** @param {string} peerId */
async function useUpInvite(peerId) {
	const inv = await inviteStoreModule();
	try {
		const id = inv?.inviteIdOf?.(peerId);
		if (id && typeof inv.revokeInvite === 'function') inv.revokeInvite(id);
	} catch {
		/* the invite lane owns its errors */
	}
}

/**
 * The REMOVER: tell the mesh, then drop them here. The message goes out first (the removed
 * peer hears it on our still-open connection — that is how a cooperating client knows to
 * leave and say so), and our own connection to them closes a moment later so the send can
 * flush. Everybody else closes theirs on receipt.
 * @param {string} peerId @param {{block?: boolean}} [opts] @returns {boolean}
 */
export function removePeer(peerId, opts = {}) {
	/** @type {any} */
	const pc = get(peers);
	const me = pc?.peer?.id;
	if (!peerId || peerId === me) return false;
	if (!canModerate()) {
		showToast(get(rolesInfo) ? 'Only an admin can remove people from this session.' : 'Only the session host can remove people.');
		return false;
	}
	const block = !!opts.block;
	const name = peerLabel(peerId);
	pc?.broadcast?.({ type: 'kick', peer: peerId, block });
	state.remove(peerId, { block, name, by: me || '' });
	publish();
	userdata.set(/** @type {any} */ (get(userdata)).filter((/** @type {any} */ u) => u[0] !== peerId));
	setTimeout(() => dropLocally(get(peers), peerId), 400);
	void useUpInvite(peerId);
	if (block) {
		const t = blockToast(peerId, name);
		// a decision stays on its notification-history entry until one is pressed (fix-live F-2)
		showToast(t.text, t.actions, { keep: t.actions.length > 1 });
	} else showToast(name + ' was removed from the session.');
	return true;
}

/** Lift a block, here and on every peer. @param {string} peerId @returns {boolean} */
export function allowBack(peerId) {
	/** @type {any} */
	const pc = get(peers);
	if (!canModerate()) {
		showToast(get(rolesInfo) ? 'Only an admin can allow someone back.' : 'Only the session host can allow someone back.');
		return false;
	}
	const name = state.list().find((b) => b.peerId === peerId)?.name || String(peerId).slice(0, 6).toUpperCase();
	state.allow(peerId);
	publish();
	pc?.broadcast?.({ type: 'kick', peer: peerId, allow: true });
	showToast(name + ' may ask to join again.');
	return true;
}

/**
 * A RECEIVER: the sender is checked here, receive-side, against our own view of who the
 * host and the admins are — never anything the message claims.
 * @param {any} data @param {string} sender @param {any} pc the PeerConnection
 * @returns {'ignore' | 'self' | 'allow' | 'remove'}
 */
export function applyKick(data, sender, pc) {
	const me = pc?.peer?.id || '';
	const verdict = kickDecision(data, sender, me, ctx());
	if (verdict === 'ignore') return verdict;
	if (verdict === 'allow') {
		if (state.allow(data.peer)) publish();
		return verdict;
	}
	if (verdict === 'self') {
		// they removed US. Say so where the Connect pill shows a refusal, and leave on
		// purpose (a goodbye, no reconnect storm). The others close their side regardless.
		try {
			pc?.leaveSession?.();
		} catch {
			/* the others have closed us already */
		}
		// AFTER leaving: leaveSession -> resetSession clears the refusal chip
		noteJoinRefusal(sender, 'removed');
		showToast(data.block ? 'You were removed from this session and cannot rejoin it.' : 'You were removed from this session.');
		return verdict;
	}
	const known = /** @type {any[]} */ (get(userdata)).some((u) => u[0] === data.peer);
	const name = peerLabel(data.peer);
	state.remove(data.peer, { block: !!data.block, name, by: sender });
	publish();
	dropLocally(pc, data.peer);
	if (known && !data.replay && notifyOn('peerLeft')) showToast(name + ' was removed from the session' + (data.block ? ' and blocked.' : '.'));
	return verdict;
}

/** The block list a moderator hands a peer it is joining with, so a later re-dial lands on
 * a peer that knows. @returns {any[]} kick messages, `replay: true` */
export function blockReplay() {
	if (!canModerate()) return [];
	return state.list().map((b) => ({ type: 'kick', peer: b.peerId, block: true, replay: true }));
}

/** Leaving the session forgets its moderation. */
export function resetModeration() {
	state.reset();
	requireApproval.set(false); // 71 AS3
	publish();
}

export { isKickMessage };
