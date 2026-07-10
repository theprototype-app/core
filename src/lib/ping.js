import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { peers, username } from '../stores/appStore';
import { peerColor } from './lockControl';
import { playPing } from './pingAudio';

// Ping a world point (or object) so every peer sees a pulse there for ~4s.
// V2 (87): pings carry the sender's chosen color + chime — everyone renders
// and hears YOUR ping the way you configured it.

export const PING_TTL = 4000;

/** @type {import('svelte/store').Writable<{id: string, peerId: string, name: string, pos: number[], ts: number, color?: string, sound?: string}[]>} */
export const pings = writable([]);

// per-user ping preferences (Settings; '' color = automatic peer color)
export const pingColor = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('pingColor') ?? '' : ''
);
export const pingSound = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('pingSound') ?? 'ding' : 'ding'
);
if (typeof localStorage !== 'undefined') {
	pingColor.subscribe((value) => localStorage.setItem('pingColor', value));
	pingSound.subscribe((value) => localStorage.setItem('pingSound', value));
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

/** Ping a world position, locally and for all peers @param {THREE.Vector3 | number[]} position */
export function sendPing(position) {
	const pos = Array.isArray(position) ? position : position.toArray();
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
		sound
	};
	addPing(ping);
	if (peer) peer.send({ type: 'ping', id: ping.id, peerId: ping.peerId, name, pos, color, sound });
}

/** Remote ping @param {any} data */
export function applyPing(data) {
	addPing({
		id: data.id,
		peerId: data.peerId,
		name: data.name,
		pos: data.pos,
		ts: Date.now(),
		color: data.color,
		sound: data.sound
	});
}
