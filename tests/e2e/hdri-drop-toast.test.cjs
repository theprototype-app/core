// fix-batch-2 (1.45.1): an HDRI dragged from the Explorer onto the viewport said "Audio/text
// items are used where they plug in" (explorerDrop's generic branch). It now says where an HDRI
// goes, with a one-click way there. Counterfactual: §1 is red on 1.45.0 (the audio/text line).
const h = require('./helpers.cjs');

const toasts = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.toastStore.subscribe((list) =>
					r(list.map((t) => (typeof t === 'string' ? { text: t, actions: [] } : { text: t.text, actions: (t.actions ?? []).map((a) => a.label) })))
				)()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// a minimal Radiance header is enough: the drop never decodes it
	const id = await page.evaluate(async () => {
		const bytes = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\u0080\u0080\u0080\u0081');
		const item = await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'sky-test.hdr', null);
		return item?.id ?? null;
	});
	h.check(!!id, '§0 an .hdr item is in the Explorer');
	const kind = await page.evaluate(
		(id) => new Promise((r) => window.__stores.explorer.explorerItems.subscribe((l) => r(l.find((i) => i.id === id)?.kind))()),
		id
	);
	h.check(kind === 'hdri', `§0 ... of kind hdri (${kind})`);

	const vp = page.viewportSize() ?? { width: 1280, height: 720 };
	await page.evaluate(({ id, x, y }) => window.__stores.explorerDrop.dropExplorerItem({ id, kind: 'hdri', name: 'sky-test.hdr' }, x, y), {
		id,
		x: Math.round(vp.width / 2),
		y: Math.round(vp.height * 0.7)
	});
	await page.waitForTimeout(300);
	const list = await toasts(page);
	const last = list[list.length - 1];
	h.check(!!last && /HDRI lights the whole scene/.test(last.text), `§1 the toast talks about the HDRI (${last?.text})`);
	h.check(!list.some((t) => /Audio\/text items/.test(t.text)), '§1 ... not the audio/text line');
	h.check(last?.actions.includes('Open Environment'), '§1 ... with an "Open Environment" action');

	h.check(h.pageErrors(A).length === 0, 'no page errors');
	await h.finish(browser);
});
