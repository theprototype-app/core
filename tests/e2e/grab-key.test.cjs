// W5 — G is "grab/move" in three places, and all three are rebindable in Settings.
//
//   viewport   G arms the translate gizmo (a second name for 1, the muscle memory
//              people arrive with from Blender)
//   UV editor  G arms Move, from that editor's OWN capture-phase keydown
//   timeline   G arms Move, likewise
//
// The interesting part is not the letter, it is that the same combo can mean three
// things without conflicting. Two mechanisms hold that up and this suite pins both:
//
//  · an `external: true` registry row is REBINDABLE but has no action — the editor
//    that owns the focus scope asks `bindingOf(id)` what to answer to, so the key
//    lives in one place while running somewhere else. `handleKeydown` skips such rows
//    EXPLICITLY, so an external row can never shadow a global command.
//  · a `scope` says WHERE a combo means something, and `conflictOf` only collides rows
//    that can hear the same press: global-global and same-scope conflict, scoped vs
//    global (or vs another scope) does not. Section 5 asserts both halves — the three
//    G defaults are clean, and a second UV binding on G is not.
//
// A live mesh session owns G outright (MESH_EDIT_KEYS), which is deliberate and
// asserted here too: inside Edit Mesh, G is the session's grab, not the gizmo's.
const h = require('./helpers.cjs');

const transformMode = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.transformMode.subscribe((x) => (v = x))();
		return v;
	});

const setMode = async (page, mode) => {
	await page.evaluate((m) => window.__stores.objectActions.setTransformMode(m), mode);
	await page.waitForTimeout(200);
};

/** a real key press with nothing focused (the registry stands down inside text fields) */
async function press(page, key) {
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.keyboard.press(key);
	await page.waitForTimeout(300);
}

async function openSettings(page) {
	await page.evaluate(() => {
		window.__stores.settingsSection.set('shortcuts');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForSelector('#shortcut-grid', { timeout: 15000 });
	await page.waitForTimeout(250);
}
const closeSettings = async (page) => {
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);
};

const regOf = (page, id) =>
	page.evaluate((sid) => {
		const s = window.__stores.shortcutsRegistry.shortcuts.find((x) => x.id === sid);
		return s ? { keys: s.keys, defaultKeys: s.defaultKeys, group: s.group, scope: s.scope ?? null, external: !!s.external } : null;
	}, id);

/** rebind through the REAL Settings row: click its key control, press the combo */
async function rebindVia(page, id, keyDown) {
	await page.click(`[data-shortcut="${id}"] .shortcut-keys`);
	await page.waitForTimeout(250);
	await keyDown();
	await page.waitForTimeout(350);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => localStorage.removeItem('shortcutOverrides'));
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => !!window.__stores?.shortcutsRegistry, { timeout: 30000 });
	await A.page.waitForTimeout(600);

	// =================================================== 1. the registry rows exist
	const grab = await regOf(A.page, 'transform.grab');
	const uvGrab = await regOf(A.page, 'uv.grab');
	const animGrab = await regOf(A.page, 'animation.grab');
	h.check(
		grab && grab.keys === 'G' && grab.group === 'Transform' && !grab.external,
		`1.1 the viewport row is a normal Transform command on G (${JSON.stringify(grab)})`
	);
	h.check(
		uvGrab && uvGrab.keys === 'G' && uvGrab.external && uvGrab.scope === 'uv',
		`1.2 the UV row is external and scoped (${JSON.stringify(uvGrab)})`
	);
	h.check(
		animGrab && animGrab.keys === 'G' && animGrab.external && animGrab.scope === 'animation',
		`1.3 the timeline row is external and scoped (${JSON.stringify(animGrab)})`
	);
	const rebindable = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry;
		const of = (id) => r.isRebindable(r.shortcuts.find((s) => s.id === id));
		return { grab: of('transform.grab'), uv: of('uv.grab'), anim: of('animation.grab'), fly: of('movement.fly') };
	});
	h.check(
		rebindable.grab && rebindable.uv && rebindable.anim,
		`1.4 all three are REBINDABLE — an external row is a real combo, not a locked label (${JSON.stringify(rebindable)})`
	);
	h.check(!rebindable.fly, '1.5 ...while a `fixed` display row (W A S D) stays locked');
	// and Settings renders them as editable controls, not locked kbd labels
	await openSettings(A.page);
	const controls = await A.page.evaluate(() =>
		['transform.grab', 'uv.grab', 'animation.grab'].map(
			(id) => !!document.querySelector(`[data-shortcut="${id}"] .shortcut-keys`)
		)
	);
	h.check(
		controls.every(Boolean),
		`1.6 Settings offers a rebind control on every one of the three (${JSON.stringify(controls)})`
	);
	await closeSettings(A.page);

	// ======================================================= 2. the viewport G works
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 500));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		s.objectActions.selectObject(obj.uuid);
		return obj.uuid;
	});
	h.check(!!uuid, '2.0 premise: an object is created and selected');
	await setMode(A.page, 'rotate');
	h.check((await transformMode(A.page)) === 'rotate', '2.1 premise: the gizmo is on Rotate going in');
	await press(A.page, 'g');
	h.check(
		(await transformMode(A.page)) === 'translate',
		`2.2 G arms Move in the viewport (${await transformMode(A.page)})`
	);
	// the key it doubles for still works, and neither is "the real one"
	await setMode(A.page, 'scale');
	await press(A.page, '1');
	h.check((await transformMode(A.page)) === 'translate', '2.3 ...and 1 still does exactly the same thing');

	// a live mesh session owns G — the registry stands down (MESH_EDIT_KEYS)
	await setMode(A.page, 'rotate');
	await A.page.evaluate((u) => window.__stores.meshEdit.enterEditMode(u), uuid);
	await A.page.waitForTimeout(500);
	await press(A.page, 'g');
	const inSession = await transformMode(A.page);
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await A.page.waitForTimeout(400);
	h.check(
		inSession === 'rotate',
		`2.4 inside Edit Mesh the session keeps G and the gizmo is left alone (${inSession})`
	);

	// ========================================== 3. rebinding the viewport row moves it
	await openSettings(A.page);
	await rebindVia(A.page, 'transform.grab', async () => {
		await A.page.keyboard.down('Alt');
		await A.page.keyboard.press('g');
		await A.page.keyboard.up('Alt');
	});
	const moved = await regOf(A.page, 'transform.grab');
	h.check(moved.keys === 'Alt+G', `3.1 the Settings row rebound it to Alt+G (${moved.keys})`);
	await closeSettings(A.page);

	await setMode(A.page, 'rotate');
	await press(A.page, 'g');
	h.check(
		(await transformMode(A.page)) === 'rotate',
		`3.2 bare G no longer arms Move (${await transformMode(A.page)})`
	);
	await A.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await A.page.keyboard.down('Alt');
	await A.page.keyboard.press('g');
	await A.page.keyboard.up('Alt');
	await A.page.waitForTimeout(300);
	h.check(
		(await transformMode(A.page)) === 'translate',
		`3.3 ...and Alt+G does (${await transformMode(A.page)})`
	);
	// reset, so the rest of the suite reasons about the default
	await A.page.evaluate(() => window.__stores.shortcutsRegistry.resetShortcut('transform.grab'));
	await A.page.waitForTimeout(200);
	h.check((await regOf(A.page, 'transform.grab')).keys === 'G', '3.4 reset puts it back on G');

	// ============================================================ 4. the UV editor
	await A.page.evaluate(async () => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((x) => (g = x))();
		const box = g.children[g.children.length - 1];
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#f00';
		ctx.fillRect(0, 0, 64, 64);
		box.material.map = new w.THREE.CanvasTexture(c);
		box.material.needsUpdate = true;
		w.objectActions.selectObject(box.uuid);
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
	});
	await A.page.waitForTimeout(900);
	const uvOpen = await A.page.evaluate(() => !!document.getElementById('uv-canvas') && !!window.__uvDebug);
	h.check(uvOpen, '4.0 premise: the UV editor is open on the textured box');

	/** focus the UV wrap the way a user does — a press on the canvas */
	const focusUv = async () => {
		const at = await A.page.evaluate(() => {
			const r = document.getElementById('uv-canvas').getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6) };
		});
		await A.page.mouse.click(at.x, at.y);
		await A.page.waitForTimeout(200);
	};
	const uvXform = () => A.page.evaluate(() => window.__uvDebug().xform);

	await focusUv();
	await A.page.keyboard.press('3');
	await A.page.waitForTimeout(200);
	h.check((await uvXform()) === 'scale', `4.1 premise: 3 arms Scale in the UV editor (${await uvXform()})`);
	await A.page.keyboard.press('g');
	await A.page.waitForTimeout(200);
	h.check((await uvXform()) === 'move', `4.2 G arms Move in the UV editor (${await uvXform()})`);
	// ...and it did NOT also reach the global registry: the capture handler stops it,
	// which is the whole reason the two rows can share a combo
	const gizmoAfterUv = await transformMode(A.page);
	await A.page.keyboard.press('3');
	await A.page.waitForTimeout(150);
	await setMode(A.page, 'rotate');
	await focusUv();
	await A.page.keyboard.press('g');
	await A.page.waitForTimeout(250);
	h.check(
		(await transformMode(A.page)) === 'rotate',
		`4.3 ...and the press never reached the viewport gizmo (${await transformMode(A.page)}, was ${gizmoAfterUv})`
	);

	// the binding is REBOUND, not hard-coded: move uv.grab and the editor follows
	await openSettings(A.page);
	await rebindVia(A.page, 'uv.grab', async () => {
		await A.page.keyboard.down('Alt');
		await A.page.keyboard.press('g');
		await A.page.keyboard.up('Alt');
	});
	h.check((await regOf(A.page, 'uv.grab')).keys === 'Alt+G', '4.4 uv.grab rebound to Alt+G');
	await closeSettings(A.page);
	await focusUv();
	await A.page.keyboard.press('3');
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('g');
	await A.page.waitForTimeout(250);
	h.check((await uvXform()) === 'scale', `4.5 bare G no longer arms Move there (${await uvXform()})`);
	await A.page.keyboard.down('Alt');
	await A.page.keyboard.press('g');
	await A.page.keyboard.up('Alt');
	await A.page.waitForTimeout(250);
	h.check((await uvXform()) === 'move', `4.6 ...and Alt+G does — bindingOf is honoured (${await uvXform()})`);
	await A.page.evaluate(() => window.__stores.shortcutsRegistry.resetShortcut('uv.grab'));
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => window.__stores.uvEditorClose.set(true));
	await A.page.waitForTimeout(400);

	// ============================================================ 5. the timeline
	await A.page.evaluate(async (u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', u);
		const ap = s.animationPreview;
		ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		s.objectActions.selectObject(obj.uuid, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		await new Promise((r) => setTimeout(r, 800));
	}, uuid);
	await A.page.waitForTimeout(400);
	const animOpen = await A.page.evaluate(() => !!window.__animationDebug);
	h.check(animOpen, '5.0 premise: the Animation pane is open with a track');
	const animXform = () => A.page.evaluate(() => window.__animationDebug.xform());

	/** Click the plot so the pane owns the keyboard, then press for real. The pane's
	 *  keydown is a DIRECT listener on its own host, so a press anywhere else goes to
	 *  the global registry instead — animation-curves' own idiom. */
	const focusPlot = async () => {
		const box = await A.page.locator('#animation-timeline').boundingBox();
		if (!box) return false;
		await A.page.mouse.click(box.x + 6, box.y + box.height - 6);
		await A.page.waitForTimeout(200);
		return true;
	};
	h.check(await focusPlot(), '5.1 premise: the plot takes the keyboard on a click');
	await A.page.keyboard.press('2');
	await A.page.waitForTimeout(200);
	h.check((await animXform()) === 'scale', `5.2 premise: 2 arms Scale in the timeline (${await animXform()})`);
	await A.page.keyboard.press('g');
	await A.page.waitForTimeout(200);
	h.check((await animXform()) === 'move', `5.3 G arms Move in the timeline (${await animXform()})`);
	// and it did not also reach the gizmo — the pane claims and stops the press
	await setMode(A.page, 'rotate');
	await focusPlot();
	await A.page.keyboard.press('g');
	await A.page.waitForTimeout(250);
	h.check(
		(await transformMode(A.page)) === 'rotate',
		`5.3b ...without the viewport gizmo hearing it (${await transformMode(A.page)})`
	);

	await openSettings(A.page);
	await rebindVia(A.page, 'animation.grab', async () => {
		await A.page.keyboard.down('Alt');
		await A.page.keyboard.press('g');
		await A.page.keyboard.up('Alt');
	});
	h.check((await regOf(A.page, 'animation.grab')).keys === 'Alt+G', '5.4 animation.grab rebound to Alt+G');
	await closeSettings(A.page);
	await focusPlot();
	await A.page.keyboard.press('2');
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('g');
	await A.page.waitForTimeout(250);
	h.check((await animXform()) === 'scale', `5.5 bare G no longer arms Move there (${await animXform()})`);
	await A.page.keyboard.down('Alt');
	await A.page.keyboard.press('g');
	await A.page.keyboard.up('Alt');
	await A.page.waitForTimeout(250);
	h.check((await animXform()) === 'move', `5.6 ...and Alt+G does (${await animXform()})`);
	await A.page.evaluate(() => window.__stores.shortcutsRegistry.resetShortcut('animation.grab'));
	await A.page.waitForTimeout(200);

	// ================================================= 6. the conflict scope rule
	const verdicts = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry;
		const name = (v) => (v.shortcut ? v.shortcut.id : null);
		return {
			// each of the three G rows, asked who else answers to G in ITS scope
			viewport: name(r.conflictOf('G', 'transform.grab')),
			uv: name(r.conflictOf('G', 'uv.grab')),
			anim: name(r.conflictOf('G', 'animation.grab')),
			// a REAL double-bind: another global command moved onto G
			globalClash: name(r.conflictOf('G', 'camera.focus')),
			// ...and a real double-bind INSIDE one scope, built on the spot
			sameScope: (() => {
				r.shortcuts.push({ id: 'uv.decoy', keys: 'G', group: 'UV editor', label: 'decoy', external: true, scope: 'uv', defaultKeys: 'G' });
				const v = name(r.conflictOf('G', 'uv.grab'));
				r.shortcuts.splice(r.shortcuts.findIndex((s) => s.id === 'uv.decoy'), 1);
				return v;
			})()
		};
	});
	h.check(
		verdicts.viewport === null && verdicts.uv === null && verdicts.anim === null,
		`6.1 the three G defaults conflict with nothing — different scopes never collide (${JSON.stringify(verdicts)})`
	);
	h.check(
		verdicts.globalClash === 'transform.grab',
		`6.2 ...but a GLOBAL command moved onto G is refused against the viewport row (${verdicts.globalClash})`
	);
	h.check(
		verdicts.sameScope === 'uv.decoy',
		`6.3 ...and two bindings inside ONE scope still collide (${verdicts.sameScope})`
	);

	// The matcher SKIPS external rows explicitly rather than relying on them having no
	// action — and the difference is order. Today `transform.grab` happens to sit
	// before `uv.grab` in the array, so a plain `find` on `keys` would answer
	// correctly by luck; put the external row first and a matcher without the guard
	// returns it, finds no action and RETURNS — the viewport G silently dead. So the
	// premise of this check is the hostile order, restored afterwards.
	await A.page.evaluate(() => window.__stores.animationClose.set(true));
	await A.page.waitForTimeout(400);
	const reordered = await A.page.evaluate(() => {
		const list = window.__stores.shortcutsRegistry.shortcuts;
		const i = list.findIndex((s) => s.id === 'uv.grab');
		const j = list.findIndex((s) => s.id === 'transform.grab');
		if (i < 0 || j < 0) return null;
		const [row] = list.splice(i, 1);
		list.unshift(row); // the external row now answers to G FIRST
		return { movedTo: list.findIndex((s) => s.id === 'uv.grab'), global: list.findIndex((s) => s.id === 'transform.grab') };
	});
	h.check(
		reordered && reordered.movedTo < reordered.global,
		`6.4 premise: the external G row is ahead of the global one (${JSON.stringify(reordered)})`
	);
	await setMode(A.page, 'rotate');
	await press(A.page, 'g');
	h.check(
		(await transformMode(A.page)) === 'translate',
		`6.5 an external row never shadows a real command, whatever the order (${await transformMode(A.page)})`
	);
	await A.page.evaluate(() => {
		const list = window.__stores.shortcutsRegistry.shortcuts;
		const [row] = list.splice(list.findIndex((s) => s.id === 'uv.grab'), 1);
		list.splice(list.findIndex((s) => s.id === 'transform.grab') + 1, 0, row);
	});
	await A.page.evaluate(() => window.__stores.shortcutsRegistry.resetAllShortcuts());
	await A.page.waitForTimeout(200);
	h.check(
		(await regOf(A.page, 'transform.grab')).keys === 'G' && (await regOf(A.page, 'uv.grab')).keys === 'G',
		'6.6 reset-all puts every G row back on its default'
	);

	await h.finish(browser);
});
