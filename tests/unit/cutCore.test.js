// 77 K1/K2/K3/K5: the cut's pure half — the older-peer migration, the edit maths and the program at t
import { describe, it, expect } from 'vitest';
import { normalizeSequence, normalizeTrack, normalizeItem, shotAt, snapTargets } from '../../src/lib/sequenceCore.js';
import {
	splitItem,
	splitAt,
	rippleDelete,
	trimItem,
	slipItem,
	addMarker,
	removeMarker,
	nextStop,
	hasCutContent,
	programAt,
	outgoingShot,
	framesNeeded
} from '../../src/lib/cutCore.js';

/** what a 1.43 peer's normalizeTrack does to a kind it does not know (its code, verbatim in effect) */
function oldPeerNormalize(raw) {
	const items = raw.items.map((it) => ({ ...it, id: it.id, t: it.t, dur: 0, name: it.name || 'event' }));
	return { ...raw, kind: 'event', name: raw.name || 'Event', muted: !!raw.muted, items };
}

const cut = () =>
	normalizeSequence({
		id: 'seq-cut',
		duration: 30,
		fps: 30,
		tracks: [
			{ id: 'tr-title', kind: 'title', items: [{ id: 't1', t: 2, dur: 3, text: 'HELLO', trans: { kind: 'fade', dur: 1 }, fadeOut: 1 }] },
			{
				id: 'tr-v2',
				kind: 'video',
				items: [{ id: 'v2', t: 10, dur: 2, src: 'h-top', trans: { kind: 'wipe', dur: 1, dir: 'up' } }]
			},
			{
				id: 'tr-v1',
				kind: 'video',
				items: [
					{ id: 'v1a', t: 6, dur: 4, src: 'h-a', in: 1, srcDur: 20 },
					{ id: 'v1b', t: 10, dur: 4, src: 'h-b', trans: { kind: 'crossfade', dur: 1 } }
				]
			},
			{
				id: 'tr-cam',
				kind: 'camera',
				items: [
					{ id: 'c1', t: 0, dur: 6, camera: 'cam-a', to: 'cam-b', ease: 'linear' },
					{ id: 'c2', t: 6, dur: 6, camera: 'cam-c', trans: { kind: 'crossfade', dur: 2 } },
					{ id: 'c3', t: 12, dur: 6, camera: 'cam-a', trans: { kind: 'dip', dur: 1, color: 'white' }, fadeOut: 2 }
				]
			}
		]
	});

describe('older peers (the ext / len migration)', () => {
	it('a cut track writes its kind as `ext` and every item its length as `len`', () => {
		const s = cut();
		const v = s.tracks.find((t) => t.kind === 'video');
		expect(v.ext).toBe('video');
		expect(v.items.every((it) => it.len === it.dur)).toBe(true);
	});
	it('counterfactual: a 1.43 peer turns it into an event track with zero-length items…', () => {
		const old = oldPeerNormalize(cut().tracks[2]);
		expect(old.kind).toBe('event');
		expect(old.items[0].dur).toBe(0);
	});
	it('…and the next new peer revives it exactly', () => {
		const orig = cut().tracks[2];
		const back = normalizeTrack(oldPeerNormalize(orig));
		expect(back.kind).toBe('video');
		expect(back.items.map((it) => [it.id, it.t, it.dur, it.src, it.in ?? 0])).toEqual(
			orig.items.map((it) => [it.id, it.t, it.dur, it.src, it.in ?? 0])
		);
		const title = normalizeTrack(oldPeerNormalize(cut().tracks[0]));
		expect(title.kind).toBe('title');
		expect(title.items[0].text).toBe('HELLO');
		expect(title.items[0].dur).toBe(3);
	});
	it('a document without cut content is byte-identical (no new fields appear)', () => {
		const plain = { id: 's', name: 'S', duration: 5, fps: 30, autoplay: false, loop: false, changedAt: 0, tracks: [{ id: 'a', kind: 'audio', name: 'Audio', muted: false, items: [{ id: 'i', t: 0, dur: 2, sound: '', name: '', gain: 1 }] }] };
		expect(normalizeSequence(plain)).toEqual(plain);
		expect(normalizeItem('camera', { camera: 'x' })).not.toHaveProperty('b0');
		expect(normalizeItem('anim', { target: 'x' })).not.toHaveProperty('in');
	});
	it('transitions and markers normalize, absent stays absent', () => {
		expect(normalizeItem('camera', { trans: { kind: 'bogus' } })).not.toHaveProperty('trans');
		const w = normalizeItem('video', { dur: 2, trans: { kind: 'wipe', dur: 9, dir: 'sideways' } }).trans;
		expect(w).toEqual({ kind: 'wipe', dur: 2, dir: 'left' });
		expect(normalizeItem('camera', { dur: 4, trans: { kind: 'dip', dur: 1, color: 'pink' } }).trans.color).toBe('black');
		expect(normalizeSequence({ markers: [] })).not.toHaveProperty('markers');
		const m = normalizeSequence({ markers: [{ t: 5 }, { t: 1, name: 'a' }] }).markers;
		expect(m.map((x) => x.t)).toEqual([1, 5]);
		expect(snapTargets(normalizeSequence({ duration: 9, markers: [{ t: 4 }] }))).toContain(4);
	});
});

describe('edits', () => {
	it('split continues the source on the right half (clip in, glide slice, fades)', () => {
		const s = cut();
		const v = s.tracks[2].items[0]; // t 6, dur 4, in 1
		const [l, r] = splitItem('video', v, 7.5, 'r');
		expect([l.t, l.dur, l.in]).toEqual([6, 1.5, 1]);
		expect([r.id, r.t, r.dur, r.in]).toEqual(['r', 7.5, 2.5, 2.5]);
		expect([l.len, r.len]).toEqual([1.5, 2.5]);
		const c = s.tracks[3].items[0]; // glide over 0..6
		const [cl, cr] = splitItem('camera', c, 3);
		expect([cl.b0, cl.b1, cr.b0, cr.b1]).toEqual([0, 0.5, 0.5, 1]);
		// the glide does not jump at the split: same blend either side of it
		const seqL = normalizeSequence({ tracks: [{ kind: 'camera', items: [cl, cr] }] });
		expect(shotAt(seqL, 2.999).blend).toBeCloseTo(shotAt(s, 2.999).blend, 3);
		expect(shotAt(seqL, 3.001).blend).toBeCloseTo(shotAt(s, 3.001).blend, 3);
		const c3 = s.tracks[3].items[2];
		const [x, y] = splitItem('camera', c3, 15);
		expect(x.trans.kind).toBe('dip');
		expect(x.fadeOut).toBeUndefined();
		expect(y.trans).toBeUndefined();
		expect(y.fadeOut).toBe(2);
		const a = splitItem('anim', normalizeItem('anim', { t: 0, dur: 4, speed: 2 }), 1);
		expect(a[1].in).toBe(2); // clip seconds = sequence seconds × speed
		expect(splitItem('video', v, 6)).toBe(null); // at an edge: nothing to split
		expect(splitItem('event', { t: 0, dur: 0 }, 0)).toBe(null);
	});
	it('splitAt: the selection, else everything under the playhead', () => {
		const s = cut();
		const all = splitAt(s, 11);
		// v2 (10..12), v1b (10..14), c2 (6..12) are under 11; the title is not
		expect(all.created.length).toBe(3);
		const one = splitAt(s, 11, ['v1b']);
		expect(one.created.length).toBe(1);
		expect(one.doc.tracks[2].items.length).toBe(3);
	});
	it('ripple delete closes the gap on that track only', () => {
		const s = normalizeSequence({
			tracks: [
				{ id: 'a', kind: 'video', items: [{ id: 'x', t: 0, dur: 2 }, { id: 'y', t: 2, dur: 3 }, { id: 'z', t: 6, dur: 1 }] },
				{ id: 'b', kind: 'title', items: [{ id: 'k', t: 6, dur: 1 }] }
			]
		});
		const out = rippleDelete(s, ['y']);
		expect(out.tracks[0].items.map((it) => [it.id, it.t])).toEqual([['x', 0], ['z', 3]]);
		expect(out.tracks[1].items[0].t).toBe(6);
		const two = rippleDelete(s, ['x', 'y']);
		expect(two.tracks[0].items.map((it) => it.t)).toEqual([1]);
	});
	it('trim: left advances the source, neither edge runs past the source', () => {
		const v = normalizeItem('video', { t: 6, dur: 4, in: 1, srcDur: 10 });
		expect(trimItem('video', v, 'left', 7)).toEqual({ t: 7, dur: 3, in: 2 });
		expect(trimItem('video', v, 'left', 0)).toEqual({ t: 5, dur: 5, in: 0 }); // frame 0 stops it
		expect(trimItem('video', v, 'right', 99)).toEqual({ dur: 9 }); // 10 - in 1
		const still = normalizeItem('video', { t: 2, dur: 2, media: 'image' });
		expect(trimItem('video', still, 'left', 0)).toEqual({ t: 0, dur: 4 }); // a still has no source
		expect(trimItem('title', normalizeItem('title', { t: 1, dur: 2 }), 'right', 10)).toEqual({ dur: 9 });
	});
	it('slip changes the source window only', () => {
		const v = normalizeItem('video', { t: 6, dur: 4, in: 1, srcDur: 10 });
		expect(slipItem('video', v, 2)).toEqual({ in: 3 });
		expect(slipItem('video', v, 99)).toEqual({ in: 6 });
		expect(slipItem('video', v, -9)).toEqual({ in: 0 });
		expect(slipItem('title', normalizeItem('title', {}), 1)).toBe(null);
	});
	it('markers + jump stops', () => {
		const s = cut();
		const { doc, id } = addMarker(s, 4.5, 'beat');
		expect(doc.markers[0]).toMatchObject({ id, t: 4.5 });
		expect(nextStop(doc, 4, 1)).toBe(4.5);
		expect(nextStop(doc, 4.5, -1)).toBe(2);
		expect(removeMarker(doc, id)).not.toHaveProperty('markers');
	});
});

describe('the program at t', () => {
	it('hasCutContent', () => {
		expect(hasCutContent(cut())).toBe(true);
		expect(hasCutContent(normalizeSequence({ tracks: [{ kind: 'camera', items: [{ camera: 'x' }] }] }))).toBe(false);
		expect(hasCutContent(normalizeSequence({ tracks: [{ kind: 'camera', items: [{ camera: 'x', fadeOut: 1 }] }] }))).toBe(true);
	});
	it('a shot crossfade carries the outgoing shot, held at its end once it ended', () => {
		const s = cut();
		const p = programAt(s, 7);
		expect(p.shot.item.id).toBe('c2');
		expect(p.shotTrans.kind).toBe('crossfade');
		expect(p.shotTrans.p).toBeCloseTo(0.5, 5);
		expect(p.shotTrans.prev.item.id).toBe('c1');
		expect(p.shotTrans.prev.blend).toBe(1); // c1 ended at 6: its end pose
		expect(programAt(s, 8.5).shotTrans).toBe(null);
		expect(outgoingShot(s, s.tracks[3].items[0], 1)).toBe(null); // the first shot has none
	});
	it('a dip is centred on the cut: half over the outgoing shot, half over the incoming', () => {
		const s = cut();
		expect(programAt(s, 11.75).veils).toEqual([{ color: 'white', alpha: 0.5 }]);
		expect(programAt(s, 11.25).veils).toEqual([]);
		expect(programAt(s, 12).veils[0].alpha).toBe(1);
		expect(programAt(s, 12.25).veils[0].alpha).toBeCloseTo(0.5, 5);
		expect(programAt(s, 12.6).veils).toEqual([]);
		// the fade out at c3's end
		expect(programAt(s, 17).veils[0]).toEqual({ color: 'black', alpha: 0.5 });
	});
	it('clip layers: top track on top, crossfade over the previous clip, wipe reveals', () => {
		const s = cut();
		const p = programAt(s, 10.5);
		expect(p.layers.map((l) => l.item.id)).toEqual(['v1b', 'v2']); // bottom first
		const [b, top] = p.layers;
		expect(b.alpha).toBeCloseTo(0.5, 5);
		expect(b.prev.item.id).toBe('v1a');
		expect(b.prev.local).toBeCloseTo(1 + 4 - 1 / 30, 5); // held on v1a's last frame
		expect(top.wipe).toEqual({ p: 0.5, dir: 'up' });
		expect(top.prev).toBe(null); // nothing before it on its track: it wipes over the layers below
		expect(programAt(s, 7).layers[0].local).toBe(2); // in 1 + 1 s in
		expect(framesNeeded(s, 10.5).map((f) => f.src)).toEqual(['h-b', 'h-a', 'h-top']);
	});
	it('titles fade themselves, not the frame', () => {
		const s = cut();
		const p = programAt(s, 2.5);
		expect(p.titles[0].alpha).toBeCloseTo(0.5, 5);
		expect(p.veils).toEqual([]);
		expect(programAt(s, 4.75).titles[0].alpha).toBeCloseTo(0.25, 5);
		expect(programAt(s, 5).titles).toEqual([]);
	});
	it('a muted track draws nothing', () => {
		const s = cut();
		s.tracks[2].muted = true;
		expect(programAt(s, 7).layers).toEqual([]);
	});
});
