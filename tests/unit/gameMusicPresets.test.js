// 30b (vr-play) C5: the game-music presets as data, with no browser — every preset the
// contract names exists, every lane is a real 16-step bar, the triads are built inside the
// mode, and a step is a pure function of (preset, step), which is what makes two peers on
// one preset hear the same bar.
import { describe, it, expect } from 'vitest';
import { MUSIC_PRESETS, MUSIC_PRESET_IDS, musicPreset, stepEvents, triadOn, stepSeconds } from '../../src/lib/gameMusicPresets.js';

describe('game music presets', () => {
	it('ships exactly the contract presets', () => {
		expect([...MUSIC_PRESET_IDS].sort()).toEqual(['ambient', 'arcade', 'dungeon', 'puzzle', 'space', 'stadium', 'studio']);
		expect(musicPreset('nope')).toBeNull();
	});

	it('every lane is a 16-step bar and the tempo is sane', () => {
		for (const p of MUSIC_PRESETS) {
			expect(p.bass.length).toBe(16);
			for (const lane of Object.values(p.drums)) if (lane) expect(lane.length).toBe(16);
			if (p.arp) expect(p.arp.lane.length).toBe(16);
			expect(p.bpm).toBeGreaterThanOrEqual(60);
			expect(p.bpm).toBeLessThanOrEqual(160);
			expect(stepSeconds(p)).toBeCloseTo(60 / p.bpm / 4, 9);
		}
	});

	it('triads stack thirds inside the mode (minor i is minor, major I is major)', () => {
		const arcade = /** @type {any} */ (musicPreset('arcade')); // C major
		expect(triadOn(arcade, 0)).toEqual([60, 64, 67]);
		expect(triadOn(arcade, 4)).toEqual([67, 71, 74]); // G major
		const studio = /** @type {any} */ (musicPreset('studio')); // G minor
		const [r, t, f] = triadOn(studio, 0);
		expect(t - r).toBe(3);
		expect(f - r).toBe(7);
	});

	it('every preset plays notes in every bar of its loop', () => {
		for (const p of MUSIC_PRESETS) {
			for (let bar = 0; bar < p.progression.length; bar++) {
				let notes = 0;
				for (let i = 0; i < 16; i++) notes += stepEvents(p, bar * 16 + i).length;
				expect(notes, p.id + ' bar ' + bar).toBeGreaterThan(0);
			}
		}
	});

	it('a step is a pure function of (preset, step) and loops with the progression', () => {
		const space = /** @type {any} */ (musicPreset('space'));
		const loop = space.progression.length * 16;
		for (const step of [0, 5, 17, 40, 63]) {
			expect(stepEvents(space, step)).toEqual(stepEvents(space, step));
			expect(stepEvents(space, step)).toEqual(stepEvents(space, step + loop));
		}
		// the chord changes with the bar: the bass root of bar 0 differs from bar 1
		const root = (/** @type {number} */ step) => stepEvents(space, step).find((e) => e.kind === 'bass')?.midi;
		expect(root(0)).not.toEqual(root(16));
	});

	it('the pad holds the bar triad on its downbeat only', () => {
		const ambient = /** @type {any} */ (musicPreset('ambient'));
		expect(stepEvents(ambient, 0).some((e) => e.kind === 'pad')).toBe(true);
		expect(stepEvents(ambient, 1).some((e) => e.kind === 'pad')).toBe(false);
	});
});
