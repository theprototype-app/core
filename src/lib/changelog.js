// RW/B4 — the bundled CHANGELOG.md as blocks: a deliberately tiny markdown subset instead of a
// dependency. Shared by the What's new window and Settings ▸ About ▸ What's new (37-settings). A
// LEAF. Everything is HTML-escaped BEFORE the inline rules run, so a consumer's {@html} cannot
// inject markup even if the file grows odd characters.

/** @typedef {{kind: string, html: string, items?: string[]}} Block */

/** @param {string} s */
function esc(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} s */
function inline(s) {
	return esc(s)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/** Markdown -> a flat block list. @param {string} source @returns {Block[]} */
export function changelogBlocks(source) {
	// HTML comments carry maintainer notes for the GitHub view — never render them
	const md = source.replace(/<!--[\s\S]*?-->/g, '');
	/** @type {Block[]} */
	const out = [];
	/** @type {string[]} */
	let para = [];
	/** @type {string[]} */
	let list = [];
	const flushPara = () => {
		if (para.length) out.push({ kind: 'p', html: inline(para.join(' ')) });
		para = [];
	};
	const flushList = () => {
		if (list.length) out.push({ kind: 'ul', html: '', items: list.map(inline) });
		list = [];
	};
	const flush = () => {
		flushPara();
		flushList();
	};
	for (const raw of md.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			flush();
			continue;
		}
		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			out.push({ kind: 'h' + heading[1].length, html: inline(heading[2]) });
			continue;
		}
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		if (bullet) {
			flushPara();
			list.push(bullet[1]);
			continue;
		}
		// a wrapped bullet continues the previous item
		if (list.length) list[list.length - 1] += ' ' + line;
		else para.push(line);
	}
	flush();
	return out;
}

/**
 * Group the flat blocks into one FOLDABLE section per release (h2), so a reader opens on the
 * newest release instead of a wall of every version ever shipped. The leading "# Changelog" title
 * (h1) is for the GitHub view and is dropped; anything before the first h2 stays loose above.
 * @param {string} source @returns {{intro: Block[], releases: {title: string, body: Block[]}[]}}
 */
export function changelogReleases(source) {
	const parsed = changelogBlocks(source).filter((b) => b.kind !== 'h1');
	/** @type {Block[]} */
	const intro = [];
	/** @type {{title: string, body: Block[]}[]} */
	const releases = [];
	for (const block of parsed) {
		if (block.kind === 'h2') releases.push({ title: block.html, body: [] });
		else if (releases.length) releases[releases.length - 1].body.push(block);
		else intro.push(block);
	}
	return { intro, releases };
}
