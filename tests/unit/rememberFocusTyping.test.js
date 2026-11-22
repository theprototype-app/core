// @ts-nocheck — a hand-made fake DOM
// 54i (node-ux-keys at 60 fps): Shift+A → Enter adds a node, then Space opens the add menu again within
// 3 s. The first menu's filter INPUT is the newest focus-trail entry and is gone, so rememberFocus took
// it for a vanished opener and, on close, walked the trail back into an old node's number field — the
// next M typed "m" into it instead of muting. A vanished opener is a control, never a typing field, and
// the trail fallback never lands in a text field the person did not press.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let saved;
let focusin;
const body = { tagName: 'BODY' };
const doc = {
	body,
	documentElement: { tagName: 'HTML' },
	activeElement: body,
	addEventListener: (type, fn) => {
		if (type === 'focusin') focusin = fn;
	}
};
/** a fake element @param {string} tag @param {string} [type] */
function el(tag, type) {
	const e = {
		tagName: tag,
		type,
		isConnected: true,
		focused: 0,
		closest: () => null,
		getClientRects: () => [1],
		focus() {
			e.focused++;
			doc.activeElement = e;
		}
	};
	Object.setPrototypeOf(e, globalThis.HTMLElement.prototype);
	return e;
}
/** the element takes focus (the trail records it) */
function focusOn(e) {
	doc.activeElement = e;
	focusin({ target: e });
}

beforeAll(() => {
	saved = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };
	globalThis.HTMLElement = class {};
	globalThis.document = doc;
});
afterAll(() => {
	globalThis.document = saved.document;
	globalThis.HTMLElement = saved.HTMLElement;
});

describe('rememberFocus after a closed menu', () => {
	it('a vanished menu filter input is not an opener: focus does not go back into an old node field', async () => {
		const { rememberFocus } = await import('../../src/lib/keyboardNav.js');
		rememberFocus(); // installs the trail listener
		const nodeField = el('INPUT', 'text'); // section 1 clicked a number node's field
		focusOn(nodeField);
		const filter1 = el('INPUT', 'text'); // the first add menu's filter
		focusOn(filter1);
		filter1.isConnected = false; // Enter: the node is added, the menu closes
		doc.activeElement = body;
		const menu2 = { contains: () => false, isConnected: true };
		const restore = rememberFocus(() => menu2); // Space: the menu again, focus on <body>
		restore(); // Enter again: the second menu closes
		expect(nodeField.focused).toBe(0);
		expect(doc.activeElement).toBe(body);
	});
	it('a vanished menu ROW still hands focus back to the button that opened its menu', async () => {
		const { rememberFocus } = await import('../../src/lib/keyboardNav.js');
		const opener = el('BUTTON');
		focusOn(opener);
		const row = el('BUTTON');
		focusOn(row);
		row.isConnected = false; // the row opened a dialog and closed its menu with it
		doc.activeElement = body;
		const dialog = { contains: () => false, isConnected: true };
		const restore = rememberFocus(() => dialog);
		restore();
		expect(opener.focused).toBe(1);
	});
});
