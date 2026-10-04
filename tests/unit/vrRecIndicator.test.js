// 34 PF (profiler-xr): what the headset's recording pill says.
import { describe, it, expect } from 'vitest';
import { recSegments } from '../../src/lib/vrRecIndicator.js';

describe('recSegments', () => {
	it('is empty (hidden) with nothing recording and nobody watching', () => {
		expect(recSegments(null, null, 0)).toEqual([]);
		expect(recSegments(null, { watchers: 0 }, 0)).toEqual([]);
	});
	it('says REC and the elapsed clock for a light recording', () => {
		const s = recSegments({ mode: 'light', startedAt: 1000 }, null, 1000 + 72_500);
		expect(s.map((x) => x.text)).toEqual(['● REC 1:12']);
	});
	it('says DETAILED for a detailed one (it costs frame time)', () => {
		const s = recSegments({ mode: 'detailed', startedAt: 0 }, null, 4_000);
		expect(s[0].text).toBe('● REC DETAILED 0:04');
	});
	it('adds LIVE with the watcher count, recording or not', () => {
		expect(recSegments(null, { watchers: 2 }, 0).map((x) => x.text)).toEqual(['◉ LIVE 2']);
		expect(recSegments({ mode: 'light', startedAt: 0 }, { watchers: 1 }, 0).map((x) => x.text)).toEqual(['● REC 0:00', '◉ LIVE 1']);
	});
	it('never shows a negative clock (a clock skewed behind startedAt)', () => {
		expect(recSegments({ mode: 'light', startedAt: 5000 }, null, 1000)[0].text).toBe('● REC 0:00');
	});
});
