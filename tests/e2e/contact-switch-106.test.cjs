// 106 S2b — CONTACT SHADOWS, THIS DEVICE's switch (Preview pill ▸ Look ▸ Contact shadows: Auto / On / Off).
//
//   1. the row: a Look group after the Cinematic view group; Auto by default and Auto draws nothing (no tier does today)
//   2. On draws the pass (built in the post stack, the frame changes at a box's foot) even at Basic; Off removes it
//   3. never in the scene file: a save is byte-identical with the switch On or Off, and an old scene (saved before
//      the switch) loads unchanged while the device keeps its own setting
//   4. never on the wire: a connected peer receives nothing about it (A's sends spied, with a positive control) and
//      B's own switch, pass and environment are untouched
//   5. per device: a reload keeps On (localStorage `contactShadows`), and the pass comes back by itself
//   6. tier gating: as a phone / a headset (the shadow tier override) the switch is disabled with the reason and the
//      pass is gone even though the stored setting says On; back on the pc tier it returns
//   7. the governor drops it FIRST: overloaded frames (synthetic clock) take contact off at level 0, the note says
//      so, the next overload is step 1 (shadows off); "Restore full quality" gives both back
//   8. the measured cost (pc tier): with a GPU timer, frames with and without the pass give "costs about N ms"
//      (or "under 1 ms") in the row, kept in localStorage `contactShadowsCost`; without a timer = reported, not asserted
//   FRAMES=1 adds the frame row (the PC GPU row in the PR): product-shot + castle-courtyard at Basic, contact On
//   vs Off, 6 s each: rAF median / p95 / frames over 20 ms + the GPU meter's medians -> OUT/frames-<DEVICE>.json
//
//   APP_URL=https://theprototype.app:7206/ e2e-slot --dev $PWD 7206 -- node tests/e2e/contact-switch-106.test.cjs
//   PC GPU row: APP_URL=https://theprototype.app:7206/ E2E_PC=pc:8 e2e-slot --dev $PWD 7206 -- \
//     env E2E_GPU=1 FRAMES=1 DEVICE=pc OUT=$PWD/test-results/106-contact-switch node tests/e2e/contact-switch-106.test.cjs
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const GPU = process.env.E2E_GPU === '1';
const FRAMES = process.env.FRAMES === '1';
const DEVICE = process.env.DEVICE || 'deck';
const OUT = process.env.OUT || path.join(process.cwd(), 'test-results/106-contact-switch');

setTimeout(() => {
	console.log('SCRIPT FAILED: contact-switch-106 watchdog — the suite ran over 900 s');
	process.exit(1);
}, 900000).unref();

/** h.eventually that hands back the last value it read @param {() => Promise<any>} fn @param {(v: any) => boolean} ok @param {string} label @param {number} [timeout] */
async function until(fn, ok, label, timeout = 15000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (ok(last)) break;
		await new Promise((r) => setTimeout(r, 300));
	}
	const pass = ok(last);
	if (!pass) console.log('  last: ' + JSON.stringify(last)?.slice(0, 600));
	h.check(pass, label);
	return last;
}

/** what a page draws and holds for the switch @param {any} page */
const state = (page) =>
	page.evaluate(async () => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		const read = (/** @type {any} */ st) => {
			let v;
			st.subscribe((/** @type {any} */ x) => (v = x))();
			return v;
		};
		const cs = await S.contactShadows;
		const q = read(S.qualityGovernor.qualityOverrides);
		const qs = read(S.qualityGovernor.qualityState);
		return {
			mode: read(S.lightParams.contactShadowsMode),
			stored: localStorage.getItem('contactShadows'),
			wanted: read(S.lightParams.contactShadowsWanted),
			live: cs.contactEffectsLive(),
			tier: S.environment.shadowTier(),
			drawn: S.environment.drawnSceneShadowLevel(),
			contactOff: !!q.contactOff,
			shadowsOff: !!q.shadowsOff,
			level: qs.level,
			labels: qs.labels,
			envAt: read(S.environment.environment).changedAt ?? 0,
			note: document.getElementById('preview-contact-note')?.textContent ?? null,
			disabled: !!document.querySelector('#preview-contact-mode [aria-checked]')?.hasAttribute('disabled'),
			checked: document.querySelector('#preview-contact-mode [aria-checked="true"]')?.id ?? null
		};
	});

async function openMenu(/** @type {any} */ page) {
	if (!(await page.locator('#preview-menu').count())) await page.locator('#preview-more').click();
	await page.waitForSelector('#preview-menu', { timeout: 5000 });
}
async function closeMenu(/** @type {any} */ page) {
	if (await page.locator('#preview-menu').count()) await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
}
/** the real control @param {any} page @param {'auto'|'on'|'off'} v */
async function pick(page, v) {
	await openMenu(page);
	await page.locator(`#preview-contact-mode-${v}`).click();
	await page.waitForTimeout(300);
}
/** a save of the scene as JSON, the volatile fields (ids, times, thumbnail) left out @param {any} page */
const saveText = (page) =>
	page.evaluate(async () => {
		const p = await /** @type {any} */ (window).__tp.test.v1.sessions.buildSessionPayload('contact-switch-106');
		return JSON.stringify(p, (k, v) => (/^(id|uuid|createdAt|savedAt|updatedAt|thumbnail|at)$/.test(k) ? undefined : v));
	});

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch(GPU ? { args: h.GPU_ARGS } : {});
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;

	// ---- 1. the row ----------------------------------------------------------------------------------------------
	const s0 = await state(page);
	h.check(s0.tier === 'pc', `1. premise: the pc tier (${s0.tier})`);
	h.check(s0.mode === 'auto' && (s0.stored === null || s0.stored === 'auto'), `1. Auto by default (${s0.mode}, stored ${s0.stored})`);
	h.check(!s0.wanted && s0.live === 0, `1. Auto draws no contact pass (wanted ${s0.wanted}, built ${s0.live})`);
	await openMenu(page);
	const groups = await page.evaluate(() => [...document.querySelectorAll('#preview-menu .pm-g')].map((g) => g.textContent?.trim()));
	const li = groups.indexOf('Look');
	h.check(li >= 0 && groups[li + 1] === 'Draw as' && (li === 0 || groups[li - 1] === 'Cinematic view'), `1. a Look group after the Cinematic view group (${groups.join(' · ')})`);
	const s1 = await state(page);
	h.check(s1.checked === 'preview-contact-mode-auto' && !s1.disabled && /^Off/.test(s1.note ?? ''), `1. the row: Auto checked, enabled, "${s1.note}"`);
	await closeMenu(page);

	// ---- 2. On draws the pass, at Basic ---------------------------------------------------------------------------
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.addObjects.spawnAtPoint('/create Box 0.6 0.6 0.6', [0, 0.3, 0]));
	await page.waitForTimeout(1500);
	await page.keyboard.press('Escape'); // no selection outline in the frames
	await page.waitForTimeout(1500);
	const saveOff = await saveText(page);
	const envAt0 = (await state(page)).envAt;
	// the box's foot, and the frame's own noise floor (two grabs with nothing changed)
	const clip = await h.centeredClip(A, [0, 0, 0], 320);
	const frameAuto = await h.grabFrame(A, clip);
	await page.waitForTimeout(1500);
	const floor = await h.frameDelta(page, frameAuto, await h.grabFrame(A, clip), 6);
	await pick(page, 'on');
	const s2 = await until(() => state(page), (v) => v.mode === 'on' && v.wanted && v.live > 0, '2. On: the pass is built in the post stack', 20000);
	h.check(s2.drawn === 'basic' && s2.stored === 'on', `2. ...in a Basic scene (drawn ${s2.drawn}), stored on this device (${s2.stored})`);
	h.check(/^On/.test(s2.note ?? '') && s2.checked === 'preview-contact-mode-on', `2. the row says On ("${s2.note}")`);
	await closeMenu(page);
	await page.waitForTimeout(1500);
	const frameOn = await h.grabFrame(A, clip);
	const d = await h.frameDelta(page, frameAuto, frameOn, 6);
	h.check(d.changed > Math.max(50, 3 * floor.changed), `2. the frame changes at the box's foot (${d.changed} px over 6, max ${d.max}; noise floor ${floor.changed} px)`);
	await pick(page, 'off');
	await until(() => state(page), (v) => v.mode === 'off' && !v.wanted && v.live === 0, '2. Off: the pass is gone', 20000);
	await closeMenu(page);
	await page.waitForTimeout(1500);
	const frameOff = await h.grabFrame(A, clip);
	const d0 = await h.frameDelta(page, frameAuto, frameOff, 6);
	h.check(d0.changed <= Math.max(50, 3 * floor.changed) && d0.changed < d.changed / 4, `2. counterfactual: Off draws what Auto drew (${d0.changed} px vs On's ${d.changed}, floor ${floor.changed})`);

	// ---- 3. never in the scene file ---------------------------------------------------------------------------------
	const saveOffAgain = await saveText(page);
	await pick(page, 'on');
	await until(() => state(page), (v) => v.live > 0, '3. premise: On again', 20000);
	const saveOn = await saveText(page);
	h.check(saveOn === saveOff && saveOffAgain === saveOff, `3. a save is the same with the switch On, Off and Auto (${saveOn.length} chars)`);
	const named = [...saveOn.matchAll(/.{0,40}contact.{0,40}/gi)].map((m) => m[0]);
	h.check(!/contactShadows/i.test(saveOn), `3. the save carries no contactShadows key (other "contact" words, unchanged On/Off: ${JSON.stringify(named.slice(0, 2))})`);
	h.check((await state(page)).envAt === envAt0, '3. the environment was not re-stamped by the switch');
	// an old scene (no word about the switch, saved before it): loads unchanged, the device keeps its own setting
	const oldScene = await page.evaluate(async () => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		const p = await S.sessions.buildSessionPayload('old-scene');
		p.environment = { preset: 'sunset', exposure: 1.1, customPreset: null, lights: [], changedAt: 1 };
		await S.sessions.applySession(p, { backup: false });
		await new Promise((r) => setTimeout(r, 1500));
		let env;
		S.environment.environment.subscribe((/** @type {any} */ x) => (env = x))();
		const again = await S.sessions.buildSessionPayload('old-scene');
		return { preset: env.preset, exposure: env.exposure, level: env.shadowLevel ?? null, envBack: JSON.stringify(again.environment ?? null) };
	});
	const s3 = await state(page);
	h.check(oldScene.preset === 'sunset' && oldScene.exposure === 1.1 && oldScene.level === null, `3. an old scene loads as written (${JSON.stringify(oldScene).slice(0, 200)})`);
	h.check(s3.mode === 'on' && s3.live > 0, `3. ...and this device keeps its switch (${s3.mode}, built ${s3.live})`);

	// ---- 4. never on the wire ------------------------------------------------------------------------------------------
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1200, height: 800 } } });
	await h.connect(B, A);
	const bBefore = await state(B.page);
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__sent106c = [];
		let pc;
		w.__tp.test.v1.peers.subscribe((/** @type {any} */ v) => (pc = v))();
		const wrap = (/** @type {any} */ o, /** @type {string} */ name) => {
			const f = o[name].bind(o);
			o[name] = (/** @type {any[]} */ ...a) => {
				try {
					w.__sent106c.push(JSON.stringify(a[0]).slice(0, 400));
				} catch {}
				return f(...a);
			};
		};
		if (pc?.send) wrap(pc, 'send');
		if (pc?.broadcast) wrap(pc, 'broadcast');
	});
	await pick(page, 'off');
	await pick(page, 'on');
	await pick(page, 'auto');
	await pick(page, 'on');
	await closeMenu(page);
	await page.waitForTimeout(1500);
	const quiet = (await page.evaluate(() => /** @type {any} */ (window).__sent106c)).length;
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.addObjects.spawnAtPoint('/create Box 0.3 0.3 0.3', [-2, 0.15, 2]));
	await page.waitForTimeout(1500);
	const sent = await page.evaluate(() => /** @type {any} */ (window).__sent106c);
	h.check(sent.length > quiet, `4. premise: the spy sees A's sends (an edit afterwards: ${quiet} -> ${sent.length})`);
	const leaked = sent.filter((/** @type {string} */ m) => /contact/i.test(m));
	h.check(leaked.length === 0, `4. nothing about the switch leaves A (${sent.length} messages, ${leaked.length} name it${leaked.length ? ': ' + leaked[0] : ''})`);
	const bAfter = await state(B.page);
	h.check(bAfter.mode === 'auto' && bAfter.stored === bBefore.stored && !bAfter.wanted && bAfter.live === 0, `4. B's own switch and pass are untouched (${bBefore.mode}/${bBefore.stored} -> ${bAfter.mode}/${bAfter.stored}, built ${bAfter.live})`);
	h.check(bAfter.envAt === bBefore.envAt, `4. B's environment was not re-stamped (${bBefore.envAt} -> ${bAfter.envAt})`);
	await h.closePeer(B);

	// ---- 5. per device: a reload keeps it ------------------------------------------------------------------------------
	await h.freshReload(A);
	await h.answerRestore(A);
	await until(() => state(page), (v) => v.mode === 'on' && v.stored === 'on' && v.live > 0, '5. a reload keeps On and draws the pass again by itself', 60000);

	// ---- 6. tier gating ---------------------------------------------------------------------------------------------------
	for (const tier of ['phone', 'quest']) {
		await page.evaluate((t) => /** @type {any} */ (window).__tp.test.v1.environment.setShadowTierOverride(t), tier);
		await openMenu(page);
		const g = await until(() => state(page), (v) => v.tier === tier && !v.wanted && v.live === 0, `6. as a ${tier}: no pass although the setting says On`, 20000);
		h.check(g.disabled && /^Not (on a phone|in a headset)/.test(g.note ?? ''), `6. ${tier}: the switch is disabled with the reason ("${g.note}")`);
		h.check(g.mode === 'on' && g.stored === 'on', `6. ${tier}: the stored setting is left alone (${g.stored})`);
		await closeMenu(page);
	}
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.environment.setShadowTierOverride(null));
	await until(() => state(page), (v) => v.tier === 'pc' && v.live > 0, '6. back on the pc tier: the pass returns', 20000);

	// ---- 7. the governor drops it first ------------------------------------------------------------------------------------
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		const Q = w.__tp.test.v1.qualityGovernor;
		Q.governorForTest.reset();
		w.__g106 = { t: 1e9 };
		Q.governorForTest.setLevel(0, w.__g106.t);
		// a heavy scene for the desktop budget (the ladder's steps only act on one; the contact pre-step does not ask)
		w.__tp.test.v1.sceneBudget.qualityBaseline.set({ objects: 0, triangles: 0, calls: 5000 });
		/** synthetic frames of `ms` for `dur`, a decision every 250 ms; returns the moves @param {number} dur @param {number} ms */
		w.__g106drive = (dur, ms) => {
			const g = Q.governorForTest;
			const moves = [];
			const end = w.__g106.t + dur;
			let next = w.__g106.t + 250;
			while (w.__g106.t < end) {
				w.__g106.t += ms;
				g.frame(ms, w.__g106.t);
				if (w.__g106.t >= next) {
					next = w.__g106.t + 250;
					const d = Q.decideNow(w.__g106.t);
					if (d.moved) moves.push({ level: d.level, step: d.step ?? null, moved: d.moved });
				}
			}
			return moves;
		};
	});
	await openMenu(page);
	const m1 = await page.evaluate(() => /** @type {any} */ (window).__g106drive(2600, 60));
	h.check(m1.length === 1 && m1[0].step === 'contact' && m1[0].level === 0, `7. the first overload takes contact off and nothing else (${JSON.stringify(m1)})`);
	const g1 = await until(() => state(page), (v) => v.contactOff && v.level === 0 && v.live === 0 && !v.shadowsOff, '7. contact off at level 0: the pass leaves the stack, shadows stay', 20000);
	h.check(g1.labels[0] === 'Contact shadows off' && g1.note === 'Off for now to keep it smooth', `7. the labels and the row say so (${JSON.stringify(g1.labels)}, "${g1.note}")`);
	// the contact step published level 0, which forgets the full-quality baseline: the heavy premise again
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.sceneBudget.qualityBaseline.set({ objects: 0, triangles: 0, calls: 5000 }));
	const m2 = await page.evaluate(() => /** @type {any} */ (window).__g106drive(3600, 60));
	h.check(m2.length >= 1 && m2[0].level === 1 && m2[0].step === null, `7. the next overload is step 1 (${JSON.stringify(m2)})`);
	const g2 = await state(page);
	h.check(g2.shadowsOff && g2.contactOff, `7. step 1 = shadows off, contact still off (${g2.shadowsOff}, ${g2.contactOff})`);
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.qualityGovernor.releaseQuality());
	await until(() => state(page), (v) => !v.contactOff && !v.shadowsOff && v.level === 0 && v.live > 0, '7. "Restore full quality" gives both back (the pass returns)', 20000);
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__tp.test.v1.sceneBudget.qualityBaseline.set(null);
		w.__tp.test.v1.qualityGovernor.governorForTest.reset();
	});
	await closeMenu(page);

	// ---- 8. the measured cost ------------------------------------------------------------------------------------------------
	const meter = () => page.evaluate(async () => (await /** @type {any} */ (window).__tp.test.v1.contactCost).contactMeterDebug());
	await openMenu(page); // the menu starts the meter on the pc tier (the chunk already has)
	await page.waitForTimeout(500);
	const m0 = await meter();
	if (!m0.timer) {
		console.log(`  8. REPORT: no GPU timer here (EXT_disjoint_timer_query_webgl2): the row shows no cost (${JSON.stringify(m0)})`);
	} else {
		await pick(page, 'off');
		await until(meter, (v) => v.off >= 20, '8. frames without the pass sampled', 120000);
		await pick(page, 'on');
		// the kept number is the meter's own difference now (the stale-sample trap chain 1 found: 6.3 kept, 0.07 measured)
		const mc = await until(meter, (v) => v.on >= 20 && !!v.stored && v.cost && Math.abs(v.stored.ms - v.cost.ms) < 0.3, '8. frames with the pass sampled, the kept cost = the measured difference', 120000);
		const row = await until(() => state(page), (v) => /costs (about \d+ ms|under 1 ms)/.test(v.note ?? ''), '8. the row shows the measured cost', 15000);
		const kept = await page.evaluate(() => localStorage.getItem('contactShadowsCost'));
		h.check(!!kept && JSON.parse(kept).pixels > 0, `8. kept in localStorage (${kept}); "${row.note}"; on ${mc.onMs?.toFixed?.(2)} ms vs off ${mc.offMs?.toFixed?.(2)} ms GPU`);
	}
	await closeMenu(page);

	// ---- FRAMES: the frame row --------------------------------------------------------------------------------------------
	if (FRAMES) {
		await page.evaluate(fs.readFileSync(path.join(__dirname, 'shadow-s0-106.page.js'), 'utf8'));
		const result = { device: DEVICE, at: new Date().toISOString(), gpu: GPU, scenes: /** @type {any} */ ({}) };
		for (const slug of ['product-shot', 'castle-courtyard']) {
			const load = await page.evaluate((s) => /** @type {any} */ (window).__s0.load(s), slug);
			console.log(`  frames: ${slug} loaded ${JSON.stringify({ ok: load.ok, objects: load.objects })}`);
			const rows = [];
			for (const mode of ['off', 'on', 'off', 'on']) {
				await page.evaluate((m) => /** @type {any} */ (window).__tp.test.v1.lightParams.contactShadowsMode.set(m), mode);
				await page.waitForTimeout(2500);
				await page.evaluate(async () => (await /** @type {any} */ (window).__tp.test.v1.contactCost).contactMeterReset());
				const r = await page.evaluate(async (sampleMs) => {
					const S = /** @type {any} */ (window).__tp.test.v1;
					const xs = [];
					let last = performance.now();
					const end = last + sampleMs;
					await new Promise((res) => {
						const step = (/** @type {number} */ t) => {
							xs.push(t - last);
							last = t;
							if (t < end) requestAnimationFrame(step);
							else res(undefined);
						};
						requestAnimationFrame(step);
					});
					const s = [...xs].sort((a, b) => a - b);
					const q = (/** @type {number} */ p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
					const cs = await S.contactShadows;
					const m = (await S.contactCost).contactMeterDebug();
					return { live: cs.contactEffectsLive(), frames: xs.length, median: q(0.5), p95: q(0.95), over20: xs.filter((x) => x > 20).length, drawn: S.environment.drawnSceneShadowLevel(), gpuMs: m.onMs ?? m.offMs, gpuSamples: m.on + m.off };
				}, 6000);
				rows.push({ mode, ...r });
				console.log(`  frames: ${slug} contact ${mode}: ${JSON.stringify(r)}`);
			}
			result.scenes[slug] = { load: { ok: load.ok, objects: load.objects }, rows };
			fs.writeFileSync(path.join(OUT, `frames-${DEVICE}.json`), JSON.stringify(result, null, 1));
		}
		h.check(Object.values(result.scenes).every((/** @type {any} */ s) => s.rows.some((/** @type {any} */ r) => r.mode === 'on' && r.live > 0)), `FRAMES: rows written to ${path.join(OUT, `frames-${DEVICE}.json`)} (the pass was in the stack for every On row)`);
	}

	h.check((await h.pageErrors(A)).length === 0, `no page errors (${(await h.pageErrors(A)).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
