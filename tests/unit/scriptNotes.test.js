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
	it('a write that means to build up warns, because the pose restarts every frame', () => {
		for (const code of ['object.rotation.y += 0.02;', 'object.position.x -= speed', 'object.scale.x *= 1.01;', 'object.rotation.y++;', '--object.position.z;'])
			expect(scriptNodeWarnings({ code }, { unwired: false }).join(' '), code).toMatch(/will not build up.*base\.rot\[1\] \+ time \* speed/);
	});
	it('an amount that reads time is how an effect is meant to be written', () => {
		for (const code of ['object.position.y += Math.sin(time) * 2;', 'object.rotation.y = base.rot[1] + time * 2;', 'object.material.opacity -= 0.1;', 'count += 1;'])
			expect(scriptNodeWarnings({ code }, { unwired: false }), code).toEqual([]);
	});
	it('a base field that does not exist warns (it would throw every frame)', () => {
		expect(scriptNodeWarnings({ code: 'object.rotation.y = base.rotation[1] + time;' }, { unwired: false })[0]).toMatch(/base\.rotation does not exist.*base\.rot\[1\]/);
	});
	it('a value node has no object', () => {
		expect(scriptNodeWarnings({ code: 'object.rotation = 1', outputs: [{ name: 'x' }] }, { unwired: true })).toEqual([]);
	});
});
