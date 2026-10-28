import { describe, it, expect } from 'vitest';
import {
	parseFrame,
	helloFrame,
	answerFrame,
	closeReason,
	shouldReconnect,
	PING_TEXT,
	PONG_TEXT,
	MAX_INBOUND_BYTES,
	MAX_RESULT_BYTES,
	CONNECTOR_BLOCKED_TOOLS
} from '../../src/lib/connector/protocol.js';
import { validateArgs, schemaErrors, shapeProblem, MAX_DEPTH } from '../../src/lib/connector/argsSchema.js';

// 86 B1/B5: the tab's half of the connector wire (cloud worker-mcp/PROTOCOL.md § 1) and the args check.

describe('parseFrame', () => {
	it('reads the frames the DO sends', () => {
		const ready = parseFrame(JSON.stringify({ type: 'ready', connection: { id: 'L1', client: 'Claude', account: 'ann' }, connections: [{ id: 'g_1', client: 'Claude', scopes: ['session:edit'], lastUsed: 5 }] }));
		expect(ready).toEqual({ type: 'ready', connection: { id: 'L1', client: 'Claude', account: 'ann' }, connections: [{ id: 'g_1', client: 'Claude', scopes: ['session:edit'], lastUsed: 5 }] });
		expect(parseFrame(JSON.stringify({ type: 'call', id: 'c1', tool: 'create_objects', args: { objects: [] }, timeoutMs: 1000, scope: 'edit', connection: 'g_1' }))).toEqual({
			type: 'call', id: 'c1', tool: 'create_objects', args: { objects: [] }, timeoutMs: 1000, scope: 'edit', connection: 'g_1'
		});
		expect(parseFrame('{"type":"cancel","id":"c1"}')).toEqual({ type: 'cancel', id: 'c1' });
		expect(parseFrame('{"type":"revoked","connection":"g_1"}')).toEqual({ type: 'revoked', connection: 'g_1' });
		expect(parseFrame(PONG_TEXT)).toEqual({ type: 'pong', t: 0 });
	});

	it('a call without scope "edit" is read-only (fail closed)', () => {
		expect(parseFrame('{"type":"call","id":"c","tool":"create_objects","args":{}}')?.type === 'call' && /** @type {any} */ (parseFrame('{"type":"call","id":"c","tool":"create_objects","args":{}}')).scope).toBe('read');
		expect(/** @type {any} */ (parseFrame('{"type":"call","id":"c","tool":"x","scope":"EDIT"}')).scope).toBe('read');
	});

	it('refuses anything not exactly one of ours', () => {
		for (const bad of [
			'not json',
			'[]',
			'null',
			'{"type":"eval","code":"alert(1)"}',
			'{"type":"call","tool":"create_objects"}', // no id
			'{"type":"call","id":"c","tool":"../x"}', // bad tool name
			'{"type":"call","id":"c","tool":"x","args":[1]}', // args not an object
			JSON.stringify({ type: 'call', id: 'x'.repeat(65), tool: 'a' }),
			JSON.stringify({ type: 'ready', connection: {} }),
			42,
			undefined
		])
			expect(parseFrame(/** @type {any} */ (bad))).toBeNull();
		expect(parseFrame(JSON.stringify({ type: 'call', id: 'c', tool: 'a', args: { s: 'x'.repeat(MAX_INBOUND_BYTES) } }))).toBeNull();
	});
});

describe('frames the tab sends', () => {
	it('ping is EXACTLY the 15 bytes the DO auto-responds to', () => {
		expect(PING_TEXT).toBe('{"type":"ping"}');
		expect(PING_TEXT.length).toBe(15);
	});
	it('hello carries the token in the frame, never anywhere else', () => {
		expect(JSON.parse(helloFrame('tpp_x', '1.48.0', ['status']))).toEqual({ type: 'hello', v: 1, token: 'tpp_x', app: { version: '1.48.0' }, tools: ['status'] });
	});
	it('a result too large becomes too_large; an unknown error code becomes failed', () => {
		expect(JSON.parse(answerFrame('a', { result: { ok: 1 } }))).toEqual({ type: 'result', id: 'a', result: { ok: 1 } });
		expect(JSON.parse(answerFrame('a', { result: 'x'.repeat(MAX_RESULT_BYTES) })).error.code).toBe('too_large');
		expect(JSON.parse(answerFrame('a', { error: { code: 'weird', message: 'm' } })).error.code).toBe('failed');
	});
});

describe('close codes', () => {
	it('revoked / replaced / refused are final; blips, 4004 and 4008 heal', () => {
		expect([4001, 4002, 4003, 1000].map(shouldReconnect)).toEqual([false, false, false, false]);
		expect([1006, 1001, 4004, 4008, 1011].map(shouldReconnect)).toEqual([true, true, true, true, true]);
		expect(closeReason(4002)).toBe('replaced');
	});
	it('the agent-page tools stay out of reach', () => {
		for (const t of ['install_modules', 'accept_offer', 'pending_offers', 'leave', 'connect']) expect(CONNECTOR_BLOCKED_TOOLS.has(t)).toBe(true);
	});
});

describe('validateArgs', () => {
	const createObjects = {
		type: 'object',
		properties: {
			objects: {
				type: 'array',
				items: {
					type: 'object',
					properties: { kind: { type: 'string', enum: ['primitive', 'light'] }, position: { type: 'array', items: { type: 'number' } } },
					required: ['kind']
				}
			}
		},
		required: ['objects']
	};
	it('accepts what the schema allows', () => {
		expect(validateArgs(createObjects, { objects: [{ kind: 'primitive', position: [0, 1, 2], extra: 'kept' }] })).toEqual({ ok: true });
	});
	it('names each problem with its path', () => {
		const r = validateArgs(createObjects, { objects: [{ kind: 'nuke', position: [0, 'a'] }, {}] });
		expect(r.ok).toBe(false);
		expect(/** @type {any} */ (r).problems).toEqual([
			'args.objects[0].kind: must be one of "primitive", "light"',
			'args.objects[0].position[1]: expected number, got string',
			'args.objects[1]: missing required "kind"'
		]);
		expect(/** @type {any} */ (validateArgs(createObjects, {})).problems).toEqual(['args: missing required "objects"']);
	});
	it('integer, bounds, additionalProperties false, anyOf', () => {
		expect(schemaErrors({ type: 'integer' }, 1.5)).toHaveLength(1);
		expect(schemaErrors({ type: 'number', maximum: 3 }, 4)).toEqual(['args: must be ≤ 3']);
		expect(schemaErrors({ type: 'object', properties: {}, additionalProperties: false }, { a: 1 })).toEqual(['args: unknown field "a"']);
		expect(schemaErrors({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true)).toEqual(['args: matches none of the allowed shapes']);
		expect(schemaErrors({ type: 'number' }, NaN)).toHaveLength(1);
	});
	it('shape caps: depth, forbidden keys, non-finite numbers', () => {
		/** @type {any} */
		let deep = 1;
		for (let i = 0; i <= MAX_DEPTH + 1; i++) deep = [deep];
		expect(shapeProblem(deep)).toMatch(/nested too deeply/);
		expect(shapeProblem(JSON.parse('{"__proto__":{"x":1}}'))).toMatch(/forbidden key/);
		expect(validateArgs({ type: 'object' }, { a: Infinity }).ok).toBe(false);
	});
	it('reports at most a handful of problems, not a wall', () => {
		const r = validateArgs({ type: 'array', items: { type: 'string' } }, Array(100).fill(1));
		expect(/** @type {any} */ (r).problems.length).toBeLessThanOrEqual(8);
	});
});
