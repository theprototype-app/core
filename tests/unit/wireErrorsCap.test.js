import { describe, it, expect, vi } from 'vitest';

// the toast and the diagnostics log are side effects this table does not need to be measured
vi.mock('../../src/stores/appStore', () => ({ showToast: () => {} }));
vi.mock('../../src/lib/diagnostics', () => ({ log: () => {}, registerDiagnosticsSection: () => {} }));

const { noteWireError, noteWireDrop, wireErrors, clearWireErrors, MAX_WIRE_ROWS } = await import('../../src/lib/wireErrors.js');

describe('the wire-failure table has a size cap', () => {
	it('dials from many made-up ids do not grow it past the cap', () => {
		clearWireErrors();
		for (let i = 0; i < MAX_WIRE_ROWS * 3; i++) noteWireDrop('stranger-' + i, 'proto', 'dial');
		expect(wireErrors().length).toBe(MAX_WIRE_ROWS);
	});
	it('a row touched recently stays; the one touched longest ago goes', () => {
		clearWireErrors();
		noteWireError('host', 'frame', 'count');
		for (let i = 0; i < MAX_WIRE_ROWS - 1; i++) noteWireDrop('stranger-' + i, 'proto', 'dial');
		noteWireError('host', 'frame', 'count');
		noteWireDrop('stranger-new', 'proto', 'dial');
		const rows = wireErrors();
		expect(rows.length).toBe(MAX_WIRE_ROWS);
		expect(rows.find((r) => r.peerId === 'host')?.count).toBe(2);
		expect(rows.some((r) => r.peerId === 'stranger-0')).toBe(false);
	});
});
