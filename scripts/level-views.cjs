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
		['spawn (the road)', [-3, 0.2, 10.4], 0],
		['the front door', [-3, 0.35, 6.4], 0],
		['across the street', [6, 0.35, 13.5], 2.2],
		['inside the door', [-1.4, 0.1, 3.3], -0.2],
		['back corner over the hall', [1.2, 0.1, -3.2], 2.6],
		['balcony over the hall', [-2, 3.1, -4.6], PI * 0.8],
		['kitchen', [3.2, 0.1, 2.5], 0.3]
	],
	'wizards-tower': [
		['spawn (the path)', [1, 0.3, 13], 0],
		['the lab from the door', [1, 0.1, 3.2], 0.35],
		['the study', [-1, 3.1, 3.2], -0.4],
		['the bedchamber', [1, 6.1, 2.9], 0.45],
		['the roof terrace', [-2.5, 9.1, 3.2], -0.9]
	],
	'market-square': [
		['spawn (the square)', [0, 0.35, 6.3], 0],
		['the market from the west', [-5, 0.35, 2], -1.7],
		['the square from the bakery', [-4.5, 0.1, -9.2], PI],
		['inside the bakery', [-2.7, 0.1, -8.8], 0.6],
		['the road', [-8, 0.2, 11], -1.9]
	],
	// 33-integrate: the two rows with no views yet (spawn first, then the heaviest look)
	'forest-clearing': [
		['spawn', [0, 0.35, 5], 0],
		['the clearing looking back south', [0, 0.35, -4], PI]
	],
	'architecture-shell': [
		['spawn (outside the door)', [1, 0.3, 8.6], 0],
		['inside, the whole room', [4.6, 0.1, 3.2], 0.9]
	]
};
