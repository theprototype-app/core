// 38 R1 — THE SETTINGS LOCK. Every row of every Settings section keeps its storage key, its
// default, its scope (device vs shared) and its side effects through the UI redesign
// (SPEC §0: "Every setting's storage key, default, scope and side effects").
//
// HOW: on a fresh profile the suite opens each section, finds every row (by its NAME — the
// handoff's settings-inventory.json is the list), and EXERCISES every control in the row's
// control cell: a toggle flips, a select picks the next option, a slider/number steps, a
// colour/text field takes a new value, a segmented control presses each other option, a
// button is pressed. Around each exercise it takes the side-effect fingerprint
// (lockHelpers.effectsOf): localStorage written (key + value — the key AND the default it
// replaced), peer messages broadcast (= SHARED scope), debug-hook stores that moved,
// <html>/<body> attributes, dialogs opened, downloads and file choosers. Then it puts the
// control back and checks the control reads its default again.
//
//   LOCK_RECORD=1 node tests/e2e/lock-settings.test.cjs   records fixtures/lock/settings.json
//                                                        (two fresh passes, intersected)
//   npm run e2e -- lock-settings                          verifies against it
//
// A redesign lane that turns a checkbox into a Toggle, a flowbite select into Segmented, or
// moves a row into a sub-section keeps this green with NO fixture change: controls are found
// by role (checkbox/switch/aria-pressed/listbox/range/…), rows by name. A row that changes
// SECTION is reported as a WARN line (structure), never silently.
const h = require('./helpers.cjs');
const L = require('./lockHelpers.cjs');

const VIEWPORT = { width: 1440, height: 900 };
// The verify run is split in two suites so each stays well under the runner's 8-minute cap:
// lock-settings = part A (the first five sections), lock-settings-b = part B (the rest + the
// 390x844 pass). A record always sweeps everything.
const PART_A = ['Interface', 'Controls', 'Input', 'Touch controls', 'Scene'];
const PART = L.RECORD ? 'all' : process.env.LOCK_SETTINGS_PART || 'a';
/** @param {string} section */
const inPart = (section) => PART === 'all' || (PART === 'a') === PART_A.includes(section);
const SETTLE = 450;
/** buttons whose effect is reloading the page (the probes would not survive it) */
const RELOADS = new Set(['peer-server-reload']);
// Messages that are presence/telemetry and fire on their own (camera pose, look, cursor…):
// they never count as a setting's effect.
const PRESENCE = new Set(['camera', 'vrhands', 'cursor', 'atscene', 'look', 'perflive', 'userdata', 'playmode']);
// Stores that move on their own are found by sampling idle windows (learnNoise) and by
// intersecting two record passes, never by name: a name list hid real effects (every
// "quality" and "perf" setting).
// in-page: describe the rows of the open section and tag every control
function describeRows({ ROW_SEL, NAME_SEL, CONTROL_SEL, FIELD_SEL }) {
	const visible = (/** @type {Element} */ el) => {
		const r = el.getBoundingClientRect();
		return !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && (r.width > 0 || r.height > 0);
	};
	const kindOf = (/** @type {any} */ el) => {
		const tag = el.tagName.toLowerCase();
		const type = (el.getAttribute('type') || '').toLowerCase();
		const role = el.getAttribute('role') || '';
		if (tag === 'input' && type === 'checkbox') return 'toggle';
		if (role === 'switch' || role === 'checkbox') return 'toggle';
		if (tag === 'select' || role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'select';
		if ((tag === 'input' && type === 'range') || role === 'slider') return 'range';
		if (tag === 'input' && type === 'number') return 'number';
		if (tag === 'input' && type === 'color') return 'color';
		if (tag === 'input' && type === 'file') return 'file';
		if (tag === 'textarea' || (tag === 'input' && (type === 'text' || type === '' || type === 'search' || type === 'url'))) return 'text';
		if (role === 'radio' || (tag === 'button' && el.hasAttribute('aria-pressed') && el.closest('[role=group], [role=radiogroup], .tp-seg'))) return 'segment';
		if (tag === 'button' && el.hasAttribute('aria-pressed')) return 'toggle';
		if (tag === 'button' || tag === 'a') return 'button';
		return 'other';
	};
	const stateOf = (/** @type {any} */ el, /** @type {string} */ kind) => {
		if (kind === 'toggle') return el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
		if (kind === 'segment') return el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
		if (kind === 'select') {
			if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text?.trim() ?? '';
			return (el.textContent || '').replace(/▾/g, '').trim();
		}
		if (kind === 'button') return (el.textContent || el.getAttribute('aria-label') || '').trim();
		if (kind === 'file') return '';
		return el.value ?? '';
	};
	document.querySelectorAll('[data-lock-row]').forEach((e) => e.removeAttribute('data-lock-row'));
	document.querySelectorAll('[data-lock-ctl]').forEach((e) => e.removeAttribute('data-lock-ctl'));
	const rows = [...document.querySelectorAll(ROW_SEL)].filter(visible);
	return rows.map((row, r) => {
		row.setAttribute('data-lock-row', String(r));
		const name = (row.querySelector(NAME_SEL)?.textContent || '').trim();
		const cell = row.querySelector(CONTROL_SEL);
		/** @type {any[]} */
		const controls = [];
		const seen = new Set();
		const collect = (/** @type {Element|null} */ root, /** @type {string} */ where) => {
			if (!root) return;
			for (const el of root.querySelectorAll(FIELD_SEL)) {
				if (seen.has(el)) continue;
				seen.add(el);
				const kind = kindOf(el);
				if (kind !== 'file' && !visible(el) && !(kind === 'toggle' && el.closest('label') && visible(el.closest('label')))) continue;
				const i = controls.length;
				el.setAttribute('data-lock-ctl', r + ':' + i);
				controls.push({
					i,
					ord: controls.filter((x) => x.kind === kind && x.where === where).length,
					where,
					kind,
					id: el.id || '',
					label: (el.getAttribute('aria-label') || (kind === 'button' || kind === 'segment' ? el.textContent : '') || '').trim().slice(0, 60),
					state: stateOf(el, kind),
					disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'
				});
			}
		};
		collect(cell, 'control');
		// rows with no control cell (lists, forms, tiles) keep their controls in the body:
		// LOCKED BY PRESENCE (kind, id, state), not exercised — they open forms/sub-pages
		collect(row, cell ? 'body' : 'body');
		return { r, name, controls };
	});
}

/** @param {any} page @param {string} sel */
async function readState(page, sel) {
	return page.evaluate(
		({ sel }) => {
			const el = /** @type {any} */ (document.querySelector(sel));
			if (!el) return { gone: true };
			const role = el.getAttribute('role') || '';
			const type = (el.getAttribute('type') || '').toLowerCase();
			if ((el.tagName === 'INPUT' && type === 'checkbox') || role === 'switch' || role === 'checkbox')
				return el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
			if (el.hasAttribute('aria-pressed') && el.tagName === 'BUTTON' && el.closest('[role=group], [role=radiogroup], .tp-seg'))
				return el.getAttribute('aria-pressed') === 'true';
			if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text?.trim() ?? '';
			if (el.getAttribute('aria-haspopup') === 'listbox') return (el.textContent || '').replace(/▾/g, '').trim();
			if (el.tagName === 'BUTTON' || el.tagName === 'A') return (el.textContent || el.getAttribute('aria-label') || '').trim();
			return el.value ?? '';
		},
		{ sel }
	);
}

/** Press a control the way a person would where it can be pressed, else through the element.
 * @param {any} page @param {string} sel */
async function press(page, sel) {
	const loc = page.locator(sel);
	const box = await loc.boundingBox().catch(() => null);
	if (box && box.width > 2 && box.height > 2) {
		await loc.scrollIntoViewIfNeeded().catch(() => {});
		try {
			await loc.click({ timeout: 2500 });
			return;
		} catch {}
	}
	await page.evaluate((s) => /** @type {any} */ (document.querySelector(s))?.click(), sel);
}

/** Pick option `index` of a select control (native or listbox popup). @param {any} page @param {string} sel @param {number|string} want */
async function pickOption(page, sel, want) {
	const native = await page.evaluate((s) => document.querySelector(s)?.tagName === 'SELECT', sel);
	if (native) {
		const options = await page.evaluate((s) => [.../** @type {any} */ (document.querySelector(s)).options].map((o) => o.text.trim()), sel);
		const idx = typeof want === 'number' ? want : options.indexOf(want);
		if (idx < 0) return null;
		await page.locator(sel).selectOption({ index: idx });
		return options[idx];
	}
	await press(page, sel);
	const list = page.locator('[role=listbox]:visible').last();
	await list.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
	const options = await list.locator('[role=option]').allTextContents().catch(() => []);
	const clean = options.map((t) => t.trim());
	const idx = typeof want === 'number' ? want : clean.indexOf(want);
	if (idx < 0 || idx >= clean.length) {
		await press(page, sel);
		return null;
	}
	await list.locator('[role=option]').nth(idx).click();
	return clean[idx];
}

/** The option list of a select (to pick "the next one"). @param {any} page @param {string} sel */
async function optionsOf(page, sel) {
	const native = await page.evaluate((s) => document.querySelector(s)?.tagName === 'SELECT', sel);
	if (native) return page.evaluate((s) => [.../** @type {any} */ (document.querySelector(s)).options].map((o) => o.text.trim()), sel);
	await press(page, sel);
	const list = page.locator('[role=listbox]:visible').last();
	await list.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
	const options = (await list.locator('[role=option]').allTextContents().catch(() => [])).map((t) => t.trim());
	// close it the way it opened (the button toggles). Never Escape here: it also reaches the
	// Settings window's own key handling.
	await press(page, sel);
	await page.waitForTimeout(120);
	return options;
}

/** Step a range/number by one step up (or down at the top). @param {any} page @param {string} sel @param {1|-1} dir */
async function stepField(page, sel, dir) {
	return page.evaluate(
		({ sel, dir }) => {
			const el = /** @type {any} */ (document.querySelector(sel));
			if (!el) return null;
			const before = el.value;
			try {
				if (dir > 0) el.stepUp();
				else el.stepDown();
			} catch {
				const step = Number(el.step) || 1;
				el.value = String(Number(el.value) + dir * step);
			}
			if (el.value === before) return null;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return el.value;
		},
		{ sel, dir }
	);
}

/** Set a value field (colour/text/number) and fire input + change. @param {any} page @param {string} sel @param {string} value */
async function setValue(page, sel, value) {
	await page.evaluate(
		({ sel, value }) => {
			const el = /** @type {any} */ (document.querySelector(sel));
			if (!el) return;
			el.focus?.();
			el.value = value;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			el.blur?.();
		},
		{ sel, value }
	);
}

/** Close whatever a button opened: Escape twice, then an outside click on the backdrop side. @param {any} page */
async function dismiss(page) {
	for (let i = 0; i < 2; i++) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(150);
	}
}

async function openSettings(page, section) {
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.locator('#settings-nav').waitFor({ state: 'visible', timeout: 10000 });
	const row = page.locator(`#settings-nav .sn-row[data-section="${section}"]`);
	await row.click();
	await page.waitForTimeout(350);
}

/**
 * One pass over every section. Returns {sections: {label: {rows: [...]}}}.
 * @param {any} browser @param {string} tag
 */
async function sweep(browser, tag) {
	const P = await h.setupPage(browser, tag, {
		context: { viewport: VIEWPORT, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true }
	});
	let page = P.page;
	/** @type {string[]} */
	let events = [];
	const listen = (/** @type {any} */ p) => {
		p.on('download', () => events.push('download'));
		p.on('filechooser', () => events.push('filechooser'));
		p.on('dialog', (/** @type {any} */ d) => {
			events.push('native-dialog');
			d.dismiss().catch(() => {});
		});
	};
	listen(page);
	await L.installProbes(page);
	/** @type {Set<string>} */
	const noisy = new Set();
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.locator('#settings-nav').waitFor({ state: 'visible', timeout: 15000 });
	await page.waitForTimeout(600);
	await L.learnNoise(page, noisy, 1200);
	await L.learnNoise(page, noisy, 800);
	const nav = (await page.evaluate(() => [...document.querySelectorAll('#settings-nav .sn-row')].map((b) => b.getAttribute('data-section') || ''))).filter(inPart);
	/** @type {Record<string, any>} */
	const sections = {};

	/** re-open after anything that closed Settings or left a dialog over it */
	const recover = async (/** @type {string} */ section) => {
		const ok = await page.evaluate(() => {
			let open;
			window.__stores.settingsOpen.subscribe((v) => (open = v))();
			return open;
		});
		const extra = await page.evaluate(
			() => [...document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]')].filter((d) => d.getClientRects().length && !d.closest('#settings-modal, .settings-window') && !d.querySelector('#settings-nav')).length
		);
		if (ok && !extra) return;
		await dismiss(page);
		await page.evaluate(() => window.__stores.settingsOpen.set(true));
		await page.waitForTimeout(300);
		await openSettings(page, section);
	};

	/** the selector of control `c` of the row named `name`, after a fresh tagging pass
	 * @param {string} name @param {any} c */
	const refind = async (name, c) => {
		const rows = await page.evaluate(describeRows, { ROW_SEL: L.ROW_SEL, NAME_SEL: L.NAME_SEL, CONTROL_SEL: L.CONTROL_SEL, FIELD_SEL: L.FIELD_SEL });
		const r = rows.find((/** @type {any} */ x) => x.name === name);
		if (!r) return '[data-lock-none]';
		let m = c.id ? r.controls.find((/** @type {any} */ x) => x.id === c.id) : null;
		if (!m) {
			const ord = c.ord ?? 0;
			m = r.controls.filter((/** @type {any} */ x) => x.kind === c.kind && x.where === c.where)[ord];
		}
		return m ? `[data-lock-ctl="${r.r}:${m.i}"]` : '[data-lock-none]';
	};

	for (const section of nav) {
		await openSettings(page, section);
		await L.learnNoise(page, noisy, 300);
		const rows = await page.evaluate(describeRows, { ROW_SEL: L.ROW_SEL, NAME_SEL: L.NAME_SEL, CONTROL_SEL: L.CONTROL_SEL, FIELD_SEL: L.FIELD_SEL });
		const out = [];
		for (const row of rows) {
			/** @type {any[]} */
			const controls = [];
			for (const c of row.controls) {
				const entry = { kind: c.kind, id: c.id, label: c.label, where: c.where, default: c.state, disabled: c.disabled };
				controls.push(entry);
				if (c.where !== 'control' || c.disabled || c.kind === 'file' || c.kind === 'other') continue;
				// the rows may have re-rendered (another control showed or hid a row): re-find this
				// control by row NAME and its id (else kind + position among that kind)
				const sel = await refind(row.name, c);
				if (!(await page.locator(sel).count())) {
					if (process.env.LOCK_DEBUG) console.log(`  LOST ${section} › ${row.name} [${c.kind}]`);
					entry.exercise = 'lost';
					continue;
				}
				const doExercise = async () => {
					if (c.kind === 'toggle') {
						await press(page, sel);
						return null;
					}
					if (c.kind === 'segment') {
						if (c.state) return 'skip';
						await press(page, sel);
						return null;
					}
					if (c.kind === 'select') {
						const options = await optionsOf(page, sel);
						entry.options = options;
						const at = options.indexOf(String(c.state));
						if (options.length < 2) return 'skip';
						const next = (at + 1) % options.length;
						const picked = await pickOption(page, sel, next);
						return picked === null ? 'skip' : null;
					}
					if (c.kind === 'range' || c.kind === 'number') {
						let v = await stepField(page, sel, 1);
						entry.dir = 1;
						if (v === null) {
							v = await stepField(page, sel, -1);
							entry.dir = -1;
						}
						return v === null ? 'skip' : null;
					}
					if (c.kind === 'color') {
						await setValue(page, sel, String(c.state).toLowerCase() === '#123456' ? '#654321' : '#123456');
						return null;
					}
					if (c.kind === 'text') {
						await setValue(page, sel, 'lock-' + row.name.toLowerCase().replace(/[^a-z]+/g, '-'));
						return null;
					}
					if (c.kind === 'button') {
						// a button that RELOADS the app (1.26: Connection ▸ Apply changes) takes the
						// sweep's probes with it — its effect is the reload; recorded as a skip
						if (RELOADS.has(c.id)) return 'skip';
						await press(page, sel);
						return null;
					}
					return 'skip';
				};
				const undo = async () => {
					if (c.kind === 'toggle') return press(page, sel);
					if (c.kind === 'segment') {
						// press back the option that was on
						const was = row.controls.find((/** @type {any} */ o) => o.kind === 'segment' && o.state);
						if (was) return press(page, await refind(row.name, was));
						return;
					}
					if (c.kind === 'select') return pickOption(page, sel, String(c.state));
					// set the original back (a step back from a rounded/clamped value does not round-trip)
					if (c.kind === 'range' || c.kind === 'number') return setValue(page, sel, String(c.state));
					if (c.kind === 'color' || c.kind === 'text') return setValue(page, sel, String(c.state));
				};
				await L.learnNoise(page, noisy, 200);
				events = [];
				const before = await L.snap(page);
				if (process.env.LOCK_DEBUG) console.log(`  ${section} › ${row.name} [${c.kind}${c.id ? ' #' + c.id : ''}] = ${JSON.stringify(c.state)}`);
				// a control whose exercise hangs (a popup that never opens) must not take the
				// whole sweep with it: it is recorded as 'timeout' and the page recovered
				const skipped = await Promise.race([doExercise(), L.sleep(15000).then(() => 'timeout')]);
				if (skipped === 'timeout') {
					entry.exercise = 'timeout';
					console.log(`  TIMEOUT ${section} › ${row.name} [${c.kind}]`);
					await dismiss(page);
					await recover(section);
					continue;
				}
				if (skipped === 'skip') {
					entry.exercise = 'skip';
					continue;
				}
				await page.waitForTimeout(c.kind === 'button' ? 900 : SETTLE);
				const after = await L.snap(page);
				const sent = (await L.sentSince(page, before.sent)).filter((t) => !PRESENCE.has(t));
				const fx = L.effectsOf(before, after, sent, new Set([...noisy].filter(() => true)));
				entry.state = await readState(page, sel);
				entry.effects = { ...fx, events: [...new Set(events)].sort() };
				entry.scope = fx.broadcasts.length ? 'shared' : 'device';
				// put it back
				if (c.kind === 'button') {
					await dismiss(page);
					await recover(section);
				} else {
					await undo();
					await page.waitForTimeout(SETTLE);
					entry.restored = await readState(page, await refind(row.name, c));
					const back = await L.snap(page);
					/** storage after the round trip: a toggle flipped twice may leave the default WRITTEN */
					entry.storageAfterRestore = Object.fromEntries(
						L.changedKeys(before.ls, back.ls)
							.filter((k) => !noisy.has('ls:' + k))
							.map((k) => [k, k in back.ls ? back.ls[k] : null])
					);
				}
				entry.exercise = 'done';
			}
			out.push({ name: row.name, controls });
		}
		sections[section] = { rows: out };
		console.log(`[${tag}] ${section}: ${out.length} rows`);
	}
	await P.ctx.close();
	return { sections, noisy: [...noisy].sort() };
}

/**
 * The phone layout (390x844, touch): every row and every control's default, by section — no
 * exercising (behaviour is locked at desktop). Sections are reached through the deep-link
 * store the app's own links use, since the narrow layout swaps the sidebar for chips.
 * @param {any} browser
 */
async function presence(browser) {
	const P = await h.setupPage(browser, 'mobile', { context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
	const page = P.page;
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForTimeout(800);
	/** @type {Record<string, any[]>} */
	const out = {};
	for (const label of Object.keys(require('./fixtures/lock/settings-inventory.json'))) {
		const key = label.toLowerCase().replace(/[^a-z0-9]/g, '');
		await page.evaluate((k) => {
			window.__stores.settingsSection.set(null);
			window.__stores.settingsSection.set(k);
		}, key);
		await page.waitForTimeout(500);
		const rows = await page.evaluate(describeRows, { ROW_SEL: L.ROW_SEL, NAME_SEL: L.NAME_SEL, CONTROL_SEL: L.CONTROL_SEL, FIELD_SEL: L.FIELD_SEL });
		out[label] = rows.map((/** @type {any} */ r) => ({
			name: r.name,
			controls: r.controls.filter((/** @type {any} */ c) => c.where === 'control').map((/** @type {any} */ c) => ({ kind: c.kind, id: c.id, default: c.state }))
		}));
	}
	await P.ctx.close();
	return out;
}

/** Merge two record passes: keep only what BOTH saw (an effect seen once is noise). */
function intersect(a, b) {
	const out = { sections: {} };
	for (const [section, sa] of Object.entries(a.sections)) {
		const sb = b.sections[section] ?? { rows: [] };
		out.sections[section] = {
			rows: sa.rows.map((/** @type {any} */ row) => {
				const rb = sb.rows.find((/** @type {any} */ r) => r.name === row.name);
				return {
					name: row.name,
					controls: row.controls.map((/** @type {any} */ c, /** @type {number} */ i) => {
						const cb = rb?.controls?.[i];
						if (!c.effects || !cb?.effects) return c;
						const fx = c.effects;
						const gx = cb.effects;
						/** @type {Record<string, any>} */
						const stores = {};
						for (const [k, v] of Object.entries(fx.stores)) {
							if (!(k in gx.stores)) continue;
							stores[k] = JSON.stringify(v) === JSON.stringify(gx.stores[k]) ? v : '<varies>';
						}
						/** @type {Record<string, any>} */
						const storage = {};
						for (const [k, v] of Object.entries(fx.storage)) {
							if (!(k in gx.storage)) continue;
							storage[k] = v === gx.storage[k] ? v : '<varies>';
						}
						const both = (/** @type {string[]} */ x, /** @type {string[]} */ y) => x.filter((t) => y.includes(t));
						return {
							...c,
							effects: {
								storage,
								stores,
								html: both(fx.html, gx.html),
								body: both(fx.body, gx.body),
								dialogs: both(fx.dialogs, gx.dialogs),
								broadcasts: both(fx.broadcasts, gx.broadcasts),
								events: both(fx.events, gx.events)
							},
							scope: both(fx.broadcasts, gx.broadcasts).length ? 'shared' : 'device'
						};
					})
				};
			})
		};
	}
	return out;
}

/**
 * A row's defaults by MEANING: toggles as on/off, a choice as the label shown (a select's
 * text, or the pressed option of a segmented control), value fields as their values.
 * @param {any[]} controls
 */
function rowDefaults(controls) {
	const own = controls.filter((c) => c.where === 'control');
	return {
		toggles: own.filter((c) => c.kind === 'toggle').map((c) => !!c.default),
		choices: [
			...own.filter((c) => c.kind === 'select').map((c) => String(c.default)),
			...own.filter((c) => c.kind === 'segment' && c.default).map((c) => String(c.label || ''))
		],
		values: own.filter((c) => ['range', 'number', 'color', 'text'].includes(c.kind)).map((c) => String(c.default).toLowerCase())
	};
}

/**
 * Does live control `x` do what recorded control `c` did? Storage writes exact (key AND
 * value, unless the record saw the value vary), every recorded store change present with
 * the same primitive value, every recorded broadcast still sent, every page effect (html /
 * body attributes, dialogs, downloads, file choosers) still there.
 * @param {any} c @param {any} x @returns {{ok: boolean, why: string}}
 */
function sameEffects(c, x) {
	const want = c.effects;
	const got = x.effects;
	const why = [];
	const keysOk = JSON.stringify(Object.keys(want.storage).sort()) === JSON.stringify(Object.keys(got.storage).sort());
	const valsOk = Object.entries(want.storage).every(([k, v]) => v === '<varies>' || got.storage[k] === v);
	if (!keysOk || !valsOk) why.push(`storage expected ${JSON.stringify(want.storage)} got ${JSON.stringify(got.storage)}`);
	const lostStores = Object.entries(want.stores).filter(([k, v]) => !(k in got.stores) || (v !== '<varies>' && v !== '<object>' && v !== '<changed>' && JSON.stringify(got.stores[k]) !== JSON.stringify(v)));
	if (lostStores.length) why.push(`side effects lost/changed ${JSON.stringify(Object.fromEntries(lostStores))} (now ${JSON.stringify(got.stores)})`);
	const lostMsgs = want.broadcasts.filter((/** @type {string} */ t) => !got.broadcasts.includes(t));
	if (lostMsgs.length) why.push(`no longer broadcasts ${lostMsgs.join(',')} (scope was ${c.scope})`);
	const lostDom = [
		...want.html.filter((/** @type {string} */ a) => !got.html.includes(a)).map((/** @type {string} */ a) => 'html@' + a),
		...want.body.filter((/** @type {string} */ a) => !got.body.includes(a)).map((/** @type {string} */ a) => 'body@' + a),
		...want.dialogs.filter((/** @type {string} */ d) => !got.dialogs.includes(d)).map((/** @type {string} */ d) => 'dialog ' + d),
		...want.events.filter((/** @type {string} */ e) => !got.events.includes(e))
	];
	if (lostDom.length) why.push(`page effects lost ${lostDom.join(', ')}`);
	return { ok: why.length === 0, why: why.join('\n      ') };
}

h.run(async () => {
	const browser = await L.launch();
	const inventory = require('./fixtures/lock/settings-inventory.json');

	if (L.RECORD) {
		const one = await sweep(browser, 'record-1');
		// LOCK_PASSES=1 is for iterating on the suite itself, never for a committed record
		const two = process.env.LOCK_PASSES === '1' ? one : await sweep(browser, 'record-2');
		const merged = intersect(one, two);
		const mobile = await presence(browser);
		L.writeFixture('settings', { recordedAt: new Date().toISOString(), viewport: VIEWPORT, ...merged, mobile });
		await h.finish(browser);
		return;
	}

	const fixture = L.readFixture('settings');
	h.check(!!fixture, 'the recorded settings lock exists (tests/e2e/fixtures/lock/settings.json)');
	if (!fixture) return h.finish(browser);
	const now = await sweep(browser, 'verify');

	// 1. every inventory row still exists, in its section (a move is a WARN)
	/** @type {Map<string, string>} */
	const where = new Map();
	for (const [section, s] of Object.entries(now.sections)) for (const r of s.rows) where.set(section + '\u0000' + r.name, section);
	const allNames = new Map();
	for (const [section, s] of Object.entries(now.sections)) for (const r of s.rows) allNames.set(r.name, section);
	let missing = 0;
	for (const [section, rows] of Object.entries(inventory).filter(([sec]) => inPart(sec))) {
		for (const row of rows) {
			if (where.has(section + '\u0000' + row.name)) continue;
			if (allNames.has(row.name)) {
				console.log(`WARN settings row "${row.name}" moved from ${section} to ${allNames.get(row.name)}`);
				continue;
			}
			missing++;
			h.check(false, `settings row "${row.name}" (${section}) still exists`);
		}
	}
	h.check(missing === 0, `all ${Object.entries(inventory).filter(([sec]) => inPart(sec)).flatMap(([, r]) => r).length} inventory rows of this part are present`);

	// 1b. the phone layout keeps every row and every control default
	if (fixture.mobile && PART !== 'a') {
		const phone = await presence(browser);
		for (const [section, rows] of Object.entries(fixture.mobile)) {
			for (const row of rows) {
				const live = Object.values(phone).flat().find((/** @type {any} */ r) => r.name === row.name);
				if (!live) {
					h.check(false, `390x844: settings row "${row.name}" (${section}) is there`);
					continue;
				}
				const shape = (/** @type {any[]} */ cs) => JSON.stringify(cs.map((c) => [c.kind, c.default]));
				h.check(shape(live.controls) === shape(row.controls), `390x844: ${section} › ${row.name} has the same controls and defaults` + (shape(live.controls) === shape(row.controls) ? '' : `\n      expected ${shape(row.controls)}\n      actual   ${shape(live.controls)}`));
			}
		}
	}

	// 2. every row: the same DEFAULTS and the same EFFECTS — compared per row, not per control
	// type, so a checkbox becoming a Toggle or a dropdown becoming Segmented changes nothing
	// here while a lost storage write, a new default or a missing side effect fails.
	for (const [section, s] of Object.entries(fixture.sections).filter(([sec]) => inPart(sec))) {
		for (const row of s.rows) {
			const nowSection = where.has(section + '\u0000' + row.name) ? section : allNames.get(row.name);
			const live = nowSection ? now.sections[nowSection].rows.find((/** @type {any} */ r) => r.name === row.name) : null;
			if (!live) continue; // reported above
			const tag = `${section} › ${row.name}`;
			L.same(h.check, `${tag}: defaults`, rowDefaults(row.controls), rowDefaults(live.controls));
			// the CHOICES offered (a dropdown's options, a segmented control's buttons) — no option lost
			const offered = (/** @type {any[]} */ cs) =>
				[...new Set(cs.flatMap((c) => (c.kind === 'select' ? c.options ?? [] : c.kind === 'segment' ? [c.label] : [])).map((o) => String(o).toLowerCase()))].sort();
			if (offered(row.controls).length) L.same(h.check, `${tag}: the choices offered`, offered(row.controls), offered(live.controls));
			const liveFx = live.controls.filter((/** @type {any} */ c) => c.effects);
			for (const c of row.controls) {
				if (!c.effects) continue;
				const label = `${tag} [${c.kind}${c.id ? ' #' + c.id : c.label ? ' "' + c.label + '"' : ''}]`;
				const m = liveFx.find((/** @type {any} */ x) => sameEffects(c, x).ok) ?? null;
				if (m) {
					h.check(true, `${label}: ${Object.keys(c.effects.storage).join(',') || 'no storage'} · ${c.scope}${Object.keys(c.effects.stores).length ? ' · ' + Object.keys(c.effects.stores).length + ' side effects' : ''}`);
					continue;
				}
				// the nearest live control (same id, else same kind) explains what differs
				const near = liveFx.find((/** @type {any} */ x) => c.id && x.id === c.id) ?? liveFx.find((/** @type {any} */ x) => x.kind === c.kind) ?? liveFx[0];
				h.check(false, `${label}: no control in the row still does what it did\n      ${near ? sameEffects(c, near).why : 'the row has no operable control'}`);
			}
			// every live control reads its default again once put back (the round trip works)
			for (const x of live.controls) {
				if (!('restored' in x)) continue;
				h.check(JSON.stringify(x.restored) === JSON.stringify(x.default), `${tag} [${x.kind}${x.id ? ' #' + x.id : ''}]: reads its default again after being put back (${JSON.stringify(x.restored)})`);
			}
		}
	}
	await h.finish(browser);
});
