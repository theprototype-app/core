// 33-scenes — named viewpoints per General-tab level, shared by scripts/perf-levels.cjs (the
// draw-call probe) and the level suites: [label, feet [x, y, z], yaw]. yaw 0 looks -Z,
// +PI/2 looks -X, PI looks +Z, -PI/2 looks +X (the spawn convention). Each level lists its
// spawn first and then the views a player would stand in that see the MOST of it (the worst
// case for draw calls), so a budget claim is about the heaviest frame and not an easy one.
const PI = Math.PI;
module.exports = {
	'castle-courtyard': [
		['spawn', [1, 0.3, 4.6], 0],
		['rampart looking south', [0, 3, -12.8], PI],
		['the well looking north', [0, 0, -2], 0]
	],
	'tavern-interior': [
		['spawn', [-1.4, 0.3, 3.3], -0.2],
		['back corner over the hall', [1.2, 0.1, -3.2], 2.6],
		['balcony over the hall', [-2, 3.1, -4.6], PI * 0.8],
		['kitchen', [3.2, 0.1, 2.5], 0.3]
	]
};
