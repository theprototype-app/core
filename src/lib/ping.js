import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { peers, username } from '../stores/appStore';
import { objectsGroup } from '../stores/sceneStore';
import { peerColor } from './lockControl';
import { playPing } from './pingAudio';
import { safeStorage } from './safeStorage';
import { PING_MIN_GAP } from './pingCore.js';
import { pingLog, recordPing, recentPings, pingWorld } from './pingLog.js';

export { pingLog, recentPings, pingWorld };

// Ping a world point (or object) so every peer sees a pulse there for ~4s.
// V2 (87): pings carry the sender's chosen color + chime — everyone renders
// and hears YOUR ping the way you configured it.

export const PING_TTL = 4000;

/** @type {import('svelte/store').Writable<{id: string, peerId: string, name: string, pos: number[], ts: number, color?: string, sound?: string, uuid?: string}[]>} */
export const pings = writable([]);

// per-user ping preferences (Settings; '' color = automatic peer color)
export const pingColor = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('pingColor') ?? '' : ''
);
export const pingSound = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('pingSound') ?? 'ding' : 'ding'
);
if (typeof localStorage !== 'undefined') {
	pingColor.subscribe((value) => safeStorage.setItem('pingColor', value));
	pingSound.subscribe((value) => safeStorage.setItem('pingSound', value));
}

const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
/**
 * 85b S2: where on WHICH object a ping landed, in that object's own frame (so it follows the object): the scene
 * object right under the scene root that holds the hit, the point, and the surface normal.
 * @param {any} object the hit (any descendant of the scene's objects) @param {THREE.Vector3 | number[]} point world
 * @param {THREE.Vector3 | null} [worldNormal] world-space surface normal (null = straight up)
 * @returns {{uuid: string, local: number[], normal: number[]} | undefined}
 */
export function pingAnchor(object, point, worldNormal) {
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group || !object) return undefined;
	let anchor = object;
	while (anchor.parent && anchor.parent !== group) anchor = anchor.parent;
	if (anchor.parent !== group) return undefined;
	anchor.updateWorldMatrix(true, false);
	const p = Array.isArray(point) ? new THREE.Vector3().fromArray(point) : point.clone();
	const local = anchor.worldToLocal(p);
	_m.copy(anchor.matrixWorld).invert();
	const n = _n.copy(worldNormal ?? new THREE.Vector3(0, 1, 0)).transformDirection(_m);
	const r = (/** @type {number} */ v) => Math.round(v * 1e4) / 1e4;
	return { uuid: anchor.uuid, local: local.toArray().map(r), normal: n.toArray().map(r) };
}

/** a raycast hit's world normal (three's face normal is in the hit mesh's frame) @param {any} hit */
export function hitWorldNormal(hit) {
	if (!hit?.face?.normal || !hit.object) return null;
	hit.object.updateWorldMatrix(true, false);
	return hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
}

/** @param {any} ping */
function addPing(ping) {
	pings.update((list) => [...list.filter((p) => Date.now() - p.ts < PING_TTL), ping]);
	playPing(ping.sound, ping.pos);
	// schedule expiry
	setTimeout(() => {
		pings.update((list) => list.filter((p) => Date.now() - p.ts < PING_TTL));
	}, PING_TTL + 100);
}

/**
 * 36-avatars: PREVIEW a ping colour + chime at a point, on THIS screen only (the customise panel's
 * live preview). Sends nothing — a preview is not a ping.
 * @param {number[]} pos @param {string} color @param {string} sound
 */
export function previewPing(pos, color, sound) {
	/** @type {any} */
	const peer = get(peers);
	addPing({
		id: crypto.randomUUID(),
		peerId: peer?.peer?.id ?? 'me',
		name: get(username) || 'me',
		pos,
		ts: Date.now(),
		color: color || peerColor(peer?.peer?.id ?? 'me'),
		sound: sound || 'ding'
	});
}

/** Ping a world position, locally and for all peers. An optional `uuid` marks
 * the ping as an OBJECT ping: receivers also flash a highlight around that
 * object for PING_TTL (PingHighlights). 85b S2: `hit` (a raycast hit) records the surface it landed on.
 * @param {THREE.Vector3 | number[]} position @param {string=} uuid @param {any} [hit] */
export function sendPing(position, uuid, hit) {
	const pos = Array.isArray(position) ? position : position.toArray();
	// 85b S2: one ping per PING_MIN_GAP (a double click, a bouncing stick click)
	const t = Date.now();
	if (t - lastSent < PING_MIN_GAP) return;
	lastSent = t;
	// 85b S2: what it landed on — a raycast hit (object + face), else the object an object ping names
	const group = /** @type {any} */ (get(objectsGroup));
	const on = hit?.object ? pingAnchor(hit.object, pos, hitWorldNormal(hit)) : uuid ? pingAnchor(group?.getObjectByProperty('uuid', uuid), pos, null) : undefined;
	/** @type {any} */
	const peer = get(peers);
	const name = get(username) || peer?.peer?.id || 'me';
	const color = get(pingColor) || peerColor(peer?.peer?.id ?? 'me');
	const sound = get(pingSound) || 'ding';
	const ping = {
		id: crypto.randomUUID(),
		peerId: peer?.peer?.id ?? 'me',
		name,
		pos,
		ts: Date.now(),
		color,
		sound,
		uuid: uuid ?? undefined,
		...(on ? { on } : {})
	};
	addPing(ping);
	recordPing(ping);
	if (peer) peer.send({ type: 'ping', id: ping.id, peerId: ping.peerId, name, pos, color, sound, uuid: uuid ?? undefined, ...(on ? { on } : {}) });
}
let lastSent = 0;

/**
 * mcp-diorama2 (19): the first hit on real geometry — selection's tiny-object and measurement proxies carry the
 * object's ORIGIN as their point, which is not where anyone pointed. null = nothing real under the pointer.
 * @param {any[]} hits nearest first
 */
export function surfaceHit(hits) {
	return (hits ?? []).find((h) => h && !h.tinyProxy && !h.measure && h.point) ?? null;
}

/**
 * mcp-diorama2 (19): the object menu's Ping at the spot that was right-clicked (the menu's hit point), on that
 * object — "Ping this object" used to pulse the top of its bounding box, so an agent read a point nobody chose.
 * @param {string} uuid @param {number[]} point world
 */
export function pingObjectAt(uuid, point) {
	if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) return pingObject(uuid);
	sendPing(point, uuid);
}

/** Ping the top-center of an object by uuid (used by the object context menu).
 * Lives here so the shared object-menu builder needs no THREE import. @param {string} uuid */
export function pingObject(uuid) {
	const group = /** @type {any} */ (get(objectsGroup));
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return;
	const box = new THREE.Box3().setFromObject(object);
	const top = box.getCenter(new THREE.Vector3());
	top.y = box.max.y;
	sendPing(top, uuid); // carry the uuid so peers highlight the object too
}

/** Ping the top-center of a SET's union bounds (multi-select menu). @param {string[]} uuids */
export function pingObjects(uuids) {
	if (!uuids || uuids.length <= 1) return pingObject(uuids?.[0]);
	const group = /** @type {any} */ (get(objectsGroup));
	const box = new THREE.Box3();
	let any = false;
	for (const uuid of uuids) {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (object) {
			box.expandByObject(object);
			any = true;
		}
	}
	if (!any) return;
	const top = box.getCenter(new THREE.Vector3());
	top.y = box.max.y;
	sendPing(top);
}

/** Remote ping. 85b S2: `from` (the connection's peer) is who pinged — never the message's own claim.
 * @param {any} data @param {string} [from] */
export function applyPing(data, from) {
	const peerId = from ?? data.peerId;
	const on = data.on && typeof data.on.uuid === 'string' ? { uuid: data.on.uuid, local: data.on.local, ...(data.on.normal ? { normal: data.on.normal } : {}) } : undefined;
	// the throttle drops the marker too: a flood of pings must not flood every screen
	if (!recordPing({ id: data.id, peerId, name: data.name, pos: data.pos, on })) return;
	addPing({
		id: data.id,
		peerId,
		name: data.name,
		pos: data.pos,
		ts: Date.now(),
		color: data.color,
		sound: data.sound,
		uuid: data.uuid
	});
}
