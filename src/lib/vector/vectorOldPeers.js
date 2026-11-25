// 64-extrude row 6: an OLD PEER gets the solid as a plain mesh.
//
// A release without vector shapes ignores the `geometry` message of a 'Vector' (it cannot build
// one), so a shape extruded after it joined would stay flat there, and a heavy shape (sent without
// its triangles, vectorGate) would stay empty. This build says `vs: 1` in its caps (wireProto); to
// every open peer that did NOT, the shape's current mesh goes as an ordinary `meshgeo` (binary
// arrays, so a 2 000-point solid fits) marked `vectorFallback` — which an older build applies as a
// plain mesh edit and this build drops (a peer whose caps have not arrived yet looks old for a
// moment). Debounced per shape: a drag sends once, when it settles.
// A LAZY chunk: geometryEdit / commandsHandler reach it by dynamic import.
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { meshGeoMessage } from '../meshCommit.js';
import { packFaces, readStoredFaces } from '../meshTopology.js';
import { isVectorObject } from './vectorGate.js';

const SETTLE_MS = 400;
/** @type {Map<string, any>} */
const timers = new Map();
let sent = 0;

/** open peers without the `vs` cap @param {any} peer @returns {string[]} */
export function oldPeerIds(peer) {
	const conns = peer?.connections ?? {};
	return Object.keys(conns).filter((id) => conns[id]?.open && !peer.peerCaps?.get?.(id)?.vs);
}

/**
 * Send a shape's mesh to the old peers now (or to `only` of them). @param {string} uuid
 * @param {string[]} [only] @returns {number} how many peers it went to
 */
export function sendOldPeerSolid(uuid, only) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return 0;
	let ids = oldPeerIds(peer);
	if (only) ids = ids.filter((id) => only.includes(id));
	if (!ids.length) return 0;
	const object = /** @type {any} */ (get(objectsGroup)?.getObjectByProperty('uuid', uuid));
	const g = object?.geometry;
	if (!isVectorObject(object) || !g?.attributes?.position?.count) return 0;
	const faces = readStoredFaces(g);
	const message = {
		...meshGeoMessage(uuid, g.attributes.position.array, {
			uvs: g.attributes.uv?.array,
			colors: g.attributes.color?.array,
			faceFields: faces ? (packFaces(faces) ?? undefined) : undefined
		}),
		vectorFallback: true
	};
	peer.sendReliableTo(message, ids);
	sent += ids.length;
	return ids.length;
}

/** after a local change: send once it settles @param {string} uuid */
export function scheduleOldPeerSolid(uuid) {
	clearTimeout(timers.get(uuid));
	timers.set(
		uuid,
		setTimeout(() => {
			timers.delete(uuid);
			sendOldPeerSolid(uuid);
		}, SETTLE_MS)
	);
}

/** TEST/DEBUG */
export function oldPeerDebug() {
	/** @type {any} */
	const peer = get(peers);
	return { sent, pending: timers.size, oldPeers: oldPeerIds(peer) };
}
