import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { onLayoutRestore } from './uiLayoutsCore';
import { settingsOpen, settingsSection, settingsSearchSeed } from '../stores/appStore.js';

// panel-gestures item 5 (owner): "hide-sidebar, undock / split, the side-pane buttons and the other
// chrome buttons: right-click -> Hide this button; the '+' on panels is the only button that always
// stays". ONE record of the chrome buttons a person switched off, and ONE way to get each back:
//
//   - every hideable strip button wears `use:chromeButton={'<id>'}`: right-click (a long press on
//     touch) opens its menu — Hide this button, Show buttons ▸ (what this kind of strip has hidden),
//     Customize buttons… (Settings) — and a hidden one is `display: none` (its id stays in the DOM, so
//     the suites that address it keep their selector, and a keyboard path / menu row still runs it);
//   - the panel's own context menu lists that strip kind's hidden buttons (`showButtonsItems`);
//   - Settings ▸ Interface ▸ Customize buttons lists all of them as switches.
//
// The ids are per strip KIND, not per instance: a person who hides "Full height" wants it gone from
// both columns. The "+" of every strip is NOT in the registry and cannot be registered, so there is
// always a way back. LOCAL (this device) and part of the named workspace layouts ($lib/uiLayoutsCore:
// the `chromeButtons` key), so a layout carries its own set; absent = everything shown.

/** @typedef {{id: string, kind: string, label: string, icon?: string}} ChromeButtonDef */

const KEY = 'chromeButtons';

/** the strip kinds, in Settings order */
export const CHROME_KINDS = /** @type {Record<string, string>} */ ({
	sidebar: 'Sidebar header',
	dock: 'Bottom dock',
	group: 'Floating window tabs',
	pane: 'Side panes',
	top: 'Top buttons'
});

/** @type {ChromeButtonDef[]} */
const REGISTRY = [
	// the column's show / hide control, whatever form it takes (strip button today; the owner may pick header
	// buttons + a switch in the top-right group) — the id names the JOB, not the widget
	{ id: 'sidebar.toggle', kind: 'sidebar', label: 'Show / hide sidebar', icon: 'panel-right-close' },
	{ id: 'sidebar.full', kind: 'sidebar', label: 'Full height', icon: 'unfold-vertical' },
	{ id: 'sidebar.lock', kind: 'sidebar', label: 'Header lock', icon: 'lock' },
	{ id: 'dock.split', kind: 'dock', label: 'Split', icon: 'columns-2' },
	{ id: 'dock.undock', kind: 'dock', label: 'Undock', icon: 'app-window' },
	{ id: 'dock.minimize', kind: 'dock', label: 'Minimize the dock', icon: 'panel-bottom' },
	{ id: 'group.dock', kind: 'group', label: 'Dock all tabs', icon: 'panel-bottom' },
	{ id: 'group.close', kind: 'group', label: 'Close all tabs', icon: 'x' }
];

/** a "+" can never be hidden: any id naming one is refused @param {string} id */
const isAdd = (id) => /(^|[.:-])(add|plus)$/.test(id);

/** register another hideable chrome button (a side-pane handle, a module's strip button)
 * @param {ChromeButtonDef} def @returns {boolean} */
export function registerChromeButton(def) {
	if (!def || typeof def.id !== 'string' || !def.id || isAdd(def.id) || !CHROME_KINDS[def.kind]) return false;
	if (REGISTRY.some((d) => d.id === def.id)) return true;
	REGISTRY.push({ ...def });
	return true;
}

/** the registered buttons, optionally of one kind @param {string} [kind] */
export function chromeButtonDefs(kind) {
	return REGISTRY.filter((d) => !kind || d.kind === kind);
}
/** @param {string} id */
export function chromeButtonDef(id) {
	return REGISTRY.find((d) => d.id === id) ?? null;
}
/** can this button be hidden (registered, not a "+") @param {string} id */
export function isHideable(id) {
	return !isAdd(id) && !!chromeButtonDef(id);
}

/** parse the stored record: a JSON array of ids (anything else = nothing hidden) @param {string|null} raw @returns {string[]} */
export function parseHidden(raw) {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x && !isAdd(x)))].sort() : [];
	} catch {
		return [];
	}
}

const read = () => (typeof localStorage === 'undefined' ? [] : parseHidden(safeStorage.getItem(KEY)));

/** the hidden ids (sorted) @type {import('svelte/store').Writable<string[]>} */
export const hiddenChromeButtons = writable(read());

/** @param {string[]} list */
function write(list) {
	const next = [...new Set(list)].filter((x) => !isAdd(x)).sort();
	hiddenChromeButtons.set(next);
	if (typeof localStorage === 'undefined') return;
	if (next.length) safeStorage.setItem(KEY, JSON.stringify(next));
	else safeStorage.removeItem(KEY); // absent = the default, so a layout saved now applies cleanly
}

// a named layout just rewrote the key: re-read it (absent = everything shown)
onLayoutRestore(() => hiddenChromeButtons.set(read()));

/** @param {string} id */
export function hideChromeButton(id) {
	if (!isHideable(id)) return false;
	const cur = get(hiddenChromeButtons);
	if (!cur.includes(id)) write([...cur, id]);
	return true;
}
/** @param {string} id */
export function showChromeButton(id) {
	write(get(hiddenChromeButtons).filter((x) => x !== id));
}
/** every hidden button back (of one kind, or all) @param {string} [kind] */
export function showAllChromeButtons(kind) {
	write(kind ? get(hiddenChromeButtons).filter((x) => chromeButtonDef(x)?.kind !== kind) : []);
}
/** @param {string} id @param {boolean} shown */
export function setChromeButtonShown(id, shown) {
	if (shown) showChromeButton(id);
	else hideChromeButton(id);
}

/** Settings ▸ Interface, searched to the row */
export function openCustomizeButtons() {
	settingsSection.set(/** @type {any} */ ('interface'));
	settingsSearchSeed.set('Customize buttons');
	settingsOpen.set(/** @type {any} */ (true));
}

/** "Show buttons ▸" for a strip kind's menu — nothing when that kind hides nothing
 * @param {string} kind @param {string[]} [hidden] @returns {any[]} */
export function showButtonsItems(kind, hidden = get(hiddenChromeButtons)) {
	const off = /** @type {ChromeButtonDef[]} */ (hidden.map((id) => chromeButtonDef(id)).filter((d) => !!d && d.kind === kind));
	if (!off.length) return [];
	return [
		{
			label: 'Show buttons',
			icon: 'eye',
			children: [
				...off.map((d) => ({ label: d.label, icon: d.icon, action: () => showChromeButton(d.id) })),
				...(off.length > 1 ? [{ label: 'Show all', icon: 'eye', action: () => showAllChromeButtons(kind) }] : [])
			]
		}
	];
}

/** the open button menu @type {import('svelte/store').Writable<{x: number, y: number, id: string} | null>} */
export const chromeButtonMenu = writable(null);

/** the rows of a chrome button's own menu @param {string} id @returns {any[]} */
export function chromeButtonMenuItems(id) {
	const def = chromeButtonDef(id);
	if (!def) return [];
	return [
		{ label: 'Hide this button', icon: 'eye-off', tooltip: 'Settings ▸ Customize buttons, or this strip’s menu, brings it back', action: () => hideChromeButton(id) },
		...showButtonsItems(def.kind),
		{ label: 'Customize buttons…', icon: 'settings', action: openCustomizeButtons }
	];
}

const HOLD_MS = 500; // the strips' menu timer (a still press)
const HOLD_SLOP = 10;

/**
 * `use:chromeButton={'dock.split'}` — the button hides while its id is in the record, and its menu
 * opens on right-click / a still long press. A non-hideable id ("+") gets neither.
 * @param {HTMLElement} node @param {string} id
 */
export function chromeButton(node, id) {
	let cur = id;
	const shownDisplay = node.style.display;
	/** @type {string[]} */ let list = [];
	const paint = () => {
		const off = isHideable(cur) && list.includes(cur);
		node.style.display = off ? 'none' : shownDisplay;
		if (off) node.dataset.chromeHidden = '1';
		else delete node.dataset.chromeHidden;
	};
	node.dataset.chromeButton = cur;
	const unsub = hiddenChromeButtons.subscribe((l) => {
		list = l;
		paint();
	});
	/** @param {number} x @param {number} y */
	const open = (x, y) => {
		if (!isHideable(cur)) return false;
		const m = get(chromeButtonMenu);
		if (!m || m.id !== cur) chromeButtonMenu.set({ x, y, id: cur });
		return true;
	};
	/** @param {MouseEvent} e */
	const contextmenu = (e) => {
		if (!isHideable(cur)) return;
		e.preventDefault();
		e.stopPropagation();
		open(e.clientX, e.clientY);
	};
	// touch: a still press of HOLD_MS — the slop is re-checked when the timer fires
	/** @type {ReturnType<typeof setTimeout> | 0} */ let timer = 0;
	let x0 = 0;
	let y0 = 0;
	let x = 0;
	let y = 0;
	let swallowClick = false;
	const cancel = () => {
		if (timer) clearTimeout(timer);
		timer = 0;
	};
	/** @param {PointerEvent} e */
	const down = (e) => {
		if (e.pointerType === 'mouse' || !isHideable(cur)) return;
		cancel();
		swallowClick = false;
		x0 = x = e.clientX;
		y0 = y = e.clientY;
		timer = setTimeout(() => {
			timer = 0;
			if (Math.hypot(x - x0, y - y0) > HOLD_SLOP) return;
			try {
				navigator.vibrate?.(10);
			} catch {}
			swallowClick = true;
			open(x0, y0);
		}, HOLD_MS);
	};
	/** @param {PointerEvent} e */
	const move = (e) => {
		x = e.clientX;
		y = e.clientY;
		if (timer && Math.hypot(x - x0, y - y0) > HOLD_SLOP) cancel();
	};
	/** @param {MouseEvent} e */
	const click = (e) => {
		if (!swallowClick) return;
		swallowClick = false;
		e.preventDefault();
		e.stopImmediatePropagation();
	};
	node.addEventListener('contextmenu', contextmenu);
	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', cancel);
	node.addEventListener('pointercancel', cancel);
	node.addEventListener('click', click, true);
	return {
		/** @param {string} next */
		update(next) {
			cur = next;
			node.dataset.chromeButton = cur;
			paint();
		},
		destroy() {
			cancel();
			unsub();
			node.removeEventListener('contextmenu', contextmenu);
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', cancel);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('click', click, true);
		}
	};
}
