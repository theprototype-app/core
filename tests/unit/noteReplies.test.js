// @ts-nocheck — assertions on plain objects
// 37 R16: threaded note replies — normalize, the per-reply merge, and the undo re-stamp.
import { describe, it, expect } from 'vitest';
import { normalizeReplies, mergeReplies, restampReplies, MAX_REPLIES } from '../../src/lib/noteReplies.js';

const r = (id, text, ts, at = ts, deleted) => ({ id, text, author: 'A', authorKey: 'k', ts, at, ...(deleted ? { deleted: true } : {}) });

describe('normalizeReplies', () => {
	it('drops junk and duplicates, orders by when written, caps', () => {
		const out = normalizeReplies([r('b', 'two', 20), null, { id: '' }, r('a', 'one', 10), r('a', 'dup', 30)]);
		expect(out.map((x) => x.id)).toEqual(['a', 'b']);
		expect(out[0].text).toBe('one');
		expect(normalizeReplies(Array.from({ length: MAX_REPLIES + 5 }, (_, i) => r('r' + i, 't', i)))).toHaveLength(MAX_REPLIES);
		expect(normalizeReplies('nope')).toEqual([]);
	});
});

describe('mergeReplies', () => {
	it('keeps both sides of a simultaneous reply', () => {
		expect(mergeReplies([r('a', 'mine', 10)], [r('b', 'theirs', 11)]).map((x) => x.id)).toEqual(['a', 'b']);
	});
	it('a tombstone with a newer stamp wins; an older copy cannot resurrect it', () => {
		const gone = r('a', 'x', 10, 50, true);
		expect(mergeReplies([gone], [r('a', 'x', 10, 10)])[0].deleted).toBe(true);
		expect(mergeReplies([r('a', 'x', 10, 10)], [gone])[0].deleted).toBe(true);
	});
});

describe('restampReplies (undo/redo)', () => {
	it('undoing a reply tombstones it NOW, so peers holding it take the delete', () => {
		const out = restampReplies([r('a', 'one', 10), r('b', 'two', 20)], [r('a', 'one', 10)], 1000);
		const b = out.find((x) => x.id === 'b');
		expect(b.deleted).toBe(true);
		expect(b.at).toBe(1000);
		expect(mergeReplies([r('b', 'two', 20)], out).find((x) => x.id === 'b').deleted).toBe(true);
	});
	it('redoing brings it back newer than the tombstone', () => {
		const out = restampReplies([r('b', 'two', 20, 1000, true)], [r('b', 'two', 20)], 1000);
		expect(out[0].deleted).toBeUndefined();
		expect(out[0].at).toBe(1001);
		expect(mergeReplies([r('b', 'two', 20, 1000, true)], out)[0].deleted).toBeUndefined();
	});
	it('leaves what already matches untouched', () => {
		const same = [r('a', 'one', 10)];
		expect(restampReplies(same, same, 999)).toEqual(same);
	});
});

describe('an undo step touches only its own replies', () => {
	it('redoing my reply does not bring back a reply somebody deleted meanwhile', async () => {
		const { changedReplyIds } = await import('../../src/lib/noteReplies.js');
		const before = [r('a', 'one', 10)];
		const after = [r('a', 'one', 10), r('mine', 'mine', 20), r('theirs', 'theirs', 21)];
		const only = changedReplyIds(before, after);
		expect([...only].sort()).toEqual(['mine', 'theirs']);
		// a later step's view: `theirs` was deleted by its author; this step should only know `mine`
		const onlyMine = changedReplyIds([r('a', 'one', 10), r('theirs', 'theirs', 21)], after);
		const current = [r('a', 'one', 10), r('theirs', 'theirs', 21, 500, true)];
		const out = restampReplies(current, after, 1000, onlyMine);
		expect(out.find((x) => x.id === 'theirs').deleted).toBe(true);
		expect(out.find((x) => x.id === 'mine').deleted).toBeUndefined();
	});
});
