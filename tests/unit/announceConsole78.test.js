// 78 F14: an announcement is written down in every mode, and says whether a banner drew it
// (Play / a headset) or only the Debugger console did (Edit).
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { announce, announceLog, announceUnread, clearAnnounceLog, ANNOUNCE_LOG_CAP } from '../../src/lib/gameAnnounce.js';
import { isLocked, isVRMode } from '../../src/stores/sceneStore';
import { entries } from '../../src/lib/diagnostics.js';

describe('Announce console (78 F14)', () => {
	beforeEach(() => {
		clearAnnounceLog();
		isLocked.set(null);
		isVRMode.set(false);
	});
	it('in Edit: a console line with its time and source node, counted unread', () => {
		const id = announce('Ring 1 reached', { sub: 'go on', source: { nodeId: 'n1', label: 'Ring banner', graph: 'scene' } });
		const rows = get(announceLog);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id, text: 'Ring 1 reached', sub: 'go on', shown: 'console', source: { kind: 'node', nodeId: 'n1', label: 'Ring banner' } });
		expect(Math.abs(rows[0].at - Date.now())).toBeLessThan(1000);
		expect(get(announceUnread)).toBe(1);
		expect(entries().some((e) => e.scope === 'announce' && e.message.includes('Ring 1 reached'))).toBe(true);
	});
	it('in Play and in a headset: shown as a banner, not counted unread', () => {
		isLocked.set(true);
		announce('GOAL!');
		isLocked.set(null);
		isVRMode.set(true);
		announce('Level 3', { source: { kind: 'module', label: 'module fx' } });
		const rows = get(announceLog);
		expect(rows.map((r) => r.shown)).toEqual(['banner', 'banner']);
		expect(rows[1].source).toEqual({ kind: 'module', label: 'module fx' });
		expect(get(announceUnread)).toBe(0);
	});
	it('keeps the newest lines only, and an empty line writes nothing', () => {
		expect(announce('   ')).toBe(0);
		for (let i = 0; i < ANNOUNCE_LOG_CAP + 5; i++) announce('line ' + i);
		const rows = get(announceLog);
		expect(rows).toHaveLength(ANNOUNCE_LOG_CAP);
		expect(rows[rows.length - 1].text).toBe('line ' + (ANNOUNCE_LOG_CAP + 4));
	});
});
