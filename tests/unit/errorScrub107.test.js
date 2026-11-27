// 107-int (claude:9 row for #666): the connector's error text never carries another person's peer id or a file path.
import { describe, it, expect } from 'vitest';
import { scrubErrorText } from '../../src/lib/connector/dispatcher.js';
import { lockNoteText } from '../../src/lib/ai/lockNote.js';

describe('scrubErrorText', () => {
	it('drops the peer id from a lock skip and keeps the name', () => {
		const t = lockNoteText('u-1', 'Box', { peerId: 'f0fd3a21-77', name: 'Alex' });
		expect(t).toContain('peer f0fd3a21-77'); // counterfactual: the raw skip carries it
		const s = scrubErrorText('nothing was changed — ' + t);
		expect(s).not.toContain('f0fd3a21');
		expect(s).toContain('locked by Alex — they are editing it');
	});
	it('says "another person" for a nameless holder', () => {
		const s = scrubErrorText(lockNoteText('u-2', '', { peerId: 'ab12cd34', name: '' }));
		expect(s).not.toContain('ab12cd34');
		expect(s).toContain('locked by another person');
	});
	it('leaves ordinary words after "peer" alone', () => {
		expect(scrubErrorText('another peer is running the simulation')).toBe('another peer is running the simulation');
		expect(scrubErrorText('a peer joined')).toBe('a peer joined');
	});
	it('replaces filesystem paths and file/blob URLs', () => {
		const s = scrubErrorText('could not read /home/deck/x/model.glb or C:\\Users\\a\\b.png or file:///tmp/a.fbx or blob:https://theprototype.app/1234');
		expect(s).not.toMatch(/home\/deck|Users|tmp\/a|blob:/);
		expect(s.match(/\[path\]/g)?.length).toBe(4);
	});
	it('keeps Explorer library paths (Sounds/boom.ogg) as they are', () => {
		expect(scrubErrorText('a file named Sounds/boom.ogg exists')).toBe('a file named Sounds/boom.ogg exists');
	});
});
