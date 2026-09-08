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
//
// 28-G: a def may also be kind:'contest'. A CONTEST is a starter scene plus the text a
// contest page reads: it is written under contests/<slug>/ (scene.tpscene + thumb.webp +
// contest.json, from `def.contest`) and listed in a `contests` array of the --out
// index.json — optional exactly like `games`, and only written when a contest def ran.
// Never part of the bundled seed. The two starters needed more than four primitives, so
// the object vocabulary grew, all ADDITIVE (every earlier def builds byte-identically):
//   {type:'torus'} · {type:'light', kind:'point'} · {type:'empty'} · {type:'camera', pos,
//   lookAt, fov} (the app's own /create Camera marker) · {type:'spline', points} ·
//   {type:'group', children} · {type:'mirror', of, opacity, prefix} (a named group's
//   objects reflected across x = 0) · `shadow:false` on any object · def-level
//   `animations` (authored clips keyed by object NAME) · `music` {url|file, sha256, name}
//   (the track lands in the Explorer and the scene's music slot; `'$music'` in node data
//   becomes its content hash, so a Sound node can play the same bytes) · `view` (the
//   editor camera the file opens on) · `thumb.camera` (render the card through a named
//   camera object). A def with `music` exports WITH assets, so the bytes ride the .tpscene.
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

// ---- 28-G: the first two contests — Make a mirror, Follow the beat ---------------
// Both are DATA (spec: cloud plans-core/28-g-contests-mirror-and-beat.md). The mirror
// starter ships the answer as a faint ghost; the beat starter ships a CC0 track, a
// Conductor whose clip is only a CLOCK (markers on every beat, every bar and one cue per
// loop) and the graph that turns those markers into a light pulse and three camera cuts.

/**
 * The track bytes for a def's `music`: a local `file` (repo-relative), else `url`
 * fetched once and cached under the OS temp dir — the file belongs to neither repo, the
 * .tpscene is where it ships. `sha256` PINS the bytes: a CDN quietly swapping the file
 * would otherwise change every entry's soundtrack without anyone noticing.
 * @param {{url?: string, file?: string, sha256?: string}} music
 */
async function fetchMusic(music) {
	let bytes;
	if (music.file) bytes = fs.readFileSync(path.resolve(__dirname, '..', music.file));
	else {
		const cacheDir = path.join(require('os').tmpdir(), 'author-templates-cache');
		// globalThis.URL: this file's `URL` const is the app's address, not the class
		const cached = path.join(cacheDir, path.basename(new globalThis.URL(music.url).pathname));
		if (fs.existsSync(cached)) bytes = fs.readFileSync(cached);
		else {
			const res = await fetch(music.url);
			if (!res.ok) throw new Error('music: HTTP ' + res.status + ' fetching ' + music.url);
			bytes = Buffer.from(await res.arrayBuffer());
			fs.mkdirSync(cacheDir, { recursive: true });
			fs.writeFileSync(cached, bytes);
		}
	}
	if (music.sha256) {
		const got = require('crypto').createHash('sha256').update(bytes).digest('hex');
		if (got !== music.sha256) throw new Error('music: sha256 mismatch for ' + (music.file ?? music.url) + ' (got ' + got + ')');
	}
	return bytes;
}

/**
 * The text a contest page and the ops ritual read (the cloud repo's seed-contests.mjs
 * turns it into a record and uploads the starter). `starter` is filled in from the
 * layout so the two can never disagree; brief and rules are capped at 1500 chars
 * because they render in a card. @param {string} file @param {any} def
 */
function writeContestJson(file, def) {
	const c = def.contest ?? {};
	const json = {
		slug: def.slug,
		title: def.title,
		brief: c.brief ?? '',
		rules: c.rules ?? '',
		starter: `contests/${def.slug}/scene.tpscene`,
		durationDays: c.durationDays ?? 14,
		opensAfterDays: c.opensAfterDays ?? 0,
		judging: c.judging ?? '',
		credits: c.credits ?? []
	};
	for (const key of ['brief', 'rules'])
		if (json[key].length > 1500) throw new Error(`contest ${def.slug}: ${key} is ${json[key].length} chars (max 1500)`);
	fs.writeFileSync(file, JSON.stringify(json, null, '\t') + '\n');
}

const CONTEST_JUDGING = "top 3 by likes + Judge's pick; winners get featured";
const ALL_TOGETHER =
	'Do it alone or **all together**: host the starter, share the invite link, build in one ' +
	'session and publish once from the host with everyone credited in `authors`. Co-built ' +
	'entries are welcome.';

// The sculpture is CLEARLY HANDED: a staircase that spirals one way, yawed slabs, a cone
// pointing at the line, a flag on one side of its mast, a three-axis-rotated cube and a
// bent spline — so a mirror that only negates x reads wrong at a glance, and the ghost
// (built by the same code with `mirror`) shows what a reflection does to each rotation.
const MIRROR_SCULPTURE = [
	{ type: 'cylinder', name: 'Plinth', color: 0x6b7280, r: 1.3, r2: 1.5, h: 0.4, pos: [-3.2, 0.2, 0.2], roughness: 0.9 },
	{ type: 'box', name: 'Base slab', color: 0xaab2bd, size: [2.6, 0.3, 1.7], pos: [-3.2, 0.55, 0.2], rot: [0, 0.35, 0] },
	{ type: 'box', name: 'Tower', color: 0xd0a070, size: [0.8, 2.6, 0.8], pos: [-3.6, 2.0, 0.5], rot: [0, 0.35, 0] },
	{ type: 'box', name: 'Cantilever', color: 0xa3be8c, size: [2.4, 0.28, 0.5], pos: [-2.2, 3.15, 0.75], rot: [0, 0.1, 0.12] },
	{ type: 'sphere', name: 'Lamp', color: 0xffe08a, r: 0.34, pos: [-1.0, 3.45, 0.85], emissive: 0xffcf50, emissiveIntensity: 0.9, roughness: 0.4 },
	{ type: 'box', name: 'Step 1', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-4.9, 0.1, 1.6] },
	{ type: 'box', name: 'Step 2', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-5.0, 0.4, 0.7], rot: [0, 0.5, 0] },
	{ type: 'box', name: 'Step 3', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-4.7, 0.7, -0.2], rot: [0, 1.0, 0] },
	{ type: 'box', name: 'Step 4', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-4.1, 1.0, -0.9], rot: [0, 1.5, 0] },
	{ type: 'box', name: 'Leaning slab', color: 0xd97706, size: [0.16, 2.2, 1.2], pos: [-1.7, 1.1, -1.5], rot: [0, 0.6, -0.3] },
	{ type: 'cylinder', name: 'Mast', color: 0x4c566a, r: 0.06, h: 3.2, pos: [-5.4, 1.6, -1.3] },
	{ type: 'box', name: 'Flag', color: 0xc2452f, size: [0.8, 0.45, 0.05], pos: [-5.0, 3.0, -1.3] },
	{ type: 'torus', name: 'Ring', color: 0x88c0d0, r: 0.55, tube: 0.09, pos: [-1.7, 2.9, 1.6], rot: [0.6, 0.4, 0] },
	{ type: 'sphere', name: 'Orb A', color: 0xb48ead, r: 0.36, pos: [-1.4, 0.36, 2.0] },
	{ type: 'sphere', name: 'Orb B', color: 0xb48ead, r: 0.26, pos: [-1.4, 0.95, 2.0] },
	{ type: 'sphere', name: 'Orb C', color: 0xb48ead, r: 0.16, pos: [-1.4, 1.35, 2.0] },
	{ type: 'box', name: 'Beam', color: 0x4c566a, size: [0.2, 0.2, 2.8], pos: [-2.5, 1.85, 0.1], rot: [0, -0.4, 0] },
	// a cone lying on its side, tip toward the line (rot z -90 deg): its mirror points back
	{ type: 'cone', name: 'Nose cone', color: 0xebcb8b, r: 0.55, h: 0.9, pos: [-0.9, 0.55, -0.6], rot: [0, 0, -1.5708] },
	{ type: 'cylinder', name: 'Dish', color: 0xe8e2d6, r: 0.75, h: 0.08, pos: [-2.0, 2.5, -1.0], rot: [0.5, 0, 0.3] },
	{ type: 'cylinder', name: 'Pillar A', color: 0x8f99a4, r: 0.15, h: 1.6, pos: [-5.6, 0.8, 1.0] },
	{ type: 'cylinder', name: 'Pillar B', color: 0x8f99a4, r: 0.15, h: 1.2, pos: [-5.6, 0.6, -0.4] },
	{ type: 'box', name: 'Lintel', color: 0x8f99a4, size: [0.3, 0.16, 1.9], pos: [-5.6, 1.65, 0.3], rot: [0.15, 0, 0] },
	{ type: 'box', name: 'Tilted cube', color: 0xbf616a, size: [0.6, 0.6, 0.6], pos: [-3.9, 3.7, 0.4], rot: [0.3, 0.8, 0.2] },
	{ type: 'cylinder', name: 'Antenna', color: 0x2e3440, r: 0.04, h: 1.1, pos: [-3.4, 3.85, 0.7] },
	{ type: 'sphere', name: 'Antenna tip', color: 0xbf616a, r: 0.1, pos: [-3.4, 4.45, 0.7] },
	{ type: 'box', name: 'Ramp', color: 0x94b07e, size: [1.5, 0.12, 0.8], pos: [-1.0, 0.4, 1.0], rot: [0, 0, 0.35] },
	{
		type: 'spline', name: 'Ribbon', color: 0xff7b3d,
		points: [
			{ pos: [-2.7, 0.7, 1.3], radius: 0.09 }, { pos: [-2.1, 1.5, 1.7], radius: 0.085 },
			{ pos: [-1.5, 2.2, 1.2], radius: 0.08 }, { pos: [-1.2, 2.8, 0.4], radius: 0.07 },
			{ pos: [-1.6, 3.4, -0.2], radius: 0.06 }
		]
	}
];

// a real floor grid in objects (the app's own grid is a local pref, so it may be off)
const MIRROR_FLOOR = [
	{ type: 'box', name: 'Floor left', color: 0x7e8a97, size: [8, 0.2, 10], pos: [-4, -0.1, 0], roughness: 0.95 },
	{ type: 'box', name: 'Floor right', color: 0x8b959f, size: [8, 0.2, 10], pos: [4, -0.1, 0], roughness: 0.95 },
	...[-4, -2, 0, 2, 4].map((z) => ({ type: 'box', name: 'Grid line z' + z, color: 0x5d6673, size: [16, 0.03, 0.04], pos: [0, 0.015, z] })),
	...[-6, -4, -2, 2, 4, 6].map((x) => ({ type: 'box', name: 'Grid line x' + x, color: 0x5d6673, size: [0.04, 0.03, 10], pos: [x, 0.015, 0] }))
];

const MIRROR_DEF = {
	kind: 'contest',
	slug: 'make-a-mirror',
	title: 'Make a mirror',
	description:
		'Rebuild the sculpture on the left as its mirror image on the right of the glowing line. The faint ghost is the answer — hide it to test yourself.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['contest', 'primitives', 'co-op'],
	env: { preset: 'studio', exposure: 1 },
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	// the editor opens on a 3/4 view that shows both halves and the line between them
	view: { pos: [6.5, 5.2, 13], target: [0, 1.6, 0] },
	thumb: { camera: 'Judge' },
	objects: [
		{ type: 'group', name: 'Floor grid', children: MIRROR_FLOOR },
		// the mirror plane: emissive, translucent, at x = 0 exactly
		{ type: 'box', name: 'Mirror plane', color: 0x9ee6ff, size: [0.04, 4.8, 10], pos: [0, 2.4, 0], emissive: 0x4fc3f7, emissiveIntensity: 1.1, opacity: 0.4, roughness: 0.3, shadow: false },
		{ type: 'group', name: 'Sculpture', children: MIRROR_SCULPTURE },
		// THE GHOST: every sculpture piece reflected, 15% opacity, one group so one click
		// hides it. Locks are live session state (lockedObjects), not part of a file —
		// see the PR: the starter cannot ship it locked, only as a single, hide-able group.
		{ type: 'mirror', name: 'Ghost', of: 'Sculpture', opacity: 0.15, prefix: 'Ghost ' },
		{ type: 'camera', name: 'Front', pos: [0, 2.6, 12.5], lookAt: [0, 1.8, 0], fov: 45 },
		{ type: 'camera', name: 'Judge', pos: [7.5, 4.4, 8.8], lookAt: [-0.4, 1.6, 0.2], fov: 42 }
	],
	contest: {
		brief:
			'Build the mirror image of the sculpture on the right side of the glowing line. Use the ' +
			'ghost as a guide, or hide it to test yourself (select the **Ghost** group and hide it). ' +
			'Every piece is a primitive: mirror its position across the line and mind the rotations — ' +
			'a reflection turns a left-handed twist into a right-handed one.\n\n' +
			ALL_TOGETHER +
			'\n\nJudged on accuracy and on what you add: lighting, a look, a motion.',
		rules:
			'- Primitives and your own assets — no duplicating the ghost.\n' +
			'- The **Ghost** group must be hidden or removed in the entry.\n' +
			'- One entry per person (or per co-built session); updates allowed until the contest closes.',
		durationDays: 14,
		opensAfterDays: 0,
		judging: CONTEST_JUDGING,
		credits: []
	}
};

// The track: CC0 on freesound, 72 s, and MEASURED at 120.00 BPM (onset autocorrelation,
// the "Party Retro Organ ... 120bpm" candidate read 122 despite its title, and was
// dropped). The HQ preview is the same CC0 work transcoded to mp3; the sha256 pins it.
const BEAT_TRACK = {
	url: 'https://cdn.freesound.org/previews/622/622426_2282212-hq.mp3',
	sha256: '8542ef29eb53aad159230fa8dd6cab54e6b3bedc829f9a9ecaa5758cbd80a0fb',
	name: 'szegvari - Happy Ethno Jazz Dance 120bpm (CC0).mp3',
	volume: 0.8,
	credit: {
		what: 'track',
		title: 'Happy Experimental Ethno Jazz Vocal Instruments Dance Cinematic Music 120Bpm Mastered',
		author: 'szegvari',
		license: 'CC0-1.0',
		source: 'https://freesound.org/people/szegvari/sounds/622426/'
	}
};

const BEAT_BPM = 120;
const BEAT_SECONDS = 60 / BEAT_BPM; // 0.5
// THREE bars per loop, because there are three cameras: a Sequence off one cue per loop
// cuts Wide / Dolly / Detail on bars 1 / 2 / 3 and the loop brings Wide back. (A trigger
// stamp comes only from EVENT nodes, so "counter mod 3 -> which camera" cannot be wired;
// the Sequence is the one node that fans a single pulse out in time.)
const BEAT_BARS = 3;
const BEAT_LOOP = BEAT_BARS * 4 * BEAT_SECONDS; // 6 s
// The cue sits 60 ms AFTER the downbeat, never on it: a marker at exactly t = 0 is not
// crossed on the FIRST lap (the tick has no previous head to travel from), so a cue at 0
// would give lap one no camera cuts. 60 ms is under a frame's worth of error at the cut
// and past two frames of start-up hitch; the Sequence's second delay takes it back off.
const BEAT_CUE_AT = 0.06;
function beatMarkers() {
	const markers = [];
	for (let beat = 0; beat < BEAT_BARS * 4; beat++) {
		markers.push({ t: beat * BEAT_SECONDS, name: 'beat' });
		if (beat % 4 === 0) markers.push({ t: beat * BEAT_SECONDS, name: 'bar' });
	}
	markers.push({ t: BEAT_CUE_AT, name: 'cue' });
	return markers;
}

function beatGraph() {
	/** @type {any[]} */ const nodes = [];
	/** @type {any[]} */ const edges = [];
	/** @param {string} id @param {string} type @param {string} label @param {number} x @param {number} y @param {any} data */
	const N = (id, type, label, x, y, data) => {
		nodes.push({ id, type, position: { x, y }, data: { label, ...data }, class: 'w-[150px]' });
		return id;
	};
	// the editor's canonical edge id with BOTH handles (Nodes.svelte) — a Sequence step is
	// a SOURCE handle, which the Towers helper never needed
	/** @param {string} source @param {string} target @param {string} [targetHandle] @param {string} [sourceHandle] */
	const E = (source, target, targetHandle, sourceHandle) => {
		edges.push({
			id: 'e-' + source + (sourceHandle ? '.' + sourceHandle : '') + '-' + target + (targetHandle ? '.' + targetHandle : ''),
			source,
			target,
			...(sourceHandle ? { sourceHandle } : {}),
			...(targetHandle ? { targetHandle } : {})
		});
	};
	// selectors — every trigger and action names its object through one
	N('selcond', 'objectselector', 'Conductor', 760, 190, { selected: 'Conductor' });
	N('selstage', 'objectselector', 'Stage', 760, 340, { selected: 'Stage' });
	N('sellight', 'objectselector', 'Beat light', 760, 640, { selected: 'Beat light' });
	N('sellamp', 'objectselector', 'Beat lamp', 760, 790, { selected: 'Beat lamp' });
	N('selpad', 'objectselector', 'Pad', 760, 940, { selected: 'Pad' });
	N('selwide', 'objectselector', 'Wide camera', 760, 40, { selected: 'Wide' });
	N('seldolly', 'objectselector', 'Dolly camera', 1000, 1160, { selected: 'Dolly' });
	N('seldetail', 'objectselector', 'Detail camera', 1000, 1400, { selected: 'Detail' });

	// ---- Start: the HUD button enters `playing`; everyone starts on Wide -----------
	N('bstart', 'hudbutton', 'Start button', 40, 40, { element: 'start-btn' });
	N('gostart', 'setgamestate', 'Start', 280, 40, { state: 'playing', outcome: '', reset: false });
	E('bstart', 'gostart', 'trigger');
	N('gcam', 'gamestart', 'Everyone starts on Wide', 520, 40, { camera: '' });
	E('selwide', 'gcam', 'camera');
	// entering `playing` restarts the clock, plays the track once and flashes the downbeat.
	// THROUGH A ZERO-SECOND DELAY, measured: On Game State (like HUD Button) has a trigger
	// STAMP but no VALUE in the evaluator, and Play Animation acts on the rising edge of
	// its resolved `trigger` VALUE — so wired straight, the clock never started while the
	// stamp-reading Sound node beside it played. A Delay is pure and value-evaluable
	// (pulseAt(stamp + 0)), which turns the stamp into the pulse Play Animation can see.
	// Recorded as a core follow-up (playanim could read the stamp like setcamera does).
	N('onplay', 'ongamestate', 'When play starts', 40, 190, { state: 'playing', edge: 'enter', pulse: 0.3 });
	N('startpulse', 'delay', 'Start pulse (0 s)', 280, 190, { seconds: 0, pulse: 0.3 });
	E('onplay', 'startpulse', 'trigger');
	N('clock', 'playanim', 'Start the beat clock', 520, 190, { clip: 'Beat clock', action: 'restart', speed: 1 });
	E('startpulse', 'clock', 'trigger');
	E('clock', 'selcond');
	// the track as a ONE-SHOT on the stage: no falloff (rolloff 0) so it is heard everywhere
	N('track', 'sound', 'Play the track', 520, 340, {
		hash: '$music', file: BEAT_TRACK.name, volume: BEAT_TRACK.volume, radius: 40, rolloff: 0, loop: false, playing: false
	});
	E('startpulse', 'track', 'trigger');
	E('track', 'selstage');
	N('downbeat', 'playanim', 'Flash on the downbeat', 520, 490, { clip: 'Flash', action: 'restart', speed: 1 });
	E('startpulse', 'downbeat', 'trigger');
	E('downbeat', 'sellight');

	// ---- every beat: the light and the lamp restart their Flash clip ----------------
	N('beat', 'animmarker', 'Every beat', 40, 640, { name: 'beat', pulse: 0.3 });
	E('beat', 'selcond');
	N('flash', 'playanim', 'Pulse the light', 280, 640, { clip: 'Flash', action: 'restart', speed: 1 });
	E('beat', 'flash', 'trigger');
	E('flash', 'sellight');
	N('lamp', 'playanim', 'Pulse the lamp', 280, 790, { clip: 'Flash', action: 'restart', speed: 1 });
	E('beat', 'lamp', 'trigger');
	E('lamp', 'sellamp');

	// ---- every bar: a burst of stars off the Pad -------------------------------------
	N('bar', 'animmarker', 'Every bar', 40, 940, { name: 'bar', pulse: 0.3 });
	E('bar', 'selcond');
	N('burst', 'particle', 'Burst on the bar', 280, 940, {
		mode: 'burst', count: 80, lifetime: 1.2, speed: 2.2, gravity: 0, turbulence: 0.4,
		sizeStart: 0.1, opacity: 0.9, sprite: 'star', blending: 'additive', space: 'world',
		colorStart: '#fffbe8', colorEnd: '#b48ead'
	});
	E('bar', 'burst', 'trigger');
	E('burst', 'selpad');

	// ---- the camera cuts: one cue per loop fans out to the three bars -----------------
	N('cue', 'animmarker', 'Cue (once per loop)', 40, 1090, { name: 'cue', pulse: 0.3 });
	E('cue', 'selcond');
	const barLen = 4 * BEAT_SECONDS;
	N('cuts', 'sequence', 'Cuts on the bars', 280, 1090, {
		delay1: 0, delay2: +(barLen - BEAT_CUE_AT).toFixed(3), delay3: barLen, delay4: 0, pulse: 0.3
	});
	E('cue', 'cuts', 'trigger');
	N('cutwide', 'setcamera', 'Bar 1: Wide', 520, 1040, { camera: '' });
	E('cuts', 'cutwide', 'trigger', 'step1');
	E('selwide', 'cutwide', 'camera');
	N('cutdolly', 'setcamera', 'Bar 2: Dolly', 520, 1160, { camera: '' });
	E('cuts', 'cutdolly', 'trigger', 'step2');
	E('seldolly', 'cutdolly', 'camera');
	// ...and the Dolly TRUCKS for its bar: its own 2 s clip, restarted on the same step
	N('truck', 'playanim', 'Truck the Dolly', 760, 1280, { clip: 'Truck', action: 'restart', speed: 1 });
	E('cuts', 'truck', 'trigger', 'step2');
	E('truck', 'seldolly');
	N('cutdetail', 'setcamera', 'Bar 3: Detail', 520, 1400, { camera: '' });
	E('cuts', 'cutdetail', 'trigger', 'step3');
	E('seldetail', 'cutdetail', 'camera');
	return { nodes, edges };
}

const BEAT_HUD_PANEL = {
	bg: 'rgba(20, 26, 36, 0.92)',
	radius: 16,
	border: '1px solid rgba(180, 142, 173, 0.35)'
};
const BEAT_DEF = {
	kind: 'contest',
	slug: 'follow-the-beat',
	title: 'Follow the beat',
	description:
		'A 120 BPM track, a Conductor whose clip marks every beat and bar, a light that pulses on the beat and three cameras that cut on the bars. Press Start, then make the scene move. ' +
		'Track: "' + BEAT_TRACK.credit.title + '" by ' + BEAT_TRACK.credit.author + ' (freesound, CC0 1.0).',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['contest', 'music', 'animation', 'cameras'],
	env: { preset: 'sunset', exposure: 1 },
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.6, luminanceThreshold: 0.8 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [3, 4, 15], target: [0, 1.6, -0.5] },
	thumb: { camera: 'Wide' },
	// `music` = the scene's track slot (playing OFF: the Start button plays it through the
	// Sound node above, so the editor stays quiet) and the bytes bundled into the .tpscene
	music: BEAT_TRACK,
	objects: [
		{ type: 'box', name: 'Stage', color: 0x2b2f36, size: [16, 0.3, 10], pos: [0, -0.15, 0], roughness: 0.9 },
		{ type: 'cylinder', name: 'Riser', color: 0x3b4252, r: 2.6, h: 0.3, pos: [0, 0.15, -0.5] },
		{ type: 'box', name: 'Backdrop', color: 0x1f2430, size: [16, 6.5, 0.3], pos: [0, 3.1, -5.2] },
		{ type: 'box', name: 'Pillar left', color: 0x434c5e, size: [0.5, 6, 0.5], pos: [-7, 3, -4.5], emissive: 0x88c0d0, emissiveIntensity: 0.35 },
		{ type: 'box', name: 'Pillar right', color: 0x434c5e, size: [0.5, 6, 0.5], pos: [7, 3, -4.5], emissive: 0x88c0d0, emissiveIntensity: 0.35 },
		// a few primitives to animate — the contest is what you do with them
		{ type: 'box', name: 'Bass', color: 0xd08770, size: [1.5, 1.5, 1.5], pos: [-3.6, 0.75, 0.2] },
		{ type: 'cylinder', name: 'Snare', color: 0xebcb8b, r: 0.7, h: 0.5, pos: [0, 0.55, 1.2] },
		{ type: 'cone', name: 'Hat', color: 0xa3be8c, r: 0.6, h: 1.2, pos: [3.6, 0.6, 0.2] },
		{ type: 'sphere', name: 'Pad', color: 0xb48ead, r: 0.9, pos: [0, 2.6, -2.6], emissive: 0x7a5a9e, emissiveIntensity: 0.5 },
		// the beat: a lamp you can see and a light that lights the stage, both pulsed
		{ type: 'sphere', name: 'Beat lamp', color: 0xfff3d6, r: 0.35, pos: [0, 4.6, 0.6], emissive: 0xffd45e, emissiveIntensity: 0.6, shadow: false },
		{ type: 'light', name: 'Beat light', kind: 'point', color: 0xffd9a0, intensity: 6, pos: [0, 4.6, 0.6] },
		// the Conductor: an EMPTY whose clip is the clock (markers, one gentle turn)
		{ type: 'empty', name: 'Conductor', pos: [0, 5.6, 0.6] },
		{ type: 'camera', name: 'Wide', pos: [0, 3.4, 13], lookAt: [0, 1.6, -0.5], fov: 45 },
		// the Dolly faces straight at the backdrop and TRUCKS left-to-right for its bar
		{ type: 'camera', name: 'Dolly', pos: [-4.5, 1.7, 6.5], lookAt: [-4.5, 1.4, -0.5], fov: 40 },
		{ type: 'camera', name: 'Detail', pos: [2.4, 1.3, 3.2], lookAt: [0, 0.6, 1.2], fov: 32 }
	],
	animations: {
		Conductor: {
			active: 'clock',
			changedAt: 0,
			clips: {
				clock: {
					name: 'Beat clock', duration: BEAT_LOOP, loop: 'loop', fps: 30,
					tracks: [{ id: 'turn', channel: 'rot.y', keys: [{ t: 0, v: 0 }, { t: BEAT_LOOP, v: 6.2832 }] }],
					markers: beatMarkers()
				}
			}
		},
		'Beat light': {
			active: 'flash',
			changedAt: 0,
			clips: {
				flash: {
					name: 'Flash', duration: 0.5, loop: 'once',
					tracks: [{ id: 'i', channel: 'light.intensity', keys: [{ t: 0, v: 60, ease: [0.2, 0.6, 0.4, 1] }, { t: 0.45, v: 6 }] }]
				}
			}
		},
		'Beat lamp': {
			active: 'flash',
			changedAt: 0,
			clips: {
				flash: {
					name: 'Flash', duration: 0.5, loop: 'once',
					tracks: [
						{ id: 'glow', channel: 'emissive', keys: [{ t: 0, v: 4 }, { t: 0.45, v: 0.6 }] },
						{ id: 'size', channel: 'scale', keys: [{ t: 0, v: 1.35 }, { t: 0.4, v: 1 }] }
					]
				}
			}
		},
		// position keys are RELATIVE to where the object is (R1): 0 -> 9 trucks 9 m right
		Dolly: {
			active: 'truck',
			changedAt: 0,
			clips: {
				truck: {
					name: 'Truck', duration: 4 * BEAT_SECONDS, loop: 'once',
					tracks: [{ id: 'x', channel: 'pos.x', keys: [{ t: 0, v: 0 }, { t: 4 * BEAT_SECONDS, v: 9 }] }]
				}
			}
		}
	},
	graphs: { scene: beatGraph() },
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
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 320, z: 0, label: '', style: BEAT_HUD_PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -105, w: 440, h: 54, z: 1, label: 'FOLLOW THE BEAT', style: { size: 38, weight: '700', color: '#ebcb8b', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -50, w: 440, h: 48, z: 1, label: 'Press Start: the track plays, the light pulses on every beat and the cameras cut on the bars. Make the scene move with it.', style: { size: 14, color: '#d8dee9', align: 'center' }, wrap: true },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: 30, w: 220, h: 48, z: 1, label: 'Start', enabled: true, style: { size: 17, weight: '600', bg: '#b48ead', color: '#1f2430', radius: 10 } },
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 105, w: 440, h: 40, z: 1, label: 'Judged in play mode from the Wide camera  ·  Esc leaves play', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'play-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 560, h: 20, z: 1, label: 'Wide · Dolly · Detail cut on the bars  ·  Esc to leave play', style: { size: 11, color: '#8b97a8', align: 'center' } }
					]
				}
			]
		}
	},
	contest: {
		brief:
			'Make the scene move with the track: animate objects to the beat, cut between cameras on ' +
			'the bars, add a look. The starter gives you the clock — a **Conductor** whose clip carries ' +
			'a marker on every beat and every bar, a light that pulses on the beat and three cameras ' +
			'that cut on the bars. Open the node editor to see how, then make it yours. Entries are ' +
			'judged in play mode from the **Wide** camera.\n\n' +
			ALL_TOGETHER,
		rules:
			'- Keep the track (it ships inside the scene, CC0).\n' +
			'- Add anything: objects, clips, cameras, a look, a HUD.\n' +
			'- The entry must play from **Start** without any other input.',
		durationDays: 14,
		opensAfterDays: 7,
		judging: CONTEST_JUDGING,
		credits: [BEAT_TRACK.credit]
	}
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
	TOWERS_DEF,
	MIRROR_DEF,
	BEAT_DEF
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
		// 28-G: a def's music is fetched HERE in node (the page has no business reaching a
		// CDN, and the file belongs to no repo); the page hands the bytes to the Explorer,
		// which is what makes them a scene asset the .tpscene bundles.
		const music = def.music ? { ...def.music, b64: (await fetchMusic(def.music)).toString('base64') } : null;
		const out = await page.evaluate(async ({ d, music }) => {
			const s = window.__stores;
			const T = s.THREE;
			s.commandsHandler.sceneCommand('/clear all');
			/** @type {any} */
			let group;
			s.objectsGroup.subscribe((g) => (group = g))();
			/** @param {number} n */
			const hex = (n) => '#' + Number(n).toString(16).padStart(6, '0');
			// 28-G: ONE recursive builder. The four original primitives take exactly the
			// steps they always did, in the same order, so every earlier def is byte-identical.
			// `mirror` reflects across x = 0: position x negated, yaw and roll NEGATED — a
			// reflection flips handedness, and every primitive here is symmetric about its own
			// axes, so the reflected shape is the same primitive posed (rx, -ry, -rz); a spline
			// reflects its points. A ghost's material is faded and it casts no shadow.
			/** @param {any} o @param {{mirror?: boolean, prefix?: string, opacity?: number, shadow?: boolean}} [opts] */
			const build = (o, opts = {}) => {
				const mirror = !!opts.mirror;
				const pos = o.pos ? [mirror ? -o.pos[0] : o.pos[0], o.pos[1], o.pos[2]] : null;
				const rot = o.rot ? [o.rot[0], mirror ? -o.rot[1] : o.rot[1], mirror ? -o.rot[2] : o.rot[2]] : null;
				/** @type {any} */
				let object;
				if (o.type === 'group' || o.type === 'empty') {
					object = new T.Group();
					for (const child of o.children ?? []) object.add(build(child, opts));
				} else if (o.type === 'light') {
					// a point light: a viewpoint's worth of scenery it lights, no shadow map
					object = new T.PointLight(o.color ?? 0xffffff, o.intensity ?? 1, o.distance ?? 0, o.decay ?? 2);
					object.castShadow = false;
				} else if (o.type === 'camera') {
					// the app's OWN marker: /create Camera builds the body and stamps
					// userData.camera (geometries.svelte.js), so a camera authored here is the
					// one a user makes. The create selects + attaches the gizmo — undo that —
					// and aim with the CAMERA convention (-Z forward: Matrix4.lookAt(eye,
					// target, up); Object3D.lookAt on a plain mesh faces +Z, the gotcha).
					s.commandsHandler.sceneCommand('/create Camera');
					s.selectedObject.subscribe((v) => (object = v))();
					/** @type {any} */ let controls;
					s.TControls.subscribe((v) => (controls = v))();
					controls?.detach?.();
					s.objectActions.deselectObject();
					if (o.lookAt && pos) {
						const m = new T.Matrix4().lookAt(new T.Vector3(...pos), new T.Vector3(...o.lookAt), new T.Vector3(0, 1, 0));
						object.quaternion.setFromRotationMatrix(m);
					}
					object.userData.camera = {
						...object.userData.camera,
						...(o.fov ? { fov: o.fov } : {}),
						...(o.aspect ? { aspect: o.aspect } : {})
					};
				} else if (o.type === 'spline') {
					// the record lives in the mesh's frame, re-seated on the centroid (the
					// finishSpline ritual), so the object's origin and gizmo pivot are sane
					const pts = o.points.map((/** @type {any} */ p) => ({ pos: [mirror ? -p.pos[0] : p.pos[0], p.pos[1], p.pos[2]], radius: p.radius }));
					const c = [0, 1, 2].map((i) => pts.reduce((a, /** @type {any} */ p) => a + p.pos[i], 0) / pts.length);
					object = s.splineTool.createSplineMesh(
						{
							points: pts.map((/** @type {any} */ p) => ({ pos: [p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]], radius: p.radius })),
							color: hex(o.color ?? 0xff7b3d),
							closed: !!o.closed
						},
						new T.Vector3(c[0], c[1], c[2])
					);
				} else {
					let geo;
					if (o.type === 'box') geo = new T.BoxGeometry(o.size[0], o.size[1], o.size[2]);
					else if (o.type === 'cylinder') geo = new T.CylinderGeometry(o.r, o.r2 ?? o.r, o.h, 24);
					else if (o.type === 'sphere') geo = new T.SphereGeometry(o.r, 24, 16);
					else if (o.type === 'torus') geo = new T.TorusGeometry(o.r, o.tube ?? o.r * 0.2, 16, 40);
					else geo = new T.ConeGeometry(o.r, o.h, 24);
					const mat = new T.MeshStandardMaterial({
						color: o.color,
						roughness: o.roughness ?? 0.85,
						metalness: o.metalness ?? 0
					});
					// B8: material EMISSIVE + opacity, so a game can glow a pad or float a
					// translucent marker without a shader doc (which the user found "strange").
					// emissiveIntensity multiplies the emissive COLOUR, so both are needed.
					if (o.emissive != null && opts.opacity == null) {
						mat.emissive = new T.Color(o.emissive);
						mat.emissiveIntensity = o.emissiveIntensity ?? 1;
					}
					if (o.opacity != null && o.opacity < 1) {
						mat.transparent = true;
						mat.opacity = o.opacity;
					}
					object = new T.Mesh(geo, mat);
				}
				// a ghost fades WHATEVER it is made of — the spline builds its own material
				// above, so this sits after every branch rather than inside the primitive one
				if (opts.opacity != null && object.material) {
					object.material.transparent = true;
					object.material.opacity = opts.opacity;
				}
				object.name = (opts.prefix ?? '') + o.name;
				if (pos && o.type !== 'spline') object.position.set(pos[0], pos[1], pos[2]);
				if (rot) object.rotation.set(rot[0], rot[1], rot[2]);
				if (o.physics && !mirror) object.userData.physics = o.physics;
				if (o.shadow === false || opts.shadow === false) {
					// shadowDefaults sweeps cast/receive back ON unless the object opts out
					object.castShadow = false;
					object.receiveShadow = false;
					object.userData.shadow = false;
				}
				// toJSON reads the MATRIX the last render composed (the serializer
				// gotcha) — compose it now, we export before any frame runs
				object.updateMatrix();
				return object;
			};
			for (const o of d.objects) {
				if (o.type === 'mirror') {
					const src = d.objects.find((/** @type {any} */ x) => x.name === o.of);
					if (!src) throw new Error('mirror: no object named "' + o.of + '"');
					const ghost = new T.Group();
					ghost.name = o.name;
					const kids = src.type === 'group' ? src.children ?? [] : [src];
					for (const child of kids) ghost.add(build(child, { mirror: true, opacity: o.opacity ?? 0.15, prefix: o.prefix ?? '', shadow: false }));
					ghost.userData.shadow = false;
					ghost.updateMatrix();
					group.add(ghost);
					continue;
				}
				group.add(build(o));
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
			// 28-G: nested objects too (a group's children), top level winning a name clash
			group.traverse((c) => {
				if (c !== group && c.name && !named[c.name]) named[c.name] = c.uuid;
			});
			// 28-G: AUTHORED CLIPS, keyed by def-local object name -> the uuid just minted.
			// Through animationsRestore, the app's own read path, so a def's clip is exactly
			// what the Animation window would have saved (normalizeClip runs on the way in).
			if (d.animations && s.animationPreview) {
				/** @type {Record<string, any>} */
				const sets = {};
				for (const [key, set] of Object.entries(d.animations)) {
					if (!named[key]) throw new Error('animations: no object named "' + key + '"');
					sets[named[key]] = set;
				}
				s.animationPreview.animationsRestore(sets, false);
			}
			// 28-G: THE TRACK. Into the Explorer (content-hashed, so re-runs dedupe) and into
			// the scene's music slot with playing OFF — the graph plays it from Start. The
			// hash is what a Sound node addresses, hence the `'$music'` remap below.
			if (music && s.explorer && s.sceneMusic) {
				const bin = Uint8Array.from(atob(music.b64), (ch) => ch.charCodeAt(0));
				const item = await s.explorer.addItemFromBytes(bin.buffer, music.name, null, { imported: true });
				named['$music'] = item.hash;
				s.sceneMusic.commitMusic({ hash: item.hash, name: music.name, volume: music.volume ?? 0.8, playing: false, startedAt: 0 });
			}
			// 28-G: the editor camera the file opens on (buildSessionPayload saves it). BOTH
			// the camera and the orbit target, or OrbitControls.update() reverts the move.
			if (d.view) {
				/** @type {any} */ let cam;
				/** @type {any} */ let controls;
				s.globalCamera.subscribe((v) => (cam = v))();
				s.orbitControls.subscribe((v) => (controls = v))();
				if (cam) cam.position.set(d.view.pos[0], d.view.pos[1], d.view.pos[2]);
				if (controls?.target) {
					controls.target.set(d.view.target[0], d.view.target[1], d.view.target[2]);
					controls.update?.();
				}
			}
			if (d.graphs) {
				const grid = (i) => ({ x: 40 + (i % 4) * 220, y: 40 + Math.floor(i / 4) * 140 });
				// a node's object reference may be a def-local NAME: `uuid` on effect/anim
				// nodes, `selected` on an Object Selector (B8 — the selector is how every
				// trigger and action names its target, so a game graph is mostly selectors)
				const remapData = (data) => {
					const out = { ...(data ?? {}) };
					if (out.uuid && named[out.uuid]) out.uuid = named[out.uuid];
					if (out.selected && named[out.selected]) out.selected = named[out.selected];
					// 28-G: `camera` on setcamera/gamestart/setlook, and the track's hash
					if (out.camera && named[out.camera]) out.camera = named[out.camera];
					if (out.hash === '$music' && named['$music']) out.hash = named['$music'];
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
			// 28-G: a def with music exports WITH assets — the track rides the .tpscene
			// (sceneAssetList lists the music hash and the Sound node's, one blob for both)
			const bytes = await s.sessions.exportSessionZip(payload, { assets: !!music, packs: false, flow: true });

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
				let camera = new T.PerspectiveCamera(40, 480 / 270, size / 100, size * 10);
				camera.position.copy(center).add(new T.Vector3(size * 0.55, size * 0.42, size * 0.72));
				camera.lookAt(center);
				// 28-G: `thumb.camera` renders the card THROUGH a named camera object — the
				// hero shot the def already authored — instead of the fitted 3/4 view. Camera
				// markers are chrome, not scenery, so they stay out of that picture.
				const hero = d.thumb?.camera ? group.getObjectByName(d.thumb.camera) : null;
				if (hero) {
					group.updateMatrixWorld(true);
					const spec = hero.userData?.camera ?? {};
					camera = new T.PerspectiveCamera(spec.fov ?? 50, 480 / 270, spec.near ?? 0.1, spec.far ?? 1000);
					hero.getWorldPosition(camera.position);
					hero.getWorldQuaternion(camera.quaternion);
					clone.traverse((/** @type {any} */ n) => {
						if (n.userData?.camera) n.visible = false;
					});
				}
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
			// 28-G: the clips and the track slot too (the Explorer keeps the bytes — it is a
			// library, and the hash dedupes a re-run; nothing of it reaches the next def)
			if (s.animationPreview) s.animationPreview.animationsRestore({}, false);
			if (s.sceneMusic) s.sceneMusic.musicRestore(null, false);
			return { bytes: Array.from(bytes), thumb };
		}, { d: def, music });
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
					games: prev.games ?? [],
					// 28-G: contests is OPTIONAL (the games rule) — carried only when the
					// file already has it, so an index without contests stays byte-identical
					...(Array.isArray(prev.contests) ? { contests: prev.contests } : {})
				};
			} catch {
				console.log('  WARN existing index.json unreadable — rebuilding it from this run');
			}
		}
		for (const def of defs) {
			const section =
				def.kind === 'template' ? 'templates' : def.kind === 'game' ? 'games' : def.kind === 'contest' ? 'contests' : 'examples';
			const row = {
				...writeDef(path.join(REPO_OUT, section), def),
				scene: `${section}/${def.slug}/scene.tpscene`,
				thumb: built[def.slug].thumb ? `${section}/${def.slug}/thumb.webp` : '',
				// 28-G: a contest row points at its text, beside the starter it describes
				...(def.kind === 'contest' ? { contest: `${section}/${def.slug}/contest.json` } : {})
			};
			if (def.kind === 'contest') writeContestJson(path.join(REPO_OUT, section, def.slug, 'contest.json'), def);
			// the section array is created on first use — `contests` only exists once a
			// contest def has run, so every other index keeps its exact shape
			const rows = (index[section] ??= []);
			const at = rows.findIndex((/** @type {any} */ r) => r.slug === def.slug);
			if (at === -1) rows.push(row);
			else rows[at] = row;
		}
		fs.mkdirSync(REPO_OUT, { recursive: true });
		fs.writeFileSync(indexPath, JSON.stringify(index, null, '\t') + '\n');
		console.log(`scenes repo tree -> ${REPO_OUT}`);
	}
})();
