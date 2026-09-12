import { describe, it, expect } from 'vitest';
import * as budget from '../../src/lib/meshBudget.js';

// 27-I (audit L9). meshBudget is the app's size policy for geometry work: what may be
// committed, what may be streamed as a live preview, and how much undo memory the history
// may hold. Its own header carries the MEASUREMENTS those numbers came from (12 MB over
// the wire in 4.9 s; 66-83 ms to commit at the ceiling; 11.4 MB per history entry), which
// is exactly the kind of constant that gets "tidied" by someone who has not read them.
//
// The point of a unit test here is not to re-assert the numbers — it is to pin the
// RELATIONSHIPS between them, because those are what silently break: a live preview
// ceiling above the commit ceiling would stream what can never be committed, and a history
// budget smaller than one entry would evict the edit you just made.

describe('the ceilings exist and are numbers', () => {
	it('exports the four budgets', () => {
		expect(typeof budget.MAX_SNAPSHOT).toBe('number');
		expect(typeof budget.MAX_LIVE_PREVIEW).toBe('number');
		expect(typeof budget.MAX_FACE_TRIS).toBe('number');
		expect(typeof budget.HISTORY_BYTES).toBe('number');
	});
});

describe('the relationships between them are the real contract', () => {
	it('a LIVE PREVIEW ceiling is below the COMMIT ceiling', () => {
		// otherwise a gesture streams previews of an edit that can never be committed —
		// and the preview is the per-frame cost, so it is the one that must stay small.
		expect(budget.MAX_LIVE_PREVIEW).toBeLessThan(budget.MAX_SNAPSHOT);
	});

	it('the face-partition budget scales WITH the snapshot ceiling, not below it', () => {
		expect(budget.MAX_FACE_TRIS).toBeGreaterThanOrEqual(budget.MAX_SNAPSHOT);
	});

	it('the history budget holds more than one ceiling-sized entry', () => {
		// a meshgeo entry stores a BEFORE and an AFTER, so one edit at the ceiling is
		// ~2 x 4 bytes x MAX_SNAPSHOT. A budget under that would evict the newest step.
		const oneEntryBytes = budget.MAX_SNAPSHOT * 4 * 2;
		expect(budget.HISTORY_BYTES).toBeGreaterThan(oneEntryBytes);
	});

	it('every budget is positive and finite', () => {
		for (const [name, v] of Object.entries(budget))
			if (typeof v === 'number') {
				expect(Number.isFinite(v), name).toBe(true);
				expect(v, name).toBeGreaterThan(0);
			}
	});
});
