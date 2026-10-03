// Template def `mini-golf` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');

// ---- 35-mini-golf: MINI GOLF ------------------------------------------------------------
// Six holes side by side, each a lane from its tee (+z) to its cup (-z): a straight warm-up,
// a ramp to a high green, a windmill whose blades sweep the gap, a bank shot round a wall, a
// sand trap and a hump with posts. THE SPLIT (the Towers shape): this def is the COURSE (every
// object the core `minigolf` module finds by name), the HUD and a small graph (buttons, click
// sounds, the windmill's Spin, music, the walking body, the HUD words through the module's
// `golfinfo` value node). The rules — strokes, the cup, out of bounds, sand, the putt itself —
// live in src/modules/minigolf (holes.js is the table; its numbers are mirrored below).

/** lane x centres (holes.js LANE_X) */
const LANE_X = [-12.5, -7.5, -2.5, 2.5, 7.5, 12.5];
const GREEN = { color: 0x3f9b4a, roughness: 0.92 };
const RAIL = { color: 0xe9e2d0, physical: true, roughness: 0.45, clearcoat: 0.3 };
const railPhysics = { mode: 'static', friction: 0.2, restitution: 0.65 };
const greenPhysics = { mode: 'static', friction: 0.6, restitution: 0.05 };
const deco = { mode: 'static', sensor: true };
/** the cups (holes.js HOLES[*].cup) */
const CUPS = [
	[LANE_X[0], 0.1, -4.5],
	[LANE_X[1], 0.6, -5],
	[LANE_X[2], 0.1, -5],
	[LANE_X[3] + 0.8, 0.1, -5],
	[LANE_X[4], 0.1, -5],
	[LANE_X[5], 0.1, -5.2]
];
const NAMES = ['Straight', 'The ramp', 'Windmill', 'Bank shot', 'Sand trap', 'The hump'];
const PARS = [2, 3, 3, 3, 3, 4];
/** rail height per hole (the ramp and the hump need taller sides) */
const RAIL_H = [0.3, 0.9, 0.3, 0.3, 0.3, 0.5];

/** one lane: green, rails, tee, cup, flag, putter @param {number} i 0..5 */
function lane(i) {
	const x = LANE_X[i];
	const n = i + 1;
	const h = RAIL_H[i];
	const cup = CUPS[i];
	const flagColor = [0xff5a4f, 0xffc640, 0x4fb3ff, 0xc77dff, 0xff9f43, 0x2ee6a8][i];
	return [
		{ type: 'box', name: 'Green ' + n, size: [3, 0.1, 12], pos: [x, 0.05, -0.5], ...GREEN, physics: greenPhysics },
		{ type: 'box', name: 'Rail west ' + n, size: [0.2, h, 12.4], pos: [x - 1.6, h / 2, -0.5], ...RAIL, physics: railPhysics },
		{ type: 'box', name: 'Rail east ' + n, size: [0.2, h, 12.4], pos: [x + 1.6, h / 2, -0.5], ...RAIL, physics: railPhysics },
		{ type: 'box', name: 'Rail back ' + n, size: [3.4, h, 0.2], pos: [x, h / 2, -6.6], ...RAIL, physics: railPhysics },
		{ type: 'box', name: 'Rail front ' + n, size: [3.4, 0.3, 0.2], pos: [x, 0.15, 5.6], ...RAIL, physics: railPhysics },
		{ type: 'box', name: 'Tee ' + n, size: [0.7, 0.012, 0.7], pos: [x, 0.106, 4.4], color: 0x2c6e34, roughness: 0.95, shadow: false, physics: deco },
		{ type: 'cylinder', name: 'Cup ' + n, r: 0.12, h: 0.012, pos: [cup[0], cup[1] + 0.006, cup[2]], color: 0x101410, roughness: 1, shadow: false, physics: deco },
		{ type: 'cylinder', name: 'Flagpole ' + n, r: 0.012, h: 1.1, pos: [cup[0], cup[1] + 0.55, cup[2]], color: 0xf2f2f2, metalness: 0.5, roughness: 0.3, physics: deco },
		{ type: 'box', name: 'Flag ' + n, size: [0.34, 0.22, 0.01], pos: [cup[0] + 0.18, cup[1] + 0.98, cup[2]], color: flagColor, emissive: flagColor, emissiveIntensity: 0.35, side: 'double', shadow: false, physics: deco },
		{ type: 'box', name: 'Number ' + n, size: [0.5, 0.5, 0.06], pos: [x - 1.05, 0.6, 5.65], color: flagColor, emissive: flagColor, emissiveIntensity: 0.5, physics: deco },
		// the putter (VR): a shaft lying beside the tee; grip it and swing the low end through the ball
		{ type: 'box', name: 'Putter ' + n, size: [0.045, 0.95, 0.045], pos: [x + 1.2, 0.13, 3.6], rot: [Math.PI / 2, 0, 0], color: 0x9aa4b2, physical: true, metalness: 0.8, roughness: 0.3, physics: { mode: 'dynamic', mass: 0.4, friction: 0.8, restitution: 0.1 } }
	];
}

/** the per-hole obstacles */
const OBSTACLES = [
	// 2 — a ramp up to the high green
	{ type: 'box', name: 'High green', size: [3, 0.6, 3], pos: [LANE_X[1], 0.3, -5], ...GREEN, physics: greenPhysics },
	{ type: 'box', name: 'Ramp', size: [3, 0.1, 3.06], pos: [LANE_X[1], 0.3, -2], rot: [0.165, 0, 0], color: 0x358a40, roughness: 0.9, physics: greenPhysics },
	// 3 — the windmill: a house with a gap, blades sweeping through it (the graph's Spin)
	{ type: 'box', name: 'Windmill west', size: [1.1, 0.6, 0.6], pos: [LANE_X[2] - 0.95, 0.4, -1.2], color: 0xc65b3c, roughness: 0.7, physics: railPhysics },
	{ type: 'box', name: 'Windmill east', size: [1.1, 0.6, 0.6], pos: [LANE_X[2] + 0.95, 0.4, -1.2], color: 0xc65b3c, roughness: 0.7, physics: railPhysics },
	{ type: 'box', name: 'Windmill house', size: [3, 1.2, 0.6], pos: [LANE_X[2], 1.3, -1.2], color: 0xe3d3b0, roughness: 0.8, physics: deco },
	{ type: 'cone', name: 'Windmill roof', r: 1.2, h: 0.9, pos: [LANE_X[2], 2.35, -1.2], color: 0x7a3b2a, roughness: 0.7, physics: deco },
	{ type: 'box', name: 'Windmill blade A', size: [2.6, 0.16, 0.05], pos: [LANE_X[2], 1.2, -0.84], color: 0xf4efe2, roughness: 0.6, physics: { mode: 'static' } },
	{ type: 'box', name: 'Windmill blade B', size: [0.16, 2.6, 0.05], pos: [LANE_X[2], 1.2, -0.84], color: 0xf4efe2, roughness: 0.6, physics: { mode: 'static' } },
	// 4 — the wall that makes it a bank shot
	{ type: 'box', name: 'Bank wall', size: [2.2, 0.3, 0.2], pos: [LANE_X[3] - 0.4, 0.25, -1], ...RAIL, physics: railPhysics },
	{ type: 'block', shape: 'Wedge', args: [0.6, 0.3, 0.8], name: 'Bank bumper', pos: [LANE_X[3] + 1.2, 0.1, 1.2], rot: [0, -Math.PI / 2, 0], color: 0xd2a86e, roughness: 0.6, physics: { mode: 'static', collider: 'hull', restitution: 0.6 } },
	// 5 — the sand trap (holes.js sand)
	{ type: 'box', name: 'Sand trap', size: [2.1, 0.014, 1.4], pos: [LANE_X[4] - 0.45, 0.107, -1.9], color: 0xe2c98e, roughness: 1, shadow: false, physics: deco },
	{ type: 'box', name: 'Sand trap 2', size: [1.2, 0.014, 0.9], pos: [LANE_X[4] + 0.6, 0.107, -3.9], color: 0xe2c98e, roughness: 1, shadow: false, physics: deco },
	// 6 — a hump and three posts round the cup
	{ type: 'box', name: 'Hump up', size: [3, 0.1, 1.52], pos: [LANE_X[5], 0.175, 0.25], rot: [0.165, 0, 0], color: 0x358a40, roughness: 0.9, physics: greenPhysics },
	{ type: 'box', name: 'Hump down', size: [3, 0.1, 1.52], pos: [LANE_X[5], 0.175, -1.25], rot: [-0.165, 0, 0], color: 0x358a40, roughness: 0.9, physics: greenPhysics },
	{ type: 'cylinder', name: 'Post 1', r: 0.13, h: 0.4, pos: [LANE_X[5] - 0.6, 0.3, -3.6], ...RAIL, physics: { ...railPhysics, collider: 'cylinder' } },
	{ type: 'cylinder', name: 'Post 2', r: 0.13, h: 0.4, pos: [LANE_X[5] + 0.6, 0.3, -3.6], ...RAIL, physics: { ...railPhysics, collider: 'cylinder' } },
	{ type: 'cylinder', name: 'Post 3', r: 0.13, h: 0.4, pos: [LANE_X[5], 0.3, -4.3], ...RAIL, physics: { ...railPhysics, collider: 'cylinder' } }
];

const PANEL = { bg: 'rgba(16, 38, 24, 0.9)', radius: 18, border: '1px solid rgba(255, 224, 102, 0.3)' };
const BTN = { size: 17, weight: '600', bg: '#2f9e55', color: '#ffffff', radius: 10 };

function golfGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	N('click', 'gamesound', 'Button click', 520, 40, { sound: 'click' });
	const button = (id, element, label, x, y) => {
		N(id, 'hudbutton', label, x, y, { element });
		E(id, 'click', 'trigger');
	};
	button('bstart', 'start-btn', 'Start button', 40, 40);
	button('bagain', 'again-btn', 'Play again button', 40, 110);
	button('bmenu', 'menu-btn', 'Menu button', 40, 180);
	const text = (id, read, element, x, y, extra = {}) => {
		N(id + 'i', 'golfinfo', 'Golf: ' + read, x, y, { read, ...extra });
		N(id + 't', 'hudtext', 'HUD ' + element, x + 240, y, { element, format: '', decimals: 0, value: 0 });
		E(id + 'i', id + 't', 'format');
	};
	text('mbest', 'menuBest', 'mg-menu-best', 800, 40);
	text('title', 'title', 'mg-title', 800, 110);
	text('par', 'par', 'mg-par', 800, 180);
	text('strokes', 'strokes', 'mg-strokes', 800, 250);
	text('total', 'total', 'mg-total', 800, 320);
	text('tip', 'tip', 'mg-tip', 800, 390);
	text('rline', 'resultLine', 'mg-result-line', 800, 480);
	text('rbest', 'best', 'mg-best', 800, 550);
	for (let i = 1; i <= 6; i++) text('card' + i, 'card', 'mg-card-' + i, 1300, 40 + (i - 1) * 70, { hole: i });
	// the windmill: two blades turning about the hub (a Spin makes each a kinematic body)
	N('spinA', 'spin', 'Windmill spin A', 40, 300, { axis: 'z', speed: 0.9 });
	N('selA', 'objectselector', 'Blade A', 280, 300, { selected: 'Windmill blade A' });
	E('spinA', 'selA');
	N('spinB', 'spin', 'Windmill spin B', 40, 380, { axis: 'z', speed: 0.9 });
	N('selB', 'objectselector', 'Blade B', 280, 380, { selected: 'Windmill blade B' });
	E('spinB', 'selB');
	N('music', 'gamemusic', 'Puzzle music', 40, 480, { preset: 'puzzle', volume: 0.35, while: 'always' });
	N('body', 'charcontroller', 'Player: walk', 280, 480, { mode: 'walk', speed: 0.06, jumpHeight: 0, eyeHeight: 1.6, gravity: true });
	return g.done();
}

/** a scorecard row on the results screen @param {number} i 1..6 */
const cardRow = (i) => ({ id: 'mg-card-' + i, kind: 'text', anchor: 'center', x: 0, y: -60 + (i - 1) * 26, w: 420, h: 22, z: 1, label: '', style: { size: 15, weight: '500', color: '#e5e9f0', align: 'left' } });

const MINI_GOLF_DEF = {
	kind: 'game',
	slug: 'mini-golf',
	title: 'Mini Golf',
	description:
		'Six holes of mini golf: a ramp, a windmill, a bank shot, a sand trap and a hump. Drag back from the ball and let go to putt, or swing a putter in VR. Par for each hole, a scorecard at the end, your best round saved on this device.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['sports', 'golf', 'physics', 'casual', 'vr'],
	modules: [],
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#5b9be0', bottom: '#e3f0f7' },
		fog: { color: '#e3f0f7', near: 22, far: 80 },
		ground: { color: '#6f8f55', roughness: 0.95 }
	},
	physics: {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0 },
		bounds: { limit: -20, action: 'respawn' },
		material: { friction: 0.6, restitution: 0.2 },
		damping: { linear: 0.3, angular: 0.8 },
		ccd: true,
		knock: { enabled: true, gain: 1, maxSpeed: 6, minSpeed: 0.3, radius: 0.12, spin: 0.3, predict: true },
		play: { interaction: 'grab', grounded: false, simOnPlay: true, cursor: 'free', spawn: { position: [LANE_X[0], 0, 6.4], yaw: 0 }, locomotion: { teleport: true } }
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.5, luminanceThreshold: 0.85 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [-6, 9, 14], target: [-4, 0, -1] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: golfGraph() },
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
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 560, h: 400, z: 0, label: '', style: PANEL },
						{ id: 'mg-name', kind: 'text', anchor: 'center', x: 0, y: -140, w: 500, h: 50, z: 1, label: 'MINI GOLF', style: { size: 42, weight: '700', color: '#ffe066', align: 'center' } },
						{ id: 'mg-sub', kind: 'text', anchor: 'center', x: 0, y: -84, w: 500, h: 44, z: 1, label: 'Six holes: a ramp, a windmill, a bank shot, sand and a hump. Sink each ball in as few strokes as you can.', style: { size: 14, color: '#d8dee9', align: 'center' }, wrap: true },
						{ id: 'mg-menu-best', kind: 'text', anchor: 'center', x: 0, y: -36, w: 460, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#9ee6b0', align: 'center' } },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: 26, w: 260, h: 52, z: 1, label: 'Tee off', enabled: true, style: { ...BTN, size: 20 } },
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 104, w: 520, h: 34, z: 1, label: 'Desktop: press on the ball, drag BACK and let go · WASD walks', style: { size: 12, color: '#a9b8a9', align: 'center' }, wrap: true },
						{ id: 'menu-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 140, w: 520, h: 34, z: 1, label: 'VR: grip the putter beside the tee and swing it through the ball', style: { size: 12, color: '#a9b8a9', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'mg-title', kind: 'text', anchor: 'top-center', x: 0, y: 12, w: 420, h: 28, z: 1, label: '', style: { size: 20, weight: '700', color: '#ffe066', align: 'center' } },
						{ id: 'mg-par', kind: 'text', anchor: 'top-center', x: -90, y: 44, w: 160, h: 24, z: 1, label: '', style: { size: 16, weight: '600', color: '#ffffff', align: 'center' } },
						{ id: 'mg-strokes', kind: 'text', anchor: 'top-center', x: 90, y: 44, w: 160, h: 24, z: 1, label: '', style: { size: 16, weight: '600', color: '#9ee6ff', align: 'center' } },
						{ id: 'mg-total', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 260, h: 24, z: 1, label: '', style: { size: 15, weight: '600', color: '#e5e9f0', align: 'right' } },
						{ id: 'mg-tip', kind: 'text', anchor: 'bottom-center', x: 0, y: 14, w: 640, h: 20, z: 1, label: '', style: { size: 13, color: '#e5e9f0', align: 'center' } }
					]
				},
				{
					id: 'over',
					name: 'Scorecard',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 500, h: 440, z: 0, label: '', style: PANEL },
						{ id: 'mg-result', kind: 'text', anchor: 'center', x: 0, y: -170, w: 460, h: 40, z: 1, label: 'Course complete!', style: { size: 28, weight: '700', color: '#ffe066', align: 'center' } },
						{ id: 'mg-result-line', kind: 'text', anchor: 'center', x: 0, y: -128, w: 460, h: 26, z: 1, label: '', style: { size: 17, weight: '600', color: '#ffffff', align: 'center' } },
						{ id: 'mg-best', kind: 'text', anchor: 'center', x: 0, y: -98, w: 460, h: 20, z: 1, label: '', style: { size: 13, color: '#9ee6b0', align: 'center' } },
						...[1, 2, 3, 4, 5, 6].map(cardRow),
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: -70, y: 170, w: 160, h: 46, z: 1, label: 'Play again', enabled: true, style: BTN },
						{ id: 'menu-btn', kind: 'button', anchor: 'center', x: 100, y: 170, w: 120, h: 46, z: 1, label: 'Menu', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the marker that wakes the core `minigolf` module (an empty: no body, no draw)
		{ type: 'empty', name: 'Mini golf game' },
		{ type: 'light', name: 'Sun', kind: 'directional', color: 0xfff1d6, intensity: 2.2, pos: [-20, 18, 12], target: [0, 0, -1] },
		{ type: 'light', name: 'Sky fill', kind: 'hemisphere', color: 0xcfe6ff, groundColor: 0x55703f, intensity: 0.6 },
		...[0, 1, 2, 3, 4, 5].flatMap(lane),
		...OBSTACLES,
		// the ball (holes.js BALL_R), on hole 1's tee
		{ type: 'sphere', name: 'Golf ball', r: 0.06, pos: [LANE_X[0], 0.19, 4.4], color: 0xffffff, physical: true, roughness: 0.25, clearcoat: 0.8, physics: { mode: 'dynamic', mass: 0.05, collider: 'sphere', friction: 0.5, restitution: 0.35 } },
		{ type: 'camera', name: 'Card camera', pos: [-6.5, 5.2, 7.5], lookAt: [-5.5, 0, -2], fov: 50 }
	]
};

module.exports = MINI_GOLF_DEF;
