// @ts-nocheck — hand-made fake DOM elements
// 36 U11: the keymap's scope rules — which pane a press belongs to, and which row answers it.
import { describe, it, expect, beforeEach } from 'vitest';
import {
	hostScopeOf,
	scopeOfEvent,
	pickForScope,
	scopeHears,
	chainOf,
	setLastScope,
	lastScope,
	setVrScopeProbe,
	onScopeChange,
	viewportHasKeys
} from '../../src/lib/keyScope.js';

/** A minimal element: `closest` walks a parent chain by attribute/class. */
function el({ tag = 'DIV', scope = null, cls = '', editable = false, parent = null } = {}) {
	/** @type {any} */
	const node = {
		tagName: tag,
		isContentEditable: editable,
		parent,
		getAttribute: (name) => (name === 'data-key-scope' ? scope : null),
		closest(selector) {
			/** @type {any} */
			let at = node;
			while (at) {
				if (selector === '.cm-editor' && at.cls?.includes('cm-editor')) return at;
				if (selector === '[data-key-scope]' && at.scopeAttr) return at;
				at = at.parent;
			}
			return null;
		}
	};
	node.cls = cls;
	node.scopeAttr = scope;
	return node;
}

describe('keyScope', () => {
	beforeEach(() => {
		setLastScope('viewport');
		setVrScopeProbe(null);
	});

	it('an element outside any marked pane belongs to the viewport', () => {
		expect(hostScopeOf(el())).toBe('viewport');
		expect(hostScopeOf(null)).toBe('viewport');
	});

	it('a marked pane names its scope for everything inside it', () => {
		const pane = el({ scope: 'nodes' });
		const card = el({ parent: el({ parent: pane }) });
		expect(hostScopeOf(card)).toBe('nodes');
	});

	it('a CodeMirror editor is the code scope, wherever it sits', () => {
		const pane = el({ scope: 'nodes' });
		const cm = el({ cls: 'cm-editor', parent: pane });
		expect(hostScopeOf(el({ parent: cm }))).toBe('code');
	});

	it('text entry is decided per EVENT and never reaches the registry', () => {
		const input = el({ tag: 'INPUT', parent: el({ scope: 'nodes' }) });
		expect(scopeOfEvent({ target: input })).toBe('text');
		expect(scopeOfEvent({ target: el({ editable: true }) })).toBe('text');
		const cmContent = el({ editable: true, parent: el({ cls: 'cm-editor' }) });
		expect(scopeOfEvent({ target: cmContent })).toBe('code');
	});

	it('a press on a non-text element belongs to the pane that last took focus', () => {
		setLastScope('nodes');
		expect(scopeOfEvent({ target: el() })).toBe('nodes'); // body / a node card
		setLastScope('viewport');
		expect(scopeOfEvent({ target: el() })).toBe('viewport');
	});

	it('VR wins while a session runs, and falls back to the viewport rows', () => {
		setVrScopeProbe(() => true);
		expect(scopeOfEvent({ target: el() })).toBe('vr');
		expect(chainOf('vr')).toEqual(['vr', 'viewport', 'global']);
		expect(viewportHasKeys({ target: el() })).toBe(true);
	});

	it('the focused scope row wins over a global one; text hears nothing', () => {
		const rows = [
			{ id: 'g', scope: 'global' },
			{ id: 'n', scope: 'nodes' },
			{ id: 'v', scope: 'viewport' }
		];
		expect(pickForScope(rows, 'nodes')?.id).toBe('n');
		expect(pickForScope(rows, 'viewport')?.id).toBe('v');
		expect(pickForScope(rows, 'uv')?.id).toBe('g');
		expect(pickForScope(rows, 'text')).toBe(null);
		expect(pickForScope([{ id: 'v', scope: 'viewport' }], 'nodes')).toBe(null); // the C fix
	});

	it('an unscoped row is global', () => {
		expect(pickForScope([{ id: 'x' }], 'nodes')?.id).toBe('x');
		expect(scopeHears(undefined, 'nodes')).toBe(true);
		expect(scopeHears('viewport', 'nodes')).toBe(false);
		expect(scopeHears('global', 'code')).toBe(false);
	});

	it('viewport listeners stand down outside the viewport', () => {
		setLastScope('nodes');
		expect(viewportHasKeys({ target: el() })).toBe(false);
		expect(viewportHasKeys({ target: el({ tag: 'TEXTAREA' }) })).toBe(false);
		setLastScope('viewport');
		expect(viewportHasKeys({ target: el() })).toBe(true);
	});

	it('scope changes notify once per change', () => {
		/** @type {string[]} */
		const seen = [];
		const off = onScopeChange((s) => seen.push(s));
		setLastScope('nodes');
		setLastScope('nodes');
		setLastScope('viewport');
		off();
		setLastScope('nodes');
		expect(seen).toEqual(['nodes', 'viewport']);
		expect(lastScope()).toBe('nodes');
	});
});
