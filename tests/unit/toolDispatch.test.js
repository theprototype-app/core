// @ts-nocheck — a source-text guard (the checkJs rule for test fixtures)
// mcp-diorama2: a tool added to a module's NAMES list is offered to every agent, and tools.js routes each one by an
// explicit `case` — `duplicate` and `set_quality` shipped in their modules' lists with no case, so every agent call
// answered "unknown tool". Every geometry and look name must have its case.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {}, selectionTintOriginals: () => null }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {}, physicsShapeChanged: () => {} }));

const { GEOMETRY_TOOL_NAMES } = await import('../../src/lib/ai/geometryTools.js');
const { LOOK_TOOL_NAMES } = await import('../../src/lib/ai/lookTools.js');
const source = readFileSync(fileURLToPath(new URL('../../src/lib/ai/tools.js', import.meta.url)), 'utf8');

describe('tools.js routes every geometry and look tool', () => {
	for (const name of [...GEOMETRY_TOOL_NAMES, ...LOOK_TOOL_NAMES, 'import_shape'])
		it(name + ' has its case', () => expect(source).toContain("case '" + name + "'"));
});
