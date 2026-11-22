// 78-int PL42: the no-emoji check (scripts/check-emoji.cjs) — what it flags and what it lets through.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { findEmoji } = require('../../scripts/check-emoji.cjs');

describe('check:emoji', () => {
	it('flags colour emoji in UI strings and markup', () => {
		for (const s of ["label: '✨ Generate'", '<span>📷 {name}</span>', "icon: '⚙'", "'⏸ Pause'", "x = '✏️'", "'⚠ ' + text", "'🔒 locked'"]) {
			expect(findEmoji(s).length, s).toBe(1);
		}
	});
	it('lets text glyphs through', () => {
		for (const s of ["'✕'", "'✓ done'", "'▶ Play'", "'❚❚ Pause'", "handler: 'ϟ'", "'★'", "'ⓘ'", "'⚄'", "'◷'", "'✎ Drawing'", "'■ Stop'"]) {
			expect(findEmoji(s), s).toEqual([]);
		}
	});
	it('skips comments and the pragmas', () => {
		expect(findEmoji('// a ⚡ comment')).toEqual([]);
		expect(findEmoji('\t<!-- the ⚙ tab -->')).toEqual([]);
		expect(findEmoji("const smile = '😀'; // emoji-ok: chat shortcode")).toEqual([]);
		expect(findEmoji("// emoji-ok-file: user content\nconst a = '😀';")).toEqual([]);
	});
	it('the shipped src tree is clean', async () => {
		const fs = await import('fs');
		const path = await import('path');
		/** @param {string} d @param {string[]} out @returns {string[]} */
		const walk = (d, out) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p, out);
				else if (/\.(svelte|js|ts|html|css)$/.test(e.name)) out.push(p);
			}
			return out;
		};
		const hits = walk('src', []).flatMap((f) => findEmoji(fs.readFileSync(f, 'utf8')).map((h) => f + ':' + h.line));
		expect(hits).toEqual([]);
	});
});
