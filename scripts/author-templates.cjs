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
//
// ==== THE DEF SCHEMA (30 author-kit) — every field, one line each ======================
// Colours are 0xRRGGBB numbers or '#rrggbb' strings; positions/rotations are [x, y, z]
// (rotation in radians, Euler XYZ); lengths in metres. Every field is OPTIONAL unless marked *;
// an absent field is the old behaviour, so a def only states what it means to change.
//
// DEF (the file / the card):
//   kind*            'template' | 'example' | 'game' | 'contest' — decides the folder + index section
//   slug* title* description   identity + card text; author, license ('CC0-1.0'), tags []
//   modules          [{id, version}] — the card's module list (games only; must match installModules)
//   installModules   ['<id>'] — zips installed from MODULES_REPO before the build (the game shows)
//   generate         a /command, {menu, moduleId?, waitMs?}, or a list of them — run after the build
//   generateWaitMs   default wait after each generate step (2500)
//   layout           [{kind, index?, pos, yaw?}] — place generated devices by userData.device.kind
//   objects*         the scene: OBJECTS below
//   env              '<preset>' | {preset, exposure} | a CUSTOM sky (ENV below)
//   gravity          number (m/s², negative = down) · physics — a scenePhysics block, merged
//   post             a scenePost document (effects: AO, tone mapping, bloom, SMAA, ...)
//   graphs           {'scene' | <object name>: {nodes, edges}} — node data strings naming a def
//                    object become its uuid (not label/format/text/placeholder/name); '$music' and
//                    '$sound:<key>' become content hashes
//   hud              a hudDocs map · shaders {'scene' | <object name>: shader graph document}
//   animations       {<object name>: an authored animation set (clips of tracks of keys)}
//   music            {url | file, sha256, name, volume?} — the scene's background track (+ Explorer)
//   sounds           [{key, url | file, sha256, name}] — one-shot assets for Sound nodes
//   view             {pos, target} — the editor camera the file opens on (also the card's camera)
//   thumb            {camera?: <camera object name>, sceneGroups?: ['<scene-root group>'],
//                     toneMapping?: 'agx'|'aces'|'neutral'|'reinhard'|'cineon'|'linear'|'none'}
//   contest          (kind contest) {brief, rules, durationDays, opensAfterDays, judging, credits}
//
// OBJECTS — {type*, name*, pos?, rot?, ...}:
//   box              size [w, h, d]; bevel (radius → a ROUNDED box, baked), bevelSegments (3)
//   sphere           r                  · cylinder  r (top), r2 (bottom, = r), h
//   cone             r, h               · torus     r, tube (r × 0.2)
//   capsule          r, h (the straight part; `length` alias)
//   plane            size [w, h] — faces +Z (rot [-π/2, 0, 0] to lie flat)
//   ring             r (outer), inner (r × 0.5) — a flat annulus facing +Z
//   icosahedron / dodecahedron   r, detail (0)
//   light            kind 'point' (default: color, intensity, distance, decay — no shadow)
//                    | 'spot' (angle π/6, penumbra 0.3, distance, decay, target) | 'directional'
//                    (target; its shadow frustum is FITTED to the built meshes — `fit: false` to
//                    keep three's) | 'hemisphere' (color = sky, groundColor, intensity).
//                    spot/directional: castShadow (true), shadowMapSize, `target` = a WORLD point
//                    aimed by rotation — place a directional OUTSIDE the scene on its sun side
//   camera           lookAt, fov, aspect — the app's own /create Camera marker
//   spline           points [{pos, radius}], closed, color
//   group / empty    children [objects] (names resolve inside groups too)
//   mirror           of (a named object/group), opacity (0.15), prefix — reflected across x = 0
// MATERIAL (every mesh type): color, roughness (0.85), metalness (0), emissive +
//   emissiveIntensity (1), opacity (< 1 → transparent), flatShading, side ('double' | 'back'),
//   toon (MeshToonMaterial), physical (MeshPhysicalMaterial — also implied by any of:
//   clearcoat, clearcoatRoughness, transmission, thickness, ior, sheen, sheenColor,
//   sheenRoughness, iridescence, specularIntensity)
// FLAGS (any object): physics {mode, mass, restitution, friction, ...} (userData.physics) ·
//   shadow false (no cast/receive) · pick 'through' (select-through shells: walls, glass) ·
//   origin [x, y, z] (the local pivot a Door preset swings about) · anim '<preset>' | [..]
//   (door, drawer, elevator, turntable, pulse, fade — key or name; an AUTHORED clip, run it with
//   a Play Animation node) · particles '<preset>' | {preset, ...overrides} (sparkles, fire,
//   smoke, dust, confetti, sparks)
// ENV — a custom sky: {preset: 'custom' | '<preset>', base?: '<preset>', exposure,
//   background: '#hex' | {top, bottom} (a gradient; `background` keeps the bottom colour),
//   fog: {color, near, far} | null, ground: {color, roughness?} (a solid ground disc that takes
//   the shadows), sun: {color, intensity, dir (FROM the scene TOWARD the sun) | position} | null,
//   hemi: {sky, ground, intensity} | null}. Any of those keys (or preset 'custom') builds a custom
//   payload from the base preset (default: the named preset, else studio); exposure is applied once.
// LOADER FLAGS: --out <dir> (scenes-repo tree + index.json) · --only <slug,..> (a subset, index
//   MERGED) · --def <file.json,..> (defs from JSON; a same-slug def REPLACES the built-in one) ·
//   env APP_URL, MODULES_REPO (the sibling modules checkout: zips + modules/<id>/<id>.def.json)
// THE CARD: rendered with the scene's own look (background, fog, environment rig, authored
//   lights, shadows), the post stack's tone curve else none, through thumb.camera, else view,
//   else a 3/4 fit of the content (floor slabs excluded); the private studio pair only lights a
//   scene with no light at all.
//
// 24-A A3 (the PR #192 follow-up): the node/edge helpers are ONE module-scope
// `graphBuilder()` and `remapData` walks every own string field. Both are meant to leave
// every earlier def byte-identical, and that is CHECKED, not believed — build the same def
// with the script before and after the change and compare the two trees:
//
//   APP_URL=https://theprototype.app:5177/ node scripts/author-templates.cjs --only towers --out /tmp/towers-before
//   (edit)  APP_URL=https://theprototype.app:5177/ node scripts/author-templates.cjs --only towers --out /tmp/towers-after
//   node scripts/compare-authored.cjs /tmp/towers-before /tmp/towers-after
//
// compare-authored.cjs unzips each .tpscene, strips what a build mints afresh every run
// (`changedAt`/`createdAt`/`at` stamps, the session uuid, and every object uuid — replaced
// by its order of first appearance, so the graph's remapped references still have to
// agree) and diffs the rest; the thumbnails are compared by size only (an offscreen render
// is not bit-stable across GPU drivers).
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
// 24-B: a def a MODULE owns lives in that module's own folder, emitted by its build
// (`npm run build:football` writes modules/football/football.def.json from the same
// source the module's own flight runs), so the def and the module cannot drift. Read it
// from the sibling checkout like the zips; null when that checkout does not have it.
function moduleDef(id) {
	const file = path.join(MODULES_REPO, 'modules', id, id + '.def.json');
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
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
// 30 author-kit: `--def <file.json[,file.json]>` adds defs from JSON files — each file holds
// ONE def or an ARRAY of them. A file def whose slug matches a DEFS entry REPLACES it (so a
// lane can iterate on a def without editing DEFS); any other slug is appended. Combine with
// `--only <slug>` to author just that def. This is also how the author-kit suite authors its
// def-under-test into a scratch folder.
const defFlag = process.argv.indexOf('--def');
const FILE_DEFS =
	defFlag !== -1
		? String(process.argv[defFlag + 1] ?? '')
				.split(',')
				.filter(Boolean)
				.flatMap((file) => {
					const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
					return Array.isArray(parsed) ? parsed : [parsed];
				})
		: [];

// ---- declarative scene definitions ------------------------------------------
// objects: {type:'box'|'cylinder'|'sphere'|'cone', name, color, pos, rot?, ...dims,
//           physics?} — physics = the userData.physics schema
//           {mode:'static'|'dynamic', mass, restitution, friction}.
const gray = { floor: 0x8b939c, block: 0xaab2bd, wall: 0x99a3ae, accent: 0xd97706 };

// ---- 24-A A3: the ONE graph builder every def authors its nodes through -----------
// Hoisted from towersGraph()/beatGraph(), which each carried a local copy (PR #192's
// review asked for this the moment a second game arrived). Byte-identical output: the
// `class: 'w-[150px]'`, the label rule (a programmatic node with no label renders a blank
// card) and the editor's CANONICAL edge id — `e-<source>[.<sourceHandle>]-<target>
// [.<targetHandle>]` (Nodes.svelte / hudActions.makeEdge) — which peer dedupe depends on.
// The E signature is the beat graph's superset: a Sequence step is a SOURCE handle, and a
// three-argument call (every Towers edge) produces exactly the id it always did.
function graphBuilder() {
	/** @type {any[]} */ const nodes = [];
	/** @type {any[]} */ const edges = [];
	/** every node gets a LABEL — a programmatic node with none renders a blank card.
	 * @param {string} id @param {string} type @param {string} label @param {number} x @param {number} y @param {any} data */
	const N = (id, type, label, x, y, data) => {
		nodes.push({ id, type, position: { x, y }, data: { label, ...data }, class: 'w-[150px]' });
		return id;
	};
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
	return { N, E, nodes, edges, done: () => ({ nodes, edges }) };
}

// 24-A A3: the node-data keys that are HUMAN TEXT and must never be remapped, even when
// their value happens to equal a def-local object's name — a HUD text whose format is
// literally "Build pad" must stay text, and a variable NAMED like an object is a name.
const HUMAN_TEXT_KEYS = new Set(['label', 'format', 'text', 'placeholder', 'name']);

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
	const g = graphBuilder();
	const { N, E } = g;

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
	// 30: Round over offers Play again beside Menu — the Restart chain above, from `over`
	N('breplay', 'hudbutton', 'Play again button', 40, 875, { element: 'replay-btn' });
	E('breplay', 'restartreset', 'trigger');
	E('breplay', 'restartdelay', 'trigger');

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
	// ---- 30: the BEST HEIGHT, saved on THIS device (Store Value / Stored Value) --------
	// Stored on every ring crossing, never on `over`: a perRound latch READS un-set the
	// instant the round ends (the Infinity cutoff), so an `over` edge would store 0 — and
	// that is also why the old Round-over line read "0 m" every time. `towers-last` is the
	// same number for THIS round: `max` too (a crate jittering in a ring sensor re-fires
	// the crossing after the round ends, when the height reads 0 — a `set` would wipe it),
	// zeroed by its own `set` node when a round starts. Keys are game-specific because a
	// Games-tab load leaves the scene unnamed, so every template shares tp:scene:untitled:*.
	N('storebest', 'storevalue', 'Save best height', 1720, 1030, { key: 'towers-best', mode: 'max', value: 0 });
	N('storelast', 'storevalue', 'Save this round', 1720, 1180, { key: 'towers-last', mode: 'max', value: 0 });
	E('mxall', 'storebest', 'value');
	E('mxall', 'storelast', 'value');
	for (let i = 1; i <= 4; i++) {
		E('enr' + i, 'storebest', 'trigger');
		E('enr' + i, 'storelast', 'trigger');
	}
	N('onround', 'ongamestate', 'When a round starts', 1480, 1330, { state: 'playing', edge: 'enter', pulse: 0.3 });
	N('zerolast', 'storevalue', 'New round: zero it', 1720, 1330, { key: 'towers-last', mode: 'set', value: 0 });
	E('onround', 'zerolast', 'trigger');
	N('storedbest', 'storedvalue', 'My best height', 1960, 1030, { key: 'towers-best', output: 'number', fallback: 0 });
	N('hbest', 'hudtext', 'HUD best (menu)', 2200, 980, { element: 'best-read', format: 'Your best tower: {v} m', decimals: 0, value: 0 });
	E('storedbest', 'hbest', 'value');
	N('hbest2', 'hudtext', 'HUD best (over)', 2200, 1100, { element: 'over-best', format: 'Best ever: {v} m', decimals: 0, value: 0 });
	E('storedbest', 'hbest2', 'value');
	N('storedlast', 'storedvalue', 'This round', 1960, 1180, { key: 'towers-last', output: 'number', fallback: 0 });
	N('hfinal', 'hudtext', 'HUD final height', 2200, 1220, { element: 'final-height', format: 'This round: {v} m', decimals: 0, value: 0 });
	E('storedlast', 'hfinal', 'value');
	// ---- 30b: the rings are MILESTONES. The first crossing of a ring in a round (a perRound
	// Once — a crate re-entering the sensor must not re-announce) tells every player: a banner,
	// a burst AT the ring, a chime from the ring, and a success buzz in VR. The gold ring at
	// the top is the big one: confetti, the level-up fanfare, "Top of the tower!". The Game
	// Feel nodes are LOCAL on every peer from the replicated stamp, so no message of their own.
	// (It replaces 30's particle emitter on the pad: the burst pool costs no emitter slot.)
	N('buzzring', 'hapticpulse', 'Buzz: a ring reached', 1720, 1480, { pattern: 'success', hand: 'both' });
	for (let i = 1; i <= 4; i++) {
		const y = 960 + (i - 1) * 150;
		const top = i === 4;
		N('first' + i, 'once', 'First time at ' + i + 'm', 2440, y, { perRound: true, pulse: 0.3 });
		E('enr' + i, 'first' + i, 'trigger');
		N('say' + i, 'announce', top ? 'Say: top!' : 'Say: ring ' + i, 2680, y, top
			? { text: 'Top of the tower!', sub: '4 m — the gold ring', seconds: 2.6, color: '#ffc640', decimals: 0 }
			: { text: 'Ring ' + i + ' reached', sub: i + ' m — keep stacking', seconds: 1.8, color: '#9ee6ff', decimals: 0 });
		E('first' + i, 'say' + i, 'trigger');
		N('fx' + i, 'effectburst', 'Burst at ring ' + i, 2920, y, { kind: top ? 'confetti' : 'sparkle', count: top ? 96 : 56, lift: 0, color: '' });
		E('first' + i, 'fx' + i, 'trigger');
		E('selr' + i, 'fx' + i, 'at');
		N('chime' + i, 'gamesound', top ? 'Fanfare at the top' : 'Chime at ring ' + i, 3160, y, { sound: top ? 'levelup' : 'ring' });
		E('first' + i, 'chime' + i, 'trigger');
		E('selr' + i, 'chime' + i, 'at');
		E('first' + i, 'buzzring', 'trigger');
	}
	N('topsparkle', 'effectburst', 'Sparkle at the top', 2920, 1560, { kind: 'sparkle', count: 80, lift: 0.4, color: '#ffe08a' });
	E('first4', 'topsparkle', 'trigger');
	E('selr4', 'topsparkle', 'at');

	// ---- the stars — collectible-module touch pickups (shared team score) -------
	for (let i = 1; i <= 3; i++) {
		const y = 1600 + (i - 1) * 150;
		N('colstar' + i, 'collectible', 'Star ' + i + ' pickup', 40, y, {
			variable: 'stars', scope: 'shared', trigger: 'touch', radius: 1.4,
			respawn: 0, hide: 'on', perRound: true, whilePlaying: true
		});
		N('selstar' + i, 'objectselector', 'Star ' + i, 280, y, { selected: 'Star ' + i });
		E('colstar' + i, 'selstar' + i);
		// 30: every star turns and breathes once a round starts (its authored `Star glow`
		// clip: the Turntable + Pulse presets in ONE clip, since a transport plays one clip
		// per object). Through a zero-second Delay: Play Animation reads a trigger VALUE and
		// On Game State carries only a stamp (the beat-graph finding).
		N('glow' + i, 'playanim', 'Star ' + i + ' glow', 1240, y, { clip: 'Star glow', action: 'restart', speed: 1 });
		E('glowpulse', 'glow' + i, 'trigger');
		E('glow' + i, 'selstar' + i);
	}
	N('glowpulse', 'delay', 'Round start pulse (0 s)', 1000, 1560, { seconds: 0, pulse: 0.3 });
	E('onround', 'glowpulse', 'trigger');
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
	N('hclock', 'hudtext', 'HUD clock', 280, 2040, { element: 'clock', format: 'Time: {v}s', decimals: 0, value: 0 });
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

	// ---- 30b: the round's sound, and the crates' ------------------------------------------
	// Music: the arcade loop while you are in the game (Interact or Play; never the editor).
	N('music', 'gamemusic', 'Arcade music', 40, 2480, { preset: 'arcade', volume: 0.45, while: 'always' });
	// Every menu button clicks.
	N('click', 'gamesound', 'Button click', 280, 2480, { sound: 'click' });
	for (const b of ['bstart', 'bagain', 'bresume', 'brestart', 'bquit', 'breplay']) E(b, 'click', 'trigger');
	// A round starts with a whistle and a banner; it ends with one of two.
	N('saygo', 'announce', 'Say: build!', 1720, 1640, { text: 'Build!', sub: 'Stack crates on the glowing pad — reach the gold ring', seconds: 2.2, color: '#ffd45e', decimals: 0 });
	E('onround', 'saygo', 'trigger');
	N('whistle', 'gamesound', 'Round start whistle', 1720, 1720, { sound: 'whistle' });
	E('onround', 'whistle', 'trigger');
	N('saywin', 'announce', 'Say: all stars', 1240, 2000, { text: 'All stars collected!', sub: '', seconds: 2.4, color: '#ffc640', decimals: 0 });
	E('allwin', 'saywin', 'trigger');
	N('cheer', 'gamesound', 'Cheer', 1240, 2080, { sound: 'cheer' });
	E('allwin', 'cheer', 'trigger');
	N('confetti', 'effectburst', 'Confetti for everyone', 1240, 2160, { kind: 'confetti', count: 96, lift: 0, color: '' });
	E('allwin', 'confetti', 'trigger');
	N('sayup', 'announce', "Say: time's up", 1240, 2300, { text: "Time's up!", sub: '', seconds: 2.2, color: '#e5e9f0', decimals: 0 });
	E('alltime', 'sayup', 'trigger');
	N('upwhistle', 'gamesound', 'Final whistle', 1240, 2380, { sound: 'whistle' });
	E('alltime', 'upwhistle', 'trigger');
	// Each crate: a pop when a player lifts it (On Grab) and a knock when it lands on
	// something (On Impact past a gentle landing), both placed AT the crate.
	TOWERS_CRATES.forEach((name, k) => {
		const y = 2560 + k * 110;
		N('csel' + k, 'objectselector', name, 280, y, { selected: name });
		N('cgrab' + k, 'ongrab', name + ' grabbed', 40, y, { pulse: 0.3 });
		E('cgrab' + k, 'csel' + k);
		N('cpop' + k, 'gamesound', name + ' lift', 520, y, { sound: 'pop' });
		E('cgrab' + k, 'cpop' + k, 'trigger');
		E('csel' + k, 'cpop' + k, 'at');
		N('cland' + k, 'onimpact', name + ' lands', 760, y, { pulse: 0.3, minStrength: 0.8 });
		E('cland' + k, 'csel' + k);
		N('cknock' + k, 'gamesound', name + ' knock', 1000, y, { sound: 'hit' });
		E('cland' + k, 'cknock' + k, 'trigger');
		E('csel' + k, 'cknock' + k, 'at');
	});

	return g.done();
}
/** the nine crates the sound chains above name (the objects below) */
const TOWERS_CRATES = ['Cube 1', 'Cube 2', 'Cube 3', 'Cube 4', 'Cube 5', 'Cube 6', 'Plank 1', 'Plank 2', 'Plank 3'];

const TOWERS_HUD_PANEL = {
	bg: 'rgba(14, 20, 32, 0.9)',
	radius: 18,
	border: '1px solid rgba(255, 212, 94, 0.28)'
};
const TOWERS_BTN = { size: 17, weight: '600', bg: '#3b7dd8', color: '#ffffff', radius: 10 };
// 30: the finished look. Crates read as WOOD (a physical material with a sheen and a thin
// clearcoat, chamfered edges), the floor carries a subtle 2 m tile from a shader graph, the
// walls are chamfered with a glowing trim, and the height markers are thin glowing rings
// beside a marked pole instead of stacked translucent squares.
const TOWERS_WOOD = { physical: true, roughness: 0.6, sheen: 0.4, sheenColor: 0xffd7a0, sheenRoughness: 0.55, clearcoat: 0.12, clearcoatRoughness: 0.5 };
const TOWERS_CRATE = { mode: 'dynamic', mass: 1, friction: 0.8, restitution: 0.03 };
const TOWERS_PLANK = { mode: 'dynamic', mass: 0.9, friction: 0.8, restitution: 0.03 };
/** a chamfered wooden crate (bevelSegments 1 keeps the baked geometry small)
 * @param {string} name @param {number} color @param {number[]} size @param {number[]} pos @param {any} physics */
const towersCrate = (name, color, size, pos, physics) => ({ type: 'box', name, color, size, bevel: 0.045, bevelSegments: 1, pos, ...TOWERS_WOOD, physics });
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
/** the Turntable + Pulse presets folded into ONE clip (a transport plays one clip per
 * object): a turn every 6 s, a breath every 1.5 s — scale and glow together */
const STAR_GLOW_CLIP = {
	active: 'glow',
	changedAt: 0,
	clips: {
		glow: {
			name: 'Star glow',
			duration: 6,
			loop: 'loop',
			tracks: [
				{ id: 'turn', channel: 'rot.y', keys: [{ t: 0, v: 0 }, { t: 6, v: 6.2832 }] },
				{
					id: 'breathe',
					channel: 'scale',
					keys: [0, 1.5, 3, 4.5, 6].flatMap((t, i, all) =>
						i < all.length - 1
							? [{ t, v: 1, ease: [0.42, 0, 0.58, 1] }, { t: t + 0.75, v: 1.18, ease: [0.42, 0, 0.58, 1] }]
							: [{ t, v: 1 }]
					)
				},
				{
					id: 'shine',
					channel: 'emissive',
					keys: [0, 1.5, 3, 4.5, 6].flatMap((t, i, all) =>
						i < all.length - 1 ? [{ t, v: 1.6 }, { t: t + 0.75, v: 3.2 }] : [{ t, v: 1.6 }]
					)
				}
			]
		}
	}
};
const TOWERS_DEF = {
	kind: 'game',
	slug: 'towers',
	title: 'Towers',
	description:
		'Co-op crate stacking: grab the wooden crates, build the tallest tower on the glowing pad, climb to the stars. Your best height is saved. Press P to pause or restart.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['physics', 'stacking', 'co-op', 'vr'],
	modules: [{ id: 'collectible', version: '1.1.2' }],
	installModules: ['collectible'],
	// 30: daylight under a real sky — a blue-to-haze gradient, a far fog that softens the
	// horizon, and a solid ground disc around the arena (the infinite grid is editor chrome;
	// it no longer shows in Play). Exposure above the 0.9 floor.
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#4a7fc0', bottom: '#dbe8f2' },
		// 30 integrate: the fog closes in past the arena wall, so the ground beyond the edge
		// fades into the sky's own haze instead of ending in a flat olive band
		fog: { color: '#dbe8f2', near: 16, far: 75 },
		ground: { color: '#7b8866', roughness: 0.95 }
	},
	// ground ON — a solid floor the crates rest on. A crate knocked past the low wall
	// falls to the bounds limit and RESPAWNS to its start pose (beforeStates), so the
	// supply cannot be lost. Grab interaction, sim starts on Play.
	physics: {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0 },
		bounds: { limit: -20, action: 'respawn' },
		material: { friction: 0.7, restitution: 0.05 },
		damping: { linear: 0.05, angular: 0.3 },
		// 30b: a SPAWN — Play (and Interact in VR) puts you 4.5 m in front of the pad, facing
		// it, with a podium on each hand (yaw 0 faces -Z)
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [0, 0, 4.5], yaw: 0 } }
	},
	// the shell floor (fork 11): ao -> AgX -> bloom -> smaa, bloom a touch higher so the
	// rings, the trim and the pad read as light
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
	view: { pos: [7.5, 6.5, 12.5], target: [0, 1.4, 0] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: towersGraph() },
	shaders: { 'Arena floor': TOWERS_FLOOR_SHADER },
	animations: { 'Star 1': STAR_GLOW_CLIP, 'Star 2': STAR_GLOW_CLIP, 'Star 3': STAR_GLOW_CLIP },
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
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 500, h: 460, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -176, w: 420, h: 54, z: 1, label: 'TOWERS', style: { size: 42, weight: '700', color: '#ffd45e', align: 'center' } },
						// 30b: HOW TO PLAY, said once, plainly — the goal, the milestones, the clock
						{ id: 'howto-title', kind: 'text', anchor: 'center', x: 0, y: -132, w: 440, h: 20, z: 1, label: 'HOW TO PLAY', style: { size: 12, weight: '700', color: '#9ee6ff', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -94, w: 450, h: 60, z: 1, label: 'Grab crates from the podiums and stack them on the glowing pad. Each ring your tower reaches is a milestone — the gold ring at 4 m is the top. Touch the three floating stars. Three minutes a round.', style: { size: 14, color: '#d8dee9', align: 'center' }, wrap: true },
						{ id: 'best-read', kind: 'text', anchor: 'center', x: 0, y: -44, w: 420, h: 24, z: 1, label: 'Your best tower: 0 m', style: { size: 15, weight: '600', color: '#9ee6ff', align: 'center' } },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: 14, w: 240, h: 50, z: 1, label: 'Start round', enabled: true, style: TOWERS_BTN },
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 88, w: 460, h: 36, z: 1, label: 'Desktop: hold click to grab  ·  wheel pushes/pulls  ·  Q/E fly  ·  P pause', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true },
						{ id: 'menu-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 128, w: 460, h: 36, z: 1, label: 'VR: grip grabs a crate  ·  left stick walks  ·  Y switches to Edit mode', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'height-read', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 280, h: 30, z: 1, label: '', style: { size: 20, weight: '700', color: '#ffffff', align: 'center' } },
						{ id: 'clock', kind: 'text', anchor: 'top-center', x: 0, y: 48, w: 120, h: 22, z: 1, label: '', style: { size: 13, weight: '600', color: '#e5e9f0', align: 'center' } },
						{ id: 'stars-read', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 200, h: 24, z: 1, label: '', style: { size: 15, weight: '600', color: '#ffd45e', align: 'right' } },
						{ id: 'play-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 520, h: 20, z: 1, label: 'Stack on the glowing pad — the rings mark your height.  Press P to pause.', style: { size: 11, color: '#e5e9f0', align: 'center' } }
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
						{ id: 'restart-btn', kind: 'button', anchor: 'center', x: 0, y: 22, w: 240, h: 42, z: 1, label: 'Restart round', enabled: true, style: { ...TOWERS_BTN, size: 16, bg: '#4c9e6a' } },
						{ id: 'quit-btn', kind: 'button', anchor: 'center', x: 0, y: 74, w: 240, h: 42, z: 1, label: 'Quit to menu', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				},
				{
					id: 'over',
					name: 'Round over',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 440, h: 320, z: 0, label: '', style: TOWERS_HUD_PANEL },
						{ id: 'over-title', kind: 'text', anchor: 'center', x: 0, y: -104, w: 400, h: 40, z: 1, label: 'ROUND OVER', style: { size: 30, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'final-height', kind: 'text', anchor: 'center', x: 0, y: -56, w: 400, h: 28, z: 1, label: '', style: { size: 18, weight: '600', color: '#e5e9f0', align: 'center' } },
						{ id: 'over-best', kind: 'text', anchor: 'center', x: 0, y: -24, w: 400, h: 22, z: 1, label: '', style: { size: 14, color: '#9ee6ff', align: 'center' } },
						{ id: 'replay-btn', kind: 'button', anchor: 'center', x: 0, y: 40, w: 240, h: 46, z: 1, label: 'Play again', enabled: true, style: TOWERS_BTN },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: 0, y: 96, w: 240, h: 42, z: 1, label: 'Menu', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
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
		// build pad — glowing blue under a clearcoat, SUNK so its bottom face is not coplanar
		// with the floor, a bright rim, and a soft blue light spilling onto the tiles
		{ type: 'cylinder', name: 'Build pad', color: 0x2f6fbf, r: 1.7, h: 0.24, pos: [0, 0.08, 0], emissive: 0x2f8fff, emissiveIntensity: 1.1, physical: true, roughness: 0.3, clearcoat: 0.8, physics: { mode: 'static', friction: 1 } },
		{ type: 'torus', name: 'Pad rim', color: 0xbfefff, r: 1.72, tube: 0.045, pos: [0, 0.2, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x7fdcff, emissiveIntensity: 3, shadow: false },
		{ type: 'light', name: 'Pad glow', kind: 'point', color: 0x5fb4ff, intensity: 4, distance: 7, pos: [0, 0.7, 0] },
		// podiums where the crate supply sits, sunk into the floor by the same trick
		{ type: 'cylinder', name: 'Cube podium', color: 0x5d6879, r: 1.1, h: 0.5, pos: [-5.5, 0.2, 0], physical: true, metalness: 0.1, roughness: 0.4, clearcoat: 0.5, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'cylinder', name: 'Plank podium', color: 0x5d6879, r: 1.1, h: 0.5, pos: [5.5, 0.2, 0], physical: true, metalness: 0.1, roughness: 0.4, clearcoat: 0.5, physics: { mode: 'static', friction: 0.9 } },
		// PRE-PLACED wooden crates: a tidy supply that rests until grabbed, then stays put.
		// Cubes on the left podium (podium top ~0.45; stack from just above it).
		towersCrate('Cube 1', 0xb57a45, [0.6, 0.6, 0.6], [-5.5, 0.85, 0], TOWERS_CRATE),
		towersCrate('Cube 2', 0xc28d55, [0.6, 0.6, 0.6], [-5.5, 1.5, 0], TOWERS_CRATE),
		towersCrate('Cube 3', 0xa86d3c, [0.6, 0.6, 0.6], [-5.5, 2.15, 0], TOWERS_CRATE),
		towersCrate('Cube 4', 0xb57a45, [0.6, 0.6, 0.6], [-5.5, 2.8, 0], TOWERS_CRATE),
		// planks on the right podium
		towersCrate('Plank 1', 0xd2a86e, [1.4, 0.3, 0.6], [5.5, 0.75, 0], TOWERS_PLANK),
		towersCrate('Plank 2', 0xc49a60, [1.4, 0.3, 0.6], [5.5, 1.2, 0], TOWERS_PLANK),
		towersCrate('Plank 3', 0xd2a86e, [1.4, 0.3, 0.6], [5.5, 1.65, 0], TOWERS_PLANK),
		// a few loose cubes near the pad to start building right away
		towersCrate('Cube 5', 0xc28d55, [0.6, 0.6, 0.6], [-2, 0.35, 2], TOWERS_CRATE),
		towersCrate('Cube 6', 0xa86d3c, [0.6, 0.6, 0.6], [2, 0.35, 2], TOWERS_CRATE),
		// height rings over the pad — thin glowing rings a rising crate trips (the sensor is
		// the ring's box, so the hole still counts); select-through, so a click reaches the
		// tower inside. The top ring is gold: the one worth a sparkle.
		{ type: 'torus', name: 'Height ring 1m', color: 0xbff4ff, r: 0.9, tube: 0.035, pos: [0, 1, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 2.2, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true, collider: 'box' } },
		{ type: 'torus', name: 'Height ring 2m', color: 0xbff4ff, r: 0.9, tube: 0.035, pos: [0, 2, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 2.2, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true, collider: 'box' } },
		{ type: 'torus', name: 'Height ring 3m', color: 0xbff4ff, r: 0.9, tube: 0.035, pos: [0, 3, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 2.2, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true, collider: 'box' } },
		{ type: 'torus', name: 'Height ring 4m', color: 0xfff0b8, r: 0.9, tube: 0.04, pos: [0, 4, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0xffc640, emissiveIntensity: 2.6, shadow: false, pick: 'through', physics: { mode: 'static', sensor: true, collider: 'box' } },
		// the measuring pole beside the pad: one bright mark per metre, lined up with a ring
		{ type: 'cylinder', name: 'Height pole', color: 0xe8edf3, r: 0.04, h: 4.3, pos: [2.2, 2.15, 0], physical: true, metalness: 0.6, roughness: 0.3, shadow: false },
		{ type: 'torus', name: 'Pole mark 1m', color: 0xbff4ff, r: 0.1, tube: 0.025, pos: [2.2, 1, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 2.4, shadow: false },
		{ type: 'torus', name: 'Pole mark 2m', color: 0xbff4ff, r: 0.1, tube: 0.025, pos: [2.2, 2, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 2.4, shadow: false },
		{ type: 'torus', name: 'Pole mark 3m', color: 0xbff4ff, r: 0.1, tube: 0.025, pos: [2.2, 3, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x49d2ff, emissiveIntensity: 2.4, shadow: false },
		{ type: 'torus', name: 'Pole mark 4m', color: 0xfff0b8, r: 0.1, tube: 0.03, pos: [2.2, 4, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0xffc640, emissiveIntensity: 2.6, shadow: false },
		// the stars — faceted glowing collectibles at climbing heights (touch pickups)
		{ type: 'dodecahedron', name: 'Star 1', color: 0xffc640, r: 0.24, pos: [-3.5, 2.4, 3.5], emissive: 0xffb830, emissiveIntensity: 1.6, physical: true, roughness: 0.25, metalness: 0.1, clearcoat: 1, flatShading: true },
		{ type: 'dodecahedron', name: 'Star 2', color: 0xffc640, r: 0.24, pos: [3.5, 3.2, -3.5], emissive: 0xffb830, emissiveIntensity: 1.6, physical: true, roughness: 0.25, metalness: 0.1, clearcoat: 1, flatShading: true },
		{ type: 'dodecahedron', name: 'Star 3', color: 0xffc640, r: 0.24, pos: [0, 4.6, 0], emissive: 0xffb830, emissiveIntensity: 1.6, physical: true, roughness: 0.25, metalness: 0.1, clearcoat: 1, flatShading: true },
		// the card's camera: a 3/4 view over the pad with the podiums either side
		{ type: 'camera', name: 'Card camera', pos: [8.2, 6, 10.2], lookAt: [0, 1.5, 0], fov: 45 }
	]
};

// ---- 24-A A4: Stars Room, the second GAME def -------------------------------------
// The first game that needs NO module download: a zero-g room you knock stars around
// in (A1's knock, A2's On Hit), pure core. Design notes worth keeping:
//   · 30 visuals-core: a START SCREEN (menu) offers `Start round` or `Free play`. Free play is
//     a game STATE of its own ('free' — setGameState keeps an unknown state verbatim), so its
//     screen is state-bound and the P menu's Resume (a `hide`) falls back to it; a screen
//     OVERRIDE would have fallen back to the start screen instead. A round is two minutes:
//     light every star, or run out of time — Round over names which, from STORED values,
//     because every perRound latch reads un-lit the instant the round ends;
//   · the default free screen is `input: 'game'` — a `menu`-input screen visible while
//     playing releases the pointer lock (21-E3), which would make free play unplayable
//     on desktop; every button lives on the P menu, plus two onclick PADS for VR;
//   · the lit colour rides latch -> Select -> Set Color. The editor would refuse to draw
//     Select (number) into Set Color's colour input, but the runtime reads whatever the
//     wire resolves to and Select passes a string through raw — recorded as a follow-up
//     (a Select typed by its wired inputs, or a Select Colour node). The Round-over title
//     uses the same trick into HUD Text's `format`;
//   · THE BURST (30b): 30 pooled ONE particle emitter on a `Burst anchor` a Script moved onto
//     the star just hit, because a particle node wired to 24 stars is 24 of the runtime's 8
//     emitters. The Game Feel Effect Burst is pooled by the CORE (twelve short-lived systems at
//     the scene root, no emitter slot), so each star has its own burst node now and the anchor,
//     the Script and the hit-index sum are gone;
//   · the spawner RECYCLES oldest-out at maxAlive, it does not refuse — "More stars"
//     therefore never fails, and the room holds at most 27 + 32 dynamic bodies;
//   · the chime is a def-level `sounds` entry (A4, additive): fetched like `music`,
//     dropped into the Explorer, addressed by `'$sound:<key>'` from a Sound node — NOT
//     `music`, which would also fill the scene's background-music slot;
//   · 30: a real space room — a deep-blue gradient sky, a starfield (one continuous emitter
//     flung to a ~20 m shell and faded in only once it has left the room), glass walls on a
//     glowing frame, crystal stars; the look on the user's display is owed, never assumed.
const STARS_HUD_PANEL = {
	bg: 'rgba(8, 10, 28, 0.9)',
	radius: 18,
	border: '1px solid rgba(255, 212, 94, 0.3)'
};
const STARS_CHIME = {
	key: 'chime',
	name: 'impact-glass.ogg',
	url: 'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1/audio-essentials/assets/impact-glass.ogg',
	sha256: '9252d50bfb85edb17d6073c4a7806e10cdb9de56d3dbfc93a4b9727146d2df6d',
	credit: { what: 'Impact Glass', author: 'Kenney', license: 'CC0-1.0', source: 'https://kenney.nl/assets/impact-sounds' }
};
const STAR_DIM = '#3b3f66';
const STAR_LIT = '#ffe08a';
/** the round length in seconds (Game Time `remaining`) */
const STARS_ROUND = 120;
/** a seeded LCG, so the lattice jitter is DATA and two builds place every star alike
 * @param {number} seed */
function seeded(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}
/** 24 crystal stars on a jittered 4 x 6 lattice at hand height (0.8-2.6 m), r 0.16-0.3 —
 * faceted icosahedra under a clearcoat, glowing in four colours, with SPHERE colliders */
function starObjects() {
	const rand = seeded(24);
	const palette = [
		{ color: 0xffe08a, emissive: 0xffc040 },
		{ color: 0x9ad0ff, emissive: 0x4a9cff },
		{ color: 0xffb0d8, emissive: 0xff5aa8 },
		{ color: 0xc8ffb0, emissive: 0x6aff5a }
	];
	/** @type {any[]} */ const out = [];
	let i = 0;
	for (let gx = 0; gx < 4; gx++)
		for (let gz = 0; gz < 6; gz++) {
			i++;
			const x = -3.9 + gx * 2.6 + (rand() - 0.5) * 1.2;
			const z = -4.5 + gz * 1.8 + (rand() - 0.5) * 1.0;
			const y = 0.8 + rand() * 1.8;
			const r = 0.16 + rand() * 0.14;
			const p = palette[(i - 1) % palette.length];
			out.push({
				type: 'icosahedron', name: 'Star ' + i, color: p.color, r: +r.toFixed(3),
				pos: [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)],
				emissive: p.emissive, emissiveIntensity: 1.1, physical: true, roughness: 0.15, metalness: 0.1,
				clearcoat: 1, clearcoatRoughness: 0.1, flatShading: true,
				physics: { mode: 'dynamic', mass: 0.2, restitution: 0.9, friction: 0.1, collider: 'sphere' }
			});
		}
	return out;
}

function starsGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	// ---- the start screen: Start round or Free play -----------------------------------
	N('bstart0', 'hudbutton', 'Start screen: Start', 40, 40, { element: 'go-btn' });
	N('gostart', 'setgamestate', 'Start round', 280, 40, { state: 'playing', outcome: '', reset: false });
	E('bstart0', 'gostart', 'trigger');
	N('bfree', 'hudbutton', 'Start screen: Free play', 40, 110, { element: 'free-btn' });
	N('gofree', 'setgamestate', 'Free play', 280, 110, { state: 'free', outcome: '', reset: false });
	E('bfree', 'gofree', 'trigger');
	// ---- Start from the P menu or the VR pad -> playing ---------------------------------
	N('bstart', 'hudbutton', 'Start button (menu)', 40, 190, { element: 'start-btn' });
	E('bstart', 'gostart', 'trigger');
	N('padstart', 'onclick', 'Start pad clicked', 40, 260, { pulse: 0.3 });
	N('selstartpad', 'objectselector', 'Start pad', 280, 260, { selected: 'Start pad' });
	E('padstart', 'selstartpad');
	E('padstart', 'gostart', 'trigger');
	N('starthide', 'hudscreen', 'Close menu on start', 520, 190, { screen: 'pause', action: 'hide' });
	E('bstart', 'starthide', 'trigger');
	// ---- Round over: Play again, or back to the start screen ------------------------------
	N('bagain', 'hudbutton', 'Menu button (over)', 40, 330, { element: 'again-btn' });
	N('gomenu', 'setgamestate', 'Back to menu', 280, 330, { state: 'menu', outcome: '', reset: true });
	E('bagain', 'gomenu', 'trigger');
	N('breplay', 'hudbutton', 'Play again button', 40, 400, { element: 'replay-btn' });
	// ---- the P menu (Towers' pause, plus Start / More stars) --------------------------
	N('pkey', 'keypress', 'Press P', 40, 480, { code: 'KeyP', edge: 'down', pulse: 0.3 });
	N('pausetoggle', 'hudscreen', 'Toggle menu', 280, 480, { screen: 'pause', action: 'toggle' });
	E('pkey', 'pausetoggle', 'trigger');
	N('bresume', 'hudbutton', 'Resume button', 40, 560, { element: 'resume-btn' });
	N('resumehide', 'hudscreen', 'Close menu', 280, 560, { screen: 'pause', action: 'hide' });
	E('bresume', 'resumehide', 'trigger');
	N('brestart', 'hudbutton', 'Restart button', 40, 640, { element: 'restart-btn' });
	N('restartreset', 'setgamestate', 'Restart: to menu', 280, 640, { state: 'menu', outcome: '', reset: true });
	N('restartdelay', 'delay', 'Restart: wait', 520, 640, { seconds: 0.2, pulse: 0.3 });
	N('restartplay', 'setgamestate', 'Restart: play', 760, 640, { state: 'playing', outcome: '', reset: false });
	N('restarthide', 'hudscreen', 'Close menu on restart', 280, 760, { screen: 'pause', action: 'hide' });
	E('brestart', 'restartreset', 'trigger');
	E('brestart', 'restartdelay', 'trigger');
	E('restartdelay', 'restartplay', 'trigger');
	E('brestart', 'restarthide', 'trigger');
	E('breplay', 'restartreset', 'trigger');
	E('breplay', 'restartdelay', 'trigger');
	N('bquit', 'hudbutton', 'Quit to menu button', 40, 840, { element: 'quit-btn' });
	N('doquit', 'setgamestate', 'Quit to menu', 280, 840, { state: 'menu', outcome: '', reset: true });
	N('quithide', 'hudscreen', 'Close menu on quit', 520, 840, { screen: 'pause', action: 'hide' });
	E('bquit', 'doquit', 'trigger');
	E('bquit', 'quithide', 'trigger');
	// ---- More stars: the menu button or the VR pad spawns 3 copies of the template ----
	N('bmore', 'hudbutton', 'More stars button', 40, 940, { element: 'more-btn' });
	N('padmore', 'onclick', 'More pad clicked', 40, 1020, { pulse: 0.3 });
	N('selmorepad', 'objectselector', 'More stars pad', 280, 1020, { selected: 'More stars pad' });
	E('padmore', 'selmorepad');
	N('seltpl', 'objectselector', 'Star template', 280, 940, { selected: 'Star template' });
	// `at` is an OFFSET from the template (under the floor at y -2): y 4 lands copies at 2 m
	N('spawn', 'spawn', 'Spawn 3 stars', 520, 940, { x: 0, y: 4, z: 0, count: 3, maxAlive: 32, interval: 0.5, spread: 1.5 });
	E('bmore', 'spawn', 'trigger');
	E('padmore', 'spawn', 'trigger');
	E('seltpl', 'spawn', 'source');
	// ---- touches: per-player rows (one writer each), the sum, the leaderboard ---------
	N('touch', 'setvariable', 'Count my touch', 520, 1240, { name: 'touches', value: 1, op: 'add', scope: 'player' });
	N('mytouch', 'peervariable', 'My touches', 40, 1390, { name: 'touches', read: 'mine', peer: '', fallback: 0 });
	N('hmine', 'hudtext', 'HUD my touches', 280, 1390, { element: 'touches-read', format: 'Your touches: {v}', decimals: 0, value: 0 });
	E('mytouch', 'hmine', 'value');
	N('hmine2', 'hudtext', 'HUD my touches (round)', 520, 1390, { element: 'touches-read-2', format: 'Your touches: {v}', decimals: 0, value: 0 });
	E('mytouch', 'hmine2', 'value');
	N('sumtouch', 'peervariable', 'All touches', 40, 1540, { name: 'touches', read: 'sum', peer: '', fallback: 0 });
	N('hsum', 'hudtext', 'HUD all touches', 280, 1540, { element: 'total-read', format: 'Touches: {v}', decimals: 0, value: 0 });
	E('sumtouch', 'hsum', 'value');
	N('board', 'leaderboard', 'Touch leaderboard', 520, 1540, { element: 'board', variable: 'touches', order: 'desc', format: '{name} — {v}', decimals: 0, limit: 4 });
	N('board2', 'leaderboard', 'Touch leaderboard (round)', 760, 1540, { element: 'board-2', variable: 'touches', order: 'desc', format: '{name} — {v}', decimals: 0, limit: 4 });
	N('board3', 'leaderboard', 'Touch leaderboard (over)', 1000, 1540, { element: 'board-3', variable: 'touches', order: 'desc', format: '{name} — {v}', decimals: 0, limit: 5 });
	// ---- the round clock: two minutes, counting down -----------------------------------
	N('clock', 'gametime', 'Time left', 40, 1690, { read: 'remaining', length: STARS_ROUND });
	N('hclock', 'hudtext', 'HUD clock', 280, 1690, { element: 'clock', format: '{v}s left', decimals: 0, value: 0 });
	E('clock', 'hclock', 'value');
	N('elapsed', 'gametime', 'Round time', 40, 1760, { read: 'elapsed', length: STARS_ROUND });
	N('timeup', 'compare', 'Time up?', 280, 1760, { op: 'lte', a: 0, b: 0 });
	E('clock', 'timeup', 'a');
	N('playing', 'gametime', 'Is playing', 40, 1830, { read: 'playing', length: 60 });
	N('timeandplay', 'gate', 'Time up & playing', 520, 1760, { op: 'and', a: false, b: false });
	E('timeup', 'timeandplay', 'a');
	E('playing', 'timeandplay', 'b');
	N('alltime', 'allplayers', 'Everyone out of time', 760, 1760, { pulse: 0.3 });
	E('timeandplay', 'alltime', 'condition');
	N('gotime', 'setgamestate', 'Time over', 1000, 1760, { state: 'over', outcome: "Time's up!", reset: false });
	E('alltime', 'gotime', 'trigger');
	// ---- per star: a chime on any hit, a per-player touch on MY hit, and a perRound latch
	// that paints the star lit during a round ------------------------------------------------
	let prevSum = '';
	for (let i = 1; i <= 24; i++) {
		const y = 1900 + (i - 1) * 180;
		N('sel' + i, 'objectselector', 'Star ' + i, 1000, y, { selected: 'Star ' + i });
		N('hit' + i, 'onhit', 'Star ' + i + ' hit', 40, y, { pulse: 0.3, minSpeed: 0.3, who: 'anyone' });
		E('hit' + i, 'sel' + i);
		N('snd' + i, 'sound', 'Star ' + i + ' chime', 760, y, {
			hash: '$sound:chime', file: STARS_CHIME.name, volume: 0.7, radius: 8, rolloff: 1, loop: false, playing: false
		});
		E('hit' + i, 'snd' + i, 'trigger');
		E('snd' + i, 'sel' + i);
		N('me' + i, 'onhit', 'Star ' + i + ' my hit', 40, y + 90, { pulse: 0.3, minSpeed: 0.3, who: 'me' });
		E('me' + i, 'sel' + i);
		E('me' + i, 'touch', 'trigger');
		N('lat' + i, 'latch', 'Star ' + i + ' lit', 1240, y, { initial: false, perRound: true });
		E('hit' + i, 'lat' + i, 'set');
		N('lit' + i, 'select', 'Star ' + i + ' colour', 1480, y, { index: 0, a: STAR_DIM, b: STAR_LIT });
		E('lat' + i, 'lit' + i, 'index');
		N('col' + i, 'setcolor', 'Star ' + i + ' paint', 1720, y, { color: STAR_DIM, whilePlaying: true });
		E('lit' + i, 'col' + i, 'color');
		E('col' + i, 'sel' + i);
		if (i === 2) {
			N('sum2', 'math', 'Lit 1-2', 1960, y, { op: 'add', a: 0, b: 0 });
			E('lat1', 'sum2', 'a');
			E('lat2', 'sum2', 'b');
			prevSum = 'sum2';
		} else if (i > 2) {
			N('sum' + i, 'math', 'Lit 1-' + i, 1960, y, { op: 'add', a: 0, b: 0 });
			E(prevSum, 'sum' + i, 'a');
			E('lat' + i, 'sum' + i, 'b');
			prevSum = 'sum' + i;
		}
	}
	// ---- 30b: each star SPARKLES where it is hit, and LIGHTING it (the first hit of the round,
	// a perRound Once) pays a coin chime and a haptic tap. The Game Feel burst is POOLED by
	// the core (twelve short-lived systems at the scene root, no emitter slot), so 24 of them
	// cost nothing between hits — which retires 30's one-emitter-plus-Script anchor trick.
	N('buzzlit', 'hapticpulse', 'Buzz: a star lit', 1960, 1400, { pattern: 'tap', hand: 'both' });
	for (let i = 1; i <= 24; i++) {
		const y = 1900 + (i - 1) * 180;
		N('fx' + i, 'effectburst', 'Star ' + i + ' sparkle', 2200, y, { kind: 'sparkle', count: 28, lift: 0, color: '' });
		E('hit' + i, 'fx' + i, 'trigger');
		E('sel' + i, 'fx' + i, 'at');
		N('first' + i, 'once', 'Star ' + i + ' first lit', 2440, y, { perRound: true, pulse: 0.3 });
		E('hit' + i, 'first' + i, 'trigger');
		N('coin' + i, 'gamesound', 'Star ' + i + ' coin', 2680, y, { sound: 'coin' });
		E('first' + i, 'coin' + i, 'trigger');
		E('sel' + i, 'coin' + i, 'at');
		E('first' + i, 'buzzlit', 'trigger');
	}
	// ---- the round's result, kept where the round's end cannot erase it ------------------
	N('hlit', 'hudtext', 'HUD lit', 2200, 2000, { element: 'lit-read', format: 'Lit: {v} / 24', decimals: 0, value: 0 });
	E('sum24', 'hlit', 'value');
	N('alllit', 'compare', 'All lit?', 2200, 2150, { op: 'gte', a: 0, b: 24 });
	E('sum24', 'alllit', 'a');
	N('allwin', 'allplayers', 'Everyone agrees', 2440, 2150, { pulse: 0.3 });
	E('alllit', 'allwin', 'condition');
	N('gowin', 'setgamestate', 'Round won', 2680, 2150, { state: 'over', outcome: 'Every star lit!', reset: false });
	E('allwin', 'gowin', 'trigger');
	// Stored on every hit (never on `over`, when every perRound latch reads un-lit): the
	// best round and this round's count as `max`, so a star knocked on the over screen
	// (the sim still runs) cannot wipe them; the win time is `max` of a value that is 0
	// until the 24th star lights. Each round zeroes its own two by `set` nodes.
	N('winat', 'select', 'Time if every star is lit', 2200, 2300, { index: 0, a: 0, b: 0 });
	E('alllit', 'winat', 'index');
	E('elapsed', 'winat', 'b');
	N('storebest', 'storevalue', 'Save best round', 2440, 2300, { key: 'stars-best', mode: 'max', value: 0 });
	N('storelast', 'storevalue', 'Save this round', 2440, 2380, { key: 'stars-last', mode: 'max', value: 0 });
	N('storetime', 'storevalue', 'Save the win time', 2440, 2460, { key: 'stars-time', mode: 'max', value: 0 });
	E('sum24', 'storebest', 'value');
	E('sum24', 'storelast', 'value');
	E('winat', 'storetime', 'value');
	for (let i = 1; i <= 24; i++) {
		E('hit' + i, 'storebest', 'trigger');
		E('hit' + i, 'storelast', 'trigger');
		E('hit' + i, 'storetime', 'trigger');
	}
	N('onround', 'ongamestate', 'When a round starts', 2200, 2540, { state: 'playing', edge: 'enter', pulse: 0.3 });
	N('zerolast', 'storevalue', 'New round: zero the count', 2440, 2540, { key: 'stars-last', mode: 'set', value: 0 });
	N('zerotime', 'storevalue', 'New round: zero the time', 2440, 2620, { key: 'stars-time', mode: 'set', value: 0 });
	E('onround', 'zerolast', 'trigger');
	E('onround', 'zerotime', 'trigger');
	N('storedlast', 'storedvalue', 'This round', 2680, 2380, { key: 'stars-last', output: 'number', fallback: 0 });
	N('storedtime', 'storedvalue', 'Win time', 2680, 2460, { key: 'stars-time', output: 'number', fallback: 0 });
	N('storedbest', 'storedvalue', 'Best round', 2680, 2300, { key: 'stars-best', output: 'number', fallback: 0 });
	N('won', 'compare', 'Won?', 2920, 2380, { op: 'gte', a: 0, b: 24 });
	E('storedlast', 'won', 'a');
	N('titlepick', 'select', 'Over title', 3160, 2300, { index: 0, a: "TIME'S UP", b: 'EVERY STAR LIT' });
	E('won', 'titlepick', 'index');
	N('htitle', 'hudtext', 'HUD over title', 3400, 2300, { element: 'over-title', format: 'ROUND OVER', decimals: 0, value: 0 });
	E('titlepick', 'htitle', 'format');
	N('linepick', 'select', 'Over line', 3160, 2460, { index: 0, a: 'Lit {v} / 24 in time', b: 'Every star lit in {v}s' });
	E('won', 'linepick', 'index');
	N('pickvalue', 'select', 'Over number', 3160, 2540, { index: 0, a: 0, b: 0 });
	E('won', 'pickvalue', 'index');
	E('storedlast', 'pickvalue', 'a');
	E('storedtime', 'pickvalue', 'b');
	N('hfinal', 'hudtext', 'HUD over line', 3400, 2460, { element: 'final-time', format: 'Lit {v} / 24', decimals: 0, value: 0 });
	E('linepick', 'hfinal', 'format');
	E('pickvalue', 'hfinal', 'value');
	N('hbest', 'hudtext', 'HUD best (over)', 3400, 2620, { element: 'over-best', format: 'Your best: {v} / 24 stars', decimals: 0, value: 0 });
	E('storedbest', 'hbest', 'value');
	N('hbest0', 'hudtext', 'HUD best (start)', 3400, 2700, { element: 'best-read', format: 'Your best round: {v} / 24 stars', decimals: 0, value: 0 });
	E('storedbest', 'hbest0', 'value');

	// ---- 30b: the round says what is happening, and sounds like it -----------------------
	N('music', 'gamemusic', 'Space music', 40, 1240, { preset: 'space', volume: 0.45, while: 'always' });
	N('click', 'gamesound', 'Button click', 280, 1100, { sound: 'click' });
	for (const b of ['bstart0', 'bfree', 'bstart', 'bagain', 'breplay', 'bresume', 'brestart', 'bquit', 'bmore']) E(b, 'click', 'trigger');
	N('saygo', 'announce', 'Say: light them', 2680, 2540, { text: 'Light every star!', sub: 'Two minutes — knock each one', seconds: 2.2, color: '#ffe08a', decimals: 0 });
	E('onround', 'saygo', 'trigger');
	N('whistle', 'gamesound', 'Round start whistle', 2680, 2620, { sound: 'whistle' });
	E('onround', 'whistle', 'trigger');
	N('sayfree', 'announce', 'Say: free play', 520, 110, { text: 'Free play', sub: 'Knock the stars around — P or the menu to start a round', seconds: 2, color: '#9ee6ff', decimals: 0 });
	E('bfree', 'sayfree', 'trigger');
	N('saywin', 'announce', 'Say: all lit', 2920, 2150, { text: 'Every star lit!', sub: '', seconds: 2.4, color: '#ffe08a', decimals: 0 });
	E('allwin', 'saywin', 'trigger');
	N('fanfare', 'gamesound', 'Win fanfare', 2920, 2230, { sound: 'levelup' });
	E('allwin', 'fanfare', 'trigger');
	N('sayup', 'announce', "Say: time's up", 1240, 1840, { text: "Time's up!", sub: '', seconds: 2.2, color: '#e5e9f0', decimals: 0 });
	E('alltime', 'sayup', 'trigger');
	N('upwhistle', 'gamesound', 'Final whistle', 1240, 1920, { sound: 'whistle' });
	E('alltime', 'upwhistle', 'trigger');
	// the round's end, whichever way: confetti in front of every player and a cheer, with the
	// results on the Round over screen (the VR board in a headset)
	N('onover', 'ongamestate', 'When the round ends', 3160, 2700, { state: 'over', edge: 'enter', pulse: 0.3 });
	N('confetti', 'effectburst', 'Confetti', 3400, 2700, { kind: 'confetti', count: 96, lift: 0, color: '' });
	E('onover', 'confetti', 'trigger');
	N('cheer', 'gamesound', 'Cheer', 3400, 2780, { sound: 'cheer' });
	E('onover', 'cheer', 'trigger');
	return g.done();
}

const STARS_TEXT = { size: 13, color: '#d8dee9', align: 'center' };
const STARS_BTN = { size: 16, weight: '600', bg: '#3b7dd8', color: '#ffffff', radius: 10 };
const STARS_QUIET = { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 };
/** a glass wall: nearly clear, glossy, faintly blue — select-through, so the stars behind
 * it are what a click reaches @param {string} name @param {number[]} size @param {number[]} pos */
const starsGlass = (name, size, pos) => ({
	type: 'box', name, color: 0x8fb0ff, size, pos, opacity: 0.1, physical: true, roughness: 0.05, clearcoat: 1,
	emissive: 0x1a2a5a, emissiveIntensity: 0.4, pick: 'through', shadow: false,
	physics: { mode: 'static', friction: 0.1, restitution: 0.85 }
});
/** the glowing frame the glass hangs in @param {string} name @param {string} type @param {any} dims @param {number[]} pos */
const starsFrame = (name, type, dims, pos) => ({ type, name, ...dims, pos, color: 0xbfe8ff, emissive: 0x58c8ff, emissiveIntensity: 2.2, shadow: false });
const STARS_DEF = {
	kind: 'game',
	slug: 'stars-room',
	title: 'Stars Room',
	description:
		'A zero-gravity glass room full of glowing crystal stars. Knock them with your hands in VR or walk into them. Start a round to light every star against the clock, or just play.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['zero-g', 'physics', 'sandbox', 'vr'],
	// pure core — the first game that needs no download (no 'modules', no 'installModules')
	// 30: a space room at a readable exposure (the 0.55 studio made it murky): a deep-blue
	// gradient sky, a cool hemisphere and a soft key light for the crystals' facets
	env: {
		preset: 'custom',
		base: 'studio',
		exposure: 1.1,
		background: { top: '#03040f', bottom: '#27408f' },
		fog: null,
		hemi: { sky: '#a8b8ff', ground: '#2c2058', intensity: 1.4 },
		sun: { color: '#d4ddff', intensity: 1.5, dir: [0.35, 1, 0.3] }
	},
	physics: {
		gravity: 0,
		ground: { enabled: false },
		bounds: { limit: -50, action: 'respawn' },
		material: { friction: 0.1, restitution: 0.85 },
		damping: { linear: 0.35, angular: 0.2 },
		ccd: false,
		// 30b: a SPAWN just inside the south glass, facing the stars (yaw 0 faces -Z)
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [0, 0, 5.2], yaw: 0 } },
		knock: { enabled: true, gain: 1, maxSpeed: 10, radius: 0.12, spin: 0.6 }
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 1.3, luminanceThreshold: 0.5 } },
			{ id: 'vig', kind: 'vignette', enabled: true, params: {} },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	sounds: [STARS_CHIME],
	view: { pos: [0, 3.4, 11], target: [0, 1.6, 0] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: starsGraph() },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'start',
					name: 'Start',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'start-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 460, h: 400, z: 0, label: '', style: STARS_HUD_PANEL },
						{ id: 'start-title', kind: 'text', anchor: 'center', x: 0, y: -145, w: 420, h: 48, z: 1, label: 'STARS ROOM', style: { size: 36, weight: '700', color: '#ffd45e', align: 'center' } },
						// 30b: HOW TO PLAY
						{ id: 'howto-title', kind: 'text', anchor: 'center', x: 0, y: -112, w: 400, h: 18, z: 1, label: 'HOW TO PLAY', style: { size: 12, weight: '700', color: '#9ee6ff', align: 'center' } },
						{ id: 'start-sub', kind: 'text', anchor: 'center', x: 0, y: -80, w: 420, h: 44, z: 1, label: 'Zero gravity. Knock every crystal star once to light it — in VR swing your hands through them, on a desktop walk into them.', style: STARS_TEXT, wrap: true },
						{ id: 'best-read', kind: 'text', anchor: 'center', x: 0, y: -44, w: 400, h: 24, z: 1, label: 'Your best round: 0 / 24 stars', style: { size: 14, weight: '600', color: '#9ee6ff', align: 'center' } },
						{ id: 'go-btn', kind: 'button', anchor: 'center', x: 0, y: 12, w: 260, h: 48, z: 1, label: 'Start round', enabled: true, style: { ...STARS_BTN, size: 17 } },
						{ id: 'free-btn', kind: 'button', anchor: 'center', x: 0, y: 70, w: 260, h: 42, z: 1, label: 'Free play', enabled: true, style: STARS_QUIET },
						{ id: 'start-hint', kind: 'text', anchor: 'center', x: 0, y: 128, w: 420, h: 22, z: 1, label: 'Light all 24 in two minutes  ·  P: menu', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true },
						{ id: 'start-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 156, w: 420, h: 22, z: 1, label: 'VR: left stick walks  ·  grip grabs  ·  Y switches to Edit mode', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'free',
					name: 'Free play',
					showWhile: 'free',
					input: 'game',
					elements: [
						{ id: 'free-title', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 420, h: 30, z: 1, label: 'STARS ROOM  ·  free play', style: { size: 18, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'free-hint', kind: 'text', anchor: 'top-center', x: 0, y: 44, w: 520, h: 22, z: 1, label: 'Knock the stars.  P: menu (start a round, more stars)', style: { size: 12, color: '#c8d0dc', align: 'center' } },
						{ id: 'touches-read', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 220, h: 24, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffd45e', align: 'right' } },
						{ id: 'total-read', kind: 'text', anchor: 'top-right', x: 16, y: 40, w: 220, h: 22, z: 1, label: '', style: { size: 12, color: '#c8d0dc', align: 'right' } },
						{ id: 'board', kind: 'list', anchor: 'top-right', x: 16, y: 70, w: 180, h: 96, z: 1, label: '', title: 'Touches', rowsText: '', rows: 4, rowHeight: 18, style: { size: 12, bg: 'rgba(8, 10, 28, 0.62)', radius: 10, pad: 8 } }
					]
				},
				{
					id: 'hud',
					name: 'Round',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'lit-read', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 280, h: 30, z: 1, label: '', style: { size: 20, weight: '700', color: '#ffe08a', align: 'center' } },
						{ id: 'clock', kind: 'text', anchor: 'top-center', x: 0, y: 48, w: 140, h: 22, z: 1, label: '', style: { size: 13, weight: '600', color: '#e5e9f0', align: 'center' } },
						{ id: 'touches-read-2', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 220, h: 24, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffd45e', align: 'right' } },
						{ id: 'board-2', kind: 'list', anchor: 'top-right', x: 16, y: 44, w: 180, h: 96, z: 1, label: '', title: 'Touches', rowsText: '', rows: 4, rowHeight: 18, style: { size: 12, bg: 'rgba(8, 10, 28, 0.62)', radius: 10, pad: 8 } },
						{ id: 'play-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 520, h: 20, z: 1, label: 'Light every star.  P: menu', style: { size: 11, color: '#c8d0dc', align: 'center' } }
					]
				},
				{
					id: 'pause',
					name: 'Menu',
					input: 'menu',
					elements: [
						{ id: 'pause-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 400, h: 400, z: 0, label: '', style: STARS_HUD_PANEL },
						{ id: 'pause-title', kind: 'text', anchor: 'center', x: 0, y: -150, w: 360, h: 36, z: 1, label: 'STARS ROOM', style: { size: 28, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'pause-sub', kind: 'text', anchor: 'center', x: 0, y: -112, w: 360, h: 40, z: 1, label: 'Zero gravity. Knock the stars with your hands in VR, or walk into them.', style: STARS_TEXT, wrap: true },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: -50, w: 250, h: 42, z: 1, label: 'Start round: light every star', enabled: true, style: STARS_BTN },
						{ id: 'restart-btn', kind: 'button', anchor: 'center', x: 0, y: 0, w: 250, h: 42, z: 1, label: 'Restart round', enabled: true, style: { ...STARS_BTN, bg: '#4c9e6a' } },
						{ id: 'more-btn', kind: 'button', anchor: 'center', x: 0, y: 50, w: 250, h: 42, z: 1, label: 'More stars', enabled: true, style: { ...STARS_BTN, bg: '#b0863b' } },
						{ id: 'resume-btn', kind: 'button', anchor: 'center', x: 0, y: 100, w: 250, h: 42, z: 1, label: 'Resume', enabled: true, style: STARS_QUIET },
						{ id: 'quit-btn', kind: 'button', anchor: 'center', x: 0, y: 150, w: 250, h: 42, z: 1, label: 'Quit to menu', enabled: true, style: STARS_QUIET }
					]
				},
				{
					id: 'over',
					name: 'Round over',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 460, h: 400, z: 0, label: '', style: STARS_HUD_PANEL },
						{ id: 'over-title', kind: 'text', anchor: 'center', x: 0, y: -150, w: 420, h: 42, z: 1, label: 'ROUND OVER', style: { size: 30, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'final-time', kind: 'text', anchor: 'center', x: 0, y: -106, w: 420, h: 26, z: 1, label: '', style: { size: 17, weight: '600', color: '#e5e9f0', align: 'center' } },
						{ id: 'over-best', kind: 'text', anchor: 'center', x: 0, y: -76, w: 420, h: 22, z: 1, label: '', style: { size: 14, color: '#9ee6ff', align: 'center' } },
						{ id: 'board-3', kind: 'list', anchor: 'center', x: 0, y: 4, w: 280, h: 116, z: 1, label: '', title: 'Touches', rowsText: '', rows: 5, rowHeight: 18, style: { size: 12, bg: 'rgba(255, 255, 255, 0.05)', radius: 10, pad: 8 } },
						{ id: 'replay-btn', kind: 'button', anchor: 'center', x: 0, y: 100, w: 240, h: 44, z: 1, label: 'Play again', enabled: true, style: STARS_BTN },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: 0, y: 154, w: 240, h: 40, z: 1, label: 'Menu', enabled: true, style: STARS_QUIET }
					]
				}
			]
		}
	},
	objects: [
		// the room: 12 x 7 x 12 — a glossy deck, a dark ceiling with a light ring, glass walls
		// you can see (and click) through and bounce off, hung in a glowing frame
		{ type: 'box', name: 'Floor', color: 0x4a62b8, size: [12, 0.5, 12], pos: [0, -0.25, 0], physical: true, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.2, physics: { mode: 'static', friction: 0.1, restitution: 0.85 } },
		{ type: 'ring', name: 'Floor ring', color: 0xbfe8ff, r: 4.6, inner: 4.45, pos: [0, 0.01, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x58c8ff, emissiveIntensity: 2, shadow: false, pick: 'through' },
		{ type: 'box', name: 'Ceiling', color: 0x1c2656, size: [12, 0.5, 12], pos: [0, 7.25, 0], physical: true, roughness: 0.5, clearcoat: 0.5, physics: { mode: 'static', friction: 0.1, restitution: 0.85 } },
		{ type: 'torus', name: 'Ceiling ring', color: 0xeaf4ff, r: 2.2, tube: 0.05, pos: [0, 6.9, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0xcfe6ff, emissiveIntensity: 3, shadow: false, pick: 'through' },
		starsGlass('Wall north', [12.5, 7, 0.5], [0, 3.5, -6]),
		starsGlass('Wall south', [12.5, 7, 0.5], [0, 3.5, 6]),
		starsGlass('Wall west', [0.5, 7, 12.5], [-6, 3.5, 0]),
		starsGlass('Wall east', [0.5, 7, 12.5], [6, 3.5, 0]),
		starsFrame('Frame NW', 'cylinder', { r: 0.07, h: 7 }, [-6, 3.5, -6]),
		starsFrame('Frame NE', 'cylinder', { r: 0.07, h: 7 }, [6, 3.5, -6]),
		starsFrame('Frame SW', 'cylinder', { r: 0.07, h: 7 }, [-6, 3.5, 6]),
		starsFrame('Frame SE', 'cylinder', { r: 0.07, h: 7 }, [6, 3.5, 6]),
		starsFrame('Frame top north', 'box', { size: [12.1, 0.1, 0.1] }, [0, 7, -6]),
		starsFrame('Frame top south', 'box', { size: [12.1, 0.1, 0.1] }, [0, 7, 6]),
		starsFrame('Frame top west', 'box', { size: [0.1, 0.1, 12.1] }, [-6, 7, 0]),
		starsFrame('Frame top east', 'box', { size: [0.1, 0.1, 12.1] }, [6, 7, 0]),
		// the starfield: one continuous emitter flung to a ~20 m shell (speed / drag) that fades
		// in only once it is out past the glass — the kit's particles, not a texture
		{
			type: 'empty', name: 'Starfield', pos: [0, 3.5, 0],
			particles: {
				preset: 'sparkles', mode: 'continuous', count: 450, lifetime: 9, lifeJitter: 0.3,
				shape: 'sphere', radius: 0.5, speed: 60, speedJitter: 0.4, gravity: 0, drag: 3, turbulence: 0,
				sizeStart: 0.18, sizeEnd: 0.18, colorStart: '#ffffff', colorEnd: '#a8bcff',
				opacity: 1, fadeIn: 0.3, fadeOut: 0.25, sprite: 'star', blending: 'additive', spin: 0, space: 'local'
			}
		},
		{ type: 'light', name: 'Room light', kind: 'point', color: 0xa8bcff, intensity: 20, distance: 18, pos: [0, 5.5, 0] },
		{ type: 'light', name: 'Deck glow', kind: 'point', color: 0x7fd4ff, intensity: 4, distance: 9, pos: [0, 0.6, 0] },
		// the two physical buttons (an onclick fires from a VR ray — the HUD is not in a headset)
		{ type: 'box', name: 'Start pad', color: 0x3b7dd8, size: [0.6, 0.16, 0.6], bevel: 0.04, bevelSegments: 1, pos: [-1, 0.08, -4.8], emissive: 0x2f6fef, emissiveIntensity: 1.4, physical: true, roughness: 0.3, clearcoat: 1, physics: { mode: 'static' } },
		{ type: 'box', name: 'More stars pad', color: 0xb0863b, size: [0.6, 0.16, 0.6], bevel: 0.04, bevelSegments: 1, pos: [1, 0.08, -4.8], emissive: 0xc07a1f, emissiveIntensity: 1.4, physical: true, roughness: 0.3, clearcoat: 1, physics: { mode: 'static' } },
		// the stars, two planets for contrast, and the spawner's template under the floor
		...starObjects(),
		{ type: 'sphere', name: 'Planet Azure', color: 0x5b7fd6, r: 0.6, pos: [-3, 1.9, 2.2], emissive: 0x1f3f9f, emissiveIntensity: 0.4, physical: true, roughness: 0.45, sheen: 0.6, sheenColor: 0x9fc4ff, clearcoat: 0.4, physics: { mode: 'dynamic', mass: 2, restitution: 0.7, friction: 0.2, collider: 'sphere' } },
		{ type: 'sphere', name: 'Planet Ember', color: 0xd68a5b, r: 0.6, pos: [3.2, 2.3, -2.4], emissive: 0x8f3a1a, emissiveIntensity: 0.4, physical: true, roughness: 0.45, sheen: 0.6, sheenColor: 0xffc49f, clearcoat: 0.4, physics: { mode: 'dynamic', mass: 2, restitution: 0.7, friction: 0.2, collider: 'sphere' } },
		{ type: 'icosahedron', name: 'Star template', color: 0xffe08a, r: 0.22, pos: [0, -2, 0], emissive: 0xffc040, emissiveIntensity: 1.1, physical: true, roughness: 0.15, clearcoat: 1, flatShading: true, physics: { mode: 'dynamic', mass: 0.2, restitution: 0.9, friction: 0.1, collider: 'sphere' } },
		// the card: through the south glass, across the lattice, the frame catching the light
		{ type: 'camera', name: 'Card camera', pos: [9, 5.6, 13], lookAt: [0, 2.4, 0], fov: 46 }
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
	const g = graphBuilder();
	const { N, E } = g;
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
	return g.done();
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

// ---- module-owned DEFS (the LOADER region) -------------------------------------------
// Each slug here is read from the sibling modules checkout as
// modules/<id>/<id>.def.json (moduleDef above), emitted by that module's own build so the
// def and the module cannot drift. `--only <slug>` authors one of them; the def's
// `installModules` installs the zips first so the card shows the game.
//   football       — 24-B (PR #218)
//   dungeon-realms — 21-C C6-b: the TWO-MODULE case (`modules: dungeon + dungeon-realms`);
//                    its world is scene-root module content, so the def names
//                    `thumb.sceneGroups: ['dungeon-module']` to get it onto the card
//   untangle       — 21-C C7: the thin template (pose + level + room + HUD + graph); its
//                    board is scene-root content too (`thumb.sceneGroups: ['untangle-module']`)
// ---- 30 visuals-core: the Jam Room becomes a GAME -----------------------------------
// It was a sandbox on one dark slab with no HUD: 23-D3's piano into a speaker, the beat lab
// (transport, drum machine, sampler) and a pedal chain into a mixer, all cabled — built
// from the modules' own menus, so the devices are always what those modules make. Now it
// is a small studio (a wooden floor, rugs, plastered walls with acoustic panels, warm
// lamps, a few props) and a shell: Start = a three-second COUNT-IN, then the goal on
// screen — keep the band playing for EIGHT BARS.
//   · WHAT THE GOAL IS BUILT ON: core's Transport node (musicClock's shared transport as a
//     flow value — beat, bar, bpm, playing, identical on every peer). The music modules
//     publish nothing to the flow (no notes-played count, no transport control), so the
//     round cannot START the transport: the HUD says "press ▶ on the Transport", which is
//     the device's own Play button, clicked with the FREE CURSOR (play.cursor 'free' — you
//     play instruments with the pointer, no lock). The beat the count-in ends on is kept
//     with Set Variable (a replicated sample-and-hold), so bars count from THIS round; a
//     transport restarted mid-round counts from its own zero.
//   · the SCORE is the tempo you finished at (the Transport's BPM −/+ buttons), saved on
//     this device as the best with Store Value max — `jam-best-bpm`.
//   · a device selector cannot be authored here: graphs are restored BEFORE `generate`
//     makes the devices, so a def-local name cannot reach them (the builder is the kit's
//     region). Nothing in the shell needs one — the Transport node reads the shared clock.
const JAM_BARS = 8;
const JAM_PANEL = { bg: 'rgba(28, 18, 12, 0.9)', radius: 18, border: '1px solid rgba(255, 176, 96, 0.35)' };
const JAM_BTN = { size: 17, weight: '600', bg: '#d9772b', color: '#ffffff', radius: 10 };
const JAM_QUIET = { size: 15, weight: '500', bg: '#4a3b32', color: '#f1e6dc', radius: 10 };
function jamGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	// ---- starting: the Start button, or Play again / Restart after a reset ---------------
	N('bgo', 'hudbutton', 'Start jam button', 40, 40, { element: 'go-btn' });
	N('begin', 'delay', 'Begin (0 s)', 280, 40, { seconds: 0, pulse: 0.3 });
	E('bgo', 'begin', 'trigger');
	N('goplay', 'setgamestate', 'Start the round', 520, 40, { state: 'playing', outcome: '', reset: false });
	E('begin', 'goplay', 'trigger');
	// the count-in: its own screen over the round's HUD for three seconds
	N('showcount', 'hudscreen', 'Show the count-in', 520, 120, { screen: 'countin', action: 'show' });
	E('begin', 'showcount', 'trigger');
	N('countdone', 'delay', 'Count-in: 3 s', 760, 120, { seconds: 3, pulse: 0.3 });
	E('begin', 'countdone', 'trigger');
	N('hidecount', 'hudscreen', 'Hide the count-in', 1000, 120, { screen: 'countin', action: 'hide' });
	E('countdone', 'hidecount', 'trigger');
	N('elapsed', 'gametime', 'Round time', 40, 200, { read: 'elapsed', length: 600 });
	N('countval', 'math', '3.49 - time', 280, 200, { op: 'sub', a: 3.49, b: 0 });
	E('elapsed', 'countval', 'b');
	N('hcount', 'hudtext', 'HUD count', 520, 200, { element: 'count-read', format: '{v}', decimals: 0, value: 3 });
	E('countval', 'hcount', 'value');
	// ---- the transport, as numbers --------------------------------------------------------
	N('tbeat', 'transportbeat', 'Transport beat', 40, 320, { read: 'beat' });
	N('tbpm', 'transportbeat', 'Transport BPM', 40, 400, { read: 'bpm' });
	N('tplaying', 'transportbeat', 'Transport playing', 40, 480, { read: 'playing' });
	// the beat the count-in ended on: a replicated sample-and-hold
	N('keepstart', 'setvariable', 'Remember the start beat', 1240, 120, { name: 'jamStartBeat', value: 0, op: 'set', scope: 'shared' });
	E('countdone', 'keepstart', 'trigger');
	E('tbeat', 'keepstart', 'value');
	N('startbeat', 'getvariable', 'Start beat', 280, 320, { name: 'jamStartBeat', fallback: 0 });
	N('since', 'math', 'Beats since the start', 520, 320, { op: 'sub', a: 0, b: 0 });
	E('tbeat', 'since', 'a');
	E('startbeat', 'since', 'b');
	N('restarted', 'compare', 'Transport restarted?', 520, 400, { op: 'lt', a: 0, b: 0 });
	E('tbeat', 'restarted', 'a');
	E('startbeat', 'restarted', 'b');
	N('beats', 'select', 'Beats this round', 760, 360, { index: 0, a: 0, b: 0 });
	E('restarted', 'beats', 'index');
	E('since', 'beats', 'a');
	E('tbeat', 'beats', 'b');
	N('bars', 'math', 'Bars (÷ 4)', 1000, 360, { op: 'div', a: 0, b: 4 });
	E('beats', 'bars', 'a');
	// shown as COMPLETED bars: round(x - 0.5) is floor(x) for the readout
	N('barsfloor', 'math', 'Bars − 0.5', 1240, 320, { op: 'sub', a: 0, b: 0.5 });
	E('bars', 'barsfloor', 'a');
	N('barsshown', 'math', 'Not below 0', 1480, 320, { op: 'max', a: 0, b: 0 });
	E('barsfloor', 'barsshown', 'a');
	N('hbars', 'hudtext', 'HUD bars', 1720, 320, { element: 'bars-read', format: 'Bar {v} / ' + JAM_BARS, decimals: 0, value: 0 });
	E('barsshown', 'hbars', 'value');
	N('hbarbar', 'hudbar', 'HUD progress', 1720, 400, { element: 'bars-bar', min: 0, max: JAM_BARS, value: 0, format: '' });
	E('bars', 'hbarbar', 'value');
	N('beatmod', 'math', 'Beat in the bar', 280, 560, { op: 'mod', a: 0, b: 4 });
	E('tbeat', 'beatmod', 'a');
	N('beatshown', 'math', '+ 0.5 (1..4)', 520, 560, { op: 'add', a: 0, b: 0.5 });
	E('beatmod', 'beatshown', 'a');
	N('hbeat', 'hudtext', 'HUD beat', 760, 560, { element: 'beat-read', format: 'Beat {v}', decimals: 0, value: 0 });
	E('beatshown', 'hbeat', 'value');
	N('hintpick', 'select', 'Hint', 280, 640, { index: 0, a: 'Press ▶ on the Transport to start the beat', b: 'Keep the band going  ·  {v} BPM' });
	E('tplaying', 'hintpick', 'index');
	N('hhint', 'hudtext', 'HUD hint', 520, 640, { element: 'jam-hint', format: 'Press ▶ on the Transport to start the beat', decimals: 0, value: 0 });
	E('hintpick', 'hhint', 'format');
	E('tbpm', 'hhint', 'value');
	// ---- the goal: eight bars, with the transport running, after the count-in -------------
	N('enough', 'compare', JAM_BARS + ' bars?', 1240, 440, { op: 'gte', a: 0, b: JAM_BARS });
	E('bars', 'enough', 'a');
	N('pastcount', 'compare', 'Count-in over?', 280, 720, { op: 'gte', a: 0, b: 3.2 });
	E('elapsed', 'pastcount', 'a');
	N('isplaying', 'gametime', 'Round on', 40, 720, { read: 'playing', length: 600 });
	N('g1', 'gate', 'Bars & transport', 1480, 440, { op: 'and', a: false, b: false });
	E('enough', 'g1', 'a');
	E('tplaying', 'g1', 'b');
	N('g2', 'gate', 'Round on & counted in', 520, 720, { op: 'and', a: false, b: false });
	E('isplaying', 'g2', 'a');
	E('pastcount', 'g2', 'b');
	N('g3', 'gate', 'Session complete?', 1720, 480, { op: 'and', a: false, b: false });
	E('g1', 'g3', 'a');
	E('g2', 'g3', 'b');
	N('allwin', 'allplayers', 'Everyone agrees', 1960, 480, { pulse: 0.3 });
	E('g3', 'allwin', 'condition');
	N('gowin', 'setgamestate', 'Session complete', 2200, 480, { state: 'over', outcome: 'Session complete!', reset: false });
	E('allwin', 'gowin', 'trigger');
	// ---- the score: the tempo you finished at, the best kept on this device --------------
	N('storebest', 'storevalue', 'Save best tempo', 2200, 560, { key: 'jam-best-bpm', mode: 'max', value: 0 });
	N('storelast', 'storevalue', 'Save this tempo', 2200, 640, { key: 'jam-last-bpm', mode: 'set', value: 0 });
	E('allwin', 'storebest', 'trigger');
	E('allwin', 'storelast', 'trigger');
	E('tbpm', 'storebest', 'value');
	E('tbpm', 'storelast', 'value');
	N('storedbest', 'storedvalue', 'Best tempo', 2440, 560, { key: 'jam-best-bpm', output: 'number', fallback: 0 });
	N('storedlast', 'storedvalue', 'This tempo', 2440, 640, { key: 'jam-last-bpm', output: 'number', fallback: 0 });
	N('hbest', 'hudtext', 'HUD best (start)', 2680, 560, { element: 'best-read', format: 'Your best tempo: {v} BPM', decimals: 0, value: 0 });
	E('storedbest', 'hbest', 'value');
	N('hbest2', 'hudtext', 'HUD best (over)', 2680, 640, { element: 'over-best', format: 'Your best tempo: {v} BPM', decimals: 0, value: 0 });
	E('storedbest', 'hbest2', 'value');
	N('hlast', 'hudtext', 'HUD this tempo', 2680, 720, { element: 'over-line', format: JAM_BARS + ' bars at {v} BPM', decimals: 0, value: 0 });
	E('storedlast', 'hlast', 'value');
	// ---- the P menu and Round over: Resume / Restart / Play again / Quit -----------------
	N('pkey', 'keypress', 'Press P', 40, 880, { code: 'KeyP', edge: 'down', pulse: 0.3 });
	N('pausetoggle', 'hudscreen', 'Toggle menu', 280, 880, { screen: 'pause', action: 'toggle' });
	E('pkey', 'pausetoggle', 'trigger');
	N('bresume', 'hudbutton', 'Resume button', 40, 960, { element: 'resume-btn' });
	N('resumehide', 'hudscreen', 'Close menu', 280, 960, { screen: 'pause', action: 'hide' });
	E('bresume', 'resumehide', 'trigger');
	N('brestart', 'hudbutton', 'Restart button', 40, 1040, { element: 'restart-btn' });
	N('breplay', 'hudbutton', 'Play again button', 40, 1120, { element: 'replay-btn' });
	N('restartreset', 'setgamestate', 'Restart: to menu', 280, 1080, { state: 'menu', outcome: '', reset: true });
	N('restarthide', 'hudscreen', 'Close menu on restart', 520, 1040, { screen: 'pause', action: 'hide' });
	N('restartdelay', 'delay', 'Restart: wait', 520, 1120, { seconds: 0.2, pulse: 0.3 });
	for (const b of ['brestart', 'breplay']) {
		E(b, 'restartreset', 'trigger');
		E(b, 'restartdelay', 'trigger');
	}
	E('brestart', 'restarthide', 'trigger');
	E('restartdelay', 'begin', 'trigger');
	N('bquit', 'hudbutton', 'Quit to menu button', 40, 1200, { element: 'quit-btn' });
	N('bmenu', 'hudbutton', 'Menu button (over)', 40, 1280, { element: 'again-btn' });
	N('doquit', 'setgamestate', 'Quit to menu', 280, 1240, { state: 'menu', outcome: '', reset: true });
	N('quithide', 'hudscreen', 'Close menu on quit', 520, 1240, { screen: 'pause', action: 'hide' });
	E('bquit', 'doquit', 'trigger');
	E('bmenu', 'doquit', 'trigger');
	E('bquit', 'quithide', 'trigger');
	return g.done();
}
/** a warm lamp: a pole, a glowing shade and its light, as ONE group
 * @param {string} name @param {number[]} pos */
const jamLamp = (name, pos) => ({
	type: 'group', name, pos,
	children: [
		{ type: 'cylinder', name: name + ' base', color: 0x2b2420, r: 0.18, r2: 0.2, h: 0.04, pos: [0, 0.02, 0], physical: true, metalness: 0.6, roughness: 0.35 },
		{ type: 'cylinder', name: name + ' pole', color: 0x2b2420, r: 0.02, h: 1.5, pos: [0, 0.77, 0], physical: true, metalness: 0.6, roughness: 0.35 },
		{ type: 'cylinder', name: name + ' shade', color: 0xffe2b8, r: 0.16, r2: 0.26, h: 0.3, pos: [0, 1.6, 0], emissive: 0xffb060, emissiveIntensity: 1.6, side: 'double', shadow: false },
		{ type: 'light', name: name + ' light', kind: 'point', color: 0xffb070, intensity: 8, distance: 9, pos: [0, 1.5, 0] }
	]
});
const JAM_DEF = {
	kind: 'game',
	slug: 'jam-room',
	title: 'Jam Room',
	description:
		'A small studio: a piano into a speaker, a beat lab (transport, drum machine, sampler pads) and a pedal chain into a mixer — all cabled. Press Start, then ▶ on the Transport, and keep the band going for eight bars. Play with the mouse; your best tempo is saved.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['music', 'vr'],
	installModules: ['music-lab', 'music-fx'],
	modules: [{ id: 'music-lab', version: '0.2.1' }, { id: 'music-fx', version: '0.1.0' }],
	// warm, indoor, readable: a dark wood gradient behind the open front, a warm hemisphere,
	// a soft key light, and the lamps doing the rest
	env: {
		preset: 'custom',
		base: 'studio',
		exposure: 1.25,
		background: { top: '#1a120d', bottom: '#3a2a20' },
		fog: null,
		ground: { color: '#2a211c', roughness: 0.95 },
		hemi: { sky: '#ffdcb8', ground: '#7a5a42', intensity: 1.8 },
		sun: { color: '#ffe2c0', intensity: 1.6, dir: [0.4, 1, 0.7] }
	},
	// no simulation (nothing here has a body); a FREE cursor, because you play the
	// instruments by pointing at them — no pointer lock, the real cursor clicks keys and pads
	physics: { play: { cursor: 'free', simOnPlay: false } },
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.6, luminanceThreshold: 0.8 } },
			{ id: 'vig', kind: 'vignette', enabled: true, params: {} },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	// inside the room, a step back from the band: Play starts from the editor camera's spot
	view: { pos: [1.0, 2.4, 2.4], target: [1.0, 0.8, -3.2] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: jamGraph() },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'start',
					name: 'Start',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'start-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 360, z: 0, label: '', style: JAM_PANEL },
						{ id: 'start-title', kind: 'text', anchor: 'center', x: 0, y: -125, w: 420, h: 48, z: 1, label: 'JAM ROOM', style: { size: 38, weight: '700', color: '#ffb060', align: 'center' } },
						{ id: 'start-sub', kind: 'text', anchor: 'center', x: 0, y: -72, w: 420, h: 44, z: 1, label: 'Press Start, then ▶ on the Transport, and keep the band going for eight bars.', style: { size: 14, color: '#f1e6dc', align: 'center' }, wrap: true },
						{ id: 'best-read', kind: 'text', anchor: 'center', x: 0, y: -24, w: 420, h: 24, z: 1, label: 'Your best tempo: 0 BPM', style: { size: 15, weight: '600', color: '#ffd9a8', align: 'center' } },
						{ id: 'go-btn', kind: 'button', anchor: 'center', x: 0, y: 40, w: 240, h: 50, z: 1, label: 'Start jam', enabled: true, style: JAM_BTN },
						{ id: 'start-hint', kind: 'text', anchor: 'center', x: 0, y: 122, w: 440, h: 40, z: 1, label: 'Click keys, pads and the drum grid  ·  BPM −/+ on the Transport  ·  P: menu', style: { size: 12, color: '#b8a594', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'countin',
					name: 'Count-in',
					input: 'game',
					elements: [
						{ id: 'count-read', kind: 'text', anchor: 'center', x: 0, y: -30, w: 200, h: 120, z: 1, label: '3', style: { size: 96, weight: '700', color: '#ffb060', align: 'center' } },
						{ id: 'count-sub', kind: 'text', anchor: 'center', x: 0, y: 50, w: 420, h: 30, z: 1, label: 'Get ready…', style: { size: 20, weight: '600', color: '#f1e6dc', align: 'center' } }
					]
				},
				{
					id: 'hud',
					name: 'Jam',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'bars-read', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 280, h: 30, z: 1, label: 'Bar 0 / ' + JAM_BARS, style: { size: 20, weight: '700', color: '#ffffff', align: 'center' } },
						{ id: 'bars-bar', kind: 'bar', anchor: 'top-center', x: 0, y: 50, w: 260, h: 10, z: 1, label: '', min: 0, max: JAM_BARS, value: 0, orientation: 'horizontal', style: { color: '#ffb060', bg: 'rgba(255, 255, 255, 0.15)', radius: 5 } },
						{ id: 'beat-read', kind: 'text', anchor: 'top-right', x: 18, y: 14, w: 160, h: 26, z: 1, label: '', style: { size: 16, weight: '600', color: '#ffd9a8', align: 'right' } },
						{ id: 'jam-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 70, w: 560, h: 24, z: 1, label: '', style: { size: 14, weight: '600', color: '#f1e6dc', align: 'center' } }
					]
				},
				{
					id: 'pause',
					name: 'Menu',
					input: 'menu',
					elements: [
						{ id: 'pause-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 380, h: 300, z: 0, label: '', style: JAM_PANEL },
						{ id: 'pause-title', kind: 'text', anchor: 'center', x: 0, y: -95, w: 340, h: 36, z: 1, label: 'PAUSED', style: { size: 26, weight: '700', color: '#f1e6dc', align: 'center' } },
						{ id: 'resume-btn', kind: 'button', anchor: 'center', x: 0, y: -30, w: 240, h: 42, z: 1, label: 'Resume', enabled: true, style: { ...JAM_BTN, size: 16 } },
						{ id: 'restart-btn', kind: 'button', anchor: 'center', x: 0, y: 22, w: 240, h: 42, z: 1, label: 'Restart', enabled: true, style: { ...JAM_BTN, size: 16, bg: '#4c9e6a' } },
						{ id: 'quit-btn', kind: 'button', anchor: 'center', x: 0, y: 74, w: 240, h: 42, z: 1, label: 'Quit to menu', enabled: true, style: JAM_QUIET }
					]
				},
				{
					id: 'over',
					name: 'Session complete',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 440, h: 300, z: 0, label: '', style: JAM_PANEL },
						{ id: 'over-title', kind: 'text', anchor: 'center', x: 0, y: -100, w: 400, h: 40, z: 1, label: 'SESSION COMPLETE', style: { size: 30, weight: '700', color: '#ffb060', align: 'center' } },
						{ id: 'over-line', kind: 'text', anchor: 'center', x: 0, y: -54, w: 400, h: 28, z: 1, label: '', style: { size: 18, weight: '600', color: '#f1e6dc', align: 'center' } },
						{ id: 'over-best', kind: 'text', anchor: 'center', x: 0, y: -22, w: 400, h: 22, z: 1, label: '', style: { size: 14, color: '#ffd9a8', align: 'center' } },
						{ id: 'replay-btn', kind: 'button', anchor: 'center', x: 0, y: 40, w: 240, h: 46, z: 1, label: 'Play again', enabled: true, style: JAM_BTN },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: 0, y: 96, w: 240, h: 42, z: 1, label: 'Menu', enabled: true, style: JAM_QUIET }
					]
				}
			]
		}
	},
	objects: [
		// the studio: a warm wooden floor (the devices sit on it at y 0), two rugs, plastered
		// walls on three sides with acoustic panels — select-through, they are the room's shell
		{ type: 'box', name: 'Floor', color: 0xb07a4a, size: [12, 0.3, 10], pos: [1.1, -0.15, -1.8], physical: true, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 },
		{ type: 'box', name: 'Rug', color: 0x7a2330, size: [5.4, 0.02, 3.4], pos: [0.9, 0.012, -2.7], physical: true, roughness: 0.95, sheen: 0.8, sheenColor: 0xd4606e, sheenRoughness: 0.7 },
		{ type: 'cylinder', name: 'Round rug', color: 0x2f4d5a, r: 1.9, h: 0.02, pos: [3.6, 0.012, -0.9], physical: true, roughness: 0.95, sheen: 0.8, sheenColor: 0x7fb4c8, sheenRoughness: 0.7 },
		{ type: 'box', name: 'Back wall', color: 0xe6cbaa, size: [12, 3.4, 0.2], pos: [1.1, 1.7, -6.8], roughness: 0.9, pick: 'through' },
		{ type: 'box', name: 'Left wall', color: 0xdcbf9e, size: [0.2, 3.4, 10], pos: [-4.9, 1.7, -1.8], roughness: 0.9, pick: 'through' },
		{ type: 'box', name: 'Right wall', color: 0xdcbf9e, size: [0.2, 3.4, 10], pos: [7.1, 1.7, -1.8], roughness: 0.9, pick: 'through' },
		// a ceiling that casts no shadow (the key light comes from above), so the room reads as a
		// room from the player's eye while the open front keeps the editor's view in
		{ type: 'box', name: 'Ceiling', color: 0xf0dcc4, size: [12, 0.12, 10], pos: [1.1, 3.46, -1.8], roughness: 0.9, emissive: 0x8a6a50, emissiveIntensity: 0.9, shadow: false, pick: 'through' },
		{ type: 'cylinder', name: 'Ceiling light 1', color: 0xfff2dc, r: 0.4, h: 0.04, pos: [-1.2, 3.38, -2.6], emissive: 0xffd8a8, emissiveIntensity: 3, shadow: false, pick: 'through' },
		{ type: 'cylinder', name: 'Ceiling light 2', color: 0xfff2dc, r: 0.4, h: 0.04, pos: [3.2, 3.38, -2.6], emissive: 0xffd8a8, emissiveIntensity: 3, shadow: false, pick: 'through' },
		{ type: 'box', name: 'Skirting', color: 0x3a2a20, size: [12, 0.14, 0.04], pos: [1.1, 0.07, -6.68], roughness: 0.6 },
		// acoustic panels: fabric (sheen) in two colours, on the back wall behind the band
		{ type: 'box', name: 'Panel 1', color: 0x2d4a52, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [-2.6, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0x6fa0ac, pick: 'through' },
		{ type: 'box', name: 'Panel 2', color: 0x8a3a2a, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [-0.9, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0xd08a70, pick: 'through' },
		{ type: 'box', name: 'Panel 3', color: 0x2d4a52, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [0.8, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0x6fa0ac, pick: 'through' },
		{ type: 'box', name: 'Panel 4', color: 0x8a3a2a, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [2.5, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0xd08a70, pick: 'through' },
		{ type: 'box', name: 'Panel 5', color: 0x2d4a52, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [4.2, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0x6fa0ac, pick: 'through' },
		// warm light: two floor lamps and a spot on the beat lab
		jamLamp('Lamp left', [-4.1, 0, -5.4]),
		jamLamp('Lamp right', [6.3, 0, -5.4]),
		{ type: 'light', name: 'Stage spot', kind: 'spot', color: 0xffd9a8, intensity: 60, angle: 0.7, penumbra: 0.6, distance: 14, pos: [1, 5.2, 1.5], target: [0.9, 0, -2.6] },
		// props: an amp stack, a plant, a stool
		{
			type: 'group', name: 'Amp', pos: [-3.6, 0, -3.4], rot: [0, 0.5, 0],
			children: [
				{ type: 'box', name: 'Amp cabinet', color: 0x1e1a18, size: [0.9, 0.9, 0.5], bevel: 0.04, bevelSegments: 1, pos: [0, 0.45, 0], physical: true, roughness: 0.7, clearcoat: 0.2 },
				{ type: 'plane', name: 'Amp grille', color: 0x4a403a, size: [0.76, 0.56], pos: [0, 0.38, 0.252], roughness: 1 },
				{ type: 'box', name: 'Amp head', color: 0x2a2420, size: [0.9, 0.24, 0.46], bevel: 0.03, bevelSegments: 1, pos: [0, 1.02, 0], physical: true, roughness: 0.6, clearcoat: 0.3 },
				{ type: 'box', name: 'Amp light', color: 0xffc07a, size: [0.5, 0.03, 0.01], pos: [0, 1.03, 0.235], emissive: 0xffa040, emissiveIntensity: 2.5, shadow: false }
			]
		},
		{
			type: 'group', name: 'Plant', pos: [6.2, 0, -3.2],
			children: [
				{ type: 'cylinder', name: 'Pot', color: 0xb8674a, r: 0.26, r2: 0.2, h: 0.46, pos: [0, 0.23, 0], physical: true, roughness: 0.8, clearcoat: 0.2 },
				{ type: 'icosahedron', name: 'Leaves', color: 0x3f7a3a, r: 0.5, detail: 1, pos: [0, 0.86, 0], roughness: 0.8, flatShading: true },
				{ type: 'icosahedron', name: 'Leaves top', color: 0x4d8f45, r: 0.34, detail: 1, pos: [0.08, 1.3, 0.04], roughness: 0.8, flatShading: true }
			]
		},
		{
			type: 'group', name: 'Stool', pos: [-1.9, 0, -0.8],
			children: [
				{ type: 'cylinder', name: 'Stool seat', color: 0x6a3f22, r: 0.24, h: 0.06, pos: [0, 0.62, 0], physical: true, roughness: 0.5, clearcoat: 0.4 },
				{ type: 'cylinder', name: 'Stool leg', color: 0x2b2420, r: 0.03, h: 0.6, pos: [0, 0.3, 0], physical: true, metalness: 0.6, roughness: 0.35 },
				{ type: 'cylinder', name: 'Stool foot', color: 0x2b2420, r: 0.2, h: 0.03, pos: [0, 0.015, 0], physical: true, metalness: 0.6, roughness: 0.35 }
			]
		},
		{ type: 'camera', name: 'Card camera', pos: [4.2, 2.6, 2.6], lookAt: [0.9, 0.5, -2.7], fov: 55 }
	],
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
};

const MODULE_DEFS = ['football', 'dungeon-realms', 'untangle', 'waves'];

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
	// 23-D3's Jam Room, a game since 30 visuals-core (JAM_DEF above)
	JAM_DEF,
	TOWERS_DEF,
	STARS_DEF,
	MIRROR_DEF,
	BEAT_DEF,
	// the def is the module's (see moduleDef); a checkout without it cannot author it
	...MODULE_DEFS.map((id) => moduleDef(id) ?? { slug: id, missingModuleDef: true })
];

(async () => {
	// 30 author-kit: the REAL GPU. `--use-angle=gl` fell back to SwiftShader on Linux, so every
	// card was a software render. The ANGLE backend is per platform — tests/e2e/helpers.cjs
	// GPU_ARGS, which is where the measurements behind it live.
	const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'vulkan';
	const browser = await chromium.launch({
		headless: true,
		args: [
			'--disable-background-timer-throttling',
			'--disable-renderer-backgrounding',
			'--use-gl=angle',
			'--use-angle=' + angle,
			...(angle === 'vulkan' ? ['--enable-features=Vulkan'] : []),
			'--enable-gpu',
			'--ignore-gpu-blocklist'
		]
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
	// 30 author-kit: say which GPU the thumbnails are rendered on — a SwiftShader card is
	// not the one a user's display would show, and nothing else in the run would tell
	const gpu = await page.evaluate(() => {
		const gl = document.createElement('canvas').getContext('webgl2');
		const info = gl?.getExtension('WEBGL_debug_renderer_info');
		return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
	});
	console.log('GPU: ' + gpu + (/swiftshader/i.test(gpu) ? '  (WARN software rendering)' : ''));

	/** @type {Record<string, {entry: any, bytes: Buffer, thumb: Buffer|null}>} */
	const built = {};
	// 30 author-kit: `--def` files replace a same-slug DEFS entry in place, or append
	const allDefs = DEFS.map((d) => FILE_DEFS.find((f) => f.slug === d.slug) ?? d).concat(
		FILE_DEFS.filter((f) => !DEFS.some((d) => d.slug === f.slug))
	);
	const defs = ONLY ? allDefs.filter((d) => ONLY.includes(d.slug)) : allDefs;
	if (ONLY && defs.length !== ONLY.length)
		console.log('  WARN --only names a slug DEFS does not have: ' + ONLY.join(','));
	// a module-owned def whose file is absent must not quietly drop its row from a full
	// --out rebuild (that rebuilds index.json from scratch) — refuse instead.
	// (Without --out only TEMPLATE kinds are written, so a missing game def is moot there.)
	const missing = defs.filter((d) => d.missingModuleDef).map((d) => d.slug);
	if (missing.length && REPO_OUT) {
		console.log(`  FATAL module def(s) not found under ${MODULES_REPO}/modules: ${missing.join(',')} — set MODULES_REPO to a modules checkout that has them`);
		await browser.close();
		process.exit(1);
	}
	for (const def of defs.filter((d) => !d.missingModuleDef)) {
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
		// 24-A A4: one-shot SOUNDS a graph plays (a def-level list, ADDITIVE). Same fetch and
		// the same Explorer drop as the track, but NOT the music slot: a chime is a scene
		// asset a Sound node addresses through '$sound:<key>', never background music.
		const sounds = [];
		for (const snd of def.sounds ?? []) sounds.push({ ...snd, b64: (await fetchMusic(snd)).toString('base64') });
		const out = await page.evaluate(async ({ d, music, sounds, humanTextKeys }) => {
			// 24-A A3: the module-scope Set does not cross into the page — it arrives as a list
			const humanText = new Set(humanTextKeys);
			const s = window.__stores;
			const T = s.THREE;
			s.commandsHandler.sceneCommand('/clear all');
			/** @type {any} */
			let group;
			s.objectsGroup.subscribe((g) => (group = g))();
			/** @param {number} n */
			const hex = (n) => '#' + Number(n).toString(16).padStart(6, '0');
			// 30 author-kit: material fields only MeshPhysicalMaterial has (a def using any of
			// them gets one), the directional lights whose shadow frustum is fitted once the
			// whole scene is built, and the animation presets applied once objects have uuids
			const PHYSICAL_KEYS = ['clearcoat', 'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'sheen', 'sheenColor', 'sheenRoughness', 'iridescence', 'specularIntensity'];
			/** @type {any[]} */ const fitShadows = [];
			/** @type {{object: any, anim: any}[]} */ const animQueue = [];
			// 30 author-kit: a ROUNDED box. Core's Box params carry no bevel, so this is a port of
			// three/examples' RoundedBoxGeometry (MIT) — same vertex placement, normals and UVs —
			// BAKED into a plain BufferGeometry: toJSON writes a subclass's `type` and ObjectLoader
			// cannot rebuild 'RoundedBoxGeometry', while a plain BufferGeometry round-trips its
			// buffers. @param {number} width @param {number} height @param {number} depth
			// @param {number} segments @param {number} radius
			const roundedBox = (width, height, depth, segments, radius) => {
				const total = segments * 2 + 1;
				radius = Math.min(width / 2, height / 2, depth / 2, radius);
				const src = new T.BoxGeometry(1, 1, 1, total, total, total).toNonIndexed();
				const positions = src.attributes.position.array;
				const normals = src.attributes.normal.array;
				const uvs = src.attributes.uv.array;
				const position = new T.Vector3();
				const normal = new T.Vector3();
				const temp = new T.Vector3();
				const faceDir = new T.Vector3();
				const box = new T.Vector3(width, height, depth).divideScalar(2).subScalar(radius);
				const faceTris = positions.length / 6;
				const half = 0.5 / total;
				/** @param {string} uvAxis @param {string} projAxis @param {number} side */
				const getUv = (uvAxis, projAxis, side) => {
					const arc = (2 * Math.PI * radius) / 4;
					const centre = Math.max(side - 2 * radius, 0);
					temp.copy(normal);
					/** @type {any} */ (temp)[projAxis] = 0;
					temp.normalize();
					const arcUv = (0.5 * arc) / (arc + centre);
					const arcAngle = 1.0 - temp.angleTo(faceDir) / (Math.PI / 4);
					if (Math.sign(/** @type {any} */ (temp)[uvAxis]) === 1) return arcAngle * arcUv;
					return centre / (arc + centre) + arcUv + arcUv * (1.0 - arcAngle);
				};
				for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
					position.fromArray(positions, i);
					normal.copy(position);
					normal.x -= Math.sign(normal.x) * half;
					normal.y -= Math.sign(normal.y) * half;
					normal.z -= Math.sign(normal.z) * half;
					normal.normalize();
					positions[i] = box.x * Math.sign(position.x) + normal.x * radius;
					positions[i + 1] = box.y * Math.sign(position.y) + normal.y * radius;
					positions[i + 2] = box.z * Math.sign(position.z) + normal.z * radius;
					normals[i] = normal.x;
					normals[i + 1] = normal.y;
					normals[i + 2] = normal.z;
					const face = Math.floor(i / faceTris);
					if (face === 0) {
						faceDir.set(1, 0, 0);
						uvs[j] = getUv('z', 'y', depth);
						uvs[j + 1] = 1.0 - getUv('y', 'z', height);
					} else if (face === 1) {
						faceDir.set(-1, 0, 0);
						uvs[j] = 1.0 - getUv('z', 'y', depth);
						uvs[j + 1] = 1.0 - getUv('y', 'z', height);
					} else if (face === 2) {
						faceDir.set(0, 1, 0);
						uvs[j] = 1.0 - getUv('x', 'z', width);
						uvs[j + 1] = getUv('z', 'x', depth);
					} else if (face === 3) {
						faceDir.set(0, -1, 0);
						uvs[j] = 1.0 - getUv('x', 'z', width);
						uvs[j + 1] = 1.0 - getUv('z', 'x', depth);
					} else if (face === 4) {
						faceDir.set(0, 0, 1);
						uvs[j] = 1.0 - getUv('x', 'y', width);
						uvs[j + 1] = 1.0 - getUv('y', 'x', height);
					} else {
						faceDir.set(0, 0, -1);
						uvs[j] = getUv('x', 'y', width);
						uvs[j + 1] = 1.0 - getUv('y', 'x', height);
					}
				}
				const geo = new T.BufferGeometry();
				geo.setAttribute('position', new T.BufferAttribute(positions, 3));
				geo.setAttribute('normal', new T.BufferAttribute(normals, 3));
				geo.setAttribute('uv', new T.BufferAttribute(uvs, 2));
				return geo;
			};
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
				} else if (o.type === 'light' && o.kind && o.kind !== 'point') {
					// 30 author-kit: spot / directional / hemisphere. Spot and directional follow
					// createLight's convention (cast shadows by default, the V-1 bias pair) and aim
					// by ROTATION (24-E1: they shine along local -Z; lightHelpers places the target
					// on that forward) — `target` is a WORLD point applied with lookAt once the
					// position is set, below. A directional's ortho frustum is FITTED to the built
					// scene after every object exists (`fitShadows`), unless `fit: false`.
					if (o.kind === 'hemisphere') {
						object = new T.HemisphereLight(o.color ?? 0xffffff, o.groundColor ?? 0x444444, o.intensity ?? 1);
					} else if (o.kind === 'spot' || o.kind === 'directional') {
						object =
							o.kind === 'spot'
								? new T.SpotLight(o.color ?? 0xffffff, o.intensity ?? 1, o.distance ?? 0, o.angle ?? Math.PI / 6, o.penumbra ?? 0.3, o.decay ?? 2)
								: new T.DirectionalLight(o.color ?? 0xffffff, o.intensity ?? 1);
						object.castShadow = o.castShadow ?? true;
						object.shadow.bias = -0.0002;
						object.shadow.normalBias = 0.02;
						if (o.shadowMapSize) {
							object.userData.shadowMapSize = o.shadowMapSize;
							object.shadow.mapSize.set(o.shadowMapSize, o.shadowMapSize);
						}
						if (o.kind === 'directional' && object.castShadow && o.fit !== false) fitShadows.push(object);
					} else throw new Error('light: unknown kind "' + o.kind + '" (point | spot | directional | hemisphere)');
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
					if (o.type === 'box' && o.bevel > 0) geo = roundedBox(o.size[0], o.size[1], o.size[2], o.bevelSegments ?? 3, o.bevel);
					else if (o.type === 'box') geo = new T.BoxGeometry(o.size[0], o.size[1], o.size[2]);
					else if (o.type === 'cylinder') geo = new T.CylinderGeometry(o.r, o.r2 ?? o.r, o.h, 24);
					else if (o.type === 'sphere') geo = new T.SphereGeometry(o.r, 24, 16);
					else if (o.type === 'torus') geo = new T.TorusGeometry(o.r, o.tube ?? o.r * 0.2, 16, 40);
					// 30 author-kit: four more primitives, all core three geometries ObjectLoader
					// rebuilds from their parameters (so the .tpscene stays small). A plane faces +Z
					// (rotate it -90deg on x to lie flat); a ring is the flat annulus, also +Z.
					else if (o.type === 'capsule') geo = new T.CapsuleGeometry(o.r, o.h ?? o.length ?? 1, 8, 16);
					else if (o.type === 'plane') geo = new T.PlaneGeometry(o.size[0], o.size[1]);
					else if (o.type === 'ring') geo = new T.RingGeometry(o.inner ?? o.r * 0.5, o.r, 48);
					else if (o.type === 'icosahedron') geo = new T.IcosahedronGeometry(o.r, o.detail ?? 0);
					else if (o.type === 'dodecahedron') geo = new T.DodecahedronGeometry(o.r, o.detail ?? 0);
					else if (o.type === 'cone') geo = new T.ConeGeometry(o.r, o.h, 24);
					else throw new Error('object "' + o.name + '": unknown type "' + o.type + '"');
					// 30 author-kit: MeshPhysicalMaterial when a def asks for `physical` or uses any
					// field only it has; MeshToonMaterial for `toon`. Absent all of those it is the
					// same MeshStandardMaterial as ever (byte-identical defs).
					const physical = o.physical || PHYSICAL_KEYS.some((k) => o[k] != null);
					/** @type {any} */
					let mat;
					if (o.toon) mat = new T.MeshToonMaterial({ color: o.color });
					else if (physical) {
						mat = new T.MeshPhysicalMaterial({ color: o.color, roughness: o.roughness ?? 0.85, metalness: o.metalness ?? 0 });
						for (const k of PHYSICAL_KEYS) {
							if (o[k] == null) continue;
							if (k === 'sheenColor') mat.sheenColor = new T.Color(o[k]);
							else mat[k] = o[k];
						}
					} else
						mat = new T.MeshStandardMaterial({
							color: o.color,
							roughness: o.roughness ?? 0.85,
							metalness: o.metalness ?? 0
						});
					if (o.flatShading) mat.flatShading = true;
					if (o.side === 'double') mat.side = T.DoubleSide;
					else if (o.side === 'back') mat.side = T.BackSide;
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
				// 30 author-kit: object FLAGS. Each lands where the app itself keeps it, so the
				// .tpscene carries it the ordinary way (userData rides toJSON; a clip rides the
				// animations block). A mirror ghost takes none of them (it is decoration).
				if (!mirror) {
					// select-through: a shell (wall, ceiling, glass) the editor's pick passes by
					if (o.pick === 'through') object.userData.pick = 'through';
					// the transform ORIGIN (objectOrigin's local pivot offset) — a Door preset
					// swings about it, so a hinge is authored here
					if (Array.isArray(o.origin)) object.userData.origin = o.origin.map(Number);
					// a particle emitter from a preset (particlePresets), optionally patched —
					// the config addParticlesPreset writes to userData.particles
					if (o.particles) {
						const spec = typeof o.particles === 'string' ? { preset: o.particles } : o.particles;
						if (!s.particlePresets.PARTICLE_PRESETS.some((/** @type {any} */ p) => p.key === spec.preset))
							throw new Error('object "' + o.name + '": no particle preset "' + spec.preset + '"');
						const base = s.particlePresets.particlePreset(spec.preset);
						if (!base) throw new Error('object "' + o.name + '": no particle preset "' + spec.preset + '"');
						const { preset: _preset, ...patch } = spec;
						object.userData.particles = { ...structuredClone(base), ...patch };
					}
					// animation presets are applied once the object has a uuid in the scene
					if (o.anim) animQueue.push({ object, anim: o.anim });
				}
				// a spot/directional aims by rotation at a WORLD point (see the light branch)
				if (o.target && (object.isSpotLight || object.isDirectionalLight)) {
					const t = o.target;
					object.updateMatrixWorld(true);
					object.lookAt(mirror ? -t[0] : t[0], t[1], t[2]);
				}
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
			// 30 author-kit: FIT each shadow-casting directional light's ortho frustum to the
			// meshes just built — the 8 corners of their world box carried into the light's own
			// frame (it looks down -Z, and the shadow camera is posed from the light toward its
			// target on that same forward). Saved with the light: LightShadow.toJSON carries the
			// camera, so the fitted frustum is what the file (and every peer) renders with.
			if (fitShadows.length) {
				group.updateMatrixWorld(true);
				const bounds = new T.Box3();
				group.traverse((/** @type {any} */ n) => {
					if (n.isMesh && !n.userData?.camera) bounds.expandByObject(n);
				});
				if (!bounds.isEmpty()) {
					const corners = [];
					for (const x of [bounds.min.x, bounds.max.x])
						for (const y of [bounds.min.y, bounds.max.y])
							for (const z of [bounds.min.z, bounds.max.z]) corners.push(new T.Vector3(x, y, z));
					for (const light of fitShadows) {
						light.updateMatrixWorld(true);
						const inv = light.matrixWorld.clone().invert();
						const local = new T.Box3().setFromPoints(corners.map((c) => c.clone().applyMatrix4(inv)));
						const pad = Math.max(local.max.x - local.min.x, local.max.y - local.min.y) * 0.05 + 0.5;
						const cam = light.shadow.camera;
						// symmetric about the light's axis (the shadow camera is centred on it)
						const rx = Math.max(Math.abs(local.min.x), Math.abs(local.max.x)) + pad;
						const ry = Math.max(Math.abs(local.min.y), Math.abs(local.max.y)) + pad;
						cam.left = -rx;
						cam.right = rx;
						cam.bottom = -ry;
						cam.top = ry;
						cam.near = Math.max(0.1, -local.max.z - pad);
						cam.far = Math.max(cam.near + 1, -local.min.z + pad);
						cam.updateProjectionMatrix();
					}
				}
			}
			s.objectsGroup.update((v) => v);

			// ---- C5.3: the scene DATA a game carries beyond its objects -------------
			// Each of these lands through the app's own write path, so what the script
			// produces is exactly what a user authoring by hand would have saved.
			// 30 author-kit: a CUSTOM sky. `env` is still a preset name or {preset, exposure}
			// (unchanged path, byte-identical); a def that says preset:'custom' or overrides any
			// sky field builds a custom payload from a base preset (`base`, else the named
			// preset, else studio) and commits it through the environment module's own custom
			// path (applyCustomPreset), so the scene saves it as `customPreset` and a peer or a
			// late joiner receives it on the environment singleton like any authored sky.
			// The payload's own `exposure` stays 1 — the def's exposure is the STATE multiplier
			// (applyCustomPreset would otherwise square it).
			const SKY_KEYS = ['background', 'fog', 'ground', 'sun', 'hemi'];
			const env = d.env && typeof d.env === 'object' ? d.env : null;
			/** @param {any} c */
			const col = (c) => (typeof c === 'number' ? hex(c) : c);
			if (env && (env.preset === 'custom' || SKY_KEYS.some((k) => env[k] !== undefined))) {
				const presets = s.environment.ENVIRONMENT_PRESETS;
				const baseKey = env.base ?? (env.preset && env.preset !== 'custom' ? env.preset : 'studio');
				if (!presets[baseKey]) throw new Error('env: no base preset "' + baseKey + '"');
				const payload = JSON.parse(JSON.stringify(presets[baseKey]));
				payload.label = env.label ?? 'Custom';
				payload.exposure = 1;
				if (env.background !== undefined) {
					if (env.background && typeof env.background === 'object') {
						// a GRADIENT sky: `background` keeps a flat colour beside it (the horizon)
						// for the backgroundColor store and for an older peer that ignores it
						payload.gradient = { top: col(env.background.top), bottom: col(env.background.bottom) };
						payload.background = col(env.background.bottom);
					} else payload.background = col(env.background);
				}
				if (env.fog !== undefined)
					payload.fog =
						env.fog === null
							? null
							: {
									...(payload.fog ?? { color: payload.background, near: 30, far: 160 }),
									...env.fog,
									...(env.fog.color != null ? { color: col(env.fog.color) } : {})
								};
				if (env.ground) payload.ground = { color: col(env.ground.color), ...(env.ground.roughness != null ? { roughness: env.ground.roughness } : {}) };
				if (env.sun !== undefined) {
					if (env.sun === null) payload.sun = null;
					else {
						const prev = payload.sun ?? { color: '#ffffff', intensity: 1.8, position: [6, 10, 4] };
						// `dir` points FROM the scene TOWARD the sun; the rig wants a position
						const dir = env.sun.dir ? new T.Vector3(...env.sun.dir).normalize().multiplyScalar(16) : null;
						payload.sun = {
							color: env.sun.color != null ? col(env.sun.color) : prev.color,
							intensity: env.sun.intensity ?? prev.intensity,
							position: dir ? dir.toArray().map((v) => Math.round(v * 1000) / 1000) : env.sun.position ?? prev.position
						};
					}
				}
				if (env.hemi !== undefined) {
					if (env.hemi === null) payload.hemi = null;
					else {
						const prev = payload.hemi ?? { sky: '#ffffff', ground: '#4c525c', intensity: 1 };
						payload.hemi = {
							sky: env.hemi.sky != null ? col(env.hemi.sky) : prev.sky,
							ground: env.hemi.ground != null ? col(env.hemi.ground) : prev.ground,
							intensity: env.hemi.intensity ?? prev.intensity
						};
					}
				}
				s.environment.applyCustomPreset(payload);
				s.environment.setEnvironment('custom', env.exposure ?? 1);
			} else if (d.env) s.environment.setEnvironment(d.env.preset ?? d.env, d.env.exposure ?? 1);
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
			// 30 author-kit: `anim: '<preset>'` (or a list of them) — through applyPreset, the
			// Animation window's own preset path, so each is an ORDINARY authored clip keyed
			// from where the object stands (and, for a Door, about its `origin`). A clip is
			// authored, not playing: a Play Animation node (or the Animation window) runs it.
			if (animQueue.length && s.animationPreview) {
				const presets = s.animationPreview.PRESETS;
				for (const { object, anim } of animQueue) {
					for (const name of Array.isArray(anim) ? anim : [anim]) {
						const key = Object.keys(presets).find(
							(k) => k === String(name).toLowerCase() || presets[k].name.toLowerCase() === String(name).toLowerCase()
						);
						if (!key) throw new Error('object "' + object.name + '": no animation preset "' + name + '" (' + Object.keys(presets).join(', ') + ')');
						s.animationPreview.applyPreset(key, object.uuid, object);
					}
				}
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
			// 24-A A4: the one-shot sounds — Explorer only (content-hashed), `'$sound:<key>'`
			// in node data becomes the hash through the widened remap (A3)
			for (const snd of sounds) {
				if (!s.explorer) break;
				const bin = Uint8Array.from(atob(snd.b64), (ch) => ch.charCodeAt(0));
				const item = await s.explorer.addItemFromBytes(bin.buffer, snd.name, null, { imported: true });
				named['$sound:' + snd.key] = item.hash;
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
				// trigger and action names its target), `camera` on the camera nodes (28-G),
				// `hash: '$music'` on a Sound node — and, 24-A A3, ANY own string field a
				// later node type may add: every string that names a def-local object becomes
				// its uuid, string ARRAYS too (a future multi-target node), EXCEPT the human-
				// text keys in HUMAN_TEXT_KEYS. `uuid`/`selected`/`camera`/`hash` fall out
				// as ordinary cases, so the four earlier rules produce exactly what they did.
				const remapData = (data) => {
					const out = { ...(data ?? {}) };
					for (const key of Object.keys(out)) {
						if (humanText.has(key)) continue;
						const v = out[key];
						if (typeof v === 'string') {
							if (named[v]) out[key] = named[v];
						} else if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) {
							out[key] = v.map((x) => (named[x] ? named[x] : x));
						}
					}
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
			const bytes = await s.sessions.exportSessionZip(payload, { assets: !!music || sounds.length > 0, packs: false, flow: true });

			// fitted offscreen thumbnail — the sessions.js renderSceneThumbnail
			// approach at card size (480x270 webp).
			// 30 author-kit P2: THE CARD LOOKS LIKE THE GAME. It used to light the scene with a
			// private hemisphere + directional pair on a fixed grey, which is why a sunset game
			// read as a grey box. Now it renders with the scene's OWN look: the live background
			// (flat colour or the gradient texture), its fog, the environment rig cloned from the
			// scene root (hemi + sun + shadow catcher / ground + extra env lights, at the
			// intensities the viewport uses) and the authored lights; the private pair is the
			// fallback ONLY when the scene has no light at all. Shadows on (PCF). Tone mapping
			// follows the post stack's Tone mapping curve when it has one, else the renderer's
			// own ACES Filmic — what a play-mode frame shows — at the environment's exposure.
			// The camera is `thumb.camera`, else `view`, else a 3/4 framing of the CONTENT: the
			// objects' bounds without the camera markers and without floor-like slabs (a 30x40 m
			// ground framed whole leaves every game piece a speck — the 1690-byte Waves card).
			let thumb = null;
			try {
				const T = s.THREE;
				/** @type {any} */ let liveScene;
				s.globalScene.subscribe((v) => (liveScene = v))();
				/** @type {any} */ let liveRenderer;
				s.globalRenderer.subscribe((v) => (liveRenderer = v))();
				const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
				renderer.setSize(480, 270);
				renderer.shadowMap.enabled = true;
				renderer.shadowMap.type = T.PCFShadowMap;
				/** @type {any} */ let post;
				s.scenePost?.scenePost?.subscribe((/** @type {any} */ v) => (post = v))();
				const tonemap = post?.enabled !== false ? (post?.effects ?? []).find((/** @type {any} */ fx) => fx.kind === 'tonemapping' && fx.enabled !== false) : null;
				const CURVES = { AGX: T.AgXToneMapping, ACES_FILMIC: T.ACESFilmicToneMapping, NEUTRAL: T.NeutralToneMapping, REINHARD: T.ReinhardToneMapping, CINEON: T.CineonToneMapping, LINEAR: T.LinearToneMapping };
				// what the DESKTOP frame shows: a composed frame (the default Shaded+AO view mode
				// keeps the composer running) never receives the renderer's own ACES — only a stack
				// Tone mapping entry maps it (the "renderer.toneMapping NEVER REACHES A COMPOSED
				// FRAME" gotcha). So: the stack's curve, else none. `thumb.toneMapping` overrides.
				const PICK = { agx: 'AGX', aces: 'ACES_FILMIC', neutral: 'NEUTRAL', reinhard: 'REINHARD', cineon: 'CINEON', linear: 'LINEAR' };
				const forced = d.thumb?.toneMapping;
				renderer.toneMapping =
					forced === 'none'
						? T.NoToneMapping
						: forced
							? (/** @type {any} */ (CURVES)[/** @type {any} */ (PICK)[forced] ?? ''] ?? T.NoToneMapping)
							: tonemap
								? (/** @type {any} */ (CURVES)[tonemap.params?.mode ?? 'AGX'] ?? T.AgXToneMapping)
								: T.NoToneMapping;
				renderer.toneMappingExposure = liveRenderer?.toneMappingExposure ?? 1;
				const scene = new T.Scene();
				const bg = liveScene?.background;
				scene.background = bg?.isColor ? bg.clone() : bg ?? new T.Color('#232a33');
				if (liveScene?.fog) scene.fog = liveScene.fog.clone();
				const envRoot = liveScene?.getObjectByName('environment-root');
				if (envRoot) scene.add(envRoot.clone(true));
				const clone = new T.ObjectLoader().parse(group.toJSON());
				scene.add(clone);
				// 21-C C6-b: a module's WORLD lives at the scene root (golden rule 5), so a
				// card rendered from objectsGroup alone shows a dungeon template as a lone
				// arch. `thumb.sceneGroups` names scene-root groups to include — cloned into
				// the offscreen scene, never moved; absent, the picture is what it always was.
				for (const name of d.thumb?.sceneGroups ?? []) {
					const live = liveScene?.getObjectByName(name);
					if (live) clone.add(live.clone(true));
					else console.log('  WARN thumb.sceneGroups: no scene-root group named ' + name);
				}
				// camera markers are chrome, not scenery
				clone.traverse((/** @type {any} */ n) => {
					if (n.userData?.camera) n.visible = false;
				});
				scene.updateMatrixWorld(true);
				// a spot/directional shines along its -Z (24-E1) — lightHelpers seats its target
				// there every frame in the live app; nothing does in this offscreen scene
				let lights = 0;
				scene.traverse((/** @type {any} */ n) => {
					if (!n.isLight || !n.visible || !(n.intensity > 0)) return;
					let shown = true;
					for (let p = n.parent; p; p = p.parent) if (!p.visible) shown = false;
					if (!shown) return;
					lights++;
					if ((n.isSpotLight || n.isDirectionalLight) && n.parent !== scene.getObjectByName('environment-root')) {
						const at = n.getWorldPosition(new T.Vector3());
						const fwd = new T.Vector3(0, 0, -1).applyQuaternion(n.getWorldQuaternion(new T.Quaternion()));
						n.target.position.copy(at).add(fwd.multiplyScalar(10));
						scene.add(n.target);
						n.target.updateMatrixWorld(true);
					}
				});
				if (!lights) {
					scene.add(new T.HemisphereLight(0xffffff, 0x444466, 2.2));
					const sun = new T.DirectionalLight(0xffffff, 1.4);
					sun.position.set(6, 10, 4);
					scene.add(sun);
				}
				const box = new T.Box3().setFromObject(clone);
				// the CONTENT box: every visible mesh except floor-like slabs (thin, and covering
				// over a quarter of the whole footprint); the whole box when nothing else is left
				const whole = box.getSize(new T.Vector3());
				const footprint = Math.max(whole.x * whole.z, 1e-6);
				const content = new T.Box3();
				clone.traverse((/** @type {any} */ n) => {
					if (!n.isMesh || !n.visible || n.userData?.camera) return;
					const b = new T.Box3().setFromObject(n);
					if (b.isEmpty()) return;
					const sz = b.getSize(new T.Vector3());
					const slab = sz.y < 0.05 * Math.max(sz.x, sz.z) && (sz.x * sz.z) / footprint > 0.25;
					if (!slab) content.union(b);
				});
				const frame = content.isEmpty() ? box : content;
				const center = frame.getCenter(new T.Vector3());
				// FIT the box to the 16:9 frame from the 3/4 direction: every corner q (relative
				// to the centre) needs |q.right| <= tanH * depth and |q.up| <= tanV * depth, where
				// depth = dist - q.dir — so the distance is the max over the eight corners (a
				// bounding sphere wastes the card's width on a box that is long and low)
				const fov = 40;
				const dir = new T.Vector3(0.55, 0.42, 0.72).normalize();
				const fwd = dir.clone().negate();
				const right = new T.Vector3().crossVectors(fwd, new T.Vector3(0, 1, 0)).normalize();
				const up = new T.Vector3().crossVectors(right, fwd);
				const tanV = Math.tan(((fov / 2) * Math.PI) / 180);
				const tanH = tanV * (480 / 270);
				let dist = 1;
				for (const x of [frame.min.x, frame.max.x])
					for (const y of [frame.min.y, frame.max.y])
						for (const z of [frame.min.z, frame.max.z]) {
							const q = new T.Vector3(x, y, z).sub(center);
							const along = q.dot(dir);
							dist = Math.max(dist, Math.abs(q.dot(right)) / tanH + along, Math.abs(q.dot(up)) / tanV + along);
						}
				dist *= 1.08;
				const span = Math.max(whole.length(), dist * 2);
				let camera = new T.PerspectiveCamera(fov, 480 / 270, Math.max(dist / 200, 0.01), dist + span * 4);
				camera.position.copy(center).add(dir.clone().multiplyScalar(dist));
				camera.lookAt(center);
				// 28-G: `thumb.camera` renders the card THROUGH a named camera object — the
				// hero shot the def already authored — instead of the fitted 3/4 view.
				const hero = d.thumb?.camera ? group.getObjectByName(d.thumb.camera) : null;
				if (hero) {
					group.updateMatrixWorld(true);
					const spec = hero.userData?.camera ?? {};
					camera = new T.PerspectiveCamera(spec.fov ?? 50, 480 / 270, spec.near ?? 0.1, spec.far ?? 1000);
					hero.getWorldPosition(camera.position);
					hero.getWorldQuaternion(camera.quaternion);
				} else if (d.view) {
					// the editor view the file opens on — the author already chose it
					/** @type {any} */ let editorCam;
					s.globalCamera.subscribe((v) => (editorCam = v))();
					camera = new T.PerspectiveCamera(editorCam?.fov ?? 50, 480 / 270, 0.1, 2000);
					camera.position.set(d.view.pos[0], d.view.pos[1], d.view.pos[2]);
					camera.lookAt(d.view.target[0], d.view.target[1], d.view.target[2]);
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
			// 30 author-kit: the FULL reset — setEnvironment('studio') keeps a custom payload
			// in the state, and environmentSnapshot would then save it into the NEXT def
			s.environment.environmentRestore(null, false);
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
		}, { d: def, music, sounds, humanTextKeys: [...HUMAN_TEXT_KEYS] });
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
