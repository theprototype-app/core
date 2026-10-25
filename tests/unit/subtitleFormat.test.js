// 77 C1 — .srt / .vtt in and out, speech segments into cues, and the cue maths in sequenceCore.
import { describe, it, expect } from 'vitest';
import { parseSubtitles, formatSrt, formatVtt, parseTimestamp, formatTimestamp, cuesFromSegments, cuesOfSequence, CUE_CHARS } from '../../src/lib/subtitleFormat.js';
import { normalizeSequence, captionsAt, splitCaption, cleanCueText, normalizeItem } from '../../src/lib/sequenceCore.js';

const SRT = `﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,250\r\n<i>Two</i> lines\r\nof text\r\n\r\n3\r\nnot a time\r\nbroken\r\n`;
const VTT = `WEBVTT - a title

NOTE a comment

intro
00:01.000 --> 00:02.500 align:center line:90%
<v Ana>Hi &amp; welcome</v>

00:00:03.000 --> 00:00:04.000
{\\an8}Top line
`;

describe('subtitle files', () => {
	it('reads timestamps in both separators, with or without hours', () => {
		expect(parseTimestamp('01:02:03,450')).toBeCloseTo(3723.45, 6);
		expect(parseTimestamp('02:03.4')).toBeCloseTo(123.4, 6);
		expect(Number.isNaN(parseTimestamp('nope'))).toBe(true);
		expect(formatTimestamp(3723.45, ',')).toBe('01:02:03,450');
		expect(formatTimestamp(0.0004, '.')).toBe('00:00:00.000');
	});
	it('parses .srt (BOM, CRLF, tags stripped, a broken block counted)', () => {
		const out = parseSubtitles(SRT);
		expect(out.format).toBe('srt');
		expect(out.cues).toEqual([
			{ t: 1, dur: 2.5, text: 'Hello there.' },
			{ t: 4, dur: 2.25, text: 'Two lines\nof text' }
		]);
		expect(out.skipped).toBe(1);
	});
	it('parses .vtt (header, NOTE, cue ids and settings, voice span = speaker, entities)', () => {
		const out = parseSubtitles(VTT);
		expect(out.format).toBe('vtt');
		expect(out.skipped).toBe(0);
		expect(out.cues).toEqual([
			{ t: 1, dur: 1.5, text: 'Hi & welcome', speaker: 'Ana' },
			{ t: 3, dur: 1, text: 'Top line' }
		]);
	});
	it('round-trips through .srt and .vtt', () => {
		const cues = [
			{ t: 2, dur: 1.5, text: 'Second' },
			{ t: 0.5, dur: 1, text: 'First <line> & -->', speaker: 'Bo' }
		];
		const vtt = formatVtt(cues);
		expect(vtt.startsWith('WEBVTT\n')).toBe(true);
		expect(vtt).toContain('<v Bo>First &lt;line&gt; &amp; --&gt;');
		expect(parseSubtitles(vtt).cues).toEqual([
			{ t: 0.5, dur: 1, text: 'First <line> & -->', speaker: 'Bo' },
			{ t: 2, dur: 1.5, text: 'Second' }
		]);
		const srt = formatSrt(cues);
		expect(srt.split('\n').slice(0, 3)).toEqual(['1', '00:00:00,500 --> 00:00:01,500', 'Bo: First <line> & -->']);
		expect(parseSubtitles(srt).cues.map((c) => c.t)).toEqual([0.5, 2]);
	});
	it('collects the unmuted caption tracks of a sequence in time order', () => {
		const seq = normalizeSequence({
			tracks: [
				{ kind: 'caption', items: [{ t: 3, dur: 1, text: 'b' }] },
				{ kind: 'caption', muted: true, items: [{ t: 0, dur: 1, text: 'muted' }] },
				{ kind: 'caption', items: [{ t: 1, dur: 1, text: 'a', speaker: 'X' }] },
				{ kind: 'audio', items: [{ t: 0, dur: 1, caption: 'not a cue' }] }
			]
		});
		expect(cuesOfSequence(seq)).toEqual([
			{ t: 1, dur: 1, text: 'a', speaker: 'X' },
			{ t: 3, dur: 1, text: 'b' }
		]);
	});
});

describe('speech segments -> cues', () => {
	it('shifts by the clip position and clips to its window', () => {
		const cues = cuesFromSegments(
			[
				{ start: 0.2, end: 1.4, text: ' Hello ' },
				{ start: 1.5, end: 3, text: 'world' },
				{ start: 9, end: 10, text: 'past the clip' },
				{ start: 2, end: 1, text: 'backwards' }
			],
			{ offset: 5, window: 2.5 }
		);
		expect(cues).toEqual([
			{ t: 5.2, dur: 1.2, text: 'Hello' },
			{ t: 6.5, dur: 1, text: 'world' }
		]);
	});
	it('splits a long segment into readable cues sharing its time', () => {
		const words = Array.from({ length: 40 }, (_, i) => 'word' + i).join(' ');
		const cues = cuesFromSegments([{ start: 0, end: 12, text: words }]);
		expect(cues.length).toBeGreaterThan(1);
		expect(cues.every((c) => c.text.length <= CUE_CHARS + 8)).toBe(true);
		expect(cues[0].t).toBe(0);
		const last = cues[cues.length - 1];
		expect(last.t + last.dur).toBeCloseTo(12, 2);
		expect(cues.map((c) => c.text).join(' ')).toBe(words);
	});
});

describe('caption tracks in the sequence core', () => {
	it('a caption item keeps text (≤ 3 lines) and only a set speaker', () => {
		const it1 = normalizeItem('caption', { t: 1, text: ' one \r\n\n two  three \nfour\nfive' });
		expect(it1.text).toBe('one\ntwo three\nfour');
		expect('speaker' in it1).toBe(false);
		expect(it1.dur).toBe(2);
		expect(normalizeItem('caption', { text: 'x', speaker: '  Ana ' }).speaker).toBe('Ana');
		expect(cleanCueText('x'.repeat(400)).length).toBe(300);
	});
	it('captionsAt: start inclusive, end exclusive, muted tracks silent', () => {
		const seq = normalizeSequence({
			tracks: [
				{ kind: 'caption', items: [{ id: 'a', t: 0, dur: 1, text: 'A' }, { id: 'b', t: 1, dur: 1, text: 'B', speaker: 'S' }] },
				{ kind: 'caption', muted: true, items: [{ id: 'm', t: 0, dur: 5, text: 'M' }] }
			]
		});
		expect(captionsAt(seq, 0)).toEqual([{ id: 'a', text: 'A' }]);
		expect(captionsAt(seq, 0.999)).toEqual([{ id: 'a', text: 'A' }]);
		expect(captionsAt(seq, 1)).toEqual([{ id: 'b', text: 'B', speaker: 'S' }]);
		expect(captionsAt(seq, 2)).toEqual([]);
	});
	it('splitCaption wraps at spaces and hard-breaks an over-long word', () => {
		expect(splitCaption('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
		expect(splitCaption('ab\ncd', 10)).toEqual(['ab', 'cd']);
		expect(splitCaption('abcdefghij x', 4)).toEqual(['abcd', 'efgh', 'ij x']);
	});
});
