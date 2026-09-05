// Author the bundled seed templates (static/templates/) and the content for the
// theprototype-app/scenes repo from a REAL app: each template is built from
// primitives in the live scene, exported through the actual .tpscene path
// (buildSessionPayload + exportSessionZip), and gets a fitted offscreen thumbnail
// (the sessions.js renderSceneThumbnail approach at 480x270).
//
//   npx vite dev --port 5174
//   APP_URL=http://localhost:5174/ node scripts/author-templates.cjs [--out <scenes-repo-dir>]
//
// A def may be kind:'template' | 'example' | 'game'. A GAME carries the scene data a
// playable scene needs on top of its objects — flow `graphs`, an `env` preset,
// `gravity`, `hud`, `post`, `shaders` — plus the `modules` it needs and its `tags`.
// Games are written under games/ and are NEVER part of the bundled seed: a game needs a
// module download anyway, so a bundled offline game would be a broken promise.
//
// A game def may name `installModules: ['<id>']`, in which case the script installs
// those zips from the sibling theprototype.app-modules checkout BEFORE building the
// scene and runs `generate` (a command or an api action) so the thumbnail shows the
// game rather than a grey box.
//
// Without --out only static/templates/ is (re)written, with TEMPLATE kinds only
// (examples are curated remote content by definition — the bundled fallback keeps
// examples: []). With --out the full templates/ + examples/ tree and a
// repo-relative index.json are written for the scenes repo working copy.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.APP_URL || 'https://localhost:5174/';
// C5.3: game thumbnails need the game's own module loaded. Reuse the packed zips from
// the sibling modules checkout rather than reimplementing the manager drive (the
// tests/e2e helpers.cjs installModule approach). B8: the sibling is `modules` on some
// checkouts and `theprototype.app-modules` on others, and a lane worktree sits one
// directory deeper — so probe both names and let MODULES_REPO in the env win outright.
const MODULES_REPO =
	process.env.MODULES_REPO ||
	[
		path.resolve(__dirname, '../../theprototype.app-modules'),
		path.resolve(__dirname, '../../modules')
	].find((p) => fs.existsSync(p)) ||
	path.resolve(__dirname, '../../theprototype.app-modules');
function moduleZipPath(id) {
	return path.join(MODULES_REPO, id + '.zip');
}
const STATIC_OUT = path.join(__dirname, '../static/templates');
const outFlag = process.argv.indexOf('--out');
const REPO_OUT = outFlag !== -1 ? path.resolve(process.argv[outFlag + 1]) : null;
// B8: `--only <slug[,slug]>` rebuilds a subset. The bundled seed is SKIPPED in that
// mode (a partial DEFS run must not overwrite the seed index with a partial one), and
// the --out index MERGES into the file already there instead of rebuilding it, so the
// rows this run did not author survive verbatim.
const onlyFlag = process.argv.indexOf('--only');
const ONLY =
	onlyFlag !== -1
		? String(process.argv[onlyFlag + 1] ?? '')
				.split(',')
				.filter(Boolean)
		: null;

// ---- declarative scene definitions ------------------------------------------
// objects: {type:'box'|'cylinder'|'sphere'|'cone', name, color, pos, rot?, ...dims,
//           physics?} — physics = the userData.physics schema
//           {mode:'static'|'dynamic', mass, restitution, friction}.
const gray = { floor: 0x8b939c, block: 0xaab2bd, wall: 0x99a3ae, accent: 0xd97706 };

// ---- B8: Towers, the first GAME def -------------------------------------------
// A DATA-ONLY game: core nodes + a HUD document + the collectible module. Rebuilt
// from the first playthrough's findings — the clever sensor-conveyor spawner cascaded
// once you grabbed a crate (spawn -> falls into the zone -> jitters out -> spawns
// again), the emissive shader docs read "strange", and the night look was black on the
// user's display. So: crates are PRE-PLACED dynamic objects (grabbable, stable, no
// churn — the plan's own "Towers pre-places crates"); the look is a lit preset plus
// material emissive, no shader graphs; every node carries a label; and a pause menu
// (P) gives a Restart-while-playing button.
function towersGraph() {
	/** @type {any[]} */ const nodes = [];
	/** @type {any[]} */ const edges = [];
	/** every node gets a LABEL — a programmatic node with none renders a blank card.
	 * @param {string} id @param {string} type @param {string} label @param {number} x @param {number} y @param {any} data */
	const N = (id, type, label, x, y, data) => {
		nodes.push({ id, type, position: { x, y }, data: { label, ...data }, class: 'w-[150px]' });
		return id;
	};
	// the editor's canonical edge id (hudActions.makeEdge) — peer dedupe depends on it
	/** @param {string} source @param {string} target @param {string} [handle] */
	const E = (source, target, handle) => {
		edges.push({
			id: 'e-' + source + '-' + target + (handle ? '.' + handle : ''),
			source,
			target,
			...(handle ? { targetHandle: handle } : {})
		});
	};

	// ---- round control ---------------------------------------------------------
	// Start from the menu: entering 'playing' from menu BUMPS the round and re-stamps
	// startedAt, which is what clears the perRound latches — `reset:true` would instead
	// call resetGame() and force state back to MENU (it is the Back-to-menu action).
	N('bstart', 'hudbutton', 'Start button', 40, 40, { element: 'start-btn' });
	N('gostart', 'setgamestate', 'Start round', 280, 40, { state: 'playing', outcome: '', reset: false });
	E('bstart', 'gostart', 'trigger');
	N('bagain', 'hudbutton', 'Play again button', 40, 190, { element: 'again-btn' });
	N('gomenu', 'setgamestate', 'Back to menu', 280, 190, { state: 'menu', outcome: '', reset: true });
	E('bagain', 'gomenu', 'trigger');

	// ---- pause / restart while playing (P toggles a menu screen) ---------------
	N('pkey', 'keypress', 'Press P', 40, 340, { code: 'KeyP', edge: 'down', pulse: 0.3 });
	N('pausetoggle', 'hudscreen', 'Toggle pause menu', 280, 340, { screen: 'pause', action: 'toggle' });
	E('pkey', 'pausetoggle', 'trigger');
	N('bresume', 'hudbutton', 'Resume button', 40, 490, { element: 'resume-btn' });
	N('resumehide', 'hudscreen', 'Close pause menu', 280, 490, { screen: 'pause', action: 'hide' });
	E('bresume', 'resumehide', 'trigger');
	// Restart while playing: to bump a FRESH round the state must ENTER 'playing' from
	// elsewhere (setGameState is a no-op when already playing). So restart resets to
	// menu, then a short Delay re-enters playing — that transition bumps the round and
	// clears the latches. The Delay is sourced from the button (whose trigger entry
	// persists), never from a Once (whose rearm would delete the entry it re-derives).
	N('brestart', 'hudbutton', 'Restart button', 40, 640, { element: 'restart-btn' });
	N('restartreset', 'setgamestate', 'Restart: to menu', 280, 640, { state: 'menu', outcome: '', reset: true });
	N('restartdelay', 'delay', 'Restart: wait', 520, 640, { seconds: 0.2, pulse: 0.3 });
	N('restartplay', 'setgamestate', 'Restart: play', 760, 640, { state: 'playing', outcome: '', reset: false });
	N('restarthide', 'hudscreen', 'Close pause on restart', 280, 760, { screen: 'pause', action: 'hide' });
	E('brestart', 'restartreset', 'trigger');
	E('brestart', 'restartdelay', 'trigger');
	E('restartdelay', 'restartplay', 'trigger');
	E('brestart', 'restarthide', 'trigger');
	N('bquit', 'hudbutton', 'Quit to menu button', 40, 790, { element: 'quit-btn' });
	N('doquit', 'setgamestate', 'Quit to menu', 280, 790, { state: 'menu', outcome: '', reset: true });
	N('quithide', 'hudscreen', 'Close pause on quit', 520, 790, { screen: 'pause', action: 'hide' });
	E('bquit', 'doquit', 'trigger');
	E('bquit', 'quithide', 'trigger');

	// ---- height: rung sensors -> perRound latches -> boolean*height -> max -> HUD
	for (let i = 1; i <= 4; i++) {
		const y = 960 + (i - 1) * 150;
		N('enr' + i, 'onenter', 'Reached ' + i + 'm', 40, y, { pulse: 0.3 });
		N('selr' + i, 'objectselector', 'Ring ' + i + 'm', 280, y, { selected: 'Height ring ' + i + 'm' });
		E('enr' + i, 'selr' + i);
		N('lat' + i, 'latch', 'Held ' + i + 'm', 520, y, { initial: false, perRound: true });
		E('enr' + i, 'lat' + i, 'set');
		N('mul' + i, 'math', i + 'm value', 760, y, { op: 'mul', a: 0, b: i });
		E('lat' + i, 'mul' + i, 'a');
	}
	N('mx12', 'math', 'Max 1-2m', 1000, 1000, { op: 'max', a: 0, b: 0 });
	E('mul1', 'mx12', 'a');
	E('mul2', 'mx12', 'b');
	N('mx34', 'math', 'Max 3-4m', 1000, 1200, { op: 'max', a: 0, b: 0 });
	E('mul3', 'mx34', 'a');
	E('mul4', 'mx34', 'b');
	N('mxall', 'math', 'Best height', 1240, 1100, { op: 'max', a: 0, b: 0 });
	E('mx12', 'mxall', 'a');
	E('mx34', 'mxall', 'b');
	N('hheight', 'hudtext', 'HUD height', 1480, 1030, { element: 'height-read', format: 'Best height: {v} m', decimals: 0, value: 0 });
	E('mxall', 'hheight', 'value');
	N('hfinal', 'hudtext', 'HUD final height', 1480, 1180, { element: 'final-height', format: 'Your best tower: {v} m', decimals: 0, value: 0 });
	E('mxall', 'hfinal', 'value');
	// reaching the top rung earns a sparkle burst on the pad
	N('pfx', 'particle', '4m sparkle', 1000, 1400, {
		mode: 'burst', count: 120, lifetime: 1.4, speed: 2.5, gravity: 0,
		turbulence: 0.4, sizeStart: 0.12, opacity: 0.9, sprite: 'star', blending: 'additive', space: 'world'
	});
	N('selpad', 'objectselector', 'Build pad', 1240, 1400, { selected: 'Build pad' });
	E('enr4', 'pfx', 'trigger');
	E('pfx', 'selpad');

	// ---- the stars — collectible-module touch pickups (shared team score) -------
	for (let i = 1; i <= 3; i++) {
		const y = 1600 + (i - 1) * 150;
		N('colstar' + i, 'collectible', 'Star ' + i + ' pickup', 40, y, {
			variable: 'stars', scope: 'shared', trigger: 'touch', radius: 1.4,
			respawn: 0, hide: 'on', perRound: true, whilePlaying: true
		});
		N('selstar' + i, 'objectselector', 'Star ' + i, 280, y, { selected: 'Star ' + i });
		E('colstar' + i, 'selstar' + i);
	}
	N('cstars', 'collectiblecount', 'Stars left', 520, 1670, { variable: 'stars', read: 'left' });
	N('hstars', 'hudtext', 'HUD stars', 760, 1670, { element: 'stars-read', format: 'Stars left: {v}', decimals: 0, value: 0 });
	E('cstars', 'hstars', 'value');

	// ---- win: every star collected, agreed by everyone playing -----------------
	N('starsdone', 'compare', 'All stars?', 520, 1900, { op: 'lte', a: 0, b: 0 });
	E('cstars', 'starsdone', 'a');
	N('allwin', 'allplayers', 'Everyone done', 760, 1900, { pulse: 0.3 });
	E('starsdone', 'allwin', 'condition');
	N('gowin', 'setgamestate', 'Win', 1000, 1900, { state: 'over', outcome: 'All stars collected!', reset: false });
	E('allwin', 'gowin', 'trigger');

	// ---- the round clock: ends the round on time -------------------------------
	N('clock', 'gametime', 'Time left', 40, 2100, { read: 'remaining', length: 180 });
	N('hclock', 'hudtext', 'HUD clock', 280, 2040, { element: 'clock', format: '{v}s', decimals: 0, value: 0 });
	E('clock', 'hclock', 'value');
	N('timeup', 'compare', 'Time up?', 280, 2190, { op: 'lte', a: 0, b: 0 });
	E('clock', 'timeup', 'a');
	N('playing', 'gametime', 'Is playing', 40, 2340, { read: 'playing', length: 60 });
	N('timeandplay', 'gate', 'Time up & playing', 520, 2240, { op: 'and', a: false, b: false });
	E('timeup', 'timeandplay', 'a');
	E('playing', 'timeandplay', 'b');
	N('alltime', 'allplayers', 'Everyone time up', 760, 2240, { pulse: 0.3 });
	E('timeandplay', 'alltime', 'condition');
	N('gotime', 'setgamestate', 'Time over', 1000, 2240, { state: 'over', outcome: "Time's up!", reset: false });
	E('alltime', 'gotime', 'trigger');

	return { nodes, edges };
}

const TOWERS_HUD_PANEL = {
	bg: 'rgba(20, 26, 36, 0.92)',
	radius: 16,
	border: '1px solid rgba(136, 192, 208, 0.25)'
};
const TOWERS_DEF = {
	kind: 'game',
	slug: 'towers',
	title: 'Towers',
	description:
		'Co-op crate stacking: grab the crates, build the tallest tower on the glowing pad, climb to the stars. Press P to pause or restart.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['physics', 'stacking', 'co-op', 'vr'],
	modules: [{ id: 'collectible', version: '1.0.0' }],
	installModules: ['collectible'],
	// daylight: the scene must READ, and a stacking game lives on seeing block edges.
	// (night was black on the user's display; the emissive accents below still pop.)
	env: { preset: 'daylight', exposure: 1 },
	// ground ON — a solid floor the crates rest on. A crate knocked past the low wall
	// falls to the bounds limit and RESPAWNS to its start pose (beforeStates), so the
	// supply cannot be lost. Grab interaction, sim starts on Play.
	physics: {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0 },
		bounds: { limit: -20, action: 'respawn' },
		material: { friction: 0.7, restitution: 0.05 },
		damping: { linear: 0.05, angular: 0.3 },
		play: { interaction: 'grab', grounded: false, simOnPlay: true }
	},
	// C9 Towers look, minimal + VR-safe: ao -> AgX -> low bloom -> smaa. No shader docs.
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.5, luminanceThreshold: 0.85 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	graphs: { scene: towersGraph() },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'menu',
					name: 'Menu',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 460, h: 340, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -115, w: 400, h: 54, z: 1, label: 'TOWERS', style: { size: 40, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -68, w: 430, h: 44, z: 1, label: 'Grab the crates and build the tallest tower on the glowing pad. Touch the floating stars.', style: { size: 14, color: '#d8dee9', align: 'center' }, wrap: true },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: 20, w: 220, h: 48, z: 1, label: 'Start round', enabled: true, style: { size: 17, weight: '600', bg: '#3b7dd8', color: '#ffffff', radius: 10 } },
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 110, w: 430, h: 40, z: 1, label: 'Grab: hold click  ·  Push/pull: wheel  ·  Fly: Q/E  ·  Pause: P', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'height-read', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 280, h: 30, z: 1, label: '', style: { size: 18, weight: '600', color: '#e5e9f0', align: 'center' } },
						{ id: 'clock', kind: 'text', anchor: 'top-center', x: 0, y: 46, w: 120, h: 22, z: 1, label: '', style: { size: 13, color: '#c8d0dc', align: 'center' } },
						{ id: 'stars-read', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 200, h: 24, z: 1, label: '', style: { size: 14, color: '#ffd45e', align: 'right' } },
						{ id: 'play-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 520, h: 20, z: 1, label: 'Stack on the glowing pad — the rings mark your height.  Press P to pause.', style: { size: 11, color: '#8b97a8', align: 'center' } }
					]
				},
				{
					id: 'pause',
					name: 'Pause',
					input: 'menu',
					elements: [
						{ id: 'pause-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 380, h: 300, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'pause-title', kind: 'text', anchor: 'center', x: 0, y: -95, w: 340, h: 36, z: 1, label: 'PAUSED', style: { size: 26, weight: '700', color: '#e5e9f0', align: 'center' } },
						{ id: 'resume-btn', kind: 'button', anchor: 'center', x: 0, y: -30, w: 240, h: 42, z: 1, label: 'Resume', enabled: true, style: { size: 16, weight: '600', bg: '#3b7dd8', color: '#ffffff', radius: 10 } },
						{ id: 'restart-btn', kind: 'button', anchor: 'center', x: 0, y: 22, w: 240, h: 42, z: 1, label: 'Restart round', enabled: true, style: { size: 16, weight: '600', bg: '#4c9e6a', color: '#ffffff', radius: 10 } },
						{ id: 'quit-btn', kind: 'button', anchor: 'center', x: 0, y: 74, w: 240, h: 42, z: 1, label: 'Quit to menu', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				},
				{
					id: 'over',
					name: 'Round over',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 420, h: 250, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'over-title', kind: 'text', anchor: 'center', x: 0, y: -70, w: 380, h: 40, z: 1, label: 'ROUND OVER', style: { size: 30, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'final-height', kind: 'text', anchor: 'center', x: 0, y: -18, w: 380, h: 26, z: 1, label: '', style: { size: 16, color: '#e5e9f0', align: 'center' } },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: 0, y: 58, w: 220, h: 44, z: 1, label: 'Back to menu', enabled: true, style: { size: 16, weight: '600', bg: '#3b7dd8', color: '#ffffff', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the arena — a lit floor with a low rim, built on the ground plane
		{ type: 'box', name: 'Arena floor', color: 0x6b7280, size: [26, 0.5, 26], pos: [0, -0.25, 0], roughness: 0.95, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'box', name: 'Wall north', color: 0x565f6e, size: [26, 1, 0.5], pos: [0, 0.5, -13], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall south', color: 0x565f6e, size: [26, 1, 0.5], pos: [0, 0.5, 13], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall west', color: 0x565f6e, size: [0.5, 1, 26], pos: [-13, 0.5, 0], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall east', color: 0x565f6e, size: [0.5, 1, 26], pos: [13, 0.5, 0], physics: { mode: 'static' } },
		// build pad — glowing blue, SUNK so its bottom face is not coplanar with the floor
		{ type: 'cylinder', name: 'Build pad', color: 0x3b6ea8, r: 1.7, h: 0.24, pos: [0, 0.08, 0], emissive: 0x2a5b8f, emissiveIntensity: 0.7, roughness: 0.5, physics: { mode: 'static', friction: 1 } },
		// podiums where the crate supply sits, sunk into the floor by the same trick
		{ type: 'cylinder', name: 'Cube podium', color: 0x4a5262, r: 1.1, h: 0.5, pos: [-5.5, 0.2, 0], physics: { mode: 'static', friction: 0.9 } },
		{ type: 'cylinder', name: 'Plank podium', color: 0x4a5262, r: 1.1, h: 0.5, pos: [5.5, 0.2, 0], physics: { mode: 'static', friction: 0.9 } },
		// PRE-PLACED crates: a tidy supply that rests until grabbed, then stays put.
		// Cubes on the left podium (podium top ~0.45; stack from just above it).
		{ type: 'box', name: 'Cube 1', color: 0xd08770, size: [0.6, 0.6, 0.6], pos: [-5.5, 0.85, 0], physics: { mode: 'dynamic', mass: 1, friction: 0.8, restitution: 0.03 } },
		{ type: 'box', name: 'Cube 2', color: 0xd0a070, size: [0.6, 0.6, 0.6], pos: [-5.5, 1.5, 0], physics: { mode: 'dynamic', mass: 1, friction: 0.8, restitution: 0.03 } },
		{ type: 'box', name: 'Cube 3', color: 0xc98a5a, size: [0.6, 0.6, 0.6], pos: [-5.5, 2.15, 0], physics: { mode: 'dynamic', mass: 1, friction: 0.8, restitution: 0.03 } },
		{ type: 'box', name: 'Cube 4', color: 0xd08770, size: [0.6, 0.6, 0.6], pos: [-5.5, 2.8, 0], physics: { mode: 'dynamic', mass: 1, friction: 0.8, restitution: 0.03 } },
		// planks on the right podium
		{ type: 'box', name: 'Plank 1', color: 0xa3be8c, size: [1.4, 0.3, 0.6], pos: [5.5, 0.75, 0], physics: { mode: 'dynamic', mass: 0.9, friction: 0.8, restitution: 0.03 } },
		{ type: 'box', name: 'Plank 2', color: 0x94b07e, size: [1.4, 0.3, 0.6], pos: [5.5, 1.2, 0], physics: { mode: 'dynamic', mass: 0.9, friction: 0.8, restitution: 0.03 } },
		{ type: 'box', name: 'Plank 3', color: 0xa3be8c, size: [1.4, 0.3, 0.6], pos: [5.5, 1.65, 0], physics: { mode: 'dynamic', mass: 0.9, friction: 0.8, restitution: 0.03 } },
		// a few loose cubes near the pad to start building right away
		{ type: 'box', name: 'Cube 5', color: 0xd08770, size: [0.6, 0.6, 0.6], pos: [-2, 0.35, 2], physics: { mode: 'dynamic', mass: 1, friction: 0.8, restitution: 0.03 } },
		{ type: 'box', name: 'Cube 6', color: 0xc98a5a, size: [0.6, 0.6, 0.6], pos: [2, 0.35, 2], physics: { mode: 'dynamic', mass: 1, friction: 0.8, restitution: 0.03 } },
		// height rings over the pad — faint translucent bands, sensors a rising crate trips
		{ type: 'box', name: 'Height ring 1m', color: 0x9ee6ff, size: [1.5, 0.05, 1.5], pos: [0, 1, 0], emissive: 0x2f6f8f, emissiveIntensity: 0.6, opacity: 0.28, physics: { mode: 'static', sensor: true, collider: 'box' } },
		{ type: 'box', name: 'Height ring 2m', color: 0x9ee6ff, size: [1.5, 0.05, 1.5], pos: [0, 2, 0], emissive: 0x2f6f8f, emissiveIntensity: 0.6, opacity: 0.28, physics: { mode: 'static', sensor: true, collider: 'box' } },
		{ type: 'box', name: 'Height ring 3m', color: 0x9ee6ff, size: [1.5, 0.05, 1.5], pos: [0, 3, 0], emissive: 0x2f6f8f, emissiveIntensity: 0.6, opacity: 0.28, physics: { mode: 'static', sensor: true, collider: 'box' } },
		{ type: 'box', name: 'Height ring 4m', color: 0x9ee6ff, size: [1.5, 0.05, 1.5], pos: [0, 4, 0], emissive: 0x2f6f8f, emissiveIntensity: 0.6, opacity: 0.28, physics: { mode: 'static', sensor: true, collider: 'box' } },
		// the stars — glowing collectible touch pickups at climbing heights
		{ type: 'sphere', name: 'Star 1', color: 0xffe08a, r: 0.2, pos: [-3.5, 2.4, 3.5], emissive: 0xffcf50, emissiveIntensity: 0.9, roughness: 0.4 },
		{ type: 'sphere', name: 'Star 2', color: 0xffe08a, r: 0.2, pos: [3.5, 3.2, -3.5], emissive: 0xffcf50, emissiveIntensity: 0.9, roughness: 0.4 },
		{ type: 'sphere', name: 'Star 3', color: 0xffe08a, r: 0.2, pos: [0, 4.4, 0], emissive: 0xffcf50, emissiveIntensity: 0.9, roughness: 0.4 }
	]
};

const DEFS = [
	{
		kind: 'template',
		slug: 'level-blockout',
		title: 'Level blockout',
		description: 'Greybox kit: floor, ramp to a platform, steps, walls and cover blocks',
		license: 'CC0-1.0',
		author: 'theprototype',
		tags: ['greybox', 'level design'],
		objects: [
			{ type: 'box', name: 'Floor', color: gray.floor, size: [24, 0.5, 24], pos: [0, -0.25, 0] },
			{ type: 'box', name: 'Platform', color: gray.block, size: [6, 0.5, 6], pos: [8, 2, -6] },
			{ type: 'box', name: 'Ramp', color: gray.block, size: [4, 0.5, 7.2], pos: [8, 1, -0.6], rot: [-0.297, 0, 0] },
			{ type: 'box', name: 'Step 1', color: gray.block, size: [2.4, 0.66, 1.2], pos: [3.6, 0.33, -6] },
			{ type: 'box', name: 'Step 2', color: gray.block, size: [2.4, 1.33, 1.2], pos: [4.4, 0.66, -6] },
			{ type: 'box', name: 'Wall west', color: gray.wall, size: [0.5, 3, 14], pos: [-10, 1.5, -2] },
			{ type: 'box', name: 'Wall north', color: gray.wall, size: [14, 3, 0.5], pos: [-3, 1.5, -11] },
			{ type: 'box', name: 'Cover A', color: gray.block, size: [2, 2, 2], pos: [-3, 1, 4] },
			{ type: 'box', name: 'Cover B', color: gray.block, size: [3, 1, 1.2], pos: [1, 0.5, 7] },
			{ type: 'cylinder', name: 'Tower', color: gray.accent, r: 1.5, h: 6, pos: [-7, 3, -7] }
		]
	},
	{
		kind: 'template',
		slug: 'physics-playground',
		title: 'Physics playground',
		description: 'Static floor and ramp, a dynamic cube pyramid, dominos and a bouncy ball — press P to simulate',
		license: 'CC0-1.0',
		author: 'theprototype',
		tags: ['physics', 'sandbox'],
		objects: [
			{
				type: 'box', name: 'Floor', color: 0x7e8a97, size: [20, 0.5, 20], pos: [0, -0.25, 0],
				physics: { mode: 'static', friction: 0.8 }
			},
			{
				type: 'box', name: 'Ramp', color: 0x99a3ae, size: [8, 0.4, 4], pos: [-5, 1.55, 0], rot: [0, 0, 0.42],
				physics: { mode: 'static', friction: 0.3 }
			},
			{
				type: 'sphere', name: 'Bouncy ball', color: 0xd97706, r: 0.75, pos: [-8.2, 4.6, 0],
				physics: { mode: 'dynamic', mass: 2, restitution: 0.7, friction: 0.4 }
			},
			// 3-2-1 cube pyramid
			{ type: 'box', name: 'Crate 1', color: 0xc0885a, size: [1, 1, 1], pos: [3, 0.5, -1.2], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
			{ type: 'box', name: 'Crate 2', color: 0xc0885a, size: [1, 1, 1], pos: [3, 0.5, 0], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
			{ type: 'box', name: 'Crate 3', color: 0xc0885a, size: [1, 1, 1], pos: [3, 0.5, 1.2], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
			{ type: 'box', name: 'Crate 4', color: 0xb0784a, size: [1, 1, 1], pos: [3, 1.55, -0.6], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
			{ type: 'box', name: 'Crate 5', color: 0xb0784a, size: [1, 1, 1], pos: [3, 1.55, 0.6], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
			{ type: 'box', name: 'Crate 6', color: 0xa06a3e, size: [1, 1, 1], pos: [3, 2.6, 0], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
			// domino run
			{ type: 'box', name: 'Domino 1', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [0, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } },
			{ type: 'box', name: 'Domino 2', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [1, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } },
			{ type: 'box', name: 'Domino 3', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [2, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } },
			{ type: 'box', name: 'Domino 4', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [3, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } }
		]
	},
	{
		kind: 'template',
		slug: 'architecture-shell',
		title: 'Architecture shell',
		description: 'Room shell with a door and window opening, columns and a half roof to block out interiors',
		license: 'CC0-1.0',
		author: 'theprototype',
		tags: ['greybox', 'architecture'],
		objects: [
			{ type: 'box', name: 'Slab', color: 0x9aa3ad, size: [14, 0.3, 10], pos: [0, -0.15, 0] },
			{ type: 'box', name: 'Wall back', color: 0xb8bfc7, size: [14, 3, 0.3], pos: [0, 1.5, -5] },
			{ type: 'box', name: 'Wall west', color: 0xb8bfc7, size: [0.3, 3, 10], pos: [-7, 1.5, 0] },
			// east wall with a window opening
			{ type: 'box', name: 'Wall east a', color: 0xb8bfc7, size: [0.3, 3, 3.4], pos: [7, 1.5, -3.3] },
			{ type: 'box', name: 'Wall east b', color: 0xb8bfc7, size: [0.3, 3, 3.4], pos: [7, 1.5, 3.3] },
			{ type: 'box', name: 'Window lintel', color: 0xb8bfc7, size: [0.3, 0.7, 3.2], pos: [7, 2.65, 0] },
			{ type: 'box', name: 'Window sill', color: 0xb8bfc7, size: [0.3, 1, 3.2], pos: [7, 0.5, 0] },
			// front wall with a door opening
			{ type: 'box', name: 'Wall front a', color: 0xb8bfc7, size: [8.4, 3, 0.3], pos: [-2.8, 1.5, 5] },
			{ type: 'box', name: 'Wall front b', color: 0xb8bfc7, size: [4.2, 3, 0.3], pos: [4.9, 1.5, 5] },
			{ type: 'box', name: 'Door lintel', color: 0xb8bfc7, size: [1.4, 0.6, 0.3], pos: [2.1, 2.7, 5] },
			{ type: 'cylinder', name: 'Column a', color: 0x8f99a4, r: 0.22, h: 3, pos: [-2, 1.5, 0] },
			{ type: 'cylinder', name: 'Column b', color: 0x8f99a4, r: 0.22, h: 3, pos: [2, 1.5, 0] },
			{ type: 'box', name: 'Roof half', color: 0x87919c, size: [14, 0.3, 5], pos: [0, 3.15, -2.5] }
		]
	},
	{
		kind: 'example',
		slug: 'lighthouse-island',
		title: 'Lighthouse island',
		description: 'A small primitive-built lighthouse on an island — an example of composing simple shapes',
		license: 'CC0-1.0',
		author: 'theprototype',
		tags: ['showcase', 'primitives'],
		objects: [
			{ type: 'cylinder', name: 'Island', color: 0x8a9a7b, r: 7, r2: 8.5, h: 1.2, pos: [0, -0.6, 0] },
			{ type: 'cylinder', name: 'Tower base', color: 0xe8e2d6, r: 1.5, r2: 1.9, h: 3, pos: [0, 1.5, 0] },
			{ type: 'cylinder', name: 'Tower band', color: 0xc2452f, r: 1.32, r2: 1.5, h: 2.4, pos: [0, 4.2, 0] },
			{ type: 'cylinder', name: 'Tower top', color: 0xe8e2d6, r: 1.15, r2: 1.32, h: 2.4, pos: [0, 6.6, 0] },
			{ type: 'cylinder', name: 'Lamp room', color: 0x3b4652, r: 0.95, h: 1.3, pos: [0, 8.45, 0] },
			{ type: 'sphere', name: 'Lamp', color: 0xffd45e, r: 0.62, pos: [0, 8.45, 0] },
			{ type: 'cone', name: 'Roof', color: 0xc2452f, r: 1.15, h: 1.2, pos: [0, 9.7, 0] },
			{ type: 'box', name: 'Keeper house', color: 0xe8e2d6, size: [3, 1.8, 2.2], pos: [3.6, 0.9, 1.5] },
			{ type: 'box', name: 'House roof', color: 0x9a4632, size: [3.3, 0.5, 2.5], pos: [3.6, 2.05, 1.5], rot: [0, 0, 0.06] },
			{ type: 'box', name: 'Jetty', color: 0x8a6f52, size: [1.2, 0.25, 5], pos: [-1.5, 0.12, 8.5] }
		]
	},
	{
		// 23-D3: the Jam Room - the fastest answer to "what is this app": a piano into a
		// speaker, the beat lab (transport, drum machine, sampler pads), a pedal chain into a
		// mixer, all cabled. Built from the modules' own menus, so the template is always what
		// those modules make; the modules it needs ride the index row AND the payload (the
		// device-kind requirement signal derives them from the objects).
		kind: 'game',
		slug: 'jam-room',
		title: 'Jam Room',
		description: 'A piano into a speaker, a beat lab (transport, drum machine, sampler pads) and a pedal chain into a mixer - all cabled. Press Play on the transport, paint the grid, plug things in.',
		license: 'CC0-1.0',
		author: 'theprototype',
		tags: ['music', 'vr'],
		installModules: ['music-lab', 'music-fx'],
		modules: [{ id: 'music-lab', version: '0.2.0' }, { id: 'music-fx', version: '0.1.0' }],
		objects: [{ type: 'box', name: 'Floor', color: 0x2b2f36, size: [9, 0.3, 7], pos: [1.2, -0.15, -2.4] }],
		// a semicircle facing the spawn at the origin; both speakers turned to face the listener
		layout: [
			{ kind: 'mod-music-lab-transport', pos: [-2.6, 0.5, -1.8] },
			{ kind: 'mod-music-lab-piano', pos: [-1.3, 0, -2.4] },
			{ kind: 'mod-music-lab-drums', pos: [0.3, 0.8, -2.8] },
			{ kind: 'mod-music-lab-sampler', pos: [1.5, 0.8, -2.8] },
			{ kind: 'mod-music-lab-speaker', index: 0, pos: [-1.0, 0.35, -4.4], yaw: Math.PI },
			{ kind: 'mod-music-lab-speaker', index: 1, pos: [1.6, 0.35, -4.4], yaw: Math.PI },
			{ kind: 'mod-music-fx-mixer', pos: [3.2, 0.8, -2.6] },
			{ kind: 'mod-music-fx-filter', pos: [2.4, 0.5, -0.9] },
			{ kind: 'mod-music-fx-distortion', pos: [3.0, 0.5, -0.9] },
			{ kind: 'mod-music-fx-bitcrush', pos: [3.6, 0.5, -0.9] },
			{ kind: 'mod-music-fx-delay', pos: [4.2, 0.5, -0.9] },
			{ kind: 'mod-music-fx-reverb', pos: [4.8, 0.5, -0.9] }
		],
		generate: [
			{ menu: 'Music Lab: piano + speaker', moduleId: 'music-lab', waitMs: 1500 },
			{ menu: 'Music Lab: beat lab', moduleId: 'music-lab', waitMs: 1500 },
			{ menu: 'Music FX: demo chain', moduleId: 'music-fx', waitMs: 2000 }
		]
	},
	TOWERS_DEF
];

(async () => {
	const browser = await chromium.launch({
		headless: true,
		args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--use-gl=angle', '--use-angle=gl']
	});
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	const page = await ctx.newPage();
	page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message.split('\n')[0]));
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForFunction(() => window.__stores && !!window.__stores.sessions, { timeout: 40000 });
	await page.waitForTimeout(2000);

	/** @type {Record<string, {entry: any, bytes: Buffer, thumb: Buffer|null}>} */
	const built = {};
	const defs = ONLY ? DEFS.filter((d) => ONLY.includes(d.slug)) : DEFS;
	if (ONLY && defs.length !== ONLY.length)
		console.log('  WARN --only names a slug DEFS does not have: ' + ONLY.join(','));
	for (const def of defs) {
		// C5.3: a game thumbnail wants the GAME, not a grey box — install its module and
		// run its generator first. Skipped (with a warning, never a failure) when the
		// sibling modules checkout has no zips, the helpers.cjs installModule contract.
		for (const id of def.installModules ?? []) {
			const zip = moduleZipPath(id);
			if (!fs.existsSync(zip)) {
				console.log('  SKIP module ' + id + ' — no zip at ' + zip + ' (run "npm run pack -- --all" there)');
				continue;
			}
			await page.evaluate(() => window.__stores.modulesOpen.set(true));
			await page.waitForTimeout(400);
			await page.getByRole('tab', { name: /^User/ }).click();
			await page.waitForTimeout(200);
			await page.locator('#install-module-zip').setInputFiles({
				name: id + '.zip',
				mimeType: 'application/zip',
				buffer: fs.readFileSync(zip)
			});
			await page
				.waitForFunction(
					(want) => window.__stores.moduleSDK.loadedModules.some((m) => m.id === want),
					id,
					{ timeout: 20000 }
				)
				.catch(() => console.log('  WARN module ' + id + ' did not load'));
			await page.evaluate(() => window.__stores.modulesOpen.set(false));
			await page.waitForTimeout(300);
		}
		const out = await page.evaluate(async (d) => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand('/clear all');
			/** @type {any} */
			let group;
			s.objectsGroup.subscribe((g) => (group = g))();
			for (const o of d.objects) {
				let geo;
				if (o.type === 'box') geo = new s.THREE.BoxGeometry(o.size[0], o.size[1], o.size[2]);
				else if (o.type === 'cylinder') geo = new s.THREE.CylinderGeometry(o.r, o.r2 ?? o.r, o.h, 24);
				else if (o.type === 'sphere') geo = new s.THREE.SphereGeometry(o.r, 24, 16);
				else geo = new s.THREE.ConeGeometry(o.r, o.h, 24);
				const mat = new s.THREE.MeshStandardMaterial({
					color: o.color,
					roughness: o.roughness ?? 0.85,
					metalness: o.metalness ?? 0
				});
				// B8: material EMISSIVE + opacity, so a game can glow a pad or float a
				// translucent marker without a shader doc (which the user found "strange").
				// emissiveIntensity multiplies the emissive COLOUR, so both are needed.
				if (o.emissive != null) {
					mat.emissive = new s.THREE.Color(o.emissive);
					mat.emissiveIntensity = o.emissiveIntensity ?? 1;
				}
				if (o.opacity != null && o.opacity < 1) {
					mat.transparent = true;
					mat.opacity = o.opacity;
				}
				const mesh = new s.THREE.Mesh(geo, mat);
				mesh.name = o.name;
				mesh.position.set(o.pos[0], o.pos[1], o.pos[2]);
				if (o.rot) mesh.rotation.set(o.rot[0], o.rot[1], o.rot[2]);
				if (o.physics) mesh.userData.physics = o.physics;
				// toJSON reads the MATRIX the last render composed (the serializer
				// gotcha) — compose it now, we export before any frame runs
				mesh.updateMatrix();
				group.add(mesh);
			}
			s.objectsGroup.update((v) => v);

			// ---- C5.3: the scene DATA a game carries beyond its objects -------------
			// Each of these lands through the app's own write path, so what the script
			// produces is exactly what a user authoring by hand would have saved.
			if (d.env) s.environment.setEnvironment(d.env.preset ?? d.env, d.env.exposure ?? 1);
			if (typeof d.gravity === 'number') s.scenePhysics.setSceneGravity(d.gravity);
			// B8: the whole scenePhysics block (ground/bounds/material/damping/play), not
			// just gravity — a physics GAME is authored in these numbers. setScenePhysics
			// merges nested blocks, so a def states only what it means to change.
			if (d.physics) s.scenePhysics.setScenePhysics(d.physics);
			if (d.post) s.scenePost.scenePostRestore(d.post, false);
			// FLOW GRAPHS. node.position is filled in on a deterministic grid when a def
			// omits it: xyflow dereferences node.position while ADOPTING nodes, so a graph
			// written programmatically without one CRASHES the editor on mount — and a
			// deterministic grid means two peers still agree byte for byte.
			const named = {}; // def-local object names -> real uuids
			group.children.forEach((c) => (named[c.name] = c.uuid));
			if (d.graphs) {
				const grid = (i) => ({ x: 40 + (i % 4) * 220, y: 40 + Math.floor(i / 4) * 140 });
				// a node's object reference may be a def-local NAME: `uuid` on effect/anim
				// nodes, `selected` on an Object Selector (B8 — the selector is how every
				// trigger and action names its target, so a game graph is mostly selectors)
				const remapData = (data) => {
					const out = { ...(data ?? {}) };
					if (out.uuid && named[out.uuid]) out.uuid = named[out.uuid];
					if (out.selected && named[out.selected]) out.selected = named[out.selected];
					return out;
				};
				const resolved = {};
				for (const [key, doc] of Object.entries(d.graphs)) {
					// a graph key may be 'scene' or a def-local OBJECT NAME
					const graphId = key === 'scene' ? s.SCENE_GRAPH : named[key] ?? key;
					resolved[graphId] = {
						nodes: (doc.nodes ?? []).map((n, i) => ({
							...n,
							position: n.position ?? grid(i),
							data: remapData(n.data)
						})),
						edges: doc.edges ?? []
					};
				}
				s.restoreGraphs(resolved);
			}
			if (d.hud && s.hudDocs) s.hudDocs.hudDocsRestore(d.hud, false);
			if (d.shaders && s.shaderGraph) {
				// B8: shader documents are keyed 'scene' | objectUuid — remap def-local
				// object NAMES to the uuids this build just minted, same as the graphs
				const remappedShaders = {};
				for (const [key, doc] of Object.entries(d.shaders))
					remappedShaders[named[key] ?? key] = doc;
				s.shaderGraph.shaderGraphsRestore(remappedShaders, false);
			}
			// let every write settle (the debounced compiles and the reconciles)
			await new Promise((r) => setTimeout(r, d.graphs || d.shaders ? 900 : 100));

			// belt and braces: let the render loop compose world matrices too
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

			// a game's content may come from its module rather than from primitives. Two
			// seams, because modules use both: a scene COMMAND (registerPrimitive-style),
			// or a registered manager MENU action, which is how untangle and dungeon-realms
			// expose "generate/restart" (api.registerMenu).
			// 23-D3: `generate` may be ONE action or a SEQUENCE of them (a room built from several
			// module menus), each a command string or {menu, moduleId}, waited in turn
			const steps = Array.isArray(d.generate) ? d.generate : d.generate ? [d.generate] : [];
			for (const step of steps) {
				if (typeof step === 'string') s.commandsHandler.sceneCommand(step);
				else if (step.menu) {
					/** @type {any} */ let items;
					s.moduleSDK.moduleMenuItems.subscribe((/** @type {any} */ v) => (items = v))();
					const hit = items.find(
						(/** @type {any} */ it) => it.label === step.menu && (!step.moduleId || it.moduleId === step.moduleId)
					);
					if (hit) hit.action();
					else throw new Error('no module menu action named "' + step.menu + '"');
				}
				await new Promise((r) => setTimeout(r, step.waitMs ?? d.generateWaitMs ?? 2500));
				s.objectsGroup.update((v) => v);
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			}

			// export through the REAL .tpscene path (no session slot needed)
			// 23-D3: `layout` places what the menus generated - each entry names a device KIND,
			// the n-th object of that kind (default the first), a position and an optional yaw -
			// so a room built from several menus is arranged, not piled where each menu drops
			// its devices
			if (Array.isArray(d.layout)) {
				const seen = {};
				const devices = [];
				group.traverse((o) => { if (o.userData?.device?.kind) devices.push(o); });
				for (const entry of d.layout) {
					const n = entry.index ?? 0;
					const matches = devices.filter((o) => o.userData.device.kind === entry.kind);
					const target = matches[n];
					if (!target) throw new Error('layout: no device #' + n + ' of kind ' + entry.kind);
					target.position.set(entry.pos[0], entry.pos[1], entry.pos[2]);
					if (typeof entry.yaw === 'number') target.rotation.set(0, entry.yaw, 0);
					target.updateMatrix();
					seen[entry.kind] = n;
				}
				s.objectsGroup.update((v) => v);
				await new Promise((r) => setTimeout(r, 300));
			}
			const payload = s.sessions.buildSessionPayload(d.title);
			const bytes = await s.sessions.exportSessionZip(payload, { assets: false, packs: false, flow: true });

			// fitted offscreen thumbnail — the sessions.js renderSceneThumbnail
			// approach at card size (480x270 webp)
			let thumb = null;
			try {
				const T = s.THREE;
				const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
				renderer.setSize(480, 270);
				const scene = new T.Scene();
				scene.background = new T.Color('#232a33');
				scene.add(new T.HemisphereLight(0xffffff, 0x444466, 2.2));
				const sun = new T.DirectionalLight(0xffffff, 1.4);
				sun.position.set(6, 10, 4);
				scene.add(sun);
				const clone = new T.ObjectLoader().parse(group.toJSON());
				scene.add(clone);
				const box = new T.Box3().setFromObject(clone);
				const size = Math.max(box.getSize(new T.Vector3()).length(), 1);
				const center = box.getCenter(new T.Vector3());
				const camera = new T.PerspectiveCamera(40, 480 / 270, size / 100, size * 10);
				camera.position.copy(center).add(new T.Vector3(size * 0.55, size * 0.42, size * 0.72));
				camera.lookAt(center);
				renderer.render(scene, camera);
				thumb = renderer.domElement.toDataURL('image/webp', 0.82);
				renderer.dispose();
				renderer.forceContextLoss?.();
			} catch (e) {
				console.log('thumb failed', e);
			}
			// leave no look or rule behind for the next def — a leaked sky or gravity is
			// exactly the bug A6 exists to fix, and it would be baked into the next scene
			s.commandsHandler.sceneCommand('/clear all');
			s.environment.setEnvironment('studio', 1);
			s.scenePhysics.resetSceneGravity();
			s.restoreGraphs({});
			// B8: every singleton a game def can now set — a null/empty restore is the
			// documented "back to defaults" for each of them, so the next def starts clean
			s.scenePhysics.scenePhysicsRestore(null, false);
			if (s.hudDocs) s.hudDocs.hudDocsRestore({}, true, false);
			if (s.shaderGraph) s.shaderGraph.shaderGraphsRestore({}, true);
			if (s.scenePost) s.scenePost.scenePostRestore(null, false);
			if (s.gameState) s.gameState.gameStateRestore(null, false);
			return { bytes: Array.from(bytes), thumb };
		}, def);
		const bytes = Buffer.from(out.bytes);
		const thumb = out.thumb ? Buffer.from(out.thumb.split(',')[1], 'base64') : null;
		built[def.slug] = { entry: def, bytes, thumb };
		console.log(`${def.kind} ${def.slug}: scene ${bytes.length} B, thumb ${thumb ? thumb.length : 0} B`);
	}
	await browser.close();

	/** write one built def under a root dir @param {string} root @param {any} def */
	const writeDef = (root, def) => {
		const dir = path.join(root, def.slug);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'scene.tpscene'), built[def.slug].bytes);
		if (built[def.slug].thumb) fs.writeFileSync(path.join(dir, 'thumb.webp'), built[def.slug].thumb);
		return {
			slug: def.slug,
			title: def.title,
			description: def.description,
			author: def.author,
			license: def.license,
			// A7: the chip row is derived from these — a def without tags gets an
			// empty array rather than an absent key, so every row has the same shape
			tags: def.tags ?? [],
			// C5.2: only a GAME carries modules, and absent means absent — a template row
			// must not grow an empty array it has no use for.
			//
			// NOTE there are TWO module lists and they must agree: this AUTHORED one, which
			// the Games card reads, and the DERIVED one inside session.json, which
			// moduleRequirements() computes from the flow at save time. They only line up
			// when the def also lists the module in `installModules`, so the module is
			// actually loaded while the scene is being built — otherwise the file derives
			// nothing and the card promises a module the scene does not admit to needing.
			...(def.modules?.length ? { modules: def.modules } : {}),
			bytes: built[def.slug].bytes.length
		};
	};

	// bundled seed: templates only, app-origin paths (examples + GAMES stay remote-only
	// — a game needs a module download, so bundling one offline promises what it cannot
	// deliver). SKIPPED under --only: a partial run must not overwrite the seed index
	// with a partial one.
	if (!ONLY) {
		fs.mkdirSync(STATIC_OUT, { recursive: true });
		const seedTemplates = defs.filter((d) => d.kind === 'template').map((d) => ({
			...writeDef(STATIC_OUT, d),
			scene: `/templates/${d.slug}/scene.tpscene`,
			thumb: built[d.slug].thumb ? `/templates/${d.slug}/thumb.webp` : ''
		}));
		fs.writeFileSync(
			path.join(STATIC_OUT, 'index.json'),
			JSON.stringify({ version: 1, templates: seedTemplates, examples: [] }, null, '\t') + '\n'
		);
		console.log(`bundled seed -> ${STATIC_OUT} (${seedTemplates.length} templates)`);
	}

	// scenes-repo working copy: full tree, repo-relative paths
	if (REPO_OUT) {
		// C5.2: version 2 = the file has a games section. Written even when empty, so a
		// reader can tell "a v2 index with no games yet" from "a v1 index".
		/** @type {any} */
		let index = { version: 2, templates: [], examples: [], games: [] };
		const indexPath = path.join(REPO_OUT, 'index.json');
		if (ONLY && fs.existsSync(indexPath)) {
			// --only MERGES: start from the index already there so the rows this run did
			// not author survive verbatim (an unreadable file falls back to a fresh one)
			try {
				const prev = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
				index = {
					version: 2,
					templates: prev.templates ?? [],
					examples: prev.examples ?? [],
					games: prev.games ?? []
				};
			} catch {
				console.log('  WARN existing index.json unreadable — rebuilding it from this run');
			}
		}
		for (const def of defs) {
			const section =
				def.kind === 'template' ? 'templates' : def.kind === 'game' ? 'games' : 'examples';
			const row = {
				...writeDef(path.join(REPO_OUT, section), def),
				scene: `${section}/${def.slug}/scene.tpscene`,
				thumb: built[def.slug].thumb ? `${section}/${def.slug}/thumb.webp` : ''
			};
			const rows = index[section];
			const at = rows.findIndex((/** @type {any} */ r) => r.slug === def.slug);
			if (at === -1) rows.push(row);
			else rows[at] = row;
		}
		fs.mkdirSync(REPO_OUT, { recursive: true });
		fs.writeFileSync(indexPath, JSON.stringify(index, null, '\t') + '\n');
		console.log(`scenes repo tree -> ${REPO_OUT}`);
	}
})();
