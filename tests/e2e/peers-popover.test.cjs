// Phase 130: peers popover — the top-right overflow lists EVERY connected
// peer (none hidden by stacking, including the first two), each with a labeled
// Watch affordance; clicking Watch spectates that peer.
//
// R22 ROUND 30 B2 adds the second question the popover has to answer now that one mesh
// can hold several scenes: not only WHO is here but WHERE each of them is. The count
// went self-inclusive in both places (the badge said 4 while the list drew 5 rows), and
// an All | Rooms switcher groups the same rows by scene.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// inject self + four fake peers into userdata
	await A.page.evaluate(() => {
		const selfId = window.__stores.peers && (() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); return p?.peer?.id; })();
		window.__self = selfId || 'self';
		window.__stores.userdata.set([
			[window.__self, 'Me', null, null, null, {}],
			['p1', 'Ann', null, null, null, {}],
			['p2', 'Bo', null, null, null, {}],
			['p3', 'Cy', null, null, null, {}],
			['p4', 'Di', null, null, null, {}]
		]);
		// CN: the popover mounts on LIVE connections (openedPeers), never on the roster —
		// userdata is populated optimistically at dial time, which used to show a phantom
		// peer while a request was still pending. A roster injected on its own therefore
		// renders nothing at all, which is why this suite went red. The reaper only runs on
		// a conn CLOSE, so the fake rows survive for the length of the suite.
		window.__stores.peers.update((p) => {
			p.openedPeers.add('p1');
			return p;
		});
	});
	await A.page.waitForTimeout(400);

	// --- compact trigger shows the peer count ---
	const trigger = await A.page.evaluate(() => {
		const el = document.querySelector('#peers-trigger');
		return { present: !!el, text: el?.textContent.trim() };
	});
	// SELF-INCLUSIVE: the badge and the popover header count the same thing, and they
	// disagreed by one. "Connected" is the people in the session, and you are one.
	h.check(trigger.present && trigger.text.includes('5'), `compact trigger shows the peer count (${trigger.text})`);

	// --- opening lists ALL peers (5 rows incl. self + the first two) ---
	await A.page.evaluate(() => document.querySelector('#peers-trigger').click());
	await A.page.waitForTimeout(300);
	const popover = await A.page.evaluate(() => {
		const box = document.querySelector('#peers-popover');
		const rows = box ? [...box.querySelectorAll('.peers-row')] : [];
		const names = rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim());
		return {
			open: !!box,
			header: box?.querySelector('.ui-section-label')?.textContent?.trim(),
			flatArmed: box?.querySelector('#peers-view-flat')?.getAttribute('aria-pressed'),
			rowCount: rows.length,
			watchButtons: box ? box.querySelectorAll('.peer-watch').length : 0,
			gotoButtons: box ? box.querySelectorAll('.peer-goto').length : 0,
			hasAnn: names.some((n) => n.includes('Ann')),
			hasBo: names.some((n) => n.includes('Bo')),
			youMarked: names.some((n) => n.includes('Me') && n.includes('you'))
		};
	});
	h.check(popover.open, 'clicking the trigger opens the popover');
	h.check(popover.header === 'Connected (5)', `the header counts the same people the list draws (${popover.header})`);
	h.check(popover.flatArmed === 'true', `All is the default view (aria-pressed ${popover.flatArmed})`);
	h.check(popover.rowCount === 5, `every peer is listed (${popover.rowCount} rows incl. self)`);
	h.check(popover.hasAnn && popover.hasBo, 'the first two peers (previously stacked) are visible');
	h.check(popover.watchButtons === 4, `each peer has a Watch button, self does not (${popover.watchButtons})`);
	// ONLY ON EVIDENCE: nothing has told us where any of these peers is, and an absent row
	// is not "somewhere else" — so nobody is demonstrably elsewhere and Go to, which
	// exists only for that case, renders for nobody.
	h.check(popover.gotoButtons === 0, `…and nobody is demonstrably elsewhere, so no Go to (${popover.gotoButtons})`);
	h.check(popover.youMarked, 'own row is marked (you)');

	// --- the ROOMS view groups the same rows by scene ---
	await A.page.evaluate(() => document.querySelector('#peers-view-rooms').click());
	await A.page.waitForTimeout(400);
	const grouped = await A.page.evaluate(() => {
		const box = document.querySelector('#peers-popover');
		const headEls = [...box.querySelectorAll('.peers-room-head')];
		const heads = headEls.map((el) => ({
			label: el.querySelector('span')?.textContent?.trim(),
			mine: el.hasAttribute('data-mine'),
			text: el.textContent.replace(/\s+/g, ' ').trim()
		}));
		// a header's own section = the rows between it and whatever comes next
		const els = [...box.querySelectorAll('.peers-room-head, .peers-row')];
		const sectionOf = (i) => {
			const start = els.indexOf(headEls[i]);
			const out = [];
			for (let k = start + 1; k < els.length && els[k].classList.contains('peers-row'); k++) out.push(els[k]);
			return out;
		};
		const last = headEls.length - 1;
		return {
			heads,
			rowCount: box.querySelectorAll('.peers-row').length,
			viewArmed: box.querySelector('#peers-view-rooms')?.getAttribute('aria-pressed'),
			stored: localStorage.getItem('peers:view'),
			mineHasYou: sectionOf(0).some((r) => /\(you\)/.test(r.textContent)),
			unknownRows: sectionOf(last).length,
			unknownWatch: sectionOf(last).filter((r) => {
				const b = r.querySelector('.peer-watch');
				return b && !b.disabled && /Watch/i.test(b.textContent ?? '');
			}).length
		};
	});
	h.check(grouped.viewArmed === 'true', 'the Rooms half arms');
	h.check(grouped.stored === 'rooms', `…and the choice is remembered locally (${grouped.stored})`);
	h.check(grouped.rowCount === 5, `the same five people, regrouped (${grouped.rowCount})`);
	// TWO BUCKETS roomsOfSession cannot produce, and they mean different things: an empty
	// scene name is the session's UNNAMED world (a real room), while no row at all is a
	// peer on an older build. We are in the first; the four injected peers are in the
	// second, which is why it sorts LAST — it describes our ignorance, not their place.
	h.check(
		grouped.heads.length === 2 && grouped.heads[0].mine === true,
		`my own room heads the list (${JSON.stringify(grouped.heads.map((x) => x.label))})`
	);
	h.check(
		/Untitled scene/.test(grouped.heads[0].label ?? '') && /your room/.test(grouped.heads[0].text ?? ''),
		`…named as the unnamed world and marked as mine ("${grouped.heads[0].text}")`
	);
	h.check(grouped.mineHasYou, '…and it is the group holding (you)');
	h.check(
		/Scene unknown/.test(grouped.heads[1].label ?? '') && grouped.unknownRows === 4,
		`the peers who have said nothing are last, together (${grouped.heads[1].label}, ${grouped.unknownRows} rows)`
	);
	h.check(
		grouped.unknownWatch === 4,
		`…with Watch still ENABLED there — only-on-evidence, and we have none (${grouped.unknownWatch})`
	);

	// back to All, which is where the rest of this suite reads from
	await A.page.evaluate(() => document.querySelector('#peers-view-flat').click());
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.evaluate(() => document.querySelectorAll('#peers-popover .peers-room-head').length)) === 0,
		'…and All puts the flat list back'
	);

	// --- clicking Watch spectates that peer ---
	const watched = await A.page.evaluate(() => {
		const btn = document.querySelector('#peers-popover .peer-watch');
		btn.click();
		let spec;
		window.__stores.specatorMode.subscribe((v) => (spec = v))();
		return spec;
	});
	h.check(watched === 'p1', `Watch spectates the peer (${watched})`);

	// reset spectator so teardown is clean
	await A.page.evaluate(() => window.__stores.specatorMode.set(false));

	await h.finish(browser);
});
