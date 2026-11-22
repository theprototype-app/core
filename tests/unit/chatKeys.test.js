// uir-chat — old saved window state that names the AI assistant's own window ('aiAssistant') is read
// as the one Chat window ('chat'), and opens it on its Assistant tab when chat itself was not named.
import { describe, it, expect } from 'vitest';
import { migrateChatKeys, renameIn, names } from '../../src/lib/chat/chatKeys.js';

/** a Map-backed storage @param {Record<string, string>} init */
function store(init) {
	const m = new Map(Object.entries(init));
	return {
		m,
		run: () =>
			migrateChatKeys(
				(k) => (m.has(k) ? /** @type {string} */ (m.get(k)) : null),
				(k, v) => m.set(k, v),
				(k) => m.delete(k)
			)
	};
}

describe('renameIn', () => {
	it('renames, dedupes a string list and folds a split of the two', () => {
		expect(renameIn('aiAssistant')).toBe('chat');
		expect(renameIn(['flow', 'aiAssistant', 'chat'])).toEqual(['flow', 'chat']);
		expect(renameIn([{ a: 'chat', b: 'aiAssistant', r: 0.5 }])).toEqual([{ a: 'chat', b: null, r: 0.5 }]);
		expect(renameIn({ left: ['aiAssistant'], right: [] })).toEqual({ left: ['chat'], right: [] });
		expect(names({ members: ['x', 'aiAssistant'] }, 'aiAssistant')).toBe(true);
	});
});

describe('migrateChatKeys', () => {
	it('an AI-assistant-only state: rewritten, and the window opens on Assistant', () => {
		const s = store({
			dockedWindows: JSON.stringify({ left: [], right: ['aiAssistant'] }),
			'sidebar:active:right': 'aiAssistant',
			'sidebar:order:right': JSON.stringify(['inspector', 'aiAssistant']),
			aiAssistantDocked: 'true',
			'win:aiAssistant': '{"left":10,"top":20}'
		});
		const r = s.run();
		expect(r).toEqual({ changed: true, assistant: true });
		expect(JSON.parse(String(s.m.get('dockedWindows')))).toEqual({ left: [], right: ['chat'] });
		expect(s.m.get('sidebar:active:right')).toBe('chat');
		expect(JSON.parse(String(s.m.get('sidebar:order:right')))).toEqual(['inspector', 'chat']);
		expect(s.m.get('chatDocked')).toBe('true');
		expect(s.m.has('aiAssistantDocked')).toBe(false);
		expect(s.m.get('win:chat')).toBe('{"left":10,"top":20}');
		expect(s.m.has('win:aiAssistant')).toBe(false);
	});
	it('both named: one window, the Session tab (chat came first); chat keeps its own rect', () => {
		const s = store({
			dockTabOrder: JSON.stringify(['flow', 'chat', 'aiAssistant']),
			bottomDockSplits: JSON.stringify([{ a: 'chat', b: 'aiAssistant', r: 0.4 }]),
			windowTabGroups: JSON.stringify([{ id: 1, members: ['chat', 'aiAssistant'], active: 'aiAssistant', rect: {} }]),
			'win:chat': 'C',
			'win:aiAssistant': 'A'
		});
		expect(s.run().assistant).toBe(false);
		expect(JSON.parse(String(s.m.get('dockTabOrder')))).toEqual(['flow', 'chat']);
		expect(JSON.parse(String(s.m.get('bottomDockSplits')))).toEqual([{ a: 'chat', b: null, r: 0.4 }]);
		expect(JSON.parse(String(s.m.get('windowTabGroups')))[0].members).toEqual(['chat']);
		expect(s.m.get('win:chat')).toBe('C');
	});
	it('nothing old: untouched (idempotent on a second run)', () => {
		const s = store({ dockTabOrder: JSON.stringify(['chat']), bottomDockActive: 'flow' });
		expect(s.run()).toEqual({ changed: false, assistant: false });
		const t = store({ aiAssistantDocked: 'false', bottomDockActive: 'aiAssistant' });
		expect(t.run()).toEqual({ changed: true, assistant: true });
		expect(t.run()).toEqual({ changed: false, assistant: false });
	});
});
