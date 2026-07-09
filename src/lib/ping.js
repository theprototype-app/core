import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { peers, username } from '../stores/appStore';

// Ping a world point (or object) so every peer sees a pulse there for ~4s.

export const PING_TTL = 4000;

/** @type {import('svelte/store').Writable<{id: string, peerId: string, name: string, pos: number[], ts: number}[]>} */
export const pings = writable([]);

/** @param {any} ping */
function addPing(ping) {
	pings.update((list) => [...list.filter((p) => Date.now() - p.ts < PING_TTL), ping]);
	// schedule expiry
	setTimeout(() => {
		pings.update((list) => list.filter((p) => Date.now() - p.ts < PING_TTL));
	}, PING_TTL + 100);
}

/** Ping a world position, locally and for all peers @param {THREE.Vector3 | number[]} position */
export function sendPing(position) {
	const pos = Array.isArray(position) ? position : position.toArray();
	/** @type {any} */
	const peer = get(peers);
	const name = get(username) || peer?.peer?.id || 'me';
	const ping = { id: crypto.randomUUID(), peerId: peer?.peer?.id ?? 'me', name, pos, ts: Date.now() };
	addPing(ping);
	if (peer) peer.send({ type: 'ping', id: ping.id, peerId: ping.peerId, name, pos });
}

/** Remote ping @param {any} data */
export function applyPing(data) {
	addPing({ id: data.id, peerId: data.peerId, name: data.name, pos: data.pos, ts: Date.now() });
}
