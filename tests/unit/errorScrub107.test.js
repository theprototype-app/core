// 107-int (claude:9 rows for #666): no tool error text said to the AI app carries another person's peer id or name, or a
// file path. 107-look-fixes sends an error answer's errors / skipped reasons / note along, and a lock skip names its
// holder "Name (peer <id>)" (lockNote.js). The scrub sits in the dispatcher's fail(): every error frame goes through it.
import { describe, it, expect } from 'vitest';
import { scrubErrorText, createDispatcher } from '../../src/lib/connector/dispatcher.js';
import { lockNoteText } from '../../src/lib/ai/lockNote.js';

const ROBIN = { peerId: 'f0fd3a21-77', name: 'Robin' };

describe('scrubErrorText', () => {
	it('a lock skip names neither the holder nor their peer id', () => {
		const t = lockNoteText('u-1', 'Box', ROBIN);
		expect(t).toContain('Robin (peer f0fd3a21-77)'); // counterfactual: the raw skip carries both
		const s = scrubErrorText('nothing was changed — ' + t, [ROBIN]);
		expect(s).not.toMatch(/Robin|f0fd3a21/);
		expect(s).toContain('"Box" (u-1) is locked by another person — they are editing it');
	});
	it('the lock sentence loses the name even when the roster is not passed', () => {
		const s = scrubErrorText(lockNoteText('u-1', 'Box', ROBIN));
		expect(s).not.toMatch(/Robin|f0fd3a21/);
	});
	it('a nameless holder is "another person"', () => {
		const s = scrubErrorText(lockNoteText('u-2', '', { peerId: 'ab12cd34', name: '' }));
		expect(s).not.toContain('ab12cd34');
		expect(s).toContain('locked by another person');
	});
	it('any other mention of another person, by id or name, goes (whole words only)', () => {
		const s = scrubErrorText('Robin moved it; ask robin or f0fd3a21-77. Robinson stays.', [ROBIN]);
		expect(s).toBe('another person moved it; ask another person or another person. Robinson stays.');
	});
	it('ordinary words after "peer" and one-letter names are left alone', () => {
		expect(scrubErrorText('another peer is running the simulation', [{ peerId: 'x', name: 'A' }])).toBe('another peer is running the simulation');
	});
	it('filesystem paths and file / blob URLs become [path]; Explorer paths stay', () => {
		const s = scrubErrorText('could not read /home/deck/x/model.glb or C:\\Users\\a\\b.png or file:///tmp/a.fbx or blob:https://theprototype.app/1234');
		expect(s).not.toMatch(/home\/deck|Users|tmp\/a|blob:/);
		expect(s.match(/\[path\]/g)?.length).toBe(4);
		expect(scrubErrorText('a file named Sounds/boom.ogg exists')).toBe('a file named Sounds/boom.ogg exists');
	});
});

describe('the dispatcher says no other person in any error frame', () => {
	const run = async (/** @type {any} */ answer, /** @type {(n: string) => any} */ thrower = () => null) => {
		/** @type {any[]} */ const sent = [];
		const d = createDispatcher({
			agent: {
				tools: () => [{ type: 'function', function: { name: 'set_material', parameters: { type: 'object', properties: {} } } }],
				exec: async (/** @type {string} */ n) => {
					const t = thrower(n);
					if (t) throw t;
					return answer;
				},
				status: () => ({ role: 'editor' }),
				waitForEdit: () => new Promise(() => {}),
				screenshot: async () => ''
			},
			send: (/** @type {string} */ t) => sent.push(JSON.parse(t)),
			visible: () => true,
			encodeShot: async () => null,
			others: () => [ROBIN]
		});
		d.handle(/** @type {any} */ ({ id: 'e1', tool: 'set_material', args: {}, scope: 'edit', timeoutMs: null, connection: 'g_1' }));
		for (let i = 0; i < 50 && !sent.some((f) => f.id === 'e1'); i++) await new Promise((r) => setTimeout(r, 5));
		return sent.find((f) => f.id === 'e1');
	};
	const lock = lockNoteText('u-1', 'Box', ROBIN);
	it('failed: an error answer whose skipped reasons are lock notes', async () => {
		const f = await run({ error: 'nothing was changed', skipped: [{ uuid: 'u-1', reason: lock }], note: 'ask Robin to let go' });
		expect(f.error.code).toBe('failed');
		expect(f.error.message).toContain('is locked by another person');
		expect(f.error.message).not.toMatch(/Robin|f0fd3a21/);
	});
	it('refused: a refusal text', async () => {
		const f = await run({ error: 'Robin (peer f0fd3a21-77) holds the scene lock', refused: true });
		expect(f.error.code).toBe('refused');
		expect(f.error.message).not.toMatch(/Robin|f0fd3a21/);
	});
	it('a thrown error', async () => {
		const f = await run(null, () => new Error('read /home/deck/secret.glb for Robin'));
		expect(f.error.message).not.toMatch(/Robin|\/home\/deck/);
	});
});
