// 102-splats: the splat rows in the tables other domains own (Photo parity, Cinematic chip, wire gate)
import { describe, it, expect } from 'vitest';
import { meshKind, parityNotes, PHOTO_PARITY } from '../../src/lib/photo/photoCore.js';
import { STAND_IN_LABELS, notShownText } from '../../src/lib/cinematic/cinematicCore.js';

describe('102 splats in Photo mode', () => {
	it('a splat carrier is left out and counted; a Spark mesh is a helper', () => {
		expect(meshKind({ isMesh: true, userData: { splat: { hash: 'a' } }, material: {} })).toBe('skip-splat');
		expect(meshKind({ isMesh: true, userData: { splatVisual: true }, material: { isShaderMaterial: true } })).toBe('skip-helper');
	});
	it('the parity note names Gaussian splats', () => {
		expect(PHOTO_PARITY.some((r) => r.kind === 'splats' && r.shows === 'no')).toBe(true);
		const notes = parityNotes({ 'skip-splat': 2 });
		expect(notes).toHaveLength(1);
		expect(notes[0].count).toBe(2);
		expect(notes[0].note).toMatch(/Gaussian splats/);
	});
});

describe('102 splats in Cinematic view', () => {
	it('the chip has a label for them', () => {
		expect(STAND_IN_LABELS.splats).toBe('Gaussian splats');
		expect(notShownText(['splats'])).toBe('Not shown in Cinematic view: Gaussian splats');
	});
});
