// profile-notify (owner 2026-11-09) — Settings ▸ Interface ▸ Notifications: one switch per AUTOMATIC in-app
// notification kind, stored PER DEVICE (localStorage `notifyPrefs`, never the account: the same person may want a
// quiet laptop and a chatty desktop). Every switch defaults ON = today's behaviour, and absent = ON, so a kind added
// later starts on for everyone.
//
// THE ONE GATE: every emitter asks `notifyOn(kind)` (or reads `$notifyPrefs` in a component) at its single choke
// point — no scattered flags. A kind that is off is not shown at all (no pop-up, no bell entry, no sound, no badge);
// what it reports still happens (the quality still drops, the person still left).
//
// Left out on purpose (never switchable): decisions someone must answer (connection request, take-control request,
// a role offer, an agent asking permission) and safety notices (auto-admit, reload for a new version, signed out
// from another device). "What's new" keeps its own switch (whatsNew.js showWhatsNewNotice, "Announce new versions").
// A LEAF: imports only svelte/store + safeStorage, so appStore.js can import it.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

const KEY = 'notifyPrefs';

/**
 * @typedef {{id: string, label: string, description: string, keywords: string, cloud?: boolean}} NotifyKind
 * `cloud` = sent by the cloud plugin (cloudApi.notificationOn), so the row shows only while one is loaded
 */
/** @type {NotifyKind[]} in the order Settings lists them */
export const NOTIFY_KINDS = [
	{
		id: 'peerLeft',
		label: 'People leaving',
		description: 'A pop-up when someone disconnects or is removed from the session.',
		keywords: 'peer left leave disconnected removed session people toast'
	},
	{
		id: 'chat',
		label: 'Chat badge',
		description: 'The unread count on the Chat button, and its mention colour when someone @mentions you.',
		keywords: 'chat message unread badge count mention'
	},
	{
		id: 'pingSound',
		label: 'Ping sounds',
		description: 'Hear the chime when someone else pings. The marker still shows.',
		keywords: 'ping sound chime audio hear'
	},
	{
		id: 'agent',
		label: 'AI assistant',
		description: 'A pop-up when the AI answers you or an agent starts building, while the AI assistant is closed.',
		keywords: 'ai agent assistant claude answered building'
	},
	{
		id: 'autoQuality',
		label: 'Auto quality',
		description: 'A pop-up when the app lowers the quality to keep it smooth. The quality still changes.',
		keywords: 'quality performance fps lowered smooth graphics'
	},
	{
		id: 'roomInvites',
		label: 'Room invites',
		description: 'A pop-up when someone invites you to their room.',
		keywords: 'room invite join cloud',
		cloud: true
	},
	{
		id: 'contests',
		label: 'Contest reminders',
		description: 'At most one pop-up a day while a community contest is open.',
		keywords: 'contest community reminder nudge',
		cloud: true
	}
];
const IDS = new Set(NOTIFY_KINDS.map((k) => k.id));

/** @returns {Record<string, boolean>} only the kinds someone switched OFF are stored (absent = on) */
function load() {
	try {
		const raw = JSON.parse(safeStorage.getItem(KEY) || '{}');
		/** @type {Record<string, boolean>} */
		const out = {};
		if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (IDS.has(k) && v === false) out[k] = false;
		return out;
	} catch {
		return {};
	}
}

/** kind → false when switched off; LOCAL, per device @type {import('svelte/store').Writable<Record<string, boolean>>} */
export const notifyPrefs = writable(typeof localStorage !== 'undefined' ? load() : {});
if (typeof localStorage !== 'undefined') {
	notifyPrefs.subscribe((m) => {
		try {
			const off = Object.fromEntries(Object.entries(m).filter(([k, v]) => IDS.has(k) && v === false));
			if (Object.keys(off).length) safeStorage.setItem(KEY, JSON.stringify(off));
			else safeStorage.removeItem(KEY);
		} catch {
			/* storage disabled */
		}
	});
}

/** THE gate: may this kind of notification show? Unknown kinds are on (never silence what has no switch).
 * @param {string} kind @returns {boolean} */
export function notifyOn(kind) {
	return get(notifyPrefs)[kind] !== false;
}

/** @param {string} kind @param {boolean} on */
export function setNotify(kind, on) {
	if (!IDS.has(kind)) return;
	notifyPrefs.update((m) => {
		const next = { ...m };
		if (on) delete next[kind];
		else next[kind] = false;
		return next;
	});
}

/** every switch back on (Settings' "Reset Interface") */
export function resetNotifyPrefs() {
	notifyPrefs.set({});
}
