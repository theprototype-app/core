// Level def `architecture-shell` — one file per template (34 R4 A3). Built from the kit in ./_level-kit.cjs;
// listed by scripts/level-templates.cjs (LEVEL_DEFS) and authored by scripts/author-templates.cjs.

const { A, N, P, X, PI, H, COLLIDERS, namer, piece, walkGraph, playPhysics, lookPost, DYNAMIC } = require('./_level-kit.cjs');

// ---- 6. Architecture shell ---------------------------------------------------------------
//
// 33-integrate: the General tab's "Architecture shell" card (until 1.18 a grey primitive room)
// rebuilt from the kits, as the user asked ("update architecture shell scene"). Still a SHELL
// to block interiors out in — a 12 × 8 m sandstone room on flagstones with a door that OPENS
// (the Interactive Kit's studded door in its frame), a window with shutters that close and one
// with glass, two round columns, oak ceiling beams and a slate half roof over the back — but a
// walkable one now. The greybox it replaces stays the offline seed (author-templates).
function shellObjects() {
	const n = namer();
	/** @type {any[]} */
	const o = [];
	const XS = [-5, -3, -1, 1, 3, 5];
	const ZS = [-3, -1, 1, 3];
	for (const x of XS) for (const z of ZS) o.push(piece(A, 'FloorStone', n('Floor'), [x, 0, z]));
	// back wall and front wall (the door at x = 1)
	for (const x of XS) {
		o.push(piece(A, 'WallStone', n('Back wall'), [x, 0, -4], PI));
		if (x === 1) {
			o.push(piece(A, 'WallStoneDoor', 'Doorway', [x, 0, 4], 0, { physics: COLLIDERS.doorway }));
			o.push(piece(X, 'DoorStudded', 'Front door', [x, 0, 4]));
		} else o.push(piece(A, 'WallStone', n('Front wall'), [x, 0, 4]));
	}
	// the west wall is plain; the east wall has a shuttered window and a glazed one
	for (const z of ZS) {
		o.push(piece(A, 'WallStone', n('West wall'), [-6, 0, z], -H));
		if (z === -1) {
			o.push(piece(A, 'WallStoneWindow', n('Window wall'), [6, 0, z], H));
			o.push(piece(X, 'Shutters', 'Shutters', [6, 0, z], H));
		} else if (z === 1) {
			o.push(piece(A, 'WallStoneWindow', n('Window wall'), [6, 0, z], H));
			o.push(piece(A, 'Window', n('Window'), [6, 0, z], H));
		} else o.push(piece(A, 'WallStone', n('East wall'), [6, 0, z], H));
	}
	for (const [x, z] of [[-6, -4], [6, -4], [-6, 4], [6, 4]]) o.push(piece(A, 'CornerPostStone', n('Corner'), [x, 0, z]));
	// two round columns on the room's centre line, oak beams across at storey height
	for (const x of [-2, 2]) o.push(piece(A, 'Column', n('Column'), [x, 0.1, 0]));
	for (const x of [-4, -2, 0, 2, 4]) o.push(piece(A, 'Beam', n('Ceiling beam'), [x, 3, 0], H));
	// the half roof: one row of slate slopes over the back, its eave over the back wall
	for (const x of XS) o.push(piece(A, 'RoofSlope', n('Roof slope'), [x, 3, -3], PI));
	// a path to the door, a wall sconce either side of it
	for (const z of [5.4, 7.4]) o.push(piece(N, 'PathTile', n('Path'), [1, 0, z]));
	for (const x of [-0.2, 2.2]) o.push(piece(P, 'WallTorch', n('Door torch'), [x, 1.6, 4.125], 0, { physics: COLLIDERS.sensor }));
	// something to push about (the sim needs a dynamic body, or a Play starts no world)
	for (const [x, z, yaw] of [[-4.6, -2.6, 0.3], [-4.6, -1.5, 1.1]]) o.push(piece(P, 'Crate', n('Crate'), [x, 0.1, z], yaw, { physics: DYNAMIC(15) }));
	o.push(piece(P, 'Barrel', n('Barrel'), [4.4, 0.1, -2.7], 0.4, { physics: DYNAMIC(30) }));
	o.push({ type: 'light', name: 'Room light', pos: [0, 2.6, 0], color: 0xffd2a0, intensity: 8, distance: 14, decay: 2 });
	return o;
}

const SHELL_DEF = {
	kind: 'template',
	seed: false,
	slug: 'architecture-shell',
	title: 'Architecture shell',
	description:
		'A room shell built from the kits to block interiors out in: sandstone walls on flagstones, a door that opens, a window with shutters, columns, ceiling beams and a slate half roof. Press Play and walk in.',
	author: 'theprototype',
	license: 'CC0-1.0',
	tags: ['greybox', 'architecture', 'kits', 'walkable', 'doors'],
	objects: shellObjects(),
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#5a8fd0', bottom: '#e3ebef' },
		fog: { color: '#e3ebef', near: 30, far: 90 },
		ground: { color: '#7d7462', roughness: 1 },
		sun: { color: '#fff1d6', intensity: 2.5, dir: [0.55, 0.7, 0.5] },
		hemi: { sky: '#d3e6ff', ground: '#7d7462', intensity: 1.3 }
	},
	// outside, the door ahead
	physics: playPhysics([1, 0.3, 8.6], 0),
	post: lookPost(0.5),
	graphs: { scene: walkGraph() },
	view: { pos: [11, 8, 13], target: [0, 1.2, 0] },
	thumb: {}
};

module.exports = SHELL_DEF;
