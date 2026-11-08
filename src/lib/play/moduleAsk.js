// fix-play-link — WHAT THE PLAYER ANSWERED TO "This scene uses modules", ON A PLAYER PAGE.
// A LEAF (safeStorage only), so the rule is unit-testable with no dialog and no gallery.
//
// A player page is the play entry (`/play`, what `/p/<id>` frames) or any page on the play origin.
// There the ask is about one game the person chose to play, and it used to come back on every visit:
//   · Install is remembered by the install itself (the player page now restores installed modules at
//     boot, `loadUserModules`), and a module from the OFFICIAL modules repo installs without the ask
//     at all (QUESTIONS-fix-play-link Q1);
//   · Load anyway is remembered HERE, per module AND version: the same version never asks again, a
//     newer one does (it is a different module as far as the game is concerned).
// The editor keeps asking every time: a builder opening a scene wants to know what it needs.
import { safeStorage } from '../safeStorage';

export const ANYWAY_KEY = 'tp.modulesAnyway';
const MAX_REMEMBERED = 64;

/** @param {{id: string, version?: string}} entry */
export const askKey = (entry) => entry.id + '@' + (entry.version || '');

/** @returns {string[]} */
function readAnyway() {
	try {
		const list = JSON.parse(safeStorage.getItem(ANYWAY_KEY) || '[]');
		return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
	} catch {
		return [];
	}
}

/** "Load anyway" for these entries: never ask again for these versions on this device.
 * @param {{id: string, version?: string}[]} entries */
export function rememberLoadAnyway(entries) {
	const keys = new Set(readAnyway());
	for (const entry of entries) keys.add(askKey(entry));
	try {
		safeStorage.setItem(ANYWAY_KEY, JSON.stringify([...keys].slice(-MAX_REMEMBERED)));
	} catch {
		/* storage refused: the ask simply comes back next visit */
	}
}

/** the entries this device already answered "Load anyway" for (same id AND version)
 * @template {{id: string, version?: string}} T @param {T[]} entries @returns {T[]} */
export function answeredAnyway(entries) {
	const keys = new Set(readAnyway());
	return entries.filter((entry) => keys.has(askKey(entry)));
}

/**
 * Split what a scene needs into what the player page installs without asking and what it still
 * asks about. `official` = the module ids the official modules repo lists. Pure.
 * @template {{id: string, version?: string}} T
 * @param {{fetchable: T[], disabled: T[], official: Set<string> | string[]}} input
 * @returns {{autoInstall: T[], ask: {fetchable: T[], disabled: T[]}, skipAsk: boolean}}
 */
export function planPlayerAsk({ fetchable, disabled, official }) {
	const listed = official instanceof Set ? official : new Set(official);
	const autoInstall = fetchable.filter((entry) => listed.has(entry.id));
	const rest = fetchable.filter((entry) => !listed.has(entry.id));
	const remembered = new Set(answeredAnyway([...rest, ...disabled]).map(askKey));
	const ask = {
		fetchable: rest.filter((entry) => !remembered.has(askKey(entry))),
		disabled: disabled.filter((entry) => !remembered.has(askKey(entry)))
	};
	return { autoInstall, ask, skipAsk: !ask.fetchable.length && !ask.disabled.length };
}
