// Phase 108: Scene manifest — the Explorer's Scene folder derives from what
// the replicated scene references (sound hashes, script nodes, textures),
// stays identical on both peers, and self-cleans when references disappear.
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const assetsOn = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.sceneAssets.sceneAssets.subscribe((list) =>
					resolve(list.map((a) => ({ group: a.group, name: a.name })))
				)();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 8000);

	// seed: a wav in the library, a box, a sound node + script node, a texture
	await A.page.evaluate(async (png) => {
		const rate = 8000;
		const n = rate / 8;
		const buf = new ArrayBuffer(44 + n * 2);
		const v = new DataView(buf);
		const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
		str(0, 'RIFF');
		v.setUint32(4, 36 + n * 2, true);
		str(8, 'WAVE');
		str(12, 'fmt ');
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true);
		v.setUint16(22, 1, true);
		v.setUint32(24, rate, true);
		v.setUint32(28, rate * 2, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		str(36, 'data');
		v.setUint32(40, n * 2, true);
		const created = await window.__stores.explorer.importFiles(
			[new File([buf], 'beep.wav', { type: 'audio/wav' })],
			null
		);
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		// texture through the replicated path
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		await window.__stores.materialsHandler.setObjectTexture(
			box.uuid,
			new File([bytes], 'checker.png', { type: 'image/png' })
		);
		window.__stores.flowNodes.set([
			{
				id: 'snd1',
				type: 'sound',
				position: { x: 0, y: 0 },
				data: { type: 'sound', label: 'Sound', hash: created[0].hash, file: 'beep.wav', volume: 0.8, radius: 5, loop: true, playing: false },
				class: 'w-[150px]'
			},
			{
				id: 'scr1',
				type: 'script',
				position: { x: 200, y: 0 },
				data: { type: 'script', label: 'Script', name: 'mover', code: 'object.position.x = 1;' },
				class: 'w-[150px]'
			},
			{
				id: 'sel1',
				type: 'objectselector',
				position: { x: 400, y: 0 },
				data: { type: 'objectselector', label: 'Object Selector', selected: box.uuid },
				class: 'w-[150px]'
			}
		]);
		window.__stores.flowEdges.set([{ id: 'e1', source: 'snd1', target: 'sel1' }]);
	}, TINY_PNG);
	await A.page.waitForTimeout(1500);

	const aAssets = await assetsOn(A.page);
	h.check(
		aAssets.some((a) => a.group === 'audio' && a.name === 'beep.wav') &&
			aAssets.some((a) => a.group === 'config' && a.name === 'mover.js') &&
			aAssets.some((a) => a.group === 'textures'),
		`manifest derives audio + config + textures (${JSON.stringify(aAssets)})`
	);

	// identical view on the peer (references replicate; bytes pull on demand)
	await h.eventually(
		() => assetsOn(B.page),
		(b) =>
			b.some((a) => a.group === 'audio') &&
			b.some((a) => a.group === 'config') &&
			b.some((a) => a.group === 'textures'),
		'peer derives the same Scene manifest'
	);

	// the Explorer surfaces it
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(500);
	await A.page.locator('#scene-folder').click();
	await A.page.waitForTimeout(400);
	const sceneCards = await A.page.evaluate(() =>
		[...document.querySelectorAll('#explorer-list .explorer-card')].map((el) => el.textContent?.trim())
	);
	h.check(sceneCards.length === 3, `Scene folder lists the manifest (${sceneCards.length} cards)`);
	// the group rows are COLLAPSED by default and revealed by a DOUBLE-click (see
	// `sceneExpanded`, 197). This check used to single-click and then assert they were
	// visible, which could only pass on a profile where an earlier run had already
	// expanded them — a latent leak between runs, not a claim about the feature. Drive
	// the real gesture.
	await A.page.locator('#scene-folder').dblclick();
	await A.page.waitForTimeout(400);
	const subCounts = await A.page.getByText('audio (1)', { exact: false }).isVisible();
	h.check(subCounts, 'structured subfolders show their counts');

	// self-clean: remove the texture and the sound node -> entries vanish
	await A.page.evaluate(() => {
		window.__stores.materialsHandler.removeObjectTexture(window.__box.uuid);
		let nodes = [];
		window.__stores.flowNodes.subscribe((v) => (nodes = v))();
		window.__stores.flowNodes.set(nodes.filter((n) => n.id !== 'snd1'));
	});
	await A.page.waitForTimeout(1200);
	const cleaned = await assetsOn(A.page);
	h.check(
		!cleaned.some((a) => a.group === 'audio') && !cleaned.some((a) => a.group === 'textures') && cleaned.some((a) => a.group === 'config'),
		`manifest self-cleans when references disappear (${JSON.stringify(cleaned)})`
	);

	await h.finish(browser);
});
