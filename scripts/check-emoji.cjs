#!/usr/bin/env node
// PL42 (owner rule 2026-11-09): NO EMOJI IN THE UI. Menus, panels, toasts and empty states use Lucide
// icons, a text glyph (✕ ✓ ★ ▶ ϟ ❚❚ render as text) or a custom SVG. This check fails on a
// COLOUR EMOJI in src/ — a character whose default presentation is emoji, or any character forced
// to emoji with VS16 (U+FE0F). Non-UI text that must keep one (an agent prompt that quotes a user,
// a test fixture) carries the pragma `emoji-ok` on the same line.
//   node scripts/check-emoji.cjs [dir ...]   (default: src)
const fs = require('fs');
const path = require('path');

// Emoji_Presentation=Yes in the BMP (Unicode 15), plus every pictograph plane block
const PRESENTED = '⌚⌛⏩⏪⏫⏬⏰⏳◽◾☔☕♈♉♊♋♌♍♎♏♐♑♒♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓❔❕❗➕➖➗➰➿⬛⬜⭐⭕';
// text-default pictographs that phones still draw as COLOUR emoji (Emoji=Yes): the owner saw these.
// Arrows, geometric shapes (▶ ◀ ▪), ✕ ✓ ★ ☆ © ® ™ and ASCII stay allowed: they read as text.
const PICTOGRAPHS = '〰〽㊗㊙⌨⏏⏭⏮⏯⏱⏲⏸⏹⏺☀☁☂☃☄☎☑☘☝☠☢☣☦☪☮☯☸☹☺♀♂♟♠♣♥♦♨♻♾⚒⚔⚕⚖⚗⚙⚛⚜⚠⚧⚰⚱⛈⛏⛑⛓⛩⛰⛱⛴⛷⛸⛹✂✈✉✌✍✏✒✔✖✝✡✳✴❄❇❣❤';
const BMP = PRESENTED + PICTOGRAPHS;
const EMOJI = new RegExp(`[${BMP}]|[\\u{1F004}\\u{1F0CF}\\u{1F18E}\\u{1F191}-\\u{1F19A}\\u{1F1E6}-\\u{1F1FF}\\u{1F201}\\u{1F21A}\\u{1F22F}\\u{1F232}-\\u{1F236}\\u{1F238}-\\u{1F23A}\\u{1F250}\\u{1F251}\\u{1F300}-\\u{1F64F}\\u{1F680}-\\u{1F6FF}\\u{1F7E0}-\\u{1F7EB}\\u{1F90C}-\\u{1F9FF}\\u{1FA70}-\\u{1FAFF}]|.\\u{FE0F}`, 'u');
const EXT = /\.(svelte|js|ts|html|css)$/;

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
			walk(p, out);
		} else if (EXT.test(e.name)) out.push(p);
	}
	return out;
}

/** @param {string} text @returns {{line: number, char: string, text: string}[]} */
function findEmoji(text) {
	/** @type {{line: number, char: string, text: string}[]} */
	const hits = [];
	if (/emoji-ok-file/.test(text.slice(0, 2000))) return hits;
	text.split('\n').forEach((line, i) => {
		if (line.includes('emoji-ok')) return;
		// a comment is not UI
		if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return;
		const m = line.match(EMOJI);
		if (m) hits.push({ line: i + 1, char: m[0], text: line.trim().slice(0, 120) });
	});
	return hits;
}

if (require.main === module) {
	const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src'];
	const files = roots.flatMap((r) => walk(r, []));
	let n = 0;
	for (const f of files) {
		for (const h of findEmoji(fs.readFileSync(f, 'utf8'))) {
			n++;
			console.log(`${f}:${h.line}: emoji ${JSON.stringify(h.char)} — ${h.text}`);
		}
	}
	if (n) {
		console.log(`\ncheck:emoji: ${n} emoji in ${roots.join(', ')} — use a Lucide icon, a text glyph or a custom SVG (owner rule; \`emoji-ok\` on the line for non-UI text)`);
		process.exit(1);
	}
	console.log(`check:emoji: clean (${files.length} files)`);
}

module.exports = { findEmoji, EMOJI };
