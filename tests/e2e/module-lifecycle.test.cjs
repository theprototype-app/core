// 34 R6 (contract T2): ONE MODULE LIFECYCLE, NOTHING LEAKS — in the real app.
//
// §1 the lifecycle CONTRACT, all of it: every SDK member declared 'registers' is registered
//    from inside a real module, seen in core's registry, unloaded (unloadModule), seen gone,
//    journal empty — the same fixture table node vitest runs
//    (tests/fixtures/sdkLifecycleFixtures.js), here with the members node cannot load
//    (VR menu, bindings, input, knock, possess, music, lod, audio voices/schedule/mic/record,
//    requestAnimationFrame).
// §2 an INSTALLED module (a zip) written the way the modules repo writes them — bare
//    setInterval/setTimeout/requestAnimationFrame, window and document listeners — stops
//    all of it when it is removed, keeps working when it declares a timer name itself, and
//    a live UPDATE stops the old code's timers without touching the new code's.
// §3 the LEAK test: each bundled (core) module unloaded and loaded 3x — handlers, node
//    types, effects, wire listeners, audio connections, timers, meshes, materials,
//    geometries/textures on the GPU, DOM nodes, JS event listeners, its registry, and the
//    heap after a forced GC must not grow cycle over cycle.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const FIXTURES = path.resolve(__dirname, '../fixtures/sdkLifecycleFixtures.js');
const EVIDENCE = process.env.LIFECYCLE_EVIDENCE || '';
/** LIFECYCLE_SECTIONS=2,3 runs a subset (counterfactual runs); default all */
const SECTIONS = (process.env.LIFECYCLE_SECTIONS || '1,2,3').split(',');
const want = (n) => SECTIONS.includes(String(n));

/** a minimal stored zip (fflate is a dependency of the app) */
function zipOf(files) {
	const { zipSync, strToU8 } = require('fflate');
	const entries = {};
	for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text);
	return Buffer.from(zipSync(entries, { level: 0 }));
}
const manifest = (id, version) =>
	JSON.stringify({ id, name: 'Lifecycle probe ' + id, version, description: 'test' });

/** the probe module: everything a repo module does that the api never sees */
const PROBE = (id, counter) => `
const probe = (window.__lcProbe ??= {});
const bump = (k) => (probe[k] = (probe[k] ?? 0) + 1);
export default {
	id: ${JSON.stringify(id)},
	name: 'Lifecycle probe',
	version: '1.0.0',
	register(api) {
		setInterval(() => bump(${JSON.stringify(counter)}), 20);
		probe.registeredAt = Date.now();
		setTimeout(() => (probe.late = true), 4000);
		const loop = () => {
			bump('frames');
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
		window.addEventListener('keydown', (e) => e.code === 'F22' && bump('keys'), true);
		document.addEventListener('lc-probe', () => bump('doc'));
	}
};
`;

/** a module that declares a timer name itself (the prologue cannot bind it) */
const SHADOWING = `
function setTimeout(fn) { return 0; }
export default { id: 'lc-shadow', name: 'Shadow', version: '1.0.0', register(api) { window.__lcShadow = setTimeout(() => 1) === 0; } };
`;

async function installZip(page, name, buffer) {
	await page.evaluate(() => window.__stores.modulesOpen.set(true));
	await page.waitForTimeout(300);
	await page.getByRole('tab', { name: /^User/ }).click();
	await page
		.locator('#install-module-zip')
		.setInputFiles({ name, mimeType: 'application/zip', buffer });
}

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...h.AUDIO_ARGS]
	});
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const evidence = {};
	// listeners on window/document by the SCRIPT that added them: a leftover listener whose
	// function is re-added by every load is deduplicated by the browser, so a count never
	// grows — asking which file each one came from is what sees it
	const cdp = await page.context().newCDPSession(page);
	/** @type {Map<string, string>} scriptId -> url */
	const scripts = new Map();
	cdp.on('Debugger.scriptParsed', (e) => scripts.set(e.scriptId, e.url));
	await cdp.send('Debugger.enable');
	await cdp.send('Performance.enable');
	const strayListeners = async (match) => {
		const out = [];
		for (const expr of ['window', 'document']) {
			const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
			const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
				objectId: result.objectId
			});
			for (const l of listeners) {
				const url = scripts.get(l.scriptId) ?? '';
				if (match(url))
					out.push(expr + ':' + l.type + ' @ ' + url.replace(/\?.*$/, '') + ':' + l.lineNumber);
			}
		}
		return out;
	};

	// ---------------------------------------------------------------- §1 the contract ---
	await page.addScriptTag({ path: FIXTURES });
	await page.evaluate(async () => {
		window.__lcEnv = await window.__stores.moduleLifecycle.lifecycleEnv();
	});
	if (want(1)) {
		const contract = await page.evaluate(async () =>
			JSON.parse(JSON.stringify(await globalThis.__sdkLifecycle.runContract(window.__lcEnv)))
		);
		h.check(
			contract.surface.noSurface.length === 0,
			'1.1 every SDK slice declares its surface ' + JSON.stringify(contract.surface.noSurface)
		);
		h.check(
			contract.surface.undeclared.length === 0 &&
				contract.surface.stale.length === 0 &&
				contract.surface.badKind.length === 0,
			'1.2 every member declared, none stale (' +
				contract.surface.members +
				' members) ' +
				JSON.stringify([
					contract.surface.undeclared,
					contract.surface.stale,
					contract.surface.badKind
				])
		);
		h.check(
			contract.missingFixture.length === 0,
			"1.3 every 'registers' member has a fixture " + JSON.stringify(contract.missingFixture)
		);
		const results = Object.entries(contract.results);
		const skipped = results.filter(([, r]) => r.skipped).map(([p, r]) => p + ' ' + r.skipped);
		h.check(
			skipped.length === 0,
			'1.4 the browser runs EVERY fixture (' + results.length + ') ' + JSON.stringify(skipped)
		);
		for (const [p, r] of results) {
			if (r.skipped) continue;
			h.check(
				r.ok,
				'1.5 ' +
					p +
					': journaled, visible in core, gone after unloadModule, journal empty ' +
					(r.ok ? '' : JSON.stringify(r))
			);
		}
		evidence.contract = {
			members: contract.surface.members,
			registers: contract.surface.registers.length,
			results: contract.results
		};
	}

	// ------------------------------------------------------- §2 an installed module ---
	if (want(2)) {
		await installZip(
			page,
			'lc-probe.zip',
			zipOf({
				'manifest.json': manifest('lc-probe', '1.0.0'),
				'module.js': PROBE('lc-probe', 'ticks')
			})
		);
		await h.eventually(
			() => page.evaluate(() => window.__stores.moduleSDK.isModuleLoaded('lc-probe')),
			(v) => v === true,
			'2.0 the probe module installed',
			20000
		);
		await page.evaluate(() => window.__stores.modulesOpen.set(false));
		await page.waitForTimeout(400);
		const live = await page.evaluate(async () => {
			const probe = window.__lcProbe;
			const before = { ...probe };
			window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F22', key: 'F22' }));
			document.dispatchEvent(new Event('lc-probe'));
			await new Promise((r) => setTimeout(r, 200));
			return {
				before,
				after: { ...probe },
				scope: window.__stores.moduleSDK.moduleScopeDebug()['lc-probe'] ?? null
			};
		});
		h.check(
			live.after.ticks > live.before.ticks,
			'2.1 its bare setInterval runs (' + live.before.ticks + ' -> ' + live.after.ticks + ')'
		);
		h.check(
			live.after.frames > (live.before.frames ?? 0),
			'2.2 its bare requestAnimationFrame loop runs'
		);
		h.check(
			live.after.keys === 1 && live.after.doc === 1,
			'2.3 its window + document listeners hear events'
		);
		h.check(
			!!live.scope &&
				live.scope.intervals === 1 &&
				live.scope.timeouts === 1 &&
				live.scope.frames === 1 &&
				live.scope.listeners === 2,
			'2.4 the scope tracks 1 interval, 1 timeout, 1 frame, 2 listeners ' +
				JSON.stringify(live.scope)
		);
		const removed = await page.evaluate(async () => {
			const S = window.__stores;
			await S.userModules.removeUserModule('lc-probe');
			const probe = window.__lcProbe;
			await new Promise((r) => setTimeout(r, 100));
			const at = { ...probe };
			window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F22', key: 'F22' }));
			document.dispatchEvent(new Event('lc-probe'));
			// past the module's 4 s timeout
			await new Promise((r) =>
				setTimeout(r, Math.max(300, probe.registeredAt + 4300 - Date.now()))
			);
			return {
				at,
				after: { ...probe },
				loaded: S.moduleSDK.isModuleLoaded('lc-probe'),
				journal: S.moduleSDK.registrationCount('lc-probe'),
				scope: S.moduleSDK.moduleScopeDebug()['lc-probe'] ?? null
			};
		});
		h.check(
			!removed.loaded && removed.journal === 0 && removed.scope === null,
			'2.5 removed: unloaded, journal empty, scope gone ' + JSON.stringify(removed.scope)
		);
		h.check(
			removed.after.ticks === removed.at.ticks,
			'2.6 its interval STOPPED (' + removed.at.ticks + ' -> ' + removed.after.ticks + ')'
		);
		h.check(removed.after.frames === removed.at.frames, '2.7 its frame loop STOPPED');
		h.check(
			removed.after.keys === 1 && removed.after.doc === 1,
			'2.8 its window + document listeners are GONE'
		);
		h.check(!removed.after.late, '2.9 its pending timeout never fired');
		const blobLeft = await strayListeners((url) => url.startsWith('blob:'));
		h.check(
			blobLeft.length === 0,
			'2.15 no window/document listener from its code is left ' + JSON.stringify(blobLeft)
		);

		await installZip(
			page,
			'lc-shadow.zip',
			zipOf({ 'manifest.json': manifest('lc-shadow', '1.0.0'), 'module.js': SHADOWING })
		);
		await h.eventually(
			() =>
				page.evaluate(() => [
					window.__stores.moduleSDK.isModuleLoaded('lc-shadow'),
					window.__lcShadow === true
				]),
			(v) => v[0] && v[1],
			'2.10 a module declaring setTimeout itself still loads (evaluated without the prologue)',
			20000
		);
		await page.evaluate(() => window.__stores.userModules.removeUserModule('lc-shadow'));

		// live update: v1 counts `ticks`, v2 counts `ticks2` — the old code stops, the new runs
		await page.evaluate(() => (window.__lcProbe = {}));
		await installZip(
			page,
			'lc-up.zip',
			zipOf({ 'manifest.json': manifest('lc-up', '1.0.0'), 'module.js': PROBE('lc-up', 'ticks') })
		);
		await h.eventually(
			() => page.evaluate(() => (window.__lcProbe.ticks ?? 0) > 2),
			(v) => v,
			'2.11 v1 running',
			20000
		);
		await installZip(
			page,
			'lc-up.zip',
			zipOf({ 'manifest.json': manifest('lc-up', '1.0.1'), 'module.js': PROBE('lc-up', 'ticks2') })
		);
		await h.eventually(
			() => page.evaluate(() => (window.__lcProbe.ticks2 ?? 0) > 2),
			(v) => v,
			'2.12 v2 running after the live update',
			20000
		);
		const updated = await page.evaluate(async () => {
			const a = window.__lcProbe.ticks;
			const b = window.__lcProbe.ticks2;
			await new Promise((r) => setTimeout(r, 300));
			return {
				v1: [a, window.__lcProbe.ticks],
				v2: [b, window.__lcProbe.ticks2],
				scope: window.__stores.moduleSDK.moduleScopeDebug()['lc-up']
			};
		});
		h.check(
			updated.v1[0] === updated.v1[1],
			"2.13 the OLD version's interval stopped at the update " + JSON.stringify(updated.v1)
		);
		h.check(
			updated.v2[1] > updated.v2[0] && updated.scope?.intervals === 1,
			"2.14 the NEW version's interval kept running " + JSON.stringify(updated)
		);
		await page.evaluate(() => window.__stores.userModules.removeUserModule('lc-up'));
		await page.evaluate(() => window.__stores.modulesOpen.set(false));
		evidence.installed = { live, removed, updated };
	}

	// ------------------------------------------------------------- §3 the leak test ---
	if (want(3)) {
		await page.evaluate(() => {
			// counters installed NOW: everything that already exists is baseline
			const live = { timeouts: new Set(), intervals: new Set() };
			const st = window.setTimeout;
			const si = window.setInterval;
			const ct = window.clearTimeout;
			const ci = window.clearInterval;
			window.setTimeout = function (fn, ms, ...a) {
				const handle = st.call(
					window,
					(...b) => {
						live.timeouts.delete(handle);
						if (typeof fn === 'function') fn(...b);
					},
					ms,
					...a
				);
				live.timeouts.add(handle);
				return handle;
			};
			window.clearTimeout = (handle) => {
				live.timeouts.delete(handle);
				ct.call(window, handle);
			};
			window.setInterval = function (...a) {
				const handle = si.apply(window, a);
				live.intervals.add(handle);
				return handle;
			};
			window.clearInterval = (handle) => {
				live.intervals.delete(handle);
				ci.call(window, handle);
			};
			// live audio connections: connect adds an edge, disconnect() drops the node's edges
			let edges = 0;
			const out = new WeakMap();
			const conn = AudioNode.prototype.connect;
			const disc = AudioNode.prototype.disconnect;
			AudioNode.prototype.connect = function (...a) {
				out.set(this, (out.get(this) ?? 0) + 1);
				edges++;
				return conn.apply(this, a);
			};
			AudioNode.prototype.disconnect = function (...a) {
				const n = out.get(this) ?? 0;
				if (!a.length) {
					edges -= n;
					out.set(this, 0);
				} else if (n > 0) {
					out.set(this, n - 1);
					edges--;
				}
				return disc.apply(this, a);
			};
			window.__lcMeasure = () => {
				const env = window.__lcEnv;
				const { get } = env;
				const R = env.registries;
				const scene = get(env.mods.sceneStore.globalScene);
				const renderer = get(env.mods.sceneStore.globalRenderer);
				let meshes = 0;
				const materials = new Set();
				const geometries = new Set();
				scene?.traverse((o) => {
					if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
					meshes++;
					if (o.geometry) geometries.add(o.geometry);
					for (const m of [].concat(o.material ?? [])) materials.add(m);
				});
				const regs = env.lifecycle.allRegistrations();
				let journal = 0;
				for (const kinds of Object.values(regs)) for (const n of Object.values(kinds)) journal += n;
				return {
					handlers:
						R.moduleClickHandlers.length +
						R.moduleDropHandlers.length +
						R.moduleFrameTasks.length +
						R.sceneClearHandlers.length +
						R.moduleClickMissHandlers.length,
					groups: R.moduleInteractiveGroups.length + R.systemGroupNames.length,
					nodes:
						get(R.moduleNodeGroups).reduce((n, g) => n + g.items.length, 0) +
						Object.keys(R.moduleEffects).length +
						Object.keys(env.mods.moduleNodeIO.moduleValueNodes).length +
						Object.keys(R.moduleNodeComponents).length,
					menus:
						get(R.moduleMenuItems).length +
						get(R.modulePrimitiveGroups).reduce((n, g) => n + g.items.length, 0),
					wire:
						Object.values(R.messageHandlers).reduce((n, l) => n + l.length, 0) +
						Object.keys(R.stateSyncs).length,
					audioEdges: edges,
					intervals: live.intervals.size,
					timeouts: live.timeouts.size,
					meshes,
					materials: materials.size,
					sceneGeometries: geometries.size,
					gpuGeometries: renderer?.info.memory.geometries ?? -1,
					gpuTextures: renderer?.info.memory.textures ?? -1,
					journal
				};
			};
		});
		const metrics = async () => {
			await cdp.send('HeapProfiler.collectGarbage');
			await page.waitForTimeout(150);
			await cdp.send('HeapProfiler.collectGarbage');
			const m = Object.fromEntries(
				(await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value])
			);
			const app = await page.evaluate(() => window.__lcMeasure());
			return {
				...app,
				domNodes: m.Nodes,
				jsListeners: m.JSEventListeners,
				heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2)
			};
		};
		// exact metrics must not move by one; the noisy ones get a small allowance
		const EXACT = [
			'handlers',
			'groups',
			'nodes',
			'menus',
			'wire',
			'audioEdges',
			'intervals',
			'meshes',
			'materials',
			'sceneGeometries',
			'gpuGeometries',
			'gpuTextures',
			'journal'
		];
		const coreIds = await page.evaluate(() => window.__lcEnv.coreModules.map((m) => m.id));
		h.check(coreIds.length >= 5, '3.0 the bundled modules: ' + coreIds.join(', '));
		evidence.leak = {};
		for (const id of coreIds) {
			const unloaded = [];
			const loaded = [];
			/** listeners its own file left on window/document after an unload */
			const strays = [];
			// cycle 0 is a WARM-UP, not counted: a freshly booted page still uploads textures and
			// fills caches lazily, which reads as growth that is not the module's
			for (let cycle = 0; cycle <= 3; cycle++) {
				await page.evaluate((id) => window.__stores.moduleSDK.unloadModule(id), id);
				await page.waitForTimeout(500);
				const u = {
					...(await metrics()),
					mine: await page.evaluate((id) => window.__stores.moduleSDK.registrationCount(id), id)
				};
				strays.push(...(await strayListeners((url) => url.includes('/src/modules/' + id + '/'))));
				if (cycle > 0) unloaded.push(u);
				await page.evaluate(async (id) => {
					const env = window.__lcEnv;
					env.sdk.initModules([env.coreModules.find((m) => m.id === id)]);
					// exercise what the module draws: pong's table is built by its menu button
					if (id === 'pong')
						env
							.get(env.registries.moduleMenuItems)
							.find((i) => i.moduleId === 'pong')
							?.action();
				}, id);
				await page.waitForTimeout(600);
				const l = await metrics();
				if (cycle > 0) loaded.push(l);
			}
			evidence.leak[id] = { unloaded, loaded, strays };
			h.check(
				strays.length === 0,
				'3.5 ' +
					id +
					': no window/document listener from its own file outlives an unload ' +
					JSON.stringify([...new Set(strays)])
			);
			h.check(
				unloaded.every((u) => u.mine === 0),
				'3.1 ' + id + ': nothing of it is left in the registry after each unload'
			);
			const grew = EXACT.filter(
				(k) => unloaded[2][k] !== unloaded[0][k] || loaded[2][k] !== loaded[0][k]
			);
			h.check(
				grew.length === 0,
				'3.2 ' +
					id +
					': handlers, nodes, menus, wire listeners, audio, intervals, meshes, materials, GPU geometries/textures and the journal are the same after 3 cycles ' +
					(grew.length
						? JSON.stringify(
								grew.map((k) => [k, unloaded.map((u) => u[k]), loaded.map((l) => l[k])])
							)
						: '')
			);
			// the noisy ones (the app's own timers, toasts, GC timing): a LEAK rises on EVERY
			// cycle, noise does not — so a metric that climbs at each of the three unloads fails
			const NOISY = ['timeouts', 'domNodes', 'jsListeners', 'heapMB'];
			const rising = NOISY.filter(
				(k) =>
					unloaded[1][k] > unloaded[0][k] &&
					unloaded[2][k] > unloaded[1][k] &&
					(k !== 'heapMB' || unloaded[2][k] - unloaded[0][k] > 0.25)
			);
			h.check(
				rising.length === 0,
				'3.3 ' +
					id +
					': timeouts, DOM nodes, JS listeners and the heap after GC do not climb cycle over cycle ' +
					JSON.stringify(Object.fromEntries(NOISY.map((k) => [k, unloaded.map((u) => u[k])])))
			);
			if (id === 'pong') {
				h.check(
					loaded[0].meshes > unloaded[0].meshes,
					'3.4 pong: the exercise really drew its table (' +
						unloaded[0].meshes +
						' -> ' +
						loaded[0].meshes +
						' meshes)'
				);
			}
		}
	}
	if (EVIDENCE) {
		fs.mkdirSync(EVIDENCE, { recursive: true });
		fs.writeFileSync(
			path.join(EVIDENCE, 'module-lifecycle.json'),
			JSON.stringify(evidence, null, 1)
		);
	}
	await h.finish(browser);
});
