// 55 A4 — invite links, the STATEFUL half (inviteCore.js is the pure half). Store-only, like
// peerApproval.js: peerHandler, the Connect sheet, Users and the cloud API all reach it, so it
// must never import peerHandler (that closes a cycle the SSR prerender TDZ-crashes on).
//
// Two sides live here:
//   HOST   — the records (persisted on THIS device only, never sent), the token of each
//            invite minted in this tab (memory only, so the sheet can copy it again), the
//            check of every incoming dial, the grants it produced and how each peer joined.
//   JOINER — the token this tab was opened with (`#<host>&invite=<token>`), read ONCE at boot
//            or on a pasted link and consumed from the URL at once (replaceState), and the
//            dial metadata it proves with. The token itself never leaves the tab.
// Plus the agent flag: `&agent` in the boot hash, or `safeStorage.agentApi` (the 55-page
// switch for tpAgent) — what makes this page say `kind: "agent"` on its dials and roster row.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage.js';
import { userdata } from '../stores/appStore';
import {
	newToken,
	makeRecord,
	checkInvite,
	spendUse,
	revokeRecord,
	nameUse,
	pruneRecords,
	inviteState,
	dialInvite,
	parseHashParams,
	inviteLink,
	mcpCommand,
	chatSentence,
	useLabel
} from './inviteCore.js';

const STORE_KEY = 'tp:invites';
const AGENTS_AS_GUESTS_KEY = 'connect:agentsAsGuests';

/** @typedef {import('./inviteCore.js').InviteRecord} InviteRecord */

// ---------------------------------------------------------------- the agent flag

/** @param {string} hash */
const hashSaysAgent = (hash) => {
	try {
		return parseHashParams(hash).agent;
	} catch {
		return false;
	}
};

/** read at module evaluation — before the PeerConnection constructor scrubs the hash */
let bootAgent = typeof location !== 'undefined' && hashSaysAgent(location.hash);

/** Is this page an AI agent's? (`&agent` in the link, or the 55-page `agentApi` switch) */
export function isAgentSession() {
	return bootAgent || safeStorage.getItem('agentApi') === '1' || safeStorage.getItem('agentApi') === 'true';
}

/** what this page's dials and roster row say it is @returns {'agent' | undefined} */
export const myKind = () => (isAgentSession() ? 'agent' : undefined);

/** a roster row's kind (userdata slot 6, `{kind}`) @param {any} row @returns {'agent' | 'person'} */
export const kindOfRow = (row) => (Array.isArray(row) && row[6] && row[6].kind === 'agent' ? 'agent' : 'person');

/** is this peer an agent? (self-declared — intent and visibility, never security) @param {string} peerId */
export function isAgentPeer(peerId) {
	const id = String(peerId || '').toLowerCase();
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((r) => Array.isArray(r) && r[0] === id);
	return kindOfRow(row) === 'agent' || dialKinds.get(id) === 'agent';
}

/** the kind each dial declared, kept so a card and a roster row agree before userdata lands @type {Map<string, string>} */
const dialKinds = new Map();

// ---------------------------------------------------------------- the sheet

/** the invite sheet: which tab is open, null = closed (Connect ▸ Request AI opens 'agent',
 * Users ▸ Invite a person opens 'person') @type {import('svelte/store').Writable<null | 'agent' | 'person'>} */
export const inviteSheet = writable(/** @type {null | 'agent' | 'person'} */ (null));

// ---------------------------------------------------------------- settings

/** "Let AI agents join as guests" — default OFF: an agent dial gets the approval card even
 * when the room admits guests automatically (owner, 2026-10-22). */
export const agentsAsGuests = writable(safeStorage.getItem(AGENTS_AS_GUESTS_KEY) === 'true');
agentsAsGuests.subscribe((v) => safeStorage.setItem(AGENTS_AS_GUESTS_KEY, v ? 'true' : 'false'));

// ---------------------------------------------------------------- host: records

/** @returns {InviteRecord[]} */
function loadRecords() {
	try {
		const raw = safeStorage.getItem(STORE_KEY);
		return raw ? pruneRecords(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

/** every invite this device minted that Users still lists @type {import('svelte/store').Writable<InviteRecord[]>} */
export const invites = writable(loadRecords());
invites.subscribe((list) => {
	try {
		safeStorage.setItem(STORE_KEY, JSON.stringify(list));
	} catch {
		/* safeStorage already degrades per key */
	}
});

/** tokens minted in THIS tab, so the sheet can copy a link again (never persisted) @type {Map<string, string>} */
const tokens = new Map();

/** listeners for any invite change (the cloud roles plugin re-evaluates grants) @type {Set<() => void>} */
const changeListeners = new Set();
const notify = () => {
	for (const fn of changeListeners) {
		try {
			fn();
		} catch (e) {
			console.error('invite listener threw', e);
		}
	}
};
/** @param {() => void} fn @returns {() => void} */
export function onInvitesChange(fn) {
	changeListeners.add(fn);
	return () => changeListeners.delete(fn);
}

/** @param {(list: InviteRecord[]) => InviteRecord[]} fn */
function updateRecords(fn) {
	invites.update((list) => pruneRecords(fn(list)));
	notify();
}

/**
 * The hand-over strings for an invite. `base` is the page the link opens.
 * @param {string} hostId @param {string} token @param {'person'|'agent'} kind @param {string} [srvTail] @param {string} [base]
 */
export function handover(hostId, token, kind, srvTail = '', base) {
	const at = base ?? (typeof location !== 'undefined' ? location.origin + location.pathname : 'https://theprototype.app/');
	const link = inviteLink(at, hostId, token, kind, srvTail);
	return { link, mcp: mcpCommand(link), sentence: chatSentence(link, kind) };
}

/**
 * Mint an invite. The token goes into the link and this tab's memory; the device keeps the
 * KEY (a hash of it) and the rules.
 * @param {{ hostId: string, kind?: 'person'|'agent', role?: 'view'|'edit', expiry?: string, maxUses?: number, srvTail?: string, now?: number }} opts
 */
export function createInvite(opts) {
	const token = newToken();
	const record = makeRecord(token, opts, opts.now ?? Date.now());
	tokens.set(record.id, token);
	updateRecords((list) => [...list, record]);
	return { record, ...handover(opts.hostId, token, record.kind, opts.srvTail) };
}

/** the token of an invite minted in this tab (null after a reload) @param {string} id */
export const tokenOf = (id) => tokens.get(id) ?? null;

/** @param {string} id */
export function revokeInvite(id) {
	updateRecords((list) => list.map((r) => (r.id === id ? revokeRecord(r) : r)));
}

/** *Revoke all invites* in Users: every invite still usable stops working */
export function revokeAllInvites() {
	const now = Date.now();
	updateRecords((list) => list.map((r) => (inviteState(r, now) === 'active' || inviteState(r, now) === 'used' ? revokeRecord(r, now) : r)));
}

/** drop an ended invite from the list @param {string} id */
export function forgetInvite(id) {
	tokens.delete(id);
	updateRecords((list) => list.filter((r) => r.id !== id));
}

/** the invites Users lists, newest first, with a state and "used by" labels */
export function listInvites(list = get(invites), now = Date.now()) {
	return [...list]
		.sort((a, b) => b.createdAt - a.createdAt)
		.map((r) => ({ ...r, state: inviteState(r, now), usedBy: r.uses.map(useLabel), canCopy: tokens.has(r.id) }));
}

// ---------------------------------------------------------------- host: checking dials

/** @typedef {{ inviteId: string, role: 'view'|'edit', kind: string, meta: any, at: number }} InviteGrant */
/** peers admitted by invite this session @type {Map<string, InviteGrant>} */
const grants = new Map();
/** how each peer got in: 'invite' | 'approval' | 'guest' (55-people's profile card) @type {Map<string, string>} */
const joinedHow = new Map();

/** @param {string} peerId @param {'invite'|'approval'|'guest'} how */
export function noteJoinedVia(peerId, how) {
	const id = String(peerId || '').toLowerCase();
	if (!id) return;
	// an invite is the more specific fact: a manual approve after it does not overwrite it
	if (joinedHow.get(id) === 'invite' && how !== 'invite') return;
	joinedHow.set(id, how);
}
/** @param {string} peerId @returns {string | undefined} */
export const joinedVia = (peerId) => joinedHow.get(String(peerId || '').toLowerCase());

/**
 * THE HOST'S CHECK of one incoming dial (peerHandler's handleConnection). Spends a use on
 * success, remembers the grant, and NEVER logs the proof.
 * @param {string} peerId the dialer as the signaling server named it
 * @param {any} meta the dial's `invite` metadata (untrusted)
 * @param {string} hostId our own peer id
 * @param {{ kind?: string, name?: string }} [who]
 * @returns {{ ok: true, role: 'view'|'edit', kind: string, again: boolean, inviteId: string } | { ok: false, reason: string }}
 */
export function verifyInviteDial(peerId, meta, hostId, who = {}) {
	const id = String(peerId || '').toLowerCase();
	if (who.kind === 'agent') dialKinds.set(id, 'agent');
	const res = checkInvite(get(invites), meta, id, hostId);
	if (!res.ok) return { ok: false, reason: res.reason };
	const { record, again } = res;
	if (!again) updateRecords((list) => list.map((r) => (r.id === record.id ? spendUse(r, id, { name: who.name, kind: who.kind }) : r)));
	grants.set(id, { inviteId: record.id, role: record.role, kind: who.kind === 'agent' ? 'agent' : 'person', meta, at: Date.now() });
	noteJoinedVia(id, 'invite');
	if (again) notify();
	return { ok: true, role: record.role, kind: record.kind, again, inviteId: record.id };
}

/** remember a dial's declared kind without an invite (the plain-link card) @param {string} peerId @param {any} kind */
export function noteDialKind(peerId, kind) {
	if (kind === 'agent') dialKinds.set(String(peerId || '').toLowerCase(), 'agent');
}

/**
 * What the cloud plugin's roles check reads, HOST-SIDE: the dial's own invite metadata and a
 * snapshot of the record it named (with the key — the plugin re-verifies the proof itself,
 * the roomAccess pattern). Null when this peer did not come in by an invite this session.
 * @param {string} peerId
 * @returns {{ meta: any, record: InviteRecord, role: string } | null}
 */
export function inviteGrantFor(peerId) {
	const g = grants.get(String(peerId || '').toLowerCase());
	if (!g) return null;
	const record = get(invites).find((r) => r.id === g.inviteId);
	if (!record) return null;
	return { meta: g.meta, record: JSON.parse(JSON.stringify(record)), role: record.role };
}

/** a peer left: its grant goes (a re-dial proves again) — the use stays spent @param {string} peerId */
export function dropInviteGrant(peerId) {
	grants.delete(String(peerId || '').toLowerCase());
}

/** the invite a peer came in by (for Users: "Revoke invite" on its row) @param {string} peerId */
export function inviteIdOf(peerId) {
	return grants.get(String(peerId || '').toLowerCase())?.inviteId ?? null;
}

// fill "used by <name>" in when a joiner's profile name arrives
userdata.subscribe((rows) => {
	if (!Array.isArray(rows) || !get(invites).length) return;
	let changed = false;
	const next = get(invites).map((r) => {
		let out = r;
		for (const row of rows) {
			if (!Array.isArray(row) || !row[1]) continue;
			const named = nameUse(out, row[0], row[1]);
			if (named !== out) {
				out = named;
				changed = true;
			}
		}
		return out;
	});
	if (changed) invites.set(next);
});

// ---------------------------------------------------------------- joiner

/** the invite this tab was opened with: the host it is for and the token @type {{ host: string, token: string } | null} */
let joinInvite = null;

/**
 * Read an invite out of a hash (boot or a pasted link) and CONSUME it: the token is kept in
 * memory and the URL keeps everything but `invite=…` (replaceState — no history entry ever
 * holds it). Returns what it found.
 * @param {string} hash
 * @returns {{ peerId: string, agent: boolean, invite: boolean }}
 */
export function captureInviteHash(hash) {
	const p = parseHashParams(hash);
	if (p.agent) bootAgent = true;
	if (p.invite && p.peerId) joinInvite = { host: p.peerId.toLowerCase(), token: p.invite };
	if (/(^|&)invite=/i.test(String(hash || '').replace(/^#/, ''))) scrubInviteFromUrl();
	return { peerId: p.peerId, agent: p.agent, invite: !!p.invite };
}

/** the URL minus `&invite=…` (every other param stays for its own reader) */
function scrubInviteFromUrl() {
	if (typeof location === 'undefined' || typeof history === 'undefined') return;
	const h = location.hash.replace(/&invite=[^&~]*/i, '');
	try {
		history.replaceState(history.state, '', location.pathname + location.search + (h && h !== '#' ? h : ''));
	} catch {
		/* a sandboxed frame: the hash stays, the token still only lives in this tab */
	}
}

/**
 * What our dial to `hostId` carries, as `metadata.invite` — only for the host the invite
 * names. @param {string} myId @param {string} hostId
 */
export function joinerInviteMeta(myId, hostId) {
	if (!joinInvite || !myId || joinInvite.host !== String(hostId || '').toLowerCase()) return undefined;
	return dialInvite(joinInvite.token, String(myId).toLowerCase(), joinInvite.host) ?? undefined;
}

/** is our dial to this host an invite? (the join toast says so) @param {string} hostId */
export const dialingWithInvite = (hostId) => !!joinInvite && joinInvite.host === String(hostId || '').toLowerCase();

/** test seam: forget the joiner's invite */
export function clearJoinInvite() {
	joinInvite = null;
}
