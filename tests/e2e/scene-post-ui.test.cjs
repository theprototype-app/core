// L3 — Configure Scene ▸ Post-processing, driven through the REAL UI.
//
// Kept separate from `scene-post` (the pixel/replication suite) so both stay
// readable and each runs standalone. Everything here is a DOM assertion or a real
// mouse gesture: a store-level check could not see the panel crash on mount, and
// the whole point of this phase is that a person can build a look.

const h = require('./helpers.cjs');

/** Register two test effect kinds through the public registry seam. */
async function registerTestEffects(page) {
	return page.evaluate(() => {
		const { Effect, BlendFunction } = window.__stores.postprocessing;
		const shader = (body) =>
			'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { ' + body + ' }';
		window.__stores.scenePost.registerPostEffect('test-tint', {
			label: 'Test tint',
			group: 'grading',
			params: [
				{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.5 },
				{ key: 'mode', label: 'Mode', type: 'select', default: 'warm', options: [
					{ value: 'warm', label: 'Warm' },
					{ value: 'cool', label: 'Cool' }
				] },
				{ key: 'invert', label: 'Invert', type: 'bool', default: false }
			],
			make: () => new Effect('TestTint', shader('outputColor = inputColor;'), { blendFunction: BlendFunction.SET })
		});
		window.__stores.scenePost.registerPostEffect('test-plain', {
			label: 'Test plain',
			group: 'camera',
			make: () => new Effect('TestPlain', shader('outputColor = inputColor;'), { blendFunction: BlendFunction.SET })
		});
		return window.__stores.scenePost.postEffectKinds().length;
	});
}

/**
 * Close any open ThemedSelect popup.
 *
 * It closes on POINTERDOWN, not click — so `document.body.click()` leaves the
 * portaled `.ts-list` mounted over the panel. That was harmless while the add menu
 * had three entries and quietly fatal once L5 grew it to thirteen: the popup then
 * covered the stack rows and the parameter pane, and two later sections' real mouse
 * drags landed on it instead. Hence this, plus the premise check before the drag.
 */
async function closeSelect(page) {
	await page.evaluate(() =>
		document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
	);
	await page.waitForTimeout(250);
}

/** Pick an item by visible text in a portaled ThemedSelect. */
async function pickSelect(page, triggerId, textFragment) {
	await page.evaluate((id) => document.querySelector(id).click(), '#' + triggerId);
	await page.waitForTimeout(250);
	return page.evaluate((fragment) => {
		const rows = [...document.querySelectorAll('.ts-list [role="option"]')];
		const row = rows.find((r) => (r.textContent ?? '').includes(fragment));
		if (!row) return { picked: false, seen: rows.map((r) => r.textContent.trim()) };
		row.click();
		return { picked: true };
	}, textFragment);
}

/** the live stack, as {kind, enabled, params} rows */
const readStack = (page) =>
	page.evaluate(() => {
		let state = null;
		window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
		return state.effects.map((e) => ({ id: e.id, kind: e.kind, enabled: e.enabled, params: e.params }));
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	const kindCount = await registerTestEffects(page);
	h.check(kindCount >= 3, '0.1 premise: AO + two test kinds are registered (' + kindCount + ')');

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the deep link ===');

	// FORCE the condition the check is about: expand every section and scroll the
	// panel to the BOTTOM first. "the label is somewhere below the sticky header" is
	// true whenever no scrolling happened at all, so without this the assertion
	// green-lights a link that never scrolled.
	await page.evaluate(() => {
		window.__stores.inspectorKind.set('scene');
		window.__stores.inspectorClose.set(false);
		for (const label of ['File', 'Actions', 'Environment', 'Music', 'View', 'Camera', 'Grid', 'Snapping', 'Physics', 'Background', 'Fog', 'Post-processing'])
			localStorage.setItem('inspector:sec:' + label, 'open');
	});
	await h.freshReload(A);
	await page.waitForTimeout(2500);
	await registerTestEffects(page);
	await page.evaluate(() => {
		window.__stores.inspectorKind.set('scene');
		window.__stores.inspectorClose.set(false);
	});
	await page.waitForTimeout(900);

	const scrolled = await page.evaluate(() => {
		// find the panel scroller the same way Section.svelte does — by real
		// scrollability, not by class name
		const anchor = [...document.querySelectorAll('.ui-section-label')].find((el) =>
			(el.textContent ?? '').startsWith('Post-processing')
		);
		if (!anchor) return { found: false };
		let scroller = anchor.parentElement;
		while (scroller) {
			const overflow = getComputedStyle(scroller).overflowY;
			if ((overflow === 'auto' || overflow === 'scroll') && scroller.scrollHeight > scroller.clientHeight + 1) break;
			scroller = scroller.parentElement;
		}
		if (!scroller) return { found: true, scrollable: false };
		scroller.scrollTop = scroller.scrollHeight; // start at the far end
		return { found: true, scrollable: true, before: scroller.scrollTop, max: scroller.scrollHeight };
	});
	h.check(scrolled.found === true, '1.1 the Post-processing section renders in the scene inspector');
	h.check(scrolled.scrollable === true, '1.2 premise: the panel is genuinely scrollable, so a scroll can be measured');

	await page.evaluate(() => window.__stores.openSceneSection('Post-processing'));
	await page.waitForTimeout(1200);
	const landed = await page.evaluate(() => {
		const anchor = [...document.querySelectorAll('.ui-section-label')].find((el) =>
			(el.textContent ?? '').startsWith('Post-processing')
		);
		let scroller = anchor?.parentElement;
		while (scroller) {
			const overflow = getComputedStyle(scroller).overflowY;
			if ((overflow === 'auto' || overflow === 'scroll') && scroller.scrollHeight > scroller.clientHeight + 1) break;
			scroller = scroller.parentElement;
		}
		const sticky = scroller?.querySelector('#drawer-label');
		const pad = (sticky?.getBoundingClientRect().height ?? 0) + 8;
		return {
			gap: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pad,
			hasBody: !!document.querySelector('#post-counts')
		};
	});
	h.check(
		landed.gap >= -6 && landed.gap <= 40,
		'1.3 the deep link lands the section just under the sticky header (gap ' + Math.round(landed.gap) + 'px)'
	);
	h.check(landed.hasBody === true, '1.4 ...with its body expanded, not merely scrolled to');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. add / enable / remove through the UI ===');

	await page.evaluate(() => window.__stores.scenePost.scenePost.set({ enabled: true, effects: [], changedAt: 1 }));
	await page.waitForTimeout(400);
	h.check(
		await page.evaluate(() => !document.querySelector('#post-stack') && !!document.querySelector('#post-add')),
		'2.1 an empty stack shows the add row and no list'
	);

	let picked = await pickSelect(page, 'post-add-kind', 'Ambient occlusion');
	h.check(picked.picked === true, '2.2 the add menu offers the registered kinds' + (picked.seen ? ' (saw ' + JSON.stringify(picked.seen) + ')' : ''));
	await page.waitForTimeout(250);
	await page.evaluate(() => document.querySelector('#post-add').click());
	await page.waitForTimeout(500);
	let stack = await readStack(page);
	h.check(stack.length === 1 && stack[0].kind === 'ao', '2.3 Add puts the picked kind on the stack');
	h.check(
		await page.evaluate((id) => !!document.querySelector('#post-row-' + id), stack[0].id),
		'2.4 ...and the list RENDERS a row for it'
	);

	// grouped labels: the add menu must not be a flat dozen
	const grouped = await page.evaluate(() => {
		document.querySelector('#post-add-kind').click();
		return new Promise((resolve) =>
			setTimeout(() => {
				const rows = [...document.querySelectorAll('.ts-list [role="option"]')].map((r) => r.textContent.trim());
				resolve(rows);
			}, 250)
		);
	});
	await closeSelect(page);
	h.check(
		grouped.some((r) => r.startsWith('Colour grading')) && grouped.some((r) => r.startsWith('Camera FX')),
		'2.5 the add menu is grouped by family: ' + JSON.stringify(grouped)
	);

	// per-entry enable
	await page.evaluate((id) => document.querySelector('#post-toggle-' + id).click(), stack[0].id);
	await page.waitForTimeout(400);
	h.check((await readStack(page))[0].enabled === false, '2.6 the row checkbox disables that entry');
	await page.evaluate((id) => document.querySelector('#post-toggle-' + id).click(), stack[0].id);
	await page.waitForTimeout(400);
	h.check((await readStack(page))[0].enabled === true, '2.7 ...and enables it again');

	// remove
	await page.evaluate((id) => document.querySelector('#post-remove-' + id).click(), stack[0].id);
	await page.waitForTimeout(400);
	h.check((await readStack(page)).length === 0, '2.8 ✕ removes the entry');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. reorder ===');

	await page.evaluate(() => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: 1 });
		post.addPostEffect('test-tint');
		post.addPostEffect('ao');
		post.addPostEffect('test-plain');
	});
	await page.waitForTimeout(600);
	stack = await readStack(page);
	h.check(
		stack.map((e) => e.kind).join(',') === 'test-tint,ao,test-plain',
		'3.1 premise: the seeded order is tint, ao, plain'
	);

	await page.evaluate((id) => document.querySelector('#post-down-' + id).click(), stack[0].id);
	await page.waitForTimeout(500);
	h.check(
		(await readStack(page)).map((e) => e.kind).join(',') === 'ao,test-tint,test-plain',
		'3.2 ↓ moves an entry later in the stack'
	);
	await page.evaluate((id) => document.querySelector('#post-up-' + id).click(), stack[0].id);
	await page.waitForTimeout(500);
	h.check(
		(await readStack(page)).map((e) => e.kind).join(',') === 'test-tint,ao,test-plain',
		'3.3 ↑ moves it back'
	);
	h.check(
		await page.evaluate((id) => document.querySelector('#post-up-' + id).disabled, stack[0].id),
		'3.4 ↑ is disabled on the first row'
	);

	// a REAL pointer drag on the grip. Pointer events, not HTML5 drag-and-drop:
	// touch has no DnD and this panel is a bottom sheet on a phone.
	//
	// PREMISE FIRST: no portaled dropdown may be left over the panel, and the pixel
	// we are about to press must really be the grip. Without these two the drag
	// lands on a stale popup and the check reads as a broken feature (it did).
	await closeSelect(page);
	const reachable = await page.evaluate((id) => {
		const grip = document.querySelector('#post-grip-' + id);
		grip.scrollIntoView({ block: 'center' });
		const box = grip.getBoundingClientRect();
		const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
		return { isGrip: at === grip, atId: at?.id ?? at?.tagName, popup: !!document.querySelector('.ts-list') };
	}, stack[0].id);
	h.check(
		reachable.isGrip && !reachable.popup,
		'3.4b premise: the grip pixel really is the grip and nothing covers it (' + reachable.atId + ')'
	);
	const gripBox = await page.evaluate((id) => {
		const el = document.querySelector('#post-grip-' + id);
		el.scrollIntoView({ block: 'center' });
		const box = el.getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}, stack[0].id);
	const lastRowBox = await page.evaluate((id) => {
		const box = document.querySelector('#post-row-' + id).getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height - 2 };
	}, stack[2].id);
	await page.mouse.move(gripBox.x, gripBox.y);
	await page.mouse.down();
	for (let step = 1; step <= 6; step++)
		await page.mouse.move(
			gripBox.x + ((lastRowBox.x - gripBox.x) * step) / 6,
			gripBox.y + ((lastRowBox.y - gripBox.y) * step) / 6
		);
	await page.waitForTimeout(150);
	await page.mouse.up();
	await page.waitForTimeout(600);
	const dragged = await readStack(page);
	h.check(
		dragged.map((e) => e.kind).join(',') === 'ao,test-plain,test-tint',
		'3.5 a real POINTER drag on the grip reorders the stack: ' + dragged.map((e) => e.kind).join(',')
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. parameters ===');

	await page.evaluate(() => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: 1 });
		post.addPostEffect('test-tint');
	});
	await page.waitForTimeout(500);
	stack = await readStack(page);
	const tintId = stack[0].id;
	h.check(
		await page.evaluate((id) => !document.querySelector('#post-params-' + id), tintId),
		'4.1 parameters are collapsed until the row is opened'
	);
	await page.evaluate((id) => document.querySelector('#post-open-' + id).click(), tintId);
	await page.waitForTimeout(500);
	const rendered = await page.evaluate((id) => {
		const pane = document.querySelector('#post-params-' + id);
		return {
			open: !!pane,
			number: !!document.querySelector('#post-param-' + id + '-amount'),
			select: !!document.querySelector('#post-param-' + id + '-mode'),
			bool: !!document.querySelector('#post-param-' + id + '-invert'),
			isDragRow: !!document.querySelector('#post-param-' + id + '-amount')?.closest('.dn-wrap')
		};
	}, tintId);
	h.check(rendered.open, '4.2 clicking the row name opens its parameter pane');
	h.check(rendered.number && rendered.isDragRow, '4.3 a number param renders as a DragRow (.dn-wrap)');
	h.check(rendered.select, '4.4 a select param renders a themed select');
	h.check(rendered.bool, '4.5 a bool param renders a checkbox');

	// the select writes through
	const beforeMode = (await readStack(page))[0].params.mode;
	picked = await pickSelect(page, 'post-param-' + tintId + '-mode', 'Cool');
	await page.waitForTimeout(500);
	h.check(
		picked.picked && (await readStack(page))[0].params.mode === 'cool' && beforeMode === 'warm',
		'4.6 a select param writes to the stack (warm -> cool)'
	);
	await page.evaluate((id) => document.querySelector('#post-param-' + id + '-invert').click(), tintId);
	await page.waitForTimeout(400);
	h.check((await readStack(page))[0].params.invert === true, '4.7 a bool param writes to the stack');

	// A REAL SCRUB on the DragRow: this is what proves the onscrubstart/onscrubend
	// wiring, i.e. that a slider drag collapses into ONE message and ONE undo step.
	// The select opened by 4.6 has to go first, for the same reason as 3.4b.
	await closeSelect(page);
	const scrub = await page.evaluate((id) => {
		const el = document.querySelector('#post-param-' + id + '-amount');
		el.scrollIntoView({ block: 'center' });
		const box = el.getBoundingClientRect();
		// stub the wire so the message count is observable without a second peer
		const peers = window.__stores.peers;
		let original = null;
		peers.subscribe((p) => (original = p))();
		window.__postSent = [];
		window.__postRestore = () => peers.set(original);
		peers.set({ ...original, send: (m) => window.__postSent.push(m) });
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}, tintId);
	const beforeAmount = (await readStack(page))[0].params.amount;
	await page.mouse.move(scrub.x, scrub.y);
	await page.mouse.down();
	for (let step = 1; step <= 10; step++) await page.mouse.move(scrub.x + step * 3, scrub.y);
	await page.mouse.up();
	await page.waitForTimeout(600);
	const scrubResult = await page.evaluate(() => {
		const sent = window.__postSent.filter((m) => m.type === 'scenepost').length;
		window.__postRestore();
		let state = null;
		window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
		return { sent, amount: state.effects[0].params.amount };
	});
	h.check(
		scrubResult.amount !== beforeAmount,
		'4.8 premise: the real drag moved the value (' + beforeAmount + ' -> ' + scrubResult.amount + ')'
	);
	h.check(
		scrubResult.sent === 1,
		'4.9 a UI scrub puts exactly ONE message on the wire (the gesture seam is wired): ' + scrubResult.sent
	);
	const undone = await page.evaluate(() => {
		window.__stores.history.undo();
		let state = null;
		window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
		return state.effects[0]?.params?.amount;
	});
	h.check(
		Math.abs(undone - beforeAmount) < 1e-6,
		'4.10 ...and ONE undo reverts the whole drag (' + undone + ')'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. the cost line ===');

	const counts = await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		const read = () => document.querySelector('#post-counts')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
		post.scenePost.set({ enabled: true, effects: [], changedAt: 1 });
		await new Promise((r) => setTimeout(r, 300));
		const empty = read();
		// three Effects in a row: three entries, ONE pass
		post.addPostEffect('test-tint');
		post.addPostEffect('test-plain');
		post.addPostEffect('test-plain');
		await new Promise((r) => setTimeout(r, 400));
		const merged = read();
		// now break the run with a Pass in the middle
		post.addPostEffect('ao', 1);
		await new Promise((r) => setTimeout(r, 400));
		const split = read();
		// and disable one
		let state = null;
		post.scenePost.subscribe((s) => (state = s))();
		post.setPostEffectEnabled(state.effects[0].id, false);
		await new Promise((r) => setTimeout(r, 400));
		return { empty, merged, split, disabled: read() };
	});
	h.check(/Effects: 0/.test(counts.empty), '5.1 an empty stack reads "Effects: 0" (' + counts.empty + ')');
	h.check(
		/Effects: 3/.test(counts.merged) && /passes: 1/.test(counts.merged) && /merged/.test(counts.merged),
		'5.2 three Effects report ONE pass and say so: ' + counts.merged
	);
	h.check(
		/Effects: 4/.test(counts.split) && /passes: 3/.test(counts.split),
		'5.3 a Pass in the middle splits the run, and the line follows: ' + counts.split
	);
	h.check(
		/Effects: 3 of 4/.test(counts.disabled),
		'5.4 a disabled entry shows as "N of M": ' + counts.disabled
	);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. an effect this build cannot render ===');

	const unknown = await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		post.scenePost.set({
			enabled: true,
			effects: [{ id: 'u1', kind: 'from-the-future', params: { mystery: 1 } }],
			changedAt: 2
		});
		await new Promise((r) => setTimeout(r, 400));
		const row = document.querySelector('#post-row-u1');
		document.querySelector('#post-open-u1')?.click();
		await new Promise((r) => setTimeout(r, 300));
		const pane = document.querySelector('#post-params-u1');
		return {
			rendered: !!row,
			label: row?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
			paneText: pane?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
		};
	});
	h.check(unknown.rendered, '6.1 an unknown kind still gets a row (it is kept and shared)');
	h.check(/unsupported/i.test(unknown.label), '6.2 ...marked unsupported: ' + unknown.label);
	h.check(
		/newer|build|as-is/i.test(unknown.paneText),
		'6.3 ...and its pane explains rather than showing empty knobs: ' + unknown.paneText
	);

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. the bottom sheet at <=640px ===');

	await page.setViewportSize({ width: 420, height: 780 });
	await page.waitForTimeout(900);
	const sheet = await page.evaluate(() => {
		const counts = document.querySelector('#post-counts');
		if (!counts) return { present: false };
		const drawer = counts.closest('.app-drawer, .inspector, [class*="drawer"]');
		const box = (drawer ?? counts).getBoundingClientRect();
		return {
			present: true,
			// a sheet spans the width and sits at the bottom of the viewport
			wide: box.width > window.innerWidth * 0.9,
			low: box.bottom > window.innerHeight * 0.8,
			// and the section content must be inside the viewport, not off the side
			inView: box.left >= -1 && box.right <= window.innerWidth + 1
		};
	});
	h.check(sheet.present === true, '7.1 the section still renders at 420px wide');
	h.check(sheet.wide === true && sheet.low === true, '7.2 it inherits the Inspector bottom SHEET (full width, bottom-anchored)');
	h.check(sheet.inView === true, '7.3 nothing spills off the side');
	await page.setViewportSize({ width: 1280, height: 720 });

	h.check(
		h.pageErrors(A).length === 0,
		'7.4 the panel never threw: ' + JSON.stringify(h.pageErrors(A).slice(0, 2))
	);

	await h.finish(browser);
});
