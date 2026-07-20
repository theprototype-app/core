// V-3: new primitives get a curated palette color (not 0x00ff00), assigned
// deterministically by uuid so peers compute the SAME color with no wire bytes.
const h = require('./helpers.cjs');

// map every 'Box' mesh uuid -> its material color hex
const boxColors = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const out = {};
					g?.traverse((o) => {
						if (o.isMesh && o.name === 'Box') out[o.uuid] = '#' + o.material.color.getHexString();
					});
					resolve(out);
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const palette = await A.page.evaluate(() => window.__stores.palette.DEFAULT_PALETTE);
	h.check(Array.isArray(palette) && palette.length === 8, `palette has 8 colors (${palette.length})`);
	h.check(!palette.includes('#00ff00'), 'palette does not contain the old bright green');

	// connect B first, so a create on A replicates via the `create` message and
	// B re-runs createGeometry(command, uuid) — directly exercising the
	// deterministic uuid->color hash (not a serialized material)
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	await A.page.evaluate(() => {
		for (let i = 0; i < 5; i++) window.__stores.commandsHandler.sceneCommand('/create box');
	});
	await B.page.waitForTimeout(1500);

	const colors = await boxColors(A.page);
	const uuids = Object.keys(colors);
	const vals = uuids.map((u) => colors[u]);
	h.check(uuids.length >= 5, `created boxes present on A (${uuids.length})`);
	h.check(vals.every((c) => palette.includes(c)), `every new primitive is a palette color (${vals.join(', ')})`);
	h.check(new Set(vals).size > 1, `colors vary across objects (${new Set(vals).size} distinct)`);

	const bColors = await boxColors(B.page);
	const matches = uuids.filter((u) => bColors[u] && bColors[u] === colors[u]);
	h.check(matches.length === uuids.length, `peer B computes the identical color per uuid (${matches.length}/${uuids.length})`);

	await h.finish(browser);
});
