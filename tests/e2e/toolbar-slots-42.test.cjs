// 42 I7 / I8 / I9 / I10 — the user's preview-1-32c review of the toolbar (Controls.svelte):
//   I7  menu labels: "Pivot" (not "Pivot: Median point (click to change)"), "Microphone" (no helper
//       text) in Customize toolbar… and Edit positions — the bar's own tooltips keep their state
//   I8  workspace layouts save + restore the toolbar (items, position), the corner stacks, the
//       top-right group and the touch tools — desktop and phone kept apart in ONE layout record
//   I9  Edit positions: ONE "+" per stack for the next place, up to FOUR per corner; the top-right
//       notes / notifications / peers icons are editable slots; the unfolded-touch undo / redo /
//       multi-select join the same edit model; burger + profile stay static
//   I10 "Lift corner buttons above docked panels" (default OFF) beside "Always on top" in the
//       toolbar / corner context menus, with the bar's own lift option beside it
// Desktop 1440×900 with a REAL mouse; the OPPO Find N6 UNFOLDED (770×850, DPR 2.9) with REAL touch
// (CDP) and FOLDED (390×896) for the phone profile. Dark + light for the visual sections.
// Counterfactual: on origin/feat/41-int (1.32.0) the long labels show, no top-right / touch
// placeholders exist, the corners stop at three, no lift row exists and a layout carries no toolbar.
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOT_DIR || null;
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
};
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('controlsLayout') ?? 'null'));
/** the edit draft as drawn, every region */
const draft = (page) =>
	page.evaluate(() => {
		const ids = (sel) => [...document.querySelectorAll(sel)].map((el) => el.dataset.editWrap ?? (el.dataset.editHole ? 'HOLE' : null)).filter(Boolean);
		return {
			bar: ids('#controls-pill .hud-bar-row [data-edit-slot]'),
			left: ids('#hud-stack-left [data-edit-wrap]'),
			right: ids('#hud-stack-right [data-edit-wrap]'),
			top: ids('#hud-tr [data-edit-wrap]'),
			touch: ids('#touch-tools [data-edit-wrap]'),
			adds: {
				left: document.querySelectorAll('#hud-stack-left .hud-edit-add').length,
				right: document.querySelectorAll('#hud-stack-right .hud-edit-add').length,
				top: document.querySelectorAll('#hud-tr .hud-edit-add').length,
				touch: document.querySelectorAll('#touch-tools .hud-edit-add').length
			},
			editing: !!document.querySelector('#controls-pill.hud-editing')
		};
	});
/** the top-right group as drawn (outside edit mode): each visible button's id/title, in CSS order */
const topRight = (page) =>
	page.evaluate(() => {
		const group = document.getElementById('hud-tr');
		const items = [...group.querySelectorAll(':scope > *, :scope > [data-toolbar-portal] > *')].filter((el) => getComputedStyle(el).display !== 'contents' && el.getClientRects().length);
		return items
			.map((el) => ({ id: el.id || el.querySelector('button[id]')?.id || el.getAttribute('title') || el.className, x: el.getBoundingClientRect().left }))
			.sort((a, b) => a.x - b.x)
			.map((e) => e.id);
	});
const stackIds = (page, side) => page.evaluate((s) => [...document.querySelectorAll(`#hud-stack-${s} > *`)].map((el) => el.id || el.getAttribute('title')), side);
const centre = async (loc) => {
	const b = await loc.boundingBox();
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** by coordinates: a jiggling placeholder never reads as "stable" to locator.click */
async function clickAt(page, loc) {
	const p = await centre(loc);
	await page.mouse.click(p.x, p.y);
	await page.waitForTimeout(250);
}
async function mouseDrag(page, from, to) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= 14; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 14, from.y + ((to.y - from.y) * i) / 14);
	await page.waitForTimeout(150);
	await page.mouse.up();
	await page.waitForTimeout(300);
}
const menuRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({ label: el.textContent.trim(), checked: el.className.includes('ctx-checked') }))
	);
async function cellMenu(page, title) {
	await page.locator(`#controls-pill > div > [title="${title}"]`).click({ button: 'right' });
	await page.waitForTimeout(350);
}
async function enterEdit(page, title = 'Explorer') {
	await cellMenu(page, title);
	await page.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
	await page.waitForTimeout(450);
}
async function closeMenus(page) {
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
}
/** a docked panel at the bottom, and its height (the inset a lift adds) */
async function openDock(page) {
	await page.evaluate(() => {
		window.__tp.test.v1.explorerClose.set(false);
	});
	await page.waitForTimeout(900);
	return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset')) || 0);
}
const bottomGap = (page, sel) =>
	page.evaluate((s) => {
		const r = document.querySelector(s).getBoundingClientRect();
		return Math.round(window.innerHeight - r.bottom);
	}, sel);
/** is the element really what a press at its centre lands on (not covered)? */
const onTop = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return !!hit && (hit === el || el.contains(hit));
	}, sel);

// ONLY=i7,i10,i9,i8 runs those sections alone — what makes each row's COUNTERFACTUAL its own red on
// a base that lacks the others (a missing control throws and ends the script)
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (/** @type {string} */ key) => !ONLY.length || ONLY.includes(key);

h.run(async () => {
	const browser = await h.launch();

	// ═══ DESKTOP 1440×900, real mouse — dark and light ═══════════════════════════════════════════════
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'desk-' + theme, { context: { viewport: { width: 1440, height: 900 } }, storage: { theme, toastsInDrawerOnly: 'true' } });
		const P = A.page;
		const T = `[${theme}] `;

		if (want('i7')) {
			// ---- I7: the menus print the SHORT names; the bar's tooltips keep their state ----------------
			h.check((await P.locator('#controls-pill > div > [title^="Pivot: "]').count()) === 1, T + 'premise: the bar\'s Pivot cell keeps its stateful tooltip');
			await P.locator('#toolbar-customize').click();
			await P.waitForTimeout(400);
			const custom = (await menuRows(P)).map((r) => r.label);
			h.check(custom.includes('Pivot') && !custom.some((l) => l.startsWith('Pivot:')), T + `I7: Customize toolbar… says "Pivot" (${custom.filter((l) => /pivot/i.test(l)).join(' | ')})`);
			h.check(custom.includes('Microphone') && !custom.some((l) => /click to talk|click to mute/.test(l)), T + `I7: …and "Microphone", no helper text (${custom.filter((l) => /micro/i.test(l)).join(' | ')})`);
			await shot(P, `i7-customize-${theme}`);
			await closeMenus(P);
			await enterEdit(P);
			const grips = await P.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-edit-id]')].map((el) => [el.dataset.editId, el.getAttribute('title')])));
			h.check(grips.pivot === 'Pivot' && grips.mic === 'Microphone', T + `I7: Edit positions placeholders read "Pivot" / "Microphone" (${grips.pivot} / ${grips.mic})`);
			await clickAt(P, P.locator('#controls-pill [data-edit-wrap="pivot"] .hud-edit-remove'));
			await clickAt(P, P.locator('#controls-pill [data-edit-hole]').first());
			const addList = (await menuRows(P)).map((r) => r.label);
			h.check(addList.includes('Pivot') && !addList.some((l) => l.startsWith('Pivot:')), T + `I7: the "+" popup offers "Pivot" (${addList.join(' | ')})`);
			await closeMenus(P);
			await P.keyboard.press('Escape');
			await P.waitForTimeout(300);
		}

		if (want('i10')) {
			// ---- I10: the two lift rows beside Always on top; the corner lift is OFF by default ----------
			await cellMenu(P, 'Move (1)');
			let rows = await menuRows(P);
			const labels = rows.map((r) => r.label);
			const onTopAt = labels.indexOf('Always on top');
			const barLift = rows.find((r) => r.label === 'Lift toolbar above docked panels');
			const cornerLift = rows.find((r) => r.label === 'Lift corner buttons above docked panels');
			h.check(onTopAt >= 0 && labels[onTopAt + 1] === 'Lift toolbar above docked panels' && labels[onTopAt + 2] === 'Lift corner buttons above docked panels', T + `I10: the two lift rows sit right after "Always on top" (${labels.slice(onTopAt, onTopAt + 3).join(' | ')})`);
			h.check(barLift?.checked === true && cornerLift?.checked === false, T + `I10: the bar lifts by default (unchanged), the corner buttons do NOT (${barLift?.checked}/${cornerLift?.checked})`);
			await closeMenus(P);
			// a corner button's OWN menu carries the rows too (right-click the chat button)
			await P.locator('#chat-button').click({ button: 'right' });
			await P.waitForTimeout(350);
			const viaCorner = (await menuRows(P)).map((r) => r.label);
			h.check(viaCorner.includes('Lift corner buttons above docked panels') && viaCorner.includes('Always on top'), T + `I10: a corner button's own menu carries the row (${viaCorner.length} rows)`);
			await closeMenus(P);
			const inset = await openDock(P);
			h.check(inset > 100, T + `premise: a docked Explorer opens a bottom dock (${inset}px)`);
			const downGap = await bottomGap(P, '#hud-stack-right');
			h.check(downGap === 16 && !(await onTop(P, '#chat-button')), T + `I10 default: the corner stack stays on the floor and the dock covers it (gap ${downGap})`);
			// the dock covers the corner, so take the row from the bar's menu (same rows, same store)
			await cellMenu(P, 'Move (1)');
			await P.getByRole('menuitem', { name: 'Lift corner buttons above docked panels', exact: true }).click();
			await P.waitForTimeout(500);
			const upGap = await bottomGap(P, '#hud-stack-right');
			const upLeft = await bottomGap(P, '#hud-stack-left');
			h.check(Math.abs(upGap - (inset + 16)) <= 2 && Math.abs(upLeft - (inset + 16)) <= 2, T + `I10 on: both stacks ride above the dock (gap ${upGap}/${upLeft}, inset ${inset})`);
			h.check(await onTop(P, '#chat-button'), T + 'I10 on: the chat button is reachable over the dock');
			h.check((await P.evaluate(() => localStorage.getItem('hudStackLift'))) === 'true', T + 'I10: the choice is persisted (hudStackLift)');
			await shot(P, `i10-lifted-${theme}`);
			await cellMenu(P, 'Move (1)');
			h.check((await menuRows(P)).find((r) => r.label === 'Lift corner buttons above docked panels')?.checked === true, T + 'I10: the row now reads checked');
			await closeMenus(P);
			await P.evaluate(() => window.__tp.test.v1.settingsOpen.set(true));
			await P.waitForTimeout(600);
			// ui/Toggle is a <button aria-pressed>, not a checkbox
			const row = await P.evaluate(() => ({ row: !!document.getElementById('row-corner-lift'), on: document.getElementById('corner-lift')?.getAttribute('aria-pressed') === 'true' }));
			h.check(row.row && row.on === true, T + `I10: Settings ▸ Interface carries the same switch, in step (${JSON.stringify(row)})`);
			await P.evaluate(() => {
				window.__tp.test.v1.settingsOpen.set(false);
				window.__tp.test.v1.hudStackLift.set(false);
			});
			await P.waitForTimeout(400);
			h.check((await bottomGap(P, '#hud-stack-right')) === 16, T + 'I10 off again: back on the floor');
			await P.evaluate(() => window.__tp.test.v1.explorerClose.set(true));
			await P.waitForTimeout(500);
		}

		if (want('i9')) {
			// ---- I9: corners — ONE "+" for the next place, up to FOUR -----------------------------------
			await enterEdit(P);
			let d = await draft(P);
			h.check(d.adds.left === 1 && d.adds.right === 1 && d.left.join() === 'ai,add' && d.right.join() === 'chat,mic', T + `I9: each corner shows ONE "+" above its two buttons (${JSON.stringify({ l: d.left, r: d.right, adds: d.adds })})`);
			for (const pick of ['UV editor', 'Profiler']) {
				await clickAt(P, P.locator('#hud-stack-left .hud-edit-add'));
				await P.getByRole('menuitem', { name: pick, exact: true }).click();
				await P.waitForTimeout(300);
			}
			d = await draft(P);
			h.check(d.left.join() === 'ai,add,uv,profiler' && d.adds.left === 0, T + `I9: a FOURTH button fits once three are placed, then no "+" is left (${d.left.join()} / +${d.adds.left})`);
			await shot(P, `i9-corner-four-${theme}`);

			// ---- I9: the top-right group is a region: placeholders, burger + profile static ------------
			h.check(d.top.join() === 'notes,notifications,peers' && d.adds.top === 1, T + `I9: the top-right group's notes / notifications / peers are placeholders, with one "+" (${d.top.join()} / +${d.adds.top})`);
			const statics = await P.evaluate(() => ({
				burger: !!document.querySelector('#logo-menu') && !document.querySelector('#logo-menu [data-edit-id], #logo-menu.hud-edit-item'),
				profile: !!document.querySelector('#avatar-trigger') && !document.querySelector('#avatar-trigger[data-edit-id]') && !document.querySelector('#avatar-trigger .hud-edit-remove'),
				natives: document.querySelectorAll('#hud-tr #notes-toggle, #hud-tr #notif-bell').length
			}));
			h.check(statics.burger && statics.profile, T + `I9: the burger menu and the profile carry no placeholder — they stay static (${JSON.stringify(statics)})`);
			h.check(statics.natives === 0, T + 'I9: the group\'s live buttons stand down while editing (no doubled ids)');
			// Explorer from the bar into the group, between the bell and the peers trigger
			const bell = await centre(P.locator('#hud-tr [data-edit-wrap="notifications"]'));
			await mouseDrag(P, await centre(P.locator('#controls-pill [data-edit-wrap="explorer"]')), { x: bell.x + 16, y: bell.y });
			// Scene notes from the group onto the bar's start
			// (43: aimed at the bar's start "+" — a diagonal drag aimed at Move's centre enters the bar's band one
			// step early, beside Move, and the live reorder rightly keeps it where it was dropped)
			await mouseDrag(P, await centre(P.locator('#hud-tr [data-edit-wrap="notes"]')), await centre(P.locator('#toolbar-edit-add-start')));
			d = await draft(P);
			h.check(d.top.join() === 'notifications,explorer,peers' && d.bar[0] === 'notes' && !d.bar.includes('explorer'), T + `I9: buttons move between the bar and the top-right group both ways (${d.top.join()} / bar ${d.bar.slice(0, 3).join()})`);
			// the bell is home-only: dragged onto the bar it stays home
			await mouseDrag(P, await centre(P.locator('#hud-tr [data-edit-wrap="notifications"]')), await centre(P.locator('#controls-pill [data-edit-wrap="rotate"]')));
			d = await draft(P);
			h.check(d.top.includes('notifications') && !d.bar.includes('notifications'), T + 'I9: the notifications bell cannot leave the top-right group (its panel opens there)');
			await clickAt(P, P.locator('#hud-tr [data-edit-wrap="peers"] .hud-edit-remove'));
			d = await draft(P);
			h.check(d.top.join() === 'notifications,explorer', T + `I9: "−" removes the peers trigger (${d.top.join()})`);
			await clickAt(P, P.locator('#hud-tr .hud-edit-add'));
			const topAdd = (await menuRows(P)).map((r) => r.label);
			h.check(topAdd.includes('Connected peers') && topAdd.includes('Code'), T + `I9: the group's "+" offers what may go there, the peers trigger included (${topAdd.join(' | ')})`);
			await closeMenus(P);
			await clickAt(P, P.locator('#hud-stack-right .hud-edit-add'));
			const cornerAdd = (await menuRows(P)).map((r) => r.label);
			h.check(!cornerAdd.includes('Connected peers'), T + `I9: a corner's "+" never offers the peers trigger (${cornerAdd.join(' | ')})`);
			await closeMenus(P);
			await shot(P, `i9-top-right-edit-${theme}`);
			await clickAt(P, P.locator('#toolbar-edit-apply'));
			await P.waitForTimeout(500);
			const rec = await stored(P);
			h.check(rec?.top?.join() === 'notifications,explorer' && rec?.left?.length === 4 && rec?.order?.[0] === 'notes', T + `I9: ✓ applies into the ONE record (${JSON.stringify({ top: rec?.top, left: rec?.left, bar0: rec?.order?.[0] })})`);
			let tr = await topRight(P);
			h.check(tr.join() === 'notif-bell,explorer-slot', T + `I9: the live top-right group is the bell then the Explorer button (${tr.join()})`);
			h.check((await P.locator('#notes-toggle').count()) === 1 && (await P.locator('#controls-pill #notes-toggle').count()) === 1, T + 'I9: Scene notes now lives on the bar — exactly one #notes-toggle');
			h.check((await stackIds(P, 'left')).length === 4, T + 'I9: the left corner draws four buttons');
			await shot(P, `i9-applied-${theme}`);
			// the moved Explorer button still does its job from the corner of the screen
			await P.locator('#hud-tr #explorer-slot').click();
			await P.waitForTimeout(600);
			h.check((await P.evaluate(() => { let v; window.__tp.test.v1.explorerClose.subscribe((x) => (v = x))(); return v; })) === false, T + 'I9: the Explorer button works from the top-right group');
			await P.evaluate(() => window.__tp.test.v1.explorerClose.set(true));
			// Customize lists the new sections
			await P.locator('#toolbar-customize').click();
			await P.waitForTimeout(400);
			const sections = await P.evaluate(() => [...document.querySelectorAll('[role="menu"] *')].map((el) => el.textContent.trim()).filter((t) => t === 'Top right' || t === 'Left corner'));
			h.check(sections.includes('Top right'), T + `I9: Customize toolbar… has a "Top right" section (${[...new Set(sections)].join(' | ')})`);
			await closeMenus(P);
			// persists across a reload (hydrates default, applies the record after mount)
			await P.reload({ waitUntil: 'domcontentloaded' });
			await P.waitForTimeout(5500);
			await P.locator('#restore-session-dismiss').click({ timeout: 4000 }).catch(() => {});
			tr = await topRight(P);
			h.check(tr.join() === 'notif-bell,explorer-slot' && (await stackIds(P, 'left')).length === 4, T + `I9: a reload keeps it all (${tr.join()})`);
		}

		// ---- I8: a layout carries the desktop toolbar ----------------------------------------------
		if (theme === 'dark' && want('i8')) {
			if (!want('i9')) {
				// run alone: arrange something first (hide Rotate through Customize — any build has it)
				await P.locator('#toolbar-customize').click();
				await P.waitForTimeout(300);
				await P.getByRole('menuitem', { name: 'Rotate (2)', exact: true }).click();
				await P.waitForTimeout(300);
				await closeMenus(P);
			}
			const before = await stored(P);
			const liveBefore = { tr: await topRight(P), left: await stackIds(P, 'left'), bar: await P.evaluate(() => [...document.querySelector('#controls-pill .hud-bar-row').children].map((el) => el.id || el.getAttribute('title'))) };
			await P.evaluate(() => window.__tp.test.v1.hudStackLift.set(true));
			const saved = await P.evaluate(() => window.__tp.test.v1.uiLayouts.saveLayout('Arranged'));
			const rec8 = await P.evaluate(() => JSON.parse(localStorage.getItem('uiLayouts')).find((l) => l.name === 'Arranged'));
			h.check(saved.ok && rec8?.v === 2 && !!rec8?.chrome?.desktop?.controlsLayout && !rec8?.chrome?.phone, T + `I8: a desktop save carries the desktop chrome profile only (${JSON.stringify(Object.keys(rec8?.chrome ?? {}))})`);
			// wreck it: Reset toolbar, corner lift off
			await P.locator('#toolbar-customize').click();
			await P.waitForTimeout(300);
			await P.getByRole('menuitem', { name: 'Reset toolbar', exact: true }).click();
			await P.waitForTimeout(300);
			await closeMenus(P);
			await P.evaluate(() => window.__tp.test.v1.hudStackLift.set(false));
			await P.waitForTimeout(300);
			// the default top right also holds the peers trigger, drawn only while someone is there to show — on a
			// DEPLOYED build the cloud plugin's cross-scene presence (other people online anywhere) is enough
			// (Users.svelte `crossRooms`), so it comes and goes with production traffic. 48 G1: that is what
			// made this premise red on production only; the default ORDER is what is asserted.
			const trReset = (await topRight(P)).filter((id) => id !== 'peers-trigger');
			h.check((await stored(P)) === null && trReset.join() === 'notes-toggle,notif-bell', T + `premise: the toolbar is back to the default (${trReset.join()})`);
			const ok = await P.evaluate((id) => window.__tp.test.v1.uiLayouts.applyLayout(id), rec8.id);
			await P.waitForTimeout(600);
			const after = await stored(P);
			h.check(ok === true && JSON.stringify(after) === JSON.stringify(before), T + 'I8: applying the layout restores the toolbar record exactly');
			const liveAfter = { tr: await topRight(P), left: await stackIds(P, 'left'), bar: await P.evaluate(() => [...document.querySelector('#controls-pill .hud-bar-row').children].map((el) => el.id || el.getAttribute('title'))) };
			h.check(JSON.stringify(liveAfter) === JSON.stringify(liveBefore), T + `I8: …and the live bar, corners and top-right group follow at once, no reload (${JSON.stringify(liveAfter)})`);
			h.check((await P.evaluate(() => document.documentElement.classList.contains('hud-stacks-lifted'))) === true, T + 'I8: …and the corner-lift pref');
			await P.evaluate(() => window.__tp.test.v1.uiLayouts.layoutsMenuOpen.set(true));
			await P.waitForTimeout(400);
			const marks = await P.evaluate((id) => [...document.querySelectorAll(`[data-layout-id="${id}"] .wl-prof`)].map((el) => el.dataset.profile), rec8.id);
			h.check(marks.join() === 'desktop', T + `I8: the Layouts list marks what the layout carries (${marks.join()})`);
			await shot(P, 'i8-layouts-list-desktop');
			await P.evaluate(() => window.__tp.test.v1.uiLayouts.layoutsMenuOpen.set(false));
			// a pre-42 layout (v1, no chrome) leaves the toolbar alone
			await P.evaluate(() => {
				const list = JSON.parse(localStorage.getItem('uiLayouts'));
				list.push({ v: 1, id: 'lay-old1', name: 'Old one', savedAt: 1, open: {}, storage: {} });
				localStorage.setItem('uiLayouts', JSON.stringify(list));
			});
			await P.reload({ waitUntil: 'domcontentloaded' });
			await P.waitForTimeout(5500);
			await P.locator('#restore-session-dismiss').click({ timeout: 4000 }).catch(() => {});
			const pre = await stored(P);
			const old = await P.evaluate(() => {
				let list;
				window.__tp.test.v1.uiLayouts.uiLayouts.subscribe((v) => (list = v))();
				return list.find((l) => l.id === 'lay-old1');
			});
			h.check(old?.v === 2 && JSON.stringify(old?.chrome) === '{}', T + `I8: a pre-42 layout migrates to v2 with no chrome (${JSON.stringify(old?.chrome)})`);
			await P.evaluate(() => window.__tp.test.v1.uiLayouts.applyLayout('lay-old1'));
			await P.waitForTimeout(500);
			h.check(JSON.stringify(await stored(P)) === JSON.stringify(pre), T + 'I8: …and applying it leaves the toolbar as it was');
		}
		h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
		await A.ctx.close();
	}

	// ═══ OPPO Find N6 UNFOLDED (770×850, DPR 2.9) — REAL touch; then FOLDED for the phone profile ═══
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'unfolded-' + theme, {
			context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			// the auto-quality toasts land over the top-left row on this box (a slow GPU) and a press on
			// them reads as "outside" — keep toasts in the Connect drawer for this context
			storage: { theme, touchTools: 'true', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const P = A.page;
		const T = `[unfolded ${theme}] `;
		const cdp = await P.context().newCDPSession(P);
		const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
		const tap = async (loc) => {
			const p = await centre(loc);
			await touch('touchStart', p.x, p.y);
			await touch('touchEnd');
			await P.waitForTimeout(300);
		};
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
		h.check((await P.locator('#touch-tools').isVisible()) && (await P.locator('#controls-pill').isVisible()), T + 'premise: unfolded, the desktop bar and the touch tools are drawn');
		h.check(await onTop(P, '#touch-multiselect'), T + 'premise: nothing covers the touch tools (no toast over the row)');

		// ---- I10 on touch: a long press offers the lift rows ----------------------------------------
		if (want('i10')) {
			await hold(await centre(P.locator('#controls-pill > div > [title="Explorer"]')));
			const held = (await menuRows(P)).map((r) => r.label);
			h.check(held.includes('Lift corner buttons above docked panels') && held.includes('Lift toolbar above docked panels'), T + 'I10: a long press opens the menu with both lift rows');
			// the menu stays open: I9 takes its Edit positions row (a second hold would land on its backdrop)
		}

		// ---- I9: the touch tools join the edit model (real touch) -----------------------------------
		if (want('i9')) {
			if (!(await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).count())) await hold(await centre(P.locator('#controls-pill > div > [title="Explorer"]')));
			await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).tap();
			await P.waitForTimeout(450);
			let d = await draft(P);
			h.check(d.touch.join() === 'undo,redo,multiselect' && d.adds.touch === 1, T + `I9: undo / redo / multi-select are placeholders, with one "+" (${d.touch.join()} / +${d.adds.touch})`);
			await shot(P, `i9-touch-edit-${theme}`);
			if (theme === 'dark') {
				// a finger drags Redo before Undo, and Multi-select into the right corner (after the edit
				// mode has settled: one run in four lost the first finger drag fired right after the shot)
				await P.waitForTimeout(500);
				await touchDrag(await centre(P.locator('#touch-tools [data-edit-id="redo"]')), await centre(P.locator('#touch-tools [data-edit-id="undo"]')));
				await touchDrag(await centre(P.locator('#touch-tools [data-edit-id="multiselect"]')), await centre(P.locator('#hud-stack-right .hud-edit-add')));
				d = await draft(P);
				h.check(d.touch.join() === 'redo,undo' && d.right.join() === 'chat,mic,multiselect', T + `I9: a finger reorders the touch tools and carries one into a corner (${d.touch.join()} / ${d.right.join()})`);
				await P.locator('#toolbar-edit-apply').tap();
				await P.waitForTimeout(450);
				const live = await P.evaluate(() => ({
					// a row (left → right) or, when the cluster stacks, a column (top → bottom)
					touch: [...document.querySelectorAll('#touch-tools button')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((el) => el.id),
					right: [...document.querySelectorAll('#hud-stack-right > *')].map((el) => el.id)
				}));
				h.check(live.touch.join() === 'touch-redo,touch-undo' && live.right.join() === 'chat-button,mic-button,touch-multiselect', T + `I9: ✓ applies by touch — the cluster and the corner draw it (${JSON.stringify(live)})`);
				await tap(P.locator('#hud-stack-right #touch-multiselect'));
				h.check((await P.evaluate(() => { let v; window.__tp.test.v1.multiSelectMode.subscribe((x) => (v = x))(); return v; })) === true, T + 'I9: Multi-select still toggles from its new place');
				await tap(P.locator('#hud-stack-right #touch-multiselect'));
				await shot(P, `i9-touch-applied-${theme}`);
			} else {
				await P.keyboard.press('Escape').catch(() => {});
			}
		}

		// ---- I8: the phone profile — save folded, the desktop profile kept in the SAME record -------
		if (theme === 'dark' && want('i8')) {
			await closeMenus(P);
			const rightBefore = await stackIds(P, 'right');
			const deskSave = await P.evaluate(() => window.__tp.test.v1.uiLayouts.saveLayout('Both'));
			const deskRec = await stored(P);
			await P.setViewportSize({ width: 390, height: 896 });
			await P.waitForTimeout(1000);
			h.check(await P.evaluate(() => document.documentElement.classList.contains('phone-shell')), T + 'premise: folded, the phone shell takes over');
			await P.evaluate(() => { window.__tp.test.v1.phoneBar.setBar(['objects', 'chat', 'more']); window.__tp.test.v1.phonePrefs.phoneGrabHandle.set(false); });
			const phoneSave = await P.evaluate(() => window.__tp.test.v1.uiLayouts.saveLayout('Both'));
			const both = await P.evaluate(() => JSON.parse(localStorage.getItem('uiLayouts')).find((l) => l.name === 'Both'));
			h.check(deskSave.ok && phoneSave.ok && phoneSave.updated && !!both?.chrome?.desktop && both?.chrome?.phone?.phoneBar === '["objects","chat","more"]' && both?.chrome?.phone?.phoneGrabHandle === '0', T + `I8: a save from the FOLDED phone adds the phone profile and keeps the desktop one (${JSON.stringify(both?.chrome)})`);
			// change both, then apply from the folded phone
			await P.evaluate(() => { window.__tp.test.v1.phoneBar.setBar(['add', 'objects', 'explorer', 'more']); window.__tp.test.v1.phonePrefs.phoneGrabHandle.set(true); });
			await P.evaluate(() => localStorage.setItem('controlsLayout', JSON.stringify({ order: ['move'], hidden: [], spacerIndex: 0 })));
			await P.evaluate((id) => window.__tp.test.v1.uiLayouts.applyLayout(id), both.id);
			await P.waitForTimeout(600);
			const phoneBar = await P.evaluate(() => { let v; window.__tp.test.v1.phoneBar.phoneBar.subscribe((x) => (v = x))(); return v; });
			h.check(phoneBar.join() === 'objects,chat,more', T + `I8: applying it brings the phone bar back (${phoneBar.join()})`);
			const grab = await P.evaluate(() => { let v; window.__tp.test.v1.phonePrefs.phoneGrabHandle.subscribe((x) => (v = x))(); return v; });
			h.check(grab === false, T + `I8 (42-int): …and More's Show switches with it (Grab handle ${grab})`);
			await shot(P, 'i8-folded-applied');
			await P.setViewportSize({ width: 770, height: 850 });
			await P.waitForTimeout(1000);
			h.check(JSON.stringify(await stored(P)) === JSON.stringify(deskRec), T + 'I8: …and unfolding shows the DESKTOP profile it restored in the same apply');
			const live2 = await stackIds(P, 'right');
			h.check(live2.join() === rightBefore.join(), T + `I8: the unfolded corners are the saved ones (${live2.join()})`);
		}
		h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
		await A.ctx.close();
	}
	await h.finish(browser);
});
