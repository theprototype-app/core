// 30b (core-games): the Game Feel flow nodes' pure halves — the {v} fill an Announce shows,
// and which Game Music node wants to play (a DECLARATION, read every frame).
import { describe, it, expect } from 'vitest';
import { fillValue, musicWanted, MUSIC_PRESET_IDS } from '../../src/lib/gameFeelActions.js';

describe('Announce: {v}', () => {
	it('fills every {v} with the wired number at the asked decimals', () => {
		expect(fillValue('Ring {v} reached', 2)).toBe('Ring 2 reached');
		expect(fillValue('{v} m of {v}', 3.456, 1)).toBe('3.5 m of 3.5');
	});
	it('passes text through and leaves a plain line alone', () => {
		expect(fillValue('Top of the tower!', 9)).toBe('Top of the tower!');
		expect(fillValue('Hi {v}', 'Ada')).toBe('Hi Ada');
		expect(fillValue('Stars: {v}', undefined)).toBe('Stars: ');
	});
});

describe('Game Music: who wants to play', () => {
	const id = (/** @type {any} */ n) => n.data;
	const node = (/** @type {string} */ nid, /** @type {any} */ data) => ({ id: nid, type: 'gamemusic', data });
	it('the first wanting node wins, in graph order', () => {
		const nodes = [{ id: 'x', type: 'time', data: {} }, node('a', { preset: 'space', volume: 0.5 }), node('b', { preset: 'arcade' })];
		expect(musicWanted(nodes, id, 'menu')).toEqual({ id: 'a', preset: 'space', volume: 0.5 });
	});
	it('an `on` wired false steps aside for the next one', () => {
		const nodes = [node('a', { preset: 'space', on: false }), node('b', { preset: 'arcade', on: true })];
		expect(musicWanted(nodes, id, 'menu')?.id).toBe('b');
		expect(musicWanted([node('a', { preset: 'space', on: 0 })], id, 'menu')).toBeNull();
	});
	it("'round' plays only while the round runs (playing or paused)", () => {
		const nodes = [node('a', { preset: 'space', while: 'round' })];
		expect(musicWanted(nodes, id, 'menu')).toBeNull();
		expect(musicWanted(nodes, id, 'over')).toBeNull();
		expect(musicWanted(nodes, id, 'playing')?.id).toBe('a');
		expect(musicWanted(nodes, id, 'paused')?.id).toBe('a');
	});
	it('an unknown preset is nobody, volume is clamped and defaults to 0.7', () => {
		expect(musicWanted([node('a', { preset: 'polka' })], id, 'menu')).toBeNull();
		expect(musicWanted([node('a', { preset: 'space', volume: 7 })], id, 'menu')?.volume).toBe(1);
		expect(musicWanted([node('a', { preset: 'space' })], id, 'menu')?.volume).toBe(0.7);
	});
	it('every preset the palette offers is one the player can play', () => {
		expect(MUSIC_PRESET_IDS).toEqual(expect.arrayContaining(['arcade', 'ambient', 'space', 'studio']));
	});
});
