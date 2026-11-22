// @ts-nocheck: inline fixtures (the rules are typed in their modules)
// fix-film (1.58 owner bug + film-mode follow-ups) — the PURE rules:
//   · the VR UI gate: Film open or walking stands every in-headset UI down (and the VR welcome)
//   · roomLook: what an AR session shows behind the scene (Film's walk keeps the sky by default)
//   · the motion picker: choices per device, the mode in effect, the pill's words
//   · the walk's tracking-loss verdict (a take gives up sooner than an idle walk)
//   · the shots sheet: rename / trim / delete + undo / export plans; a retake keeps the name
//   · the export of chosen ranges: frame i → sequence time
import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import {
	motionOptions,
	effectiveMotion,
	defaultMotion,
	motionLabel,
	trackingVerdict,
	TRACKING_GRACE_S,
	passthroughLook,
	PASSTHROUGH,
	WALK_SCALE_CHIPS
} from '../../src/lib/film/filmCore.js';
import {
	commitTake,
	filmShots,
	shotKind,
	shotName,
	renameShot,
	trimShot,
	deleteShot,
	restoreShot,
	exportPlanFor,
	exportLabel
} from '../../src/lib/film/filmTake.js';
import { normalizeSequence } from '../../src/lib/sequenceCore.js';
import { rangeTime, rangesDuration } from '../../src/lib/recording/frameClock.js';

const { vrUiHidden, vrUiStandsDown } = await import('../../src/lib/vrUiGate.js');
const { filmOpen } = await import('../../src/lib/film/filmState.js');
const { filmWalkActive, arTable, AR_OFF } = await import('../../src/lib/arTableState.js');
const { roomLook, skyOverRoom, passthroughActive, setSessionComposites } = await import('../../src/stores/sceneStore.js');
const { vrWelcomeStandsDown } = await import('../../src/lib/tours/builtin.js');

describe('the VR UI gate (tour, wrist menus, panels, HUD)', () => {
	it('stands down while Film is open, in any session, and while its walk runs', () => {
		filmOpen.set(null);
		filmWalkActive.set(false);
		expect(get(vrUiHidden)).toBe(false);
		filmOpen.set({ uuid: 'cam' });
		expect(vrUiStandsDown()).toBe(true);
		filmOpen.set(null);
		filmWalkActive.set(true);
		expect(vrUiStandsDown()).toBe(true);
		filmWalkActive.set(false);
		expect(vrUiStandsDown()).toBe(false);
	});
	it('the VR welcome never auto-starts in Film, its walk, or an AR table', () => {
		expect(vrWelcomeStandsDown()).toBe(false);
		filmOpen.set({ uuid: 'cam' });
		expect(vrWelcomeStandsDown()).toBe(true);
		filmOpen.set(null);
		arTable.set({ ...AR_OFF, phase: 'placed' });
		expect(vrWelcomeStandsDown()).toBe(true);
		arTable.set({ ...AR_OFF });
		expect(vrWelcomeStandsDown()).toBe(false);
	});
});

describe('roomLook — the live view behind an AR session', () => {
	it('an ordinary AR session lifts the sky (the room shows); a VR session changes nothing', () => {
		roomLook.set('room');
		setSessionComposites(true);
		expect(get(passthroughActive)).toBe(true);
		expect(get(skyOverRoom)).toBe(false);
		setSessionComposites(false);
		expect(get(passthroughActive)).toBe(false);
	});
	it("Film's Off keeps the scene's own sky over the room; Dimmed lifts it; the session end resets", () => {
		roomLook.set(passthroughLook('off'));
		setSessionComposites(true);
		expect(get(passthroughActive)).toBe(false);
		expect(get(skyOverRoom)).toBe(true);
		roomLook.set(passthroughLook('dim'));
		expect(get(passthroughActive)).toBe(true);
		expect(get(skyOverRoom)).toBe(false);
		setSessionComposites(false);
		expect(get(passthroughActive)).toBe(false);
		expect(get(skyOverRoom)).toBe(false);
		roomLook.set('room');
	});
	it('the three choices, Off first (the default)', () => {
		expect(PASSTHROUGH.map((p) => p.key)).toEqual(['off', 'on', 'dim']);
		expect(passthroughLook('on')).toBe('room');
		expect(passthroughLook('nonsense')).toBe('sky');
		expect(WALK_SCALE_CHIPS).toEqual([0.5, 1, 2, 5]);
	});
});

describe('the motion picker', () => {
	const phone = { touch: true, gyro: true, ar: 'ready', keyboard: false };
	it('a phone with AR: Phone tilt, Touch, Walk, Tripod (no keyboard row)', () => {
		expect(motionOptions(phone).map((o) => o.key)).toEqual(['tilt', 'touch', 'walk', 'tripod']);
		expect(motionOptions(phone).every((o) => o.available)).toBe(true);
	});
	it('no AR: no Walk; a desktop gets Keyboard + mouse; no gyro disables Phone tilt with the reason', () => {
		const desk = motionOptions({ touch: false, gyro: false, ar: 'unsupported', keyboard: true });
		expect(desk.map((o) => o.key)).toEqual(['tilt', 'touch', 'tripod', 'keys']);
		const tilt = desk.find((o) => o.key === 'tilt');
		expect(tilt.available).toBe(false);
		expect(tilt.reason).toMatch(/No motion sensor/);
		const checking = motionOptions({ ...phone, ar: 'checking' }).find((o) => o.key === 'walk');
		expect(checking.available).toBe(false);
	});
	it('the mode in effect: no gyro → Touch; a remembered Walk waits (tilt) until started; walking = Walk', () => {
		const ctx = { gyro: true, walking: false, keyboard: false, touch: true };
		expect(effectiveMotion('tilt', ctx)).toBe('tilt');
		expect(effectiveMotion('tilt', { ...ctx, gyro: false })).toBe('touch');
		expect(effectiveMotion('walk', ctx)).toBe('tilt');
		expect(effectiveMotion('walk', { ...ctx, walking: true })).toBe('walk');
		expect(effectiveMotion('tripod', ctx)).toBe('tripod');
		expect(effectiveMotion('keys', ctx)).toBe('tilt');
		expect(effectiveMotion('keys', { ...ctx, keyboard: true })).toBe('keys');
		expect(effectiveMotion('tilt', { gyro: false, walking: false, keyboard: true, touch: false })).toBe('keys');
		expect(defaultMotion({ touch: true })).toBe('tilt');
		expect(defaultMotion({ touch: false })).toBe('keys');
	});
	it('the pill always names the mode', () => {
		expect(motionLabel('tilt')).toBe('Phone tilt');
		expect(motionLabel('tilt', { starting: true })).toBe('Phone tilt…');
		expect(motionLabel('keys')).toBe('Keyboard + mouse');
		expect(motionLabel('tilt', { waiting: true })).toBe('Walk · tap to start');
	});
});

describe("the walk's tracking-loss rule", () => {
	it('tracked = ok; a blip waits; past the grace it falls back — sooner during a take', () => {
		expect(trackingVerdict(0, true)).toBe('ok');
		expect(trackingVerdict(0.2, true)).toBe('wait');
		expect(trackingVerdict(TRACKING_GRACE_S.recording, true)).toBe('fallback');
		expect(trackingVerdict(1, false)).toBe('wait');
		expect(trackingVerdict(TRACKING_GRACE_S.idle, false)).toBe('fallback');
		expect(TRACKING_GRACE_S.recording).toBeLessThan(TRACKING_GRACE_S.idle);
	});
});

const CAM = 'cam-1';
function samples(t0, t1) {
	const out = [];
	for (let t = t0; t <= t1 + 1e-9; t += 1 / 30) out.push({ t, pos: [t, 1.6, 0], quat: [0, 0, 0, 1], fov: 50, roll: 0 });
	return out;
}
function threeShots() {
	let seq = normalizeSequence({ name: 'Film', duration: 0, tracks: [] });
	const a = commitTake(seq, { camera: CAM, mode: 'cut', samples: samples(0, 2), thumb: 'hashA' });
	const b = commitTake(a.seq, { camera: CAM, mode: 'cut', samples: samples(2, 5) });
	const c = commitTake(b.seq, { camera: CAM, mode: 'move', itemId: b.itemId, samples: samples(5, 6) });
	const d = commitTake(c.seq, { camera: CAM, mode: 'cut', samples: samples(6, 7) });
	return { seq: d.seq, ids: [a.itemId, b.itemId, d.itemId] };
}

describe('the shots sheet edits', () => {
	it('a shot keeps its thumbnail hash; a Move counts on the shot it continues', () => {
		const { seq, ids } = threeShots();
		const shots = filmShots(seq, CAM);
		expect(shots.map((s) => s.id)).toEqual(ids);
		expect(shots[0].thumb).toBe('hashA');
		expect(shotKind(shots[0])).toBe('Cut');
		expect(shotKind(shots[1])).toBe('Cut + 1 move');
		expect(shotName(shots[2], 2)).toBe('Shot 3');
	});
	it('rename: trimmed + capped, "" goes back to "Shot N", unchanged = null; a retake keeps the name', () => {
		const { seq, ids } = threeShots();
		const r = renameShot(seq, CAM, ids[0], '  The   wide  ');
		expect(filmShots(r, CAM)[0].name).toBe('The wide');
		expect(renameShot(r, CAM, ids[0], 'The wide')).toBeNull();
		expect(filmShots(renameShot(r, CAM, ids[0], ''), CAM)[0].name).toBeUndefined();
		expect(filmShots(renameShot(seq, CAM, ids[0], 'x'.repeat(80)), CAM)[0].name.length).toBe(60);
		const re = commitTake(r, { camera: CAM, mode: 'retake', itemId: ids[0], samples: samples(0, 1.5) });
		expect(filmShots(re.seq, CAM)[0].name).toBe('The wide');
		expect(filmShots(seq, CAM)[0].name).toBeUndefined(); // the input document is untouched
	});
	it('trim: in / out inside the shot as recorded, never past it, never under the smallest item; back out restores', () => {
		const { seq, ids } = threeShots();
		const t = trimShot(seq, CAM, ids[1], 3, 4.5);
		const s = filmShots(t, CAM).find((x) => x.id === ids[1]);
		expect(s.t).toBeCloseTo(3, 6);
		expect(s.dur).toBeCloseTo(1.5, 6);
		expect(s.recT).toBeCloseTo(2, 6);
		expect(s.recDur).toBeCloseTo(4, 6);
		const wide = filmShots(trimShot(t, CAM, ids[1], -5, 99), CAM).find((x) => x.id === ids[1]);
		expect(wide.t).toBeCloseTo(2, 6);
		expect(wide.t + wide.dur).toBeCloseTo(6, 6);
		const crossed = filmShots(trimShot(seq, CAM, ids[1], 5.9, 2.1), CAM).find((x) => x.id === ids[1]);
		expect(crossed.dur).toBeGreaterThan(0);
		// the other shots never move
		expect(filmShots(t, CAM).filter((x) => x.id !== ids[1])).toEqual(filmShots(seq, CAM).filter((x) => x.id !== ids[1]));
	});
	it('delete + undo puts the very same item back', () => {
		const { seq, ids } = threeShots();
		const del = deleteShot(seq, CAM, ids[1]);
		expect(filmShots(del.seq, CAM).map((s) => s.id)).toEqual([ids[0], ids[2]]);
		const back = restoreShot(del.seq, CAM, del.removed);
		expect(filmShots(back, CAM)).toEqual(filmShots(seq, CAM));
		expect(restoreShot(back, CAM, del.removed)).toBeNull();
		expect(deleteShot(seq, CAM, 'nope')).toBeNull();
	});
	it('export: all (none ticked) or the ticked ones, in recorded order; joined = one file, else one per shot', () => {
		const { seq, ids } = threeShots();
		const shots = filmShots(seq, CAM);
		const all = exportPlanFor(shots, [], true);
		expect(all.count).toBe(3);
		expect(all.queue.length).toBe(1);
		expect(all.queue[0].map((r) => r.map((v) => Math.round(v * 10) / 10))).toEqual([[0, 2], [2, 6], [6, 7]]);
		expect(all.seconds).toBeCloseTo(7, 1);
		const two = exportPlanFor(shots, [ids[2], ids[0]], false);
		expect(two.queue.map((q) => q.length)).toEqual([1, 1]);
		expect(two.queue[0][0][0]).toBeCloseTo(0, 6); // recorded order, not tick order
		expect(exportLabel(3, 0)).toBe('Export all (3)');
		expect(exportLabel(3, 2)).toBe('Export 2 selected');
		expect(exportPlanFor([], [], true).queue).toEqual([]);
	});
});

describe('exporting chosen ranges', () => {
	it('frame i walks the ranges back to back and holds the last moment', () => {
		const ranges = [
			[1, 2],
			[5, 5.5]
		];
		expect(rangesDuration(ranges)).toBeCloseTo(1.5, 9);
		expect(rangeTime(0, 30, ranges)).toBeCloseTo(1, 9);
		expect(rangeTime(15, 30, ranges)).toBeCloseTo(1.5, 9);
		expect(rangeTime(30, 30, ranges)).toBeCloseTo(5, 9);
		expect(rangeTime(39, 30, ranges)).toBeCloseTo(5.3, 9);
		expect(rangeTime(999, 30, ranges)).toBeCloseTo(5.5, 9);
	});
});
