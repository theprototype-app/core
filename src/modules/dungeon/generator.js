// Deterministic dungeon pipeline: seeded scatter -> AABB separation ->
// Delaunay (Bowyer-Watson) -> Prim MST + loop re-adds -> L corridors ->
// Uint8 raster. Same seed + params => same grid on every peer — determinism
// IS the netcode (only {seed, params} ever travels).
// All room math is integer to avoid float drift between engines.

export const VOID = 0;
export const FLOOR = 1;
export const WALL = 2;

/** @param {number} seed */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a += 0x6d2b79f5;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** @param {ReturnType<typeof mulberry32>} rand @param {number} count */
function scatterRooms(rand, count) {
	const rooms = [];
	for (let i = 0; i < count; i++) {
		const angle = 2 * Math.PI * rand();
		const radius = Math.sqrt(rand());
		const w = 4 + Math.floor(rand() * 8);
		const h = 4 + Math.floor(rand() * 8);
		const cx = Math.round(Math.cos(angle) * radius * 30);
		const cy = Math.round(Math.sin(angle) * radius * 20);
		rooms.push({ x: cx - (w >> 1), y: cy - (h >> 1), w, h });
	}
	return rooms;
}

/** Push overlapping rooms apart (1-cell gap), integer steps @param {any[]} rooms */
function separateRooms(rooms) {
	for (let iteration = 0; iteration < 100; iteration++) {
		let moved = false;
		for (let i = 0; i < rooms.length; i++) {
			for (let j = i + 1; j < rooms.length; j++) {
				const a = rooms[i];
				const b = rooms[j];
				const overlapX = Math.min(a.x + a.w + 1, b.x + b.w + 1) - Math.max(a.x - 1, b.x - 1);
				const overlapY = Math.min(a.y + a.h + 1, b.y + b.h + 1) - Math.max(a.y - 1, b.y - 1);
				if (overlapX <= 0 || overlapY <= 0) continue;
				moved = true;
				if (overlapX < overlapY) {
					const push = Math.ceil(overlapX / 2);
					if (a.x + a.w / 2 < b.x + b.w / 2) {
						a.x -= push;
						b.x += push;
					} else {
						a.x += push;
						b.x -= push;
					}
				} else {
					const push = Math.ceil(overlapY / 2);
					if (a.y + a.h / 2 < b.y + b.h / 2) {
						a.y -= push;
						b.y += push;
					} else {
						a.y += push;
						b.y -= push;
					}
				}
			}
		}
		if (!moved) break;
	}
	return rooms;
}

/**
 * Bowyer-Watson Delaunay triangulation.
 * @param {{x: number, y: number}[]} points
 * @returns {[number, number][]} unique edges as point-index pairs
 */
function delaunayEdges(points) {
	if (points.length < 2) return [];
	if (points.length === 2) return [[0, 1]];

	// super-triangle enclosing everything
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	points.forEach((p) => {
		minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
	});
	const span = Math.max(maxX - minX, maxY - minY, 1) * 10;
	const midX = (minX + maxX) / 2;
	const midY = (minY + maxY) / 2;
	const verts = [
		...points,
		{ x: midX - span, y: midY - span },
		{ x: midX + span, y: midY - span },
		{ x: midX, y: midY + span }
	];
	const superA = points.length, superB = points.length + 1, superC = points.length + 2;

	/** circumcircle test @param {number[]} tri @param {{x,y}} p */
	const inCircumcircle = (tri, p) => {
		const a = verts[tri[0]], b = verts[tri[1]], c = verts[tri[2]];
		const ax = a.x - p.x, ay = a.y - p.y;
		const bx = b.x - p.x, by = b.y - p.y;
		const cx = c.x - p.x, cy = c.y - p.y;
		const det =
			(ax * ax + ay * ay) * (bx * cy - cx * by) -
			(bx * bx + by * by) * (ax * cy - cx * ay) +
			(cx * cx + cy * cy) * (ax * by - bx * ay);
		// orientation-aware: normalize by triangle winding
		const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
		return area > 0 ? det > 0 : det < 0;
	};

	let triangles = [[superA, superB, superC]];
	for (let pi = 0; pi < points.length; pi++) {
		const bad = triangles.filter((t) => inCircumcircle(t, points[pi]));
		const edgeCount = new Map();
		bad.forEach((t) => {
			[[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(([u, v]) => {
				const key = u < v ? u + ':' + v : v + ':' + u;
				edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
			});
		});
		triangles = triangles.filter((t) => !bad.includes(t));
		edgeCount.forEach((count, key) => {
			if (count !== 1) return; // shared edges disappear
			const [u, v] = key.split(':').map(Number);
			triangles.push([u, v, pi]);
		});
	}

	const edges = new Set();
	triangles.forEach((t) => {
		[[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(([u, v]) => {
			if (u >= points.length || v >= points.length) return; // super-triangle
			edges.add(u < v ? u + ':' + v : v + ':' + u);
		});
	});
	return [...edges].sort().map((key) => key.split(':').map(Number));
}

/**
 * Prim MST over the Delaunay edges, then re-add skipped edges with loopChance.
 * @param {{x,y}[]} centers @param {[number, number][]} edges @param {ReturnType<typeof mulberry32>} rand @param {number} loopChance
 */
function chooseCorridors(centers, edges, rand, loopChance) {
	const dist2 = ([u, v]) =>
		(centers[u].x - centers[v].x) ** 2 + (centers[u].y - centers[v].y) ** 2;
	const inTree = new Set([0]);
	const chosen = [];
	const remaining = [...edges];
	while (inTree.size < centers.length && remaining.length > 0) {
		let best = -1;
		let bestD = Infinity;
		for (let i = 0; i < remaining.length; i++) {
			const [u, v] = remaining[i];
			if (inTree.has(u) === inTree.has(v)) continue;
			const d = dist2(remaining[i]);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		if (best < 0) break; // disconnected (shouldn't happen with delaunay)
		const edge = remaining.splice(best, 1)[0];
		chosen.push(edge);
		inTree.add(edge[0]);
		inTree.add(edge[1]);
	}
	let loops = 0;
	remaining.forEach((edge) => {
		if (rand() < loopChance) {
			chosen.push(edge);
			loops++;
		}
	});
	return { chosen, loops };
}

/**
 * Generate the full dungeon.
 * @param {number} seed @param {{roomCount?: number, loopChance?: number}} params
 */
export function generateDungeon(seed, params = {}) {
	const started = performance.now();
	const roomCount = Math.min(Math.max(params.roomCount ?? 24, 4), 80);
	const loopChance = Math.min(Math.max(params.loopChance ?? 0.15, 0), 1);
	const rand = mulberry32(seed);

	const rooms = separateRooms(scatterRooms(rand, roomCount));
	const centers = rooms.map((r) => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) }));
	const { chosen, loops } = chooseCorridors(centers, delaunayEdges(centers), rand, loopChance);

	// bounds incl. corridor + wall margin
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	rooms.forEach((r) => {
		minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
		maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
	});
	minX -= 2; minY -= 2; maxX += 2; maxY += 2;
	const width = maxX - minX + 1;
	const height = maxY - minY + 1;
	const grid = new Uint8Array(width * height);
	const carve = (x, y) => {
		if (x < minX || y < minY || x > maxX || y > maxY) return;
		grid[(y - minY) * width + (x - minX)] = FLOOR;
	};

	rooms.forEach((r) => {
		for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) carve(x, y);
	});
	// L corridors (2 wide), horizontal leg first — fixed order keeps peers identical
	chosen.forEach(([u, v]) => {
		const a = centers[u], b = centers[v];
		const stepX = a.x < b.x ? 1 : -1;
		for (let x = a.x; x !== b.x + stepX; x += stepX) { carve(x, a.y); carve(x, a.y + 1); }
		const stepY = a.y < b.y ? 1 : -1;
		for (let y = a.y; y !== b.y + stepY; y += stepY) { carve(b.x, y); carve(b.x + 1, y); }
	});
	// walls: VOID cells touching FLOOR (8-neighborhood)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (grid[y * width + x] !== VOID) continue;
			let nearFloor = false;
			for (let dy = -1; dy <= 1 && !nearFloor; dy++)
				for (let dx = -1; dx <= 1 && !nearFloor; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
					if (grid[ny * width + nx] === FLOOR) nearFloor = true;
				}
			if (nearFloor) grid[y * width + x] = WALL;
		}
	}

	return {
		grid, width, height, minX, minY,
		rooms, edges: chosen, loops,
		ms: performance.now() - started
	};
}

/** djb2 over the raster — equal checksums = identical dungeons @param {Uint8Array} grid */
export function gridChecksum(grid) {
	let hash = 5381;
	for (let i = 0; i < grid.length; i++) hash = ((hash * 33) ^ grid[i]) >>> 0;
	return hash;
}
