import { writable, get } from 'svelte/store';

// Roadmap 55 A9 — what the peer menu's PROFILE and "Show their recent changes" read.
// A leaf (svelte/store only). LOCAL: nothing here is sent or saved; every peer derives it
// from what already arrives (the `modules` handshake, the replicated edits themselves).

/** Per-peer facts from the handshake: the app version they run and the device they joined
 * on (`dev`, additive on `modules` — an older peer sends none).
 * @type {import('svelte/store').Writable<Record<string, {appVersion?: string, device?: string}>>} */
export const peerFacts = writable({});

/** @param {string} peerId @param {{appVersion?: any, device?: any}} facts */
export function notePeerFacts(peerId, facts) {
	/** @type {{appVersion?: string, device?: string}} */
	const next = {};
	if (typeof facts.appVersion === 'string') next.appVersion = facts.appVersion.slice(0, 32);
	if (facts.device === 'desktop' || facts.device === 'phone' || facts.device === 'vr') next.device = facts.device;
	peerFacts.update((m) => ({ ...m, [peerId]: { ...m[peerId], ...next } }));
}

/** This machine's device word for the handshake. @param {boolean} inVR */
export function myDevice(inVR) {
	if (inVR) return 'vr';
	try {
		if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return 'phone';
	} catch {
		/* no media queries: a desktop */
	}
	return 'desktop';
}

/** What a replicated edit SAYS in words, by message type. A type not listed is not an
 * "edit" anybody reads as one (presence, requests, replies), so it is not recorded. */
export const ACTIVITY_VERBS = /** @type {Record<string, string>} */ ({
	create: 'added',
	light: 'added a light',
	group: 'grouped',
	object: 'added',
	objectfile: 'imported',
	duplicate: 'duplicated',
	delete: 'deleted',
	move: 'moved',
	color: 'recoloured',
	map: 'textured',
	materials: 'changed the materials of',
	objectParameters: 'changed',
	geometry: 'reshaped',
	meshgeo: 'edited the mesh of',
	verts: 'edited the mesh of',
	nodecreate: 'added a node',
	nodedata: 'edited a node',
	nodedelete: 'removed a node',
	edgecreate: 'wired nodes',
	edgedelete: 'unwired nodes',
	clearscene: 'cleared the scene',
	environment: 'changed the sky',
	scenephysics: 'changed the physics',
	splineedit: 'edited the spline',
	animdata: 'animated'
});

/** Most recent first, capped. A burst of one verb on one object (a drag streams `move`)
 * folds into ONE entry with a count. */
export const ACTIVITY_CAP = 40;

/** @type {Record<string, {verb: string, uuid: string, at: number, n: number}[]>} */
const logs = {};

/**
 * Record one applied edit from `peerId`. Pure bookkeeping, O(1).
 * @param {string} peerId @param {any} data @param {number} [now]
 * @returns {boolean} whether it was recorded
 */
export function notePeerActivity(peerId, data, now = Date.now()) {
	const verb = ACTIVITY_VERBS[data?.type];
	if (!verb || !peerId) return false;
	const uuid = typeof data.uuid === 'string' ? data.uuid : '';
	const log = (logs[peerId] ??= []);
	const top = log[0];
	if (top && top.verb === verb && top.uuid === uuid) {
		top.at = now;
		top.n += 1;
	} else {
		log.unshift({ verb, uuid, at: now, n: 1 });
		if (log.length > ACTIVITY_CAP) log.length = ACTIVITY_CAP;
	}
	return true;
}

/** @param {string} peerId */
export function peerActivity(peerId) {
	return (logs[peerId] ?? []).map((e) => ({ ...e }));
}

/** @param {string} peerId */
export function dropPeerFacts(peerId) {
	delete logs[peerId];
	if (get(peerFacts)[peerId]) peerFacts.update((m) => {
		const next = { ...m };
		delete next[peerId];
		return next;
	});
}

/** "2 min ago" @param {number} at @param {number} [now] */
export function agoText(at, now = Date.now()) {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 10) return 'just now';
	if (s < 60) return s + ' s ago';
	const m = Math.round(s / 60);
	if (m < 60) return m + ' min ago';
	return Math.round(m / 60) + ' h ago';
}
