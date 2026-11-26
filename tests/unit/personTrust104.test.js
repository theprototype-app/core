import { describe, it, expect, beforeEach } from 'vitest';
import { askPerson, askKnown } from '../../src/lib/ai/personAsk.js';
import { showTool, showToolResetForTest, allowKey } from '../../src/lib/ai/showTool.js';
import { safeStorage } from '../../src/lib/safeStorage';

// 104-int (the O5 review + the seam review of 104-show x 89-apps): the person's tools trust only what they asked,
// and an app the Worker cannot name never rides a stored "Always".

const q = { summary: 's', prompt: 'p', choices: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no', cancel: true }], apply: () => ({ ok: true }) };

describe('askKnown: the pacing steps aside only for a question this page asked', () => {
	it('a made-up confirmId is not known; a real one is, for its own tool only', async () => {
		expect(askKnown('files', 'p-made-up')).toBe(false);
		expect(askKnown('files', undefined)).toBe(false);
		expect(askKnown('files', '')).toBe(false);
		const r = await askPerson('files', {}, q);
		expect(r.needsConfirm).toBe(true);
		expect(askKnown('files', r.confirmId)).toBe(true);
		expect(askKnown('scene', r.confirmId)).toBe(false);
	});
});

describe('show: "Always" belongs to apps with a trusted name', () => {
	beforeEach(() => {
		showToolResetForTest();
		safeStorage.removeItem(allowKey('panel'));
	});
	it('an unnamed AI app is not offered Always', async () => {
		const r = await showTool({ action: 'panel', name: 'Explorer' }, { by: 'An AI app' });
		expect(r.needsConfirm).toBe(true);
		expect(r.choices).toEqual(['This time', 'No']);
		const c = await showTool({ action: 'panel', name: 'Explorer' }, { by: 'Claude' });
		expect(c.choices).toEqual(['Always', 'This time', 'No']);
	});
	it('a stored Always does not let an unnamed AI app skip the question', async () => {
		safeStorage.setItem(allowKey('panel'), 'always');
		const r = await showTool({ action: 'panel', name: 'Explorer' }, { by: 'An AI app' });
		expect(r.needsConfirm).toBe(true);
		safeStorage.removeItem(allowKey('panel'));
	});
});
