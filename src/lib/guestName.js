// 78 PL34 — NOBODY IS "PEER". A person with no name of their own takes "Guest N" the moment a session
// forms: the host "Guest 1", each joiner the smallest free "Guest 2", "Guest 3"…, so every screen, the
// chat and the name tags agree (the name rides the roster row like any other name, no new message).
// The name is NOT remembered: a reload starts nameless again, and the join ask (JoinNameAsk.svelte) is
// how a person keeps a name of their own — that one IS remembered (`username` + `usernameCustom`, the
// same keys Edit profile writes).
//
// A LEAF (svelte/store + appStore + safeStorage), so the Connect pill, the roster and peerApproval all
// reach it without a cycle.
import { writable, get } from 'svelte/store';
import { peers, userdata, username } from '../stores/appStore';
import { safeStorage } from './safeStorage';

const GUEST = /^Guest (\d+)$/;

/** is this an automatic guest name? @param {unknown} name */
export const isGuestName = (name) => GUEST.test(String(name ?? '').trim());

/**
 * The smallest free "Guest N" — N starts at 1 for the host and at 2 for a joiner, and skips every
 * number a row other than ours already wears.
 * @param {any[]} roster userdata rows `[id, name, …]`
 * @param {string} selfId
 * @param {boolean} hosting
 */
export function nextGuestName(roster, selfId, hosting) {
	const taken = new Set();
	for (const row of roster ?? []) {
		if (!Array.isArray(row) || row[0] === selfId) continue;
		const m = GUEST.exec(String(row[1] ?? '').trim());
		if (m) taken.add(Number(m[1]));
	}
	let n = hosting ? 1 : 2;
	while (taken.has(n)) n++;
	return 'Guest ' + n;
}

/**
 * Two people took the same guest number (they joined in the same moment, each before the other's row
 * arrived). The one whose id sorts LATER moves on — both sides compute the same answer, so it settles.
 * @param {any[]} roster @param {string} selfId @param {string} mine
 */
export function guestClash(roster, selfId, mine) {
	if (!isGuestName(mine)) return false;
	return (roster ?? []).some((row) => Array.isArray(row) && row[0] !== selfId && String(row[1] ?? '').trim() === mine && String(row[0]) < String(selfId));
}

/**
 * What a roster row is CALLED wherever a name is drawn: its name, else "AI agent" for an agent, else
 * "Guest" (an older build that never named itself) — never "Peer".
 * @param {any} row
 */
export function displayName(row) {
	const name = String((Array.isArray(row) ? row[1] : '') ?? '').trim();
	if (name) return name;
	if (Array.isArray(row) && row[6]?.kind === 'agent') return 'AI agent';
	return 'Guest';
}

// --- the join ask ------------------------------------------------------------------------------------

/** a remembered name of the person's own (typed in Edit profile or the join ask) */
export const hasOwnName = () => safeStorage.getItem('usernameCustom') === '1' && !!String(safeStorage.getItem('username') ?? '').trim();

/** true while the "What should others call you?" card is up (Connect.svelte draws it) */
export const joinNameAsk = writable(false);

/** an automated browser asks only when a suite says so (`joinName:e2e` = '1'), or every two-peer suite
 *  would meet a card under the pill */
const automated = () => typeof navigator !== 'undefined' && !!navigator.webdriver && safeStorage.getItem('joinName:e2e') !== '1';

/**
 * A dial is going out: ask for a name, unless the person already has one (their own, or an account's).
 * @param {{ accountName?: string, agent?: boolean }} [opts]
 */
export function maybeAskJoinName(opts = {}) {
	if (opts.agent || automated()) return;
	if (hasOwnName() || String(opts.accountName ?? '').trim()) return;
	joinNameAsk.set(true);
}

/** put OUR row's name on the roster and tell everyone @param {string} name */
export function publishOwnName(name) {
	/** @type {any} */
	const pc = get(peers);
	const me = pc?.peer?.id;
	if (!me) return;
	const rows = /** @type {any[]} */ (get(userdata)) ?? [];
	let changed = false;
	for (const row of rows) {
		if (row[0] === me && row[1] !== name) {
			row[1] = name;
			changed = true;
		}
	}
	if (!changed) return;
	userdata.set(/** @type {any} */ (rows));
	pc?.send?.({ type: 'userdata', userdata: rows });
}

/**
 * The ask's Save: the name becomes this person's own, REMEMBERED (the Edit profile keys), and the
 * session hears it at once. An empty answer keeps the guest name.
 * @param {string} typed
 */
export function saveJoinName(typed) {
	const name = String(typed ?? '').trim().slice(0, 40);
	joinNameAsk.set(false);
	if (!name) return false;
	username.set(/** @type {any} */ (name));
	try {
		safeStorage.setItem('username', name);
		safeStorage.setItem('usernameCustom', '1');
	} catch {
		/* storage off: the name still holds for this tab */
	}
	publishOwnName(name);
	return true;
}
