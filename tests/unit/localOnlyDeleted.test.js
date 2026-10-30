import { describe, it, expect } from 'vitest';
import { withoutLocalOnlyDeleted, keepLocalOnlyDeleted, mergeManifests, outboundManifest } from '../../src/lib/projectManifest.js';

// fix-live (plans review #6): a never-shared file's deletion row never leaves this machine
const priv = { hash: 'h-private', id: 'r1', name: 'diary.png', kind: 'image', at: 100, localOnly: true, folderId: 'f1', path: ['Secret'], thumb: 'data:x' };
const pub = { hash: 'h-shared', id: 'r2', name: 'tree.glb', kind: 'model', at: 200 };

describe('localOnly deletion rows', () => {
	it('are withheld from what is sent', () => {
		expect(withoutLocalOnlyDeleted({ changedAt: 1, deleted: [priv, pub] }).deleted).toEqual([pub]);
		expect('deleted' in withoutLocalOnlyDeleted({ changedAt: 1, deleted: [priv] })).toBe(false);
		const doc = { changedAt: 1, deleted: [pub] };
		expect(withoutLocalOnlyDeleted(doc)).toBe(doc); // nothing private: untouched
	});
	it('outboundManifest (the one send boundary) carries no private row, name, path or thumbnail', () => {
		const out = outboundManifest({ changedAt: 5, scenes: {}, assets: [], deleted: [priv, pub] });
		const wire = JSON.stringify(out);
		expect(wire).not.toContain('diary.png');
		expect(wire).not.toContain('Secret');
		expect(wire).not.toContain('h-private');
		expect(wire).toContain('tree.glb');
	});
	it('survive a NEWER peer document, which can never carry them (the bin is not stranded)', () => {
		const theirs = { hash: 'h-theirs', id: 'r3', name: 'rock.glb', kind: 'model', at: 300 };
		const { doc } = mergeManifests(
			{ changedAt: 10, scenes: {}, assets: [], deleted: [priv, pub] },
			{ changedAt: 20, scenes: {}, assets: [], deleted: [pub, theirs] }
		);
		expect(doc.deleted?.map((r) => r.hash)).toEqual(['h-private', 'h-shared', 'h-theirs']);
	});
	it('a SHARED row the newer side dropped stays dropped (latest-wins is unchanged for shared rows)', () => {
		const { doc } = mergeManifests(
			{ changedAt: 10, scenes: {}, assets: [], deleted: [pub] },
			{ changedAt: 20, scenes: {}, assets: [], deleted: [] }
		);
		expect(doc.deleted ?? []).toEqual([]);
	});
	it('keepLocalOnlyDeleted lets the winning side keep a key it already has', () => {
		const shared = { ...priv, localOnly: undefined, at: 150 };
		expect(keepLocalOnlyDeleted([shared], [priv]).map((r) => r.at)).toEqual([150]);
	});
});
