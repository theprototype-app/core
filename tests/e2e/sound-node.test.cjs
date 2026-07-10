// Phase 97: sound node — spatial audio chains build from Explorer files, the
// bytes PULL to peers missing the content hash (landing in their Shared
// folder), the play toggle replicates through node data, and the panner
// tracks the target object. Audible output is the user's manual check.
const h = require('./helpers.cjs');

const entriesOn = (page) =>
	page.evaluate(() => window.__stores.soundRuntime.soundEntries());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// A: generate a tiny WAV into the Explorer + wire box <- sound node
	const hash = await A.page.evaluate(async () => {
		const rate = 8000;
		const n = rate / 4;
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
		for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 10) * 12000, true);
		const created = await window.__stores.explorer.importFiles(
			[new File([buf], 'blip.wav', { type: 'audio/wav' })],
			null
		);
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		window.__stores.flowNodes.set([
			{
				id: 'snd1',
				type: 'sound',
				position: { x: 20, y: 20 },
				data: { type: 'sound', label: 'Sound', hash: created[0].hash, file: 'blip.wav', volume: 0.8, radius: 5, loop: true, playing: false },
				class: 'w-[150px]'
			},
			{
				id: 'sel1',
				type: 'objectselector',
				position: { x: 260, y: 20 },
				data: { type: 'objectselector', label: 'Object Selector', selected: box.uuid },
				class: 'w-[150px]'
			}
		]);
		window.__stores.flowEdges.set([{ id: 'e1', source: 'snd1', target: 'sel1' }]);
		return created[0].hash;
	});
	await A.page.waitForTimeout(1500);
	let aEntries = await entriesOn(A.page);
	h.check(
		aEntries.length === 1 && aEntries[0].buffered && !aEntries[0].playing,
		`sound chain decodes and waits (${JSON.stringify(aEntries)})`
	);

	// B joins: gets the graph via handshake, misses the hash, PULLS the bytes
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 12000);
	await h.eventually(
		() =>
			B.page.evaluate(
				(hash) => !!window.__stores.explorer.itemByHash(hash),
				hash
			),
		(v) => v === true,
		'B pulled the shared sound by hash'
	);
	const bShared = await B.page.evaluate(
		(hash) =>
			new Promise((resolve) => {
				const item = window.__stores.explorer.itemByHash(hash);
				window.__stores.explorer.explorerFolders.subscribe((folders) =>
					resolve(folders.find((f) => f.id === item.folderId)?.name ?? null)
				)();
			}),
		hash
	);
	h.check(bShared === 'Shared', `pulled bytes land in the Shared folder (${bShared})`);
	await h.eventually(
		() => entriesOn(B.page),
		(entries) => entries.length === 1 && entries[0].buffered,
		'B builds the same sound chain from the pulled bytes'
	);

	// Play toggles through the REAL node button and replicates as node data
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(900);
	await A.page.locator('.node-card button', { hasText: '▶ Play' }).click();
	await A.page.waitForTimeout(900);
	aEntries = await entriesOn(A.page);
	h.check(aEntries[0]?.playing === true, 'Play starts the source on A');
	await h.eventually(
		() => entriesOn(B.page),
		(entries) => entries[0]?.playing === true,
		'playing state replicates to B'
	);

	// the panner follows the object
	await A.page.evaluate(() => {
		window.__box.position.set(3, 1, 2);
		window.__box.updateMatrixWorld(true);
	});
	await A.page.waitForTimeout(400);
	aEntries = await entriesOn(A.page);
	const p = aEntries[0]?.panner ?? [];
	h.check(
		Math.abs(p[0] - 3) < 0.01 && Math.abs(p[1] - 1) < 0.01 && Math.abs(p[2] - 2) < 0.01,
		`panner tracks the object (${p.map((v) => v.toFixed(1))})`
	);

	await h.finish(browser);
});
