// 104 B2 — which camera the person looks through: the kind from the facts each source leaves (pure).
import { describe, it, expect } from 'vitest';
import { throughKind, THROUGH_KINDS } from '../../src/lib/connector/throughCameraCore.js';

const none = { preview: null, film: null, filmRecording: false, recorder: false, sequence: null, playing: false };
describe('throughKind (104 B2)', () => {
	it('nothing previewed and nothing recording: the person\'s own view', () => {
		expect(throughKind(none)).toBeNull();
		expect(throughKind({ ...none, playing: true })).toBeNull();
	});
	it('each source by its own fact, in precedence', () => {
		expect(throughKind({ ...none, preview: 'c' })).toBe('preview');
		expect(throughKind({ ...none, preview: 'c', playing: true })).toBe('play');
		expect(throughKind({ ...none, preview: 'c', playing: true, sequence: 'c' })).toBe('sequence');
		expect(throughKind({ ...none, preview: 'c', sequence: 'c', film: 'c' })).toBe('phone');
		expect(throughKind({ ...none, preview: 'c', film: 'c', filmRecording: true })).toBe('recording');
		expect(throughKind({ ...none, recorder: true })).toBe('recording');
		expect(throughKind({ ...none, preview: 'c', recorder: true })).toBe('recording');
	});
	it('a sequence or Film on ANOTHER camera than the one shown does not name this one', () => {
		expect(throughKind({ ...none, preview: 'c', sequence: 'd' })).toBe('preview');
		expect(throughKind({ ...none, preview: 'c', film: 'd' })).toBe('preview');
	});
	it('the kinds are the five the brief names', () => {
		expect([...THROUGH_KINDS]).toEqual(['preview', 'play', 'sequence', 'phone', 'recording']);
	});
});
