// 85b S2 — the ping LOG as a leaf (three + stores + pingCore): what where_are_users and the placement params read.
// ping.js (the marker, the chime, the sender) writes it; kept apart so the connector's module graph does not pull
// the marker's imports (lockControl reaches objectActions and the rune modules).
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { logPing, pruneLog } from './pingCore.js';

/** 85b S2: the agent-readable log (pingCore) — a few pings per person for PING_LOG_TTL, never saved or sent.
 * @type {import('svelte/store').Writable<import('./pingCore.js').PingRecord[]>} */
export const pingLog = writable([]);

/** @param {any} ping @returns {boolean} false when the throttle dropped it */
export function recordPing(ping) {
	const rec = { id: String(ping.id), peer: String(ping.peerId), name: String(ping.name ?? ''), time: Date.now(), pos: ping.pos, ...(ping.on ? { on: ping.on } : {}) };
	let added = false;
	pingLog.update((log) => {
		const r = logPing(log, rec, rec.time);
		added = r.added;
		return r.log;
	});
	return added;
}

/** the log without expired rows @returns {import('./pingCore.js').PingRecord[]} */
export function recentPings() {
	const live = pruneLog(get(pingLog), Date.now());
	pingLog.set(live);
	return live;
}

/**
 * 85b S2: where a ping is NOW: on the object it landed on (it follows that object), else where it was.
 * @param {import('./pingCore.js').PingRecord} rec @returns {{point: THREE.Vector3, normal: THREE.Vector3, on: any}}
 */
export function pingWorld(rec) {
	const group = /** @type {any} */ (get(objectsGroup));
	const anchor = rec.on ? group?.getObjectByProperty('uuid', rec.on.uuid) : null;
	if (anchor && rec.on) {
		anchor.updateWorldMatrix(true, false);
		const point = anchor.localToWorld(new THREE.Vector3().fromArray(rec.on.local));
		const normal = rec.on.normal ? new THREE.Vector3().fromArray(rec.on.normal).transformDirection(anchor.matrixWorld) : new THREE.Vector3(0, 1, 0);
		return { point, normal, on: anchor };
	}
	return { point: new THREE.Vector3().fromArray(rec.pos), normal: new THREE.Vector3(0, 1, 0), on: null };
}

