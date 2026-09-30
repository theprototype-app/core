// Dungeon play helpers (58): collision, spawns and minimap lookups against
// the raster the dungeon module publishes on its group's userData.play
// ({grid, width, height, minX, minY, rooms, floorValue}). Pure math — the
// module owns the data, players/VR/minimap consume it here.

// 31-perf P1: the walker, the flier, the VR walk and the minimap each asked this EVERY
// FRAME, and `getObjectByName` is a whole-scene traversal — in every game, dungeon or not
// (a miss walks everything). A hit is cached and re-validated by walking UP its parents
// (a few steps) to the scene it was asked about; a miss is remembered for MISS_MS, so a
// scene with no dungeon pays one traversal four times a second instead of per frame.
const MISS_MS = 250;
/** @type {any} */ let cachedGroup = null;
/** @type {any} */ let missScene = null;
let missAt = -Infinity;

/** @param {any} object @param {any} scene */
function attachedTo(object, scene) {
	let o = object;
	while (o?.parent) o = o.parent;
	return o === scene;
}

/** @param {any} scene @returns {any | null} the module's play payload */
export function dungeonData(scene) {
	if (!scene) return null;
	if (cachedGroup && cachedGroup.name === 'dungeon-module' && attachedTo(cachedGroup, scene)) return cachedGroup.userData?.play ?? null;
	cachedGroup = null;
	const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
	if (missScene === scene && now - missAt < MISS_MS) return null;
	const found = scene.getObjectByName?.('dungeon-module') ?? null;
	if (found) {
		cachedGroup = found;
		missScene = null;
		return found.userData?.play ?? null;
	}
	missScene = scene;
	missAt = now;
	return null;
}

/** Forget the cached lookup (a test swapping dungeons within the miss window). */
export function forgetDungeonData() {
	cachedGroup = null;
	missScene = null;
}

/** Can a circle of radius r stand at (x, z)?
 * @param {any} data @param {number} x @param {number} z @param {number=} r */
export function walkable(data, x, z, r = 0.3) {
	if (!data) return true;
	const { grid, width, height, minX, minY, floorValue } = data;
	// the four corners of the circle's box, without an array of arrays per call (this runs
	// twice per walking frame)
	for (let i = 0; i < 4; i++) {
		const cx = Math.floor(x + (i & 1 ? r : -r) - minX);
		const cz = Math.floor(z + (i & 2 ? r : -r) - minY);
		if (cx < 0 || cz < 0 || cx >= width || cz >= height) return false;
		if (grid[cz * width + cx] !== floorValue) return false;
	}
	return true;
}

/**
 * AABB slide: try the x step, then the z step, so walls stop you but you
 * slide along them. Returns the allowed position.
 * @param {any} data @param {number} x @param {number} z @param {number} dx @param {number} dz
 */
export function slideMove(data, x, z, dx, dz, r = 0.3) {
	if (!data) return { x: x + dx, z: z + dz };
	const nx = walkable(data, x + dx, z, r) ? x + dx : x;
	const nz = walkable(data, nx, z + dz, r) ? z + dz : z;
	return { x: nx, z: nz };
}

/** Center of a room @param {any} room */
export function roomCenter(room) {
	return { x: room.x + room.w / 2, z: room.y + room.h / 2 };
}

/**
 * Deterministic spawn (58.2): peers sort by id and take consecutive rooms,
 * so everyone agrees who spawns where without a message.
 * @param {any} data @param {string[]} peerIds every id incl. our own @param {string} myId
 */
export function spawnPointFor(data, peerIds, myId) {
	if (!data?.rooms?.length) return null;
	const sorted = [...new Set([...(peerIds ?? []), myId])].sort();
	const index = Math.max(0, sorted.indexOf(myId));
	const room = data.rooms[index % data.rooms.length];
	return roomCenter(room);
}

/** The room farthest from the first one (key spawn, 58.4) @param {any} rooms */
export function farthestRoom(rooms) {
	if (!rooms?.length) return null;
	const start = roomCenter(rooms[0]);
	let best = rooms[0];
	let bestDist = -1;
	for (const room of rooms) {
		const c = roomCenter(room);
		const d = (c.x - start.x) ** 2 + (c.z - start.z) ** 2;
		if (d > bestDist) {
			bestDist = d;
			best = room;
		}
	}
	return best;
}
