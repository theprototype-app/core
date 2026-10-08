// 38 R1 — THE BEHAVIOUR LOCK's shared plumbing (the `lock-*` suites).
//
// The UI redesign (roadmap 38, cloud docs/design/redesign/SPEC.md §0) may change how
// everything LOOKS and must not change what anything DOES. These suites were recorded
// against the pre-redesign UI and every redesign PR keeps them green.
//
// TWO KINDS OF CHECK live in the lock suites:
//   · hand-written assertions (DragRow scrubbing, shortcut routing, dock behaviour);
//   · RECORDED ones: a suite walks a surface, writes what it observed into
//     tests/e2e/fixtures/lock/<name>.json (LOCK_RECORD=1), and every later run compares
//     against that file. Re-record ONLY when a behaviour change is intended and agreed —
//     a redesign lane never does (SPEC §0: "split it out").
//
// WHAT A REDESIGN LANE MAY EDIT HERE: the LOCATORS below (ROW_SEL, NAME_SEL, CONTROL_SEL,
// dragFields) when a primitive renames its classes. Never the fixtures, never the
// expectations.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'lock');
const RECORD = process.env.LOCK_RECORD === '1';

/** @param {string} name */
function fixturePath(name) {
	return path.join(FIXTURES, name + '.json');
}
/** @param {string} name @returns {any} */
function readFixture(name) {
	const file = fixturePath(name);
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}
/** @param {string} name @param {any} data */
function writeFixture(name, data) {
	fs.mkdirSync(FIXTURES, { recursive: true });
	fs.writeFileSync(fixturePath(name), JSON.stringify(data, null, '\t') + '\n');
	console.log('LOCK RECORDED ' + path.relative(process.cwd(), fixturePath(name)));
}

// ---- locators (the only part a redesign lane may adapt) -----------------------------
// A settings row: today `SettingRow.svelte` = `.setting-row` with `.sr-name` + `.sr-control`.
const ROW_SEL = '.setting-row, [data-setting-row]';
const NAME_SEL = '.sr-name, [data-setting-name]';
const CONTROL_SEL = '.sr-control, [data-setting-control]';
// what counts as ONE control inside a row's control cell
const FIELD_SEL = [
	'input:not([type=hidden])',
	'select',
	'textarea',
	'button',
	'[role=switch]',
	'[role=checkbox]',
	'[role=radio]',
	'[role=slider]',
	'[role=combobox]'
].join(', ');

/**
 * Every lock suite runs on the GPU backend: on SwiftShader the 3D view behind the panels
 * starves the page (measured: a CDP round trip 271 ms and 5 rAF/s, against 2 ms and 61 rAF/s
 * with h.GPU_ARGS), which turns a settings sweep into an hour. @param {any} [options]
 */
function launch(options = {}) {
	return h.launch({ ...options, args: [...h.GPU_ARGS, ...(options.args ?? [])] });
}

/** @param {any} v */
const sleep = (v) => new Promise((r) => setTimeout(r, v));

/** Read a store's current value from the debug hook. @param {any} page @param {string} name */
function storeValue(page, name) {
	return page.evaluate(
		(n) =>
			new Promise((r) => {
				const s = n.split('.').reduce((o, k) => o?.[k], /** @type {any} */ (window).__stores);
				if (!s?.subscribe) return r(undefined);
				let v;
				s.subscribe((x) => (v = x))();
				r(v);
			}),
		name
	);
}

// ---- in-page probes -------------------------------------------------------------------
// installProbes wraps the peers instance's broadcast so a run can tell a SHARED setting (it
// tells the room) from a device one, and defines window.__lockSnap, the side-effect
// fingerprint: localStorage, every small serialisable store on the debug hook (top-level and
// one module level down), <html>/<body> attributes and which dialogs are showing.
/** @param {any} page */
async function installProbes(page) {
	await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		w.__lockSent = [];
		const inst = await new Promise((r) => w.__stores.peers.subscribe(r)());
		if (inst && !inst.__lockWrapped) {
			inst.__lockWrapped = true;
			const orig = inst.broadcast.bind(inst);
			inst.broadcast = (/** @type {any} */ payload) => {
				try {
					w.__lockSent.push(String(payload?.type ?? 'unknown'));
				} catch {}
				return orig(payload);
			};
		}
		const SKIP = new Set(['peers', 'TControls', 'globalScene', 'globalRenderer', 'orbitControls', 'worldRig', 'objectsGroup', 'camera']);
		/** @param {any} x */
		const small = (x) => {
			if (x && typeof x === 'object' && (x.isObject3D || x.isMaterial || x.isTexture || x instanceof Node)) return undefined;
			try {
				const j = JSON.stringify(x);
				return j === undefined ? 'undefined' : j.length > 1500 ? undefined : j;
			} catch {
				return undefined;
			}
		};
		/** @param {any} s */
		const read = (s) => {
			let v;
			try {
				const u = s.subscribe((/** @type {any} */ x) => (v = x));
				if (typeof u === 'function') u();
				else u?.unsubscribe?.();
			} catch {
				return undefined;
			}
			return small(v);
		};
		w.__lockSnap = () => {
			/** @type {Record<string, string>} */
			const ls = {};
			for (let i = 0; i < localStorage.length; i++) {
				const k = /** @type {string} */ (localStorage.key(i));
				ls[k] = /** @type {string} */ (localStorage.getItem(k));
			}
			/** @type {Record<string, string>} */
			const stores = {};
			for (const [name, v] of Object.entries(w.__stores)) {
				if (SKIP.has(name) || !v) continue;
				if (typeof v.subscribe === 'function') {
					const j = read(v);
					if (j !== undefined) stores[name] = j;
				} else if (typeof v === 'object' && !Array.isArray(v) && name !== 'THREE') {
					for (const [k, s] of Object.entries(v)) {
						if (s && typeof s === 'object' && typeof s.subscribe === 'function') {
							const j = read(s);
							if (j !== undefined) stores[name + '.' + k] = j;
						}
					}
				}
			}
			const attrs = (/** @type {Element} */ el) =>
				Object.fromEntries([...el.attributes].map((a) => [a.name, a.name === 'style' ? String(a.value.length) : a.value]));
			const dialogs = [
				...document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]')
			]
				.filter((d) => d.getClientRects().length && getComputedStyle(d).visibility !== 'hidden')
				.map((d) => d.id || d.getAttribute('aria-label') || (d.querySelector('h1, h2, h3')?.textContent || '').trim().slice(0, 40) || d.tagName.toLowerCase());
			return { ls, stores, html: attrs(document.documentElement), body: attrs(document.body), dialogs, sent: w.__lockSent.length };
		};
	});
}

/**
 * Count NEW undo entries. The stack length cannot be trusted late in a long suite: the
 * history LIMIT evicts the oldest entry for every new one, so a correct gesture can leave
 * the depth unchanged. This counts entry objects never seen before (undo/redo only move
 * entries between the stacks). @param {any} page
 */
async function installUndoCounter(page) {
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		if (w.__lockUndoSeen) return;
		w.__lockUndoSeen = new WeakSet();
		w.__lockUndoNew = 0;
		w.__stores.history.undoStack.subscribe((/** @type {any[]} */ stack) => {
			for (const e of stack) {
				if (e && typeof e === 'object' && !w.__lockUndoSeen.has(e)) {
					w.__lockUndoSeen.add(e);
					w.__lockUndoNew++;
				}
			}
		});
	});
}
/** @param {any} page @returns {Promise<number>} */
function undoEntries(page) {
	return page.evaluate(() => /** @type {any} */ (window).__lockUndoNew);
}

/** @param {any} page */
function snap(page) {
	return page.evaluate(() => /** @type {any} */ (window).__lockSnap());
}
/** @param {any} page @param {number} from */
function sentSince(page, from) {
	return page.evaluate((f) => [.../** @type {any} */ (window).__lockSent.slice(f)], from);
}

/** Keys whose value differs between two flat maps. @param {Record<string,string>} a @param {Record<string,string>} b */
function changedKeys(a, b) {
	const out = [];
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out.push(k);
	return out.sort();
}

const COUNTER = /(version|count|unread|seq|rev|tick|stamp|changedAt)$/i;

/**
 * Storage values that carry ids/timestamps are reduced to what they MEAN: the notification
 * centre's list becomes the texts it gained.
 * @param {string} key @param {string|undefined} before @param {string} after
 */
function volatile(key, before, after) {
	if (key !== 'notifications') return after;
	try {
		const was = new Set((JSON.parse(before ?? '[]') ?? []).map((/** @type {any} */ n) => n.id));
		const added = (JSON.parse(after) ?? []).filter((/** @type {any} */ n) => !was.has(n.id)).map((/** @type {any} */ n) => n.text);
		return 'notified: ' + JSON.stringify(added);
	} catch {
		return '<notifications>';
	}
}

/**
 * The side-effect fingerprint between two snaps. Storage is exact (keys AND values);
 * stores are by name with a value only for primitives (objects can carry ids/stamps);
 * `noisy` names (stores that move on their own) are dropped.
 * @param {any} a @param {any} b @param {string[]} sent @param {Set<string>} noisy
 */
function effectsOf(a, b, sent, noisy) {
	/** @type {Record<string, string|null>} */
	const storage = {};
	for (const k of changedKeys(a.ls, b.ls)) {
		if (noisy.has('ls:' + k)) continue;
		storage[k] = k in b.ls ? volatile(k, a.ls[k], b.ls[k]) : null;
	}
	/** @type {Record<string, any>} */
	const stores = {};
	for (const k of changedKeys(a.stores, b.stores)) {
		if (noisy.has(k)) continue;
		const v = b.stores[k];
		let parsed;
		try {
			parsed = v === undefined ? null : JSON.parse(v);
		} catch {
			parsed = null;
		}
		// a COUNTER's value depends on everything that ran before (a settings version, an
		// unread count): that it moved is the effect, not the number it reached
		if (typeof parsed === 'number' && COUNTER.test(k)) stores[k] = '<changed>';
		else stores[k] = parsed === null || typeof parsed !== 'object' ? parsed : '<object>';
	}
	const html = changedKeys(a.html, b.html).filter((k) => !noisy.has('html:' + k));
	const body = changedKeys(a.body, b.body).filter((k) => !noisy.has('body:' + k));
	const opened = b.dialogs.filter((/** @type {string} */ d) => !a.dialogs.includes(d));
	const broadcasts = [...new Set(sent)].filter((t) => !noisy.has('sent:' + t)).sort();
	return { storage, stores, html, body, dialogs: opened, broadcasts };
}

/** Names that move with nobody touching anything (sample an idle window). @param {any} page @param {Set<string>} noisy @param {number} ms */
async function learnNoise(page, noisy, ms = 400) {
	const a = await snap(page);
	await page.waitForTimeout(ms);
	const b = await snap(page);
	for (const k of changedKeys(a.stores, b.stores)) noisy.add(k);
	for (const k of changedKeys(a.ls, b.ls)) noisy.add('ls:' + k);
	for (const k of changedKeys(a.html, b.html)) noisy.add('html:' + k);
	for (const k of changedKeys(a.body, b.body)) noisy.add('body:' + k);
	for (const t of await sentSince(page, a.sent)) noisy.add('sent:' + t);
}

// ---- DragRow fields -------------------------------------------------------------------
// The scrub field. DragRow renders `.dn-wrap` around `input.dn-input`; PropRow (SPEC §2)
// WRAPS DragRow, so these classes survive the redesign by contract.
const DRAG_WRAP = '.dn-wrap';
const DRAG_INPUT = '.dn-input';

/** Every visible, enabled scrub field under `root` as a list of {index, label, aria, value}.
 * @param {any} page @param {string} root */
function dragFields(page, root) {
	return page.evaluate(
		({ root, wrap, input }) =>
			[...document.querySelectorAll(root + ' ' + wrap)]
				.filter((w) => w.getClientRects().length)
				.map((w, index) => {
					const el = /** @type {HTMLInputElement|null} */ (w.querySelector(input));
					return {
						index,
						label: w.querySelector('.dn-label')?.textContent?.trim() ?? '',
						aria: el?.getAttribute('aria-label') ?? '',
						id: el?.id ?? '',
						value: el?.value ?? '',
						disabled: !!el?.disabled
					};
				}),
		{ root, wrap: DRAG_WRAP, input: DRAG_INPUT }
	);
}

/** Scrub field `index` under `root` by `dx` px; `mods` held during the move.
 * @param {any} page @param {string} root @param {number} index @param {number} dx @param {{shift?: boolean, ctrl?: boolean, steps?: number, hold?: boolean}} [opts] */
async function scrub(page, root, index, dx, opts = {}) {
	const field = page.locator(root + ' ' + DRAG_WRAP).nth(index);
	await field.scrollIntoViewIfNeeded();
	const box = await field.boundingBox();
	if (!box) throw new Error('scrub: field ' + root + '#' + index + ' has no box');
	const x = box.x + Math.min(10, box.width / 4);
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	if (opts.shift) await page.keyboard.down('Shift');
	if (opts.ctrl) await page.keyboard.down('Control');
	await page.mouse.move(x + dx, y, { steps: opts.steps ?? 12 });
	if (!opts.hold) await page.mouse.up();
	if (opts.ctrl) await page.keyboard.up('Control');
	if (opts.shift) await page.keyboard.up('Shift');
	return { x: x + dx, y };
}

/** The text in field `index`'s box. @param {any} page @param {string} root @param {number} index */
function fieldText(page, root, index) {
	return page.locator(root + ' ' + DRAG_WRAP).nth(index).locator(DRAG_INPUT).inputValue();
}

/** @param {any} page @param {string} root @param {number} index */
function fieldInput(page, root, index) {
	return page.locator(root + ' ' + DRAG_WRAP).nth(index).locator(DRAG_INPUT);
}

/** Compare `actual` with a recorded `expected` and report each difference as a check.
 * @param {(ok: boolean, label: string) => void} check @param {string} label @param {any} expected @param {any} actual */
function same(check, label, expected, actual) {
	const e = JSON.stringify(expected);
	const a = JSON.stringify(actual);
	check(e === a, label + (e === a ? '' : `\n      expected ${e}\n      actual   ${a}`));
}

module.exports = {
	RECORD,
	launch,
	installUndoCounter,
	undoEntries,
	readFixture,
	writeFixture,
	ROW_SEL,
	NAME_SEL,
	CONTROL_SEL,
	FIELD_SEL,
	DRAG_WRAP,
	DRAG_INPUT,
	sleep,
	storeValue,
	installProbes,
	snap,
	sentSince,
	changedKeys,
	effectsOf,
	learnNoise,
	dragFields,
	scrub,
	fieldText,
	fieldInput,
	same
};
