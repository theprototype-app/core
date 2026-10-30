// fix-batch-2 (1.45.1): AI connection setup against a mock OpenAI server (mockOpenAi.cjs — no
// GPU, no real keys). Drives Settings ▸ AI ▸ Add provider like a user: a base URL typed with no
// scheme and a pasted /chat/completions tail, then Test connection, through each failure mode.
// Counterfactuals on 1.45.0: §1 (no "Will call", the scheme-less URL fails to fetch), §3 (a
// raw "Request failed (400)"), §4 (always "CORS … vLLM"), §6 ("Testing…" forever), §7 (no hint).
const h = require('./helpers.cjs');
const { startMockOpenAi } = require('./mockOpenAi.cjs');

h.run(async () => {
	const mock = await startMockOpenAi();
	// a port nothing listens on (the network case)
	const closed = await startMockOpenAi();
	const closedPort = closed.port;
	await closed.close();

	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	const openForm = async () => {
		await page.evaluate(() => {
			window.__stores.settingsSection.set('ai');
			window.__stores.settingsOpen.set(true);
		});
		await page.locator('#ai-add-provider').first().click({ timeout: 15000 });
		await page.locator('#ai-form-preset').selectOption('custom');
		await page.waitForTimeout(200);
	};
	/** fill the form and press Test; returns {text, ms} */
	const test = async (base, model = 'mock-model') => {
		await page.locator('#ai-form-base').fill(base);
		await page.locator('#ai-model-input').fill(model);
		// close the model list without a key (Escape would close Settings)
		await page.locator('#ai-model-input').evaluate((el) => el.blur());
		await page.waitForTimeout(250);
		if (!(await page.locator('#ai-form-test').count()))
			console.log('DIAG settings', await page.evaluate(() => document.querySelector('[role=dialog]')?.textContent?.slice(0, 400)));
		const t0 = Date.now();
		await page.locator('#ai-form-test').click();
		await page.locator('#ai-form-test', { hasText: 'Test connection' }).waitFor({ timeout: 25000 });
		const text = ((await page.locator('#ai-test-result').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
		return { text, ms: Date.now() - t0 };
	};

	await openForm();

	// §1 B1: no scheme + a pasted endpoint tail -> https, the tail stripped, shown under the field
	await page.locator('#ai-form-base').fill(mock.bare('ok') + '/chat/completions');
	const willCall = ((await page.locator('#ai-will-call').textContent().catch(() => '')) || '').trim();
	h.check(willCall === 'Will call ' + mock.base('ok') + '/chat/completions', `§1 "Will call" shows the resolved address (${willCall})`);
	let r = await test(mock.bare('ok') + '/chat/completions');
	h.check(/Configuration OK/.test(r.text), `§1 a scheme-less URL with a pasted tail connects (${r.text})`);
	h.check(mock.requests.some((q) => q.mode === 'ok' && q.path === '/v1/models'), '§1 the app called <base>/v1/models');

	// §2 B6 + B3: a model the server does not list -> the completion probe decides, WITHOUT
	// max_tokens, and its reason is shown (it used to be thrown away)
	r = await test(mock.bare('unknownmodel'), 'mock-model');
	h.check(/did not respond/.test(r.text) && /Unknown model/.test(r.text) && /served-model-name/.test(r.text), `§2 the probe's reason is shown (${r.text})`);
	const probe = mock.requests.filter((q) => q.mode === 'unknownmodel' && q.path === '/v1/chat/completions' && q.method === 'POST').pop();
	h.check(!!probe && !('max_tokens' in (probe.body || {})) && !('max_completion_tokens' in (probe.body || {})), '§2 the probe sends no max_tokens');

	// §3 B3: Google's 400 API_KEY_INVALID reads as a key error
	r = await test(mock.bare('badkey'));
	h.check(/Key rejected/.test(r.text), `§3 a 400 API_KEY_INVALID is a key error (${r.text})`);

	// §4 B2: the server answers but sends no CORS header -> CORS, and NO vLLM flag for a
	// server that does not look like vLLM
	r = await test(mock.bare('nocors'));
	h.check(/does not allow this site \(CORS\)/.test(r.text), `§4 a missing CORS header is named as CORS (${r.text})`);
	h.check(!/vLLM|allowed-origins/.test(r.text), '§4 ... without naming vLLM for a non-vLLM server');

	// §5 B2: nothing listens -> unreachable, NOT CORS
	r = await test(`localhost:${closedPort}/v1`);
	h.check(/Could not reach/.test(r.text) && !/CORS/.test(r.text), `§5 a closed port is "could not reach", not CORS (${r.text})`);

	// §6 B3: a server that never answers -> a timeout message in ~10 s, not "Testing…" forever
	r = await test(mock.bare('slow'));
	h.check(/No answer/.test(r.text), `§6 a silent server times out (${r.text})`);
	h.check(r.ms < 16000, `§6 ... within the stage timeout (${r.ms} ms)`);

	// §8 B3: the result is scrolled into view
	const inView = await page.locator('#ai-test-result').evaluate((el) => {
		const rect = el.getBoundingClientRect();
		return rect.bottom > 0 && rect.top < window.innerHeight;
	});
	h.check(inView, '§8 the test result is in view');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));

	// §7 B4: the assistant against a vLLM without the tool flags -> the one-line fix
	await page.evaluate((base) => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: base, apiKey: 'test', model: 'mock-model' });
		window.__stores.aiProviders.setAiEnabled(true);
	}, mock.bare('notools'));
	await page.evaluate(async () => {
		await window.__stores.aiAssistant.runPrompt('make a box');
	});
	const errs = await page.evaluate(
		() => new Promise((r) => window.__stores.aiAssistant.aiMessages.subscribe((m) => r(m.filter((x) => x.role === 'error').map((x) => x.content)))())
	);
	h.check(errs.some((e) => /--enable-auto-tool-choice/.test(e)), `§7 the tool-flag 400 becomes a hint (${errs.join(' | ').slice(0, 200)})`);

	h.check(h.pageErrors(A).length === 0, 'no page errors');
	await mock.close();
	await h.finish(browser);
});
