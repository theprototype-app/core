// uir-people (People & session, owner 2026-11-09): the Invite-first pill, the Person card, the optional status.
//
//   1. one page, idle: the pill leads with its word (Ready), Invite and Join…; no robot "Request AI"; Invite opens
//      the sheet on Person with AI agent as the second tab; Join… shows the dial field, Esc (empty) folds it; a
//      pasted invite link goes the invite-link way (our own link -> "That's your own invite link").
//   2. two real peers: B (named "Sam", status Busy) joins A. A's row for B shows the status; a press on the row
//      flips the popover to B's card (name, avatar, Busy, the menu's actions as buttons); Go to flies A's camera
//      to B; the connected chip names the session.
//   3. B changes its status on its OWN card (Away): A's card follows. B turns the setting off: A's status clears.
//   4. a late joiner C (joins A): C's list and card show B's name and status (it rode A's roster).
//   Shots (dark + light, the window size given) into OUT.
//
// Run: APP_URL='https://localhost:7004/' npm run e2e -- uir-people
const h = require('./helpers.cjs');

const OUT = process.env.OUT || 'test-results/uir-people';
const W = Number(process.env.UIR_W || 1280);
const H = Number(process.env.UIR_H || 800);

const read = (p, store) =>
	p.page.evaluate((s) => {
		let v;
		window.__stores[s].subscribe((x) => (v = x))();
		return v;
	}, store);
const until = async (p, fn, ms = 30000) => {
	for (const t = Date.now() + ms; Date.now() < t; await p.page.waitForTimeout(500)) if (await fn().catch(() => false)) return true;
	return false;
};
const shot = async (p, name) => {
	await p.page.screenshot({ path: `${OUT}/${name}-${W}.png` }).catch(() => {});
};
// two heavy pages (the second peer's avatar in view) answer an input event every few seconds headless — measured
// the same on the base build (A/B 2026-11-09: 10.7 s for the trigger, 5.8-8.5 s for a row): patient clicks, not short ones
async function openPeople(p) {
	if (!(await read(p, 'peersPanelOpen'))) await p.page.locator('#peers-trigger').click({ timeout: h.PATIENT_CLICK_MS });
	await p.page.locator('#peers-popover').waitFor({ timeout: 30000 });
}
async function openCardOf(p, peerId) {
	await openPeople(p);
	if ((await p.page.locator(`#person-card[data-peer-id="${peerId}"]`).count()) === 0) {
		if (await p.page.locator('#person-card').count()) await p.page.locator('#person-card-back').click({ timeout: h.PATIENT_CLICK_MS });
		// press the row's NAME (not one of its buttons)
		await p.page.locator(`#peers-popover .peers-row[data-peer-id="${peerId}"] .peer-name`).click({ timeout: h.PATIENT_CLICK_MS });
	}
	await p.page.locator(`#person-card[data-peer-id="${peerId}"]`).waitFor({ timeout: 30000 });
}
const cardPresence = (p) => p.page.locator('#person-card-presence').getAttribute('data-presence').catch(() => null);

h.run(async () => {
	const browser = await h.launch();
	// the app's light mode is the stored theme (themes.js), not prefers-color-scheme: a light page sets both
	const ctx = (scheme) => ({ context: { viewport: { width: W, height: H }, colorScheme: scheme } });

	// ---- 1. the idle pill ------------------------------------------------------------------------------
	console.log('\n=== 1. the Invite-first pill ===');
	const A = await h.setupPage(browser, 'A', { ...ctx('dark'), storage: { username: 'Mira', usernameCustom: '1' } });
	await until(A, async () => !!(await A.page.evaluate(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return p?.peer?.open; })));
	const squeezed = A.page.locator('#connect-squeeze-dot');
	if (await squeezed.isVisible().catch(() => false)) await squeezed.click();
	h.check(await until(A, async () => (await A.page.locator('#connect-ready').innerText()).trim() === 'Ready', 15000), 'idle: the pill says Ready (not Offline) while the server answers');
	h.check(await A.page.locator('#connect-invite').isVisible(), 'idle: Invite leads the pill');
	h.check(await A.page.locator('#connect-join').isVisible(), 'idle: Join… beside it');
	h.check((await A.page.locator('#connect-request-ai').count()) === 0, 'the robot "Request AI" is gone (one Invite button)');
	h.check(!(await A.page.locator('input[placeholder="Enter peer ID to connect"]').isVisible().catch(() => false)), 'the dial field waits behind Join…');
	await shot(A, '01-pill-idle-dark');
	await A.page.locator('#connect-invite').click();
	await A.page.locator('#invite-sheet').waitFor({ timeout: 8000 });
	h.check((await A.page.locator('#invite-sheet').getAttribute('data-tab')) === 'person', 'Invite opens the sheet on Person');
	h.check(await A.page.getByRole('tab', { name: 'AI agent' }).isVisible(), 'AI agent is the sheet’s second tab');
	await shot(A, '02-invite-sheet-dark');
	await A.page.keyboard.press('Escape');
	await until(A, async () => (await A.page.locator('#invite-sheet').count()) === 0, 5000);
	await A.page.locator('#connect-join').click();
	const field = A.page.locator('input[placeholder="Enter peer ID to connect"]');
	h.check(await until(A, () => field.isVisible(), 5000), 'Join… shows the dial field');
	h.check(await A.page.evaluate(() => document.activeElement?.getAttribute('placeholder') === 'Enter peer ID to connect'), 'and focuses it');
	await shot(A, '03-pill-join-dark');
	await A.page.keyboard.press('Escape');
	h.check(await until(A, () => A.page.locator('#connect-join').isVisible(), 5000), 'Esc in the empty field folds it back to Join…');
	// a pasted link takes the invite-link path: our own link is recognised as ours
	await (await h.openDial(A.page)).fill(`https://theprototype.app/#${A.id.toUpperCase()}`);
	await A.page.keyboard.press('Enter');
	h.check(
		await until(A, async () => JSON.stringify(await read(A, 'toastStore')).includes('your own invite link'), 8000),
		'a pasted invite link goes the invite-link way (our own -> "That’s your own invite link")'
	);
	await A.page.locator('#connect-join-close').click().catch(() => {});

	// ---- 2. two peers: the card ------------------------------------------------------------------------
	console.log('\n=== 2. B joins: the row, the card, Go to ===');
	const B = await h.setupPageQuiet(browser, 'B', [A], {
		...ctx('dark'),
		storage: { username: 'Sam', usernameCustom: '1', 'people:presence': '1', 'people:presenceValue': 'busy' }
	});
	await h.connect(B, A);
	h.check(
		await until(A, async () => (await read(A, 'userdata')).some((r) => r[0] === B.id && r[1] === 'Sam' && r[6]?.presence === 'busy')),
		'A’s roster carries B’s name and status (roster slot 6)'
	);
	await openPeople(A);
	h.check(
		await until(A, async () => (await A.page.locator(`.peers-row[data-peer-id="${B.id}"] .peer-presence`).getAttribute('data-presence')) === 'busy', 8000),
		'A’s row for B shows Busy'
	);
	await shot(A, '04-people-list-dark');
	await openCardOf(A, B.id);
	h.check((await A.page.locator('#person-card .pc-name').innerText()).includes('Sam'), 'the card shows B’s name');
	h.check((await A.page.locator('#person-card .pc-av').count()) === 1, 'the card shows B’s avatar');
	h.check((await cardPresence(A)) === 'busy', 'the card shows Busy');
	h.check((await A.page.locator('#person-card [data-testid="person-watch"]').count()) === 1, 'the card offers Watch (the menu’s own row)');
	h.check((await A.page.locator('#person-card [data-testid="person-mute"]').count()) === 1, 'and Mute voice');
	h.check((await A.page.locator('#person-card [data-testid="person-profile"]').count()) === 0, 'View profile is the card itself, not repeated');
	await shot(A, '05-person-card-dark');
	// Go to: the camera flies to B
	const camAt = () => A.page.evaluate(() => { let c; window.__stores.globalCamera.subscribe((v) => (c = v))(); return c.position.toArray(); });
	const before = await camAt();
	const goto = A.page.locator('#person-card [data-testid="person-goto"]');
	h.check(await until(A, async () => !(await goto.isDisabled()), 20000), 'Go to is enabled once B’s avatar is in the scene');
	await goto.click({ timeout: h.PATIENT_CLICK_MS });
	h.check(
		await until(A, async () => { const a = await camAt(); return Math.hypot(a[0] - before[0], a[1] - before[1], a[2] - before[2]) > 0.2; }, 8000),
		'Go to flies A’s camera to B'
	);
	h.check(!(await read(A, 'peersPanelOpen')), 'and closes the popover');
	h.check((await A.page.locator('#connect-session-name').innerText().catch(() => '')) === 'Your session', 'the host’s chip names the session (Your session)');
	h.check((await B.page.locator('#connect-session-name').innerText().catch(() => '')).includes('Mira'), 'the guest’s chip names it after the host (Mira’s session)');
	await shot(B, '06-chip-guest-dark');
	// back arrow + Esc
	await openCardOf(A, B.id);
	await A.page.locator('#person-card-back').click({ timeout: h.PATIENT_CLICK_MS });
	h.check((await A.page.locator('#person-card').count()) === 0 && (await A.page.locator(`.peers-row[data-peer-id="${B.id}"]`).count()) === 1, 'the back arrow returns to the list');

	// ---- 3. B changes its own status ---------------------------------------------------------------------
	console.log('\n=== 3. B: Away, then off ===');
	await openCardOf(B, B.id);
	h.check(await B.page.locator('#person-presence').isVisible(), 'B’s own card offers the status (the setting is on)');
	await shot(B, '07-own-card-dark');
	await B.page.locator('#person-presence-away').click({ timeout: h.PATIENT_CLICK_MS });
	await openCardOf(A, B.id);
	h.check(await until(A, async () => (await cardPresence(A)) === 'away', 15000), 'A’s card follows B to Away');
	await B.page.evaluate(() => window.__stores.peoplePresence.setPresenceEnabled(false));
	h.check(await until(A, async () => (await A.page.locator('#person-card-presence').count()) === 0, 15000), 'B turns it off: A’s card shows no status');
	await B.page.evaluate(() => window.__stores.peoplePresence.setPresenceEnabled(true));
	h.check(await until(A, async () => (await cardPresence(A)) === 'away', 15000), 'B turns it back on: Away again');

	// ---- 4. a late joiner ------------------------------------------------------------------------------
	console.log('\n=== 4. C joins late ===');
	const C = await h.setupPageQuiet(browser, 'C', [A, B], { ...ctx('light'), storage: { theme: 'light' } });
	await h.connect(C, A);
	h.check(
		await until(C, async () => (await read(C, 'userdata')).some((r) => r[0] === B.id && r[1] === 'Sam' && r[6]?.presence === 'away'), 40000),
		'the late joiner holds B’s name and status'
	);
	await openCardOf(C, B.id);
	h.check((await C.page.locator('#person-card .pc-name').innerText()).includes('Sam'), 'C’s card shows B’s name');
	h.check((await cardPresence(C)) === 'away', 'and Away');
	await shot(C, '08-person-card-light');
	await C.page.locator('#person-card-back').click({ timeout: h.PATIENT_CLICK_MS });
	await shot(C, '09-people-list-light');

	await h.finish(browser);
});
