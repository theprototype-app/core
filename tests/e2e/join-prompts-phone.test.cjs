// fix-agenttest item 4 — A PHONE STAYS IN THE ROOM, AND ITS JOIN PROMPTS FIT THE SCREEN.
// The agent test lost a phone peer with "[net] link silent — closing it … why: consent-unanswered":
// that is the F-3 silence watch (peerDrop.linkSilence) closing a link whose ICE consent checks went
// unanswered for 7 s, which is what a phone does when its page goes to the BACKGROUND (screen off,
// fold/unfold, app switch). A page now says so (`linkaway {hidden}`), and a peer that said it is
// hidden gets AWAY_GRACE_MS (60 s) before a silence close; a crashed tab says nothing and is still
// cleared in 7 s. The prompts a join puts up (the host's approval card, the joiner's connect
// decision, the classic share-or-stash card) are checked on the OPPO Find N6 folded and unfolded
// viewports: on screen, and each button is the thing a tap at its centre lands on.
// Counterfactual on v1.47.0: 1.1 / 1.2 (no linkaway is sent, the host marks nobody away) are red;
// the prompt rows are the regression guard and pass on both.
const h = require('./helpers.cjs');

const PHONES = [
	['folded', { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }],
	['unfolded', { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }]
];

/** Is every element matched by these selectors fully on screen and the top hit at its centre? */
const tappable = (p, selectors) =>
	p.page.evaluate((sels) => {
		const out = {};
		for (const sel of sels) {
			const el = /** @type {HTMLElement|null} */ (typeof sel === 'string' && sel.startsWith('text=')
				? [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === sel.slice(5) && b.offsetParent)
				: document.querySelector(sel));
			if (!el) { out[sel] = 'missing'; continue; }
			const r = el.getBoundingClientRect();
			const inView = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			const onTop = !!hit && (hit === el || el.contains(hit));
			out[sel] = inView && onTop ? 'ok' : `inView=${inView} onTop=${onTop} rect=${[r.left, r.top, r.right, r.bottom].map(Math.round)} hit=${hit?.id || hit?.className || hit?.tagName}`;
		}
		return out;
	}, selectors);

/** The dial: the pill where there is one; the phone shell keeps its dial input in a panel this
 *  suite is not about, so a phone dials through the same requestConnect the pill calls */
const dial = async (from, to) => {
	const dot = from.page.locator('#connect-squeeze-dot');
	if (await dot.isVisible().catch(() => false)) await dot.click();
	const input = from.page.locator('input[placeholder="Enter peer ID to connect"]');
	if (await input.isVisible().catch(() => false)) {
		await input.fill(to.id);
		await from.page.getByRole('button', { name: 'Connect', exact: true }).click();
		return;
	}
	await from.page.waitForFunction(() => !!window.__stores?.peerApproval?.requestConnect, null, { timeout: 30000 });
	await from.page.evaluate((id) => window.__stores.peerApproval.requestConnect(id), to.id);
};

const addObject = async (p, command) => {
	await p.page.evaluate((c) => window.__stores.commandsHandler.sceneCommand(c), command);
	await p.page.waitForTimeout(800);
	await p.page.evaluate(() => window.__stores.objectActions.deselectObject());
};

/** Put the page in the background / foreground as a phone does (visibilitychange with document.hidden). */
const setHidden = (p, hidden) =>
	p.page.evaluate((v) => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'hidden' : 'visible') });
		document.dispatchEvent(new Event('visibilitychange'));
	}, hidden);

const awayOn = (p, id) =>
	p.page.evaluate((peerId) => {
		let peer;
		window.__stores.peers.subscribe((v) => (peer = v))();
		return !!peer?.awayPeers?.has?.(peerId);
	}, id);

h.run(async () => {
	const browser = await h.launch();

	for (const [shape, context] of PHONES) {
		// ---- the HOST is the phone: its approval card ---------------------------------------------
		const P = await h.setupPage(browser, 'P-' + shape, { context });
		const D = await h.setupPage(browser, 'D-' + shape);
		await dial(D, P);
		const approve = h.approveButton(P.page);
		await approve.waitFor({ state: 'visible', timeout: 30000 });
		const card = await P.page.evaluate(() => {
			const b = [...document.querySelectorAll('button')].find((x) => /^(Approve|Editor access)$/.test((x.textContent || '').trim()) && x.offsetParent);
			if (b) b.id ||= 'e2e-approve';
			const deny = [...document.querySelectorAll('button')].find((x) => /^(Deny|Reject)$/.test((x.textContent || '').trim()) && x.offsetParent);
			if (deny) deny.id ||= 'e2e-deny';
			return { approve: !!b, deny: !!deny };
		});
		h.check(card.approve && card.deny, `${shape}: the phone host's approval card has Approve and Deny (${JSON.stringify(card)})`);
		const cardFit = await tappable(P, ['#e2e-approve', '#e2e-deny']);
		h.check(Object.values(cardFit).every((v) => v === 'ok'), `${shape}: the approval card's buttons are on screen and tappable ${JSON.stringify(cardFit)}`);
		await approve.click();
		await h.eventually(
			() => Promise.all([D, P].map((x) => x.page.evaluate(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return p?.openedPeers?.size ?? 0; }))),
			(n) => n.every((v) => v >= 1),
			`${shape}: connected`,
			45000
		);

		// ---- the phone goes to the background: the desktop marks it away, then back -----------------
		if (shape === 'folded') {
			await setHidden(P, true);
			await h.eventually(() => awayOn(D, P.id), (v) => v === true, '1.1 the phone going hidden marks it AWAY on its peer (long silence grace)', 10000);
			await setHidden(P, false);
			await h.eventually(() => awayOn(D, P.id), (v) => v === false, '1.2 the phone coming back clears the mark', 10000);
		}
		await D.ctx.close();
		await P.ctx.close();

		// ---- the JOINER is the phone: the connect decision (both sides hold work, unnamed) ----------
		const J = await h.setupPage(browser, 'J-' + shape, { context });
		const H = await h.setupPage(browser, 'H-' + shape);
		await addObject(J, '/create box');
		await addObject(H, '/create Cylinder 1 1 2');
		await dial(J, H);
		await h.approveButton(H.page).click({ timeout: 30000 });
		await J.page.locator('#confirm-dialog-save').waitFor({ state: 'visible', timeout: 30000 });
		const decision = await tappable(J, ['#confirm-dialog-save', '#confirm-dialog-dismiss', '#confirm-dialog-cancel']);
		h.check(Object.values(decision).every((v) => v === 'ok'), `${shape}: the connect decision's three buttons are on screen and tappable ${JSON.stringify(decision)}`);
		await J.page.locator('#confirm-dialog-cancel').click();
		await J.ctx.close();
		await H.ctx.close();

		// ---- the classic merge (mergeOnConnect): the share-or-stash card on the phone ---------------
		const M = await h.setupPage(browser, 'M-' + shape, { context, storage: { 'connect:mergeOnConnect': 'true' } });
		const N = await h.setupPage(browser, 'N-' + shape);
		await addObject(M, '/create box');
		await addObject(N, '/create Cylinder 1 1 2');
		await dial(M, N);
		await h.approveButton(N.page).click({ timeout: 30000 });
		const labels = await h.eventually(
			() =>
				M.page.evaluate(() => {
					let list;
					window.__stores.toastStore.subscribe((v) => (list = v))();
					const entry = list.find((e) => e && e.id === 'share-or-stash');
					return entry ? (entry.actions ?? []).map((a) => a.label) : [];
				}),
			(v) => v.length >= 2,
			`${shape}: the share-or-stash card is up on the phone joiner`,
			30000
		).then(() => M.page.evaluate(() => { let list; window.__stores.toastStore.subscribe((v) => (list = v))(); return (list.find((e) => e && e.id === 'share-or-stash')?.actions ?? []).map((a) => a.label); }));
		await M.page.waitForTimeout(600);
		const stash = await tappable(M, labels.map((l) => 'text=' + l));
		h.check(Object.values(stash).every((v) => v === 'ok'), `${shape}: the share-or-stash buttons are on screen and tappable ${JSON.stringify(stash)}`);
		for (const p of [M, N]) {
			const errs = h.pageErrors(p);
			h.check(errs.length === 0, `${shape}: no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
		}
		await M.ctx.close();
		await N.ctx.close();
	}
	await h.finish(browser);
});
