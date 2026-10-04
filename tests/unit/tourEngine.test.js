// @ts-nocheck — fixtures build partial step objects
import { describe, it, expect } from 'vitest';
import { createTourEngine, AUTO_START_KEY, progressKey } from '../../src/lib/tours/engine.js';

// 36 U3b/I5: the pure half of the first-run tours (contract T1).
function memoryStorage() {
	const map = new Map();
	return {
		map,
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k)
	};
}
const STEPS = [
	{ id: 'hello', title: 'Hello', body: '' },
	{ id: 'trigger', title: 'Trigger', body: '', advanceOn: 'vr-trigger' },
	{ id: 'grab', title: 'Grab', body: '', advanceOn: ['vr-grip', 'vr-grab'] },
	{ id: 'bye', title: 'Bye', body: '', advanceOn: 'vr-exit' }
];
function engine(storage = memoryStorage()) {
	const changes = [];
	const t = createTourEngine({ storage, onChange: (a) => changes.push(a) });
	t.register('vr', { title: 'VR', surface: 'vr', steps: STEPS });
	return { t, storage, changes };
}

describe('tour engine', () => {
	it('auto-starts a new tour once, and not after it is finished', () => {
		const { t } = engine();
		expect(t.seen('vr')).toBe(false);
		expect(t.maybeAutoStart('vr')).toBe(true);
		expect(t.active().step.id).toBe('hello');
		t.next();
		t.next();
		t.next();
		t.next(); // past the last step = finished
		expect(t.active()).toBeNull();
		expect(t.seen('vr')).toBe(true);
		expect(t.maybeAutoStart('vr')).toBe(false);
	});

	it('advances on the signal the current step waits for, and only that one', () => {
		const { t } = engine();
		t.start('vr');
		expect(t.signal('vr-trigger')).toBe(false); // step 0 waits for nothing
		t.next();
		expect(t.active().waiting).toEqual(['vr-trigger']);
		expect(t.signal('vr-grip')).toBe(false);
		expect(t.active().step.id).toBe('trigger');
		expect(t.signal('vr-trigger')).toBe(true);
		expect(t.active().step.id).toBe('grab');
		expect(t.signal('vr-grab')).toBe(true); // a list matches any of its names
		expect(t.active().step.id).toBe('bye');
		expect(t.signal('vr-exit')).toBe(true);
		expect(t.active()).toBeNull();
		expect(t.seen('vr')).toBe(true);
	});

	it('skip persists: a skipped tour never auto-starts again (a fresh engine reads it)', () => {
		const storage = memoryStorage();
		const a = engine(storage).t;
		a.maybeAutoStart('vr');
		a.skip();
		expect(a.active()).toBeNull();
		const b = engine(storage).t;
		expect(b.seen('vr')).toBe(true);
		expect(b.maybeAutoStart('vr')).toBe(false);
		// ...but a manual start (Settings / radial) still works, from the top
		expect(b.start('vr', { from: 'start' })).toBe(true);
		expect(b.active().index).toBe(0);
	});

	it('is resumable: an interrupted tour picks up on the step it stopped at', () => {
		const storage = memoryStorage();
		const a = engine(storage).t;
		a.maybeAutoStart('vr');
		a.next();
		a.next();
		a.close(); // headset off / reload
		expect(a.active()).toBeNull();
		expect(a.status('vr')).toBe('progress');
		const b = engine(storage).t;
		expect(b.maybeAutoStart('vr')).toBe(true);
		expect(b.active().step.id).toBe('grab');
		b.close();
		expect(b.start('vr', { from: 'start' })).toBe(true);
		expect(b.active().step.id).toBe('hello');
	});

	it("Back never goes below the first step; Don't show again turns every auto-start off", () => {
		const { t, storage } = engine();
		t.register('editor', { title: 'Editor', steps: [{ id: 'a', title: 'A', body: '' }] });
		t.start('vr');
		t.back();
		expect(t.active().index).toBe(0);
		t.dontShowAgain();
		expect(storage.map.get(AUTO_START_KEY)).toBe('false');
		expect(t.seen('vr')).toBe(true);
		expect(t.maybeAutoStart('editor')).toBe(false); // never seen, but auto-start is off
		expect(t.start('editor')).toBe(true); // manual still works
		t.close();
		t.setAutoStart(true);
		expect(t.maybeAutoStart('editor')).toBe(true);
	});

	it('reset forgets the records (all of them + the auto-start switch, or one)', () => {
		const { t, storage } = engine();
		t.register('editor', { title: 'Editor', steps: [{ id: 'a', title: 'A', body: '' }] });
		t.start('vr');
		t.dontShowAgain();
		t.start('editor');
		t.finish();
		t.reset('editor');
		expect(t.seen('editor')).toBe(false);
		expect(t.seen('vr')).toBe(true);
		t.reset();
		expect(t.seen('vr')).toBe(false);
		expect(storage.map.has(AUTO_START_KEY)).toBe(false);
		expect(storage.map.has(progressKey('vr'))).toBe(false);
	});

	it('drops steps whose `when` is false at start, and never interrupts a running tour', () => {
		const storage = memoryStorage();
		const t = createTourEngine({ storage });
		let touch = false;
		t.register('editor', {
			title: 'Editor',
			steps: [
				{ id: 'a', title: 'A', body: '' },
				{ id: 'touch', title: 'Touch', body: '', when: () => touch },
				{ id: 'b', title: 'B', body: '' }
			]
		});
		t.register('other', { title: 'O', steps: [{ id: 'x', title: 'X', body: '' }] });
		t.start('editor');
		expect(t.active().total).toBe(2);
		expect(t.maybeAutoStart('other')).toBe(false);
		t.close();
		touch = true;
		t.start('editor', { from: 'start' });
		expect(t.active().total).toBe(3);
	});

	it('emits every change to the surface, and a throwing surface cannot wedge it', () => {
		const { t, changes } = engine();
		t.start('vr');
		t.next();
		t.close();
		expect(changes.map((c) => c?.step.id ?? null)).toEqual(['hello', 'trigger', null]);
		const bad = createTourEngine({ storage: memoryStorage(), onChange: () => { throw new Error('x'); } });
		bad.register('vr', { title: 'VR', steps: STEPS });
		expect(bad.start('vr')).toBe(true);
		bad.next();
		expect(bad.active().index).toBe(1);
	});

	it('refuses a tour without steps', () => {
		const { t } = engine();
		expect(() => t.register('empty', { title: 'E', steps: [] })).toThrow();
		expect(t.start('nope')).toBe(false);
	});
});

describe('tour preview', () => {
	it('a preview never reads or writes the record (the VR welcome read on a screen stays owed)', () => {
		const { t, storage } = engine();
		t.maybeAutoStart('vr');
		t.next();
		t.close(); // owed, at step 1
		expect(t.start('vr', { preview: true })).toBe(true);
		expect(t.active().index).toBe(0); // a preview starts at the top
		expect(t.active().preview).toBe(true);
		t.next();
		t.next();
		t.dontShowAgain();
		expect(t.seen('vr')).toBe(false);
		expect(storage.map.has(AUTO_START_KEY)).toBe(false);
		expect(JSON.parse(storage.map.get(progressKey('vr'))).at).toBe(1);
	});
});
