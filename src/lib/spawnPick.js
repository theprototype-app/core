// fix-late-joiners row 3 — THIS PLAYER'S OWN SPAWN: the facts (spawn points, who is arriving, the avatars, a probe
// into the geometry) fed to the rule in spawnSlots.js. A lazy chunk: playSpawn loads it with the first peer link.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, peerPlayModes } from '../stores/appStore';
import { spawnCandidates, arrivingSlot, pickSpawn } from './spawnSlots';
import { currentSpawn, otherPlayerIds, avatarPositions } from './playSpawn';

/** objects marked as spawn points (`userData.spawnPoint`), their world feet and facing, by uuid */
export function spawnPointMarks() {
	/** @type {any} */
	const group = get(objectsGroup);
	if (!group?.traverse) return [];
	/** @type {{id: string, position: number[], yaw: number}[]} */
	const out = [];
	const v = new THREE.Vector3();
	const q = new THREE.Quaternion();
	group.traverse((/** @type {any} */ o) => {
		if (o === group || o.userData?.spawnPoint !== true) return;
		o.updateWorldMatrix(true, false);
		o.getWorldPosition(v);
		o.getWorldQuaternion(q);
		out.push({ id: o.uuid, position: [v.x, v.y, v.z], yaw: new THREE.Euler().setFromQuaternion(q, 'YXZ').y });
	});
	return out;
}

/** could that peer be arriving now? Anyone not in play yet: a peer pressing Play this second has told nobody,
 * however long its link has been open (see spawnSlots' header) @param {string} id */
function arrivingPeer(id) {
	return /** @type {any} */ (get(peerPlayModes))?.[id] !== 'playing';
}

const probeRay = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
/** the meshes a spawn can stand on or be blocked by: visible, not a trigger zone @param {any} o */
function solid(o) {
	if (!o.isMesh || o.userData?.physics?.sensor) return false;
	for (let p = o; p; p = p.parent) if (p.visible === false) return false;
	return true;
}
/**
 * fix-late-joiners: never spawn inside geometry. A ring spot is refused when something stands between the first
 * spawn and it at chest height (a wall, a crate), and its feet go on the floor one ray down finds (within 0.6 m up
 * or 1.5 m down of the spawn's own height; nothing found keeps the spawn's height: the ground plane, the grid).
 * The spawn points themselves are the author's and are taken as they are.
 * @param {{position: number[]}} origin @returns {(spot: {position: number[], yaw: number, ring?: boolean}) => any}
 */
function spawnProbe(origin) {
	/** @type {any} */
	const group = get(objectsGroup);
	/** @type {any[]} */
	const meshes = [];
	group?.traverse?.((/** @type {any} */ o) => { if (solid(o)) meshes.push(o); });
	return (spot) => {
		if (!spot.ring || !meshes.length) return spot;
		const [x, y, z] = spot.position;
		const from = new THREE.Vector3(origin.position[0], origin.position[1] + 1.0, origin.position[2]);
		const to = new THREE.Vector3(x, y + 1.0, z);
		const dir = to.clone().sub(from);
		const dist = dir.length();
		if (dist > 1e-6) {
			probeRay.set(from, dir.normalize());
			probeRay.far = dist + 0.4;
			if (probeRay.intersectObjects(meshes, false).length) return null;
		}
		probeRay.set(new THREE.Vector3(x, y + 1.8, z), DOWN);
		probeRay.far = 1.8 + 1.5;
		const hit = probeRay.intersectObjects(meshes, false)[0];
		if (!hit) return spot;
		if (hit.distance < 0.2) return null; // something at head height: inside or under geometry
		const floor = hit.point.y;
		if (floor > y + 0.6) return null; // on top of something taller than a step
		return { ...spot, position: [x, floor, z] };
	};
}

/**
 * Where THIS player spawns: `spawn` (default the one in force; the marked spawn points join it only then), this
 * player's slot among the players arriving now, clear of every avatar, probed. Null without a spawn.
 * Read by desktop Play (spawnDesktopPlayer) and VR (vr/locomotion.spawnPlayer).
 * @param {{position: number[], yaw: number} | null} [spawn]
 * @returns {{position: [number, number, number], yaw: number} | null}
 */
export function mySpawn(spawn) {
	const inForce = currentSpawn();
	const primary = spawn === undefined ? inForce : spawn;
	// the marked spawn points belong to the scene's own spawn, never to a checkpoint or a module's respawn spot
	const same = !!primary && !!inForce && primary.position.every((v, i) => Math.abs(v - inForce.position[i]) < 1e-6);
	const marks = same ? spawnPointMarks() : [];
	const candidates = spawnCandidates(primary ?? null, marks);
	if (!candidates.length) return null;
	/** @type {any} */
	const me = get(peers)?.peer?.id;
	const others = otherPlayerIds();
	const slot = typeof me === 'string' && me ? arrivingSlot(me, others, arrivingPeer) : { rank: 0, of: 1 };
	const picked = pickSpawn(candidates, slot, avatarPositions(others), spawnProbe(candidates[0])).spot;
	if (!picked) return null;
	last = { slot, at: picked.position.slice(), candidates: candidates.length };
	return { position: [picked.position[0], picked.position[1], picked.position[2]], yaw: picked.yaw };
}

/** @type {{slot: {rank: number, of: number}, at: number[], candidates: number} | null} */
let last = null;
/** the last spawn this page chose (playSpawn.lastSpawnPick) */
export const lastSpawnPick = () => last;
