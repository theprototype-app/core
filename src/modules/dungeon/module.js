import * as THREE from 'three';
import { writable } from 'svelte/store';
import { mount } from 'svelte';
import { generateDungeon, gridChecksum, mulberry32, FLOOR, WALL } from './generator.js';
import DungeonPanel from './DungeonPanel.svelte';

// Dungeon generator: only {seed, params} replicates — every peer regenerates
// the identical dungeon locally (determinism is the netcode). The meshes live
// in a module-owned group at the SCENE root, not in objectsGroup: the dungeon
// regenerates wholesale and must never enter the object list / GLTF sync.

export const panelOpen = writable(false);
export const panelStats = writable(null);

/** @type {any} */ let apiRef = null;
/** @type {any} */ let current = null; // {seed, params} of the built dungeon
let panelMounted = false;

const GROUP_NAME = 'dungeon-module';

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

	const stats = {
		rooms: result.rooms.length,
		loops: result.loops,
		ms: Math.round(result.ms * 10) / 10,
		checksum: gridChecksum(grid),
		floors,
		walls
	};
	group.userData = { seed, params, ...stats };
	scene.add(group);
	current = { seed, params };
	panelStats.set(stats);
}

function clear() {
	clearGroup();
	current = null;
	panelStats.set(null);
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

		api.registerMenu('Dungeon generator', () => {
			if (!panelMounted && typeof document !== 'undefined') {
				panelMounted = true;
				mount(DungeonPanel, { target: document.body });
			}
			panelOpen.set(true);
		});

		api.onMessage((data) => {
			if (data.op === 'generate') build(data.seed, data.params);
			else if (data.op === 'clear') clear();
		});

		api.onSceneClear(() => clear());

		// late joiners rebuild from the current seed
		api.registerStateSync({
			getState: () => current,
			applyState: (state) => {
				if (state?.seed != null) build(state.seed, state.params);
			}
		});
	}
};
