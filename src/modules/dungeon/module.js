import * as THREE from 'three';
import { writable } from 'svelte/store';
import { mount } from 'svelte';
import { generateDungeon, gridChecksum, mulberry32, FLOOR, WALL } from './generator.js';
import { farthestRoom, roomCenter } from '../../lib/dungeonPlay.js';
import DungeonPanel from './DungeonPanel.svelte';

// Dungeon generator: only {seed, params} replicates — every peer regenerates
// the identical dungeon locally (determinism is the netcode). The meshes live
// in a module-owned group at the SCENE root, not in objectsGroup: the dungeon
// regenerates wholesale and must never enter the object list / GLTF sync.
// Playable layer (58): the group's userData.play publishes the raster for
// collision/spawns/minimap, and a key→door objective replicates through
// module messages ({op:'key'|'door'}) + the state sync.

export const panelOpen = writable(false);
export const panelStats = writable(null);
/** objective state, readable by tests/UI: {keyHolder, doorOpen} */
export const playState = writable({ keyHolder: null, doorOpen: false });

/** @type {any} */ let apiRef = null;
/** @type {any} */ let current = null; // {seed, params} of the built dungeon
let panelMounted = false;
let play = { keyHolder: null, doorOpen: false };

const GROUP_NAME = 'dungeon-module';

/** @param {{keyHolder: string | null, doorOpen: boolean}} next */
function setPlay(next) {
	play = next;
	playState.set(next);
	const scene = apiRef?.scene();
	const group = scene?.getObjectByName(GROUP_NAME);
	const key = group?.getObjectByName('dungeon-key');
	if (key) key.visible = !next.keyHolder;
	const bar = group?.getObjectByName('dungeon-door-bar');
	if (bar) bar.visible = !next.doorOpen;
}

function clearGroup() {
	const scene = apiRef?.scene();
	const group = scene?.getObjectByName(GROUP_NAME);
	if (!group) return;
	group.traverse((child) => {
		child.geometry?.dispose?.();
		if (child.material && !Array.isArray(child.material)) child.material.dispose?.();
	});
	scene.remove(group);
}

/** Build (or rebuild) the dungeon locally @param {number} seed @param {any} params */
function build(seed, params) {
	const scene = apiRef?.scene();
	if (!scene) return;
	clearGroup();
	const result = generateDungeon(seed, params);
	const { grid, width, height, minX, minY } = result;

	const group = new THREE.Group();
	group.name = GROUP_NAME;

	let floors = 0;
	let walls = 0;
	for (let i = 0; i < grid.length; i++) {
		if (grid[i] === FLOOR) floors++;
		else if (grid[i] === WALL) walls++;
	}
	const floorMesh = new THREE.InstancedMesh(
		new THREE.BoxGeometry(1, 0.2, 1),
		new THREE.MeshStandardMaterial({ color: 0x8a7f70 }),
		floors
	);
	const wallMesh = new THREE.InstancedMesh(
		new THREE.BoxGeometry(1, 2.4, 1),
		new THREE.MeshStandardMaterial({ color: 0x4a4550 }),
		walls
	);
	const matrix = new THREE.Matrix4();
	let floorIndex = 0;
	let wallIndex = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const cell = grid[y * width + x];
			if (cell === FLOOR) {
				matrix.setPosition(minX + x + 0.5, -0.1, minY + y + 0.5);
				floorMesh.setMatrixAt(floorIndex++, matrix);
			} else if (cell === WALL) {
				matrix.setPosition(minX + x + 0.5, 1.2, minY + y + 0.5);
				wallMesh.setMatrixAt(wallIndex++, matrix);
			}
		}
	}
	group.add(floorMesh, wallMesh);

	// a few torches in random rooms (own rand stream, still seed-deterministic)
	const torchRand = mulberry32(seed ^ 0xbeef);
	const torchRooms = [...result.rooms].slice(0, 64);
	for (let i = 0; i < Math.min(8, torchRooms.length); i++) {
		const room = torchRooms[Math.floor(torchRand() * torchRooms.length)];
		const light = new THREE.PointLight(0xffaa55, 6, 14);
		light.position.set(room.x + (room.w >> 1) + 0.5, 1.8, room.y + (room.h >> 1) + 0.5);
		group.add(light);
	}

	// objective props (58.4): the key waits in the farthest room, the exit
	// door frame stands in the FIRST room — both seed-deterministic
	const keyRoom = farthestRoom(result.rooms);
	if (keyRoom) {
		const c = roomCenter(keyRoom);
		const key = new THREE.Mesh(
			new THREE.OctahedronGeometry(0.22, 0),
			new THREE.MeshStandardMaterial({ color: 0xffc93d, emissive: 0x8a6a00, emissiveIntensity: 0.8 })
		);
		key.name = 'dungeon-key';
		key.position.set(c.x, 0.9, c.z);
		group.add(key);
	}
	if (result.rooms.length) {
		const c = roomCenter(result.rooms[0]);
		const door = new THREE.Group();
		door.name = 'dungeon-door';
		door.position.set(c.x, 0, c.z);
		const frameMat = new THREE.MeshStandardMaterial({ color: 0x2d3340 });
		const left = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.2, 0.2), frameMat);
		left.position.set(-0.7, 1.1, 0);
		const right = left.clone();
		right.position.x = 0.7;
		const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.2, 0.2), frameMat);
		top.position.set(0, 2.2, 0);
		const bar = new THREE.Mesh(
			new THREE.BoxGeometry(1.2, 2, 0.08),
			new THREE.MeshStandardMaterial({
				color: 0x39d0ff,
				emissive: 0x1a6f8f,
				emissiveIntensity: 0.9,
				transparent: true,
				opacity: 0.55
			})
		);
		bar.name = 'dungeon-door-bar';
		bar.position.set(0, 1.1, 0);
		door.add(left, right, top, bar);
		group.add(door);
	}

	const stats = {
		rooms: result.rooms.length,
		loops: result.loops,
		ms: Math.round(result.ms * 10) / 10,
		checksum: gridChecksum(grid),
		floors,
		walls
	};
	group.userData = {
		seed,
		params,
		...stats,
		// the play contract (58): collision/spawn/minimap raster for dungeonPlay.js
		play: { grid, width, height, minX, minY, rooms: result.rooms, floorValue: FLOOR }
	};
	scene.add(group);
	current = { seed, params };
	setPlay({ keyHolder: null, doorOpen: false });
	panelStats.set(stats);
}

function clear() {
	clearGroup();
	current = null;
	setPlay({ keyHolder: null, doorOpen: false });
	panelStats.set(null);
}

/** Local pickup/open attempt (click handler + tests) @param {string} what */
export function tryObjective(what) {
	if (!apiRef || !current) return false;
	const me = apiRef.peerId() ?? 'me';
	if (what === 'key' && !play.keyHolder) {
		setPlay({ ...play, keyHolder: me });
		apiRef.send({ op: 'key', holder: me });
		apiRef.toast('You picked up the key — find the glowing door!');
		return true;
	}
	if (what === 'door' && !play.doorOpen) {
		if (play.keyHolder !== me) {
			apiRef.toast(play.keyHolder ? 'The key holder must open the door' : 'The door needs a key');
			return false;
		}
		setPlay({ ...play, doorOpen: true });
		apiRef.send({ op: 'door' });
		apiRef.toast('The door opens — dungeon escaped! 🎉');
		return true;
	}
	return false;
}

/** Panel action: generate locally and tell every peer @param {number} seed @param {any} params */
export function generateAndBroadcast(seed, params) {
	build(seed, params);
	apiRef?.send({ op: 'generate', seed: seed, params: params });
}

export function clearAndBroadcast() {
	clear();
	apiRef?.send({ op: 'clear' });
}

export default {
	id: 'dungeon',
	name: 'Dungeon generator',
	version: '1.0.0',
	description: 'Seed-replicated procedural dungeon generator (rooms, corridors, torches).',
	/** @param {any} api */
	register(api) {
		apiRef = api;

		api.registerSystemGroup(GROUP_NAME); // visible under the System filter
		api.registerInteractiveGroup(GROUP_NAME); // key/door are clickable (58.4)

		api.registerMenu('Dungeon generator', () => {
			if (!panelMounted && typeof document !== 'undefined') {
				panelMounted = true;
				mount(DungeonPanel, { target: document.body });
			}
			panelOpen.set(true);
		});

		// desktop click + VR trigger on the key/door (58.4)
		api.registerClickHandler((/** @type {any} */ mesh) => {
			if (mesh?.name === 'dungeon-key') return tryObjective('key');
			if (mesh?.name === 'dungeon-door-bar' || mesh?.parent?.name === 'dungeon-door') return tryObjective('door');
			return false;
		});

		api.onMessage((/** @type {any} */ data) => {
			if (data.op === 'generate') build(data.seed, data.params);
			else if (data.op === 'clear') clear();
			else if (data.op === 'key') {
				setPlay({ ...play, keyHolder: data.holder });
				apiRef.toast('The key was picked up!');
			} else if (data.op === 'door') {
				setPlay({ ...play, doorOpen: true });
				apiRef.toast('The door opens — dungeon escaped! 🎉');
			}
		});

		api.onSceneClear(() => clear());

		// late joiners rebuild from the current seed + objective state
		api.registerStateSync({
			getState: () => (current ? { ...current, play } : null),
			applyState: (/** @type {any} */ state) => {
				if (state?.seed != null) {
					build(state.seed, state.params);
					if (state.play) setPlay(state.play);
				}
			}
		});
	}
};
