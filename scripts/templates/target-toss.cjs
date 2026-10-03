// Template def `target-toss` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');

// ---- 35: TARGET TOSS -----------------------------------------------------------------------
// A fairground booth: grab a ball from the shelf and throw it at tin-can pyramids, swinging
// targets, pop-ups behind a low wall and a moving cart. Five stages of rising difficulty, a
// clock each, combos, 1-3 stars a stage (saved on this device), the next stage unlocked by a
// star. THE SPLIT (the Towers precedent): this def is the BOOTH — every object the stages name
// (the tables, the shelf, the targets, the TEMPLATES parked under the floor), the HUD and a
// small graph (buttons, P pause, click sounds, music, the moving-target effects, the HUD words
// through the core `targettoss` module's `tossinfo` value node). The stages, the dealing, the
// hit judge and the scoring live in src/modules/targettoss. No module download.

const TOSS_PANEL = { bg: 'rgba(30, 14, 18, 0.92)', radius: 18, border: '1px solid rgba(255, 196, 92, 0.35)' };
const TOSS_BTN = { size: 17, weight: '600', bg: '#d8453b', color: '#ffffff', radius: 10 };
const STAGE_NAMES = ['Tin cans', 'Two stacks', 'Swingers', 'Pop-ups', 'The cart'];
const VAULT_TOP = -6.25;
const WOOD = { physical: true, roughness: 0.65, sheen: 0.3, sheenColor: 0xffd7a0, sheenRoughness: 0.6 };
const HALF_PI = Math.PI / 2;

function tossGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	N('click', 'gamesound', 'Button click', 520, 40, { sound: 'click' });
	const button = (id, element, label, x, y) => {
		N(id, 'hudbutton', label, x, y, { element });
		E(id, 'click', 'trigger');
		return id;
	};
	for (let i = 1; i <= 5; i++) button('lvl' + i, 'lvl-' + i, 'Stage ' + i + ' button', 40, 40 + (i - 1) * 70);
	button('bnext', 'next-btn', 'Next stage button', 40, 420);
	button('bretry', 'retry-btn', 'Retry button', 40, 490);
	button('blevels', 'levels-btn', 'Stages button', 40, 560);
	// (no pause menu of our own: the game shell's Esc / VR menu gives Resume / Restart / Stages)
	// ---- the HUD's words, from the module's info node into HUD Text's FORMAT
	const text = (id, read, element, x, y, extra = {}) => {
		N(id + 'i', 'tossinfo', 'Toss: ' + read, x, y, { read, ...extra });
		N(id + 't', 'hudtext', 'HUD ' + element, x + 240, y, { element, format: '', decimals: 0, value: 0 });
		E(id + 'i', id + 't', 'format');
	};
	text('mline', 'menuLine', 'menu-line', 800, 40);
	for (let i = 1; i <= 5; i++) text('ls' + i, 'levelStars', 'lvl-' + i + '-stars', 800, 110 + (i - 1) * 70, { level: i });
	text('title', 'title', 'tt-title', 1300, 40);
	text('targets', 'targets', 'tt-targets', 1300, 110);
	text('score', 'score', 'tt-score', 1300, 180);
	text('combo', 'combo', 'tt-combo', 1300, 250);
	text('clock', 'clock', 'tt-clock', 1300, 320);
	text('result', 'result', 'tt-result', 1300, 410);
	text('rstars', 'resultStars', 'tt-stars', 1300, 480);
	text('rline', 'resultLine', 'tt-line', 1300, 550);
	text('rbest', 'best', 'tt-best', 1300, 620);
	N('progi', 'tossinfo', 'Toss: progress', 1300, 710, { read: 'progress' });
	N('progbar', 'hudbar', 'HUD progress bar', 1540, 710, { element: 'tt-bar', value: 0, min: 0, max: 1, format: '' });
	E('progi', 'progbar', 'value');
	N('chargei', 'tossinfo', 'Toss: charge (desktop)', 1300, 790, { read: 'charge' });
	N('chargebar', 'hudbar', 'HUD charge bar', 1540, 790, { element: 'tt-charge', value: 0, min: 0, max: 1, format: '' });
	E('chargei', 'chargebar', 'value');
	// ---- the world: fairground music, the moving targets (module effects = kinematic bodies)
	N('music', 'gamemusic', 'Arcade music', 40, 980, { preset: 'arcade', volume: 0.35, while: 'always' });
	for (let i = 1; i <= 3; i++) {
		N('sw' + i, 'tossswing', 'Swinging target ' + i, 40, 1060 + (i - 1) * 70, { index: i });
		N('sws' + i, 'objectselector', 'Swing target ' + i, 280, 1060 + (i - 1) * 70, { selected: 'Swing target ' + i });
		E('sw' + i, 'sws' + i);
	}
	for (let i = 1; i <= 6; i++) {
		N('pp' + i, 'tosspopup', 'Pop-up target ' + i, 600, 1060 + (i - 1) * 70, { index: i });
		N('pps' + i, 'objectselector', 'Popup target ' + i, 840, 1060 + (i - 1) * 70, { selected: 'Popup target ' + i });
		E('pp' + i, 'pps' + i);
	}
	N('cart', 'tosscart', 'Moving cart', 1160, 1060, {});
	N('carts', 'objectselector', 'Cart', 1400, 1060, { selected: 'Cart' });
	E('cart', 'carts');
	N('cartt', 'tosscart', 'Moving cart target', 1160, 1130, {});
	N('cartts', 'objectselector', 'Cart target', 1400, 1130, { selected: 'Cart target' });
	E('cartt', 'cartts');
	return g.done();
}

/** a stage-select cell: the button and the stars line under it @param {number} i 1..5 */
const stageCell = (i) => {
	const x = -232 + (i - 1) * 116;
	return [
		{ id: 'lvl-' + i, kind: 'button', anchor: 'center', x, y: 10, w: 108, h: 44, z: 1, label: i + ' · ' + STAGE_NAMES[i - 1], enabled: true, style: { ...TOSS_BTN, size: 13 } },
		{ id: 'lvl-' + i + '-stars', kind: 'text', anchor: 'center', x, y: 44, w: 108, h: 18, z: 1, label: '', style: { size: 13, weight: '600', color: '#ffd45e', align: 'center' } }
	];
};

/** a target face: a flat disc facing the player (+z) */
const disc = (name, r, pos, color, emissive) => ({
	type: 'cylinder', name, r, h: 0.06, pos, rot: [HALF_PI, 0, 0], color, emissive, emissiveIntensity: 0.9,
	physical: true, roughness: 0.35, clearcoat: 0.6, physics: { mode: 'static', collider: 'cylinder', restitution: 0.4 }
});

const TEMPLATES = [
	{ type: 'sphere', name: 'Ball template', color: 0xffd45e, r: 0.1, pos: [-1, VAULT_TOP + 0.1, 0], physical: true, roughness: 0.45, clearcoat: 0.3, physics: { mode: 'dynamic', mass: 0.35, collider: 'sphere', friction: 0.7, restitution: 0.45 } },
	{ type: 'cylinder', name: 'Can template', color: 0xe8483c, r: 0.105, h: 0.28, pos: [1, VAULT_TOP + 0.14, 0], physical: true, metalness: 0.55, roughness: 0.35, clearcoat: 0.5, physics: { mode: 'dynamic', mass: 0.12, collider: 'cylinder', friction: 0.6, restitution: 0.15 } }
];

const STRIPES = Array.from({ length: 8 }, (_, k) => ({
	type: 'box', name: 'Awning stripe ' + (k + 1), color: k % 2 ? 0xfff4e0 : 0xd8453b, size: [0.5, 0.06, 1.3],
	pos: [-1.75 + k * 0.5, 3.05, 1.7], rot: [0.22, 0, 0], roughness: 0.8, shadow: false
}));

const TARGET_TOSS_DEF = {
	kind: 'game',
	slug: 'target-toss',
	title: 'Target Toss',
	description:
		'A fairground booth: throw balls at tin-can pyramids, swinging targets, pop-ups and a moving cart. Five stages against the clock, combos for quick hits, 1-3 stars a stage saved on this device. Grab and throw in VR; hold and release the mouse on a desktop.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['physics', 'throwing', 'arcade', 'vr'],
	modules: [],
	env: {
		preset: 'daylight',
		exposure: 1.2,
		background: { top: '#3a4a9a', bottom: '#ffc38a' },
		fog: { color: '#e8a06c', near: 14, far: 60 },
		ground: { color: '#6b8a4e', roughness: 0.95 }
	},
	physics: {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0.1 },
		bounds: { limit: -20, action: 'respawn' },
		material: { friction: 0.6, restitution: 0.2 },
		damping: { linear: 0.02, angular: 0.2 },
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [0, 0, 3.1], yaw: 0 }, reach: 1.6 }
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.6, luminanceThreshold: 0.8 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [3.5, 3.2, 6.5], target: [0, 1.2, -3] },
	thumb: {
		camera: 'Card camera',
		dress: [
			...[[-1.2, 0.9, -2.8]].flatMap(([cx, top, cz]) => {
				const out = [];
				let k = 0;
				for (let row = 0; row < 3; row++)
					for (let i = 0; i < 3 - row; i++)
						out.push({ ...TEMPLATES[1], name: 'Card can ' + ++k, pos: [cx + (i - (2 - row) / 2) * 0.222, top + 0.143 + row * 0.284, cz], physics: undefined });
				return out;
			}),
			{ ...TEMPLATES[0], name: 'Card ball 1', pos: [-0.75, 1.195, 1.9], physics: undefined },
			{ ...TEMPLATES[0], name: 'Card ball 2', pos: [-0.45, 1.195, 1.9], physics: undefined },
			{ ...TEMPLATES[0], name: 'Card ball 3', pos: [0.15, 1.195, 1.9], physics: undefined },
			{ ...TEMPLATES[0], name: 'Card ball flying', pos: [-0.6, 1.6, -1.2], physics: undefined }
		]
	},
	graphs: { scene: tossGraph() },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'menu',
					name: 'Stages',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 640, h: 380, z: 0, label: '', style: TOSS_PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -146, w: 520, h: 50, z: 1, label: 'TARGET TOSS', style: { size: 40, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -94, w: 580, h: 44, z: 1, label: 'Grab a ball from the shelf and knock everything down before the clock runs out: tin cans, swinging targets, pop-ups and a moving cart. Quick hits build a combo.', style: { size: 13, color: '#f0e2d8', align: 'center' }, wrap: true },
						{ id: 'menu-line', kind: 'text', anchor: 'center', x: 0, y: -50, w: 420, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffc48a', align: 'center' } },
						...Array.from({ length: 5 }, (_, k) => stageCell(k + 1)).flat(),
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 104, w: 600, h: 34, z: 1, label: 'Desktop: HOLD the mouse to charge, RELEASE to throw · Esc menu', style: { size: 12, color: '#c9b3a8', align: 'center' }, wrap: true },
						{ id: 'menu-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 134, w: 600, h: 34, z: 1, label: 'VR: grip a ball from the shelf and throw it · Y switches to Edit', style: { size: 12, color: '#c9b3a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'tt-title', kind: 'text', anchor: 'top-center', x: 0, y: 12, w: 360, h: 28, z: 1, label: '', style: { size: 19, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'tt-targets', kind: 'text', anchor: 'top-center', x: 0, y: 42, w: 460, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffffff', align: 'center' } },
						{ id: 'tt-bar', kind: 'bar', anchor: 'top-center', x: 0, y: 68, w: 300, h: 10, z: 1, label: '', value: 0, min: 0, max: 1, style: { color: '#ffd45e', bg: 'rgba(255,255,255,0.18)', radius: 5 } },
						{ id: 'tt-clock', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 120, h: 26, z: 1, label: '', style: { size: 20, weight: '700', color: '#f5ece6', align: 'right' } },
						{ id: 'tt-score', kind: 'text', anchor: 'top-left', x: 16, y: 14, w: 220, h: 26, z: 1, label: '', style: { size: 20, weight: '700', color: '#ffd45e', align: 'left' } },
						{ id: 'tt-combo', kind: 'text', anchor: 'top-left', x: 16, y: 44, w: 220, h: 24, z: 1, label: '', style: { size: 17, weight: '700', color: '#ff8a5c', align: 'left' } },
						{ id: 'tt-charge', kind: 'bar', anchor: 'bottom-center', x: 0, y: 44, w: 220, h: 10, z: 1, label: '', value: 0, min: 0, max: 1, style: { color: '#ff8a5c', bg: 'rgba(255,255,255,0.15)', radius: 5 } },
						{ id: 'tt-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 14, w: 620, h: 20, z: 1, label: 'Hold to charge · release to throw · Esc menu', style: { size: 12, color: '#f5ece6', align: 'center' } }
					]
				},
				{
					id: 'over',
					name: 'Results',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 360, z: 0, label: '', style: TOSS_PANEL },
						{ id: 'tt-result', kind: 'text', anchor: 'center', x: 0, y: -130, w: 440, h: 40, z: 1, label: '', style: { size: 28, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'tt-stars', kind: 'text', anchor: 'center', x: 0, y: -84, w: 300, h: 46, z: 1, label: '', style: { size: 38, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'tt-line', kind: 'text', anchor: 'center', x: 0, y: -36, w: 440, h: 40, z: 1, label: '', style: { size: 13, color: '#f5ece6', align: 'center' }, wrap: true },
						{ id: 'tt-best', kind: 'text', anchor: 'center', x: 0, y: -4, w: 440, h: 20, z: 1, label: '', style: { size: 12, color: '#ffc48a', align: 'center' } },
						{ id: 'next-btn', kind: 'button', anchor: 'center', x: 0, y: 50, w: 240, h: 46, z: 1, label: 'Next stage', enabled: true, style: TOSS_BTN },
						{ id: 'retry-btn', kind: 'button', anchor: 'center', x: -64, y: 110, w: 116, h: 40, z: 1, label: 'Retry', enabled: true, style: { ...TOSS_BTN, size: 15, bg: '#4c9e6a' } },
						{ id: 'levels-btn', kind: 'button', anchor: 'center', x: 64, y: 110, w: 116, h: 40, z: 1, label: 'Stages', enabled: true, style: { size: 15, weight: '500', bg: '#4a3a3e', color: '#f5ece6', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the marker that wakes the core `targettoss` module (an empty: no body, no draw)
		{ type: 'empty', name: 'Target Toss game' },
		{ type: 'box', name: 'Fairground floor', color: 0x9a7b5a, size: [20, 0.5, 20], pos: [0, -0.25, 0], roughness: 0.9, physics: { mode: 'static', friction: 0.9 } },
		// the BOOTH: a counter, the ball shelf on it with two lips, posts and a striped awning
		{ type: 'box', name: 'Counter', color: 0x8a3a2e, size: [3.4, 1.0, 0.6], bevel: 0.04, bevelSegments: 1, pos: [0, 0.5, 1.9], ...WOOD, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'box', name: 'Ball shelf', color: 0xe8c98a, size: [2.0, 0.08, 0.42], pos: [0, 1.04, 1.9], ...WOOD, physics: { mode: 'static', friction: 1, restitution: 0 } },
		{ type: 'box', name: 'Shelf lip front', color: 0xe8c98a, size: [2.0, 0.05, 0.03], pos: [0, 1.105, 2.1], ...WOOD, physics: { mode: 'static' } },
		{ type: 'box', name: 'Shelf lip back', color: 0xe8c98a, size: [2.0, 0.05, 0.03], pos: [0, 1.105, 1.7], ...WOOD, physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Post west', color: 0xfff4e0, r: 0.06, h: 3.0, pos: [-1.95, 1.5, 1.9], roughness: 0.6, physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Post east', color: 0xfff4e0, r: 0.06, h: 3.0, pos: [1.95, 1.5, 1.9], roughness: 0.6, physics: { mode: 'static' } },
		...STRIPES,
		// a string of bulbs along the awning's front edge (emissive, no shadow, no body)
		...Array.from({ length: 9 }, (_, k) => ({ type: 'sphere', name: 'Bulb ' + (k + 1), r: 0.045, color: k % 3 === 0 ? 0xffe08a : k % 3 === 1 ? 0xff9a6a : 0x9ad0ff, emissive: k % 3 === 0 ? 0xffc040 : k % 3 === 1 ? 0xff6a3a : 0x4a9cff, emissiveIntensity: 2.6, pos: [-1.9 + k * 0.475, 2.78, 2.33], shadow: false })),
		// the TABLES for the tin cans
		{ type: 'box', name: 'Table left', color: 0x4f7fbf, size: [1.2, 0.9, 0.6], bevel: 0.03, bevelSegments: 1, pos: [-1.2, 0.45, -2.8], ...WOOD, physics: { mode: 'static', friction: 0.8 } },
		{ type: 'box', name: 'Table right', color: 0x4fa36f, size: [1.4, 0.9, 0.6], bevel: 0.03, bevelSegments: 1, pos: [1.3, 0.45, -3.8], ...WOOD, physics: { mode: 'static', friction: 0.8 } },
		// the SWINGING targets hang from a beam (the module's effect swings them; hidden when unused)
		{ type: 'box', name: 'Swing beam', color: 0x6b4a32, size: [7, 0.16, 0.16], pos: [0, 3.5, -5.4], ...WOOD, physics: { mode: 'static' } },
		disc('Swing target 1', 0.28, [-2.2, 2.3, -5.4], 0xffd45e, 0xff9a2e),
		disc('Swing target 2', 0.28, [0, 2.3, -5.4], 0xffd45e, 0xff9a2e),
		disc('Swing target 3', 0.28, [2.2, 2.3, -5.4], 0xffd45e, 0xff9a2e),
		// the POP-UP targets rise above a low wall
		{ type: 'box', name: 'Pop-up wall', color: 0x5a2f3a, size: [8, 0.95, 0.25], pos: [0, 0.475, -6.4], ...WOOD, physics: { mode: 'static' } },
		...[1, 2, 3, 4, 5, 6].map((i) => disc('Popup target ' + i, 0.24, [-3 + (i - 1) * 1.2, 1.32, -6.6], 0xff5a4e, 0xff2a1e)),
		// the CART runs on a track in front of the wall, a bullseye on top
		{ type: 'box', name: 'Cart track', color: 0x3b3b44, size: [7.6, 0.03, 0.24], pos: [0, 0.015, -5.9], metalness: 0.6, roughness: 0.4, shadow: false },
		{ type: 'box', name: 'Cart', color: 0x2e6fd8, size: [1.0, 0.5, 0.5], bevel: 0.05, bevelSegments: 1, pos: [0, 0.3, -5.9], physical: true, roughness: 0.4, clearcoat: 0.6, physics: { mode: 'static' } },
		disc('Cart target', 0.34, [0, 0.95, -5.9], 0xfff4e0, 0xffc640),
		// the back curtain and one warm light
		{ type: 'box', name: 'Back curtain', color: 0x7a1f2e, size: [10, 3.6, 0.2], pos: [0, 1.8, -8], roughness: 0.95, physics: { mode: 'static' } },
		{ type: 'light', name: 'Booth light', kind: 'point', color: 0xffc98a, intensity: 9, distance: 16, pos: [0, 3.0, -2.2] },
		// the TEMPLATES, parked on a vault slab far under the floor
		{ type: 'box', name: 'Template vault', color: 0x333333, size: [4, 0.5, 2], pos: [0, VAULT_TOP - 0.25, 0], shadow: false, physics: { mode: 'static', friction: 1 } },
		...TEMPLATES,
		{ type: 'camera', name: 'Card camera', pos: [-0.5, 2.0, 3.3], lookAt: [0.1, 1.2, -4.2], fov: 55 }
	]
};

module.exports = TARGET_TOSS_DEF;
