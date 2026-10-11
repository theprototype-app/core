// 41 G1 — "Edit positions" for the bottom toolbar (the user's 1.32 review): right-click / long
// press → Edit positions; drag to reorder (pointer events, so a finger drags like a mouse); a
// small red "−" on every placeholder but Play; an emptied place shows a small green "+" that
// offers every "Customize toolbar…" button not placed yet (never Play); up to THREE round
// buttons stacked in each bottom corner; a round green ✓ at the bar's top right applies, Escape
// or a press outside cancels; the arrow keys move the focused item. Shares G23's model
// ($lib/toolbarLayout), so it is persisted like Customize and Customize shows the result.
//
// Desktop drives a REAL mouse; the phone sections drive REAL touch (CDP Input.dispatchTouchEvent)
// on the OPPO Find N6 unfolded (≈770×850, DPR 2.9) and folded (≈390×896) and across the fold.
// Counterfactual on feat/40-int: no "Edit positions" row exists and nothing below can run.
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOT_DIR || null;
const shot = async (page, name, clip) => {
	if (!SHOTS) return;
	await page.screenshot({ path: `${SHOTS}/${name}.png`, ...(clip ? { clip } : {}) }).catch(() => {});
};
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('controlsLayout') ?? 'null'));
/** the edit draft as drawn: bar ids left → right, each corner bottom → top */
const draft = (page) =>
	page.evaluate(() => {
		const ids = (sel) => [...document.querySelectorAll(sel)].map((el) => el.dataset.editWrap ?? (el.dataset.editHole ? 'HOLE' : null)).filter(Boolean);
		return {
			bar: ids('#controls-pill .hud-bar-row [data-edit-slot]'),
			left: ids('#hud-stack-left [data-edit-wrap]'),
			right: ids('#hud-stack-right [data-edit-wrap]'),
			editing: !!document.querySelector('#controls-pill.hud-editing')
		};
	});
const corners = (page) =>
	page.evaluate(() => ({
		left: [...document.querySelectorAll('#hud-stack-left > *')].map((el) => el.id),
		right: [...document.querySelectorAll('#hud-stack-right > *')].map((el) => el.id)
	}));
const centre = async (loc) => {
	const b = await loc.boundingBox();
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** click by coordinates: the jiggling placeholders never read as "stable" to locator.click */
async function clickAt(page, loc) {
	const p = await centre(loc);
	await page.mouse.click(p.x, p.y);
	await page.waitForTimeout(250);
}
async function mouseDrag(page, from, to) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
	await page.waitForTimeout(120);
	await page.mouse.up();
	await page.waitForTimeout(250);
}
async function enterEdit(page, title) {
	await page.locator(`#controls-pill > div > [title="${title}"]`).click({ button: 'right' });
	await page.waitForTimeout(300);
	await page.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
	await page.waitForTimeout(400);
}

h.run(async () => {
	const browser = await h.launch();
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'desk-' + theme, { context: { viewport: { width: 1440, height: 900 } }, storage: { theme } });
		const P = A.page;
		const T = `[${theme}] `;

		// ---- premise: the corner stacks hold the four round buttons where they always were ----
		const c0 = await corners(P);
		h.check(c0.left.join() === 'ai-hud-button,mobile-add-button' && c0.right.join() === 'chat-button,mic-button', T + `premise: AI under "+" left, chat under mic right (${JSON.stringify(c0)})`);
		const ai = await P.locator('#ai-hud-button').boundingBox();
		const add = await P.locator('#mobile-add-button').boundingBox();
		h.check(Math.abs(ai.x - 16) < 2 && add.y < ai.y && Math.round(P.viewportSize().height - (ai.y + ai.height)) === 16, T + `premise: the left stack sits in the corner, bottom 16 (${JSON.stringify({ ai, add })})`);

		// ---- enter: a right-click on a cell offers "Edit positions" first in the Toolbar section ----
		await P.locator('#controls-pill > div > [title="Explorer"]').click({ button: 'right' });
		await P.waitForTimeout(300);
		const rows = await P.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
		h.check(rows.indexOf('Edit positions') >= 0 && rows.indexOf('Edit positions') < rows.indexOf('Move left'), T + `the cell menu leads its Toolbar rows with Edit positions (${rows.join(' | ')})`);
		await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
		await P.waitForTimeout(400);
		let d = await draft(P);
		h.check(d.editing && d.bar.length === 10 && d.left.join() === 'ai,add' && d.right.join() === 'chat,mic', T + `edit mode draws the whole layout as placeholders (${JSON.stringify(d)})`);
		const removers = await P.evaluate(() => [...document.querySelectorAll('.hud-edit-remove')].map((b) => b.closest('[data-edit-wrap]')?.dataset.editWrap));
		h.check(removers.length === 13 && !removers.includes('__spacer'), T + `a red "−" on every placeholder but Play (${removers.length})`);
		const plusLeft = await P.locator('#hud-stack-left .hud-edit-add').count();
		const plusRight = await P.locator('#hud-stack-right .hud-edit-add').count();
		h.check(plusLeft === 1 && plusRight === 1, T + `each corner shows its one empty place as a green "+" (${plusLeft}, ${plusRight})`);
		const pill = await P.locator('#controls-pill').boundingBox();
		const tick = await P.locator('#toolbar-edit-apply').boundingBox();
		h.check(tick && Math.abs(tick.x + tick.width / 2 - (pill.x + pill.width)) < 16 && Math.abs(tick.y + tick.height / 2 - pill.y) < 16, T + `the round ✓ sits on the bar's top-right corner (${JSON.stringify({ pill, tick })})`);
		const look = await P.evaluate(() => {
			const cs = (sel) => getComputedStyle(document.querySelector(sel));
			return { remove: cs('.hud-edit-remove').backgroundColor, apply: cs('#toolbar-edit-apply').backgroundColor, add: cs('#hud-stack-left .hud-edit-add').color, round: cs('#toolbar-edit-apply').borderRadius, anim: cs('#controls-pill [data-edit-wrap="move"]').animationName };
		});
		const red = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return r > g * 1.6 && r > b * 1.6; };
		const green = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return g > r * 1.3 && g > b; };
		h.check(red(look.remove) && green(look.apply) && green(look.add) && look.round === '50%' && look.anim === 'hud-jiggle', T + `red −, green ✓ and +, the ✓ is round, placeholders jiggle (${JSON.stringify(look)})`);
		await shot(P, `g1-${theme}-desktop-edit`, { x: 0, y: 700, width: 1440, height: 200 });

		// ---- drag (real mouse): Animation from the bar into the left corner's empty place ----------
		await mouseDrag(P, await centre(P.locator('#controls-pill [data-edit-id="animation"]')), await centre(P.locator('#hud-stack-left .hud-edit-add')));
		d = await draft(P);
		h.check(d.left.join() === 'ai,add,animation' && !d.bar.includes('animation'), T + `a dragged bar button lands on top of the left stack (${JSON.stringify(d)})`);
		h.check((await P.locator('#hud-stack-left .hud-edit-add').count()) === 0, T + 'the left corner is now full — three is the limit, no "+" left');
		// a full corner refuses a fourth: drag Move onto it, nothing changes there
		await mouseDrag(P, await centre(P.locator('#controls-pill [data-edit-id="move"]')), await centre(P.locator('#hud-stack-left [data-edit-id="add"]')));
		d = await draft(P);
		h.check(d.left.join() === 'ai,add,animation' && d.bar.includes('move'), T + `a full corner takes nothing new (${JSON.stringify(d.left)})`);
		// reorder inside the bar: Play to the far left
		await mouseDrag(P, await centre(P.locator('#controls-pill [data-edit-id="__spacer"]')), { x: (await P.locator('#toolbar-edit-add-start').boundingBox()).x + 30, y: (await centre(P.locator('#toolbar-edit-add-start'))).y });
		d = await draft(P);
		h.check(d.bar[0] === '__spacer', T + `Play drags along the bar (${d.bar.join(',')})`);

		// ---- the red "−" and the green "+" ---------------------------------------------------------
		await clickAt(P, P.locator('#hud-stack-right [data-edit-wrap="chat"] .hud-edit-remove'));
		await P.waitForTimeout(200);
		d = await draft(P);
		h.check(d.right.join() === 'mic' && (await P.locator('#hud-stack-right .hud-edit-add').count()) === 2, T + `− takes Chat off; the right corner shows two "+" (${d.right})`);
		await clickAt(P, P.locator('#controls-pill [data-edit-wrap="rotate"] .hud-edit-remove'));
		await P.waitForTimeout(200);
		d = await draft(P);
		const holeAt = d.bar.indexOf('HOLE');
		h.check(holeAt >= 0 && !d.bar.includes('rotate'), T + `− on a bar button leaves a "+" where it was (${d.bar.join(',')})`);
		await clickAt(P, P.locator('#hud-stack-right .hud-edit-add').first());
		await P.waitForTimeout(300);
		const offered = await P.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
		h.check(offered.some((l) => l.startsWith('Chat')) && offered.includes('Rotate (2)') && !offered.some((l) => /^play/i.test(l)), T + `"+" offers every unplaced Customize button, never Play (${offered.join(' | ')})`);
		await P.getByRole('menuitem', { name: 'UV editor', exact: true }).click();
		await P.waitForTimeout(300);
		d = await draft(P);
		h.check(d.right.join() === 'mic,uv', T + `the pick lands in that corner (${d.right})`);
		await clickAt(P, P.locator('#controls-pill [data-edit-hole]').first());
		await P.waitForTimeout(300);
		await P.getByRole('menuitem', { name: /^Chat/ }).click();
		await P.waitForTimeout(300);
		d = await draft(P);
		h.check(d.bar[holeAt] === 'chat', T + `a bar "+" fills exactly the place the − emptied (${d.bar.join(',')})`);

		// ---- keyboard: arrows move the focused item, Delete removes ----------------------------------
		await P.locator('#controls-pill [data-edit-id="flow"]').focus();
		const flowAt = (await draft(P)).bar.indexOf('flow');
		await P.keyboard.press('ArrowLeft');
		await P.waitForTimeout(150);
		d = await draft(P);
		h.check(d.bar.indexOf('flow') === flowAt - 1 && (await P.evaluate(() => document.activeElement?.dataset?.editId)) === 'flow', T + `← moves the focused item one place and keeps focus (${flowAt} → ${d.bar.indexOf('flow')})`);
		await P.locator('#hud-stack-right [data-edit-id="uv"]').focus();
		await P.keyboard.press('ArrowDown');
		await P.waitForTimeout(150);
		h.check((await draft(P)).right.join() === 'uv,mic', T + '↓ moves a corner item down its stack');
		await P.keyboard.press('Delete');
		await P.waitForTimeout(150);
		h.check((await draft(P)).right.join() === 'mic', T + 'Delete removes the focused item');

		// ---- ✓ applies, persists, survives a reload, and Customize shows it -------------------------
		await P.locator('#toolbar-edit-apply').click();
		await P.waitForTimeout(400);
		h.check(!(await draft(P)).editing, T + '✓ leaves edit mode');
		const rec = await stored(P);
		h.check(rec?.left?.join() === 'ai,add,animation' && rec?.right?.join() === 'mic', T + `the record holds the corners (${JSON.stringify(rec && { left: rec.left, right: rec.right })})`);
		await shot(P, `g1-${theme}-desktop-applied`, { x: 0, y: 700, width: 1440, height: 200 });
		const barNow = await P.evaluate(() => [...document.querySelector('#controls-pill .hud-bar-row').children].map((el) => el.querySelector('#play-button') ? '__spacer' : el.id || el.getAttribute('title')));
		await P.reload({ waitUntil: 'domcontentloaded' });
		await P.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
		await P.waitForTimeout(1500);
		const barAfter = await P.evaluate(() => [...document.querySelector('#controls-pill .hud-bar-row').children].map((el) => el.querySelector('#play-button') ? '__spacer' : el.id || el.getAttribute('title')));
		h.check(barAfter.join() === barNow.join() && barAfter[0] === '__spacer', T + `the applied bar survives a reload (${barAfter.join(',')})`);
		const cAfter = await corners(P);
		h.check(cAfter.left.length === 3 && cAfter.right.join() === 'mic-button', T + `…and so do the corners (${JSON.stringify(cAfter)})`);
		h.check(!(await P.locator('#chat-button').evaluate((el) => !!el.closest('.hud-stack'))), T + 'Chat now lives on the bar');
		await P.locator('#toolbar-customize').click();
		await P.waitForTimeout(400);
		const cust = await P.evaluate(() => [...document.querySelectorAll('[role="menu"] *')].map((el) => el.textContent.trim()).filter(Boolean));
		h.check(cust.includes('Left corner') && cust.includes('Right corner') && cust.includes('Edit positions…'), T + 'Customize lists the corners and offers Edit positions…');
		await P.keyboard.press('Escape');
		await P.waitForTimeout(300);

		// ---- cancel: Escape and a press outside both throw the draft away -----------------------------
		const recBefore = JSON.stringify(await stored(P));
		await enterEdit(P, 'Move (1)');
		await clickAt(P, P.locator('#controls-pill [data-edit-wrap="move"] .hud-edit-remove'));
		await P.keyboard.press('Escape');
		await P.waitForTimeout(300);
		h.check(!(await draft(P)).editing && JSON.stringify(await stored(P)) === recBefore && (await P.locator('#controls-pill [title="Move (1)"]').count()) === 1, T + 'Escape cancels: Move is still there, the record untouched');
		await enterEdit(P, 'Move (1)');
		await clickAt(P, P.locator('#controls-pill [data-edit-wrap="move"] .hud-edit-remove'));
		await P.mouse.click(720, 300);
		await P.waitForTimeout(300);
		h.check(!(await draft(P)).editing && JSON.stringify(await stored(P)) === recBefore, T + 'a press outside cancels too');
		// a cell press in edit mode does not run the button
		await enterEdit(P, 'Move (1)');
		await clickAt(P, P.locator('#controls-pill [data-edit-id="explorer"]'));
		await P.waitForTimeout(300);
		h.check((await draft(P)).editing, T + 'clicking a placeholder does not leave edit mode or run it');
		await P.keyboard.press('Escape');
		h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
		await A.ctx.close();
	}

	// ---- phone, UNFOLDED (OPPO Find N6 ≈ 770×850, DPR 2.9): real touch ------------------------------
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'unfolded-' + theme, {
			context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const P = A.page;
		const T = `[unfolded ${theme}] `;
		const cdp = await P.context().newCDPSession(P);
		const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
		const hold = async (p, ms = 750) => {
			await touch('touchStart', p.x, p.y);
			await P.waitForTimeout(ms);
			await touch('touchEnd');
			await P.waitForTimeout(300);
		};
		const touchDrag = async (a, b) => {
			await touch('touchStart', a.x, a.y);
			for (let i = 1; i <= 14; i++) {
				await touch('touchMove', a.x + ((b.x - a.x) * i) / 14, a.y + ((b.y - a.y) * i) / 14);
				await P.waitForTimeout(16);
			}
			await P.waitForTimeout(120);
			await touch('touchEnd');
			await P.waitForTimeout(300);
		};
		h.check((await P.locator('#controls-pill').isVisible()) && !(await P.evaluate(() => document.documentElement.classList.contains('phone-shell'))), T + 'premise: unfolded, the desktop bar is drawn (no phone shell)');
		// a LONG PRESS (held finger, no browser contextmenu needed) opens the menu with Edit positions
		await hold(await centre(P.locator('#controls-pill > div > [title="Explorer"]')));
		const opened = await P.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
		h.check(opened.includes('Edit positions'), T + `a long press opens the toolbar menu (${opened.slice(0, 6).join(' | ')})`);
		await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).tap();
		await P.waitForTimeout(400);
		let d = await draft(P);
		h.check(d.editing, T + 'tapping it enters edit mode');
		await shot(P, `g1-unfolded-${theme}-edit`);
		// drag with a FINGER: Explorer from the bar into the right corner's empty place
		await touchDrag(await centre(P.locator('#controls-pill [data-edit-id="explorer"]')), await centre(P.locator('#hud-stack-right .hud-edit-add')));
		d = await draft(P);
		h.check(d.right.join() === 'chat,mic,explorer' && !d.bar.includes('explorer'), T + `a finger drags a button into a corner (${JSON.stringify(d)})`);
		const rm = P.locator('#hud-stack-left [data-edit-wrap="ai"] .hud-edit-remove');
		const rb = await rm.boundingBox();
		await touch('touchStart', rb.x + rb.width / 2, rb.y + rb.height / 2);
		await touch('touchEnd');
		await P.waitForTimeout(300);
		h.check((await draft(P)).left.join() === 'add', T + 'a tap on the small red − removes (AI assistant)');
		await P.locator('#toolbar-edit-apply').tap();
		await P.waitForTimeout(400);
		const c = await corners(P);
		h.check(c.left.join() === 'mobile-add-button' && c.right.join() === 'chat-button,mic-button,explorer-slot', T + `✓ applies by touch (${JSON.stringify(c)})`);
		await shot(P, `g1-unfolded-${theme}-applied`);

		// ---- the FOLD: unfolded → folded (the phone shell takes over), mid-edit and after -------------
		await hold(await centre(P.locator('#controls-pill > div > [title="Move (1)"]')));
		await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).tap();
		await P.waitForTimeout(300);
		h.check((await draft(P)).editing, T + 'premise: editing before the fold');
		await P.setViewportSize({ width: 390, height: 896 });
		await P.waitForTimeout(900);
		const folded = await P.evaluate(() => ({
			shell: document.documentElement.classList.contains('phone-shell'),
			editing: !!document.querySelector('.hud-editing'),
			pill: getComputedStyle(document.getElementById('controls-pill')).display,
			stack: [...document.querySelectorAll('.hud-stack > *')].filter((el) => el.getClientRects().length > 0).length,
			bar: !!document.getElementById('ps-bar')
		}));
		h.check(folded.shell && !folded.editing && folded.pill === 'none' && folded.stack === 0 && folded.bar, T + `folding mid-edit cancels the draft; the phone shell's own bar takes over and no corner button leaks onto it (${JSON.stringify(folded)})`);
		await shot(P, `g1-folded-${theme}`);
		await P.setViewportSize({ width: 770, height: 850 });
		await P.waitForTimeout(900);
		const back = await corners(P);
		h.check(back.right.join() === 'chat-button,mic-button,explorer-slot' && back.left.join() === 'mobile-add-button', T + `unfolding brings back the APPLIED layout, not the cancelled draft (${JSON.stringify(back)})`);
		h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
		await A.ctx.close();
	}
	await h.finish(browser);
});
