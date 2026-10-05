// Author the bundled seed templates (static/templates/) and the content for the
// theprototype-app/scenes repo from a REAL app: each template is built from
// primitives in the live scene, exported through the actual .tpscene path
// (buildSessionPayload + exportSessionZip), and gets a fitted offscreen thumbnail
// (the sessions.js renderSceneThumbnail approach at 480x270).
//
//   npx vite dev --port 5174
//   APP_URL=http://localhost:5174/ node scripts/author-templates.cjs [--out <scenes-repo-dir>]
//   (34 B3: every scene is scene-linted before anything is written; --no-lint skips it)
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
//   seed             false keeps a template out of the bundled offline seed (30c: kit levels need the pack CDN)
//   remote           false keeps a template OUT of --out (33: a seed-only greybox whose online twin is a kit level)
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
//   thumb            {camera?: <camera object name>, sceneGroups?: ['<scene-root group>'], dress?: [objects]
//                     (card-only objects: built for the picture, never written into the file),
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
//   block            shape 'Wedge' | 'Arch' | 'Corner' (an L) | 'Stairs', args [w, h, d(, steps)] — the
//                    app's building blocks (`/create Wedge 2 1 2`), bottom-anchored (origin on the floor).
//                    A hull collider fits a wedge; give an arch or an L a custom compound collider
//                    (physics.collider 'custom' + colliderVerts/colliderPieces — the Towers def's `compound`)
//   light            kind 'point' (default: color, intensity, distance, decay — no shadow)
//                    | 'spot' (angle π/6, penumbra 0.3, distance, decay, target) | 'directional'
//                    (target; its shadow frustum is FITTED to the built meshes — `fit: false` to
//                    keep three's) | 'hemisphere' (color = sky, groundColor, intensity).
//                    spot/directional: castShadow (true), shadowMapSize, `target` = a WORLD point
//                    aimed by rotation — place a directional OUTSIDE the scene on its sun side
//   camera           lookAt, fov, aspect — the app's own /create Camera marker
//   spline           points [{pos, radius}], closed, color
//   terrain          terrain {size, segments (<= 48), seed, amplitude, frequency, octaves, ridged, warp,
//                    falloff 'flat'|'island'|'bowl', offsetX, offsetZ} — the app's parametric Terrain (C1)
//   (any non-kit)    scale [x, y, z] | n · children [objects] on a mesh too (visual parts riding it)
//   group / empty    children [objects] (names resolve inside groups too)
//   (any primitive)  children [objects] too (36-fb-water) — built in the parent's LOCAL frame, so
//                    they ride its body: a floating boat = a dynamic hull (collider 'hull' = the
//                    hull mesh alone) carrying its stripe and mast
//   mirror           of (a named object/group), opacity (0.15), prefix — reflected across x = 0
//   kit              pack*, item* (a pack item NAME, e.g. 'architecture-kit' / 'WallStone'), scale?
//                    ([x,y,z] or a number) — a PACK PIECE as a reference (30c packRefs.js): written
//                    as a stub the app refills from PACKS_BASE, so a level of 100 pieces stays small.
//                    Kept TOP-LEVEL (physics only reads top-level objects); `physics` sets its
//                    collider (custom compound boxes/wedges for doorways, stairs, trees).
//                    33-scenes: an item whose pack row carries a `behavior` (a door, a chest, a
//                    lever — contract P2) is placed through importFile like an Explorer drop: an
//                    animated import with the row's behavior + LOD group, saved as an `animRef`
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
//   smoke, dust, confetti, sparks) · water '<preset>' | {preset, shape?, level?, look?, waves?, bubbles?,
//   flow?, density?} (36: a water volume, userData.water — pool aquarium ocean lake river lava swamp toxic
//   ice; a static sensor unless `physics` says otherwise) · bubbles {…} (a standalone bubble emitter)
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
// 34 B3: the scene-lint every written scene passes (the pack rules use a packs checkout when found)
const sceneLint = require('./scene-lint.cjs');
const NO_LINT = process.argv.includes('--no-lint');
const lintPacks = NO_LINT ? null : sceneLint.makePackIndex(sceneLint.findPacks(null));
let lintErrors = 0;
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

// ---- the template defs: scripts/templates/, ONE FILE PER TEMPLATE (34 R4 A3) ------------
// The defs, their shared builders (gray, graphBuilder) and the authoring-order table live in
// scripts/templates/ (index.cjs). This file is the RUNNER: the schema doc above, the CLI flags,
// and the browser drive below.

// 24-A A3: the node-data keys that are HUMAN TEXT and must never be remapped, even when
// their value happens to equal a def-local object's name — a HUD text whose format is
// literally "Build pad" must stay text, and a variable NAMED like an object is a name.
const HUMAN_TEXT_KEYS = new Set(['label', 'format', 'text', 'placeholder', 'name']);

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

const DEFS = require('./templates/index.cjs').loadDefs(moduleDef);

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
			// 30c: KIT pieces name a pack item; resolve each to its file path through the pack's
			// own item list (default.json) on PACKS_BASE, once per pack, before anything builds
			/** @type {Record<string, Record<string, string>>} */
			const kitFiles = {};
			// 33-scenes: the item rows too — a row with a `behavior` (a door, a chest, a lever:
			// contract P2) is an ANIMATED piece, placed through the Explorer's own import path
			/** @type {Record<string, Record<string, any>>} */
			const kitRows = {};
			/** @param {any[]} list @param {Set<string>} sink */
			const kitPacks = (list, sink) => {
				for (const o of list ?? []) {
					if (o.type === 'kit') sink.add(o.pack);
					if (o.children) kitPacks(o.children, sink);
				}
				return sink;
			};
			for (const pack of kitPacks(d.objects, new Set())) {
				const base = String(s.packs.PACKS_BASE).replace(/\/+$/, '');
				const res = await fetch(base + '/' + pack + '/default.json');
				if (!res.ok) throw new Error('kit: pack "' + pack + '" is not served at ' + base + ' (HTTP ' + res.status + ')');
				kitFiles[pack] = {};
				kitRows[pack] = {};
				for (const row of await res.json()) {
					const file = row?.variants?.['glTF-Binary'];
					if (row?.name && file) kitFiles[pack][row.name] = pack + '/' + row.name + '/glTF-Binary/' + file;
					if (row?.name) kitRows[pack][row.name] = row;
				}
			}
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
			// 31-towers: the app's own BUILDING BLOCKS (Wedge / Arch / Corner / Stairs) — the same
			// builders `/create Wedge` uses, fetched only when a def asks for one
			const blockBuilders = d.objects.some((/** @type {any} */ o) => o.type === 'block')
				? (await import('/src/lib/customGeometries.js')).customGeometryBuilders
				: null;
			// 36-sim: the app's Fluid tank (`/create FluidTank w h d`), fetched only when a def asks
			const simTank = d.objects.some((/** @type {any} */ o) => o.type === 'fluidtank')
				? await import('/src/lib/sim/fluidTank.js')
				: null;
			// 36-backlog-21c: a procedural TERRAIN (C1's builder + its geometryParams stamp), fetched only when a def asks
			const terrainBuilder = d.objects.some((/** @type {any} */ o) => o.type === 'terrain')
				? (await import('/src/lib/customGeometries.js')).terrainGeometry
				: null;
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
				} else if (o.type === 'kit') {
					// 30c: a hollow STUB — the app's packRefs watcher refills it from the pack
					// (awaited below, before the card renders and the file is written)
					const path = kitFiles[o.pack]?.[o.item];
					if (!path) throw new Error('kit "' + o.name + '": pack ' + o.pack + ' has no item "' + o.item + '"');
					object = new T.Group();
					object.userData.packRef = { pack: o.pack, item: o.item, path, kids: [] };
					object.userData.packStub = true;
					if (o.scale != null) {
						const k = Array.isArray(o.scale) ? o.scale : [o.scale, o.scale, o.scale];
						object.scale.set(k[0], k[1], k[2]);
					}
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
					// 31-towers: a building block, bottom-anchored like `/create Wedge` (origin on the floor)
					else if (o.type === 'block') {
						const make = blockBuilders?.[o.shape];
						if (!make || !['Wedge', 'Arch', 'Corner', 'Stairs'].includes(o.shape))
							throw new Error('object "' + o.name + '": unknown block "' + o.shape + '" (Wedge | Arch | Corner | Stairs)');
						geo = make(...(o.args ?? []));
					}
					// 36-sim: a fluid tank — open glass box; userData.fluid + its compound collider below
					else if (o.type === 'fluidtank') geo = simTank.fluidTankGeometry(...(o.size ?? []));
					// 36-backlog-21c: a parametric terrain — the app's own builder, so the Inspector's Terrain rows edit it
					else if (o.type === 'terrain') geo = terrainBuilder(o.terrain ?? {});
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
				if (o.type === 'fluidtank') {
					simTank.stampFluidTank(object, ...(o.size ?? []));
					if (o.fluid) object.userData.fluid = { ...object.userData.fluid, ...o.fluid };
				}
				if (o.type === 'terrain') {
					object.userData.terrain = true;
					object.userData.geometryParams = { gtype: 'Terrain', params: { ...(o.terrain ?? {}) } };
				}
				// 36-backlog-21c: a MESH may carry visual children too (a car's wheels and cabin); a
				// group/empty already builds its own above
				if (o.children && o.type !== 'group' && o.type !== 'empty' && o.type !== 'kit')
					for (const child of o.children) object.add(build(child, opts));
				// and a non-kit object may be SCALED (a spline flattened into a road ribbon); a kit
				// piece takes its own `scale` above
				if (o.scale != null && o.type !== 'kit') {
					const k = Array.isArray(o.scale) ? o.scale : [o.scale, o.scale, o.scale];
					object.scale.set(k[0], k[1], k[2]);
				}
				object.name = (opts.prefix ?? '') + o.name;
				if (pos && o.type !== 'spline') object.position.set(pos[0], pos[1], pos[2]);
				if (rot) object.rotation.set(rot[0], rot[1], rot[2]);
				if (o.physics && !mirror) object.userData.physics = o.physics;
				// 36-fb-water F15: `children` on ANY primitive, built in its LOCAL frame — they ride
				// its body (a boat's stripe and mast on a floating hull) while the parent's own
				// collider stays its own shape (collider: 'hull' reads the parent mesh only)
				if (o.type !== 'group' && o.type !== 'empty' && Array.isArray(o.children))
					for (const child of o.children) object.add(build(child, opts));
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
					// 36-water: a water volume from a preset (`water: 'pool'` or {preset, shape?, level?,
					// look?, waves?, bubbles?, flow?, ...}) — userData.water, the W1 blob — and a
					// standalone bubble emitter (`bubbles: {...}` on a dry object, userData.bubbles)
					if (o.water) {
						const spec = typeof o.water === 'string' ? { preset: o.water } : o.water;
						const base = s.waterPresets.waterPreset(spec.preset ?? 'pool', spec.shape ? { shape: spec.shape } : {});
						if (!base) throw new Error('object "' + o.name + '": no water preset "' + spec.preset + '"');
						const { preset: _wp, look, waves, bubbles, ...top } = spec;
						const blob = { ...base, ...top, look: { ...base.look, ...(look ?? {}) }, waves: { ...base.waves, ...(waves ?? {}) }, bubbles: { ...base.bubbles, ...(bubbles ?? {}) } };
						object.userData.water = s.waterVolumes.normalizeWater(blob);
						// a pass-through sensor, never a solid wall (Create -> Water does the same)
						if (!o.physics) object.userData.physics = { mode: 'static', sensor: true };
					} else if (o.bubbles) {
						object.userData.bubbles = { ...s.waterPresets.BUBBLE_DEFAULTS, enabled: true, ...o.bubbles };
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
			/** @type {any[]} */
			const animatedKits = [];
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
				// 33-scenes: a FUNCTIONAL kit piece (its row carries a `behavior`) is not a stub:
				// an animated import is never a kit reference (fileHandler ignores packRef for it),
				// so it is placed after the static build through importFile — the Explorer drop's
				// own call, with the row's behavior and LOD group — and its bytes ride the file
				if (o.type === 'kit' && kitRows[o.pack]?.[o.item]?.behavior) {
					animatedKits.push(o);
					continue;
				}
				group.add(build(o));
			}
			if (animatedKits.length) {
				const base = String(s.packs.PACKS_BASE).replace(/\/+$/, '');
				const { placementGroupFor } = await import('/src/lib/lodGroup.js');
				for (const o of animatedKits) {
					const row = kitRows[o.pack][o.item];
					const url = base + '/' + kitFiles[o.pack][o.item];
					const res = await fetch(url);
					if (!res.ok) throw new Error('kit "' + o.name + '": ' + url + ' HTTP ' + res.status);
					const uuid = await s.fileHandler.importFile(new File([await res.blob()], o.item + '.glb'), o.name, undefined, o.pos, undefined, {
						// the reference makes the save NAME the pack file (animatedImports animRef)
						// instead of carrying its bytes
						packRef: { pack: o.pack, item: o.item, path: kitFiles[o.pack][o.item] },
						lod: placementGroupFor(url, row.lods),
						behavior: row.behavior
					});
					const root = uuid ? group.getObjectByProperty('uuid', uuid) : null;
					if (!root) throw new Error('kit "' + o.name + '": the animated import did not land');
					root.name = o.name;
					if (o.rot) root.rotation.set(o.rot[0], o.rot[1], o.rot[2]);
					if (o.scale != null) {
						const k = Array.isArray(o.scale) ? o.scale : [o.scale, o.scale, o.scale];
						root.scale.set(k[0], k[1], k[2]);
					}
					root.updateMatrix();
				}
				s.objectActions.deselectObject?.();
				s.selectedObjects.set([]);
			}
			// 30c: refill every kit stub from its pack BEFORE anything measures the scene (the
			// shadow fit below, the card) — and refuse to write a level whose pack is unreachable
			if (kitPacks(d.objects, new Set()).size) {
				s.objectsGroup.update((v) => v);
				await new Promise((r) => setTimeout(r, 200));
				await s.packRefs.packRefsSettled();
				const hollow = [];
				group.traverse((/** @type {any} */ n) => {
					if (n.userData?.packStub) hollow.push(n.name);
				});
				if (hollow.length) throw new Error('kit pieces did not load: ' + hollow.slice(0, 5).join(', '));
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
				// 36 (U10): a group's routed sockets are derived from the wires crossing it — the
				// app computes them now, with the editor's own rule, so opening the game rewrites nothing
				await new Promise((r) => setTimeout(r, 300)); // the behaviours load (their sockets type the groups)
				s.groupReconcile?.reconcileGroupSockets?.();
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
				// 30c: a level of kit pieces is CLONED, not round-tripped — toJSON writes every
				// piece's textures as PNG data URLs (7.9 MB for one wall), which is the very cost
				// the kit references exist to avoid. Every other def renders exactly as before.
				const clone = kitPacks(d.objects, new Set()).size ? group.clone(true) : new T.ObjectLoader().parse(group.toJSON());
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
				// 31-towers: CARD-ONLY dressing — objects built for the picture and never saved
				// (the scene was exported above). A Towers level deals its pieces at play time, so
				// an honest card of the FILE is an empty arena; the card shows a round in progress.
				for (const o of d.thumb?.dress ?? []) clone.add(build(o));
				// camera markers are chrome, not scenery
				clone.traverse((/** @type {any} */ n) => {
					if (n.userData?.camera) n.visible = false;
					// 36-water: the offscreen card has no water renderer — draw a water volume as a
					// translucent stand-in in its own colours (an opaque box otherwise hides the tank)
					if (n.isMesh && n.userData?.water) {
						const look = n.userData.water.look ?? {};
						const c = new T.Color(look.shallowColor ?? '#5fd3e6').lerp(new T.Color(look.deepColor ?? '#0b4f6c'), 0.55);
						const glow = Number(look.emissiveStrength) || 0;
						n.material = new T.MeshStandardMaterial({
							color: c,
							roughness: 0.08,
							metalness: 0,
							transparent: (look.opacity ?? 0.85) < 0.99 && !glow,
							opacity: glow ? 1 : 0.5,
							depthWrite: false,
							emissive: glow ? new T.Color(look.emissive ?? '#000000') : new T.Color(0),
							emissiveIntensity: glow
						});
						n.castShadow = false;
					}
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
		// 34 B3: every scene this writes is linted first (scripts/scene-lint.cjs) — an unknown
		// node, env preset, helper/eye layer, spawn in a wall, a nondeterministic script... is an
		// ERROR and nothing is written; warnings print. `--no-lint` skips it (say why in the PR).
		if (!NO_LINT) {
			const findings = [...sceneLint.lintDef(def), ...sceneLint.lintBytes(bytes, { packs: lintPacks })];
			const n = sceneLint.print(`  scene-lint ${def.slug}`, findings, { quiet: true });
			lintErrors += n.error;
		}
	}
	await browser.close();
	if (lintErrors) {
		console.error(`\nscene-lint: ${lintErrors} error(s) — nothing written (fix the defs, or --no-lint to override)`);
		process.exit(1);
	}

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
		// 30c: `seed: false` keeps a template OUT of the offline seed — a level built from kit
		// references needs the pack CDN, so bundling it offline would promise an empty world
		const seedTemplates = defs.filter((d) => d.kind === 'template' && d.seed !== false).map((d) => ({
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
			if (def.remote === false) continue;
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
