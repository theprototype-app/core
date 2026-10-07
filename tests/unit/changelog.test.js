// The changelog parser shared by the What's new window and Settings ▸ About ▸ What's new.
import { describe, it, expect } from 'vitest';
import { changelogBlocks, changelogReleases } from '../../src/lib/changelog.js';

const MD = `# Changelog
<!-- a maintainer note -->
Intro line.

## 1.26.0 — Settings
### Interface
- one **bold** item
  that wraps
- \`code\` and [a link](https://example.com)

## 1.25.0
Plain paragraph <b>not html</b>.
`;

describe('changelog', () => {
	it('drops comments and the h1, groups by release', () => {
		const { intro, releases } = changelogReleases(MD);
		expect(intro.map((b) => b.kind)).toEqual(['p']);
		expect(releases.map((r) => r.title)).toEqual(['1.26.0 — Settings', '1.25.0']);
		expect(releases[0].body.map((b) => b.kind)).toEqual(['h3', 'ul']);
	});
	it('continues a wrapped bullet and renders the inline subset', () => {
		const ul = changelogReleases(MD).releases[0].body[1];
		expect(ul.items?.[0]).toBe('one <strong>bold</strong> item that wraps');
		expect(ul.items?.[1]).toContain('<code>code</code>');
		expect(ul.items?.[1]).toContain('<a href="https://example.com" target="_blank" rel="noopener">a link</a>');
	});
	it('escapes markup before the inline rules', () => {
		const blocks = changelogBlocks('Plain <b>x</b> & y');
		expect(blocks[0].html).toBe('Plain &lt;b&gt;x&lt;/b&gt; &amp; y');
	});
});
