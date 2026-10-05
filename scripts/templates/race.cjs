// Template def `race` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');
const { N: NATURE, TK, piece, TRUNKS, COLLIDERS } = require('./_level-kit.cjs');

// ---- 36-backlog-21c (plan 21-C8): RACE ------------------------------------------------------
// A circuit in a valley: a closed spline road on flat ground, a ring of procedural mountains
// (ONE parametric Terrain, falloff 'bowl', sunk so its middle hides under the ground), four cars
// on the grid, a start gantry. THE SPLIT (the Mini Golf shape): this def is the CIRCUIT (every
// object the core `race` module finds by name) and the MAIN graph — the buttons on Kit: Round,
// the `racerules` node (laps, speed, grip), the HUD words through `raceinfo`, the Leaderboard
// over the per-player lap rows, the finish line's On Enter. The rules engine — seats, the arcade
// car, the lap judge — lives in src/modules/race.
//
// The road is the DATA: move a point of `Race road` and the grid, the lap judge and the reset
// all follow, because they are derived from its spline record on every peer.

/** the circuit, clockwise seen from above; P0 is the start/finish line (driving toward -X) */
const ROAD = [
	[0, 32],
	[-28, 33],
	[-48, 24],
	[-56, 4],
	[-48, -18],
	[-26, -25],
	[-12, -12],
	[4, -10],
	[18, -24],
	[40, -30],
	[56, -14],
	[57, 10],
	[42, 27],
	[20, 32]
];
const ROAD_W = 4.2; // tube radius = half the road width
const ASPHALT = 0x2e3238;

/** a car: one dynamic box (the collider is the box of its parts), the parts riding it
 * @param {number} n 1..4 @param {number} color @param {number[]} pos @param {number} yaw */
function car(n, color, pos, yaw) {
	const wheel = (x, z) => ({ type: 'cylinder', name: 'Race car ' + n + ' wheel ' + (x > 0 ? 'R' : 'L') + (z > 0 ? 'B' : 'F'), r: 0.36, h: 0.32, pos: [x, -0.19, z], rot: [0, 0, Math.PI / 2], color: 0x1b1d21, roughness: 0.8 });
	return {
		type: 'box',
		name: 'Race car ' + n,
		size: [1.7, 0.42, 3.1],
		bevel: 0.12,
		pos,
		rot: [0, yaw, 0],
		color,
		physical: true,
		roughness: 0.35,
		metalness: 0.2,
		clearcoat: 0.8,
		physics: { mode: 'dynamic', mass: 20, friction: 0.3, restitution: 0.05, freeze: { rx: true, rz: true } },
		children: [
			{ type: 'box', name: 'Race car ' + n + ' cabin', size: [1.24, 0.42, 1.3], bevel: 0.1, pos: [0, 0.38, 0.25], color: 0x14181f, physical: true, roughness: 0.15, metalness: 0.4, clearcoat: 1 },
			{ type: 'box', name: 'Race car ' + n + ' wing', size: [1.6, 0.06, 0.36], pos: [0, 0.42, 1.38], color },
			{ type: 'box', name: 'Race car ' + n + ' stripe', size: [0.32, 0.43, 3.12], pos: [0, 0.004, 0], color: 0xf3f4f6, roughness: 0.4 },
			{ type: 'box', name: 'Race car ' + n + ' lights', size: [1.3, 0.1, 0.04], pos: [0, 0.02, -1.56], color: 0xfff6c8, emissive: 0xfff6c8, emissiveIntensity: 1.6, shadow: false },
			wheel(0.82, -1.02),
			wheel(-0.82, -1.02),
			wheel(0.82, 1.02),
			wheel(-0.82, 1.02)
		]
	};
}
/** the grid: two abreast behind the line, 7 m between rows (the module re-places them on Start) */
const GRID = [
	{ n: 1, color: 0xe63946, pos: [7, 0.62, 29.8] },
	{ n: 2, color: 0x2f80ed, pos: [7, 0.62, 34.2] },
	{ n: 3, color: 0xf2c94c, pos: [14, 0.62, 29.8] },
	{ n: 4, color: 0x27ae60, pos: [14, 0.62, 34.2] }
];
// heading -X: forward is the car's -Z, so yaw = atan2(-tx, -tz) = atan2(1, 0) = +pi/2
const GRID_YAW = Math.PI / 2;

/** hay bales along the outside of the corners (they are static: a car bumps off them) */
const BALES = [
	[-60, 30], [-64, 16], [-66, 2], [-62, -16], [-52, -28], [-30, -34],
	[48, -38], [62, -24], [66, -6], [66, 12], [56, 32], [34, 40], [-38, 40], [-12, -2], [10, -2]
];
const bale = /** @type {(p: number[], i: number) => any} */ ((p, i) => piece(TK, 'HayBale', 'Hay bale ' + (i + 1), [p[0], 0, p[1]], (i * 0.7) % 3, { physics: { mode: 'static' } }));
/** trees inside the ring of mountains, kept off the road */
const TREES = [
	[-75, 44, 'Pine'], [-80, 10, 'Pine'], [-78, -30, 'Oak'], [-50, -52, 'Pine'], [-10, -48, 'Oak'],
	[30, -54, 'Pine'], [70, -44, 'Pine'], [82, -6, 'Oak'], [80, 30, 'Pine'], [52, 56, 'Oak'],
	[10, 58, 'Pine'], [-30, 58, 'Pine'], [-22, 6, 'Oak'], [24, 6, 'Pine'], [0, -30, 'Pine']
];
const tree = /** @type {(t: any[], i: number) => any} */ ((t, i) => piece(NATURE, t[2], t[2] + ' ' + (i + 1), [t[0], 0, t[1]], i * 1.3, { physics: TRUNKS[t[2]] }));
const ROCKS = [[-88, -50], [92, 40], [-20, 76], [60, -70], [-96, 20]];
const rock = /** @type {(p: number[], i: number) => any} */ ((p, i) => piece(NATURE, 'RockLarge', 'Rock ' + (i + 1), [p[0], 0, p[1]], i * 2.1, { scale: 3, physics: COLLIDERS.sensor }));

const PANEL = { bg: 'rgba(14, 18, 28, 0.9)', radius: 18, border: '1px solid rgba(255, 212, 94, 0.3)' };
const BTN = { size: 17, weight: '600', bg: '#e63946', color: '#ffffff', radius: 10 };
const T = (size, color, weight = '600', align = 'center') => ({ size, color, weight, align });

/** THE MAIN GRAPH: every rule the player can change is a node here */
function raceGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	// ---- the rules: laps, countdown, the car's feel ------------------------------------------
	N('rules', 'racerules', 'Race rules', 40, 40, { laps: 3, countdown: 3, maxSpeed: 18, accel: 9, brake: 22, turnRate: 1.9, grip: 0.85 });
	// ---- the buttons: the kit round runs the race (intro = the 3-2-1, then the clock) ------------
	N('click', 'gamesound', 'Button click', 520, 220, { sound: 'click' });
	N('bstart', 'hudbutton', 'Start button', 40, 220, { element: 'start-btn' });
	N('start', 'kit-round-restart', 'Start the race', 280, 220, {});
	E('bstart', 'start', 'trigger');
	E('bstart', 'click', 'trigger');
	N('bagain', 'hudbutton', 'Race again button', 40, 300, { element: 'again-btn' });
	N('again', 'kit-round-restart', 'Race again', 280, 300, {});
	E('bagain', 'again', 'trigger');
	E('bagain', 'click', 'trigger');
	N('bmenu', 'hudbutton', 'Menu button', 40, 380, { element: 'menu-btn' });
	N('tomenu', 'kit-round-toMenu', 'Back to menu', 280, 380, {});
	E('bmenu', 'tomenu', 'trigger');
	E('bmenu', 'click', 'trigger');
	// ---- the moments the kit pulses ----------------------------------------------------------
	N('go', 'kit-round-go', 'On go', 40, 480, {});
	N('gosound', 'gamesound', 'Go! horn', 280, 480, { sound: 'whistle' });
	E('go', 'gosound', 'trigger');
	N('won', 'kit-round-won', 'On race won', 40, 560, {});
	N('cheer', 'gamesound', 'Crowd cheer', 280, 560, { sound: 'cheer' });
	E('won', 'cheer', 'trigger');
	// the finish line is a real sensor: crossing it is a wireable event (the lap COUNT is the
	// module's arc-length judge, which a gate alone cannot be — see track.js)
	N('line', 'onenter', 'Car crosses the line', 40, 640, {});
	N('linesel', 'objectselector', 'Finish line', 40, 720, { selected: 'Finish line' });
	E('line', 'linesel');
	N('linesound', 'gamesound', 'Line beep', 280, 640, { sound: 'ring' });
	E('line', 'linesound', 'trigger');
	// ---- the player on foot (walk to a car), the music ----------------------------------------
	N('body', 'charcontroller', 'Player: walk', 520, 40, { mode: 'walk', speed: 0.08, jumpHeight: 0, eyeHeight: 1.7, gravity: true });
	N('music', 'gamemusic', 'Race music', 520, 120, { preset: 'arcade', volume: 0.3, while: 'round' });
	// ---- the HUD words ----------------------------------------------------------------------------
	const text = (id, read, element, x, y) => {
		N(id + 'i', 'raceinfo', 'Race: ' + read, x, y, { read });
		N(id + 't', 'hudtext', 'HUD ' + element, x + 240, y, { element, format: '', decimals: 0, value: 0 });
		E(id + 'i', id + 't', 'format');
	};
	text('lap', 'lap', 'rc-lap', 800, 40);
	text('clock', 'clock', 'rc-clock', 800, 110);
	text('lapc', 'lapClock', 'rc-lapclock', 800, 180);
	text('pos', 'position', 'rc-pos', 800, 250);
	text('best', 'best', 'rc-best', 800, 320);
	text('count', 'countdown', 'rc-count', 800, 390);
	text('status', 'status', 'rc-status', 800, 460);
	text('stand', 'standings', 'rc-standings', 800, 530);
	text('res', 'result', 'rc-result', 800, 600);
	text('mbest', 'menuBest', 'rc-menu-best', 800, 670);
	// the board on the results screen: everyone's laps, derived from their own rows on every peer
	N('board', 'leaderboard', 'Laps board', 800, 760, { element: 'rc-board', variable: 'rcLaps', order: 'desc', format: '{rank}. {name} — {v} laps', decimals: 0, limit: 8 });
	return g.done();
}

const RACE_DEF = {
	kind: 'game',
	slug: 'race',
	title: 'Race',
	description:
		'Four cars, a circuit in a valley of mountains, three laps. Click a car, press Start, and race your friends: a lap counts only when you have driven all of it. Edit the road and the race follows; change laps, speed and grip on the Race rules node.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['racing', 'driving', 'multiplayer', 'physics'],
	modules: [],
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#4f8fd8', bottom: '#dcebf5' },
		fog: { color: '#dcebf5', near: 90, far: 260 },
		ground: { color: '#6f9a4e', roughness: 0.95 }
	},
	physics: {
		ground: { enabled: true, height: 0, friction: 0.5, restitution: 0 },
		bounds: { limit: -20, action: 'respawn' },
		material: { friction: 0.5, restitution: 0.05 },
		damping: { linear: 0.05, angular: 0.5 },
		ccd: true,
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [11, 0, 40], yaw: 0 }, locomotion: { teleport: true } }
	},
	// 21-C9's Race look, trimmed to what reads on a desktop (post is off in VR): an ACES film
	// curve, a touch of contrast, low bloom for the tail-lights, a vignette, SMAA
	post: {
		enabled: true,
		effects: [
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'ACES_FILMIC' } },
			{ id: 'bc', kind: 'brightnesscontrast', enabled: true, params: { brightness: 0.02, contrast: 0.08 } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.45, luminanceThreshold: 0.9 } },
			{ id: 'vig', kind: 'vignette', enabled: true, params: { offset: 0.42, darkness: 0.45 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [38, 46, 92], target: [0, 0, 4] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: raceGraph() },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'menu',
					name: 'Start',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 560, h: 380, z: 0, label: '', style: PANEL },
						{ id: 'rc-name', kind: 'text', anchor: 'center', x: 0, y: -130, w: 500, h: 50, z: 1, label: 'RACE', style: T(44, '#ffd45e', '800') },
						{ id: 'rc-sub', kind: 'text', anchor: 'center', x: 0, y: -76, w: 500, h: 44, z: 1, label: 'Click a car to take the wheel, then Start. First across the line after every lap wins.', style: T(14, '#d8dee9', '400'), wrap: true },
						{ id: 'rc-menu-best', kind: 'text', anchor: 'center', x: 0, y: -30, w: 460, h: 22, z: 1, label: '', style: T(14, '#9ee6b0') },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: 30, w: 260, h: 52, z: 1, label: 'Start', enabled: true, style: { ...BTN, size: 20 } },
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 100, w: 520, h: 34, z: 1, label: 'W / S drive · A / D steer · R back on the road', style: T(12, '#a9b0c0', '400'), wrap: true },
						{ id: 'rc-status', kind: 'text', anchor: 'center', x: 0, y: 140, w: 520, h: 22, z: 1, label: '', style: T(13, '#ffd45e') }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'rc-lap', kind: 'text', anchor: 'top-center', x: 0, y: 12, w: 300, h: 30, z: 1, label: '', style: T(22, '#ffd45e', '800') },
						{ id: 'rc-clock', kind: 'text', anchor: 'top-center', x: -90, y: 46, w: 160, h: 24, z: 1, label: '', style: T(16, '#ffffff') },
						{ id: 'rc-lapclock', kind: 'text', anchor: 'top-center', x: 90, y: 46, w: 160, h: 24, z: 1, label: '', style: T(16, '#9ee6ff') },
						{ id: 'rc-pos', kind: 'text', anchor: 'top-left', x: 90, y: 16, w: 200, h: 34, z: 1, label: '', style: T(26, '#ffffff', '800', 'left') },
						{ id: 'rc-best', kind: 'text', anchor: 'top-right', x: 20, y: 16, w: 220, h: 24, z: 1, label: '', style: T(14, '#9ee6b0', '600', 'right') },
						{ id: 'rc-count', kind: 'text', anchor: 'center', x: 0, y: -60, w: 300, h: 110, z: 2, label: '', style: T(96, '#ffd45e', '900') },
						{ id: 'rc-standings', kind: 'text', anchor: 'bottom-center', x: 0, y: 14, w: 760, h: 22, z: 1, label: '', style: T(13, '#e5e9f0', '500') }
					]
				},
				{
					id: 'over',
					name: 'Results',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 520, h: 400, z: 0, label: '', style: PANEL },
						{ id: 'rc-result', kind: 'text', anchor: 'center', x: 0, y: -150, w: 480, h: 40, z: 1, label: 'Race over', style: T(26, '#ffd45e', '800') },
						{ id: 'rc-board', kind: 'list', anchor: 'center', x: 0, y: -10, w: 420, h: 200, z: 1, label: '', style: T(16, '#ffffff', '500', 'left') },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: -80, y: 150, w: 170, h: 46, z: 1, label: 'Race again', enabled: true, style: BTN },
						{ id: 'menu-btn', kind: 'button', anchor: 'center', x: 100, y: 150, w: 120, h: 46, z: 1, label: 'Menu', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the marker that wakes the core `race` module (an empty: no body, no draw)
		{ type: 'empty', name: 'Race game' },
		{ type: 'light', name: 'Sun', kind: 'directional', color: 0xfff1d6, intensity: 2.3, pos: [-60, 70, 50], target: [0, 0, 0], shadowMapSize: 2048 },
		{ type: 'light', name: 'Sky fill', kind: 'hemisphere', color: 0xcfe6ff, groundColor: 0x55703f, intensity: 0.6 },
		// the drive surface: one static slab (the physics ground backs it up)
		{ type: 'box', name: 'Track ground', size: [150, 0.2, 110], pos: [0, -0.1, 2], color: 0x6f9a4e, roughness: 0.95, physics: { mode: 'static', friction: 0.5 } },
		// the mountains: ONE parametric terrain, its middle sunk under the ground, its rim a ring of
		// peaks (C1's 'bowl' falloff); a trimesh, so a car that leaves the circuit drives up a slope
		{
			type: 'terrain',
			name: 'Mountains',
			terrain: { size: 420, segments: 32, seed: 21, amplitude: 64, frequency: 0.011, octaves: 4, ridged: true, warp: 0.3, falloff: 'bowl', offsetX: 0, offsetZ: 0 },
			pos: [0, -14, 0],
			color: 0x7d8a5a,
			roughness: 1,
			flatShading: true,
			physics: { mode: 'static', collider: 'trimesh' }
		},
		// the road: a closed spline flattened into a ribbon (scale y) — its record IS the race:
		// the grid, the lap judge and the reset are derived from it on every peer
		{ type: 'spline', name: 'Race road', closed: true, color: ASPHALT, points: ROAD.map(([x, z]) => ({ pos: [x, 0, z], radius: ROAD_W })), scale: [1, 0.012, 1], shadow: false },
		// the start/finish line (a sensor: On Enter in the graph) and the gantry over it
		{ type: 'box', name: 'Finish line', size: [0.9, 0.06, 8.6], pos: [0, 0.06, 32], color: 0xf5f5f5, roughness: 0.6, shadow: false, physics: { mode: 'static', sensor: true } },
		{ type: 'cylinder', name: 'Gantry post L', r: 0.25, h: 6, pos: [0, 3, 26.8], color: 0xd0d4da, metalness: 0.6, roughness: 0.3, physics: { mode: 'static', collider: 'cylinder' } },
		{ type: 'cylinder', name: 'Gantry post R', r: 0.25, h: 6, pos: [0, 3, 37.2], color: 0xd0d4da, metalness: 0.6, roughness: 0.3, physics: { mode: 'static', collider: 'cylinder' } },
		{ type: 'box', name: 'Gantry', size: [0.6, 1.1, 10.9], pos: [0, 6.2, 32], color: 0xe63946, emissive: 0xe63946, emissiveIntensity: 0.25, physics: { mode: 'static', sensor: true } },
		...GRID.map((c) => car(c.n, c.color, c.pos, GRID_YAW)),
		...BALES.map(bale),
		...TREES.map(tree),
		...ROCKS.map(rock),
		{ type: 'camera', name: 'Card camera', pos: [-16, 9, 46], lookAt: [12, 0.5, 31], fov: 52 }
	]
};

module.exports = RACE_DEF;
