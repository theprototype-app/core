// Template def `escape-room` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');
const { P, I, AR, H: HALF, piece } = require('./_level-kit.cjs');

// ---- 35-escape-room: THE ALCHEMIST'S ESCAPE ------------------------------------------------
// Three rooms in a row along +x (study -12..-4, workshop -4..4, vault 4..12, the exit beyond):
// drawer -> key -> chest (crank + note) + study door; dials + levers + the crank you TWIST to
// raise the iron gate; three gems on three pedestals open the vault door. The RULES live in the
// core `escape` module (src/modules/escape), which finds every puzzle piece BY NAME — the names
// below are its contract. Doors, gates, gems and handles are SENSORS (every top-level object is a
// fixed body once the sim starts, and a body does not follow a door the module slides open); the
// module keeps the player in the rooms they have opened. The crate is the one dynamic body: a
// level with none starts no simulation, and then the walker collides with nothing.

const PI = Math.PI;
const H = 3.2; // wall height
const T = 0.3; // wall thickness
const STONE = { color: 0x9c8b74, roughness: 0.92 };
const WOOD = { roughness: 0.62, physical: true, sheen: 0.3, sheenColor: 0xffd7a0, sheenRoughness: 0.6 };
const S = { mode: 'static' };
const SENSOR = { mode: 'static', sensor: true };
const BTN = { size: 18, weight: '600', bg: '#a0662c', color: '#fff8ec', radius: 10 };
const PANEL = { bg: 'rgba(24, 16, 10, 0.92)', radius: 18, border: '1px solid rgba(255, 214, 150, 0.35)' };

/** an inner wall at x with a 1.6 m doorway (2.4 m high) at z = 0 @param {string} name @param {number} x */
const innerWall = (name, x) => [
	{ type: 'box', name: name + ' north', size: [T, H, 3.2], pos: [x, H / 2, -2.4], ...STONE, physics: S },
	{ type: 'box', name: name + ' south', size: [T, H, 3.2], pos: [x, H / 2, 2.4], ...STONE, physics: S },
	{ type: 'box', name: name + ' lintel', size: [T, 0.8, 1.6], pos: [x, 2.8, 0], ...STONE, physics: S }
];
/** a hint crystal on a little stand @param {number} n @param {number[]} at */
const crystal = (n, at) => [
	{ type: 'cylinder', name: 'Crystal stand ' + n, r: 0.1, r2: 0.16, h: 1.0, pos: [at[0], 0.5, at[2]], color: 0x3a3f4a, roughness: 0.5, physics: S },
	{ type: 'icosahedron', name: 'Hint crystal ' + n, r: 0.13, pos: [at[0], 1.15, at[2]], color: 0x9ee6ff, emissive: 0x3fb8ff, emissiveIntensity: 2.2, flatShading: true, physics: SENSOR }
];
/** a dial on the workshop's north wall @param {number} n @param {number} x */
const dial = (n, x) => ({
	type: 'group',
	name: 'Dial ' + n,
	pos: [x, 1.35, -3.9],
	rot: [PI / 2, 0, 0],
	physics: SENSOR,
	children: [
		{ type: 'cylinder', name: 'Dial ' + n + ' face', r: 0.17, h: 0.08, pos: [0, 0, 0], color: 0xe0b860, metalness: 0.5, roughness: 0.35, emissive: 0x6a4a10, emissiveIntensity: 0.6 },
		{ type: 'box', name: 'Dial ' + n + ' notch', size: [0.04, 0.06, 0.14], pos: [0, 0.05, -0.09], color: 0xfff4e0, emissive: 0xffffff, emissiveIntensity: 1.4 }
	]
});
/** a lever on the workshop's south wall (pulled = rotated toward the room) @param {string} which @param {number} x */
const lever = (which, x) => ({
	type: 'group',
	name: 'Lever ' + which,
	pos: [x, 1.0, 3.88],
	physics: SENSOR,
	children: [
		{ type: 'cylinder', name: 'Lever ' + which + ' rod', r: 0.03, h: 0.42, pos: [0, 0.21, 0], color: 0x6b6f78, metalness: 0.8, roughness: 0.35 },
		{ type: 'sphere', name: 'Lever ' + which + ' knob', r: 0.065, pos: [0, 0.44, 0], color: which === 'left' ? 0xd04a3a : which === 'middle' ? 0x3aa05a : 0x3a6ad0, roughness: 0.4 }
	]
});
/** a pedestal in the vault @param {string} gem @param {number} x @param {number} color */
const pedestal = (gem, x, color) => [
	{
		type: 'group',
		name: 'Pedestal ' + gem,
		pos: [x, 0, -2.7],
		physics: { mode: 'static', collider: 'cylinder' },
		children: [
			{ type: 'cylinder', name: 'Pedestal ' + gem + ' column', r: 0.22, r2: 0.3, h: 1.0, pos: [0, 0.5, 0], color: 0x9a96a8, roughness: 0.5 },
			{ type: 'cylinder', name: 'Pedestal ' + gem + ' cap', r: 0.27, h: 0.06, pos: [0, 1.03, 0], color, emissive: color, emissiveIntensity: 0.9 }
		]
	},
	{ type: 'dodecahedron', name: 'Placed ' + gem, r: 0.13, pos: [x, 1.2, -2.7], color, emissive: color, emissiveIntensity: 2, flatShading: true, physics: SENSOR }
];

function escapeGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	N('click', 'gamesound', 'Button click', 520, 40, { sound: 'click' });
	const button = (id, element, label, state, x, y) => {
		N(id, 'hudbutton', label, x, y, { element });
		N(id + 's', 'setgamestate', label + ' -> ' + state, x + 260, y, { state, outcome: '' });
		E(id, id + 's', 'trigger');
		E(id, 'click', 'trigger');
	};
	button('bstart', 'start-btn', 'Start button', 'playing', 40, 40);
	button('bagain', 'again-btn', 'Play again button', 'playing', 40, 120);
	button('bmenu', 'menu-btn', 'Menu button', 'menu', 40, 200);
	const text = (id, read, element, x, y) => {
		N(id + 'i', 'escapeinfo', 'Escape: ' + read, x, y, { read });
		N(id + 't', 'hudtext', 'HUD ' + element, x + 240, y, { element, format: '', decimals: 0, value: 0 });
		E(id + 'i', id + 't', 'format');
	};
	text('room', 'room', 'es-room', 800, 40);
	text('clock', 'clock', 'es-clock', 800, 110);
	text('inv', 'inventory', 'es-inv', 800, 180);
	text('gems', 'gems', 'es-gems', 800, 250);
	text('goal', 'goal', 'es-goal', 800, 320);
	text('res', 'result', 'es-result', 800, 390);
	text('best', 'best', 'es-best', 800, 460);
	text('mbest', 'menuBest', 'menu-best', 800, 530);
	// walk with gravity (desktop WASD, VR stick); no jumping over a locked door
	N('body', 'charcontroller', 'Player: walk', 40, 320, { mode: 'walk', speed: 0.05, jumpHeight: 0, eyeHeight: 1.65, gravity: true });
	return g.done();
}

const ESCAPE_DEF = {
	kind: 'game',
	slug: 'escape-room',
	title: "The Alchemist's Escape",
	description:
		"An escape game in three rooms: open the drawer, find the key, unlock the chest, set the dials, pull the levers in the right order and TWIST the crank to raise the gate — then put three gems on their pedestals and get out. Hints after a minute; your best time is saved.",
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['puzzle', 'escape room', 'quest', 'co-op', 'vr'],
	modules: [],
	env: {
		preset: 'custom',
		base: 'studio',
		exposure: 1.1,
		background: { top: '#140d08', bottom: '#2a1c12' },
		fog: null,
		sun: null,
		hemi: { sky: '#ffe2bd', ground: '#4a3a2c', intensity: 1.1 }
	},
	physics: {
		ground: { enabled: true, height: 0, friction: 0.9, restitution: 0 },
		bounds: { limit: -10, action: 'respawn' },
		play: {
			interaction: 'grab',
			grounded: true,
			simOnPlay: true,
			spawn: { position: [-8, 0, 2.6], yaw: 0 },
			locomotion: { teleport: true },
			bounds: { min: [-11.8, -1, -3.8], max: [14, 4, 3.8] }
		}
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.8, luminanceThreshold: 0.75 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [-6.2, 2.4, 3.6], target: [-9.2, 0.8, -2.2] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: escapeGraph() },
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
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 600, h: 420, z: 0, label: '', style: PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -150, w: 560, h: 50, z: 1, label: "THE ALCHEMIST'S ESCAPE", style: { size: 34, weight: '700', color: '#ffd9a0', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -88, w: 520, h: 60, z: 1, label: "Locked in the alchemist's house. Search three rooms, open what is shut, twist what turns, and find the three gems that open the vault.", style: { size: 14, color: '#e8dccb', align: 'center' }, wrap: true },
						{ id: 'menu-best', kind: 'text', anchor: 'center', x: 0, y: -36, w: 480, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#9ee6ff', align: 'center' } },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: 30, w: 260, h: 54, z: 1, label: 'Start', enabled: true, style: { ...BTN, size: 22 } },
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 112, w: 540, h: 36, z: 1, label: 'Desktop: WASD walk · mouse looks · click to use · H hint · Esc menu', style: { size: 12, color: '#a89a88', align: 'center' }, wrap: true },
						{ id: 'menu-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 146, w: 540, h: 36, z: 1, label: 'VR: point and pull the trigger to use · stick walks or teleports', style: { size: 12, color: '#a89a88', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'es-room', kind: 'text', anchor: 'top-left', x: 18, y: 14, w: 260, h: 28, z: 1, label: '', style: { size: 20, weight: '700', color: '#ffd9a0', align: 'left' } },
						{ id: 'es-gems', kind: 'text', anchor: 'top-left', x: 18, y: 44, w: 260, h: 20, z: 1, label: '', style: { size: 14, weight: '600', color: '#d6b8ff', align: 'left' } },
						{ id: 'es-clock', kind: 'text', anchor: 'top-right', x: 18, y: 58, w: 120, h: 28, z: 1, label: '', style: { size: 22, weight: '700', color: '#f3eadc', align: 'right' } },
						{ id: 'es-inv', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 520, h: 22, z: 1, label: '', style: { size: 15, weight: '600', color: '#f3eadc', align: 'center', bg: 'rgba(24,16,10,0.55)', radius: 8 } },
						{ id: 'es-goal', kind: 'text', anchor: 'bottom-center', x: 0, y: 18, w: 640, h: 22, z: 1, label: '', style: { size: 14, color: '#ffe6c0', align: 'center' } }
					]
				},
				{
					id: 'over',
					name: 'Escaped',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 320, z: 0, label: '', style: PANEL },
						{ id: 'over-title', kind: 'text', anchor: 'center', x: 0, y: -110, w: 440, h: 44, z: 1, label: 'YOU ESCAPED!', style: { size: 32, weight: '700', color: '#7dffb0', align: 'center' } },
						{ id: 'es-result', kind: 'text', anchor: 'center', x: 0, y: -56, w: 440, h: 28, z: 1, label: '', style: { size: 20, weight: '600', color: '#ffd9a0', align: 'center' } },
						{ id: 'es-best', kind: 'text', anchor: 'center', x: 0, y: -20, w: 440, h: 22, z: 1, label: '', style: { size: 14, color: '#9ee6ff', align: 'center' } },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: 0, y: 46, w: 240, h: 48, z: 1, label: 'Play again', enabled: true, style: BTN },
						{ id: 'menu-btn', kind: 'button', anchor: 'center', x: 0, y: 108, w: 240, h: 40, z: 1, label: 'Main menu', enabled: true, style: { size: 15, weight: '500', bg: '#3a3028', color: '#f3eadc', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the marker that wakes the core `escape` module
		{ type: 'empty', name: 'Escape game' },
		// ---- the shell: three floors, a ceiling, the outer walls, two inner walls with doorways
		{ type: 'box', name: 'Study floor', size: [8, 0.2, 8], pos: [-8, -0.1, 0], color: 0x6b4a30, ...WOOD, physics: S },
		{ type: 'box', name: 'Workshop floor', size: [8, 0.2, 8], pos: [0, -0.1, 0], color: 0x585350, roughness: 0.9, physics: S },
		{ type: 'box', name: 'Vault floor', size: [8, 0.2, 8], pos: [8, -0.1, 0], color: 0x4a4458, roughness: 0.35, physical: true, clearcoat: 0.5, physics: S },
		{ type: 'box', name: 'Exit floor', size: [2.4, 0.2, 2], pos: [13.3, -0.1, 0], color: 0x2a4a38, emissive: 0x1a6a40, emissiveIntensity: 0.5, physics: S },
		{ type: 'box', name: 'Ceiling', size: [24.6, 0.2, 8.6], pos: [0, H + 0.1, 0], color: 0x3a2e24, roughness: 0.95, shadow: false, physics: S },
		{ type: 'box', name: 'Wall north', size: [24.6, H, T], pos: [0, H / 2, -4.15], ...STONE, physics: S },
		{ type: 'box', name: 'Wall south', size: [24.6, H, T], pos: [0, H / 2, 4.15], ...STONE, physics: S },
		{ type: 'box', name: 'Wall west', size: [T, H, 8.6], pos: [-12.15, H / 2, 0], ...STONE, physics: S },
		{ type: 'box', name: 'Wall east north', size: [T, H, 3.4], pos: [12.15, H / 2, -2.5], ...STONE, physics: S },
		{ type: 'box', name: 'Wall east south', size: [T, H, 3.4], pos: [12.15, H / 2, 2.5], ...STONE, physics: S },
		{ type: 'box', name: 'Wall east lintel', size: [T, 0.8, 1.6], pos: [12.15, 2.8, 0], ...STONE, physics: S },
		{ type: 'box', name: 'Exit wall', size: [T, H, 2.4], pos: [14.5, H / 2, 0], color: 0x24382c, roughness: 0.9, physics: S },
		...innerWall('Study wall', -4),
		...innerWall('Gate wall', 4),
		// ---- the three doors (SENSORS: the module slides them, a body would stay behind)
		{ type: 'box', name: 'Study door', size: [0.12, 2.4, 1.6], pos: [-4, 1.2, 0], color: 0x6a3d1e, ...WOOD, physics: SENSOR },
		{
			type: 'group',
			name: 'Workshop gate',
			pos: [4, 1.2, 0],
			physics: SENSOR,
			children: [
				...[-0.64, -0.32, 0, 0.32, 0.64].map((z, i) => ({ type: 'cylinder', name: 'Gate bar ' + i, r: 0.035, h: 2.4, pos: [0, 0, z], color: 0x3c3f46, metalness: 0.85, roughness: 0.4 })),
				{ type: 'box', name: 'Gate rail top', size: [0.08, 0.08, 1.6], pos: [0, 0.9, 0], color: 0x3c3f46, metalness: 0.85, roughness: 0.4 },
				{ type: 'box', name: 'Gate rail low', size: [0.08, 0.08, 1.6], pos: [0, -0.9, 0], color: 0x3c3f46, metalness: 0.85, roughness: 0.4 }
			]
		},
		{ type: 'box', name: 'Vault door', size: [0.14, 2.4, 1.6], pos: [12.15, 1.2, 0], color: 0x5f6a78, metalness: 0.75, roughness: 0.35, physics: SENSOR },
		{ type: 'torus', name: 'Exit portal', r: 0.8, tube: 0.06, pos: [13.4, 1.3, 0], rot: [0, PI / 2, 0], color: 0xb8ffd8, emissive: 0x3fff9a, emissiveIntensity: 2.6, shadow: false, physics: SENSOR },
		// ---- ROOM 1: the study
		{ type: 'box', name: 'Desk', size: [1.6, 0.76, 0.7], pos: [-9, 0.38, -3.6], color: 0x5a3820, ...WOOD, physics: S },
		{ type: 'box', name: 'Desk drawer', size: [0.7, 0.2, 0.06], pos: [-9, 0.52, -3.23], color: 0x8a5a32, ...WOOD, physics: SENSOR },
		{ type: 'sphere', name: 'Drawer knob', r: 0.035, pos: [-9, 0.52, -3.18], color: 0xd8b060, metalness: 0.8, roughness: 0.3, physics: SENSOR },
		{
			type: 'group',
			name: 'Brass key',
			pos: [-9, 0.66, -3.2],
			physics: SENSOR,
			children: [
				{ type: 'torus', name: 'Key bow', r: 0.05, tube: 0.014, pos: [-0.1, 0, 0], rot: [PI / 2, 0, 0], color: 0xffcc55, metalness: 0.9, roughness: 0.25, emissive: 0xaa7700, emissiveIntensity: 0.6 },
				{ type: 'box', name: 'Key shaft', size: [0.16, 0.02, 0.02], pos: [0.02, 0, 0], color: 0xffcc55, metalness: 0.9, roughness: 0.25, emissive: 0xaa7700, emissiveIntensity: 0.6 },
				{ type: 'box', name: 'Key bit', size: [0.03, 0.02, 0.05], pos: [0.09, 0, 0.025], color: 0xffcc55, metalness: 0.9, roughness: 0.25 }
			]
		},
		{ type: 'plane', name: 'Old note', size: [0.3, 0.4], pos: [-8.45, 0.77, -3.55], rot: [-PI / 2, 0, 0.25], color: 0xf0e2c0, roughness: 0.95, side: 'double', physics: SENSOR },
		{ type: 'cylinder', name: 'Candle', r: 0.035, h: 0.18, pos: [-9.6, 0.85, -3.6], color: 0xf4ead8, emissive: 0xffc070, emissiveIntensity: 0.4, physics: SENSOR },
		{ type: 'box', name: 'Chest body', size: [0.9, 0.5, 0.55], pos: [-10.9, 0.25, -1.4], color: 0x4a2e18, ...WOOD, physics: S },
		{
			type: 'group',
			name: 'Chest lid',
			pos: [-10.9, 0.5, -1.675],
			physics: SENSOR,
			children: [
				{ type: 'box', name: 'Chest lid board', size: [0.92, 0.12, 0.57], pos: [0, 0.06, 0.285], color: 0x5a3820, ...WOOD },
				{ type: 'box', name: 'Chest lid band', size: [0.94, 0.13, 0.06], pos: [0, 0.06, 0.285], color: 0xb08a40, metalness: 0.8, roughness: 0.35 },
				{ type: 'box', name: 'Chest lock', size: [0.1, 0.1, 0.03], pos: [0, -0.02, 0.58], color: 0xd8b060, metalness: 0.85, roughness: 0.3 }
			]
		},
		{
			type: 'group',
			name: 'Crank',
			pos: [-10.9, 0.56, -1.4],
			physics: SENSOR,
			children: [
				{ type: 'cylinder', name: 'Crank shaft', r: 0.025, h: 0.3, pos: [0, 0, 0], rot: [0, 0, PI / 2], color: 0x8a8f99, metalness: 0.9, roughness: 0.35 },
				{ type: 'box', name: 'Crank arm', size: [0.04, 0.04, 0.26], pos: [0.15, 0, 0.11], color: 0x8a8f99, metalness: 0.9, roughness: 0.35 },
				{ type: 'cylinder', name: 'Crank grip', r: 0.03, h: 0.12, pos: [0.21, 0, 0.22], rot: [0, 0, PI / 2], color: 0x6a3d1e, roughness: 0.6 }
			]
		},
		{ type: 'box', name: 'Gem shelf', size: [1.2, 0.06, 0.32], pos: [-6.4, 1.5, -3.83], color: 0x5a3820, ...WOOD, physics: S },
		{ type: 'box', name: 'Book row', size: [0.7, 0.28, 0.24], pos: [-6.7, 1.67, -3.86], color: 0x7a2a22, roughness: 0.8, physics: S },
		{ type: 'dodecahedron', name: 'Sun gem', r: 0.12, pos: [-6.0, 1.66, -3.8], color: 0xffcf4a, emissive: 0xffa520, emissiveIntensity: 2.2, flatShading: true, physics: SENSOR },
		{ type: 'box', name: 'Rug', size: [3, 0.02, 2], pos: [-8, 0.01, 0.5], color: 0x7a2e2a, roughness: 1, shadow: false, physics: SENSOR },
		...crystal(1, [-11.4, 0, 3.4]),
		// ONE lamp (the lights budget is two): the module carries it into the room you stand in
		{ type: 'light', name: 'Room lamp', kind: 'point', color: 0xffc890, intensity: 14, distance: 12, decay: 1.2, pos: [-8, 2.8, 0] },
		// ---- ROOM 2: the workshop
		{ type: 'box', name: 'Dial panel', size: [1.6, 0.8, 0.06], pos: [-1.2, 1.35, -3.97], color: 0x7a5636, metalness: 0.3, roughness: 0.6, physics: S },
		...[-1.7, -1.2, -0.7].map((x, i) => ({ type: 'cone', name: 'Dial mark ' + (i + 1), r: 0.035, h: 0.06, pos: [x, 1.6, -3.92], rot: [PI, 0, 0], color: 0xfff4e0, emissive: 0xffe0a0, emissiveIntensity: 1, physics: SENSOR })),
		dial(1, -1.7),
		dial(2, -1.2),
		dial(3, -0.7),
		{ type: 'box', name: 'Hatch niche', size: [0.56, 0.46, 0.08], pos: [0.5, 1.4, -3.97], color: 0x101010, roughness: 1, physics: S },
		{ type: 'icosahedron', name: 'Moon gem', r: 0.12, pos: [0.5, 1.4, -3.88], color: 0xd8ecff, emissive: 0x88c8ff, emissiveIntensity: 2.2, flatShading: true, physics: SENSOR },
		{ type: 'box', name: 'Dial hatch', size: [0.52, 0.42, 0.04], pos: [0.5, 1.4, -3.8], color: 0x6b5a48, metalness: 0.5, roughness: 0.5, physics: SENSOR },
		{ type: 'box', name: 'Lever plate', size: [1.6, 0.6, 0.06], pos: [-0.5, 1.2, 3.97], color: 0x7a5636, metalness: 0.3, roughness: 0.6, physics: S },
		lever('left', 0),
		lever('middle', -0.5),
		lever('right', -1.0),
		{ type: 'box', name: 'Star tray', size: [0.5, 0.08, 0.34], pos: [1.3, 0.9, 3.82], color: 0x8a8f99, metalness: 0.6, roughness: 0.4, physics: S },
		{ type: 'icosahedron', name: 'Star gem', r: 0.13, pos: [1.3, 1.04, 3.82], color: 0xd6b8ff, emissive: 0xa060ff, emissiveIntensity: 2.2, flatShading: true, physics: SENSOR },
		{ type: 'cylinder', name: 'Crank socket', r: 0.13, h: 0.1, pos: [3.82, 1.2, -1.4], rot: [0, 0, PI / 2], color: 0x5a5f68, metalness: 0.8, roughness: 0.35, physics: SENSOR },
		{
			type: 'group',
			name: 'Fitted crank',
			pos: [3.72, 1.2, -1.4],
			physics: SENSOR,
			children: [
				{ type: 'cylinder', name: 'Fitted shaft', r: 0.025, h: 0.2, pos: [-0.06, 0, 0], rot: [0, 0, PI / 2], color: 0x8a8f99, metalness: 0.9, roughness: 0.35 },
				{ type: 'box', name: 'Fitted arm', size: [0.04, 0.3, 0.04], pos: [-0.16, 0.13, 0], color: 0x8a8f99, metalness: 0.9, roughness: 0.35 },
				{ type: 'cylinder', name: 'Fitted grip', r: 0.03, h: 0.14, pos: [-0.22, 0.27, 0], rot: [0, 0, PI / 2], color: 0x6a3d1e, roughness: 0.6 }
			]
		},
		{ type: 'box', name: 'Crate', size: [0.6, 0.6, 0.6], bevel: 0.03, bevelSegments: 1, pos: [2.6, 0.3, 2.9], color: 0x8a6438, ...WOOD, physics: { mode: 'dynamic', mass: 3, friction: 0.9 } },
		...crystal(2, [-3.4, 0, 3.4]),
		// ---- ROOM 3: the vault
		...pedestal('sun', 6.5, 0xffb830),
		...pedestal('moon', 8, 0x88c8ff),
		...pedestal('star', 9.5, 0xa060ff),
		...crystal(3, [5, 0, 3.4]),
		// ---- pack dressing (references, refilled from the pack CDN)
		piece(P, 'Bookcase', 'Study bookcase', [-11.72, 0, 1.6], HALF),
		piece(I, 'Armchair', 'Study armchair', [-10.3, 0, 0.2], PI * 0.6),
		piece(P, 'WallTorch', 'Study torch', [-8, 1.6, 3.98], PI, { physics: SENSOR }),
		piece(AR, 'AlchemyTable', 'Alchemist table', [2.2, 0, -3.43]),
		piece(AR, 'PotionShelf', 'Potion shelf', [-3.7, 0, -2.6], HALF),
		piece(P, 'WallTorch', 'Workshop torch', [-2.6, 1.6, -3.98], 0, { physics: SENSOR }),
		piece(AR, 'RuneRug', 'Vault rug', [8, 0, 0.4], 0, { physics: SENSOR }),
		piece(AR, 'Armillary', 'Vault armillary', [10.8, 0, 2.8], 0.4),
		piece(P, 'WallTorch', 'Vault torch', [8, 1.6, 3.98], PI, { physics: SENSOR }),
		// the card: from the study's door corner over the desk, chest and shelf
		{ type: 'camera', name: 'Card camera', pos: [-5.6, 2.2, 3.2], lookAt: [-9.4, 0.7, -2.4], fov: 55 }
	]
};

module.exports = ESCAPE_DEF;
