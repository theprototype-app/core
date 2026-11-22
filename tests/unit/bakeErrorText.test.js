// 98-int: device-lab-3's HONOR + Tavern interior bake ended on "the scene does not fit one lightmap" with no next step
import { describe, it, expect } from 'vitest';
import { bakeErrorText } from '../../src/lib/bake/bakeRecordCore.js';
describe('1.63 bake: a scene too big for one lightmap says what to do', () => {
	it('a phone at Normal: High, or bake on a computer', () => {
		const t = bakeErrorText('the scene does not fit one lightmap', 'phone', 'normal');
		expect(t).toMatch(/Quality ▸ High/);
		expect(t).toMatch(/bake on a computer in this session/);
	});
	it('a Quest (no bigger atlas): only the computer', () => {
		const t = bakeErrorText('the scene does not fit one lightmap', 'quest', 'normal');
		expect(t).not.toMatch(/High/);
		expect(t).toMatch(/computer/);
	});
	it('a computer at High: fewer, larger objects', () => {
		expect(bakeErrorText('the scene does not fit one lightmap', 'pc', 'high')).toMatch(/fewer, larger objects/);
	});
	it('any other error passes through', () => {
		expect(bakeErrorText('cancelled', 'phone')).toBe('cancelled');
	});
});
