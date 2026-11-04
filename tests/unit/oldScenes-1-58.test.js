// 68-int — THE OLD-SCENE SET for 1.58 (every release that adds a saved type ships one): 1.58 adds the
// `prop` track kind (keyframes of one property) to saved sequences. A sequence saved by 1.56 / 1.57
// (tests/fixtures/sequences-1.57/intro.json — written by v1.57.0's own normalizeSequence, identical on
// v1.56.0) must load UNCHANGED, and a kind this version does not know (a newer one) must ride through
// verbatim instead of turning into an event track (the Timeline shows "made with a newer version").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSequence, normalizeTrack, isTrackKind } from '../../src/lib/sequenceCore.js';

const OLD = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/sequences-1.57/intro.json'), 'utf8'));

describe('1.58 old-scene set: sequences', () => {
	it('a sequence saved by 1.56 / 1.57 normalizes to exactly itself', () => {
		expect(normalizeSequence(structuredClone(OLD))).toEqual(OLD);
	});
	it('a newer kind is kept verbatim (its items and fields), not coerced to event', () => {
		const newer = { id: 'tr-x', kind: 'hologram', name: '', items: [{ id: 'h1', t: 2, beam: 3 }], power: 9 };
		const t = normalizeTrack(newer);
		expect(isTrackKind('hologram')).toBe(false);
		expect(t).toMatchObject({ id: 'tr-x', kind: 'hologram', name: 'hologram', items: [{ id: 'h1', t: 2, beam: 3 }], power: 9 });
		const seq = normalizeSequence({ ...structuredClone(OLD), tracks: [...OLD.tracks, newer] });
		expect(seq.tracks.at(-1).kind).toBe('hologram');
		expect(seq.tracks.slice(0, -1)).toEqual(OLD.tracks);
	});
	it("1.58's own prop track round-trips", () => {
		const prop = { id: 'tr-fov', kind: 'prop', target: 'cam-a', path: 'camera.fov', type: 'number', keys: [{ id: 'k1', t: 0, v: 50 }, { id: 'k2', t: 2, v: 30 }] };
		const once = normalizeTrack(prop);
		expect(normalizeTrack(structuredClone(once))).toEqual(once);
		expect(once.keys.map((/** @type {any} */ k) => [k.t, k.v])).toEqual([[0, 50], [2, 30]]);
	});
});
