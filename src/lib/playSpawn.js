// 30b P4: THE DESKTOP HALF OF A SPAWN — a LEAF (THREE + svelte/store + sceneStore + appStore +
// playSettings), so PointerLockControls, objectActions and moduleSDK can all reach it
// without closing a cycle. The VR half lives in vrControls.spawnPlayer (it moves the XR
// reference space, which only vrControls holds).
//
// A spawn is `{position: [x, y, z], yaw}` — y is the FEET, yaw is three's rotation.y (0 faces
// -Z) — resolved by playSettings.resolvePlaySettings: a module's runtime api.setSpawn, else
// a publisher's userData.play.spawn, else the scene's play.spawn.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { playerCam } from '../stores/sceneStore';
import { resolvePlaySettings } from './playSettings';
import { globalScene } from '../stores/sceneStore';
import { peers, userdata } from '../stores/appStore';
// 60 Q1: the Play here rule (pure, three only) lives in its own leaf so the unit layer can run it
export { playHereSpawnFrom, headingOf } from './playHereCore';

/** the play camera's eye above the feet: the walker's 1.7 m person */
export const SPAWN_EYE = 1.7;

// 60 Q1: PLAY HERE — a session-only spawn that beats every authored one while it is set. It is
// written by playHere (desktop/phone) and the VR radial's Play here, and cleared when that Play
// ends, so `currentSpawn()` stays the ONE read every spawn path shares (PointerLockControls, the
// VR spawnPlayer, a module's api.respawnPlayer, the game shell's restart). LOCAL: it never
// replicates, saves or undoes — "where I pressed Play here" is a fact about this peer.
/** @type {{position: [number, number, number], yaw: number} | null} */
let playHereOverride = null;

/** @param {{position: [number, number, number], yaw: number} | null} spawn */
export function setPlayHereSpawn(spawn) {
	playHereOverride = spawn ? { position: [spawn.position[0], spawn.position[1], spawn.position[2]], yaw: spawn.yaw } : null;
}

/** the Play here spawn while one is in force (test/debug view too) */
export function playHereSpawn() {
	return playHereOverride;
}

/** the spawn in force right now, or null @returns {{position: [number, number, number], yaw: number} | null} */
export function currentSpawn() {
	return playHereOverride ?? resolvePlaySettings(get(globalScene)).spawn;
}

/** the spawn a DESKTOP view honours — the one in force unless it is VR-only (30b core-games)
 * @returns {{position: [number, number, number], yaw: number} | null} */
export function desktopSpawn() {
	const spawn = currentSpawn();
	return spawn && !(/** @type {any} */ (spawn).vrOnly) ? spawn : null;
}

/**
 * Where an EYE stands on a spawn, and a point straight ahead of it at eye height (what
 * flyTo and lookAt want). Pure. @param {{position: number[], yaw: number}} spawn
 */
export function spawnEyePose(spawn) {
	const [x, y, z] = spawn.position;
	const eye = [x, y + SPAWN_EYE, z];
	const lookAt = [x - Math.sin(spawn.yaw) * 2, y + SPAWN_EYE, z - Math.cos(spawn.yaw) * 2];
	return { eye, lookAt };
}

/**
 * Put desktop Play's camera on the spawn: eye at feet + SPAWN_EYE, facing its yaw, level.
 * PointerLockControls derives yaw/pitch from the camera's quaternion every look, so writing
 * the quaternion is the whole of "face this way".
 * @param {{position: number[], yaw: number} | null} [spawn] defaults to the one in force
 * @returns {boolean} whether the camera moved
 */
export function spawnDesktopPlayer(spawn = desktopSpawn()) {
	/** @type {any} */
	const cam = get(playerCam);
	if (!spawn || !cam?.isObject3D) return false;
	// fix-play-link: every spawn path (entering play, the game shell's restart, a module's
	// respawnPlayer) lands clear of a player already standing on the spawn
	const ids = otherPlayerIds();
	const eye = clearOfAvatars(spawnEyePose(spawn).eye, avatarPositions(ids), spawn.yaw, AVATAR_CLEARANCE, mySlot(ids));
	const target = new THREE.Vector3(eye[0], eye[1], eye[2]);
	if (cam.parent) {
		cam.parent.updateWorldMatrix(true, false);
		cam.parent.worldToLocal(target);
	}
	cam.position.copy(target);
	cam.quaternion.setFromEuler(new THREE.Euler(0, spawn.yaw, 0, 'YXZ'));
	cam.updateMatrixWorld(true);
	return true;
}

/** fix-play-link: the other players' peer ids (the roster, minus me) @returns {string[]} */
export function otherPlayerIds() {
	/** @type {any} */
	const me = get(peers)?.peer?.id;
	return (/** @type {any[]} */ (get(userdata) ?? [])).map((u) => u?.[0]).filter((id) => typeof id === 'string' && id && id !== me);
}

/** world positions of these players' avatars (AvatarRig groups, named by peer id); an avatar with
 * no pose yet (parked at y = 1000) does not count @param {string[]} peerIds @returns {number[][]} */
export function avatarPositions(peerIds) {
	/** @type {any} */
	const scene = get(globalScene);
	if (!scene || !peerIds.length) return [];
	const out = [];
	const v = new THREE.Vector3();
	for (const id of peerIds) {
		const rig = scene.getObjectByName(id);
		if (!rig?.isObject3D || !rig.visible) continue;
		rig.getWorldPosition(v);
		if (v.y > 500) continue;
		out.push([v.x, v.y, v.z]);
	}
	return out;
}

/**
 * 98-int F4 (device-lab: two joiners by play link both spawned at the bare spawn, inside each other's
 * head): the step above clears only avatars this page can SEE, and two players arriving together have
 * no pose of each other yet. Every such player computes the same set — itself plus the other players
 * whose avatars it cannot see — and takes its rank in it by peer id. A lone joiner (everyone else
 * visible) is {rank: 0, of: 1}: exactly the old behaviour. Pure.
 * @param {string} me @param {string[]} unseen the other players with no visible avatar
 * @returns {{rank: number, of: number}}
 */
export function arrivalSlot(me, unseen) {
	const set = [...new Set([me, ...unseen.filter((id) => typeof id === 'string' && id)])].sort();
	return { rank: Math.max(0, set.indexOf(me)), of: set.length };
}

/** the other players whose avatars this page cannot see yet @param {string[]} peerIds */
export function unseenPlayers(peerIds) {
	/** @type {any} */
	const scene = get(globalScene);
	const v = new THREE.Vector3();
	return peerIds.filter((id) => {
		const rig = scene?.getObjectByName?.(id);
		if (!rig?.isObject3D || !rig.visible) return true;
		rig.getWorldPosition(v);
		return v.y > 500;
	});
}

/** this page's arrival slot right now (see `arrivalSlot`) @param {string[]} peerIds the OTHER players */
function mySlot(peerIds) {
	/** @type {any} */
	const me = get(peers)?.peer?.id;
	return typeof me === 'string' && me ? arrivalSlot(me, unseenPlayers(peerIds)) : { rank: 0, of: 1 };
}

/** fix-play-link: how far a joining eye keeps from another player's avatar root (its head) */
export const AVATAR_CLEARANCE = 1.0;

/**
 * fix-play-link — WHERE AN EYE STANDS CLEAR OF THE OTHER PLAYERS. Pure. Everyone who presses Play
 * lands on the same spawn (or the same saved camera), so a player joining a game already under way
 * started INSIDE the first player's avatar head (folded N6; a flat beige view for 25 s on the
 * HONOR). Returns `eye` itself when it is already clear; else the nearest spot on rings around it
 * (1.4 m, 2.4 m, 3.6 m; eight bearings, the first one straight BEHIND the facing so the
 * other player is in view) that is clear of every avatar; else `eye`.
 * Heights are kept: a spawn's floor is the author's, the ring only moves sideways.
 * @param {number[]} eye [x, y, z] @param {number[][]} others avatar roots [x, y, z]
 * @param {number} [yaw] the facing (three's rotation.y; 0 faces -Z) @param {number} [clearance]
 * @param {{rank: number, of: number}} [slot] 98-int F4: this player's place among the players arriving
 *   together (see `arrivalSlot`); the default {0, 1} is the behaviour above, unchanged
 * @returns {number[]}
 */
export function clearOfAvatars(eye, others, yaw = 0, clearance = AVATAR_CLEARANCE, slot = { rank: 0, of: 1 }) {
	const clear = (/** @type {number[]} */ p) =>
		others.every((o) => Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) >= clearance);
	/** @type {number[][]} */
	const spots = [eye];
	// 98-int F4: the inner ring is 1.4 m (was 1.2): eight bearings 45° apart on 1.2 m are only 0.92 m from each other,
	// under the clearance, once two arriving players take neighbouring spots
	for (const radius of [1.4, 2.4, 3.6]) {
		for (let i = 0; i < 8; i++) {
			// i = 0 is behind the facing (+Z rotated by yaw), then alternately either side of it
			const turn = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 4);
			const a = yaw + turn;
			spots.push([eye[0] + Math.sin(a) * radius, eye[1], eye[2] + Math.cos(a) * radius]);
		}
	}
	// 98-int F4: players arriving TOGETHER cannot see each other yet, so each one takes only its own
	// residue class of the spots (rank r of n: r, r + n, r + 2n …) — two classes never share a spot
	const of = Math.max(1, Math.floor(slot?.of ?? 1));
	const rank = Math.min(of - 1, Math.max(0, Math.floor(slot?.rank ?? 0)));
	for (let k = rank; k < spots.length; k += of) if (clear(spots[k])) return spots[k];
	for (const spot of spots) if (clear(spot)) return spot;
	return eye;
}

/**
 * Step desktop Play's camera clear of the other players' avatars (see `clearOfAvatars`). The
 * avatars are the scene's groups named by peer id (AvatarRig). Call after the spawn landed.
 * @param {string[]} peerIds the OTHER players @returns {boolean} whether the camera moved
 */
export function stepClearOfAvatars(peerIds = otherPlayerIds()) {
	/** @type {any} */
	const cam = get(playerCam);
	if (!cam?.isObject3D) return false;
	const others = avatarPositions(peerIds);
	const slot = mySlot(peerIds);
	if (!others.length && slot.of === 1) return false;
	cam.updateWorldMatrix(true, false);
	const eye = cam.getWorldPosition(new THREE.Vector3());
	const yaw = new THREE.Euler().setFromQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y;
	const spot = clearOfAvatars([eye.x, eye.y, eye.z], others, yaw, AVATAR_CLEARANCE, slot);
	if (spot[0] === eye.x && spot[2] === eye.z) return false;
	const target = new THREE.Vector3(spot[0], spot[1], spot[2]);
	if (cam.parent) cam.parent.worldToLocal(target);
	cam.position.copy(target);
	cam.updateMatrixWorld(true);
	return true;
}
