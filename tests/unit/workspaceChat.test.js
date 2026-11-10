// uir-int: the workspace record's `aiAssistant` entry is an alias over the one Chat window (1.65) — open-only
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { chatHidden, chatTab } from '../../src/stores/appStore.js';
import { applyWorkspace } from '../../src/lib/workspace.js';

describe('applyWorkspace and the AI assistant alias', () => {
	beforeEach(() => {
		chatHidden.set('hidden');
		chatTab.set('assistant');
	});
	it('a record with Chat open and the AI window closed keeps Chat open, even with Assistant in front', () => {
		applyWorkspace({ open: { chat: true, aiAssistant: false } });
		expect(get(chatHidden)).toBe('');
	});
	it('a record naming the AI window open opens Chat on Assistant', () => {
		chatTab.set('session');
		applyWorkspace({ open: { chat: false, aiAssistant: true } });
		expect(get(chatHidden)).toBe('');
		expect(get(chatTab)).toBe('assistant');
	});
	it('a record with both closed closes Chat', () => {
		chatHidden.set('');
		applyWorkspace({ open: { chat: false, aiAssistant: false } });
		expect(get(chatHidden)).toBe('hidden');
	});
});
