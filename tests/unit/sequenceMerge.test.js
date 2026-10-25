// 77: two peers edit one cut at once — the stamps, the join, the old-peer relay and undo-as-a-delta
import { describe, it, expect } from 'vitest';
import { normalizeSequence, normalizeItem } from '../../src/lib/sequenceCore.js';
import { splitAt } from '../../src/lib/cutCore.js';
import {
	stampChanges,
	mergeSequences,
	isStamped,
	sameContent,
	stripStamps,
	applyDelta
} from '../../src/lib/sequenceMerge.js';

/** a local write the way sequences.setSequence makes it */
const write = (before, after, stamp) =>
	stampChanges(before, normalizeSequence({ ...after, changedAt: stamp }), stamp);

const base = () =>
	write(
		null,
		{
			id: 's',
			name: 'Cut',
			duration: 30,
			tracks: [
				{ id: 'v', kind: 'video', items: [{ id: 'c1', t: 0, dur: 6, src: 'h1' }, { id: 'c2', t: 6, dur: 6, src: 'h2' }] },
				{ id: 'ti', kind: 'title', items: [] },
				{ id: 'cam', kind: 'camera', items: [{ id: 's1', t: 0, dur: 12, camera: 'k' }] }
			]
		},
		1000
	);

/** peer A splits the clip track at 3, peer B adds a title — at the same moment */
function concurrent() {
	const b0 = base();
	const A = write(b0, splitAt(b0, 3, ['c1']).doc, 2000);
	const titled = structuredClone(b0);
	titled.tracks[1].items.push(normalizeItem('title', { id: 'tt', t: 1, dur: 2, text: 'Hi' }));
	const B = write(b0, titled, 2000);
	return { b0, A, B };
}

describe('sequenceMerge', () => {
	it('a local write is stamped; plain content is unchanged by the stamps', () => {
		const b = base();
		expect(isStamped(b)).toBe(true);
		expect(b.tracks[0].items[0].at).toBe(1000);
		const plain = stripStamps(b);
		expect(JSON.stringify(plain)).not.toMatch(/"at"|metaAt|stampedAt|orderAt/);
		// an unchanged item keeps its stamp across a later write
		const next = write(b, { ...b, name: 'Renamed' }, 1500);
		expect(next.tracks[0].items[0].at).toBe(1000);
		expect(next.metaAt).toBe(1500);
	});
	it('counterfactual: whole-document latest-wins keeps ONE of a concurrent split + title', () => {
		const { A, B } = concurrent();
		const lww = B.changedAt >= A.changedAt ? B : A; // the 48 S2 rule
		const splitKept = lww.tracks[0].items.length === 3;
		const titleKept = lww.tracks[1].items.length === 1;
		expect(splitKept && titleKept).toBe(false);
	});
	it('the merge keeps BOTH, and is the same in either order', () => {
		const { A, B } = concurrent();
		const ab = mergeSequences(A, B);
		const ba = mergeSequences(B, A);
		expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
		expect(ab.tracks[0].items.map((it) => [it.id.startsWith('it-') ? 'right' : it.id, it.t, it.dur])).toEqual([
			['c1', 0, 3],
			['right', 3, 3],
			['c2', 6, 6]
		]);
		expect(ab.tracks[1].items.map((it) => it.text)).toEqual(['Hi']);
	});
	it('idempotent + associative (three peers converge whatever lands first)', () => {
		const { b0, A, B } = concurrent();
		const C = write(b0, { ...b0, duration: 40 }, 2500);
		const m1 = mergeSequences(mergeSequences(A, B), C);
		const m2 = mergeSequences(A, mergeSequences(B, C));
		const m3 = mergeSequences(mergeSequences(C, A), B);
		expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
		expect(JSON.stringify(m1)).toBe(JSON.stringify(m3));
		expect(m1.duration).toBe(40);
		expect(JSON.stringify(mergeSequences(m1, m1))).toBe(JSON.stringify(m1));
		expect(JSON.stringify(mergeSequences(m1, A))).toBe(JSON.stringify(m1));
	});
	it('a delete beats an older edit of the same item; a later edit beats an older delete', () => {
		const b0 = base();
		const del = write(b0, { ...b0, tracks: b0.tracks.map((t) => ({ ...t, items: t.items.filter((it) => it.id !== 'c2') })) }, 3000);
		const moved = structuredClone(b0);
		moved.tracks[0].items[1].t = 7;
		const edit = write(b0, moved, 2900);
		expect(mergeSequences(del, edit).tracks[0].items.map((it) => it.id)).toEqual(['c1']);
		const late = write(b0, moved, 3100);
		expect(mergeSequences(del, late).tracks[0].items.map((it) => it.id)).toEqual(['c1', 'c2']);
	});
	it('a deleted track stays deleted under a concurrent edit inside it', () => {
		const b0 = base();
		const noTitle = write(b0, { ...b0, tracks: b0.tracks.filter((t) => t.id !== 'ti') }, 3000);
		const t2 = structuredClone(b0);
		t2.tracks[1].items.push(normalizeItem('title', { id: 'z', t: 0, dur: 1 }));
		const edited = write(b0, t2, 3000);
		expect(mergeSequences(noTitle, edited).tracks.map((t) => t.id)).toEqual(['v', 'cam']);
	});
	it('a LOAD (reset) replaces: older content on the other side does not union back in', () => {
		const { A } = concurrent();
		const loaded = stampChanges(A, normalizeSequence({ id: 's', name: 'From file', tracks: [], changedAt: 5000 }), 5000, { reset: true });
		const m = mergeSequences(A, loaded);
		expect(m.tracks).toEqual([]);
		expect(m.name).toBe('From file');
		// …but an edit made AFTER the load still merges in
		const after = write(loaded, { ...loaded, tracks: [{ id: 'n', kind: 'title', items: [{ id: 'q', t: 0, dur: 1 }] }] }, 6000);
		expect(mergeSequences(loaded, after).tracks.length).toBe(1);
	});
	it('a document relayed by an OLDER peer takes the old rule (latest wins)', () => {
		const { A, B } = concurrent();
		const relayed = { ...B, changedAt: 9000 }; // an old peer re-sent it: stamps untouched
		expect(isStamped(relayed)).toBe(false);
		expect(mergeSequences(A, relayed)).toBe(relayed);
		expect(mergeSequences({ ...A, changedAt: 9999, stampedAt: 1 }, B).changedAt).toBe(9999);
	});
	it('an unknown (newer) kind merges whole by its own stamp', () => {
		const b0 = write(null, { id: 's', tracks: [{ id: 'x', kind: 'laser', items: [{ beam: 1 }] }] }, 100);
		const e = write(b0, { ...b0, tracks: [{ ...b0.tracks[0], items: [{ beam: 2 }] }] }, 200);
		expect(e.tracks[0].at).toBe(200);
		expect(mergeSequences(b0, e).tracks[0].items).toEqual([{ beam: 2 }]);
	});
	it('undo as a delta: my undo does not revert a peer\'s edit made since', () => {
		const b0 = base();
		const mine = structuredClone(b0);
		mine.tracks[0].items[0].t = 1; // I move c1
		const after = write(b0, mine, 2000);
		const peer = structuredClone(after);
		peer.tracks[0].items[1].t = 8; // a peer moves c2 afterwards
		const cur = write(after, peer, 2100);
		const undone = applyDelta(cur, after, b0);
		expect(undone.tracks[0].items.map((it) => [it.id, it.t])).toEqual([['c1', 0], ['c2', 8]]);
		// counterfactual: the whole-document undo puts c2 back too
		expect(b0.tracks[0].items[1].t).toBe(6);
		// undo of an added track removes only it; redo brings it back
		const plus = write(b0, { ...b0, tracks: [...b0.tracks, { id: 'new', kind: 'title', items: [] }] }, 2200);
		const minus = applyDelta(plus, plus, b0);
		expect(minus.tracks.map((t) => t.id)).toEqual(['v', 'ti', 'cam']);
		expect(applyDelta(minus, b0, plus).tracks.map((t) => t.id)).toEqual(['v', 'ti', 'cam', 'new']);
		// a dropped marker stays dropped
		const marked = write(b0, { ...b0, markers: [{ id: 'm', t: 2 }] }, 2300);
		expect(applyDelta(marked, marked, b0)).not.toHaveProperty('markers');
	});
	it('sameContent ignores stamps only', () => {
		const b0 = base();
		expect(sameContent(b0, stripStamps(b0))).toBe(true);
		expect(sameContent(b0, { ...b0, name: 'x' })).toBe(false);
	});
});
