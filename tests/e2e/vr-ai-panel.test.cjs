// 36-vr-ai (plan F1): the VR AI chat panel. Tools ▸ AI opens it; it renders the SAME aiMessages thread as
// the desktop AI Assistant window (no VR-side settings); its input row opens the VR keyboard whose commit
// runs the prompt through a MOCKED OpenAI-compatible provider; STOP aborts a run; the vrai-* controls are
// reachable by the controller ray (raycast, trigger hook, beam end, grip window); leaving VR closes it.
// The feel in a headset is the user's check.
const h = require('./helpers.cjs');

const ev = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const answer = (text) =>
	ev({ choices: [{ delta: { content: text } }] }) + ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';

const read = (page, fn, arg) => page.evaluate(fn, arg);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const base = new URL(A.page.url()).origin + '/mock-ai/v1';

	// the mocked provider: a prompt containing "slow" answers after 4 s (so STOP has a run to abort)
	await A.page.route('**/mock-ai/v1/chat/completions', async (route) => {
		const body = route.request().postData() || '';
		if (body.includes('slow please')) await new Promise((r) => setTimeout(r, 4000));
		await route
			.fulfill({ status: 200, contentType: 'text/event-stream', body: answer('Hello from the mock.') })
			.catch(() => {});
	});

	// --- 1. the radial entry: Tools ▸ AI with the sparkles icon ---
	const entry = await read(A.page, () => {
		const ring = window.__stores.vrRadialMenu.ringEntries('tools');
		const ai = ring.find((e) => e.id === 'ai');
		return { found: !!ai, icon: ai?.icon, label: typeof ai?.label === 'function' ? ai.label() : ai?.label, ids: ring.map((e) => e.id) };
	});
	h.check(entry.found && entry.icon === 'sparkles' && entry.label === 'AI', `Tools ring has AI with the sparkles icon (${entry.ids.join(',')})`);

	// --- 2. opening it: the ring closes, the panel opens, sibling panels give way (and the other way round) ---
	const open = await read(A.page, () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.vrChatPanelOpen.set(true);
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('ai');
		const afterAi = { ai: get(s.vrAiPanelOpen), chat: get(s.vrChatPanelOpen), menu: get(s.vrMenuOpen) };
		s.vrControls.executeVRMenuAction('chat');
		const afterChat = { ai: get(s.vrAiPanelOpen), chat: get(s.vrChatPanelOpen) };
		s.vrChatPanelOpen.set(false);
		s.vrControls.executeVRMenuAction('ai');
		return { afterAi, afterChat, reopened: get(s.vrAiPanelOpen), windows: s.vrControls.vrWindowIds() };
	});
	h.check(open.afterAi.ai && !open.afterAi.chat && !open.afterAi.menu, 'AI opens the panel, closes the ring and the chat panel');
	h.check(!open.afterChat.ai && open.afterChat.chat, 'opening the chat panel closes the AI panel');
	h.check(open.reopened, 'the AI sector opens it again');
	h.check(open.windows.includes('ai'), 'the panel is a grip-movable VR window (id ai)');

	// --- 3. unconfigured: a hint, and the input row does NOT open the keyboard ---
	await A.page.waitForTimeout(400);
	const bare = await read(A.page, () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.vrControls.executeVRMenuAction('ai:input');
		return { ready: get(s.vrAiPanel.vrAiReady), keyboard: !!get(s.vrKeyboard.vrKeyboardTarget) };
	});
	h.check(!bare.ready && !bare.keyboard, 'with no provider the input row stays shut (the panel shows the Settings hint)');

	// --- 4. configured: the keyboard commit runs the prompt; the thread is the desktop one ---
	await read(A.page, (b) => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: b, apiKey: 'k', model: 'mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	}, base);
	const typed = await read(A.page, () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.vrControls.executeVRMenuAction('ai:input');
		const target = get(s.vrKeyboard.vrKeyboardTarget);
		['h', 'i'].forEach((k) => s.vrKeyboard.pressVRKey(k));
		s.vrKeyboard.pressVRKey('enter');
		return { ready: get(s.vrAiPanel.vrAiReady), title: target?.title };
	});
	h.check(typed.ready && typed.title === 'Ask AI', `configured: the input row opens the keyboard titled Ask AI (${typed.title})`);
	await A.page.waitForFunction(() => {
		let v;
		window.__stores.aiAssistant.aiMessages.subscribe((x) => (v = x))();
		return v.some((m) => m.role === 'assistant' && /mock/.test(m.content) && !m.streaming);
	}, null, { timeout: 15000 });
	const thread = await read(A.page, () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		return { shared: get(s.aiAssistant.aiMessages), mirror: get(s.vrAiPanel.vrAiMessages) };
	});
	h.check(thread.shared[0]?.role === 'user' && thread.shared[0]?.content === 'hi', 'the prompt typed in VR lands in the shared thread');
	h.check(JSON.stringify(thread.mirror) === JSON.stringify(thread.shared), 'the panel shows exactly the shared thread');
	// the desktop window renders the same turn
	await read(A.page, () => window.__stores.aiAssistantHidden.set(''));
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#ai-assistant-window').getByText('Hello from the mock.').isVisible(), 'the desktop AI window shows the answer given in VR');
	await read(A.page, () => window.__stores.aiAssistantHidden.set('hidden'));

	// --- 5. the rendered controls, STOP while busy ---
	const slow = await read(A.page, async () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.vrControls.executeVRMenuAction('ai:input');
		'slow please'.split('').forEach((k) => s.vrKeyboard.pressVRKey(k === ' ' ? 'space' : k));
		s.vrKeyboard.pressVRKey('enter');
		await new Promise((r) => setTimeout(r, 500));
		const scene = get(s.globalScene);
		const names = [];
		scene?.getObjectByName('vr-ai-panel')?.traverse((o) => o.name?.startsWith('vrai-') && names.push(o.name));
		const busy = get(s.vrAiPanel.vrAiBusy);
		s.vrControls.executeVRMenuAction('ai:input'); // busy: must NOT open the keyboard
		const keyboardWhileBusy = !!get(s.vrKeyboard.vrKeyboardTarget);
		s.vrControls.executeVRMenuAction('ai:stop');
		await new Promise((r) => setTimeout(r, 400));
		const last = get(s.aiAssistant.aiMessages).slice(-1)[0];
		return { names, busy, keyboardWhileBusy, busyAfter: get(s.vrAiPanel.vrAiBusy), last };
	});
	h.check(['vrai-close', 'vrai-input', 'vrai-stop'].every((n) => slow.names.includes(n)), `the panel renders close, input and (busy) stop (${slow.names.join(',')})`);
	h.check(slow.busy && !slow.keyboardWhileBusy, 'while a run is in flight the input row stays shut');
	h.check(!slow.busyAfter && slow.last?.role === 'error' && /Cancel/.test(slow.last?.content), `STOP aborts the run (${slow.last?.content})`);

	// --- 6. the controller ray: raycast, the trigger hook, the beam ---
	const ray = await read(A.page, () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		const panel = get(s.globalScene).getObjectByName('vr-ai-panel');
		panel.updateMatrixWorld(true);
		const close = panel.getObjectByName('vrai-close');
		const at = close.getWorldPosition(new THREE.Vector3());
		const c = r.xr.getController(0);
		c.matrixAutoUpdate = true;
		c.position.set(at.x, at.y, at.z + 0.6);
		c.quaternion.identity();
		c.updateMatrixWorld(true);
		const picked = s.vrAiPanel.raycastAi(0);
		const probe = new THREE.Raycaster();
		probe.ray.origin.copy(c.position);
		probe.ray.direction.set(0, 0, -1);
		const beam = s.vrControls.beamTarget(probe);
		// the trigger PRESS on close: the hook takes it, swallows the click that follows, the panel shuts
		const took = s.vrControls.vrModuleTriggerStart(0);
		const swallowed = s.vrControls.vrModuleSelectSwallowed();
		const swallowedTwice = s.vrControls.vrModuleSelectSwallowed();
		s.vrControls.vrModuleTriggerEnd(0);
		const closedByTrigger = !get(s.vrAiPanelOpen);
		// a press that misses the panel is not taken
		s.vrControls.executeVRMenuAction('ai');
		c.position.set(at.x + 5, at.y, at.z + 0.6);
		c.updateMatrixWorld(true);
		const missTaken = s.vrControls.vrModuleTriggerStart(0);
		s.vrControls.vrModuleTriggerEnd(0);
		return { picked, beamPanel: beam.panel, beamName: beam.info?.object?.name, took, swallowed, swallowedTwice, closedByTrigger, missTaken };
	});
	h.check(ray.picked === 'ai:close', `raycastAi resolves the pointed control (${ray.picked})`);
	h.check(ray.beamPanel, `the beam ends on the AI panel (${ray.beamName})`);
	h.check(ray.took && ray.swallowed && !ray.swallowedTwice && ray.closedByTrigger, 'a trigger press on close is taken, its click swallowed once, the panel shuts');
	h.check(!ray.missTaken, 'a trigger press beside the panel is left alone');

	// --- 7. leaving VR closes it ---
	const session = await read(A.page, () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.isVRMode.set(true);
		s.vrAiPanelOpen.set(true);
		s.isVRMode.set(false);
		return get(s.vrAiPanelOpen);
	});
	h.check(session === false, 'ending the VR session closes the AI panel');

	await h.finish(browser);
});
