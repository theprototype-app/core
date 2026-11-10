// profile-notify (owner 2026-11-09) — the regrouped profile menu, the Settings ▸ Account seam and the per-device
// notification switches (Settings ▸ Interface ▸ Notifications, src/lib/notifyPrefs.js).
//
//   1. three profile-menu opens send ZERO network requests (the signed-in half — no auth-refresh, no usage — is the
//      cloud repo's smoke-sign-in, which needs a PocketBase); the A rows: "You", Profile heading, "Edit profile…",
//      Peer ID + Copy
//   2. Settings ▸ Account exists only while a plugin mounts it (cloudApi.mountSettingsSection), and search finds it
//   3. Settings ▸ Interface ▸ Notifications: one row per core kind, the cloud kinds only with a plugin; search finds
//      "notifications" and each kind; the ping row links to Customize character
//   4. each switch REALLY gates its notification — OFF first (nothing), then ON (the counterfactual: it shows):
//      People leaving · Chat badge · Ping sounds · AI assistant · Auto quality; the People leaving switch is
//      pressed through the real Settings row
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const P = A.page;
	// count every oscillator the page makes: the ping chime is three of them
	await P.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__osc = 0;
		const orig = BaseAudioContext.prototype.createOscillator;
		BaseAudioContext.prototype.createOscillator = function () {
			w.__osc++;
			return orig.apply(this, arguments);
		};
	});
	const NP = '/src/lib/notifyPrefs.js';
	const setKind = (/** @type {string} */ k, /** @type {boolean} */ on) => P.evaluate(([np, kk, o]) => import(np).then((m) => m.setNotify(kk, o)), [NP, k, on]);
	const notes = () =>
		P.evaluate(() => {
			/** @type {string[]} */
			let out = [];
			/** @type {any} */ (window).__stores.notifications.subscribe((/** @type {any[]} */ v) => (out = v.map((n) => String(n.text))))();
			return out;
		});

	// ---- 1. the menu: no request on open -----------------------------------------------------------------------
	await P.keyboard.press('Escape');
	/** @type {string[]} */
	const sent = [];
	const origin = new URL(P.url()).origin;
	const onReq = (/** @type {any} */ r) => {
		const u = r.url();
		// the dev server's own module graph (a lazily imported component) is not a request the menu makes
		if (u.startsWith(origin) && /^\/(src|node_modules|@|\.svelte-kit)\//.test(u.slice(origin.length))) return;
		if (u.startsWith('data:') || u.startsWith('blob:')) return;
		sent.push(r.method() + ' ' + u);
	};
	await P.waitForTimeout(1500);
	P.on('request', onReq);
	for (let i = 0; i < 3; i++) {
		await P.locator('#avatar-trigger').dispatchEvent('mousedown');
		await P.waitForSelector('#avatar-dropdown', { timeout: 5000 });
		await P.waitForTimeout(900);
		await P.keyboard.press('Escape');
		await P.waitForTimeout(400);
	}
	P.off('request', onReq);
	h.check(sent.length === 0, `three profile-menu opens send no request (${JSON.stringify(sent).slice(0, 300)})`);

	await P.locator('#avatar-trigger').dispatchEvent('mousedown');
	await P.waitForSelector('#avatar-dropdown', { timeout: 5000 });
	const menu = await P.evaluate(() => {
		const d = document.querySelector('#avatar-dropdown');
		return {
			sub: d?.querySelector('.pm-sub')?.textContent?.trim(),
			group: d?.querySelector('.pm-group')?.textContent?.trim(),
			rows: [...(d?.querySelectorAll('.pm-card .nr-label') || [])].map((n) => n.textContent?.trim())
		};
	});
	h.check(menu.sub === 'You' && menu.group === 'Profile' && menu.rows.join('|') === 'Customize character|Edit profile…', `A: no plugin = "You", a Profile heading over Customize character · Edit profile… (${JSON.stringify(menu)})`);
	await P.locator('#avatar-dropdown').getByText('Edit profile…').click();
	await P.waitForSelector('#peer-id-copy', { timeout: 5000 });
	h.check((await P.locator('#peer-id-copy').count()) === 1, 'Edit profile: the Peer ID has a Copy button');
	await P.evaluate(() => /** @type {any} */ (window).__stores.profileSettingsOpen.set(false));

	// ---- 2. Settings ▸ Account: only while a plugin mounts it ------------------------------------------------
	const openSettings = (/** @type {string | null} */ section) =>
		P.evaluate((s) => {
			const S = /** @type {any} */ (window).__stores;
			S.settingsSection.set(s);
			S.settingsOpen.set(true);
		}, section);
	const search = (/** @type {string} */ q) => P.locator('input#settings-search').first().fill(q);
	const closeSettings = () => P.evaluate(() => /** @type {any} */ (window).__stores.settingsOpen.set(false));
	await openSettings(null);
	await P.waitForSelector('#settings-main', { timeout: 10000 });
	h.check((await P.locator('#settings-account').count()) === 0, 'no plugin: Settings has no Account page');
	await closeSettings();
	const seam = await P.evaluate(async () => {
		const S = /** @type {any} */ (window).__stores;
		const api = S.cloudPlugin.makeCloudApi();
		const bad = api.mountSettingsSection('nope', () => {});
		const ok = api.mountSettingsSection('account', (/** @type {HTMLElement} */ el) => {
			el.innerHTML =
				'<section class="tp-ui sec-card-wrap"><h3 data-section-label>Email</h3><div class="tp-ui setting-row" id="row-fake-updates"><span class="sr-name">Product updates</span></div></section>';
			return () => (el.innerHTML = '');
		});
		return { bad, ok };
	});
	h.check(seam.bad === false && seam.ok === true, 'mountSettingsSection accepts "account" and refuses an unknown key');
	await openSettings('account');
	await P.waitForSelector('#settings-account #row-fake-updates', { timeout: 10000 });
	h.check(true, 'with a plugin mount, Settings ▸ Account shows the plugin rows');
	await search('product updates');
	await P.waitForTimeout(600);
	h.check(
		(await P.locator('#row-fake-updates').isVisible()) && !(await P.locator('#row-notify-peerLeft').isVisible()),
		'Settings search finds the plugin\'s "Product updates" row (and filters the rest out)'
	);
	await search('');
	await closeSettings();
	await P.evaluate(() => /** @type {any} */ (window).__stores.cloudPlugin.makeCloudApi().mountSettingsSection('account', null));

	// ---- 3. the Notifications rows ------------------------------------------------------------------------------
	await openSettings('interface');
	await P.waitForSelector('#row-notify-peerLeft', { timeout: 10000 });
	const rows = await P.evaluate(() => [...document.querySelectorAll('[id^="row-notify-"]')].map((r) => r.id.slice('row-notify-'.length)).filter((id) => !id.endsWith('-desc')));
	h.check(rows.join(',') === 'peerLeft,chat,pingSound,agent,autoQuality', `Interface ▸ Notifications: the five core kinds, no cloud kinds without a plugin (${rows.join(',')})`);
	h.check((await P.locator('#notify-ping-character').count()) === 1, 'the Ping sounds row links to Customize character (its own picker), no second picker');
	const pingDesc = await P.locator('#row-notify-pingSound').innerText();
	h.check(/still shows\. Your own ping sound is in Customize character\./.test(pingDesc.replace(/\s+/g, ' ')), `the Ping sounds sentence reads cleanly (${pingDesc.replace(/\s+/g, ' ').slice(0, 160)})`);
	for (const [q, id] of [['notifications', 'row-notify-autoQuality'], ['ping sounds', 'row-notify-pingSound'], ['chat badge', 'row-notify-chat'], ['people leaving', 'row-notify-peerLeft'], ['ai assistant', 'row-notify-agent'], ['auto quality', 'row-notify-autoQuality']]) {
		await search(q);
		await P.waitForTimeout(500);
		const other = id === 'row-notify-chat' ? '#row-notify-pingSound' : '#row-notify-chat';
		const shown = await P.locator('#' + id).isVisible();
		const filtered = q === 'notifications' || !(await P.locator(other).isVisible());
		h.check(shown && filtered, `Settings search "${q}" finds #${id}${q === 'notifications' ? '' : ' and hides ' + other}`);
	}
	await search('');
	await P.waitForTimeout(300);

	// ---- 4a. People leaving, through the real switch -----------------------------------------------------------
	await P.locator('#notify-peerLeft').click();
	await P.waitForTimeout(200);
	const stored = await P.evaluate(() => localStorage.getItem('notifyPrefs'));
	h.check(stored === '{"peerLeft":false}', `the switch stores per device, only what is off (${stored})`);
	await closeSettings();
	const leave = async (/** @type {string} */ id) =>
		P.evaluate(async (pid) => {
			const S = /** @type {any} */ (window).__stores;
			S.userdata.update((/** @type {any[]} */ u) => [...u, [pid, 'Ann', '']]);
			await new Promise((r) => setTimeout(r, 50));
			S.commandsHandler.handleDisconnected(pid);
		}, id);
	await leave('PEEROFF');
	await P.waitForTimeout(300);
	h.check(!(await notes()).some((t) => /PEEROFF disconnected/.test(t)), 'People leaving OFF: no "disconnected" pop-up');
	await openSettings('interface');
	await P.waitForSelector('#notify-peerLeft', { timeout: 10000 });
	await P.locator('#notify-peerLeft').click();
	await closeSettings();
	await leave('PEERON');
	await P.waitForTimeout(300);
	h.check((await notes()).some((t) => /PEERON disconnected/.test(t)), 'People leaving ON (counterfactual): the pop-up shows');

	// ---- 4b. Chat badge ---------------------------------------------------------------------------------------
	const chat = (/** @type {string} */ id) =>
		P.evaluate((mid) => {
			const S = /** @type {any} */ (window).__stores;
			S.chatHidden.set('hidden');
			S.chatUnread.set(0);
			S.addMessage({ id: mid, message: 'hello', sender: 'Ann', type: 'received' });
			let n = 0;
			S.chatUnread.subscribe((/** @type {number} */ v) => (n = v))();
			return n;
		}, id);
	await setKind('chat', false);
	h.check((await chat('m-off')) === 0, 'Chat badge OFF: a message to a closed chat adds no unread count');
	await setKind('chat', true);
	h.check((await chat('m-on')) === 1, 'Chat badge ON (counterfactual): the count goes to 1');

	// ---- 4c. Ping sounds ----------------------------------------------------------------------------------------
	const ping = (/** @type {string} */ id, /** @type {string} */ peer) =>
		P.evaluate(
			async ([pid, who]) => {
				const w = /** @type {any} */ (window);
				w.__stores.audioEngine.ensureAudioContext();
				const before = w.__osc;
				w.__stores.ping.applyPing({ id: pid, peerId: who, name: 'Ann', pos: [0, 1, 0], sound: 'ding' }, who);
				await new Promise((r) => setTimeout(r, 100));
				let shown = false;
				w.__stores.ping.pings.subscribe((/** @type {any[]} */ l) => (shown = l.some((p) => p.id === pid)))();
				return { oscs: w.__osc - before, shown };
			},
			[id, peer]
		);
	await setKind('pingSound', false);
	const pOff = await ping('ping-off', 'PINGA');
	h.check(pOff.oscs === 0 && pOff.shown, `Ping sounds OFF: someone's ping draws its marker and plays no chime (${JSON.stringify(pOff)})`);
	await setKind('pingSound', true);
	const pOn = await ping('ping-on', 'PINGB');
	h.check(pOn.oscs > 0 && pOn.shown, `Ping sounds ON (counterfactual): the chime plays (${JSON.stringify(pOn)})`);

	// ---- 4d. AI assistant ---------------------------------------------------------------------------------------
	const agent = (/** @type {string} */ peer) =>
		P.evaluate(async (who) => {
			const S = /** @type {any} */ (window).__stores;
			S.aiAssistantHidden.set('hidden');
			S.agentLog.applyAgentLog(who, { entry: { peer: who, name: 'Bot ' + who, id: 'e-' + who, at: Date.now(), text: 'made a box', kind: 'step' } });
			await new Promise((r) => setTimeout(r, 100));
			let seen = false;
			S.notifications.subscribe((/** @type {any[]} */ v) => (seen = v.some((n) => String(n.text).startsWith('Bot ' + who + ' is building'))))();
			return seen;
		}, peer);
	await setKind('agent', false);
	h.check((await agent('agentoff')) === false, 'AI assistant OFF: an agent starting to build shows no pop-up');
	await setKind('agent', true);
	h.check((await agent('agenton')) === true, 'AI assistant ON (counterfactual): "… is building in this session" shows');

	// ---- 4e. Auto quality ---------------------------------------------------------------------------------------
	const drop = () =>
		P.evaluate(async () => {
			const w = /** @type {any} */ (window);
			const Q = w.__stores.qualityGovernor;
			const g = Q.governorForTest;
			try {
				sessionStorage.removeItem('quality:announced');
			} catch {}
			w.__pnT = (w.__pnT || 1e9) + 1e6;
			g.setLevel(0, w.__pnT);
			await new Promise((r) => setTimeout(r, 700)); // the reset's own publish settles (BATCH_MS 400)
			w.__stores.toastStore.set([]);
			// an empty scene is never governed (the light-scene exemption): read as a heavy one for the drive, which is
			// synchronous, so the real sampler cannot write between these frames
			const SB = await import('/src/lib/sceneBudget.js');
			SB.sceneMetrics.set({ at: Date.now(), profile: 'desktop', objects: 5000, triangles: 2e7, calls: 5000 });
			let moved = 0;
			let next = w.__pnT + 250;
			// every third frame slow (the auto-quality-notice driver), a decision every 250 ms, until two steps down
			for (let i = 0; i < 6000 && moved < 2; i++) {
				const ms = i % 3 === 0 ? 40 : 16.7;
				w.__pnT += ms;
				g.frame(ms, w.__pnT);
				if (w.__pnT >= next) {
					next = w.__pnT + 250;
					if (Q.decideNow(w.__pnT).moved) moved++;
					g.clearFlapLock?.();
				}
			}
			await new Promise((r) => setTimeout(r, 1200)); // BATCH_MS + the flush
			let card = false;
			w.__stores.toastStore.subscribe((/** @type {any[]} */ l) => (card = l.some((e) => e && typeof e === 'object' && e.id === 'auto-quality')))();
			let reason = '';
			Q.qualityState.subscribe((/** @type {any} */ v) => (reason = v.reason))();
			return { moved, card, reason, level: g.level?.() };
		});
	await setKind('autoQuality', false);
	const qOff = await drop();
	h.check(qOff.moved > 0, `premise: the governor lowered the quality by itself (${JSON.stringify(qOff)})`);
	h.check(!qOff.card, 'Auto quality OFF: the quality drops with no pop-up');
	await setKind('autoQuality', true);
	const qOn = await drop();
	h.check(qOn.moved > 0 && qOn.card, `Auto quality ON (counterfactual): the "Lowered …" card shows (${JSON.stringify(qOn)})`);
	await P.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__stores.qualityGovernor.governorForTest.setLevel(0, (w.__pnT || 1e9) + 1e6);
	});

	// ---- reset: "Reset Interface" turns every switch back on ------------------------------------------------------
	await setKind('chat', false);
	const after = await P.evaluate(async () => {
		const m = await import('/src/lib/settings/resetCategory.js');
		m.resetCategory('interface');
		await new Promise((r) => setTimeout(r, 100));
		return localStorage.getItem('notifyPrefs');
	});
	h.check(after === null, `Reset Interface puts every notification switch back on (stored: ${after})`);

	await h.finish(browser);
});
