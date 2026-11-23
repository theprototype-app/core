// 104 D1 — SCAN MY ROOM, the session + scene half (LAZY: the VR menu row and the Play menu row import it on press).
//
// 1. Read: inside an immersive-ar session that was granted `plane-detection` (XrButtons asks for it and for
//    `mesh-detection`), wait for the headset's room setup to arrive — Meta: `detectedPlanes` fills a couple of
//    seconds after the session starts — then read every plane and furniture volume once (roomScanCore.readFrame).
// 2. Nothing there = no room setup: say how to make one. Quest Browser can start Space Setup from the page
//    (`session.initiateRoomCapture()`, once per session); otherwise the Settings path. Nothing else happens.
// 3. Build: the pieces become ordinary objects (Box primitives, `create` / `group` / `name` / `move` /
//    `geometry` / `color` messages — the same ones the editor sends), so they sync, save and undo like any
//    other, as ONE undo step. A second scan updates the "My room" group by name (planUpdate) instead of
//    adding a second room; its walls are matched to the old ones by shape first (nameWalls), so "Wall 2"
//    stays the same real wall when a new session faces another way.
// No camera image is read, used or stored: the room comes from the shapes drawn in the headset's room setup.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalRenderer, lockedObjects, pokeScene } from '../../stores/sceneStore';
import { peers, showToast } from '../../stores/appStore';
import { createGeometry, createGroup } from '../geometries.svelte.js';
import { recordObjectPresence, recordTransform, beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '../history';
import { renameObject, moveObjectToGroup, deleteObjectsByUuid } from '../objectActions';
import { setObjectColor, setMaterialParam } from '../materialsHandler';
import { applyGeometry } from '../geometryEdit';
import { isViewer } from '../objectPermissions';
import { roomPieces, planUpdate, nameWalls, scanSummary, readFrame, colorOf, ROOM_GROUP_NAME, ROOM_NAME_RE } from './roomScanCore.js';

/** how see-through the pieces are, so the fit against the real room shows in passthrough */
export const ROOM_OPACITY = 0.45;
/** give up waiting for the room setup after this long (Meta: planes arrive 2-3 s after the session starts) */
const WAIT_MS = 4000;
/** the room is read once its plane count has held this long */
const SETTLE_MS = 600;

/** sessions that already asked for Space Setup (the browser allows it once per session) */
const captureAsked = new WeakSet();

/** the last scan, for the suites and the debug hook @type {any} */
let last = null;
export const roomScanDebug = {
	last: () => last
};

const say = (/** @type {string} */ text) => showToast(text);

/**
 * Wait for the room setup and read it once.
 * @param {any} session @param {any} space @param {{waitMs?: number, settleMs?: number}} [opts]
 * @returns {Promise<{planes: any[], meshes: any[]}>}
 */
export function readRoom(session, space, opts = {}) {
	const waitMs = opts.waitMs ?? WAIT_MS;
	const settleMs = opts.settleMs ?? SETTLE_MS;
	return new Promise((resolve) => {
		const t0 = performance.now();
		let best = { planes: /** @type {any[]} */ ([]), meshes: /** @type {any[]} */ ([]) };
		let count = -1;
		let since = t0;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(best);
		};
		// frames may not come at all (a paused render, a session ending): the clock decides too
		const timer = setTimeout(finish, waitMs + 50);
		const onFrame = (/** @type {number} */ _t, /** @type {any} */ frame) => {
			if (done) return;
			const got = readFrame(frame, space);
			const n = got.planes.length + got.meshes.length;
			const now = performance.now();
			if (n !== count) {
				count = n;
				since = now;
			}
			if (n >= best.planes.length + best.meshes.length) best = got;
			if ((n > 0 && now - since >= settleMs) || now - t0 >= waitMs) return finish();
			try {
				session.requestAnimationFrame(onFrame);
			} catch {
				finish();
			}
		};
		try {
			session.requestAnimationFrame(onFrame);
		} catch {
			finish();
		}
	});
}

/** the XR session the renderer is presenting, or null */
function liveSession() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	return renderer?.xr?.getSession?.() ?? null;
}

/**
 * The VR menu's "Scan my room" (and the Play menu's, once its session is up).
 * @returns {Promise<{status: string, [k: string]: any}>}
 */
export async function scanMyRoom() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const session = liveSession();
	if (!session) {
		say('Scan my room works inside the headset: choose Scan my room from the Play button menu.');
		return (last = { status: 'no-session' });
	}
	if (isViewer()) {
		say('You are watching this session. Ask for editor access to add your room.');
		return (last = { status: 'viewer' });
	}
	const features = session.enabledFeatures;
	if (Array.isArray(features) && !features.includes('plane-detection')) {
		say('This session has no room data. Leave VR, then choose Scan my room (passthrough) from the Play button menu.');
		return (last = { status: 'no-planes-feature', features: [...features] });
	}
	const space = renderer.xr.getReferenceSpace();
	const room = await readRoom(session, space);
	const pieces = roomPieces(room);
	if (!pieces.length) return (last = noRoomSetup(session, room));
	const { pieces: named, ...result } = applyRoom(pieces);
	const line = scanSummary(named, result);
	say(line);
	return (last = { status: 'ok', line, ...result, pieces: named.map((p) => ({ name: p.name, size: p.size, position: p.position })) });
}

/** @param {any} session @param {{planes: any[], meshes: any[]}} room */
function noRoomSetup(session, room) {
	const canCapture = typeof session.initiateRoomCapture === 'function' && !captureAsked.has(session);
	if (canCapture) {
		captureAsked.add(session);
		say('No room setup on this headset yet. Space Setup is opening: trace your walls and furniture, then choose Scan my room again.');
		try {
			Promise.resolve(session.initiateRoomCapture()).catch(() => {});
		} catch {
			/* refused: the toast already says what to do */
		}
	} else
		say('No room setup found. On Quest: Settings, Physical space, Space setup. Then choose Scan my room again.');
	return { status: 'no-room-setup', capture: canCapture, planes: room.planes.length, meshes: room.meshes.length };
}

/** @param {any} data */
function send(data) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(data);
}

/** @param {string} uuid */
const lockedByPeer = (uuid) => get(lockedObjects).some((/** @type {any} */ l) => l[1] === uuid);

/** the scene's "My room" group: a top-level Group by that name (made by a scan here or on a peer) */
function findRoomGroup() {
	/** @type {any} */
	const root = get(objectsGroup);
	return root?.children.find((/** @type {any} */ c) => c.type === 'Group' && c.name === ROOM_GROUP_NAME) ?? null;
}

const _world = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * A piece's world pose → the group's local frame (the scene may sit in a scaled or moved world rig, and the
 * group may have been moved): the real room lands where the real room is.
 * @param {any} group @param {import('./roomScanCore.js').NamedPiece} piece
 */
function localPose(group, piece) {
	group.updateWorldMatrix(true, false);
	_inv.copy(group.matrixWorld).invert();
	_world.compose(_p.fromArray(piece.position), _q.fromArray(piece.quaternion), _s.set(1, 1, 1));
	_world.premultiply(_inv).decompose(_p, _q, _s);
	return {
		position: _p.toArray(),
		quaternion: _q.clone(),
		size: piece.size.map((n, k) => Math.round(n * [_s.x, _s.y, _s.z][k] * 1e4) / 1e4)
	};
}

/** move + replicate + record (applyAiTransform's shape, with a quaternion) @param {any} object @param {number[]} position @param {THREE.Quaternion} quaternion */
function place(object, position, quaternion) {
	const before = { pos: object.position.toArray(), rot: [object.rotation.x, object.rotation.y, object.rotation.z], scale: object.scale.toArray() };
	object.position.fromArray(position);
	object.quaternion.copy(quaternion);
	object.scale.set(1, 1, 1);
	const after = { pos: object.position.toArray(), rot: [object.rotation.x, object.rotation.y, object.rotation.z], scale: object.scale.toArray() };
	send({ type: 'move', uuid: object.uuid, pos: after.pos, rot: after.rot, scale: after.scale });
	recordTransform({ uuid: object.uuid, before, after });
}

const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();

/**
 * What a re-scan matches walls against (nameWalls): the group's "Wall N" boxes and its other scan-made pieces,
 * in world space like the scan's pieces. A wall's length is its Box width as it stands now (scaled by the world).
 * @param {any} group
 */
function oldRoom(group) {
	/** @type {import('./roomScanCore.js').OldWall[]} */
	const walls = [];
	/** @type {import('./roomScanCore.js').OldThing[]} */
	const others = [];
	group.updateWorldMatrix(true, true);
	for (const c of group.children) {
		const name = String(c.name ?? '');
		if (!ROOM_NAME_RE.test(name)) continue;
		c.matrixWorld.decompose(_wp, _wq, _ws);
		const base = name.replace(/ \d+$/, '');
		if (base === 'Wall') {
			const width = c.userData?.geometryParams?.params?.width;
			if (!Number.isFinite(width)) continue;
			const n = new THREE.Vector3(0, 1, 0).applyQuaternion(_wq);
			walls.push({ uuid: c.uuid, name, length: width * Math.abs(_ws.x), position: _wp.toArray(), normal: n.toArray() });
		} else others.push({ base, position: _wp.toArray() });
	}
	return { walls, others };
}

/**
 * Build or update the "My room" group from named pieces, as one undo step. Walls are first renamed to the
 * group's old ones by shape (nameWalls); the pieces come back with their final names.
 * @param {import('./roomScanCore.js').NamedPiece[]} pieces
 * @returns {{group: string, created: number, updated: number, removed: number, skipped: string[], missing: string[], pieces: import('./roomScanCore.js').NamedPiece[]}}
 */
export function applyRoom(pieces) {
	/** @type {any} */
	const root = get(objectsGroup);
	if (!root) return { group: '', created: 0, updated: 0, removed: 0, skipped: [], missing: [], pieces };
	// the 37 R25 rule: inside a batch already open (an AI app's call in this tab) the scan joins it, never closes it
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		let group = findRoomGroup();
		if (!group) {
			const uuid = THREE.MathUtils.generateUUID();
			const command = '/group My_room';
			createGroup(command, uuid);
			group = root.getObjectByProperty('uuid', uuid);
			send({ type: 'group', command, uuid });
			recordObjectPresence('create', group);
			renameObject(uuid, ROOM_GROUP_NAME);
		}
		const old = oldRoom(group);
		const walls = nameWalls(pieces, old.walls, { others: old.others });
		pieces = walls.pieces;
		const plan = planUpdate(
			group.children.map((/** @type {any} */ c) => ({ uuid: c.uuid, name: c.name })),
			pieces
		);
		/** @type {string[]} */
		const skipped = [];
		let updated = 0;
		for (const { uuid, piece } of plan.update) {
			const object = group.getObjectByProperty('uuid', uuid);
			if (!object || lockedByPeer(uuid)) {
				skipped.push(piece.name);
				continue;
			}
			const pose = localPose(group, piece);
			const params = object.userData?.geometryParams?.params;
			const [width, height, depth] = pose.size;
			if (!params || params.width !== width || params.height !== height || params.depth !== depth)
				applyGeometry(uuid, { width, height, depth }, { gtype: 'Box' });
			place(object, pose.position, pose.quaternion);
			updated++;
		}
		let created = 0;
		for (const piece of plan.create) {
			const uuid = THREE.MathUtils.generateUUID();
			const pose = localPose(group, piece);
			const command = '/create Box ' + pose.size.join(' ');
			createGeometry(command, uuid);
			const object = root.getObjectByProperty('uuid', uuid);
			if (!object) {
				skipped.push(piece.name);
				continue;
			}
			send({ type: 'create', command, uuid });
			recordObjectPresence('create', object);
			renameObject(uuid, piece.name);
			moveObjectToGroup(uuid, group.uuid);
			place(object, pose.position, pose.quaternion);
			setObjectColor(uuid, colorOf(piece.base));
			setMaterialParam(uuid, 'transparent', true);
			setMaterialParam(uuid, 'opacity', ROOM_OPACITY);
			created++;
		}
		const removable = plan.remove.filter((u) => !lockedByPeer(u));
		const removed = removable.length ? deleteObjectsByUuid(removable) : 0;
		pokeScene();
		return { group: group.uuid, created, updated, removed: Number(removed) || 0, skipped, missing: walls.missing, pieces };
	} finally {
		if (own) endHistoryBatch('Scan my room');
	}
}

/**
 * The Play menu's row: the press started an AR session (requestPlay); scan once it is presenting.
 * @param {{timeoutMs?: number}} [opts]
 */
export function scanWhenSessionStarts(opts = {}) {
	if (liveSession()) return scanMyRoom();
	/** @type {any} */
	const renderer = get(globalRenderer);
	const xr = renderer?.xr;
	if (!xr) return Promise.resolve((last = { status: 'no-renderer' }));
	return new Promise((resolve) => {
		const onStart = () => {
			clearTimeout(timer);
			xr.removeEventListener('sessionstart', onStart);
			// let three set the reference space up before the first read
			setTimeout(() => resolve(scanMyRoom()), 0);
		};
		// a permission prompt the person never answers: stop listening, say nothing (nothing was started). Long:
		// Quest Browser asks once per site, and on the real Quest 3 that first answer came after 6.5 min
		const timer = setTimeout(() => {
			xr.removeEventListener('sessionstart', onStart);
			resolve((last = { status: 'no-session-started' }));
		}, opts.timeoutMs ?? 10 * 60000);
		xr.addEventListener('sessionstart', onStart);
	});
}
