// 34 R6 (contract T2): the modules REPO through the lifecycle — every packed zip in the
// sibling modules checkout (helpers.moduleZipPath; MODULES_REPO wins) installed, its
// toolboxes opened (that is where the repo's refresh intervals live), then unloaded and
// re-activated 3x.
//
// GATED, because core guarantees it for any module: after every unload the module's
// lifecycle registry is empty, its scope (installed-module timers + window/document
// listeners) is gone, and no window/document listener from its code (a blob: script) is
// left. REPORTED, not gated, because it is the module's own code: what still climbs cycle
// over cycle (raw WebAudio connections made on api.audio.context(), DOM it appended
// outside a toolbox, the heap). The table goes to LIFECYCLE_EVIDENCE/module-lifecycle-repo.json
// and to the log; the modules repo owns those findings. Skips (never fails) without zips.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.LIFECYCLE_EVIDENCE || '';
const ONLY = (process.env.LIFECYCLE_MODULES || '').split(',').filter(Boolean);

h.run(async () => {
	const dir = path.dirname(h.moduleZipPath('x'));
	const zips = fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => f.endsWith('.zip') && !f.startsWith('_'))
				.map((f) => f.slice(0, -4))
				.filter((id) => !ONLY.length || ONLY.includes(id))
				.sort()
		: [];
	if (!zips.length) {
		console.log('SKIP: no packed module zips in ' + dir + ' (npm run pack -- --all there)');
		console.log('ALL PASS');
		process.exit(0);
	}
	const browser = await h.launch({ args: [...h.AUDIO_ARGS] });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const cdp = await page.context().newCDPSession(page);
	/** @type {Map<string, string>} */
	const scripts = new Map();
	cdp.on('Debugger.scriptParsed', (e) => scripts.set(e.scriptId, e.url));
	await cdp.send('Debugger.enable');
	await cdp.send('Performance.enable');
	const blobListeners = async () => {
		const out = [];
		for (const expr of ['window', 'document']) {
			const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
			const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
				objectId: result.objectId
			});
			for (const l of listeners)
				if ((scripts.get(l.scriptId) ?? '').startsWith('blob:'))
					out.push(expr + ':' + l.type + ':' + l.lineNumber);
		}
		return out;
	};
	await page.evaluate(async () => {
		window.__lcEnv = await window.__stores.moduleLifecycle.lifecycleEnv();
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
		window.__lcMeasure = (id) => {
			const env = window.__lcEnv;
			const { get } = env;
			const scene = get(env.mods.sceneStore.globalScene);
			const renderer = get(env.mods.sceneStore.globalRenderer);
			let meshes = 0;
			scene?.traverse((o) => {
				if (o.isMesh || o.isLine || o.isPoints || o.isSprite) meshes++;
			});
			return {
				journal: env.lifecycle.registrationCount(id),
				scope: window.__stores.moduleSDK.moduleScopeDebug()[id] ?? null,
				audioEdges: edges,
				meshes,
				gpuGeometries: renderer?.info.memory.geometries ?? -1,
				gpuTextures: renderer?.info.memory.textures ?? -1
			};
		};
	});
	const metrics = async (id) => {
		await cdp.send('HeapProfiler.collectGarbage');
		await page.waitForTimeout(100);
		await cdp.send('HeapProfiler.collectGarbage');
		const m = Object.fromEntries(
			(await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value])
		);
		return {
			...(await page.evaluate((id) => window.__lcMeasure(id), id)),
			domNodes: m.Nodes,
			jsListeners: m.JSEventListeners,
			heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2)
		};
	};

	const report = {};
	for (const id of zips) {
		const started = Date.now();
		const bytes = fs.readFileSync(h.moduleZipPath(id)).toString('base64');
		const installed = await page.evaluate(
			async ({ id, bytes }) => {
				const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
				const ok = await window.__stores.userModules.installZip(
					new File([raw], id + '.zip', { type: 'application/zip' })
				);
				return ok && window.__stores.moduleSDK.isModuleLoaded(id);
			},
			{ id, bytes }
		);
		if (!installed) {
			h.check(false, id + ': installs from its zip');
			continue;
		}
		const cycles = [];
		for (let cycle = 0; cycle <= 3; cycle++) {
			// exercise: open every toolbox it registered (their mount fns run the refresh timers)
			await page.evaluate((id) => {
				const env = window.__lcEnv;
				for (const box of env.get(env.mods.moduleToolboxes.moduleToolboxes))
					if (box.moduleId === id) env.mods.moduleToolboxes.openModuleToolbox(box.id);
			}, id);
			await page.waitForTimeout(400);
			const loaded = await metrics(id);
			await page.evaluate((id) => window.__stores.moduleSDK.unloadModule(id), id);
			await page.waitForTimeout(400);
			const unloaded = { ...(await metrics(id)), strays: await blobListeners() };
			if (cycle > 0) cycles.push({ loaded, unloaded });
			if (cycle < 3) {
				await page.evaluate(async (id) => {
					const record = window.__lcEnv
						.get(window.__stores.userModules.userModules)
						.find((r) => r.id === id);
					await window.__stores.userModules.activateUserModule(record);
				}, id);
			}
		}
		const u = cycles.map((c) => c.unloaded);
		const l = cycles.map((c) => c.loaded);
		h.check(
			u.every((x) => x.journal === 0),
			id + ': its registry is empty after every unload ' + JSON.stringify(u.map((x) => x.journal))
		);
		h.check(
			u.every((x) => x.scope === null),
			id + ': its scope (timers + window/document listeners) is gone after every unload'
		);
		h.check(
			u.every((x) => x.strays.length === 0),
			id +
				': no window/document listener from its code outlives an unload ' +
				JSON.stringify(u.flatMap((x) => x.strays))
		);
		const climbs = [
			'audioEdges',
			'meshes',
			'gpuGeometries',
			'gpuTextures',
			'domNodes',
			'jsListeners',
			'heapMB'
		].filter(
			(k) => u[1][k] > u[0][k] && u[2][k] > u[1][k] && (k !== 'heapMB' || u[2][k] - u[0][k] > 0.25)
		);
		report[id] = {
			seconds: Math.round((Date.now() - started) / 1000),
			climbs,
			unloaded: Object.fromEntries(
				[
					'audioEdges',
					'meshes',
					'gpuGeometries',
					'gpuTextures',
					'domNodes',
					'jsListeners',
					'heapMB'
				].map((k) => [k, u.map((x) => x[k])])
			),
			loadedScope: l.map((x) => x.scope)
		};
		console.log('REPORT ' + id + ' ' + JSON.stringify(report[id]));
		await page.evaluate((id) => window.__stores.userModules.removeUserModule(id), id);
	}
	if (EVIDENCE) {
		fs.mkdirSync(EVIDENCE, { recursive: true });
		fs.writeFileSync(
			path.join(EVIDENCE, 'module-lifecycle-repo.json'),
			JSON.stringify(report, null, 1)
		);
	}
	await h.finish(browser);
});
