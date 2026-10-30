// 86-fix N2 — `join_session(link)`: Claude asks; THE PERSON decides, in the tab. Never silent:
//
//   1. the link must name a session on this app (joinLink.js — another site, no id, a bad id: refused, nothing shown);
//   2. a Join / Cancel card in the tab names who asks (the fixed words "Claude (connector)", never the OAuth
//      client's own name), the host and the session id, and says when the link carries an invite or names another
//      signaling server. Another question already open in the tab → `busy` (the card never replaces the person's);
//   3. Join hands the link to the app's own pasted-link path (inviteLinks.handleInviteHash) — the same guards and
//      questions a person pasting it would get: leave your current session first, join on another server (with
//      the IP warning), the host's Approve unless the invite admits; then the connect decision if the tab holds work;
//   4. Cancel, no answer in JOIN_ASK_MS, a cancelled call or Disconnect → the card goes and nothing is dialled.

import { get } from 'svelte/store';
import { confirmDialog } from '../confirmDialog.js';
import { handleInviteHash } from '../inviteLinks.js';
import { nameOf } from '../lockControl.js';
import { APP_ORIGIN } from '../playOrigin.js';
import { peers } from '../../stores/appStore.js';
import { CONNECTOR_LABEL } from '../agent/tpAgent.js';
import { parseJoinLink } from './joinLink.js';

/** how long the card waits for the person (the Worker's call budget is 120 s) */
export const JOIN_ASK_MS = 90 * 1000;
/** the card's id: ConfirmModal renders `#confirm-connector-join`, its Join button `#confirm-dialog-join` */
export const JOIN_DIALOG_ID = 'connector-join';
/** the app's own public origin: a share link copied on theprototype.app names a session in any of its tabs */
const PUBLIC_ORIGIN = 'https://theprototype.app';

/** @param {string} code @param {string} message */
const fail = (code, message) => ({ error: { code, message } });

/** "Ann (F0FD3)" or "F0FD3" — a name only when this tab already knows the peer @param {string} id */
function hostLabel(id) {
	let name = '';
	try {
		name = nameOf(id) || '';
	} catch {}
	const short = id.toUpperCase();
	return name && name.toLowerCase() !== id ? name.slice(0, 40) + ' (' + short + ')' : short;
}

/**
 * @param {{link?: any}} args
 * @param {{onCancel?: (fn: () => void) => void}} [ctx] the dispatcher's cancel hook (a DO cancel, Disconnect)
 * @returns {Promise<{result: any} | {error: {code: string, message: string}}>}
 */
export async function joinSession(args, ctx = {}) {
	const here = typeof location !== 'undefined' ? location.origin : '';
	const parsed = parseJoinLink(args?.link, [here, APP_ORIGIN, PUBLIC_ORIGIN].filter(Boolean));
	if ('error' in parsed) return fail('invalid_args', parsed.error);
	/** @type {any} */
	const peer = get(peers);
	const myId = String(peer?.peer?.id || peer?.myId || '').toLowerCase();
	if (!peer?.peer) return fail('failed', 'This tab is not online yet (no signaling link). Try again in a moment.');
	if (parsed.id === myId) return fail('refused', 'That is this tab’s own session — the person is already in it.');
	if (get(confirmDialog)) return fail('busy', 'The person has another question open in the tab. Try again once they have answered it.');

	const who = hostLabel(parsed.id);
	const extras = [parsed.invite ? 'The link carries an invite, so you may be let in without the host approving.' : '', parsed.server ? 'The link names another signaling server; the app asks about that next.' : '']
		.filter(Boolean)
		.join(' ');
	/** @type {string | null} */
	const answer = await new Promise((resolve) => {
		let settled = false;
		const record = {
			id: JOIN_DIALOG_ID,
			title: 'Join a session?',
			message:
				CONNECTOR_LABEL + ' asks this tab to join the session hosted by ' + who + '.' +
				(extras ? '\n\n' + extras : '') +
				'\n\nJoin only if you asked Claude to. If you have work open, the app asks what to do with it first.',
			choices: [{ value: 'join', label: 'Join' }],
			cancelLabel: 'Cancel',
			resolve: (/** @type {any} */ a) => done(typeof a === 'string' && a ? a : null)
		};
		/** @param {string | null} a */
		const done = (a) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(a);
		};
		// the card goes on a timeout or a cancel — only if it is still OURS on screen
		const dismiss = () => {
			confirmDialog.update((cur) => (cur === record ? null : cur));
			done(null);
		};
		const timer = setTimeout(dismiss, JOIN_ASK_MS);
		ctx.onCancel?.(dismiss);
		confirmDialog.set(record);
	});
	if (answer !== 'join') return fail('refused', 'The person did not join (Cancel, or no answer in ' + Math.round(JOIN_ASK_MS / 1000) + ' s). Do not ask again unless they ask you to.');

	const outcome = await handleInviteHash(parsed.hash);
	const id = parsed.id.toUpperCase();
	switch (outcome) {
		case 'dial':
			return {
				result: {
					joining: true,
					session: id,
					note: (parsed.invite ? 'The person pressed Join; the invite should let this tab in shortly.' : 'The person pressed Join; the host now has to press Approve.') + ' Call status in a few seconds to see where the tab is.'
				}
			};
		case 'ask-leave':
		case 'ask-server':
			return {
				result: {
					joining: 'asking',
					session: id,
					note: 'The person pressed Join; the app now asks them ' + (outcome === 'ask-leave' ? 'to leave their current session first' : 'about the other signaling server') + '. Call status in a few seconds.'
				}
			};
		case 'already':
			return { result: { joined: true, session: id, note: 'This tab is already in that session.' } };
		case 'self':
			return fail('refused', 'That is this tab’s own session.');
		default:
			return fail('failed', 'The tab could not dial that session (not online yet, or the link names a server this app cannot read). Try again in a moment.');
	}
}
