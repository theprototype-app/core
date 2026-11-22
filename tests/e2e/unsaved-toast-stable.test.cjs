// 42 I11 — "bug: when peer connected and another peer edits unsaved scene the toast of not saved scene
// constantly shows/hides" (the user's preview-1-32c review). Two real peers: the HOST holds an unsaved
// scene, the JOINER adopts it and is told once "this scene has never been saved" (the shared-library
// offer, Toasts.svelte). Every edit the host makes re-runs that state mirror, and the mirror updates
// its card IN PLACE (a new row object under the same id) — while the toast stack was keyed by the ROW
// OBJECT, so every edit unmounted the card (fly out) and mounted a new one (fly in): the flicker.
// The stack keys an id'd card by its id now, so the indicator is ONE stable element.
// Measured here: a MutationObserver counts the card's DOM insertions/removals on the joiner while the
// host makes 12 edits (six creates, six moves). Counterfactual (feat/41-int): an insertion + a removal
// per create (the moves do not re-run the mirror); after: zero, and the card stays visible throughout.
// OUT=<dir> writes the joiner's screenshot (dark + light).
const h = require('./helpers.cjs');
const path = require('path');

const OUT = process.env.OUT || '';
const CARD = /never been saved|has unsaved changes/;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host', { context: { viewport: { width: 1280, height: 800 } } });
	const B = await h.setupPage(browser, 'joiner', { context: { viewport: { width: 1280, height: 800 } } });
	// the host's world: two boxes, never saved
	await A.page.evaluate(() => {
		const c = window.__tp.test.v1.commandsHandler;
		c.sceneCommand('/create box');
		c.sceneCommand('/create box');
	});
	await A.page.waitForTimeout(1500);
	await h.connect(B, A);
	// the joiner is empty, so it adopts the host's world and receives the boxes
	await h.eventually(
		() => B.page.evaluate(() => window.__tp.test.v1.objectsGroup && (() => { let g; window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))(); return g?.children?.length ?? 0; })()),
		(n) => n >= 2,
		'premise: the joiner holds the host\'s two boxes',
		30000
	);
	// premise: the "never been saved" card is up on the joiner
	await h.eventually(
		() => B.page.evaluate((src) => [...document.querySelectorAll('.toasts-regular .tp-toast')].some((n) => new RegExp(src).test(n.textContent || '')), CARD.source),
		(v) => v,
		'premise: the joiner shows the unsaved-scene card',
		20000
	);
	const shown = await B.page.evaluate((src) => [...document.querySelectorAll('.toasts-regular .tp-toast')].some((n) => new RegExp(src).test(n.textContent || '')), CARD.source);
	if (!shown) {
		await h.finish(browser);
		return;
	}
	await B.page.waitForTimeout(800); // let its entrance finish
	// count every insertion / removal of that card from now on
	await B.page.evaluate((src) => {
		const re = new RegExp(src);
		const w = /** @type {any} */ (window);
		w.__i11 = { added: 0, removed: 0, hiddenSamples: 0, samples: 0 };
		const isCard = (n) => n.nodeType === 1 && n.classList?.contains('tp-toast') && re.test(n.textContent || '');
		const mo = new MutationObserver((list) => {
			for (const m of list) {
				for (const n of m.addedNodes) if (isCard(n)) w.__i11.added++;
				for (const n of m.removedNodes) if (isCard(n)) w.__i11.removed++;
			}
		});
		mo.observe(document.body, { childList: true, subtree: true });
		w.__i11.mo = mo;
		// and sample "is it on screen" every 40 ms (a timer: a software-GL page's rAF crawls at a few
		// frames a second, and a fly-out or fly-in reads as not-fully-opaque)
		w.__i11.timer = setInterval(() => {
			w.__i11.samples++;
			const on = [...document.querySelectorAll('.toasts-regular .tp-toast')].some((n) => re.test(n.textContent || '') && getComputedStyle(n).opacity === '1');
			if (!on) w.__i11.hiddenSamples++;
		}, 40);
	}, CARD.source);
	// the host edits its unsaved scene: six creates and six moves, ~400 ms apart
	for (let i = 0; i < 12; i++) {
		await A.page.evaluate((k) => {
			const s = window.__tp?.test.v1;
			if (k % 2 === 0) {
				s.commandsHandler.sceneCommand('/create box');
				return;
			}
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const o = g?.children?.[0];
			if (!o) return;
			o.position.x += 0.25;
			let p;
			s.peers.subscribe((v) => (p = v))();
			p?.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: [0, 0, 0], scale: [1, 1, 1] });
			s.objectsGroup.update((v) => v);
		}, i);
		await A.page.waitForTimeout(400);
	}
	await B.page.waitForTimeout(1500);
	const r = await B.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		clearInterval(w.__i11.timer);
		w.__i11.mo.disconnect();
		const out = { added: w.__i11.added, removed: w.__i11.removed, hiddenSamples: w.__i11.hiddenSamples, samples: w.__i11.samples };
		w.__i11 = null;
		return out;
	});
	const objects = await B.page.evaluate(() => { let g; window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))(); return g?.children?.length ?? 0; });
	console.log('transitions', JSON.stringify(r), 'joiner objects', objects);
	h.check(objects >= 8, `premise: the host's edits reached the joiner (${objects} objects)`);
	h.check(r.added === 0 && r.removed === 0, `the unsaved-scene card never re-mounts while the host edits (added ${r.added}, removed ${r.removed})`);
	h.check(r.samples >= 3 && r.hiddenSamples === 0, `…and it is on screen at full opacity the whole time (${r.hiddenSamples} of ${r.samples} samples hidden)`);
	const still = await B.page.evaluate((src) => [...document.querySelectorAll('.toasts-regular .tp-toast')].filter((n) => new RegExp(src).test(n.textContent || '')).length, CARD.source);
	h.check(still === 1, `exactly one unsaved-scene card at the end (${still})`);
	if (OUT) {
		for (const t of ['dark', 'light']) {
			await B.page.evaluate((th) => window.__tp.test.v1.themes.theme.set(th), t);
			await B.page.waitForTimeout(350);
			await B.page.screenshot({ path: path.join(OUT, `i11-joiner-card-${t}.png`) });
		}
	}
	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors on either peer');
	await h.finish(browser);
});
