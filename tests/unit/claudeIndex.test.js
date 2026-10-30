// pipeline-1: CLAUDE-index.md (the line index of CLAUDE.md) is what scripts/claude-index.cjs writes.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { build, title } = require('../../scripts/claude-index.cjs');
const root = new URL('../../', import.meta.url).pathname;

describe('claude-index', () => {
	it('CLAUDE-index.md is current', () => {
		const fresh = build(fs.readFileSync(root + 'CLAUDE.md', 'utf8')) === fs.readFileSync(root + 'CLAUDE-index.md', 'utf8');
		expect(fresh, 'CLAUDE-index.md is stale: run `node scripts/claude-index.cjs` (after editing CLAUDE.md, or on a merge conflict in the index)').toBe(true);
	});
	it('names an entry by its bold lead, else its first words', () => {
		expect(title('**`git checkout --theirs`** discards the ours side')).toBe('`git checkout --theirs`');
		expect(title('`src/lib/sim/` (36-sim): buoyancy')).toBe('`src/lib/sim/` (36-sim): buoyancy');
		expect(build('# T\n\n## S\n- **A** b\n  · **C** d\n')).toContain('    4  - A\n    5      · C');
	});
});
