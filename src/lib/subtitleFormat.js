// 77 C1 — SUBTITLE FILES: .srt and .vtt in and out, and speech segments into cues.
//
// Pure and import-free (the unit layer runs it), and LAZY: the Timeline editor imports it when
// a file is picked or an export is asked for, so none of it is in the boot bundle.
//
// A CUE here is the caption-track item shape minus the id: {t, dur, text, speaker?} in
// seconds. Parsing is forgiving the way players are: either timestamp separator (`,` or `.`),
// hours optional, cue numbers optional, blank-line separated blocks, a BOM, CRLF; VTT cue
// settings after the times are dropped, a `<v Name>` voice span becomes the speaker, and every
// other tag (`<i>`, `<c.x>`, `{\an8}`) is stripped to its text. A block that does not parse is
// skipped and COUNTED, so an import can say "3 lines could not be read" instead of nothing.

/** @typedef {{t: number, dur: number, text: string, speaker?: string}} Cue */

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
const ARROW = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})/;

/** "01:02:03,450" / "02:03.4" -> seconds; NaN when it is not a timestamp @param {string} s */
export function parseTimestamp(s) {
	const m = TIME.exec(String(s ?? '').trim());
	if (!m) return NaN;
	const ms = Number(m[4].padEnd(3, '0'));
	return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

/** seconds -> "HH:MM:SS,mmm" (srt) or "HH:MM:SS.mmm" (vtt) @param {number} t @param {',' | '.'} sep */
export function formatTimestamp(t, sep) {
	const ms = Math.max(0, Math.round((Number(t) || 0) * 1000));
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	const pad = (/** @type {number} */ n, /** @type {number} */ w) => String(n).padStart(w, '0');
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms % 1000, 3)}`;
}

/** a cue's lines with markup stripped; a leading VTT voice span names the speaker @param {string[]} lines */
function cueText(lines) {
	let speaker = '';
	const text = lines
		.map((line) => {
			const voice = /^<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(line);
			if (voice && !speaker) speaker = voice[1].trim();
			return line
				.replace(/<[^>]*>/g, '')
				.replace(/\{\\[^}]*\}/g, '')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&nbsp;/g, ' ')
				.replace(/&amp;/g, '&')
				.trim();
		})
		.filter(Boolean)
		.join('\n');
	return { text, speaker };
}

/**
 * Parse an .srt or .vtt file (sniffed by content, not by name).
 * @param {string} source
 * @returns {{format: 'srt' | 'vtt', cues: Cue[], skipped: number}}
 */
export function parseSubtitles(source) {
	const body = String(source ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
	const format = /^WEBVTT\b/.test(body.trimStart()) ? 'vtt' : 'srt';
	/** @type {Cue[]} */
	const cues = [];
	let skipped = 0;
	for (const block of body.split(/\n\s*\n/)) {
		const lines = block.split('\n').filter((l) => l.trim() !== '');
		if (!lines.length) continue;
		const at = lines.findIndex((l) => ARROW.test(l));
		if (at < 0) {
			// a VTT header / NOTE / STYLE / REGION block is not a cue and not a failure
			if (!/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0].trim())) skipped++;
			continue;
		}
		const m = /** @type {RegExpExecArray} */ (ARROW.exec(lines[at]));
		const start = parseTimestamp(m[1]);
		const end = parseTimestamp(m[2]);
		const { text, speaker } = cueText(lines.slice(at + 1));
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
			skipped++;
			continue;
		}
		/** @type {Cue} */
		const cue = { t: round(start), dur: round(end - start), text };
		if (speaker) cue.speaker = speaker;
		cues.push(cue);
	}
	cues.sort((a, b) => a.t - b.t);
	return { format, cues, skipped };
}

/** ms precision, which is what both formats carry @param {number} v */
function round(v) {
	return Math.round(v * 1000) / 1000;
}

/** @param {Cue[]} cues */
function sorted(cues) {
	return [...(cues ?? [])].filter((c) => c && String(c.text ?? '').trim()).sort((a, b) => a.t - b.t);
}

/** Cues -> .srt text (the speaker, when set, leads the first line as "Name: "). @param {Cue[]} cues */
export function formatSrt(cues) {
	return sorted(cues)
		.map((c, i) => `${i + 1}\n${formatTimestamp(c.t, ',')} --> ${formatTimestamp(c.t + c.dur, ',')}\n${(c.speaker ? c.speaker + ': ' : '') + String(c.text).trim()}\n`)
		.join('\n');
}

/** VTT cue text must not hold "-->" and escapes & < > @param {string} s */
function vttEscape(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/-->/g, '--&gt;');
}

/** Cues -> .vtt text (the speaker as a `<v Name>` voice span, which players show or style). @param {Cue[]} cues */
export function formatVtt(cues) {
	const blocks = sorted(cues).map((c) => {
		const text = vttEscape(String(c.text).trim());
		const voiced = c.speaker ? `<v ${vttEscape(c.speaker)}>${text}` : text;
		return `${formatTimestamp(c.t, '.')} --> ${formatTimestamp(c.t + c.dur, '.')}\n${voiced}\n`;
	});
	return ['WEBVTT\n', ...blocks].join('\n');
}

/** The cues of a sequence's unmuted caption tracks, as a file wants them (one list, in time order). @param {any} seq */
export function cuesOfSequence(seq) {
	/** @type {Cue[]} */
	const out = [];
	for (const track of seq?.tracks ?? []) {
		if (track.kind !== 'caption' || track.muted) continue;
		for (const it of track.items ?? []) {
			/** @type {Cue} */
			const cue = { t: it.t, dur: it.dur, text: it.text };
			if (it.speaker) cue.speaker = it.speaker;
			out.push(cue);
		}
	}
	return sorted(out);
}

/** subtitle convention: ≤ 2 rows of ≤ 42 characters on screen, ≤ 7 s, ≥ 0.7 s */
export const CUE_CHARS = 84;
export const CUE_MAX_S = 7;
export const CUE_MIN_S = 0.7;

/**
 * Speech-to-text SEGMENTS ({start, end, text} in seconds of the clip) -> cues on the timeline:
 * shifted by `offset` (where the clip sits), clipped to the clip's window `[offset, offset+window)`,
 * and a long segment split into readable cues (by words, time shared in proportion to length).
 * @param {{start: number, end: number, text: string}[]} segments
 * @param {{offset?: number, window?: number, speaker?: string}} [opts]
 * @returns {Cue[]}
 */
export function cuesFromSegments(segments, opts = {}) {
	const offset = Number(opts.offset) || 0;
	const limit = Number.isFinite(Number(opts.window)) && Number(opts.window) > 0 ? offset + Number(opts.window) : Infinity;
	/** @type {Cue[]} */
	const out = [];
	for (const seg of segments ?? []) {
		const text = String(seg?.text ?? '').replace(/\s+/g, ' ').trim();
		const start = Number(seg?.start);
		const end = Number(seg?.end);
		if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
		for (const piece of splitSegment(text, start, end)) {
			const t = offset + piece.start;
			const stop = Math.min(limit, offset + piece.end);
			if (t >= limit || stop - t < 0.05) continue;
			/** @type {Cue} */
			const cue = { t: round(t), dur: round(Math.max(Math.min(CUE_MIN_S, limit - t), stop - t)), text: piece.text };
			if (opts.speaker) cue.speaker = opts.speaker;
			out.push(cue);
		}
	}
	return out;
}

/** @param {string} text @param {number} start @param {number} end @returns {{text: string, start: number, end: number}[]} */
function splitSegment(text, start, end) {
	const span = end - start;
	if (text.length <= CUE_CHARS && span <= CUE_MAX_S) return [{ text, start, end }];
	const parts = Math.max(Math.ceil(text.length / CUE_CHARS), Math.ceil(span / CUE_MAX_S));
	const words = text.split(' ');
	const target = text.length / parts;
	/** @type {string[]} */
	const chunks = [];
	let cur = '';
	for (const w of words) {
		if (cur && cur.length + 1 + w.length > target && chunks.length < parts - 1) {
			chunks.push(cur);
			cur = w;
		} else cur = cur ? cur + ' ' + w : w;
	}
	if (cur) chunks.push(cur);
	const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
	/** @type {{text: string, start: number, end: number}[]} */
	const out = [];
	let at = start;
	for (const c of chunks) {
		const len = (span * c.length) / total;
		out.push({ text: c, start: at, end: at + len });
		at += len;
	}
	return out;
}
