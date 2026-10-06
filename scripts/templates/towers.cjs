// Template def `towers` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');

/** the floor tile: a 13 x 13 grid of 2 m tiles with a thin grout line and a faint checker,
 * MULTIPLYING the authored colour (albedo is `diffuseColor.rgb *= ` in the inject backend) */
const TOWERS_FLOOR_SHADER = {
	nodes: [
		{ id: 'uv', type: 'uv', position: { x: 40, y: 80 }, data: {} },
		{ id: 'xy', type: 'split', position: { x: 240, y: 80 }, data: {} },
		{
			id: 'tile',
			type: 'glsl',
			position: { x: 460, y: 80 },
			data: {
				type: 'vec3',
				expression:
					'vec3(1.0 - 0.3 * (1.0 - step(0.025, fract(a * 13.0)) * step(fract(a * 13.0), 0.975) * step(0.025, fract(b * 13.0)) * step(fract(b * 13.0), 0.975)) - 0.06 * mod(floor(a * 13.0) + floor(b * 13.0), 2.0))'
			}
		},
		{ id: 's', type: 'surface', position: { x: 720, y: 80 }, data: {} }
	],
	edges: [
		{ id: 'e-uv-xy', source: 'uv', sourceHandle: 'out', target: 'xy', targetHandle: 'value' },
		{ id: 'e-xy-tile-a', source: 'xy', sourceHandle: 'x', target: 'tile', targetHandle: 'a' },
		{ id: 'e-xy-tile-b', source: 'xy', sourceHandle: 'y', target: 'tile', targetHandle: 'b' },
		{ id: 'e-tile-s', source: 'tile', sourceHandle: 'out', target: 's', targetHandle: 'albedo' }
	]
};

// ---- B8 → 31-towers: Towers, a real game ----------------------------------------
// The round was "stack crates to the gold ring, hooray" (the Quest note: "after finishing
// basic level nothing happens"). It is TWELVE LEVELS now, each with its own piece shapes, a
// limited supply dealt onto racks, a goal, par pieces and par time for 1-3 stars, an unlock
// chain and logical rules: grab REACH is limited (play.reach, 1.3 m from your body), so the
// high levels need steps and a JUMP (the Character Controller's jumpHeight, desktop Space /
// VR A); pieces dropped outside the build yard are LOST; later levels add wind, a narrow
// pedestal, a rocking plate, an outline to fill and a star to deliver.
//
// THE SPLIT: this def is the ARENA (every object the levels name — zones, racks, the ledge,
// the perch, the piece TEMPLATES under the floor, the goal/yard/ghost markers), the HUD and a
// small graph (buttons, P pause, click sounds, music, the controller, the wobble effect, and
// the HUD words through the core `towers` module's `towersinfo` value node). The levels, the
// dealing, the judge and the stars live in src/modules/towers (levels.js is the table).
// No module download: the template needs only core.

/** one wooden look for every piece */
const TOWERS_WOOD = { physical: true, roughness: 0.6, sheen: 0.4, sheenColor: 0xffd7a0, sheenRoughness: 0.55, clearcoat: 0.12, clearcoatRoughness: 0.5 };
/** the eight corners of a local box, flat — a custom compound collider piece
 * @param {number} x0 @param {number} x1 @param {number} y0 @param {number} y1 @param {number} z0 @param {number} z1 */
const boxVerts = (x0, x1, y0, y1, z0, z1) => {
	const out = [];
	for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push(x, y, z);
	return out;
};
/** a custom collider from box pieces @param {number[][]} boxes [x0,x1,y0,y1,z0,z1] each */
const compound = (boxes) => {
	const colliderVerts = [];
	const colliderPieces = [];
	for (const b of boxes) {
		colliderPieces.push([colliderVerts.length, 24]);
		colliderVerts.push(...boxVerts(...b));
	}
	return { collider: 'custom', colliderVerts, colliderPieces };
};
const piecePhysics = (mass, extra = {}) => ({ mode: 'dynamic', mass, friction: 0.85, restitution: 0.03, ...extra });
/** the vault the templates rest on, far under the arena floor */
const VAULT_TOP = -6.25;
/** the piece TEMPLATES: dynamic (so every copy is), parked on the vault; the module copies
 * them as transient pieces. Names are the module's `SHAPES[*].template`. */
const TOWERS_TEMPLATES = [
	{ type: 'box', name: 'Piece cube', color: 0xb57a45, size: [0.6, 0.6, 0.6], bevel: 0.045, bevelSegments: 1, pos: [-6, VAULT_TOP + 0.3, 0], ...TOWERS_WOOD, physics: piecePhysics(1) },
	{ type: 'box', name: 'Piece plank', color: 0xd2a86e, size: [1.4, 0.3, 0.6], bevel: 0.04, bevelSegments: 1, pos: [-4.5, VAULT_TOP + 0.15, 0], ...TOWERS_WOOD, physics: piecePhysics(0.9) },
	{ type: 'box', name: 'Piece beam', color: 0xc49a60, size: [2.0, 0.25, 0.4], bevel: 0.035, bevelSegments: 1, pos: [-2.4, VAULT_TOP + 0.125, 0], ...TOWERS_WOOD, physics: piecePhysics(1) },
	{ type: 'block', shape: 'Wedge', args: [0.8, 0.6, 0.6], name: 'Piece wedge', color: 0x5f9fd8, pos: [-0.6, VAULT_TOP, 0], roughness: 0.55, physics: piecePhysics(0.7, { collider: 'hull' }) },
	{ type: 'cylinder', name: 'Piece barrel', color: 0x9a5b2e, r: 0.3, h: 0.7, pos: [0.6, VAULT_TOP + 0.35, 0], ...TOWERS_WOOD, physics: piecePhysics(0.8, { collider: 'cylinder' }) },
	{
		type: 'block', shape: 'Arch', args: [1.2, 0.8, 0.5], name: 'Piece arch', color: 0xb8ad98, pos: [2.2, VAULT_TOP, 0], roughness: 0.8,
		physics: piecePhysics(1.4, compound([[-0.6, -0.36, 0, 0.8, -0.25, 0.25], [0.36, 0.6, 0, 0.8, -0.25, 0.25], [-0.36, 0.36, 0.72, 0.8, -0.25, 0.25]]))
	},
	{
		type: 'block', shape: 'Corner', args: [0.9, 0.45, 0.3], name: 'Piece L', color: 0x86b865, pos: [3.8, VAULT_TOP, 0], roughness: 0.6,
		physics: piecePhysics(1, compound([[-0.45, 0.45, 0, 0.45, 0.15, 0.45], [-0.45, -0.15, 0, 0.45, -0.45, 0.45]]))
	},
	{ type: 'sphere', name: 'Piece ball', color: 0xe0604a, r: 0.3, pos: [5.2, VAULT_TOP + 0.3, 0], physical: true, roughness: 0.35, clearcoat: 0.6, physics: piecePhysics(0.8, { collider: 'sphere', friction: 0.6, restitution: 0.15 }) },
	{ type: 'box', name: 'Piece base', color: 0x59616e, size: [1.4, 0.35, 1.4], bevel: 0.05, bevelSegments: 1, pos: [6.8, VAULT_TOP + 0.175, 0], physical: true, roughness: 0.7, clearcoat: 0.2, physics: piecePhysics(6, { friction: 1 }) },
	{ type: 'dodecahedron', name: 'Piece star', color: 0xffc640, r: 0.26, pos: [8.4, VAULT_TOP + 0.26, 0], emissive: 0xffb830, emissiveIntensity: 1.6, physical: true, roughness: 0.25, metalness: 0.1, clearcoat: 1, flatShading: true, physics: piecePhysics(0.4, { collider: 'hull' }) }
];

const TOWERS_HUD_PANEL = { bg: 'rgba(14, 20, 32, 0.9)', radius: 18, border: '1px solid rgba(255, 212, 94, 0.28)' };
const TOWERS_BTN = { size: 17, weight: '600', bg: '#3b7dd8', color: '#ffffff', radius: 10 };
const TOWERS_LEVEL_NAMES = ['Stack', 'Planks', 'Climb', 'Wedges', 'Barrels', 'Arches', 'Narrow base', 'Gusts', 'Balls', 'Wobble', 'Outline', 'Summit'];

function towersGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	// ---- the buttons: the core `towers` module watches their stamps; the graph adds the click
	N('click', 'gamesound', 'Button click', 520, 40, { sound: 'click' });
	const button = (id, element, label, x, y) => {
		N(id, 'hudbutton', label, x, y, { element });
		E(id, 'click', 'trigger');
		return id;
	};
	for (let i = 1; i <= 12; i++) button('lvl' + i, 'lvl-' + i, 'Level ' + i + ' button', 40, 40 + (i - 1) * 70);
	button('bnext', 'next-btn', 'Next level button', 40, 900);
	button('bretry', 'retry-btn', 'Retry button', 40, 970);
	button('blevels', 'levels-btn', 'Levels button', 40, 1040);
	// ---- pause (P): Resume closes it; Restart and Levels are the module's, and close it too
	N('pkey', 'keypress', 'Press P', 40, 1140, { code: 'KeyP', edge: 'down', pulse: 0.3 });
	N('pausetoggle', 'hudscreen', 'Toggle pause menu', 280, 1140, { screen: 'pause', action: 'toggle' });
	E('pkey', 'pausetoggle', 'trigger');
	N('pausehide', 'hudscreen', 'Close pause menu', 520, 1240, { screen: 'pause', action: 'hide' });
	button('bresume', 'resume-btn', 'Resume button', 40, 1210);
	button('brestart', 'restart-btn', 'Restart level button', 40, 1280);
	button('bquit', 'quit-btn', 'Levels (pause) button', 40, 1350);
	for (const b of ['bresume', 'brestart', 'bquit']) E(b, 'pausehide', 'trigger');
	// ---- the HUD's words, from the module's Towers info node into HUD Text's FORMAT
	const text = (id, read, element, x, y, extra = {}) => {
		N(id + 'i', 'towersinfo', 'Towers: ' + read, x, y, { read, ...extra });
		N(id + 't', 'hudtext', 'HUD ' + element, x + 240, y, { element, format: '', decimals: 0, value: 0 });
		E(id + 'i', id + 't', 'format');
	};
	text('mline', 'menuLine', 'menu-line', 800, 40);
	for (let i = 1; i <= 12; i++) text('ls' + i, 'levelStars', 'lvl-' + i + '-stars', 800, 110 + (i - 1) * 70, { level: i });
	text('title', 'title', 'tw-title', 1300, 40);
	text('goal', 'goalText', 'tw-goal', 1300, 110);
	text('pieces', 'pieces', 'tw-pieces', 1300, 180);
	text('clock', 'clock', 'tw-clock', 1300, 250);
	text('hold', 'hold', 'tw-hold', 1300, 320);
	text('rule', 'rule', 'tw-rule', 1300, 390);
	text('result', 'result', 'tw-result', 1300, 480);
	text('rstars', 'resultStars', 'tw-stars', 1300, 550);
	text('rline', 'resultLine', 'tw-line', 1300, 620);
	text('rbest', 'resultBest', 'tw-best', 1300, 690);
	N('progi', 'towersinfo', 'Towers: progress', 1300, 780, { read: 'progress' });
	N('progbar', 'hudbar', 'HUD progress bar', 1540, 780, { element: 'tw-bar', value: 0, min: 0, max: 1, format: '' });
	E('progi', 'progbar', 'value');
	// ---- the world: music in the game, the player's body, the rocking plate
	N('music', 'gamemusic', 'Arcade music', 40, 1460, { preset: 'arcade', volume: 0.4, while: 'always' });
	// the Character Controller: WALK with gravity and a 1 m jump (Space on a desktop, A in VR),
	// which is what lets a player climb onto pieces to reach a high goal
	N('body', 'charcontroller', 'Player: walk + jump', 280, 1460, { mode: 'walk', speed: 0.06, jumpHeight: 1.0, eyeHeight: 1.7, gravity: true });
	N('wobble', 'towerswobble', 'Wobble plate rocks (level 10)', 40, 1560, { amplitude: 0.07, period: 3.4 });
	N('selwobble', 'objectselector', 'Wobble plate', 280, 1560, { selected: 'Wobble plate' });
	E('wobble', 'selwobble');
	// ---- 36 F11: MAIN, READABLE — four group cards with notes (groups are views: every node
	// and wire above is unchanged), laid out by the author script's Tidy
	const nums = (/** @type {string} */ p, /** @type {string} */ q = '') => Array.from({ length: 12 }, (_, i) => p + (i + 1) + q);
	const GX = -2400;
	g.T('n-readme', 'Towers — read me first', 'Stack the pieces you are dealt into a tower that meets the level\'s goal and **hold it** until the timer runs out. Twelve levels; stars for the win, few pieces and a quick time. The **Towers** module deals the pieces, judges the tower and keeps your stars — open its **Code link** to read it. This graph wires its words into the HUD and its buttons into the menus.', GX, -1500, { color: 'blue', w: 340, h: 210 });
	g.T('n-buttons', 'Level buttons', 'The level picker and the results buttons (Next, Retry, Levels) and the click every button makes. The module reads the presses.', GX, -1250, { color: 'gray', w: 300, h: 110 });
	g.G('g-buttons', 'Level buttons', [...nums('lvl'), 'bnext', 'bretry', 'blevels', 'click'], GX, -1100);
	g.T('n-picker', 'Level picker stars', 'The picker\'s headline and the stars you hold on each of the 12 levels — a **Towers** value into each HUD line.', GX, -950, { color: 'gray', w: 300, h: 100 });
	g.G('g-picker', 'Level picker stars', ['mlinei', 'mlinet', ...nums('ls', 'i'), ...nums('ls', 't')], GX, -820);
	g.T('n-hud', 'Play HUD & results', 'In play: the level, its goal, pieces left, the clock, the hold timer and the rule; at the end: the result, stars, the line and your best; the progress bar.', GX, -680, { color: 'green', w: 300, h: 120 });
	g.G('g-hud', 'Play HUD & results', ['titlei', 'titlet', 'goali', 'goalt', 'piecesi', 'piecest', 'clocki', 'clockt', 'holdi', 'holdt', 'rulei', 'rulet', 'resulti', 'resultt', 'rstarsi', 'rstarst', 'rlinei', 'rlinet', 'rbesti', 'rbestt', 'progi', 'progbar'], GX, -530);
	g.T('n-pause', 'Pause menu', '**P** opens it; Resume closes it, Restart replays the level, Levels goes back to the picker (the module acts on those two).', GX, -390, { color: 'purple', w: 300, h: 110 });
	g.G('g-pause', 'Pause menu', ['pkey', 'pausetoggle', 'pausehide', 'bresume', 'brestart', 'bquit'], GX, -250);
	return g.done();
}

/** a level-select cell: the button and the stars line under it @param {number} i 1..12 */
const towersLevelCell = (i) => {
	const col = (i - 1) % 4;
	const row = Math.floor((i - 1) / 4);
	const x = -216 + col * 144;
	const y = -40 + row * 76;
	return [
		{ id: 'lvl-' + i, kind: 'button', anchor: 'center', x, y, w: 132, h: 42, z: 1, label: i + ' · ' + TOWERS_LEVEL_NAMES[i - 1], enabled: true, style: { ...TOWERS_BTN, size: 14 } },
		{ id: 'lvl-' + i + '-stars', kind: 'text', anchor: 'center', x, y: y + 30, w: 132, h: 18, z: 1, label: '', style: { size: 13, weight: '600', color: '#ffd45e', align: 'center' } }
	];
};

const TOWERS_DEF = {
	kind: 'game',
	slug: 'towers',
	title: 'Towers',
	description:
		'Twelve levels of stacking: cubes, planks, wedges, barrels, arches and balls. You can only reach what is close to you, so build steps and jump. Wind, a wobbling plate and a star to deliver. 1-3 stars a level, saved on this device.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['physics', 'stacking', 'puzzle', 'co-op', 'vr'],
	modules: [],
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#4a7fc0', bottom: '#dbe8f2' },
		fog: { color: '#dbe8f2', near: 16, far: 75 },
		ground: { color: '#7b8866', roughness: 0.95 }
	},
	physics: {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0 },
		bounds: { limit: -20, action: 'respawn' },
		material: { friction: 0.7, restitution: 0.05 },
		damping: { linear: 0.05, angular: 0.3 },
		// 31-towers: REACH 1.3 m from your body — the puzzle's first rule
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [0, 0, 5.4], yaw: 0 }, reach: 1.3 }
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.75, luminanceThreshold: 0.8 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [9, 7.5, 13.5], target: [0, 1.4, -1] },
	thumb: {
		camera: 'Card camera',
		// a round in progress: a half-built tower on the pad, the supply on the racks
		dress: [
			{ ...TOWERS_TEMPLATES[8], name: 'Card base', pos: [0, 0.375, 0], physics: undefined },
			{ ...TOWERS_TEMPLATES[0], name: 'Card cube 1', pos: [-0.35, 0.86, 0.1], physics: undefined },
			{ ...TOWERS_TEMPLATES[0], name: 'Card cube 2', pos: [0.35, 0.86, -0.1], rot: [0, 0.3, 0], physics: undefined },
			{ ...TOWERS_TEMPLATES[1], name: 'Card plank', pos: [0, 1.32, 0], rot: [0, 0.4, 0], physics: undefined },
			{ ...TOWERS_TEMPLATES[3], name: 'Card wedge', pos: [0, 1.47, 0], rot: [0, 0.4, 0], physics: undefined },
			{ ...TOWERS_TEMPLATES[4], name: 'Card barrel', pos: [0.9, 0.35, 1.9], rot: [0, 0, Math.PI / 2], physics: undefined },
			{ ...TOWERS_TEMPLATES[0], name: 'Card rack 1', pos: [4.4, 1.12, 0.9], physics: undefined },
			{ ...TOWERS_TEMPLATES[0], name: 'Card rack 2', pos: [4.4, 1.12, 1.7], physics: undefined },
			{ ...TOWERS_TEMPLATES[5], name: 'Card rack 3', pos: [4.4, 0.82, 2.8], physics: undefined },
			{ ...TOWERS_TEMPLATES[1], name: 'Card rack 4', pos: [-4.4, 0.97, 1.0], physics: undefined },
			{ ...TOWERS_TEMPLATES[6], name: 'Card rack 5', pos: [-4.4, 0.82, 2.4], physics: undefined },
			{ ...TOWERS_TEMPLATES[0], name: 'Card ledge', pos: [0.6, 3.32, -3.0], physics: undefined },
			{ ...TOWERS_TEMPLATES[9], name: 'Card star', pos: [2.4, 3.68, -2.2], physics: undefined }
		]
	},
	graphs: { scene: towersGraph() },
	// 36 F11: group cards laid out by the node editor's own Tidy
	graphTidy: 'layout',
	shaders: { 'Arena floor': TOWERS_FLOOR_SHADER },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'menu',
					name: 'Levels',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 20, w: 640, h: 520, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -206, w: 520, h: 50, z: 1, label: 'TOWERS', style: { size: 40, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -154, w: 580, h: 44, z: 1, label: 'Carry pieces from the racks to the glowing zone and build up to the gold ring. You can only grab what is close to you, so build steps and jump to reach higher. The tower must hold still for three seconds.', style: { size: 13, color: '#d8dee9', align: 'center' }, wrap: true },
						{ id: 'menu-line', kind: 'text', anchor: 'center', x: 0, y: -110, w: 420, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#9ee6ff', align: 'center' } },
						...Array.from({ length: 12 }, (_, k) => towersLevelCell(k + 1)).flat(),
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 214, w: 600, h: 34, z: 1, label: 'Desktop: hold click to grab · wheel pushes/pulls · WASD walk · Space jumps · P pause', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true },
						{ id: 'menu-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 244, w: 600, h: 34, z: 1, label: 'VR: grip grabs a piece · left stick walks · A jumps · Y switches to Edit', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'tw-title', kind: 'text', anchor: 'top-center', x: 0, y: 12, w: 360, h: 28, z: 1, label: '', style: { size: 19, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'tw-goal', kind: 'text', anchor: 'top-center', x: 0, y: 42, w: 420, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffffff', align: 'center' } },
						{ id: 'tw-bar', kind: 'bar', anchor: 'top-center', x: 0, y: 68, w: 300, h: 10, z: 1, label: '', value: 0, min: 0, max: 1, style: { color: '#ffd45e', bg: 'rgba(255,255,255,0.18)', radius: 5 } },
						{ id: 'tw-clock', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 120, h: 26, z: 1, label: '', style: { size: 20, weight: '700', color: '#e5e9f0', align: 'right' } },
						{ id: 'tw-pieces', kind: 'text', anchor: 'top-right', x: 16, y: 44, w: 320, h: 20, z: 1, label: '', style: { size: 12, weight: '600', color: '#9ee6ff', align: 'right' } },
						{ id: 'tw-hold', kind: 'text', anchor: 'center', x: 0, y: -120, w: 360, h: 40, z: 1, label: '', style: { size: 28, weight: '700', color: '#7dffb0', align: 'center' } },
						{ id: 'tw-rule', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 620, h: 20, z: 1, label: '', style: { size: 12, color: '#e5e9f0', align: 'center' } }
					]
				},
				{
					id: 'pause',
					name: 'Pause',
					input: 'menu',
					elements: [
						{ id: 'pause-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 380, h: 300, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'pause-title', kind: 'text', anchor: 'center', x: 0, y: -95, w: 340, h: 36, z: 1, label: 'PAUSED', style: { size: 26, weight: '700', color: '#e5e9f0', align: 'center' } },
						{ id: 'resume-btn', kind: 'button', anchor: 'center', x: 0, y: -30, w: 240, h: 42, z: 1, label: 'Resume', enabled: true, style: { ...TOWERS_BTN, size: 16 } },
						{ id: 'restart-btn', kind: 'button', anchor: 'center', x: 0, y: 22, w: 240, h: 42, z: 1, label: 'Restart level', enabled: true, style: { ...TOWERS_BTN, size: 16, bg: '#4c9e6a' } },
						{ id: 'quit-btn', kind: 'button', anchor: 'center', x: 0, y: 74, w: 240, h: 42, z: 1, label: 'Levels', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				},
				{
					id: 'over',
					name: 'Results',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 360, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'tw-result', kind: 'text', anchor: 'center', x: 0, y: -130, w: 440, h: 40, z: 1, label: '', style: { size: 28, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'tw-stars', kind: 'text', anchor: 'center', x: 0, y: -84, w: 300, h: 46, z: 1, label: '', style: { size: 38, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'tw-line', kind: 'text', anchor: 'center', x: 0, y: -36, w: 440, h: 40, z: 1, label: '', style: { size: 13, color: '#e5e9f0', align: 'center' }, wrap: true },
						{ id: 'tw-best', kind: 'text', anchor: 'center', x: 0, y: -4, w: 440, h: 20, z: 1, label: '', style: { size: 12, color: '#9ee6ff', align: 'center' } },
						{ id: 'next-btn', kind: 'button', anchor: 'center', x: 0, y: 50, w: 240, h: 46, z: 1, label: 'Next level', enabled: true, style: TOWERS_BTN },
						{ id: 'retry-btn', kind: 'button', anchor: 'center', x: -64, y: 110, w: 116, h: 40, z: 1, label: 'Retry', enabled: true, style: { ...TOWERS_BTN, size: 15, bg: '#4c9e6a' } },
						{ id: 'levels-btn', kind: 'button', anchor: 'center', x: 64, y: 110, w: 116, h: 40, z: 1, label: 'Levels', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the marker that wakes the core `towers` module (an empty: no body, no draw)
		{ type: 'empty', name: 'Towers game' },
		// the arena — a tiled floor with a low chamfered rim and a glowing trim on top
		{ type: 'box', name: 'Arena floor', color: 0xb4bbc4, size: [26, 0.5, 26], pos: [0, -0.25, 0], roughness: 0.78, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'box', name: 'Wall north', color: 0x7a8494, size: [26, 1, 0.5], bevel: 0.1, bevelSegments: 1, pos: [0, 0.5, -13], physical: true, roughness: 0.55, clearcoat: 0.3, physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall south', color: 0x7a8494, size: [26, 1, 0.5], bevel: 0.1, bevelSegments: 1, pos: [0, 0.5, 13], physical: true, roughness: 0.55, clearcoat: 0.3, physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall west', color: 0x7a8494, size: [0.5, 1, 26], bevel: 0.1, bevelSegments: 1, pos: [-13, 0.5, 0], physical: true, roughness: 0.55, clearcoat: 0.3, physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall east', color: 0x7a8494, size: [0.5, 1, 26], bevel: 0.1, bevelSegments: 1, pos: [13, 0.5, 0], physical: true, roughness: 0.55, clearcoat: 0.3, physics: { mode: 'static' } },
		{ type: 'box', name: 'Trim north', color: 0x9fe8ff, size: [25.4, 0.05, 0.12], pos: [0, 1.02, -13], emissive: 0x4fcfff, emissiveIntensity: 2.4, shadow: false },
		{ type: 'box', name: 'Trim south', color: 0x9fe8ff, size: [25.4, 0.05, 0.12], pos: [0, 1.02, 13], emissive: 0x4fcfff, emissiveIntensity: 2.4, shadow: false },
		{ type: 'box', name: 'Trim west', color: 0x9fe8ff, size: [0.12, 0.05, 25.4], pos: [-13, 1.02, 0], emissive: 0x4fcfff, emissiveIntensity: 2.4, shadow: false },
		{ type: 'box', name: 'Trim east', color: 0x9fe8ff, size: [0.12, 0.05, 25.4], pos: [13, 1.02, 0], emissive: 0x4fcfff, emissiveIntensity: 2.4, shadow: false },
		// ZONE 1 — the build pad (most levels), sunk so its bottom is not coplanar with the floor
		{ type: 'cylinder', name: 'Build pad', color: 0x2f6fbf, r: 1.7, h: 0.24, pos: [0, 0.08, 0], emissive: 0x2f8fff, emissiveIntensity: 1.1, physical: true, roughness: 0.3, clearcoat: 0.8, physics: { mode: 'static', friction: 1 } },
		{ type: 'torus', name: 'Pad rim', color: 0xbfefff, r: 1.72, tube: 0.045, pos: [0, 0.2, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x7fdcff, emissiveIntensity: 3, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true } },
		{ type: 'light', name: 'Pad glow', kind: 'point', color: 0x5fb4ff, intensity: 4, distance: 7, pos: [0, 0.7, 0] },
		// ZONE 2 — the narrow pedestal (level 7), north-west
		{ type: 'box', name: 'Pedestal', color: 0x6a7382, size: [0.8, 0.8, 0.8], bevel: 0.05, bevelSegments: 1, pos: [-6, 0.4, -4.5], physical: true, roughness: 0.5, clearcoat: 0.4, physics: { mode: 'static', friction: 1 } },
		{ type: 'box', name: 'Pedestal cap', color: 0x9fe8ff, size: [0.84, 0.03, 0.84], pos: [-6, 0.815, -4.5], emissive: 0x4fcfff, emissiveIntensity: 1.6, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true } },
		// ZONE 3 — the wobble plate (level 10), north-east: it ROCKS through the module's effect
		{ type: 'cone', name: 'Wobble pivot', color: 0x59616e, r: 0.5, h: 0.2, pos: [6, 0.1, -4.5], roughness: 0.5, physics: { mode: 'static' } },
		{ type: 'box', name: 'Wobble plate', color: 0x3d7f6e, size: [2.2, 0.2, 2.2], bevel: 0.05, bevelSegments: 1, pos: [6, 0.25, -4.5], emissive: 0x2a8f6e, emissiveIntensity: 0.5, physical: true, roughness: 0.4, clearcoat: 0.5, physics: { mode: 'static', friction: 1 } },
		// the SUPPLY: two low racks either side of the spawn (top 0.8), a high ledge north of the
		// pad (top 3.0 — out of reach from the floor) and a star perch (top 3.4)
		{ type: 'box', name: 'Rack west', color: 0x6b5a48, size: [1.6, 0.8, 4], bevel: 0.05, bevelSegments: 1, pos: [-4.4, 0.4, 2.2], ...TOWERS_WOOD, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'box', name: 'Rack east', color: 0x6b5a48, size: [1.6, 0.8, 4], bevel: 0.05, bevelSegments: 1, pos: [4.4, 0.4, 2.2], ...TOWERS_WOOD, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'box', name: 'High ledge', color: 0x7a8494, size: [3, 0.3, 0.9], bevel: 0.05, bevelSegments: 1, pos: [0, 2.85, -3.0], physical: true, roughness: 0.5, clearcoat: 0.3, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'cylinder', name: 'Ledge post west', color: 0x5d6879, r: 0.09, h: 2.7, pos: [-1.35, 1.35, -3.0], physical: true, metalness: 0.3, roughness: 0.4, physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Ledge post east', color: 0x5d6879, r: 0.09, h: 2.7, pos: [1.35, 1.35, -3.0], physical: true, metalness: 0.3, roughness: 0.4, physics: { mode: 'static' } },
		{ type: 'box', name: 'Star perch', color: 0x7a8494, size: [0.7, 0.2, 0.7], bevel: 0.04, bevelSegments: 1, pos: [2.4, 3.3, -2.2], physical: true, roughness: 0.5, physics: { mode: 'static', friction: 1 } },
		{ type: 'cylinder', name: 'Perch post', color: 0x5d6879, r: 0.06, h: 3.2, pos: [2.4, 1.6, -2.2], physical: true, metalness: 0.3, roughness: 0.4, physics: { mode: 'static' } },
		// the MOVING markers — the module puts them on the level's zone (a sensor each, so none
		// is a wall: every top-level object becomes a fixed body at sim start)
		{ type: 'torus', name: 'Goal ring', color: 0xfff0b8, r: 0.95, tube: 0.045, pos: [0, 1.8, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0xffc640, emissiveIntensity: 2.8, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true } },
		{ type: 'ring', name: 'Yard ring', color: 0xbff4ff, r: 3.4, inner: 3.3, pos: [0, 0.02, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 1.2, shadow: false, side: 'double', pick: 'through', physics: { mode: 'static', sensor: true } },
		{ type: 'box', name: 'Ghost wall', color: 0x9fe8ff, size: [1.8, 1.2, 0.62], pos: [0, -9, 0], emissive: 0x49d2ff, emissiveIntensity: 0.9, opacity: 0.22, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true } },
		// the measuring pole beside the pad: a bright mark per metre
		{ type: 'cylinder', name: 'Height pole', color: 0xe8edf3, r: 0.04, h: 4.3, pos: [2.2, 2.15, 0.6], physical: true, metalness: 0.6, roughness: 0.3, shadow: false, physics: { mode: 'static' } },
		...[1, 2, 3, 4].map((m) => ({ type: 'torus', name: 'Pole mark ' + m + 'm', color: 0xbff4ff, r: 0.1, tube: 0.025, pos: [2.2, m, 0.6], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 2.4, shadow: false, physics: { mode: 'static', sensor: true } })),
		// the piece TEMPLATES, parked on a vault slab far under the floor
		{ type: 'box', name: 'Template vault', color: 0x333333, size: [18, 0.5, 3], pos: [1, VAULT_TOP - 0.25, 0], shadow: false, physics: { mode: 'static', friction: 1 } },
		...TOWERS_TEMPLATES,
		// the card's camera: a 3/4 view over the pad, the ledge and a rack
		{ type: 'camera', name: 'Card camera', pos: [6.6, 4.9, 8.2], lookAt: [0, 1.3, -0.9], fov: 45 }
	]
};

module.exports = TOWERS_DEF;
