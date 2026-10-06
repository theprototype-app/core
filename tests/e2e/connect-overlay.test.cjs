// Phase 152: the Connect panel's transparent p-8 padding (z-index 300) used to
// eat clicks/drags over neighbouring windows. Now the wrapper is
// pointer-events:none (padding passes through) with the Navbar re-enabling
// events on its own visible area — so the controls still work but the padding
// no longer steals input.
// 38 R8: ported to the markup since #14 — the wrapper is `.connect-wrap` (pointer-events
// none) and the visible bar is `.connect-pill` (auto). The p-8 padding is gone, so the
// "padding passes through" check now asks the same question of the wrapper's own box:
// a point beside the pill, inside the wrapper's row, must not land on Connect.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const info = await A.page.evaluate(() => {
		const input = document.querySelector('input[placeholder="Enter peer ID to connect"]');
		if (!input) return { ok: false };
		const wrapper = input.closest('.connect-wrap');
		const inner = wrapper?.querySelector('.connect-pill');
		if (!wrapper || !inner) return { ok: false };
		const wb = wrapper.getBoundingClientRect();
		const ib = inner.getBoundingClientRect();
		// the wrapper's 8px top offset strip, centred over the pill: transparent, so a press
		// there must reach whatever is underneath, never the Connect chrome
		const padX = wb.left + wb.width / 2;
		const padY = Math.max(1, wb.top - 4);
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
	h.check(info.wrapperPE === 'none', 'the Connect wrapper is pointer-events:none');
	h.check(info.innerPE === 'auto', 'the visible bar (.connect-pill) re-enables pointer-events');
	h.check(info.padPassesThrough, 'a click just above the bar passes through (does not hit the Connect chrome)');
	h.check(info.inputReachable, 'the Connect controls still capture clicks on their visible area');

	// the controls still function: the input accepts text
	await A.page.fill('input[placeholder="Enter peer ID to connect"]', 'abcde');
	const typed = await A.page.inputValue('input[placeholder="Enter peer ID to connect"]');
	h.check(typed === 'abcde', 'the Connect input still works');

	await h.finish(browser);
});
