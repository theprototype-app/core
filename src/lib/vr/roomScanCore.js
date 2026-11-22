// 104 D1 — SCAN MY ROOM, the pure half. A LEAF: three's maths only, no stores, no session.
//
// The headset's room setup (Meta Space Setup) hands a WebXR page its walls, floor, ceiling and furniture as
// PLANES (`frame.detectedPlanes`: a polygon in the plane's own space, +Y = the normal into the room) and, on
// Quest 3, furniture VOLUMES as MESHES (`frame.detectedMeshes`: a box-shaped mesh in its own space), each with
// a `semanticLabel`. No camera image is involved anywhere: these are the shapes the person drew in setup.
//
// This file turns what roomScan.js read off one frame into NAMED BOXES at real size (metres, world space):
//   plane  → a 2 cm panel BEHIND the surface (a wall's face stays where the real wall is), door / window /
//            wall art a 1 cm panel just IN FRONT of the wall so it shows; a furniture plane with no volume →
//            a box from its top down to the floor.
//   volume → the mesh's own bounding box.
// and plans the update of an existing "My room" group by NAME (planUpdate): names are deterministic, so a
// second scan of the same room updates the same objects instead of adding a second room. WALLS are first
// matched to the old ones by shape (nameWalls), because their numbers follow the session's facing.

import * as THREE from 'three';

export const ROOM_GROUP_NAME = 'My room';
/** panel thickness for walls, floor, ceiling (m) */
export const PANEL = 0.02;
/** door / window / wall art sit this thick in front of their wall (m) */
export const INSET = 0.01;
/** the most pieces one scan makes (Quest budget: each is a draw call) */
export const MAX_PIECES = 64;
/** a plane or volume smaller than this on a side is noise (m) */
const MIN_SIDE = 0.03;
/** Space Setup's furniture volumes are boxes (8 corners; 24 if a browser sends a vertex per face corner). An
 * UNLABELLED mesh with more vertices is the room mesh: Quest Browser 157 sends it with no semanticLabel
 * (real Quest 3, 2026-11-22: 6245 vertices), not as 'global mesh'. */
const MAX_BOX_VERTICES = 24;

/** label → base name; `null` = never built (the room mesh, the invisible walls Space Setup adds) */
const LABELS = /** @type {Record<string, string | null>} */ ({
	floor: 'Floor',
	ceiling: 'Ceiling',
	wall: 'Wall',
	'wall face': 'Wall',
	table: 'Table',
	desk: 'Desk',
	couch: 'Couch',
	bed: 'Bed',
	door: 'Door',
	'door frame': 'Door',
	window: 'Window',
	'window frame': 'Window',
	shelf: 'Shelf',
	storage: 'Storage',
	screen: 'Screen',
	lamp: 'Lamp',
	plant: 'Plant',
	'wall art': 'Wall art',
	other: 'Object',
	'global mesh': null,
	'invisible wall face': null
});

/** kinds that hang ON a wall (thin, in front of it) */
const ON_WALL = new Set(['Door', 'Window', 'Wall art', 'Screen']);
/** kinds that are the room's shell */
const SHELL = new Set(['Floor', 'Ceiling', 'Wall']);

/** the colour each kind is drawn in (plain, so the assistant's materials read as a change) */
export const ROOM_COLORS = /** @type {Record<string, string>} */ ({
	Floor: '#8a8f98',
	Ceiling: '#d8dade',
	Wall: '#c9ccd2',
	Door: '#9a7552',
	Window: '#7fb3d9',
	'Wall art': '#b98fc4',
	Screen: '#3a3f47',
	Object: '#b0a48f'
});
/** furniture that is not listed above */
export const FURNITURE_COLOR = '#c79a5b';

/** Every name a scan writes: `Wall 3`, `Floor`, `Table 2` … (planUpdate only ever removes these). */
export const ROOM_NAME_RE = new RegExp(
	'^(' + [...new Set(Object.values(LABELS).filter(Boolean))].join('|') + ')( \\d+)?$'
);

/**
 * The base name of a semantic label, `null` for one that is never built.
 * @param {string | undefined | null} label @returns {string | null}
 */
export function labelName(label) {
	const key = String(label ?? '').trim().toLowerCase();
	if (!key) return 'Object';
	if (key in LABELS) return LABELS[key];
	return 'Object';
}

/** no semantic label at all (Quest Browser leaves the room mesh and some volumes unlabelled) @param {unknown} label */
const unlabelled = (label) => !String(label ?? '').trim();

/** @param {string} base */
export function colorOf(base) {
	return ROOM_COLORS[base] ?? FURNITURE_COLOR;
}

/**
 * @typedef {{label?: string, polygon: {x: number, z: number}[], matrix: ArrayLike<number>}} PlaneIn
 *   one plane: its polygon in plane space (y = 0) and the plane space's pose (column-major 4x4)
 * @typedef {{label?: string, vertices: ArrayLike<number>, matrix: ArrayLike<number>}} MeshIn
 * @typedef {{base: string, from: 'plane' | 'volume', size: number[], position: number[], quaternion: number[]}} Piece
 *   a box: Box params [w, h, d] and its centre pose in world space
 * @typedef {Piece & {name: string}} NamedPiece
 */

const _m = new THREE.Matrix4();
const _o = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/** a pose matrix + a local offset/turn → the piece's world pose @param {ArrayLike<number>} matrix @param {THREE.Vector3} at @param {number} yaw */
function poseOf(matrix, at, yaw) {
	_m.fromArray(/** @type {number[]} */ (Array.from(matrix)));
	_o.makeRotationY(yaw).setPosition(at);
	_m.multiply(_o).decompose(_p, _q, _s);
	return { position: _p.toArray(), quaternion: _q.toArray() };
}

/**
 * The smallest rectangle around a polygon whose sides follow its longest edge (Space Setup's planes are
 * rectangles; a turned one would get a loose box from a plain min/max).
 * @param {{x: number, z: number}[]} poly @returns {{w: number, d: number, cx: number, cz: number, yaw: number} | null}
 */
export function polygonRect(poly) {
	if (!Array.isArray(poly) || poly.length < 3) return null;
	let yaw = 0;
	let best = -1;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const len = Math.hypot(b.x - a.x, b.z - a.z);
		if (len > best) {
			best = len;
			yaw = Math.atan2(b.z - a.z, b.x - a.x);
		}
	}
	// the box frame is the plane frame turned about +Y so its x axis runs along the edge (cos a, sin a):
	// three's Ry(-a). A point's coordinates in it are Ry(a)·p: (x c + z s, -x s + z c)
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const p of poly) {
		if (!Number.isFinite(p?.x) || !Number.isFinite(p?.z)) return null;
		const lx = p.x * c + p.z * s;
		const lz = -p.x * s + p.z * c;
		minX = Math.min(minX, lx);
		maxX = Math.max(maxX, lx);
		minZ = Math.min(minZ, lz);
		maxZ = Math.max(maxZ, lz);
	}
	const mx = (minX + maxX) / 2;
	const mz = (minZ + maxZ) / 2;
	// the centre back in plane space: Ry(-a)·(mx, mz)
	return { w: maxX - minX, d: maxZ - minZ, cx: mx * c - mz * s, cz: mx * s + mz * c, yaw: -yaw };
}

/**
 * One plane → one box, or null (never built, too small, malformed). `floorY` (world) turns a furniture
 * plane's top into a box down to the floor.
 * @param {PlaneIn} plane @param {{floorY?: number | null}} [opts] @returns {Piece | null}
 */
export function planePiece(plane, opts = {}) {
	const base = labelName(plane?.label);
	if (!base || !plane?.matrix || plane.matrix.length !== 16) return null;
	const rect = polygonRect(plane.polygon);
	if (!rect || rect.w < MIN_SIDE || rect.d < MIN_SIDE) return null;
	let h = PANEL;
	let y = -PANEL / 2;
	if (ON_WALL.has(base)) {
		h = INSET;
		y = INSET / 2;
	} else if (!SHELL.has(base) && base !== 'Object') {
		// furniture top: down to the floor when the plane faces up and a floor is known
		const top = plane.matrix[13];
		const upY = plane.matrix[5]; // plane +Y in world (column 1, row 1)
		if (opts.floorY != null && upY > 0.9 && top - opts.floorY > MIN_SIDE) {
			h = top - opts.floorY;
			y = -h / 2;
		}
	}
	const pose = poseOf(plane.matrix, new THREE.Vector3(rect.cx, y, rect.cz), rect.yaw);
	return { base, from: 'plane', size: [rect.w, h, rect.d].map(r4), ...roundPose(pose) };
}

/**
 * One mesh (a furniture volume) → its bounding box in its own space, or null.
 * @param {MeshIn} mesh @returns {Piece | null}
 */
export function meshPiece(mesh) {
	const base = labelName(mesh?.label);
	if (!base || SHELL.has(base) || !mesh?.matrix || mesh.matrix.length !== 16) return null;
	const v = mesh.vertices;
	if (!v || v.length < 9 || v.length % 3) return null;
	if (unlabelled(mesh?.label) && v.length / 3 > MAX_BOX_VERTICES) return null; // the room mesh
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < v.length; i += 3)
		for (let k = 0; k < 3; k++) {
			const n = v[i + k];
			if (!Number.isFinite(n)) return null;
			if (n < min[k]) min[k] = n;
			if (n > max[k]) max[k] = n;
		}
	const size = [0, 1, 2].map((k) => max[k] - min[k]);
	if (size.some((n) => n < MIN_SIDE)) return null;
	const at = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
	const pose = poseOf(mesh.matrix, at, 0);
	return { base, from: 'volume', size: size.map(r4), ...roundPose(pose) };
}

/** is a world point inside a piece's box (grown by `pad` m)? @param {Piece} piece @param {number[]} point @param {number} pad */
function inside(piece, point, pad) {
	_q.fromArray(piece.quaternion).invert();
	_p.fromArray(point).sub(_s.fromArray(piece.position)).applyQuaternion(_q);
	return [_p.x, _p.y, _p.z].every((n, k) => Math.abs(n) <= piece.size[k] / 2 + pad);
}

/**
 * Everything one frame gave → the named pieces of a room, in a stable order:
 * Floor, Ceiling, Wall 1… (clockwise seen from above, from the wall straight ahead of -Z), then the rest by
 * kind and position. A furniture plane inside a volume of its kind is dropped (the volume is the real size).
 * @param {{planes?: PlaneIn[], meshes?: MeshIn[]}} input @returns {NamedPiece[]}
 */
export function roomPieces(input) {
	const planes = Array.isArray(input?.planes) ? input.planes : [];
	const meshes = Array.isArray(input?.meshes) ? input.meshes : [];
	// the floor's height (the lowest floor plane) for furniture tops
	let floorY = /** @type {number | null} */ (null);
	for (const p of planes)
		if (labelName(p?.label) === 'Floor' && p?.matrix?.length === 16) floorY = floorY == null ? p.matrix[13] : Math.min(floorY, p.matrix[13]);
	const built = meshes.map((m) => ({ m, piece: meshPiece(m) })).filter((x) => x.piece);
	const volumes = /** @type {Piece[]} */ (built.map((x) => x.piece));
	const builtPlanes = planes.map((p) => ({ p, piece: planePiece(p, { floorY }) }));
	/** a plane's own origin in world space (the polygon's frame) @param {PlaneIn} p @param {Piece} piece */
	const originOf = (p, piece) => (p.matrix.length === 16 ? [p.matrix[12], p.matrix[13], p.matrix[14]] : piece.position);
	// An unlabelled volume (Quest Browser sends a shelf's volume with no label, its top plane labelled 'shelf')
	// takes the kind of a labelled furniture plane inside it, so the two become one box, the volume
	built.forEach(({ m, piece: v }) => {
		if (!v || v.base !== 'Object' || !unlabelled(m?.label)) return;
		const top = builtPlanes.find(({ p, piece }) => piece && piece.base !== 'Object' && !SHELL.has(piece.base) && !ON_WALL.has(piece.base) && inside(v, originOf(p, piece), 0.1));
		if (top?.piece) v.base = top.piece.base;
	});
	/** @type {Piece[]} */
	const pieces = [...volumes];
	for (const { p, piece } of builtPlanes) {
		if (!piece) continue;
		if (!SHELL.has(piece.base) && !ON_WALL.has(piece.base) && volumes.some((v) => v.base === piece.base && inside(v, originOf(p, piece), 0.1)))
			continue;
		pieces.push(piece);
	}
	// the room's middle (walls' centres) orders the walls around it
	const walls = pieces.filter((p) => p.base === 'Wall');
	const mid = walls.length
		? [0, 2].map((k) => walls.reduce((sum, w) => sum + w.position[k], 0) / walls.length)
		: [0, 0];
	/** clockwise from -Z seen from above: atan2(x, -z) in [0, 2π) @param {Piece} p */
	const around = (p) => {
		const a = Math.atan2(p.position[0] - mid[0], -(p.position[2] - mid[1]));
		return a < 0 ? a + 2 * Math.PI : a;
	};
	const rank = (/** @type {string} */ base) => (base === 'Floor' ? 0 : base === 'Ceiling' ? 1 : base === 'Wall' ? 2 : 3);
	pieces.sort(
		(a, b) =>
			rank(a.base) - rank(b.base) ||
			(a.base === 'Wall' && b.base === 'Wall' ? around(a) - around(b) : 0) ||
			a.base.localeCompare(b.base) ||
			a.position[0] - b.position[0] ||
			a.position[2] - b.position[2]
	);
	/** @type {Record<string, number>} */
	const count = {};
	return pieces.slice(0, MAX_PIECES).map((p) => {
		const n = (count[p.base] = (count[p.base] ?? 0) + 1);
		// walls are always numbered (Wall 1 … ); anything else is numbered from its second
		const name = p.base === 'Wall' ? 'Wall ' + n : n === 1 ? p.base : p.base + ' ' + n;
		return { ...p, name };
	});
}

/** a re-scan wall matches an old one when their lengths are this close (m) — the orchestrator's 3 cm */
export const WALL_LENGTH_TOL = 0.03;
/** …and, once the two rooms are laid over each other, their centres this close (m) */
const WALL_PLACE_TOL = 0.3;
/** …and their faces turned no more than this apart (radians) */
const WALL_TURN_TOL = (20 * Math.PI) / 180;
/** furniture further than this from its match counts as this far (one moved chair must not decide) (m) */
const FURNITURE_CAP = 1;
/** two fits whose furniture differs by less than this are a tie (m, mean) */
const FURNITURE_TIE = 0.05;
const WALL_NAME_RE = /^Wall (\d+)$/;

/**
 * @typedef {{uuid: string, name: string, length: number, position: number[], normal: number[]}} OldWall
 *   a "Wall N" already in the group, in the SAME world frame as this scan's pieces (its width, centre, face normal)
 * @typedef {{base: string, position: number[]}} OldThing  another scan-made piece already in the group (a tie-breaker)
 */

/** a wall's face normal (its box's +Y) in world space @param {Piece} piece */
export function wallNormal(piece) {
	_p.set(0, 1, 0).applyQuaternion(_q.fromArray(piece.quaternion));
	return [_p.x, _p.y, _p.z];
}

/** the turn about +Y (radians, in [-π, π]) @param {number} a */
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** a direction's angle on the floor @param {number[]} n */
const heading = (n) => Math.atan2(n[2], n[0]);

/**
 * WALL NAMES THAT STAY PUT. The first scan numbers the walls clockwise from the one ahead of the session's
 * -Z (roomPieces); a later session faces another way, so that rule alone gives "Wall 1" to another real
 * wall and the person's edits on it move with the name (real Quest 3, 2026-11-22: session 1 named the long
 * walls Wall 2 + Wall 4, session 2 Wall 1 + Wall 3). So a re-scan matches by SHAPE: every pairing of an old
 * wall with a new one of the same length (within WALL_LENGTH_TOL) proposes one turn + shift that lays the
 * old room over the new one; the proposal that then places the most walls (length, facing and centre — so
 * each wall's clockwise neighbours line up too) wins. A rectangle fits two ways round; the room's other
 * pieces (a table near one long wall) decide, then the smaller move (the session did not turn), then the
 * closer fit. Matched walls take their old names; a new wall takes the next free number; an old wall not
 * found keeps its name and is reported (`missing`) — it is never removed by a scan.
 * @param {NamedPiece[]} pieces this scan (roomPieces' names) @param {OldWall[]} oldWalls
 * @param {{others?: OldThing[]}} [opts]
 * @returns {{pieces: NamedPiece[], missing: string[], matched: number}}
 */
export function nameWalls(pieces, oldWalls, opts = {}) {
	const old = (oldWalls ?? []).filter(
		(w) => WALL_NAME_RE.test(String(w?.name ?? '')) && Number.isFinite(w.length) && w.position?.length === 3 && w.normal?.length === 3
	);
	if (!old.length) return { pieces, missing: [], matched: 0 };
	const fresh = pieces.map((p, i) => ({ p, i })).filter((x) => x.p.base === 'Wall');
	const freshN = fresh.map((x) => wallNormal(x.p));
	const others = (opts.others ?? []).filter((o) => o?.base && o.base !== 'Wall' && !SHELL.has(o.base) && o.position?.length === 3);
	const freshOthers = pieces.filter((p) => p.base !== 'Wall' && !SHELL.has(p.base));
	/** @param {number} turn @param {number[]} shift @param {number[]} at an old point → where it lands in this scan (x, z) */
	const lay = (turn, shift, at) => {
		const c = Math.cos(turn);
		const s = Math.sin(turn);
		// the same turn as the headings: angle(x, z) grows by `turn`
		return [at[0] * c - at[2] * s + shift[0], at[0] * s + at[2] * c + shift[1]];
	};
	/** @type {WallFit | null} */
	let best = null;
	for (let a = 0; a < old.length; a++)
		for (let b = 0; b < fresh.length; b++) {
			if (Math.abs(old[a].length - fresh[b].p.size[0]) > WALL_LENGTH_TOL) continue;
			const turn = wrap(heading(freshN[b]) - heading(old[a].normal));
			const at = lay(turn, [0, 0], old[a].position);
			const shift = [fresh[b].p.position[0] - at[0], fresh[b].p.position[2] - at[1]];
			// every old wall → the closest new wall that fits it, one each (closest pairs first)
			/** @type {{k: number, j: number, d: number}[]} */
			const options = [];
			old.forEach((w, k) => {
				const to = lay(turn, shift, w.position);
				fresh.forEach((f, j) => {
					if (Math.abs(w.length - f.p.size[0]) > WALL_LENGTH_TOL) return;
					if (Math.abs(wrap(heading(freshN[j]) - heading(w.normal) - turn)) > WALL_TURN_TOL) return;
					const d = Math.hypot(f.p.position[0] - to[0], f.p.position[2] - to[1]);
					if (d <= WALL_PLACE_TOL) options.push({ k, j, d });
				});
			});
			options.sort((x, y) => x.d - y.d || x.k - y.k || x.j - y.j);
			const takenK = new Set();
			const takenJ = new Set();
			/** @type {[number, number][]} */
			const pairs = [];
			let residual = 0;
			for (const o of options) {
				if (takenK.has(o.k) || takenJ.has(o.j)) continue;
				takenK.add(o.k);
				takenJ.add(o.j);
				pairs.push([o.k, o.j]);
				residual += o.d;
			}
			// the room's other pieces under this fit: mean distance to the nearest new piece of their kind
			let furniture = 0;
			for (const o of others) {
				const to = lay(turn, shift, o.position);
				let d = FURNITURE_CAP;
				for (const f of freshOthers) if (f.base === o.base) d = Math.min(d, Math.hypot(f.position[0] - to[0], f.position[2] - to[1]));
				furniture += d;
			}
			if (others.length) furniture /= others.length;
			const cand = { pairs, turn, shift, residual, furniture };
			if (!best || better(cand, best)) best = cand;
		}
	/** @type {Map<number, string>} piece index → its old name */
	const named = new Map();
	const found = new Set();
	for (const [k, j] of best?.pairs ?? []) {
		named.set(fresh[j].i, old[k].name);
		found.add(old[k].name);
	}
	let next = Math.max(0, ...old.map((w) => Number(WALL_NAME_RE.exec(w.name)?.[1] ?? 0)));
	const out = pieces.map((p, i) => (p.base !== 'Wall' ? p : { ...p, name: named.get(i) ?? 'Wall ' + ++next }));
	const missing = [...new Set(old.map((w) => w.name))]
		.filter((n) => !found.has(n))
		.sort((x, y) => Number(WALL_NAME_RE.exec(x)?.[1]) - Number(WALL_NAME_RE.exec(y)?.[1]));
	return { pieces: out, missing, matched: found.size };
}

/** @typedef {{pairs: [number, number][], turn: number, shift: number[], residual: number, furniture: number}} WallFit */
/** fit ranking: more walls placed → furniture closer (beyond a tie) → the smaller move → the closer fit
 * @param {WallFit} a @param {WallFit} b */
function better(a, b) {
	if (a.pairs.length !== b.pairs.length) return a.pairs.length > b.pairs.length;
	if (Math.abs(a.furniture - b.furniture) > FURNITURE_TIE) return a.furniture < b.furniture;
	const move = (/** @type {WallFit} */ f) => Math.abs(f.turn) + Math.hypot(f.shift[0], f.shift[1]);
	if (Math.abs(move(a) - move(b)) > 1e-6) return move(a) < move(b);
	return a.residual < b.residual - 1e-9;
}

/**
 * A re-scan against the group already there: a child whose name a scan writes is updated (same name) or
 * removed (gone from the room; never a "Wall N", see nameWalls); every other child (renamed, added by hand or by the assistant) is left alone.
 * @param {{uuid: string, name: string}[]} children @param {NamedPiece[]} pieces
 * @returns {{create: NamedPiece[], update: {uuid: string, piece: NamedPiece}[], remove: string[]}}
 */
export function planUpdate(children, pieces) {
	const byName = new Map();
	for (const c of children ?? []) if (ROOM_NAME_RE.test(String(c?.name ?? '')) && !byName.has(c.name)) byName.set(c.name, c.uuid);
	/** @type {NamedPiece[]} */
	const create = [];
	/** @type {{uuid: string, piece: NamedPiece}[]} */
	const update = [];
	const used = new Set();
	for (const piece of pieces) {
		const uuid = byName.get(piece.name);
		if (uuid) {
			update.push({ uuid, piece });
			used.add(uuid);
		} else create.push(piece);
	}
	// a wall is never removed by a scan: one not found keeps its name (nameWalls reports it)
	const remove = [...byName.entries()].filter(([n, u]) => !used.has(u) && !WALL_NAME_RE.test(n)).map(([, u]) => u);
	return { create, update, remove };
}

/**
 * The line the person reads when the scan lands (the confirm line — it says no camera image was used).
 * @param {NamedPiece[]} pieces @param {{created: number, updated: number, removed: number, missing?: string[]}} [counts]
 */
export function scanSummary(pieces, counts) {
	/** @type {Record<string, number>} */
	const by = {};
	for (const p of pieces) by[p.base] = (by[p.base] ?? 0) + 1;
	const order = Object.keys(by).sort((a, b) => (a === 'Wall' ? -1 : b === 'Wall' ? 1 : 0));
	const parts = order.map((b) => (by[b] === 1 ? b.toLowerCase() : by[b] + ' ' + plural(b.toLowerCase())));
	const again = counts && counts.updated ? ' (updated)' : '';
	const missing = counts?.missing?.length ? ' ' + listOf(counts.missing) + ' not found in this scan.' : '';
	return ROOM_GROUP_NAME + again + ': ' + parts.join(', ') + '.' + missing + ' From your headset’s room setup; no camera image used or stored.';
}

/** "Wall 3", "Wall 1 and Wall 3", "Wall 1, Wall 2 and Wall 3" @param {string[]} names */
const listOf = (names) => (names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]);
/** @param {string} word */
const plural = (word) => (word.endsWith('s') ? word : word.endsWith('h') ? word + 'es' : word + 's');
/** 0.1 mm @param {number} n */
const r4 = (n) => Math.round(n * 1e4) / 1e4;
/** @param {{position: number[], quaternion: number[]}} pose */
const roundPose = (pose) => ({ position: pose.position.map(r4), quaternion: pose.quaternion.map((n) => Math.round(n * 1e6) / 1e6) });

/**
 * What one XR frame holds of the room: every detected plane and mesh with its pose in `space` (the app's
 * reference space, so the poses are world coordinates). Planes / meshes with no pose this frame are skipped.
 * `frame.detectedMeshes` is absent where the browser did not grant mesh-detection — planes alone then.
 * @param {any} frame an XRFrame @param {any} space an XRReferenceSpace
 * @returns {{planes: PlaneIn[], meshes: MeshIn[]}}
 */
export function readFrame(frame, space) {
	/** @type {PlaneIn[]} */
	const planes = [];
	/** @type {MeshIn[]} */
	const meshes = [];
	try {
		for (const plane of frame?.detectedPlanes ?? []) {
			const pose = frame.getPose(plane.planeSpace, space);
			if (!pose) continue;
			planes.push({
				label: plane.semanticLabel,
				polygon: Array.from(plane.polygon ?? [], (/** @type {any} */ p) => ({ x: p.x, z: p.z })),
				matrix: Array.from(pose.transform.matrix)
			});
		}
		for (const mesh of frame?.detectedMeshes ?? []) {
			const pose = frame.getPose(mesh.meshSpace, space);
			if (!pose) continue;
			meshes.push({ label: mesh.semanticLabel, vertices: mesh.vertices, matrix: Array.from(pose.transform.matrix) });
		}
	} catch {
		/* a frame read outside its callback throws InvalidStateError: what was read so far stands */
	}
	return { planes, meshes };
}
