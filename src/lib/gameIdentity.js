// 36-community (C4) — A GAME'S PERMANENT ID. Industry practice is a permanent PROJECT id plus a
// per-build id; before this every Export minted a fresh random id, so one game's visits split
// across every re-export and its play link.
//
//   · every scene gets a permanent `gameId` (a UUID) the first time it is SAVED (a named save,
//     an export, a publish) and keeps it through every ordinary save — it lives in the scene
//     file (session.json `gameId`), so it travels with the file;
//   · a COPY gets a new one with `parentGameId` = the original: Explorer ▸ Duplicate, a paste,
//     Templates ▸ Save to Library (all `importDuplicates.sceneCopyBytes`), and a REMIX — a
//     community scene or template opened by someone who is not its owner. A remix forks LAZILY:
//     the file's id stays while the scene is only played (a play link's badge must count the
//     game it shows) and is replaced by a fresh one at the first save / export / publish;
//   · `template` = the Games-tab template the game was started from (a slug), kept with it.
//
// The badge link carries `g=<gameId>` (+ the build and the source — see export/badge.js), and
// the cloud plugin records the id on the published scene and on signed-in exports. The OSS app
// keeps the id in the file and in the badge only; nothing here talks to a server.
//
// A LEAF (svelte/store only): sessions, levels, the exporter, the badge and cloudPlugin read it.
import { writable, get } from 'svelte/store';

/** the counter's own id pattern — anything else is not an id we write or trust */
export const GAME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @typedef {{ gameId: string, parentGameId: string, template: string, pendingFork: boolean }} GameIdentity
 * `pendingFork`: a remote scene opened by a non-owner — `gameId` is still the ORIGINAL's id and
 * the first save replaces it (see the header).
 */

/** the open scene's identity; null = a scene nobody has saved yet (and no file id)
 * @type {import('svelte/store').Writable<GameIdentity | null>} */
export const gameIdentity = writable(null);

/** @param {unknown} v @returns {string} */
const idOr = (v) => (typeof v === 'string' && GAME_ID_RE.test(v) ? v : '');
/** @param {unknown} v @returns {string} */
const slugOr = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : '');

/** a fresh game id @returns {string} */
export function newGameId() {
	try {
		return crypto.randomUUID();
	} catch {
		// a non-secure context has no randomUUID: 16 random bytes in the same shape
		const b = new Uint8Array(16);
		crypto.getRandomValues(b);
		const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
	}
}

/* ------------------------------------------------------------------ the load origin ---- */
// A load reaches `applySession` through confirms, a peer proposal or a module prompt, so the
// caller that KNOWS what it is loading (a remix, a template, the owner's own scene) primes the
// origin by the payload's id and the apply consumes it. Unprimed = an ordinary file / session /
// peer load: the file's id is kept as it is.

/** @type {Map<string, {remote?: boolean, keep?: boolean, template?: string}>} */
const origins = new Map();

/**
 * @param {string} payloadId the session payload's `id`
 * @param {{remote?: boolean, keep?: boolean, template?: string}} origin `remote` = a community
 *   scene / template (forks lazily); `keep` = the owner's own published scene (no fork)
 */
export function primeLoadOrigin(payloadId, origin) {
	if (!payloadId) return;
	origins.set(String(payloadId), { ...origin });
	// a declined proposal leaves its prime behind: keep the map small
	while (origins.size > 8) origins.delete(/** @type {string} */ (origins.keys().next().value));
}

/** @param {string} payloadId */
function takeLoadOrigin(payloadId) {
	const o = origins.get(String(payloadId ?? '')) ?? null;
	origins.delete(String(payloadId ?? ''));
	return o;
}

/**
 * A scene was applied: take its identity from the file (+ the primed origin). Called by
 * `sessions.applySession` for every load.
 * @param {any} payload
 */
export function noteLoadedGame(payload) {
	const origin = takeLoadOrigin(payload?.id);
	const gameId = idOr(payload?.gameId);
	const parentGameId = idOr(payload?.parentGameId);
	const template = slugOr(origin?.template) || slugOr(payload?.template);
	if (!gameId && !parentGameId && !template) {
		gameIdentity.set(null);
		return;
	}
	gameIdentity.set({ gameId, parentGameId, template, pendingFork: !!origin?.remote && !origin?.keep && !!gameId });
}

/**
 * The open scene's game id, minted (or forked, for a pending remix) when it has none — called
 * by the deliberate saves: a named save, an export, a publish bundle.
 * @returns {string}
 */
export function ensureGameId() {
	const cur = get(gameIdentity);
	if (cur?.gameId && !cur.pendingFork) return cur.gameId;
	const next = {
		gameId: newGameId(),
		parentGameId: cur?.pendingFork ? cur.gameId : cur?.parentGameId ?? '',
		template: cur?.template ?? '',
		pendingFork: false
	};
	gameIdentity.set(next);
	return next.gameId;
}

/**
 * Give the open scene a NEW game id with the current one as its parent — the cloud plugin's
 * answer when the server says the id belongs to another account (a file shared by hand).
 * @returns {string} the new id
 */
export function forkGameId() {
	const cur = get(gameIdentity);
	const next = { gameId: newGameId(), parentGameId: cur?.gameId || cur?.parentGameId || '', template: cur?.template ?? '', pendingFork: false };
	gameIdentity.set(next);
	return next.gameId;
}

/**
 * The fields a session payload carries — READ ONLY (building a payload never mints: autosave,
 * the dirty check and backups build payloads all the time). A pending remix writes its parent,
 * not the original's id, so a backup of it can never re-open as the original game.
 * @returns {{gameId?: string, parentGameId?: string, template?: string}}
 */
export function gameFields() {
	const cur = get(gameIdentity);
	if (!cur) return {};
	/** @type {{gameId?: string, parentGameId?: string, template?: string}} */
	const out = {};
	if (cur.pendingFork) {
		if (cur.gameId) out.parentGameId = cur.gameId;
	} else {
		if (cur.gameId) out.gameId = cur.gameId;
		if (cur.parentGameId) out.parentGameId = cur.parentGameId;
	}
	if (cur.template) out.template = cur.template;
	return out;
}

/**
 * A copy's session.json: a NEW id, the source's as its parent. A source without an id stays
 * without one (its copy is minted on its own first save). Mutates and returns `payload`.
 * @param {any} payload
 */
export function forkPayloadGame(payload) {
	if (!payload || typeof payload !== 'object') return payload;
	const source = idOr(payload.gameId);
	if (source) {
		payload.parentGameId = source;
		payload.gameId = newGameId();
	}
	return payload;
}

/** what the badge counts for the open scene: its id as it stands (a pending remix still counts
 * the original — that IS the game being played) @returns {string} */
export function currentGameIdForBadge() {
	return get(gameIdentity)?.gameId || '';
}
