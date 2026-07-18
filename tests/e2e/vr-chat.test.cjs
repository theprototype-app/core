// Phase 117: VR chat panel — the Chat sector opens it, messages render with
// an unread badge while closed, and the input row opens the 116 keyboard
// whose commit sends through the normal chat path. The ring shuffle (Chat on
// the base ring, Mic nested under System) shipped in 109 and is covered by
// the radial suite; here we re-verify the nested Mic back-stack. Feel is
// the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- Chat sector opens the panel, closes the ring + siblings ---
	const open = await A.page.evaluate(() => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const s = window.__stores;
		s.vrPaletteOpen.set(true);
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('chat');
		return {
			chat: read(s.vrChatPanelOpen),
			palette: read(s.vrPaletteOpen),
			menu: read(s.vrMenuOpen)
		};
	});
	h.check(
		open.chat === true && open.palette === false && open.menu === false,
		'Chat sector opens the panel and closes the ring + palette'
	);

	// --- messages render; unread badge counts while closed, clears on open ---
	await A.page.evaluate(() => window.__stores.vrChatPanelOpen.set(false));
	const badge = await A.page.evaluate(() => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const s = window.__stores;
		s.vrControls.vrChatUnread.set(0);
		// two incoming messages while the panel is closed
		s.addMessage({ message: 'hello VR', type: 'received', sender: 'peerX' });
		s.addMessage({ message: 'second', type: 'received', sender: 'peerX' });
		const whileClosed = read(s.vrControls.vrChatUnread);
		s.vrChatPanelOpen.set(true);
		const afterOpen = read(s.vrControls.vrChatUnread);
		return { whileClosed, afterOpen };
	});
	h.check(badge.whileClosed === 2, `unread badge counts messages while closed (${badge.whileClosed})`);
	h.check(badge.afterOpen === 0, 'opening the panel clears the unread badge');

	await A.page.waitForTimeout(400);
	const rendered = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-chat-panel');
					const controls = [];
					let texts = 0;
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrchat-')) controls.push(o.name.slice(7));
						if (o.isMesh && o.geometry?.type === 'ShapeGeometry') texts++; // troika text meshes
					});
					resolve({ controls, hasText: texts > 0 });
				})();
			})
	);
	h.check(
		rendered.controls.includes('close') && rendered.controls.includes('input'),
		`panel renders close + input controls (${rendered.controls.join(',')})`
	);

	// --- input row opens the keyboard; commit sends through the chat path ---
	const sent = await A.page.evaluate(() => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const s = window.__stores;
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({
			...(original ?? {}),
			peer: { id: 'me' },
			connections: {},
			sendMessage: (text) => {
				captured.push(text);
				s.addMessage({ message: text, type: 'sent', sender: 'me' });
			}
		});
		s.vrControls.executeVRMenuAction('chat:input');
		const keyboardOpen = !!read(s.vrKeyboard.vrKeyboardTarget);
		['h', 'i'].forEach((c) => s.vrKeyboard.pressVRKey(c));
		s.vrKeyboard.pressVRKey('enter');
		const kbClosed = read(s.vrKeyboard.vrKeyboardTarget) === null;
		const lastMsg = read(s.messages).slice(-1)[0];
		s.peers.set(original);
		return { keyboardOpen, kbClosed, captured, lastText: lastMsg?.text };
	});
	h.check(sent.keyboardOpen, 'the input row opens the VR keyboard');
	h.check(
		sent.captured.length === 1 && sent.captured[0] === 'hi' && sent.kbClosed,
		'keyboard commit sends through the chat path'
	);
	h.check(sent.lastText === 'hi', 'the sent message lands in the messages store');

	// --- chat:close closes the panel ---
	const closed = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrControls.executeVRMenuAction('chat:close');
		let v;
		s.vrChatPanelOpen.subscribe((x) => (v = x))();
		return v;
	});
	h.check(closed === false, 'chat:close closes the panel');

	// --- nested System ▸ Mic ▸ back-stack (117.1 shuffle, 109 stack) ---
	const stack = await A.page.evaluate(() => {
		const s = window.__stores;
		const ring = () => {
			let r;
			s.vrRadialMenu.activeRing.subscribe((x) => (r = x))();
			return r;
		};
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('nav:system');
		s.vrControls.executeVRMenuAction('nav:mic');
		const inMic = ring();
		s.vrControls.executeVRMenuAction('back');
		const afterBack = ring();
		s.vrControls.executeVRMenuAction('back');
		const atRoot = ring();
		s.vrMenuOpen.set(false);
		return { inMic, afterBack, atRoot };
	});
	h.check(
		stack.inMic === 'mic' && stack.afterBack === 'system' && stack.atRoot === 'root',
		`Mic nests under System, Back pops one level (${stack.inMic}→${stack.afterBack}→${stack.atRoot})`
	);

	await h.finish(browser);
});
