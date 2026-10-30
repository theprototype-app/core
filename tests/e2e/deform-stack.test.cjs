// fix-agenttest item 2 — TWO VERTEX DEFORMERS ON ONE OBJECT COMPILE.
// Body Wave and Jiggle each cloned the mesh's material and wrapped its onBeforeCompile; on one
// object they wrapped each other and the wave's declarations went in twice ("Vertex shader is
// not compiled ... 'bwToRoot' : redefinition"). vertexDeform.js gives a mesh ONE clone holding
// every deformer. Every pair: wave+jiggle, jiggle+wave, wave+wave, jiggle on a parent + jiggle
// on its child (the child mesh is jiggled twice). Counterfactual on v1.47.0 (measured): wave+wave
// and the parent+child jiggles log the shader error, and every pair nests clones, so removing the
// nodes never puts the original material back.
const h = require('./helpers.cjs');

const WAVE = { type: 'bodywave', data: { amplitude: 0.1, wavelength: 1, frequency: 1.5 } };
const JIG = { type: 'jiggle', data: { stiffness: 80, damping: 0.1, amplitude: 0.15, frequency: 3 } };

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const shaderErrors = [];
	page.on('console', (m) => {
		const t = m.text();
		if (/Shader Error|not compiled|redefinition/i.test(t)) shaderErrors.push(t.slice(0, 300));
	});

	const PAIRS = [
		['wave + jiggle', [WAVE, JIG], null],
		['jiggle + wave', [JIG, WAVE], null],
		['wave + wave', [WAVE, WAVE], null],
		['jiggle on parent + jiggle on child', [JIG], [JIG]]
	];

	for (const [label, nodes, childNodes] of PAIRS) {
		const before = shaderErrors.length;
		const setup = await page.evaluate(
			({ nodes, childNodes }) => {
				const S = window.__stores;
				S.commandsHandler.sceneCommand('/clear all');
				S.commandsHandler.sceneCommand('/create Box 1 1.6 1');
				let g;
				S.objectsGroup.subscribe((v) => (g = v))();
				const box = g.children[g.children.length - 1];
				box.position.set(0, 0.8, 0);
				const graphs = {
					[box.uuid]: {
						nodes: nodes.map((n, i) => ({ id: 'd' + i, type: n.type, position: { x: 20, y: 20 + i * 120 }, data: { ...n.data } })),
						edges: []
					}
				};
				let target = box;
				if (childNodes) {
					// a child box parented under the first: the parent's jiggle traverses into it
					S.commandsHandler.sceneCommand('/create Box 0.5 0.5 0.5');
					const kid = g.children[g.children.length - 1];
					box.add(kid);
					kid.position.set(0, 1, 0);
					graphs[kid.uuid] = {
						nodes: childNodes.map((n, i) => ({ id: 'k' + i, type: n.type, position: { x: 20, y: 20 }, data: { ...n.data } })),
						edges: []
					};
					target = kid;
				}
				box.updateMatrixWorld(true);
				window.__deformTarget = target;
				window.__deformOriginal = target.material;
				S.flowGraphs.update((all) => ({ ...all, ...graphs }));
				return { uuid: target.uuid };
			},
			{ nodes, childNodes }
		);
		h.check(!!setup.uuid, `${label}: authored`);
		// move it so both deformers have something to do, and let a few frames draw it
		const state = await page.evaluate(async () => {
			const t = window.__deformTarget;
			const root = t.parent?.isMesh ? t.parent : t;
			for (let i = 0; i < 30; i++) {
				root.position.x += 0.03;
				root.rotation.y += 0.05;
				root.updateMatrixWorld(true);
				await new Promise((r) => requestAnimationFrame(r));
			}
			const m = t.material;
			return {
				key: m.customProgramCacheKey?.() ?? '',
				cloned: m !== window.__deformOriginal,
				sameUuid: m.uuid === window.__deformOriginal.uuid
			};
		});
		const wants = nodes.concat(childNodes ?? []).map((n) => (n.type === 'bodywave' ? 'bodywave1' : 'jiggle1'));
		const count = (s, k) => s.split(k).length - 1;
		const kinds = [...new Set(wants)];
		const full = (key) => kinds.every((k) => count(key, k) === wants.filter((w) => w === k).length);
		// both deformers attach on the flow tick (a headless dev page draws at a few fps)
		await h.eventually(
			() => page.evaluate(() => window.__deformTarget.material.customProgramCacheKey?.() ?? ''),
			full,
			`${label}: both deformers attached`,
			20000
		);
		Object.assign(
			state,
			await page.evaluate(() => {
				const m = window.__deformTarget.material;
				return { key: m.customProgramCacheKey?.() ?? '', cloned: m !== window.__deformOriginal, sameUuid: m.uuid === window.__deformOriginal.uuid };
			})
		);
		// and a few more frames with both on, so the stacked program is really drawn
		await page.evaluate(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r)); });
		const fresh = shaderErrors.slice(before);
		h.check(fresh.length === 0, `${label}: the stacked material compiles (no shader error)` + (fresh.length ? ': ' + fresh[0] : ''));
		h.check(
			state.cloned && state.sameUuid && full(state.key),
			`${label}: ONE clone carries both deformers (${state.key})`
		);

		// remove the graphs: the original material comes back
		const back = await page.evaluate(async () => {
			const S = window.__stores;
			const t = window.__deformTarget;
			const keys = [t.uuid, t.parent?.uuid].filter(Boolean);
			S.flowGraphs.update((all) => {
				const next = { ...all };
				for (const k of keys) delete next[k];
				return next;
			});
			for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
			return t.material === window.__deformOriginal;
		});
		h.check(back, `${label}: removing the nodes puts the original material back`);
	}

	const errs = h.pageErrors ? h.pageErrors(A) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
