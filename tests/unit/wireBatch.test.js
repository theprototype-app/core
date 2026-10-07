import { describe, it, expect, beforeEach } from 'vitest';
import {
	beginWireBatch,
	endWireBatch,
	withWireBatch,
	withWireBatchAsync,
	holdForWireBatch,
	wireBatchOpen,
	resetWireBatch,
	WIRE_BATCH_MAX
} from '../../src/lib/wireBatch.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';

// 37 R1: a multi-object edit leaves as ONE envelope. The leaf is driven exactly the way
// PeerConnection.broadcast drives it: every payload is offered to holdForWireBatch first,
// and only what it does NOT hold goes out now.

/** @type {any[]} */
let wire = [];
/** broadcast's shape: offer, else send @param {any} payload @param {boolean} [batchable] */
function broadcast(payload, batchable = true) {
	if (holdForWireBatch(payload, batchable, (out) => broadcast(out))) return;
	wire.push(payload);
}
const move = (/** @type {string} */ uuid) => ({ type: 'move', uuid, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] });

beforeEach(() => {
	wire = [];
	resetWireBatch();
});

describe('wireBatch', () => {
	it('sends straight through when no batch is open', () => {
		broadcast(move('a'));
		broadcast(move('b'));
		expect(wire.map((m) => m.type)).toEqual(['move', 'move']);
	});

	it('collapses a batch of N into ONE envelope carrying every item in order', () => {
		withWireBatch(() => {
			broadcast(move('a'));
			broadcast(move('b'));
			broadcast(move('c'));
			expect(wire).toEqual([]); // held until the close
		});
		expect(wire).toHaveLength(1);
		expect(wire[0].type).toBe('batch');
		expect(wire[0].items.map((/** @type {any} */ m) => m.uuid)).toEqual(['a', 'b', 'c']);
	});

	it('sends a batch of ONE as the bare message (single edits stay byte-identical)', () => {
		withWireBatch(() => broadcast(move('a')));
		expect(wire).toEqual([move('a')]);
	});

	it('only the OUTERMOST close sends (nesting)', () => {
		beginWireBatch();
		withWireBatch(() => broadcast(move('a')));
		expect(wire).toEqual([]);
		broadcast(move('b'));
		endWireBatch();
		expect(wire).toHaveLength(1);
		expect(wire[0].items).toHaveLength(2);
		expect(wireBatchOpen()).toBe(false);
	});

	it('a non-batchable message flushes what is held FIRST, so nothing overtakes an edit', () => {
		withWireBatch(() => {
			broadcast(move('a'));
			broadcast(move('b'));
			broadcast({ type: 'camera' }, false);
			broadcast(move('c'));
		});
		expect(wire.map((m) => m.type)).toEqual(['batch', 'camera', 'move']);
		expect(wire[0].items.map((/** @type {any} */ m) => m.uuid)).toEqual(['a', 'b']);
		expect(wire[2].uuid).toBe('c');
	});

	it('a throwing writer still closes the batch (and what it wrote still leaves)', () => {
		expect(() =>
			withWireBatch(() => {
				broadcast(move('a'));
				broadcast(move('b'));
				throw new Error('applier failed');
			})
		).toThrow('applier failed');
		expect(wireBatchOpen()).toBe(false);
		expect(wire).toHaveLength(1);
		broadcast(move('c'));
		expect(wire[1].uuid).toBe('c'); // not held: the batch is closed
	});

	it('the async twin holds across awaits', async () => {
		await withWireBatchAsync(async () => {
			broadcast(move('a'));
			await Promise.resolve();
			broadcast(move('b'));
		});
		expect(wire).toHaveLength(1);
		expect(wire[0].items).toHaveLength(2);
	});

	it('chunks a huge edit into envelopes the validator accepts', () => {
		const n = WIRE_BATCH_MAX * 2 + 1;
		withWireBatch(() => {
			for (let i = 0; i < n; i++) broadcast(move('u' + i));
		});
		expect(wire.map((m) => m.type)).toEqual(['batch', 'batch', 'move']);
		expect(wire[0].items).toHaveLength(WIRE_BATCH_MAX);
		for (const m of wire) expect(validateWireMessage(m)).toBe(true);
	});

	it('never wraps an envelope in another', () => {
		withWireBatch(() => broadcast({ type: 'batch', items: [move('a'), move('b')] }));
		expect(wire).toHaveLength(1);
		expect(wire[0].items).toHaveLength(2);
	});
});

describe('the envelope on the wire', () => {
	it('validates an envelope by its shape; empty, oversized and non-array items are refused', () => {
		expect(validateWireMessage({ type: 'batch', items: [move('a'), move('b')] })).toBe(true);
		expect(validateWireMessage({ type: 'batch', items: [] })).toBe(false);
		expect(validateWireMessage({ type: 'batch', items: 'x' })).toBe(false);
		expect(validateWireMessage({ type: 'batch', items: new Array(WIRE_BATCH_MAX + 1).fill(move('a')) })).toBe(false);
	});
});
