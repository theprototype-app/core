// Phase 50: sessions — save/load solo, proposal flow with peers (accept +
// decline), selective object import, export/import round-trip.
const h = require('./helpers.cjs');

const objectNames = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__tp.test.v1.objectsGroup.subscribe((g) =>
					r((g?.children ?? []).map((c) => c.name))
				)()
			)
	);
const sessionList = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__tp.test.v1.sessions.sessions.subscribe(r)())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// build a small scene and save it
	await A.page.evaluate(async () => {
		const cmd = window.__tp.test.v1.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create sphere 1');
		await new Promise((r) => setTimeout(r, 300));
		await window.__tp.test.v1.sessions.saveSession('SceneOne');
	});
	let list = await sessionList(A.page);
	h.check(list.length === 1 && list[0].name === 'SceneOne' && list[0].count === 2, 'session saved with meta');
	h.check(!!list[0].thumbnail, 'thumbnail rendered');

	// clear, then solo load applies immediately (and stashes nothing extra — scene was empty)
	await A.page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(300);
	await A.page.evaluate((id) => window.__tp.test.v1.sessions.requestLoadSession(id), list[0].id);
	await h.eventually(
		() => objectNames(A.page),
		(names) => names.includes('Box') && names.includes('Sphere'),
		'solo load restored the scene'
	);

	// selective import: bring only the Box in as a fresh copy
	const before = (await objectNames(A.page)).length;
	await A.page.evaluate(async (id) => {
		const s = window.__tp.test.v1.sessions;
		const payload = await s.getSession(id);
		const entries = s.sessionObjectList(payload);
		const box = entries.find((e) => e.name === 'Box');
		s.importObjects(payload, [box.index]);
	}, list[0].id);
	await h.eventually(
		() => objectNames(A.page),
		(names) => names.length === before + 1,
		'selective import added exactly one object'
	);

	// export → import round-trip creates a second slot
	await A.page.evaluate(async (id) => {
		const s = window.__tp.test.v1.sessions;
		const payload = await s.getSession(id);
		const json = s.exportSession(payload);
		await s.importSession(json);
	}, list[0].id);
	list = await sessionList(A.page);
	h.check(list.length === 2, 'export/import round-trip created a new slot');

	// ---- proposal flow with a connected peer ----
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await A.page.waitForTimeout(500);

	// B declines first: nothing changes on B
	const target = list.find((s) => s.name === 'SceneOne');
	await A.page.evaluate((id) => window.__tp.test.v1.sessions.requestLoadSession(id), target.id);
	await B.page.waitForTimeout(800);
	h.check(
		// the TOAST, not its copy in the screen-reader live region (e3edaee5) — getByText matched both
		await B.page.locator('.tp-toast-text', { hasText: /wants to load session/ }).isVisible(),
		'B sees the proposal toast'
	);
	// the proposal's OWN toast's button: another toast's action could share the name
	await B.page.locator('.tp-toast', { hasText: /wants to load session/ }).getByRole('button', { name: 'Decline', exact: true }).click();
	await A.page.waitForTimeout(800);
	h.check(
		await A.page.locator('.tp-toast-text', { hasText: /declined the session load/ }).isVisible(),
		'A is told about the decline'
	);

	// fix-batch-4 B1: B holds many big saved sessions, the shape that made the 'Backup before' save slow
	// (it re-read every saved session for the list: ~8 of ~10 s under load). Seeded straight into idb so
	// the seeding itself reads nothing; the timer runs in B's page from the Accept press.
	const SEED = Number(process.env.SESSIONS_B1_SEED ?? 24);
	await B.page.evaluate(async (n) => {
		const t = window.__tp.test.v1;
		const pad = 'x'.repeat(1_500_000);
		for (let i = 0; i < n; i++)
			await t.idb.idbPut('session:b1-seed-' + i, { id: 'b1-seed-' + i, name: 'B1 seed ' + i, createdAt: Date.now() - 1e6 - i, format: 1, objects: [], pad });
		// @ts-ignore
		window.__b1 = { accept: 0, backup: 0, objects: 0 };
		t.sessions.sessions.subscribe((list) => {
			// @ts-ignore
			if (window.__b1.accept && !window.__b1.backup && list.some((m) => /^Backup before/.test(m.name))) window.__b1.backup = performance.now();
		});
		t.sceneLoader.sceneLoad.subscribe((/** @type {any} */ l) => {
			// @ts-ignore
			if (window.__b1.accept && !window.__b1.objects && l?.phase === 'objects') window.__b1.objects = performance.now();
		});
	}, SEED);
	// then B accepts: the load applies and replicates
	await A.page.evaluate((id) => window.__tp.test.v1.sessions.requestLoadSession(id), target.id);
	await B.page.waitForTimeout(800);
	// the press is stamped IN THE PAGE in the same task that presses it (a document capture listener never
	// saw Playwright's pointerdown/click reach the toast button: the app's own capture handlers get it first)
	await B.page.locator('.tp-toast', { hasText: /wants to load session/ }).getByRole('button', { name: 'Accept', exact: true }).waitFor({ timeout: 15000 });
	await B.page.evaluate(() => {
		const toast = [...document.querySelectorAll('.tp-toast')].find((t) => /wants to load session/.test(t.textContent ?? ''));
		const btn = /** @type {HTMLButtonElement | undefined} */ ([...(toast?.querySelectorAll('button') ?? [])].find((x) => (x.textContent ?? '').trim() === 'Accept'));
		// @ts-ignore
		window.__b1.accept = performance.now();
		btn?.click();
	});
	let replaced = false;
	await h.eventually(
		() => Promise.all([objectNames(A.page), objectNames(B.page)]),
		([a, b]) =>
			(replaced =
				a.filter((n) => n === 'Box').length === 1 &&
				a.includes('Sphere') &&
				b.filter((n) => n === 'Box').length === 1 &&
				b.includes('Sphere')),
		'accepted load replaced the scene on both peers',
		// 54-net: not stuck, slow — traced under load ~20 (x2-trace2): Accept -> the 'Backup before'
		// save took ~10 s (its session-list reload ~8 s), the clear landed ~15 s after Accept and the
		// objects after it, so a 15 s window read "nothing happened" while the load was still running
		60000
	);
	// @ts-ignore
	const b1 = await B.page.evaluate(() => window.__b1);
	const ms = (/** @type {number} */ t) => (t && b1.accept ? Math.round(t - b1.accept) : -1);
	h.check(b1.accept > 0, 'premise: B pressed Accept (stamped in the page)');
	console.log(`  B1: Accept -> backup saved ${ms(b1.backup)} ms, -> objects building ${ms(b1.objects)} ms (${SEED} seeded sessions of 1.5 MB)`);
	h.check(b1.backup > 0 && b1.objects > 0 && b1.objects - b1.accept < 2000, `B1: Accept -> the load builds objects in < 2 s with ${SEED} big saved sessions (${ms(b1.objects)} ms)`);
	// test-health-1: red since the toast check stopped masking it (e3edaee5) and not explained from the
	// code (A clears and adds nothing, B applies nothing) — a red prints each side's link, load job and
	// recent net/session diagnostics, so the next run says which path stopped
	if (!replaced)
		for (const [name, p, other] of [['A', A, B], ['B', B, A]])
			console.log(
				`  ${name} after Accept: ` +
					JSON.stringify(
						await p.page.evaluate((otherId) => {
							const s = window.__tp?.test.v1;
							let pc;
							s.peers.subscribe((v) => (pc = v))();
							const job = s.sceneLoader.currentJob?.();
							return {
								id: pc?.peer?.id,
								openTo: !!pc?.connections?.[otherId]?.open,
								reconnecting: pc?.reconnecting?.get?.(otherId) ?? null,
								job: job ? { name: job.name, cancelled: !!job.cancelled, interrupted: !!job.interrupted } : null,
								log: (s.diagnostics.lines?.() ?? []).filter((l) => /net|session|load|clear|wire/i.test(JSON.stringify(l))).slice(-12)
							};
						}, other.id)
					)
			);

	await h.finish(browser);
});
