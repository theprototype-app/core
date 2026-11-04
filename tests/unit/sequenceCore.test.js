// 48 S1/S2: the pure half of the Timeline — documents, evaluation, crossings, snapping
import { describe, it, expect } from 'vitest';
import {
	normalizeSequence,
	normalizeTrack,
	normalizeItem,
	shotAt,
	crossedStarts,
	liveItems,
	playheadAt,
	snapTime,
	snapTargets,
	snapToFrame,
	findSequence,
	uniqueName,
	formatTime,
	rulerTicks,
	contentEnd,
	smooth
} from '../../src/lib/sequenceCore.js';

const seq = normalizeSequence({
	id: 'seq-a',
	name: 'Intro',
	duration: 10,
	tracks: [
		{
			id: 'tr-cam',
			kind: 'camera',
			items: [
				{ id: 'c2', t: 4, dur: 4, camera: 'cam-b', to: 'cam-c', ease: 'linear' },
				{ id: 'c1', t: 0, dur: 5, camera: 'cam-a' }
			]
		},
		{
			id: 'tr-anim',
			kind: 'anim',
			items: [{ id: 'a1', t: 1, dur: 2, target: 'door', clip: 'open' }]
		},
		{
			id: 'tr-ev',
			kind: 'event',
			items: [
				{ id: 'e1', t: 3, name: 'boom' },
				{ id: 'e0', t: 0, name: 'start' }
			]
		},
		{ id: 'tr-mute', kind: 'event', muted: true, items: [{ id: 'e9', t: 3, name: 'never' }] }
	]
});

describe('normalize', () => {
	it('fills defaults, sorts items, keeps unknown fields', () => {
		const s = normalizeSequence({
			future: 42,
			tracks: [{ kind: 'audio', items: [{ t: -3, gain: 9, extra: 'x' }] }]
		});
		expect(s.name).toBe('Sequence');
		expect(s.duration).toBe(10);
		expect(s.fps).toBe(30);
		expect(s.autoplay).toBe(false);
		expect(s.future).toBe(42);
		const it0 = s.tracks[0].items[0];
		expect(it0.t).toBe(0);
		expect(it0.gain).toBe(2);
		expect(it0.extra).toBe('x');
		expect(seq.tracks[0].items.map((/** @type {any} */ i) => i.id)).toEqual(['c1', 'c2']);
	});
	it('68: an UNKNOWN track kind is kept opaque (a newer peer\'s track survives our edit)', () => {
		const tr = normalizeTrack({ id: 'tr-x', kind: 'laser', beam: 3, items: [{ t: 1, dur: 5, power: 9 }] });
		expect(tr.kind).toBe('laser');
		expect(tr.beam).toBe(3);
		expect(tr.items).toEqual([{ t: 1, dur: 5, power: 9 }]);
		// and it never fires, plays or snaps like one of ours
		const s = normalizeSequence({ tracks: [tr] });
		expect(crossedStarts(s, -1, 10)).toEqual([]);
		expect(shotAt(s, 2)).toBe(null);
	});
	it('a track with NO kind is an event track; events have no length', () => {
		const tr = normalizeTrack({ items: [{ t: 1, dur: 5 }] });
		expect(tr.kind).toBe('event');
		expect(tr.items[0].dur).toBe(0);
		expect(tr.items[0].name).toBe('event');
	});
	it('clamps duration and per-kind fields', () => {
		expect(normalizeSequence({ duration: 0 }).duration).toBe(0.1);
		expect(normalizeSequence({ duration: 1e9 }).duration).toBe(3600);
		expect(normalizeItem('anim', { speed: 99 }).speed).toBe(4);
		expect(normalizeItem('camera', {}).ease).toBe('smooth');
	});
	it('is idempotent', () => {
		expect(normalizeSequence(seq)).toEqual(seq);
	});
});

describe('evaluation', () => {
	it('a later shot cuts an earlier one; gaps are the player view', () => {
		expect(shotAt(seq, 0)?.item.id).toBe('c1');
		expect(shotAt(seq, 4.5)?.item.id).toBe('c2');
		expect(shotAt(seq, 8.5)).toBe(null);
	});
	it('blend runs 0..1 through a shot with its ease', () => {
		expect(shotAt(seq, 6)?.blend).toBeCloseTo(0.5);
		expect(smooth(0.25)).toBeCloseTo(0.15625);
	});
	it('crossings: prev exclusive, now inclusive, muted tracks silent', () => {
		expect(crossedStarts(seq, -1, 0, 'event').map((x) => x.item.name)).toEqual(['start']);
		expect(crossedStarts(seq, 0, 3, 'event').map((x) => x.item.name)).toEqual(['boom']);
		expect(crossedStarts(seq, 3, 3.5, 'event')).toEqual([]);
		expect(crossedStarts(seq, 0.5, 1, 'anim').map((x) => x.item.id)).toEqual(['a1']);
	});
	it('live items carry their offset (a mid-way start)', () => {
		const live = liveItems(seq, 2, 'anim');
		expect(live.length).toBe(1);
		expect(live[0].offset).toBeCloseTo(1);
	});
	it('the playhead stops at the end, or wraps when looping', () => {
		expect(playheadAt(seq, 3)).toEqual({ t: 3, done: false, wraps: 0 });
		expect(playheadAt(seq, 12)).toEqual({ t: 10, done: true, wraps: 0 });
		const looped = playheadAt({ ...seq, loop: true }, 23);
		expect(looped.t).toBeCloseTo(3);
		expect(looped.wraps).toBe(2);
		expect(playheadAt(seq, 1, 4).t).toBe(5);
	});
	it('contentEnd is the furthest item edge', () => {
		expect(contentEnd(seq)).toBe(8);
	});
});

describe('snapping', () => {
	it('snaps to an edge within tolerance, else to the frame grid', () => {
		const targets = snapTargets(seq, new Set(['a1']), 2.5);
		expect(snapTime(4.96, targets, 0.1, 30)).toEqual({ t: 5, to: 5 });
		expect(snapTime(2.47, targets, 0.1, 30).to).toBe(2.5);
		expect(snapTime(6.51, targets, 0.05, 30).to).toBe(null);
		expect(snapToFrame(1.01, 30)).toBeCloseTo(1);
	});
	it('excluded items are not targets', () => {
		expect(snapTargets(seq, new Set(['a1'])).includes(1)).toBe(false);
	});
});

describe('helpers', () => {
	it('finds by id, then by name (case-insensitive)', () => {
		const all = { [seq.id]: seq };
		expect(findSequence(all, 'seq-a')?.name).toBe('Intro');
		expect(findSequence(all, 'intro')?.id).toBe('seq-a');
		expect(findSequence(all, '')).toBe(null);
	});
	it('unique names', () => {
		expect(uniqueName([])).toBe('Sequence');
		expect(uniqueName(['Sequence', 'sequence 2'])).toBe('Sequence 3');
	});
	it('formats m:ss.ff', () => {
		expect(formatTime(65.5, 30)).toBe('1:05.15');
	});
	it('ruler ticks keep labels apart', () => {
		const { step, ticks } = rulerTicks(0, 10, 600, 60);
		expect(step).toBe(1);
		expect(ticks[0]).toBe(0);
		expect(ticks.at(-1)).toBe(10);
	});
});
