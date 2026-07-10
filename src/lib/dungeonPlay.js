// Dungeon play helpers (58): collision, spawns and minimap lookups against
// the raster the dungeon module publishes on its group's userData.play
// ({grid, width, height, minX, minY, rooms, floorValue}). Pure math — the
// module owns the data, players/VR/minimap consume it here.

/** @param {any} scene @returns {any | null} the module's play payload */
export function dungeonData(scene) {
	return scene?.getObjectByName('dungeon-module')?.userData?.play ?? null;
}

/** Can a circle of radius r stand at (x, z)?
 * @param {any} data @param {number} x @param {number} z @param {number=} r */
export function walkable(data, x, z, r = 0.3) {
	if (!data) return true;
	const { grid, width, height, minX, minY, floorValue } = data;
	for (const [ox, oz] of [
		[-r, -r],
		[r, -r],
		[-r, r],
		[r, r]
	]) {
		const cx = Math.floor(x + ox - minX);
		const cz = Math.floor(z + oz - minY);
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
