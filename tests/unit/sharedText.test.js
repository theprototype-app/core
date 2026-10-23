// @ts-nocheck — fixture tabs and raw Yjs docs; the module under test is typed
// 50 Y1/Y2 — shared text: the pure rules (sharedTextCore, codeTabs.reconcileShared, the wire
// rows, the capability floor) and, on REAL Yjs documents wired back to back the way the room's
// conns carry them, the two properties the lane is for: two people typing in ONE line both keep
// their text (v1.41.0's buffer is last-writer-wins), and two peers seeding the same source at
// the same moment end up with ONE copy of it.
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import {
	fnv1a,
	seedClientId,
	sharedDocKey,
	isDocKey,
	minimalEdit,
	rebaseEdit,
	isExternalWriter,
	lineAt,
	presenceLabel,
	selectionTint
} from '../../src/lib/sharedTextCore.js';
import { reconcileShared, reconcileExternal } from '../../src/lib/codeTabs.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';
import { canApply, setCapabilityProvider } from '../../src/lib/cloudHooks.js';

/** two docs whose updates cross like two peers' conns (ordered, immediate) */
function pair() {
	const a = new Y.Doc();
	const b = new Y.Doc();
	a.on('update', (u, origin) => origin !== 'wire' && Y.applyUpdate(b, u, 'wire'));
	b.on('update', (u, origin) => origin !== 'wire' && Y.applyUpdate(a, u, 'wire'));
	return { a, b };
}
/** the sharedText seed: a throwaway doc under the deterministic client */
function seedInto(doc, key, text) {
	const s = new Y.Doc();
	s.clientID = seedClientId(key, text);
	s.getText('text').insert(0, text);
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(s), 'seed');
}

describe('sharedTextCore', () => {
	it('names the same document on every peer: a node by graph + id, a file by name', () => {
		expect(sharedDocKey({ kind: 'node', nodeId: 'n1', graphId: 'scene' })).toBe('n:scene:n1');
		expect(sharedDocKey({ kind: 'behaviour', nodeId: 'n2' })).toBe('n:scene:n2');
		expect(sharedDocKey({ kind: 'node', nodeId: 'n3', graphId: 'obj-1' })).toBe('n:obj-1:n3');
		// a file's id is per device and its hash moves with every save — the NAME is the file
		expect(sharedDocKey({ kind: 'file', name: 'notes.txt', itemId: 'local-1', hash: 'h1' })).toBe('f:notes.txt');
		expect(sharedDocKey({ kind: 'file', name: 'notes.txt', itemId: 'other-9', hash: 'h2' })).toBe('f:notes.txt');
	});
	it('shares nothing read-only and no graph JSON', () => {
		expect(sharedDocKey({ kind: 'module', moduleId: 'kit', readOnly: true })).toBe(null);
		expect(sharedDocKey({ kind: 'node', nodeId: 'n1', readOnly: true })).toBe(null);
		expect(sharedDocKey({ kind: 'graph', graphId: 'scene' })).toBe(null);
		expect(sharedDocKey({ kind: 'file', name: '  ' })).toBe(null);
		expect(sharedDocKey(null)).toBe(null);
	});
	it('accepts only its own key shapes on the wire', () => {
		expect(isDocKey('n:scene:a')).toBe(true);
		expect(isDocKey('f:x.txt')).toBe(true);
		expect(isDocKey('x:bad')).toBe(false);
		expect(isDocKey('f:' + 'a'.repeat(600))).toBe(false);
		expect(isDocKey(42)).toBe(false);
	});
	it('derives the seed client from (key, text) — same pair, same client; any change, another', () => {
		expect(seedClientId('n:scene:a', 'return 1')).toBe(seedClientId('n:scene:a', 'return 1'));
		expect(seedClientId('n:scene:a', 'return 1')).not.toBe(seedClientId('n:scene:a', 'return 2'));
		expect(seedClientId('n:scene:a', 'x')).not.toBe(seedClientId('n:scene:b', 'x'));
		const id = seedClientId('f:a', '');
		expect(id).toBeGreaterThan(0);
		expect(id).toBeLessThan(2 ** 32);
		expect(fnv1a('hello')).toMatch(/^[0-9a-f]{8}$/);
	});
	it('computes the smallest single edit', () => {
		expect(minimalEdit('abc', 'abc')).toBe(null);
		expect(minimalEdit('let x = 1;', 'let x = 42;')).toEqual({ index: 8, remove: 1, insert: '42' });
		expect(minimalEdit('aaa', 'aaaa')).toEqual({ index: 3, remove: 0, insert: 'a' });
		expect(minimalEdit('hello world', 'hello')).toEqual({ index: 5, remove: 6, insert: '' });
		expect(minimalEdit('', 'new')).toEqual({ index: 0, remove: 0, insert: 'new' });
	});
	it('keeps keys typed before the shared document was ready, beside or after the room\'s change', () => {
		const apply = (s, e) => s.slice(0, e.index) + e.insert + s.slice(e.index + e.remove);
		// nothing typed
		expect(rebaseEdit('let a;', 'let a;', 'let b;')).toBe(null);
		// the room still holds the opening text: the typing goes in as typed
		expect(apply('let a;', rebaseEdit('let a;', 'let a = 1;', 'let a;'))).toBe('let a = 1;');
		// typing AFTER the room's change moves past it
		expect(apply('// x\nlet a;', rebaseEdit('let a;', 'let a = 1;', '// x\nlet a;'))).toBe('// x\nlet a = 1;');
		// typing BEFORE the room's change stays put
		expect(apply('ab;\nend!', rebaseEdit('ab;\nend', 'abc;\nend', 'ab;\nend!'))).toBe('abc;\nend!');
		// both rewrote the same span: the room's text stays, ours lands right after it
		expect(apply('let theirs;', rebaseEdit('let x;', 'let mine;', 'let theirs;'))).toBe('let theirsmine;');
		// the probe's case: select-all + retype against a room that moved the whole line
		expect(apply('b = 7;', rebaseEdit('b = 1;', 'b = 9; // mine', 'b = 7;'))).toContain('// mine');
	});
	it('picks ONE writer for a change that arrived through the source: the lowest peer id', () => {
		expect(isExternalWriter(['b', 'c'], 'a')).toBe(true);
		expect(isExternalWriter(['a', 'c'], 'b')).toBe(false);
		expect(isExternalWriter([], 'z')).toBe(true);
		expect(isExternalWriter(['a'], '')).toBe(false);
	});
	it('reads lines and labels people for a screen reader', () => {
		expect(lineAt('a\nb\nc', 0)).toBe(1);
		expect(lineAt('a\nb\nc', 2)).toBe(2);
		expect(lineAt('a\nb\nc', 99)).toBe(3);
		expect(presenceLabel({ name: 'Ana', line: 4, selected: 0 })).toBe('Ana is on line 4');
		expect(presenceLabel({ name: 'Ana', line: 4, selected: 1 })).toBe('Ana is on line 4, 1 character selected');
		expect(presenceLabel({ name: '', line: null })).toBe('A peer has this file open');
		expect(selectionTint('hsl(200, 80%, 60%)')).toBe('hsla(200, 80%, 60%, 0.3)');
		expect(selectionTint('red')).toBe('red');
	});
});

describe('real Yjs documents over a back-to-back wire', () => {
	it('two people typing in ONE line both keep their text', () => {
		const line = 'let speed = 1;';
		const { a, b } = pair();
		seedInto(a, 'n:scene:s', line);
		expect(b.getText('text').toString()).toBe(line);
		// concurrent: both edit the SAME line before either hears the other
		const offline = new Y.Doc();
		Y.applyUpdate(offline, Y.encodeStateAsUpdate(b));
		const ta = a.getText('text');
		const tb = offline.getText('text');
		ta.insert(line.indexOf('1'), '2'); // "let speed = 21;"
		tb.insert(4, 'max'); // "let maxspeed = 1;"
		Y.applyUpdate(offline, Y.encodeStateAsUpdate(a, Y.encodeStateVector(offline)));
		Y.applyUpdate(a, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(a)));
		expect(ta.toString()).toBe('let maxspeed = 21;');
		expect(offline.getText('text').toString()).toBe('let maxspeed = 21;');
	});
	it('two peers seeding the SAME source at the same moment keep ONE copy', () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		seedInto(a, 'n:scene:s', 'return 1;');
		seedInto(b, 'n:scene:s', 'return 1;');
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		expect(a.getText('text').toString()).toBe('return 1;');
		expect(b.getText('text').toString()).toBe('return 1;');
		// and edits made on either seed apply on the other
		a.getText('text').insert(0, '// hi\n');
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
		expect(b.getText('text').toString()).toBe('// hi\nreturn 1;');
	});
	it('a random client per peer (no deterministic seed) WOULD double the text — why the seed exists', () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		a.getText('text').insert(0, 'return 1;');
		b.getText('text').insert(0, 'return 1;');
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		expect(a.getText('text').toString()).toBe('return 1;return 1;');
	});
	it('a late joiner gets the full text from a state-vector diff, unsaved edits included', () => {
		const host = new Y.Doc();
		seedInto(host, 'f:notes.txt', 'line one');
		host.getText('text').insert(8, '\nline two (unsaved)');
		const joiner = new Y.Doc();
		Y.applyUpdate(joiner, Y.encodeStateAsUpdate(host, Y.encodeStateVector(joiner)));
		expect(joiner.getText('text').toString()).toBe('line one\nline two (unsaved)');
	});
	it('a minimal-edit replace keeps a concurrent edit elsewhere in the text', () => {
		const { a, b } = pair();
		seedInto(a, 'n:scene:s', 'one\ntwo\nthree');
		const off = new Y.Doc();
		Y.applyUpdate(off, Y.encodeStateAsUpdate(b));
		// a reverts line one; off types on line three, concurrently
		const t = a.getText('text');
		const e = /** @type {any} */ (minimalEdit(t.toString(), 'ONE\ntwo\nthree'));
		a.transact(() => {
			t.delete(e.index, e.remove);
			t.insert(e.index, e.insert);
		});
		off.getText('text').insert(13, '!');
		Y.applyUpdate(a, Y.encodeStateAsUpdate(off, Y.encodeStateVector(a)));
		expect(t.toString()).toBe('ONE\ntwo\nthree!');
	});
});

describe('codeTabs.reconcileShared', () => {
	const tab = (over = {}) => ({ id: 't', kind: 'node', title: 'x', lang: 'js', code: 'a', saved: 'a', ...over });
	it('a save of the shared buffer keeps a tab clean — even one with more typing on top', () => {
		const out = reconcileShared(tab({ code: 'abc', saved: 'a' }), 'ab', true);
		expect(out.tab.saved).toBe('ab');
		expect(out.tab.stale).toBe(false);
		expect(out.follow).toBe(false);
		// the classic rule would have called that stale
		expect(reconcileExternal(/** @type {any} */ (tab({ code: 'abc', saved: 'a' })), 'ab').stale).toBe(true);
	});
	it('a foreign change to a clean shared tab asks for ONE follow instead of rewriting the code here', () => {
		const out = reconcileShared(tab(), 'z', false);
		expect(out.follow).toBe(true);
		expect(out.tab.code).toBe('a');
		expect(out.tab.saved).toBe('z');
	});
	it('a foreign change to a dirty shared tab goes stale, the classic rule', () => {
		const out = reconcileShared(tab({ code: 'ab' }), 'z', false);
		expect(out.tab.stale).toBe(true);
		expect(out.tab.external).toBe('z');
		expect(out.follow).toBe(false);
	});
	it('matching text settles; an unchanged source is the same object', () => {
		const t = tab({ code: 'b' });
		expect(reconcileShared(t, 'b', false).tab.saved).toBe('b');
		const same = tab();
		expect(reconcileShared(same, 'a', false).tab).toBe(same);
	});
});

describe('the wire and the floor', () => {
	afterEach(() => setCapabilityProvider(null));
	const bytes = new Uint8Array([1, 2, 3]);
	it('validates the three shared-text messages', () => {
		expect(validateWireMessage({ type: 'ytext', key: 'n:scene:a', u: bytes })).toBe(true);
		expect(validateWireMessage({ type: 'ytext', key: 'n:scene:a', u: bytes.buffer })).toBe(true);
		expect(validateWireMessage({ type: 'ytext', key: 'f:a.txt', none: true })).toBe(true);
		expect(validateWireMessage({ type: 'ytext', key: 'n:scene:a', u: [1, 2, 3] })).toBe(false);
		expect(validateWireMessage({ type: 'ytext', key: 'bogus', u: bytes })).toBe(false);
		expect(validateWireMessage({ type: 'ytextaw', key: 'f:a.txt', a: bytes })).toBe(true);
		expect(validateWireMessage({ type: 'ytextaw', key: 'f:a.txt' })).toBe(false);
		expect(validateWireMessage({ type: 'getytext', key: 'f:a.txt', sv: bytes })).toBe(true);
		expect(validateWireMessage({ type: 'getytext', key: 'f:a.txt' })).toBe(true);
		expect(validateWireMessage({ type: 'getytext', key: 7 })).toBe(false);
	});
	it('lets a viewer ASK for a shared buffer and keeps every update and cursor gateable', () => {
		setCapabilityProvider(() => false);
		expect(canApply('v', 'getytext')).toBe(true);
		expect(canApply('v', 'ytext')).toBe(false);
		expect(canApply('v', 'ytextaw')).toBe(false);
	});
});
