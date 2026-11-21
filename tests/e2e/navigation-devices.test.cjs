// 61-nav (roadmap 61 G10 + the lane rule "phone + Quest for every new surface"): the navigation
// module's surfaces on the devices the owner tests on.
//   1 N6 folded (390x896) and unfolded (770x850), touch: the object menu's "Make this an enemy…" opens
//     the sheet, every control is on screen, a TAP on Make enemy builds the guard
//   2 Quest (IWER): in a headset Play is the surface — the guard sees the HEADSET (api.players() reads
//     the XR-posed camera): a head in front of it is spotted and chased; the sheet itself is a desktop /
//     phone toolbox (QUESTIONS-61-nav fork 6)
// Skip-never-fail without the navigation zip (MODULES_REPO / helpers.moduleZipPath).
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const fs = require('fs');

const dbg = (page) => page.evaluate(() => window.__navigation?.debug?.() ?? null);
const FOLDED = {
	viewport: { width: 390, height: 896 },
	deviceScaleFactor: 3,
	isMobile: true,
	hasTouch: true,
	userAgent: h.N6_UA
};
const UNFOLDED = {
	viewport: { width: 770, height: 850 },
	deviceScaleFactor: 2.6,
	isMobile: true,
	hasTouch: true,
	userAgent: h.N6_UA
};

/** poll until ok(value); checks once, returns the last value */
async function until(fn, ok, label, ms = 10000) {
	const end = Date.now() + ms;
	let v;
	for (;;) {
		try {
			v = await fn();
		} catch (error) {
			v = { error: String(error?.message ?? error) };
		}
		let good = false;
		try {
			good = !!ok(v);
		} catch {
			good = false;
		}
		if (good || Date.now() > end) {
			h.check(good, label + (good ? '' : ' (last: ' + JSON.stringify(v)?.slice(0, 500) + ')'));
			return v;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}

h.run(async () => {
	if (!fs.existsSync(h.moduleZipPath('navigation'))) {
		console.log('SKIP: no navigation.zip at ' + h.moduleZipPath('navigation'));
		console.log('ALL PASS');
		process.exit(0);
	}
	const browser = await h.launch({});

	// ---- 1. the sheet on the N6, folded and unfolded ------------------------------------------------
	for (const [name, ctx] of /** @type {const} */ ([
		['folded', FOLDED],
		['unfolded', UNFOLDED]
	])) {
		const P = await h.setupPage(browser, name, { context: ctx });
		const page = P.page;
		const exec = (tool, args) =>
			page.evaluate(([t, a]) => window.__tp.test.v1.aiTools.executeAiTool(t, a), [tool, args]);
		h.check(
			await h.installModule(P, 'navigation'),
			'1.' + name + ' the module installs on the phone'
		);
		const made = await exec('create_objects', {
			objects: [
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Phone guard',
					params: [0.6, 1.6, 0.6],
					position: [0, 0.8, -3]
				}
			]
		});
		const uuid = made?.created?.[0]?.uuid;
		const opened = await page.evaluate((uuid) => {
			const m = window.__tp.test.v1.objectMenu;
			const item = m
				.flattenMenuItems(m.buildObjectMenuItems(uuid))
				.find((i) => /Make this an enemy/.test(i.label ?? ''));
			if (!item) return 'no row';
			item.action();
			return 'ok';
		}, uuid);
		h.check(opened === 'ok', '1.' + name + ' the object menu has "Make this an enemy…"');
		await page
			.locator('#nav-sheet-apply')
			.waitFor({ state: 'visible', timeout: 10000 })
			.catch(() => {});
		const vp = ctx.viewport;
		const rects = await page.evaluate(() =>
			[
				'#nav-sheet-target',
				'#nav-sheet-path',
				'#nav-sheet-sightRange',
				'#nav-sheet-apply',
				'#nav-sheet-debug'
			].map((sel) => {
				const el = document.querySelector(sel);
				const r = el?.getBoundingClientRect();
				return {
					sel,
					r: r
						? {
								x: Math.round(r.x),
								y: Math.round(r.y),
								w: Math.round(r.width),
								h: Math.round(r.height)
							}
						: null
				};
			})
		);
		const off = rects.filter(
			(q) => !q.r || q.r.w <= 0 || q.r.x < 0 || q.r.x + q.r.w > vp.width + 1
		);
		h.check(
			!off.length,
			'1.' +
				name +
				' every sheet control is inside the ' +
				vp.width +
				' px width (' +
				JSON.stringify(off.length ? off : rects.map((q) => q.sel + ' ' + q.r?.w)) +
				')'
		);
		const btn = rects.find((q) => q.sel === '#nav-sheet-apply')?.r;
		h.check(
			!!btn && btn.h >= 32,
			'1.' + name + ' Make enemy is a finger-sized target (' + btn?.h + ' px tall)'
		);
		await page
			.locator('#nav-sheet-apply')
			.scrollIntoViewIfNeeded()
			.catch(() => {});
		await page.locator('#nav-sheet-apply').tap();
		await until(
			() =>
				page.evaluate(
					(uuid) =>
						window.__navigation.api.flow.nodes('navnpc').filter((n) => n.graphId === uuid).length,
					uuid
				),
			(n) => n === 1,
			'1.' + name + ' a TAP on Make enemy builds the guard',
			10000
		);
		await P.page.context().close();
	}

	// ---- 2. Quest (IWER): the guard sees the headset --------------------------------------------------
	const Q = await h.setupPage(browser, 'quest', {
		init: iwer.initScript(),
		context: { viewport: { width: 1280, height: 720 } }
	});
	const page = Q.page;
	const exec = (tool, args) =>
		page.evaluate(([t, a]) => window.__tp.test.v1.aiTools.executeAiTool(t, a), [tool, args]);
	h.check(
		await h.installModule(Q, 'navigation'),
		'2.1 the module installs (desktop page that becomes the headset)'
	);
	const made = await exec('create_objects', {
		objects: [
			{
				kind: 'primitive',
				primitive: 'Box',
				name: 'VR ground',
				params: [40, 0.5, 40],
				position: [0, -0.25, 0],
				physics: 'static'
			},
			{
				kind: 'primitive',
				primitive: 'Box',
				name: 'VR guard',
				params: [0.6, 1.6, 0.6],
				position: [-6, 0.8, 0]
			}
		]
	});
	const guard = made?.created?.find((c) => c.name === 'VR guard')?.uuid;
	const npc = await exec('set_npc', { object: guard, path: 'none' });
	h.check(!npc?.error, '2.2 set_npc on the guard (' + (npc?.error ?? 'ok') + ')');
	await iwer.enter(page);
	await until(
		() => dbg(page),
		(d) => d?.active === true && d?.bake?.status === 'ready',
		'2.3 in the headset Play runs the navigation (active + baked)',
		30000
	);
	const me = () =>
		page.evaluate(() => window.__navigation.api.players().find((p) => p.me)?.pos ?? null);
	// park the head far away first, then measure how a head move maps into the world
	const head0 = [0, 1.6, 0];
	await iwer.pose(page, 'head', head0);
	await iwer.frames(page, 6);
	const w0 = await me();
	await iwer.pose(page, 'head', [head0[0] + 1, head0[1], head0[2]]);
	await iwer.frames(page, 6);
	const w1 = await me();
	const dx = w0 && w1 ? [w1[0] - w0[0], w1[2] - w0[2]] : null;
	h.check(
		!!dx && Math.abs(Math.hypot(dx[0], dx[1]) - 1) < 0.1,
		'2.4 api.players() follows the headset (a 1 m head move = ' + JSON.stringify(dx) + ')'
	);
	// the head 5 m in front of the guard (+Z of its home): head +x maps to world `ux` (measured), head +z
	// to `ux` turned 90 degrees one way or the other (the rig is a rotation) — try both, keep the one that lands
	if (dx) {
		const want = [-6, 0, 5];
		const rel = [want[0] - w0[0], want[2] - w0[2]];
		let best = null;
		for (const sign of [1, -1]) {
			const vz = [-dx[1] * sign, dx[0] * sign];
			const d = dx[0] * vz[1] - dx[1] * vz[0];
			const a = (rel[0] * vz[1] - rel[1] * vz[0]) / d;
			const b = (dx[0] * rel[1] - dx[1] * rel[0]) / d;
			await iwer.pose(page, 'head', [head0[0] + a, head0[1], head0[2] + b]);
			await iwer.frames(page, 6);
			const got = await me();
			const err = got ? Math.hypot(got[0] - want[0], got[2] - want[2]) : 99;
			if (!best || err < best.err) best = { err, got, a, b };
			if (err < 0.5) break;
		}
		await iwer.pose(page, 'head', [head0[0] + best.a, head0[1], head0[2] + best.b]);
		h.check(
			best.err < 0.5,
			'2.5 the headset stands 5 m in front of the guard (' + JSON.stringify(best.got) + ')'
		);
	}
	await until(
		async () => (await dbg(page))?.agents?.find((a) => a.uuid === guard),
		(a) => a?.state === 'chase' || a?.state === 'attack',
		'2.6 the guard spots the headset and comes for it',
		20000
	);
	await iwer.exit(page);

	await h.finish(browser);
});
