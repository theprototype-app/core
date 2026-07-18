// Phase 116: VR keyboard (native key grid) + Objects panel row actions v2.
// Covers the pure buffer semantics, the target open/route/commit/cancel
// lifecycle, the rendered key grid, and the row actions (visibility, rename
// through the keyboard replicated to a peer, delete with a locked refuse).
// Typing feel in-headset is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure buffer semantics ---
	const buffer = await A.page.evaluate(() => {
		const k = window.__stores.vrKeyboard;
		let s = { buffer: '', shift: false };
		const feed = (key) => (s = k.keyPress(key, s));
		feed('h');
		feed('shift');
		const shiftArmed = s.shift;
		feed('i'); // uppercased, shift clears
		const afterI = { buffer: s.buffer, shift: s.shift };
		feed('space');
		feed('2'); // digit
		feed('backspace');
		const beforeCommit = s.buffer;
		const commit = k.keyPress('enter', s);
		const cancel = k.keyPress('esc', s);
		return {
			shiftArmed,
			afterI,
			beforeCommit,
			commitDone: commit.done,
			cancelDone: cancel.done,
			labels: {
				shiftDigit: k.keyLabel('3', true),
				plainDigit: k.keyLabel('3', false),
				upper: k.keyLabel('q', true),
				space: k.keyLabel('space', false)
			}
		};
	});
	h.check(buffer.shiftArmed === true, 'Shift arms one-shot');
	h.check(
		buffer.afterI.buffer === 'hI' && buffer.afterI.shift === false,
		`Shift upper-cases one char then clears (${buffer.afterI.buffer})`
	);
	h.check(buffer.beforeCommit === 'hI ', `space adds, backspace removes the digit (${buffer.beforeCommit})`);
	h.check(buffer.commitDone === 'commit' && buffer.cancelDone === 'cancel', 'Enter commits, Esc cancels');
	h.check(
		buffer.labels.shiftDigit === '#' && buffer.labels.plainDigit === '3' && buffer.labels.upper === 'Q',
		'key labels reflect shift (digits punctuate, letters upper)'
	);

	// --- target lifecycle: open → route → commit ---
	const lifecycle = await A.page.evaluate(() => {
		const k = window.__stores.vrKeyboard;
		let committed = null;
		let cancelled = false;
		k.openVRKeyboard({ title: 'Type', initial: 'ab', onCommit: (t) => (committed = t), onCancel: () => (cancelled = true) });
		const opened = (() => {
			let v;
			k.vrKeyboardTarget.subscribe((x) => (v = x))();
			return v;
		})();
		k.pressVRKey('c');
		k.pressVRKey('enter');
		const closed = (() => {
			let v;
			k.vrKeyboardTarget.subscribe((x) => (v = x))();
			return v === null;
		})();
		// a fresh open then cancel
		k.openVRKeyboard({ title: 'X', onCommit: () => {}, onCancel: () => (cancelled = true) });
		k.pressVRKey('esc');
		return { title: opened?.title, initial: opened?.buffer, committed, closed, cancelled };
	});
	h.check(lifecycle.title === 'Type' && lifecycle.initial === 'ab', 'openVRKeyboard seeds title + initial buffer');
	h.check(lifecycle.committed === 'abc' && lifecycle.closed, 'pressVRKey builds the buffer, Enter commits + closes');
	h.check(lifecycle.cancelled, 'Esc fires onCancel');

	// --- rendered key grid ---
	await A.page.evaluate(() =>
		window.__stores.vrKeyboard.openVRKeyboard({ title: 'Test', onCommit: () => {} })
	);
	await A.page.waitForTimeout(400);
	const keys = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-keyboard');
					const names = [];
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrkey-')) names.push(o.name.slice(6));
					});
					resolve(names);
				})();
			})
	);
	h.check(
		keys.includes('q') && keys.includes('shift') && keys.includes('backspace') &&
			keys.includes('space') && keys.includes('enter') && keys.includes('esc'),
		`key grid renders letters + specials (${keys.length} keys)`
	);
	await A.page.evaluate(() => window.__stores.vrKeyboard.closeVRKeyboard());

	// --- Objects panel row actions v2: visibility + delete + rename ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__crate = group.children[group.children.length - 2];
		window.__crate.name = 'Crate';
		window.__ball = group.children[group.children.length - 1];
		window.__ball.name = 'Ball';
		window.__stores.vrObjectsPanelOpen.set(true);
	});
	await A.page.waitForTimeout(400);

	const rowActions = await A.page.evaluate(() => {
		const v = window.__stores.vrControls;
		const crate = window.__crate;
		v.executeVRMenuAction('panel:visible:' + crate.uuid);
		const hidden = crate.visible === false;
		v.executeVRMenuAction('panel:visible:' + crate.uuid);
		const shown = crate.visible !== false;
		return { hidden, shown };
	});
	h.check(rowActions.hidden && rowActions.shown, 'row visibility button toggles that object');

	// rename opens the keyboard seeded with the current name; typing + Enter renames
	const renamed = await A.page.evaluate(() => {
		const v = window.__stores.vrControls;
		const k = window.__stores.vrKeyboard;
		v.executeVRMenuAction('panel:rename:' + window.__crate.uuid);
		const seeded = (() => {
			let x;
			k.vrKeyboardTarget.subscribe((t) => (x = t))();
			return x?.buffer;
		})();
		for (let i = 0; i < 8; i++) k.pressVRKey('backspace');
		['b', 'o', 'x', 'y'].forEach((c) => k.pressVRKey(c));
		k.pressVRKey('enter');
		return { seeded, name: window.__crate.name };
	});
	h.check(renamed.seeded === 'Crate', 'rename seeds the keyboard with the current name');
	h.check(renamed.name === 'boxy', `rename commit updates the object name (${renamed.name})`);

	// delete refuses when another peer holds the lock
	const lockedDelete = await A.page.evaluate(async () => {
		const v = window.__stores.vrControls;
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const before = group.children.length;
		window.__stores.lockedObjects.set([['peerX', window.__ball.uuid]]);
		v.executeVRMenuAction('panel:delete:' + window.__ball.uuid);
		const afterLocked = group.children.length;
		window.__stores.lockedObjects.set([]);
		v.executeVRMenuAction('panel:delete:' + window.__ball.uuid);
		const afterFree = group.children.length;
		return { before, afterLocked, afterFree };
	});
	h.check(lockedDelete.afterLocked === lockedDelete.before, 'delete refuses a peer-locked object');
	h.check(lockedDelete.afterFree === lockedDelete.before - 1, 'delete removes an unlocked object');

	// rename routes through renameObject, which sends the replicated `name`
	// message (the receive path is covered by the object-sync suites)
	const sends = await A.page.evaluate(() => {
		const captured = [];
		const v = window.__stores.vrControls;
		const k = window.__stores.vrKeyboard;
		let original;
		window.__stores.peers.subscribe((p) => (original = p))();
		window.__stores.peers.set({ ...(original ?? {}), send: (m) => captured.push(m) });
		v.executeVRMenuAction('panel:rename:' + window.__crate.uuid);
		for (let i = 0; i < 8; i++) k.pressVRKey('backspace');
		['k', 'e', 'g'].forEach((c) => k.pressVRKey(c));
		k.pressVRKey('enter');
		window.__stores.peers.set(original);
		return captured;
	});
	const nameMsg = sends.find((m) => m.type === 'name');
	h.check(
		!!nameMsg && nameMsg.name === 'keg' && nameMsg.uuid,
		`rename broadcasts a name message (${nameMsg?.name})`
	);

	await h.finish(browser);
});
