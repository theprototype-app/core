import { describe, it, expect } from 'vitest';
import { scriptNodeWarnings } from '../../src/lib/ai/scriptNotes.js';

describe('mcp-fix: a Script node says what cannot work', () => {
	it('an object graph script that edits in place has nothing to warn about', () => {
		expect(scriptNodeWarnings({ code: 'object.rotation.y = time; object.material.color.set("#f00");' }, { unwired: false })).toEqual([]);
	});
	it('a scene graph script wired to nothing drives nothing', () => {
		expect(scriptNodeWarnings({ code: 'object.rotation.y = time;' }, { unwired: true })[0]).toMatch(/drives nothing/);
	});
	it('replacing a transform or the material is refused by the sandbox, so it warns', () => {
		expect(scriptNodeWarnings({ code: 'object.rotation = new Euler(0, 1, 0);' }, { unwired: false })[0]).toMatch(/object\.rotation cannot be replaced/);
		expect(scriptNodeWarnings({ code: 'object.material = other;' }, { unwired: false })[0]).toMatch(/object\.material cannot be replaced/);
		expect(scriptNodeWarnings({ code: 'object.material.map = t;' }, { unwired: false })[0]).toMatch(/material\.map/);
	});
	it('a comparison is not an assignment', () => {
		expect(scriptNodeWarnings({ code: 'if (object.material == null) return;' }, { unwired: false })).toEqual([]);
	});
	it('a value node has no object', () => {
		expect(scriptNodeWarnings({ code: 'object.rotation = 1', outputs: [{ name: 'x' }] }, { unwired: true })).toEqual([]);
	});
});
