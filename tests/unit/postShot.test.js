// mcp-diorama2 item 7: why a screen draws no post effects, in a code an agent can branch on and words it can say
import { describe, it, expect } from 'vitest';
import { postOffReason, QUALITY_HOW } from '../../src/lib/agent/postShotCore.js';

const on = { authored: 2, mode: 'shaded', localOn: true, ok: true, postOff: false };

describe('postOffReason', () => {
	it('names each reason, most basic first', () => {
		expect(postOffReason({ ...on, authored: 0 }).reason).toBe('no effects');
		expect(postOffReason({ ...on, mode: 'wireframe' }).reason).toBe('wireframe');
		expect(postOffReason({ ...on, ok: false, major: 140 })).toMatchObject({ reason: 'browser', how: null });
		expect(postOffReason({ ...on, ok: false, major: 140 }).detail).toMatch(/Chromium 140/);
		expect(postOffReason({ ...on, localOn: false }).how).toMatch(/View ▸ Overrides/);
	});
	it('a phone that turned post off to keep its frames = "quality tier", with where to raise it and the consented ask', () => {
		const r = postOffReason({ ...on, postOff: true, level: 6 });
		expect(r.reason).toBe('quality tier');
		expect(r.detail).toMatch(/step 6/);
		expect(r.detail).toMatch(/nothing was changed/);
		expect(r.how).toBe(QUALITY_HOW);
		expect(QUALITY_HOW).toMatch(/Settings ▸ Scene ▸ Performance ▸ Quality preset: High/);
		expect(QUALITY_HOW).toMatch(/set_quality {"level": "high"}/);
	});
});
