// 86-fix N1 — THE AI WINDOW ALWAYS OPENS. With no AI provider set up the AI button used to toast and jump to
// Settings ▸ AI, so Connect Claude (which needs no provider) could not be reached. Now:
//
//   OSS (no connector): the button opens the window on a welcome with one choice — your own provider
//   (Open settings ▸ AI); no Connect Claude anywhere. The quick prompt bar (`) keeps its provider toast.
//   cloud, signed out: the first choice carries "Sign in to connect", which opens the top-right profile pop-up
//   (FW-AI, roadmap 76: no login buttons in this window); signing in swaps it for Connect Claude IN THE SAME
//   WINDOW; Connect → the connected state + Disconnect. A provider set up + signed out: the button in the header.
//   axe on the welcome; the OPPO Find N6 folded / unfolded (dark + light), screenshots for the docs.
//
// Run: APP_URL='https://theprototype.app:5890/' npm run e2e -- connector-window
const path = require('path');
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

const OUT = process.env.E2E_OUT || 'test-results/86-fix';

async function axe(page, include, label) {
	const res = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	for (const v of res.violations) console.log(`  [${label}] ${v.impact} ${v.id} (${v.nodes.length}) — ${v.help}`);
	h.check(gated.length === 0, `${label}: no serious/critical axe violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
}

const read = (page, name) => page.evaluate((n) => new Promise((r) => window.__stores[n].subscribe((v) => r(v))()), name);

/** signed out on a cloud build, faked: the plugin's flag + its account section in the profile pop-up */
async function installSignIn(page) {
	await page.evaluate(() => {
		window.__stores.cloudHooks.connectorSignInSlot.set(() => () => {});
		window.__stores.cloudHooks.profileSlot.set((el) => {
			const b = document.createElement('button');
			b.id = 'fake-cloud-signin';
			b.textContent = 'Sign in to cloud';
			el.append(b);
			return () => b.remove();
		});
	});
}

/** press it, expect the profile pop-up with focus on the account section's button, then close the pop-up */
async function pressOpensProfile(page, sel, label) {
	h.check((await page.locator('#avatar-dropdown').count()) === 0, `${label}: the profile pop-up starts closed`);
	await page.locator(sel).click();
	await page.locator('#avatar-dropdown').waitFor({ state: 'visible', timeout: 10000 });
	h.check(await page.locator('#avatar-dropdown #fake-cloud-signin').isVisible(), `${label}: the press opens the profile pop-up, with the sign-in in it`);
	await page.waitForFunction(() => document.activeElement?.id === 'fake-cloud-signin', null, { timeout: 5000 }).catch(() => {});
	h.check((await page.evaluate(() => document.activeElement?.id)) === 'fake-cloud-signin', `${label}: focus lands on the sign-in`);
	h.check((await page.evaluate(() => document.querySelectorAll('#ai-assistant-window #fake-cloud-signin').length)) === 0, `${label}: no login buttons inside the AI window`);
	await page.keyboard.press('Escape');
	await page.locator('#avatar-dropdown').waitFor({ state: 'detached', timeout: 5000 });
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.toastsInDrawerOnly.set(true));

	// ---- OSS: the button opens the window on the welcome -------------------------------------------
	h.check(!(await A.page.evaluate(() => window.__stores.aiProviders.aiReady())), 'no AI provider is set up');
	await A.page.locator('#ai-hud-button').first().click();
	await A.page.locator('#ai-assistant-window').waitFor({ state: 'visible', timeout: 10000 });
	h.check((await read(A.page, 'settingsOpen')) !== true, 'the AI button opened the window, not Settings');
	h.check(await A.page.locator('#ai-welcome').isVisible(), 'the window shows the welcome');
	h.check((await A.page.locator('#connect-claude').count()) === 0, 'OSS: no Connect Claude choice');
	h.check(await A.page.locator('#ai-welcome-own').isVisible(), 'the "Use your own AI provider" choice is there');
	await A.page.locator('#ai-welcome-settings').click();
	h.check((await read(A.page, 'settingsOpen')) === true && (await read(A.page, 'settingsSection')) === 'tools', 'Open settings goes to Tools & connections');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));

	// the prompt bar keeps the provider toast (it is a prompt, not the window)
	// a viewport shortcut: the window closed and nothing focused (a press inside a window is not the viewport's)
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('');
		window.__stores.aiAssistantHidden.set('hidden');
		/** @type {any} */ (document.activeElement)?.blur?.();
	});
	await A.page.keyboard.press('Backquote');
	await A.page.waitForTimeout(300);
	h.check((await read(A.page, 'aiPromptBarOpen')) !== true && (await read(A.page, 'settingsSection')) === 'tools', 'the ` prompt bar still points at Tools & connections with no provider');
	await A.page.evaluate(() => {
		window.__stores.settingsOpen.set(false);
		window.__stores.aiAssistantHidden.set('');
	});

	// ---- cloud, signed out: Sign in to connect --------------------------------------------------------
	await installSignIn(A.page);
	const signIn = A.page.locator('#ai-welcome #connect-claude #connect-claude-signin');
	await signIn.waitFor({ state: 'visible', timeout: 10000 });
	h.check(true, 'signed out: the first choice offers Sign in to connect');
	h.check(/Connect Claude/.test((await A.page.locator('#connect-claude-title').textContent()) ?? '') && /no API key/.test((await A.page.locator('#connect-claude .cc-desc').textContent()) ?? ''), 'the choice says what it is: Connect Claude, your Claude account, no API key');
	h.check(/profile, top right/.test((await A.page.locator('#connect-claude .cc-text').textContent()) ?? ''), 'the window says to sign in from the profile, top right');
	// 78 PL10: one wording: signed out, step 2 names the button the user sees (Sign in to connect), not Connect Claude
	const step2Out = (await A.page.locator('#connect-claude-step-2').textContent()) ?? '';
	h.check(/press Sign in to connect/.test(step2Out) && !/press Connect Claude here/.test(step2Out), `signed out: step 2 names the Sign in to connect button (${step2Out.trim().slice(0, 90)})`);
	h.check((await A.page.locator('#ai-header-signin').count()) === 0, 'the welcome carries the button: none in the header too');
	await pressOpensProfile(A.page, '#connect-claude-signin', 'welcome');
	h.check((await read(A.page, 'aiAssistantHidden')) === '', 'on a desktop the AI window stays open behind the pop-up');
	await axe(A.page, '#ai-welcome', 'AI welcome (signed out)');
	await A.page.screenshot({ path: path.join(OUT, 'n1-signed-out.png') }).catch(() => {});

	// "signing in": the plugin removes the mount and installs the provider — the window stays, the button appears
	const relay = await fakeRelay(A.page);
	await A.page.evaluate(() => window.__stores.cloudHooks.connectorSignInSlot.set(null));
	await installProvider(A.page);
	const button = A.page.locator('#ai-welcome #connect-claude-button');
	await button.waitFor({ state: 'visible', timeout: 10000 });
	h.check((await read(A.page, 'aiAssistantHidden')) === '' && (await A.page.locator('#connect-claude-signin').count()) === 0, 'after sign-in the same window shows Connect Claude');
	h.check((await A.page.locator('#connect-claude').count()) === 1, 'one Connect Claude control (the top row stands down while the welcome shows)');
	// the claude.ai half: two short steps, the link one press away
	const step1 = (await A.page.locator('#connect-claude-step-1').textContent()) ?? '';
	h.check(/Add theprototype to Claude/.test(step1) && /Add custom connector/.test(step1) && step1.includes('https://theprototype.app/mcp'), `step 1 shows both ways (${step1.trim().slice(0, 90)})`);
	const add = A.page.locator('#connect-claude-add');
	h.check((await add.getAttribute('href')) === 'https://claude.ai/directory/connectors/theprototype' && (await add.getAttribute('target')) === '_blank' && /Add to Claude/.test((await add.textContent()) ?? ''), 'Add to Claude opens the directory in a new tab');
	const addBox = await add.boundingBox();
	const manualBox = await A.page.locator('#connect-claude-step-1 .cc-address').boundingBox();
	h.check(!!addBox && !!manualBox && addBox.y + addBox.height <= manualBox.y, 'the button comes first, the manual way under it');
	const how = A.page.locator('#connect-claude-how');
	h.check((await how.getAttribute('href')) === 'https://docs.theprototype.app/ai/claude-connector/' && /How it works/.test((await how.textContent()) ?? ''), 'step 1 has the How it works link');
	await A.page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
	const copy = A.page.locator('#connect-claude-copy');
	h.check((await copy.getAttribute('aria-label')) === 'Copy connector address' && !(((await copy.textContent()) ?? '').trim()), 'the copy button is icon-only with an accessible name');
	h.check((await A.page.locator('#connect-claude-copy-link, #connect-claude-step-1 button:has-text("Copy link")').count()) === 0, 'the old Copy link text button is gone');
	const copyIcon = () => copy.locator('svg').getAttribute('class');
	const iconBefore = await copyIcon();
	await copy.click();
	h.check((await A.page.evaluate(() => navigator.clipboard.readText().catch(() => ''))) === 'https://theprototype.app/mcp', 'copy puts the address on the clipboard');
	h.check((await copyIcon()) !== iconBefore, 'the icon turns to a check');
	h.check((await A.page.locator('#connect-claude-step-1 [role="status"]').textContent()) === 'Copied', 'a polite live region says Copied');
	await A.page.waitForFunction((b) => document.querySelector('#connect-claude-copy svg')?.getAttribute('class') === b, iconBefore, { timeout: 4000 }).catch(() => {});
	h.check((await copyIcon()) === iconBefore && !(await A.page.locator('#connect-claude-step-1 [role="status"]').textContent()), 'after 2 s it turns back');
	h.check(/press Connect Claude here/.test((await A.page.locator('#connect-claude-step-2').textContent()) ?? ''), 'step 2 says to press Connect Claude here');
	await axe(A.page, '#ai-welcome', 'AI welcome (signed in)');
	await A.page.screenshot({ path: path.join(OUT, 'n1-welcome.png') }).catch(() => {});

	// ---- Connect → the connected state + Disconnect, in the window ----------------------------------
	await button.click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 15000);
	h.check(relay.frames.some((x) => x.f.type === 'hello'), 'the tab paired with the relay');
	const text = (await A.page.locator('#ai-welcome #connect-claude .cc-text').textContent()) ?? '';
	h.check(/Claude connected/.test(text) && (await A.page.locator('#ai-welcome #connect-claude-disconnect').isVisible()), `the window shows the connected state + Disconnect (${text.trim()})`);
	await axe(A.page, '#ai-welcome', 'AI welcome (connected)');
	await A.page.screenshot({ path: path.join(OUT, 'n1-connected.png') }).catch(() => {});
	await A.page.locator('#connect-claude-disconnect').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'idle', 'idle again', 10000);
	h.check((await connectorPhase(A)) === 'idle' && (await button.isVisible()), 'Disconnect → Connect Claude again');

	// ---- a provider set up: the welcome stands down, the old row returns ------------------------------
	await A.page.evaluate(() => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: 'https://127.0.0.1:9/v1', apiKey: 'x', model: 'mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	});
	await A.page.locator('#ai-welcome').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
	h.check((await A.page.locator('#ai-welcome').count()) === 0 && (await A.page.locator('#ai-assistant-window #connect-claude-button').isVisible()), 'with a provider: no welcome, Connect Claude in its top row');
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);

	// ---- FW-AI: a local model, signed out: the assistant works, "Sign in to connect" sits in the header ---
	await A.page.evaluate(() => {
		window.__stores.cloudHooks.setConnectorProvider(null);
		window.__stores.cloudHooks.connectorSignInSlot.set(() => () => {});
	});
	const headerBtn = A.page.locator('#ai-assistant-window #ai-header-signin');
	await headerBtn.waitFor({ state: 'visible', timeout: 10000 });
	h.check((await A.page.locator('#ai-welcome').count()) === 0 && (await A.page.locator('#connect-claude').count()) === 0, 'local model + signed out: no welcome and no Connect row, the header button is there');
	const headBox = await A.page.locator('#ai-assistant-window .ui-panel-header').boundingBox();
	const btnBox = await headerBtn.boundingBox();
	h.check(!!headBox && !!btnBox && btnBox.y >= headBox.y - 1 && btnBox.y + btnBox.height <= headBox.y + headBox.height + 1, `the button is in the window's header (${JSON.stringify(btnBox)} in ${JSON.stringify(headBox)})`);
	h.check((await A.page.locator('#ai-assistant-window textarea, #ai-assistant-window input[type="text"]').first().isEnabled()), 'the composer works: nothing waits for a sign-in');
	await pressOpensProfile(A.page, '#ai-header-signin', 'header');
	await axe(A.page, '#ai-assistant-window', 'AI window (local model, signed out)');
	await A.page.screenshot({ path: path.join(OUT, 'fw-ai-header.png') }).catch(() => {});
	// signing in: the plugin clears the flag and installs the provider
	await A.page.evaluate(() => window.__stores.cloudHooks.connectorSignInSlot.set(null));
	await installProvider(A.page);
	await headerBtn.waitFor({ state: 'detached', timeout: 10000 });
	h.check((await A.page.locator('#ai-assistant-window #connect-claude-button').isVisible()), 'signed in: no sign-in button, Connect Claude in its top row');
	h.check(h.pageErrors(A).length === 0, `no page errors after FW-AI (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.closePeer(A);

	// ---- the OPPO Find N6, folded and unfolded ---------------------------------------------------------
	for (const [name, viewport, theme] of [
		['folded', { width: 390, height: 896 }, 'dark'],
		['unfolded', { width: 770, height: 850 }, 'dark'],
		['unfolded-light', { width: 770, height: 850 }, 'light']
	]) {
		const P = await h.setupPage(browser, name, { context: { viewport, deviceScaleFactor: 2.9, isMobile: true, hasTouch: true }, storage: { theme } });
		await installProvider(P.page);
		await P.page.evaluate(() => {
			window.__stores.toastsInDrawerOnly.set(true);
			window.__stores.aiAssistantHidden.set('');
		});
		const b = P.page.locator('#ai-welcome #connect-claude-button');
		await b.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
		const fits = async (sel) => {
			await P.page.locator(sel).scrollIntoViewIfNeeded().catch(() => {});
			const box = await P.page.locator(sel).boundingBox();
			const hit = box ? await P.page.evaluate(([x, y, s]) => !!document.elementFromPoint(x, y)?.closest(s), [box.x + box.width / 2, box.y + box.height / 2, sel]) : false;
			return { ok: !!box && box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height && box.height >= 32 && hit, box, hit };
		};
		// 54i x: the whole welcome fits, no inner scroll — the own-provider card included (the folded sheet opens
		// at full height, the floating window grows to its content)
		await P.page.waitForTimeout(600); // the sheet's height transition / the window's re-clamp
		const fit = await P.page.evaluate(() => {
			const win = document.querySelector('#ai-assistant-window');
			// 78 PL23: on the folded phone the AI assistant is a phone DOCK TAB at the dock's height (not a full-height
			// sheet), so the welcome may scroll there; the own-provider card must still be reachable inside the window
			const docked = win.getAttribute('data-pd-host') === 'shown';
			if (docked) document.querySelector('#ai-welcome-own')?.scrollIntoView({ block: 'nearest' });
			const sc = document.querySelector('#ai-welcome')?.closest('.overflow-y-auto');
			const w = win.getBoundingClientRect();
			const own = document.querySelector('#ai-welcome-own').getBoundingClientRect();
			return { docked, sh: sc?.scrollHeight, ch: sc?.clientHeight, ownB: Math.round(own.bottom), winB: Math.round(w.bottom), vh: innerHeight };
		});
		h.check((fit.docked || fit.sh <= fit.ch + 1) && fit.ownB <= fit.winB + 1 && fit.winB <= fit.vh, `N6 ${name}: the welcome fits without an inner scroll (a phone dock tab: scrolls inside the dock), own provider card in view (${JSON.stringify(fit)})`);
		// 54i f: no window header under the top chrome (the bell cluster, the profile circle, the Connect bar);
		// the Debugger stands for every toolbox that opens at the top right
		await P.page.evaluate(() => window.__stores.flowDebug.setDebugOpen(true));
		await P.page.locator('#flow-debugger').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
		await P.page.waitForTimeout(300);
		const under = await P.page.evaluate(() => {
			const R = (el) => el?.getBoundingClientRect();
			const chrome = ['#hud-tr', '#avatar-trigger', '.connect-pill'].map((s) => [s, R(document.querySelector(s))]).filter(([, r]) => r && r.width && r.height);
			const out = [];
			for (const sel of ['#ai-assistant-window', '#flow-debugger']) {
				const el = document.querySelector(sel);
				if (!el || el.closest('[data-ps-host]') || el.hasAttribute('data-ps-host') || el.classList.contains('tbx-sheet')) continue; // a phone sheet is placed by the shell
				const w = R(el);
				for (const [c, r] of chrome) if (w.left < r.right && w.right > r.left && w.top < r.bottom && w.bottom > r.top) out.push(`${sel} top ${Math.round(w.top)} under ${c} (bottom ${Math.round(r.bottom)})`);
			}
			return out;
		});
		h.check(under.length === 0, `N6 ${name}: no window header under the top chrome (${under.join('; ') || 'none'})`);
		await P.page.evaluate(() => window.__stores.flowDebug.setDebugOpen(false));
		const c = await fits('#connect-claude-button');
		const o = await fits('#ai-welcome-settings');
		h.check(c.ok && o.ok, `N6 ${name}: both choices are on screen and pressable (${JSON.stringify(c.box)} ${JSON.stringify(o.box)}, hit ${c.hit}/${o.hit})`);
		if (name === 'unfolded-light') await axe(P.page, '#ai-welcome', 'AI welcome (light)');
		await P.page.screenshot({ path: path.join(OUT, `n1-n6-${name}.png`) }).catch(() => {});
		// step 1 at this width: no sideways overflow, the copy icon is a 44 px touch target
		const copyFit = await fits('#connect-claude-copy');
		const addFit = await fits('#connect-claude-add');
		const card = await P.page.evaluate(() => { const c = document.querySelector('#connect-claude'); return { sw: c.scrollWidth, cw: c.clientWidth }; });
		h.check(copyFit.ok && addFit.ok && card.sw <= card.cw && copyFit.box.width >= 44 && copyFit.box.height >= 44, `N6 ${name}: step 1 fits, copy is 44 px (${JSON.stringify(copyFit.box)}, card ${card.sw}/${card.cw})`);
		// FW-AI: signed out with a provider, the header button fits; on the phone the AI sheet steps aside for the profile sheet
		await P.page.evaluate(() => {
			window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: 'https://127.0.0.1:9/v1', apiKey: 'x', model: 'mock' });
			window.__stores.aiProviders.setAiEnabled(true);
			window.__stores.cloudHooks.setConnectorProvider(null);
		});
		await installSignIn(P.page);
		await P.page.locator('#ai-header-signin').waitFor({ state: 'visible', timeout: 10000 });
		const hb = await fits('#ai-header-signin');
		// 54i: the title keeps its words beside the button (the folded sheet says "Sign in")
		const title = await P.page.evaluate(() => {
			const t = document.querySelector('#ai-assistant-window .wc-title');
			const b = document.querySelector('#ai-header-signin');
			return { sw: t.scrollWidth, cw: t.clientWidth, text: t.textContent.trim(), name: b.getAttribute('aria-label') || b.textContent.trim() };
		});
		h.check(title.sw <= title.cw && title.name === 'Sign in to connect', `N6 ${name}: the header title is not cut short and the button keeps its name (${JSON.stringify(title)})`);
		const closeFits = await fits('#ai-assistant-window .wc-close');
		h.check(hb.ok && closeFits.hit && closeFits.box.x + closeFits.box.width <= viewport.width, `N6 ${name}: the header button fits and the close button stays on screen and pressable (${JSON.stringify(hb.box)}, hit ${hb.hit}/${closeFits.hit})`);
		await P.page.screenshot({ path: path.join(OUT, `fw-ai-n6-${name}.png`) }).catch(() => {});
		await P.page.locator('#ai-header-signin').click();
		await P.page.locator('#avatar-dropdown #fake-cloud-signin').waitFor({ state: 'visible', timeout: 10000 });
		const prof = await fits('#fake-cloud-signin');
		h.check(prof.hit, `N6 ${name}: the profile pop-up opens in front (${JSON.stringify(prof.box)})`);
		await P.page.screenshot({ path: path.join(OUT, `fw-ai-n6-${name}-profile.png`) }).catch(() => {});
		await h.closePeer(P);
	}

	await h.finish(browser);
});
