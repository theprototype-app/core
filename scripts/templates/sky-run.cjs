// Template def `sky-run` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.
//
// 35-sky-obby: SKY RUN, a floating obstacle course. The def owns the GEOMETRY and the graph; the
// core `skyrun` module (src/modules/skyrun/module.js) reads the course BY NAME — `Sky S<n> start`,
// `Sky S<n> flag <k>`, `Sky S<n> coin <k>`, `Sky S<n> portal`, `Sky S<n> spinner <k>` — and owns
// the run (falls, checkpoints, coins, spinners, the portal) and the mover effect. Design notes:
//   · three stages side by side (x 0 / 30 / 60), each running toward -Z from its start pad;
//     the stage picker teleports you, so they never need to connect;
//   · GENEROUS for VR: platforms >= 2.5 m, gaps <= 1.5 m, steps <= 0.5 m (the walker jumps 1.3 m);
//   · every moving thing is a `skyrunmove` EFFECT node -> the runtime makes it a KINEMATIC body
//     the walker stands on, and the pose comes from the synced clock, so no message moves it;
//   · coins, flags, the portal and the clouds are SENSORS — every top-level object becomes a
//     fixed body at sim start, and the walker's capsule ignores sensors (EXCLUDE_SENSORS);
//   · the HUD sits top-CENTRE: the game shell's Menu button owns the top-right corner;
//   · a dynamic crate on stage 1's pad, because a scene with no dynamic body starts no
//     simulation and a walker with no simulation collides with nothing;
//   · the physics ground is OFF (you fall into the clouds) and the module catches a fall 7 m
//     under the stage's start pad; ~70 meshes in all, well under the 150-call budget.
const { graphBuilder } = require('./_builders.cjs');

const PANEL = { bg: 'rgba(12, 22, 48, 0.9)', radius: 18, border: '1px solid rgba(160, 220, 255, 0.35)' };
const BTN = { size: 17, weight: '600', bg: '#2f8fe0', color: '#ffffff', radius: 10 };
const STAGE_NAMES = ['Cloud Steps', 'Spin Cycle', 'Sky Gauntlet'];
const STAGE_X = [0, 30, 60];
const STAGE_COLORS = [
	{ top: 0x8fd3ff, side: 0x4a90c8 },
	{ top: 0xffc58f, side: 0xc8804a },
	{ top: 0xd3a6ff, side: 0x8a5ac8 }
];

/** @type {any[]} */ const OBJECTS = [];
/** @type {{name: string, data: any}[]} */ const MOVERS = [];
const THICK = 0.6;

/** a platform whose TOP is at `top` @param {number} s stage 1..3 @param {string} name @param {number} x @param {number} top @param {number} z @param {number} w @param {number} d @param {any=} extra */
function plat(s, name, x, top, z, w, d, extra = {}) {
	const c = STAGE_COLORS[s - 1];
	OBJECTS.push({
		type: 'box', name, color: extra.color ?? c.top, size: [w, THICK, d], bevel: 0.08, bevelSegments: 1,
		pos: [STAGE_X[s - 1] + x, top - THICK / 2, z], physical: true, roughness: 0.45, clearcoat: 0.4,
		emissive: extra.emissive ?? c.side, emissiveIntensity: extra.glow ?? 0.12,
		physics: { mode: 'static', friction: 0.9 }
	});
	if (extra.move) MOVERS.push({ name, data: extra.move });
	return name;
}
let coinN = [0, 0, 0];
/** a coin floating ~1 m over a spot @param {number} s @param {number} x @param {number} top @param {number} z */
function coin(s, x, top, z) {
	const k = ++coinN[s - 1];
	const name = 'Sky S' + s + ' coin ' + k;
	OBJECTS.push({
		type: 'cylinder', name, color: 0xffd45e, r: 0.32, h: 0.08, pos: [STAGE_X[s - 1] + x, top + 1.0, z], rot: [Math.PI / 2, 0, 0],
		emissive: 0xffb020, emissiveIntensity: 1.6, physical: true, metalness: 0.6, roughness: 0.25, shadow: false, pick: 'through',
		physics: { mode: 'static', sensor: true }
	});
	MOVERS.push({ name, data: { kind: 'coin', axis: 'y', distance: 0.3, period: 2.2, phase: k * 0.4 } });
}
/** a checkpoint flag (pole + cloth) standing on a spot @param {number} s @param {number} k @param {number} x @param {number} top @param {number} z */
function flag(s, k, x, top, z) {
	const X = STAGE_X[s - 1] + x;
	OBJECTS.push({ type: 'cylinder', name: 'Sky S' + s + ' flag ' + k, color: 0xf1f5fa, r: 0.06, h: 2.2, pos: [X - 1.2, top + 1.1, z], metalness: 0.5, roughness: 0.3, physics: { mode: 'static', sensor: true } });
	OBJECTS.push({ type: 'box', name: 'Sky S' + s + ' cloth ' + k, color: 0x5be38a, size: [0.8, 0.5, 0.04], pos: [X - 0.8, top + 1.9, z], emissive: 0x2fbf60, emissiveIntensity: 0.8, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true } });
}
/** a low sweeping arm over a platform (jump it) @param {number} s @param {number} k @param {number} x @param {number} top @param {number} z @param {number} len @param {number} period @param {number} dir */
function spinner(s, k, x, top, z, len, period, dir) {
	const X = STAGE_X[s - 1] + x;
	const name = 'Sky S' + s + ' spinner ' + k;
	OBJECTS.push({ type: 'cylinder', name: 'Sky S' + s + ' hub ' + k, color: 0x3a4150, r: 0.25, h: 0.9, pos: [X, top + 0.45, z], metalness: 0.5, roughness: 0.4, physics: { mode: 'static', sensor: true } });
	OBJECTS.push({
		type: 'box', name, color: 0xff5a5a, size: [len, 0.35, 0.35], pos: [X, top + 0.45, z], emissive: 0xff2a2a, emissiveIntensity: 0.9,
		physical: true, roughness: 0.4, clearcoat: 0.5, physics: { mode: 'static', sensor: true }
	});
	MOVERS.push({ name, data: { kind: 'spin', axis: 'y', distance: 0, period, phase: 0, dir } });
}
/** the finish portal (a glowing ring standing up, facing the run) @param {number} s @param {number} x @param {number} top @param {number} z */
function portal(s, x, top, z) {
	const X = STAGE_X[s - 1] + x;
	OBJECTS.push({ type: 'torus', name: 'Sky S' + s + ' portal', color: 0xb8f0ff, r: 1.3, tube: 0.16, pos: [X, top + 1.45, z], emissive: 0x49d2ff, emissiveIntensity: 3, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true } });
	OBJECTS.push({ type: 'cylinder', name: 'Sky S' + s + ' portal glow', color: 0xd8f8ff, r: 1.15, h: 0.04, pos: [X, top + 1.45, z], rot: [Math.PI / 2, 0, 0], emissive: 0x7fe4ff, emissiveIntensity: 1.4, opacity: 0.35, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true } });
	OBJECTS.push({ type: 'light', name: 'Sky S' + s + ' portal light', kind: 'point', color: 0x7fe4ff, intensity: 6, distance: 8, pos: [X, top + 1.5, z + 0.8] });
	MOVERS.push({ name: 'Sky S' + s + ' portal', data: { kind: 'spin', axis: 'y', distance: 0, period: 6, phase: 0, dir: 1 } });
}

// ---- STAGE 1: Cloud Steps — gentle steps, one moving platform ---------------------------
plat(1, 'Sky S1 start', 0, 12, 0, 6, 6);
plat(1, 'Sky S1 step 1', 0, 12, -5.5, 3, 3);
coin(1, 0, 12, -5.5);
plat(1, 'Sky S1 step 2', 1.2, 12.4, -9.5, 3, 3);
coin(1, 1.2, 12.4, -9.5);
plat(1, 'Sky S1 step 3', -0.8, 12.8, -13.5, 3, 3);
plat(1, 'Sky S1 rest', 0, 13, -18.5, 4, 4);
flag(1, 1, 0, 13, -18.5);
plat(1, 'Sky S1 slider', 0, 13, -23.5, 3, 3, { move: { kind: 'slide', axis: 'x', distance: 3, period: 6, phase: 0 } });
coin(1, 0, 13, -23.5);
plat(1, 'Sky S1 step 4', 0, 13.4, -28, 3, 3);
coin(1, 0, 13.4, -28);
plat(1, 'Sky S1 finish', 0, 13.8, -33.5, 5, 5);
coin(1, -1.6, 13.8, -32.2);
portal(1, 0, 13.8, -34.6);

// ---- STAGE 2: Spin Cycle — sweeping arms and vanishing tiles ----------------------------
plat(2, 'Sky S2 start', 0, 12, 0, 6, 6);
plat(2, 'Sky S2 bridge', 0, 12, -7, 4, 8);
spinner(2, 1, 0, 12, -7, 7, 3.6, 1);
coin(2, 1.2, 12, -9.5);
for (let i = 0; i < 4; i++) {
	plat(2, 'Sky S2 tile ' + (i + 1), 0, 12, -13.5 - i * 3, 2.6, 2.6, { color: 0xfff0b0, emissive: 0xffd060, glow: 0.25, move: { kind: 'blink', axis: 'y', distance: 0, period: 5, phase: i * 1.0 } });
}
coin(2, 0, 12, -19.5);
plat(2, 'Sky S2 rest', 0, 12.5, -27, 4, 4);
flag(2, 1, 0, 12.5, -27);
plat(2, 'Sky S2 arena', 0, 12.5, -33.5, 5, 6);
spinner(2, 2, 0, 12.5, -33.5, 5, 2.8, -1);
coin(2, -1.6, 12.5, -32);
plat(2, 'Sky S2 slider', 0, 13, -39.5, 3, 3, { move: { kind: 'slide', axis: 'x', distance: 4, period: 5, phase: 1 } });
coin(2, 0, 13, -39.5);
plat(2, 'Sky S2 finish', 0, 13.4, -45, 5, 5);
coin(2, 1.6, 13.4, -43.6);
portal(2, 0, 13.4, -46.1);

// ---- STAGE 3: Sky Gauntlet — a climb, tiles, a slider and a double sweep -----------------
plat(3, 'Sky S3 start', 0, 14, 0, 6, 6);
plat(3, 'Sky S3 stair 1', 0, 14.5, -5, 2.6, 2.6);
plat(3, 'Sky S3 stair 2', 1.6, 15, -8.5, 2.6, 2.6);
coin(3, 1.6, 15, -8.5);
plat(3, 'Sky S3 stair 3', 0, 15.5, -12, 2.6, 2.6);
plat(3, 'Sky S3 stair 4', -1.6, 16, -15.5, 2.6, 2.6);
coin(3, -1.6, 16, -15.5);
plat(3, 'Sky S3 rest 1', 0, 16, -20, 4, 4);
flag(3, 1, 0, 16, -20);
for (let i = 0; i < 3; i++) {
	plat(3, 'Sky S3 tile ' + (i + 1), 0, 16, -24.5 - i * 3, 2.6, 2.6, { color: 0xfff0b0, emissive: 0xffd060, glow: 0.25, move: { kind: 'blink', axis: 'y', distance: 0, period: 4.4, phase: i * 1.1 } });
}
coin(3, 0, 16, -27.5);
plat(3, 'Sky S3 slider', 0, 16.5, -35, 3, 3, { move: { kind: 'slide', axis: 'x', distance: 5, period: 6, phase: 2 } });
coin(3, 0, 16.5, -35);
plat(3, 'Sky S3 rest 2', 0, 17, -40, 4, 4);
flag(3, 2, 0, 17, -40);
plat(3, 'Sky S3 gauntlet', 0, 17, -46.5, 4, 7);
spinner(3, 1, 0, 17, -45, 4.5, 3, 1);
spinner(3, 2, 0, 17, -48.2, 4.5, 2.6, -1);
coin(3, 1.4, 17, -46.6);
plat(3, 'Sky S3 finish', 0, 17.5, -54, 5, 5);
coin(3, -1.6, 17.5, -52.6);
coin(3, 1.6, 17.5, -52.6);
portal(3, 0, 17.5, -55.1);

// ---- the sky dressing: the clouds are the GROUND — a white sea far below that the fog
// fades into the horizon (an earlier pass of sphere clouds read as snowballs) ----------------

function skyGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	N('click', 'gamesound', 'Button click', 760, 40, { sound: 'click' });
	// ---- the start menu: a stage button selects the stage AND starts the round ------------
	for (let s = 1; s <= 3; s++) {
		const y = 40 + (s - 1) * 120;
		N('b' + s, 'hudbutton', 'Stage ' + s + ' button', 40, y, { element: 'stage-' + s });
		N('sel' + s, 'kit-levels-select', 'Go to stage ' + s, 280, y, { level: String(s) });
		N('go' + s, 'kit-round-start', 'Start (stage ' + s + ')', 520, y, {});
		E('b' + s, 'sel' + s, 'trigger');
		E('b' + s, 'go' + s, 'trigger');
		E('b' + s, 'click', 'trigger');
	}
	// ---- results: Retry / Next stage / Menu -----------------------------------------------
	N('bretry', 'hudbutton', 'Retry button', 40, 420, { element: 'retry-btn' });
	N('retry', 'kit-round-restart', 'Retry the stage', 280, 420, {});
	E('bretry', 'retry', 'trigger');
	E('bretry', 'click', 'trigger');
	N('bnext', 'hudbutton', 'Next stage button', 40, 500, { element: 'next-btn' });
	N('next', 'kit-levels-next', 'Next stage', 280, 500, {});
	E('bnext', 'next', 'trigger');
	E('bnext', 'click', 'trigger');
	N('bmenu', 'hudbutton', 'Menu button', 40, 580, { element: 'menu-btn' });
	N('tomenu', 'kit-round-toMenu', 'Back to menu', 280, 580, {});
	E('bmenu', 'tomenu', 'trigger');
	E('bmenu', 'click', 'trigger');
	// ---- the player: walk + jump, and the music ---------------------------------------------
	N('body', 'charcontroller', 'Player: walk + jump', 40, 700, { mode: 'walk', speed: 0.07, jumpHeight: 1.3, eyeHeight: 1.7, gravity: true });
	N('music', 'gamemusic', 'Sky music', 280, 700, { preset: 'arcade', volume: 0.35, while: 'always' });
	// ---- the HUD words ------------------------------------------------------------------------
	const text = (id, read, element, x, y, extra = {}) => {
		N(id + 'i', 'skyruninfo', 'Sky Run: ' + read, x, y, { read, ...extra });
		N(id + 't', 'hudtext', 'HUD ' + element, x + 240, y, { element, format: '', decimals: 0, value: 0 });
		E(id + 'i', id + 't', 'format');
	};
	text('title', 'title', 'sr-title', 800, 200);
	text('clock', 'clock', 'sr-clock', 800, 270);
	text('coins', 'coins', 'sr-coins', 800, 340);
	text('cp', 'checkpoint', 'sr-cp', 800, 410);
	text('best', 'best', 'sr-best', 800, 480);
	text('count', 'countdown', 'sr-count', 800, 550);
	text('res', 'result', 'sr-result', 800, 620);
	text('resl', 'resultLine', 'sr-line', 800, 690);
	for (let s = 1; s <= 3; s++) text('sb' + s, 'stageBest', 'stage-' + s + '-best', 800, 760 + (s - 1) * 70, { level: String(s) });
	// ---- every moving thing: a mover effect on its object -----------------------------------
	MOVERS.forEach((m, i) => {
		const y = 40 + i * 70;
		N('mv' + i, 'skyrunmove', 'Move: ' + m.name, 1400, y, m.data);
		N('mvs' + i, 'objectselector', m.name, 1640, y, { selected: m.name });
		E('mv' + i, 'mvs' + i);
	});
	return g.done();
}

const stageCell = (s) => {
	const x = -200 + (s - 1) * 200;
	return [
		{ id: 'stage-' + s, kind: 'button', anchor: 'center', x, y: 30, w: 180, h: 56, z: 1, label: s + ' · ' + STAGE_NAMES[s - 1], enabled: true, style: { ...BTN, size: 16 } },
		{ id: 'stage-' + s + '-best', kind: 'text', anchor: 'center', x, y: 74, w: 180, h: 20, z: 1, label: '', style: { size: 13, weight: '600', color: '#ffd45e', align: 'center' } }
	];
};

const SKY_RUN_DEF = {
	kind: 'game',
	slug: 'sky-run',
	title: 'Sky Run',
	description:
		'A floating obstacle course in the clouds: three stages of jumps, moving platforms, vanishing tiles and spinning arms. Flags save your spot, coins and par times earn stars, and your best time is kept on this device.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['platformer', 'obby', 'parkour', 'co-op', 'vr'],
	modules: [],
	env: {
		preset: 'daylight',
		exposure: 1.1,
		background: { top: '#3d8fe0', bottom: '#e8f4ff' },
		fog: { color: '#eef6ff', near: 30, far: 110 },
		ground: { color: '#ffffff', roughness: 1 }
	},
	physics: {
		ground: { enabled: false, height: -30, friction: 0.8, restitution: 0 },
		bounds: { limit: -30, action: 'respawn' },
		material: { friction: 0.8, restitution: 0.02 },
		damping: { linear: 0.05, angular: 0.3 },
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [0, 12.05, 1.8], yaw: 0 }, reach: 1.3 }
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.7, luminanceThreshold: 0.82 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [14, 22, 14], target: [0, 12.5, -16] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: skyGraph() },
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
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 10, w: 660, h: 400, z: 0, label: '', style: PANEL },
						{ id: 'menu-title', kind: 'text', anchor: 'center', x: 0, y: -146, w: 560, h: 52, z: 1, label: 'SKY RUN', style: { size: 42, weight: '800', color: '#9ee6ff', align: 'center' } },
						{ id: 'menu-sub', kind: 'text', anchor: 'center', x: 0, y: -92, w: 600, h: 44, z: 1, label: 'Jump from platform to platform to the portal. Touch a flag to save your spot — fall, or get swept by a spinner, and you go back to it. Grab the coins and beat the par time for three stars.', style: { size: 13, color: '#d8dee9', align: 'center' }, wrap: true },
						{ id: 'menu-pick', kind: 'text', anchor: 'center', x: 0, y: -26, w: 400, h: 22, z: 1, label: 'Pick a stage', style: { size: 15, weight: '600', color: '#ffffff', align: 'center' } },
						...[1, 2, 3].flatMap(stageCell),
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 132, w: 600, h: 34, z: 1, label: 'Desktop: WASD walk · Space jumps · mouse looks · Esc for the menu', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true },
						{ id: 'menu-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 160, w: 600, h: 34, z: 1, label: 'VR: left stick walks · A jumps · X for the menu (Comfort vignette in Settings)', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'sr-hud-panel', kind: 'panel', anchor: 'top-center', x: 0, y: 8, w: 420, h: 84, z: 0, label: '', style: { bg: 'rgba(12, 22, 48, 0.55)', radius: 14 } },
						{ id: 'sr-title', kind: 'text', anchor: 'top-center', x: 0, y: 12, w: 400, h: 26, z: 1, label: '', style: { size: 18, weight: '700', color: '#ffffff', align: 'center' } },
						{ id: 'sr-clock', kind: 'text', anchor: 'top-center', x: 0, y: 38, w: 200, h: 30, z: 1, label: '', style: { size: 26, weight: '800', color: '#ffffff', align: 'center' } },
						{ id: 'sr-coins', kind: 'text', anchor: 'top-center', x: -130, y: 68, w: 150, h: 20, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffd45e', align: 'center' } },
						{ id: 'sr-cp', kind: 'text', anchor: 'top-center', x: 0, y: 68, w: 150, h: 20, z: 1, label: '', style: { size: 13, weight: '600', color: '#7dffb0', align: 'center' } },
						{ id: 'sr-best', kind: 'text', anchor: 'top-center', x: 130, y: 68, w: 150, h: 20, z: 1, label: '', style: { size: 13, color: '#d8eeff', align: 'center' } },
						{ id: 'sr-count', kind: 'text', anchor: 'center', x: 0, y: -90, w: 200, h: 90, z: 1, label: '', style: { size: 72, weight: '800', color: '#ffffff', align: 'center' } }
					]
				},
				{
					id: 'over',
					name: 'Results',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 300, z: 0, label: '', style: PANEL },
						{ id: 'sr-result', kind: 'text', anchor: 'center', x: 0, y: -100, w: 440, h: 40, z: 1, label: '', style: { size: 28, weight: '700', color: '#9ee6ff', align: 'center' } },
						{ id: 'sr-line', kind: 'text', anchor: 'center', x: 0, y: -50, w: 440, h: 44, z: 1, label: '', style: { size: 14, color: '#e5e9f0', align: 'center' }, wrap: true },
						{ id: 'next-btn', kind: 'button', anchor: 'center', x: 0, y: 20, w: 240, h: 46, z: 1, label: 'Next stage', enabled: true, style: BTN },
						{ id: 'retry-btn', kind: 'button', anchor: 'center', x: -64, y: 84, w: 116, h: 40, z: 1, label: 'Retry', enabled: true, style: { ...BTN, size: 15, bg: '#4c9e6a' } },
						{ id: 'menu-btn', kind: 'button', anchor: 'center', x: 64, y: 84, w: 116, h: 40, z: 1, label: 'Stages', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the marker that wakes the core `skyrun` module (an empty: no body, no draw)
		{ type: 'empty', name: 'Sky Run game' },
		{ type: 'light', name: 'Sun', kind: 'directional', color: 0xfff4e0, intensity: 2.2, pos: [30, 40, 20], target: [30, 12, -25] },
		...OBJECTS,
		// a crate on stage 1's pad: a dynamic body, so pressing Play starts the simulation
		{ type: 'box', name: 'Sky crate', color: 0xb57a45, size: [0.6, 0.6, 0.6], bevel: 0.04, bevelSegments: 1, pos: [2.2, 12.3, 2.2], roughness: 0.6, physics: { mode: 'dynamic', mass: 1, friction: 0.8 } },
		{ type: 'camera', name: 'Card camera', pos: [12, 19, 8], lookAt: [0, 12.8, -14], fov: 50 }
	]
};

module.exports = SKY_RUN_DEF;
