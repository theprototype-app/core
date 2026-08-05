// 16-Q3: ONE numeric field everywhere (DragRow) — transform rows, the boxes beside
// sliders, and the loose inputs that used to be plain <input type="number">.
//   • typing applies LIVE (no Enter)
//   • ArrowUp/Down step one MINOR unit (0.01 at 2 decimals), Ctrl ×10, Shift ×100
//   • integer fields (decimals 0) step by 1 / 10 / 100
//   • Esc reverts to the value you started with
//   • horizontal drag still scrubs
const h = require('./helpers.cjs');

const posX = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.selectedObject.subscribe((o) => r(Math.round((o?.position.x ?? 0) * 1000) / 1000))()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a box selected with its properties open
	await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 250));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(0, 0, 0);
		w.objectActions.selectObject(box.uuid, true);
		localStorage.setItem('inspector:sec:Transform', 'open');
	});
	await A.page.waitForTimeout(700);

	// the X position field of the transform row
	const field = A.page.locator('.dn-wrap', { has: A.page.locator('.dn-label', { hasText: 'X' }) }).first();
	const input = field.locator('.dn-input');
	h.check(await input.count() > 0, 'the transform row renders the shared numeric field');

	// ---------- typing is LIVE ----------
	await input.click();
	await A.page.waitForTimeout(150);
	await input.fill('2.5');
	await A.page.waitForTimeout(250);
	h.check((await posX(A.page)) === 2.5, `typing applies without Enter (${await posX(A.page)})`);

	// ---------- arrow keys: minor unit, then Ctrl and Shift ----------
	await input.press('ArrowUp');
	await A.page.waitForTimeout(150);
	let value = await posX(A.page);
	h.check(Math.abs(value - 2.51) < 0.0005, `ArrowUp adds one minor unit 0.01 (${value})`);

	await input.press('ArrowDown');
	await A.page.waitForTimeout(150);
	value = await posX(A.page);
	h.check(Math.abs(value - 2.5) < 0.0005, `ArrowDown subtracts 0.01 (${value})`);

	await input.press('Control+ArrowUp');
	await A.page.waitForTimeout(150);
	value = await posX(A.page);
	h.check(Math.abs(value - 2.6) < 0.0005, `Ctrl+ArrowUp adds 0.10 (${value})`);

	await input.press('Shift+ArrowUp');
	await A.page.waitForTimeout(150);
	value = await posX(A.page);
	h.check(Math.abs(value - 3.6) < 0.0005, `Shift+ArrowUp adds 1 (${value})`);

	// ---------- Esc reverts to the value the field was focused with ----------
	await A.page.locator('#drawer-label').click({ position: { x: 5, y: 5 } }).catch(() => {});
	await A.page.waitForTimeout(200);
	await input.click();
	await A.page.waitForTimeout(200);
	const beforeEsc = await posX(A.page);
	await input.press('ArrowUp');
	await input.press('ArrowUp');
	await A.page.waitForTimeout(150);
	await input.press('Escape');
	await A.page.waitForTimeout(250);
	value = await posX(A.page);
	h.check(Math.abs(value - beforeEsc) < 0.0005, `Esc reverts the edit (${beforeEsc} -> ${value})`);

	// ---------- drag still scrubs ----------
	const box = await field.boundingBox();
	const start = await posX(A.page);
	await A.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await A.page.mouse.down();
	await A.page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	value = await posX(A.page);
	h.check(value > start + 0.2, `dragging right scrubs the value up (${start} -> ${value})`);

	// ---------- an INTEGER field steps by whole numbers ----------
	const intStep = await A.page.evaluate(async () => {
		const w = window.__stores;
		localStorage.setItem('inspector:sec:Object', 'open');
		await new Promise((r) => setTimeout(r, 500));
		const el = document.querySelector('#inspector-render-order');
		if (!el) return null;
		el.focus();
		const before = Number(el.value);
		el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		await new Promise((r) => setTimeout(r, 200));
		const afterPlain = Number(document.querySelector('#inspector-render-order').value);
		el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true }));
		await new Promise((r) => setTimeout(r, 200));
		const afterCtrl = Number(document.querySelector('#inspector-render-order').value);
		return { before, afterPlain, afterCtrl };
	});
	h.check(intStep !== null, 'found the integer field (render order)');
	h.check(
		intStep && intStep.afterPlain === intStep.before + 1,
		`an integer field steps by 1 (${JSON.stringify(intStep)})`
	);
	h.check(intStep && intStep.afterCtrl === intStep.afterPlain + 10, 'Ctrl steps it by 10');

	// ---------- the boxes beside sliders are the same field ----------
	const sliderBox = await A.page.evaluate(async () => {
		window.__stores.showSidebar('scene');
		await new Promise((r) => setTimeout(r, 600));
		window.__stores.inspectorScrollTo.set('Camera');
		await new Promise((r) => setTimeout(r, 400));
		const far = document.querySelector('#camera-far');
		if (!far) return null;
		far.focus();
		const before = Number(far.value);
		far.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true }));
		await new Promise((r) => setTimeout(r, 250));
		return { before, after: Number(document.querySelector('#camera-far').value), tag: far.tagName };
	});
	h.check(sliderBox !== null && sliderBox.tag === 'INPUT', 'the far-clip box is the shared field');
	h.check(
		sliderBox && sliderBox.after === sliderBox.before + 10,
		`it steps with the same rules (${JSON.stringify(sliderBox)})`
	);


	// ---------- 16-Q6: a scrub must not put a caret in the field -----------------
	await A.page.evaluate(async () => {
		const w = window.__stores;
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		w.objectActions.selectObject(g.children[0].uuid, true);
		localStorage.setItem("inspector:sec:Transform", "open");
		await new Promise((r) => setTimeout(r, 600));
	});
	await A.page.waitForTimeout(700);
	const caretField = A.page.locator(".dn-wrap").first();
	// the panel is still scrolled from the deep-link section above
	await caretField.scrollIntoViewIfNeeded();
	await A.page.waitForTimeout(300);
	const caret = await A.page.evaluate(() => document.activeElement?.className ?? '');
	await A.page.locator('#drawer-label').click({ position: { x: 5, y: 5 } }).catch(() => {});
	await A.page.waitForTimeout(200);
	const fieldBox = await caretField.boundingBox();
	await A.page.mouse.move(fieldBox.x + fieldBox.width / 2, fieldBox.y + fieldBox.height / 2);
	await A.page.mouse.down();
	await A.page.mouse.move(fieldBox.x + fieldBox.width / 2 + 30, fieldBox.y + fieldBox.height / 2, { steps: 5 });
	const duringDrag = await A.page.evaluate(() => ({
		focused: document.activeElement === document.querySelector('.dn-wrap .dn-input'),
		selection: (document.getSelection?.()?.toString() ?? '').length,
		scrubbing: !!document.querySelector('.dn-wrap.dn-scrub')
	}));
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	h.check(duringDrag.scrubbing, 'the field reports a scrub in progress');
	h.check(!duringDrag.focused, 'no caret: dragging never focuses the input');
	h.check(duringDrag.selection === 0, 'and never smears a selection');

	// a plain CLICK still hands over the caret for typing
	await A.page.mouse.click(fieldBox.x + fieldBox.width / 2, fieldBox.y + fieldBox.height / 2);
	await A.page.waitForTimeout(250);
	const afterClick = await A.page.evaluate(
		() => document.activeElement === document.querySelector('.dn-wrap .dn-input')
	);
	h.check(afterClick, 'a click focuses it for typing');
	void caret;

	await h.finish(browser);
});
