// Phase 152: the Connect panel's transparent p-8 padding (z-index 300) used to
// eat clicks/drags over neighbouring windows. Now the wrapper is
// pointer-events:none (padding passes through) with the Navbar re-enabling
// events on its own visible area — so the controls still work but the padding
// no longer steals input.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const info = await A.page.evaluate(() => {
		const input = document.querySelector('input[placeholder="Enter peer ID to connect"]');
		if (!input) return { ok: false };
		const wrapper = input.closest('.p-8');
		const inner = wrapper.querySelector('div[style*="pointer-events: auto"]');
		const wb = wrapper.getBoundingClientRect();
		const ib = inner.getBoundingClientRect();
		// a point in the transparent TOP padding strip (above the navbar), centered
		const padX = wb.left + wb.width / 2;
		const padY = wb.top + Math.max(2, (ib.top - wb.top) / 2);
		const atPad = document.elementFromPoint(padX, padY);
		const atInput = document.elementFromPoint(ib.left + ib.width / 2, ib.top + ib.height / 2);
		return {
			ok: true,
			wrapperPE: getComputedStyle(wrapper).pointerEvents,
			innerPE: getComputedStyle(inner).pointerEvents,
			padPassesThrough: !wrapper.contains(atPad),
			inputReachable: !!(atInput && inner.contains(atInput))
		};
	});
	h.check(info.ok, 'the Connect panel renders');
	h.check(info.wrapperPE === 'none', 'the padding wrapper is pointer-events:none');
	h.check(info.innerPE === 'auto', 'the Navbar wrapper re-enables pointer-events');
	h.check(info.padPassesThrough, 'a click in the transparent padding passes through (does not hit the Connect wrapper)');
	h.check(info.inputReachable, 'the Connect controls still capture clicks on their visible area');

	// the controls still function: the input accepts text
	await A.page.fill('input[placeholder="Enter peer ID to connect"]', 'abcde');
	const typed = await A.page.inputValue('input[placeholder="Enter peer ID to connect"]');
	h.check(typed === 'abcde', 'the Connect input still works');

	await h.finish(browser);
});
