// 78-int PL1 — the Statistics window's "Baked light" line
import { describe, it, expect } from 'vitest';
import { bakedLightLine } from '../../src/lib/bake/bakeRecordCore.js';

const record = {
	full: { hash: 'a', side: 1024, bytes: 1468006 },
	lite: { hash: 'b', side: 512, bytes: 300000 },
	objects: [{ uuid: '1' }, { uuid: '2' }, { uuid: '3' }]
};

describe('bakedLightLine', () => {
	it('says none for an unbaked scene', () => {
		expect(bakedLightLine(null, null)).toEqual({ none: true, text: 'none' });
		expect(bakedLightLine({ objects: [] }, null).none).toBe(true);
	});
	it('names the full map: px, MB, baked / shown', () => {
		const l = bakedLightLine(record, { map: 'full', applied: 3 });
		expect(l).toMatchObject({ none: false, px: 1024, mb: 1.4, baked: 3, shown: 3, map: 'full' });
		expect(l.text).toBe('1024 px · 1.4 MB · 3 baked / 3 shown');
	});
	it('names the small copy when this device shows it', () => {
		const l = bakedLightLine(record, { map: 'lite', applied: 2 });
		expect(l).toMatchObject({ px: 512, map: 'lite', shown: 2 });
		expect(l.text).toBe('512 px · 0.3 MB · 3 baked / 2 shown');
	});
	it('shows 0 when the device shows none of it, and clamps the count', () => {
		expect(bakedLightLine(record, { map: 'none', applied: 3 }).shown).toBe(0);
		expect(bakedLightLine(record, { map: 'full', applied: 99 }).shown).toBe(3);
		expect(bakedLightLine({ ...record, full: { hash: 'a', side: 256, bytes: 2000 } }, { map: 'full', applied: 1 }).text).toContain('< 0.1 MB');
	});
});
