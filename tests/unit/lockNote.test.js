import { describe, it, expect } from 'vitest';
import { lockNoteText } from '../../src/lib/ai/lockNote.js';

describe('lockNoteText (55, 1.48.1 b)', () => {
	it('names the object and the peer holding it', () => {
		const t = lockNoteText('u1', 'Door', { peerId: 'p9', name: 'Alex' });
		expect(t).toContain('"Door" (u1)');
		expect(t).toContain('Alex (peer p9)');
	});
	it('falls back to ids when there is no name', () => {
		expect(lockNoteText('u1', '', { peerId: 'p9', name: '' })).toMatch(/^u1 is locked by peer p9/);
	});
});
