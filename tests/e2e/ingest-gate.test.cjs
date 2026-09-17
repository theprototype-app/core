// 26-C — Stage 2: the ingest gate (roadmap 26 section 4).
//
// A scene arriving over the wire announces itself FIRST (`{type:'loading', count,
// uuids}`) and only then sends the objects, so there is exactly one moment where the
// size is known and nothing has been applied yet. Past that moment a 4,000-object scene
// is simply happening to you — which is what the freeze reports describe.
//
// What is asserted, in the order it matters:
//  1. the verdict, which is pure and decides everything downstream;
//  2. an over-budget announcement PARKS the objects instead of applying them, and the
//     progress bar does not quietly give up while the question is open;
//  3. each of the three answers does what it says — including "the first N", which is
//     the only one with arithmetic in it;
//  4. a scene FILE asks too, with two ways out rather than three, and Cancel really
//     leaves the scene alone.
const h = require('./helpers.cjs');

const objectCount = (page) =>
	page.evaluate(() => {
		let n = 0;
		const g = window.__stores.objectsGroup;
		let group;
		const s = g.subscribe((/** @type {any} */ v) => (group = v));
		s();
		group?.traverse?.((/** @type {any} */ o) => { if (o !== group) n++; });
		return n;
	});

/** N object messages, exactly as the wire delivers them, without draining them. */
const feed = (page, n, prefix) =>
	page.evaluate(
		({ n, prefix }) => {
			const { THREE, commandsHandler } = window.__stores;
			const geo = new THREE.BoxGeometry(1, 1, 1);
			const mat = new THREE.MeshStandardMaterial();
			const uuids = [];
			for (let i = 0; i < n; i++) {
				const mesh = new THREE.Mesh(geo, mat);
				mesh.name = prefix + i;
				uuids.push(mesh.uuid);
				commandsHandler.createObject({ element: mesh.toJSON() }, null);
			}
			return uuids;
		},
		{ n, prefix }
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the verdict ------------------------------------------------------
	const verdicts = await A.page.evaluate(() => {
		const { ingestVerdict } = window.__stores.sceneBudget;
		return {
			// desktop objects: green <= 1000, amber <= 3000, red above
			small: ingestVerdict(0, 50, 'desktop'),
			amber: ingestVerdict(0, 2000, 'desktop'),
			red: ingestVerdict(0, 4200, 'desktop'),
			// the CURRENT scene counts: 2,900 here plus 500 more crosses it
			topUp: ingestVerdict(2900, 500, 'desktop'),
			// …and a headset crosses far sooner on the same numbers
			vr: ingestVerdict(0, 2000, 'vr'),
			empty: ingestVerdict(0, 0, 'desktop'),
			alreadyOver: ingestVerdict(5000, 100, 'desktop'),
			negative: ingestVerdict(-5, -5, 'desktop')
		};
	});
	h.check(verdicts.small.gate === false && verdicts.amber.gate === false, 'green and AMBER do not ask — amber warns, red asks');
	h.check(verdicts.red.gate === true && verdicts.red.allowed === 3000, `red asks, and offers the first ${verdicts.red.allowed}`);
	h.check(
		verdicts.topUp.gate === true && verdicts.topUp.allowed === 100,
		`what is ALREADY here counts: 2900 + 500 asks, and only ${verdicts.topUp.allowed} fit`
	);
	h.check(verdicts.vr.gate === true, 'the same 2,000 objects ask on a headset and not on a desktop');
	h.check(verdicts.empty.gate === false, 'an empty arrival never asks');
	h.check(verdicts.alreadyOver.allowed === 0, 'a scene already past the budget offers zero, not a negative number');
	h.check(verdicts.negative.total === 0 && verdicts.negative.gate === false, 'nonsense input answers 0, never NaN');

	// ---- 2. an over-budget arrival PARKS ------------------------------------
	const before = await objectCount(A.page);
	const armed = await A.page.evaluate((before) => {
		const { commandsHandler } = window.__stores;
		// announce more than the desktop budget can take
		commandsHandler.createLoader(4200, ['a', 'b', 'c'], 'peer-sending');
		return { open: commandsHandler.ingestGateOpen(), before };
	}, before);
	h.check(armed.open, 'an over-budget announcement opens the gate');
	await feed(A.page, 30, 'parked-');
	await A.page.waitForTimeout(700);
	const parked = await A.page.evaluate(() => ({
		backlog: window.__stores.commandsHandler.ingestBacklog(),
		gate: (() => { let v; const s = window.__stores.commandsHandler.ingestGate.subscribe((/** @type {any} */ x) => (v = x)); s(); return v; })()
	}));
	h.check(parked.backlog >= 29, `the objects are PARKED, not applied (${parked.backlog} in the queue)`);
	h.check((await objectCount(A.page)) === before, 'the scene is untouched while the question is open');
	h.check(parked.gate?.count === 4200 && parked.gate?.limit === 3000, `the card is told the real numbers (${parked.gate?.count} of ${parked.gate?.limit})`);
	const card = await A.page.locator('.tp-toast', { hasText: 'This scene has 4200 objects' });
	h.check((await card.count()) > 0, 'the fork is on screen');
	h.check(
		(await A.page.getByRole('button', { name: /Load the first/ }).count()) > 0,
		'…offering "Load the first N" beside Load all and Cancel'
	);

	// ---- 3a. Cancel --------------------------------------------------------
	await A.page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
	await A.page.waitForTimeout(500);
	const cancelled = await A.page.evaluate(() => ({
		backlog: window.__stores.commandsHandler.ingestBacklog(),
		open: window.__stores.commandsHandler.ingestGateOpen(),
		loading: (() => { let v; const s = window.__stores.loading.subscribe((/** @type {any} */ x) => (v = x)); s(); return v.length; })()
	}));
	h.check(cancelled.backlog === 0 && !cancelled.open, 'Cancel drops the parked queue and closes the gate');
	h.check((await objectCount(A.page)) === before, '…and not one of them reached the scene');
	h.check(cancelled.loading === 0, '…and the progress bar is cleared rather than left stuck');

	// ---- 3b. "Load the first N" --------------------------------------------
	const capBase = await objectCount(A.page);
	await A.page.evaluate(() => window.__stores.commandsHandler.createLoader(4200, [], 'peer-sending'));
	await feed(A.page, 40, 'capped-');
	await A.page.waitForTimeout(400);
	// force a small allowance so the arithmetic is observable in a headless scene
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.ingestGate.update((/** @type {any} */ g) => ({ ...g, allowed: 12 }));
	});
	await A.page.waitForTimeout(200);
	await A.page.getByRole('button', { name: /Load the first 12/ }).first().click();
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.commandsHandler.ingestBacklog()),
		(n) => n === 0,
		'the queue drains after the answer'
	);
	const capped = (await objectCount(A.page)) - capBase;
	h.check(capped === 12, `exactly the allowance was applied and the rest dropped (${capped} of 40)`);
	h.check(
		(await A.page.evaluate(() => { let v; const s = window.__stores.loading.subscribe((/** @type {any} */ x) => (v = x)); s(); return v.length; })) === 0,
		'the dropped objects count as arrived, so the bar does not wait out the stall'
	);

	// ---- 3c. Load all -------------------------------------------------------
	await A.page.evaluate(() => {
		const { objectsGroup, pokeScene } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		group.clear();
		pokeScene();
	});
	await A.page.waitForTimeout(400);
	const allBase = await objectCount(A.page);
	await A.page.evaluate(() => window.__stores.commandsHandler.createLoader(4200, [], 'peer-sending'));
	await feed(A.page, 25, 'all-');
	await A.page.waitForTimeout(300);
	await A.page.getByRole('button', { name: 'Load all', exact: true }).first().click();
	await h.eventually(
		() => objectCount(A.page),
		(n) => n - allBase === 25,
		'Load all applies every parked object'
	);
	h.check(!(await A.page.evaluate(() => window.__stores.commandsHandler.ingestGateOpen())), 'and the gate closes behind it');

	// ---- 4. a scene FILE asks too ------------------------------------------
	const payload = await A.page.evaluate(() => {
		const { THREE, sessions } = window.__stores;
		const objects = [];
		for (let i = 0; i < 3500; i++) {
			const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
			m.name = 'file-' + i;
			objects.push({ object: { uuid: m.uuid, name: m.name, type: 'Mesh', children: [] } });
		}
		return { count: sessions.countPayloadObjects({ objects }), nested: sessions.countPayloadObjects({ objects: [{ object: { children: [{ children: [{}] }] } }] }) };
	});
	h.check(payload.count === 3500, `a payload's objects are counted (${payload.count})`);
	h.check(payload.nested === 3, `…including nested children, the unit the budget is stated in (${payload.nested})`);

	const sceneBefore = await objectCount(A.page);
	await A.page.evaluate(() => {
		const objects = [];
		for (let i = 0; i < 3500; i++)
			objects.push({ object: { uuid: 'file-uuid-' + i, name: 'file-' + i, type: 'Mesh', children: [] } });
		// requestLoadPayload is what a file open and the Sessions manager's Load both
		// reach; the travel node and a peer proposal deliberately do NOT
		window.__tpLoad = window.__stores.sessions.requestLoadPayload({ name: 'Huge', objects });
	});
	await A.page.waitForSelector('dialog', { timeout: 8000 });
	const ask = await A.page.evaluate(() => document.querySelector('dialog')?.textContent ?? '');
	h.check(/3500 objects/.test(ask), `the ask names the count (${ask.slice(0, 90)})`);
	h.check(/3000 recommended/.test(ask), '…against the budget for this device');
	h.check(!/first \d/.test(ask), 'a FILE gets two ways out, not three — half a document is not a scene');
	await A.page.getByRole('button', { name: /Cancel/i }).first().click();
	const answered = await A.page.evaluate(() => window.__tpLoad);
	h.check(answered === false, 'Cancel refuses the load');
	await A.page.waitForTimeout(400);
	h.check((await objectCount(A.page)) === sceneBefore, '…and the current scene is untouched — it was not cleared first');

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
