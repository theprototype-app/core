// 54i: one top-chrome rule for every floating window (dragWindow's minTop). The N6-unfolded case: a docked
// Connect bar (0..52) pushes the notes/bell cluster to 62..114 and the profile circle to 60..108; the AI
// window's 76 fix cleared only the circle, so its header sat at 112, under the bell row.
import { describe, it, expect } from 'vitest';
import { topChromeFloor, TOP_CHROME } from '../../src/lib/windowSize.js';

/** @param {number} left @param {number} top @param {number} right @param {number} bottom */
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const bar = rect(0, 0, 770, 52);
const cluster = rect(592, 62, 694, 114);
const avatar = rect(702, 60, 750, 108);

describe('topChromeFloor', () => {
	it('names the cluster and the profile circle as well as the Connect pill', () => {
		expect(TOP_CHROME).toEqual(expect.arrayContaining(['.connect-pill', '#hud-tr', '#avatar-trigger']));
	});
	it('a window under the bell row opens below it, not just below the profile circle', () => {
		expect(topChromeFloor(255, 500, [bar, cluster, avatar])).toBe(118);
		expect(topChromeFloor(255, 500, [bar, avatar])).toBe(112); // the 76 rule alone: the header at 112 < 114
	});
	it('only horizontal overlap counts', () => {
		expect(topChromeFloor(10, 300, [bar, cluster, avatar])).toBe(56); // left of the cluster: under the bar only
		expect(topChromeFloor(10, 300, [cluster, avatar])).toBe(0);
		expect(topChromeFloor(694, 20, [cluster])).toBe(0); // touching edges do not overlap
	});
	it('hidden chrome (an empty rect) and missing chrome never count', () => {
		expect(topChromeFloor(255, 500, [rect(0, 0, 0, 0), null, rect(600, 0, 600, 90)])).toBe(0);
	});
});
