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
// tests/e2e helpers.cjs installModule approach).
const MODULES_REPO = path.resolve(__dirname, '../../theprototype.app-modules');
function moduleZipPath(id) {
	return path.join(MODULES_REPO, id + '.zip');
}
const STATIC_OUT = path.join(__dirname, '../static/templates');
const outFlag = process.argv.indexOf('--out');
const REPO_OUT = outFlag !== -1 ? path.resolve(process.argv[outFlag + 1]) : null;

// ---- declarative scene definitions ------------------------------------------
// objects: {type:'box'|'cylinder'|'sphere'|'cone', name, color, pos, rot?, ...dims,
//           physics?} — physics = the userData.physics schema
//           {mode:'static'|'dynamic', mass, restitution, friction}.
const gray = { floor: 0x8b939c, block: 0xaab2bd, wall: 0x99a3ae, accent: 0xd97706 };
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
	}
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
	for (const def of DEFS) {
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
				const mat = new s.THREE.MeshStandardMaterial({ color: o.color, roughness: 0.85, metalness: 0 });
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
			if (d.post) s.scenePost.scenePostRestore(d.post, false);
			// FLOW GRAPHS. node.position is filled in on a deterministic grid when a def
			// omits it: xyflow dereferences node.position while ADOPTING nodes, so a graph
			// written programmatically without one CRASHES the editor on mount — and a
			// deterministic grid means two peers still agree byte for byte.
			if (d.graphs) {
				const named = {}; // def-local object names -> real uuids
				group.children.forEach((c) => (named[c.name] = c.uuid));
				const grid = (i) => ({ x: 40 + (i % 4) * 220, y: 40 + Math.floor(i / 4) * 140 });
				const resolved = {};
				for (const [key, doc] of Object.entries(d.graphs)) {
					// a graph key may be 'scene' or a def-local OBJECT NAME
					const graphId = key === 'scene' ? s.SCENE_GRAPH : named[key] ?? key;
					resolved[graphId] = {
						nodes: (doc.nodes ?? []).map((n, i) => ({
							...n,
							position: n.position ?? grid(i),
							// a node's own object reference may also be a def-local name
							data: n.data?.uuid && named[n.data.uuid] ? { ...n.data, uuid: named[n.data.uuid] } : { ...n.data }
						})),
						edges: doc.edges ?? []
					};
				}
				s.restoreGraphs(resolved);
			}
			if (d.hud && s.hudDocs) s.hudDocs.hudDocsRestore(d.hud, false);
			if (d.shaders && s.shaderGraph) s.shaderGraph.shaderGraphsRestore(d.shaders, false);
			// let every write settle (the debounced compiles and the reconciles)
			await new Promise((r) => setTimeout(r, d.graphs || d.shaders ? 900 : 100));

			// belt and braces: let the render loop compose world matrices too
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

			// a game's content may come from its module rather than from primitives. Two
			// seams, because modules use both: a scene COMMAND (registerPrimitive-style),
			// or a registered manager MENU action, which is how untangle and dungeon-realms
			// expose "generate/restart" (api.registerMenu).
			if (d.generate) {
				if (typeof d.generate === 'string') s.commandsHandler.sceneCommand(d.generate);
				else if (d.generate.menu) {
					/** @type {any} */ let items;
					s.moduleSDK.moduleMenuItems.subscribe((/** @type {any} */ v) => (items = v))();
					const hit = items.find(
						(/** @type {any} */ it) =>
							it.label === d.generate.menu && (!d.generate.moduleId || it.moduleId === d.generate.moduleId)
					);
					if (hit) hit.action();
					else throw new Error('no module menu action named "' + d.generate.menu + '"');
				}
				await new Promise((r) => setTimeout(r, d.generateWaitMs ?? 2500));
				s.objectsGroup.update((v) => v);
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			}

			// export through the REAL .tpscene path (no session slot needed)
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
	// deliver)
	fs.mkdirSync(STATIC_OUT, { recursive: true });
	const seedTemplates = DEFS.filter((d) => d.kind === 'template').map((d) => ({
		...writeDef(STATIC_OUT, d),
		scene: `/templates/${d.slug}/scene.tpscene`,
		thumb: built[d.slug].thumb ? `/templates/${d.slug}/thumb.webp` : ''
	}));
	fs.writeFileSync(
		path.join(STATIC_OUT, 'index.json'),
		JSON.stringify({ version: 1, templates: seedTemplates, examples: [] }, null, '\t') + '\n'
	);
	console.log(`bundled seed -> ${STATIC_OUT} (${seedTemplates.length} templates)`);

	// scenes-repo working copy: full tree, repo-relative paths
	if (REPO_OUT) {
		// C5.2: version 2 = the file has a games section. Written even when empty, so a
		// reader can tell "a v2 index with no games yet" from "a v1 index".
		const index = { version: 2, templates: [], examples: [], games: [] };
		for (const def of DEFS) {
			const section =
				def.kind === 'template' ? 'templates' : def.kind === 'game' ? 'games' : 'examples';
			const row = writeDef(path.join(REPO_OUT, section), def);
			index[section].push({
				...row,
				scene: `${section}/${def.slug}/scene.tpscene`,
				thumb: built[def.slug].thumb ? `${section}/${def.slug}/thumb.webp` : ''
			});
		}
		fs.mkdirSync(REPO_OUT, { recursive: true });
		fs.writeFileSync(path.join(REPO_OUT, 'index.json'), JSON.stringify(index, null, '\t') + '\n');
		console.log(`scenes repo tree -> ${REPO_OUT}`);
	}
})();
