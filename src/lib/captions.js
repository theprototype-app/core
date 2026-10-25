// 53 (A6 + A5) — THE CAPTION BUS. One line of text per sound a game plays, for players who cannot
// hear it (deaf / hard of hearing, sound off, a noisy room). Producers say WHAT is heard; this
// module keeps the short list of lines on screen; the renderers draw it — CaptionOverlay.svelte
// on a flat screen, a head-locked strip on the VR game board (vrGamePanel).
//
// THE SHARED FORMAT (53-play publishes it, 53-scale owns it — QUESTIONS-53-play Q1):
//   · a Sound node and a Game Sound node carry `data.caption` (a string; '-' = never caption);
//   · a Timeline AUDIO item carries `caption` (sequenceCore keeps unknown fields already);
//   · a module calls `api.captions.show(text, {seconds})`.
// Every peer reaches the same producer line itself (a trigger stamp, a sequence run), so nothing
// here replicates: whether captions SHOW is each player's own Accessibility choice.
//
// Producers always push; `captionsShown` decides whether anything is drawn — so turning captions on
// mid-game shows the next line, and a suite can read what WOULD be captioned with them off.
//
// A LEAF: svelte/store + the pure core + playerAccess (a leaf).
import { writable, derived, get } from 'svelte/store';
import { pushCaption, liveCaptions, captionFor, cleanCaption } from './playerAccessCore';
import { accessValues } from './playerAccess';

/** @typedef {import('./playerAccessCore').Caption} Caption */

/** the live caption lines (expired ones are pruned on the next push / tick) @type {import('svelte/store').Writable<Caption[]>} */
export const activeCaptions = writable([]);

/** 53-scale's editor-side switch (Settings ▸ Accessibility ▸ Captions) can set this; the player's
 * own per-game row is the other way in. @type {import('svelte/store').Writable<boolean>} */
export const captionsForced = writable(false);

/** Are captions drawn right now? */
export const captionsShown = derived([accessValues, captionsForced], ([$v, $f]) => !!$v.captions || $f);

let nextId = 1;
/** @type {ReturnType<typeof setTimeout> | null} */
let pruneTimer = null;
/** @type {{pushed: number, last: string[]}} */
const debug = { pushed: 0, last: [] };

function schedulePrune() {
	if (pruneTimer) return;
	const list = get(activeCaptions);
	if (!list.length) return;
	const wait = Math.max(50, Math.min(...list.map((c) => c.until)) - Date.now() + 20);
	pruneTimer = setTimeout(() => {
		pruneTimer = null;
		activeCaptions.set(liveCaptions(get(activeCaptions), Date.now()));
		schedulePrune();
	}, wait);
}

/**
 * Show a caption line. `source` names the producer ('sound', 'gamesound', 'timeline', a module id).
 * Returns the text shown ('' when there was nothing to say).
 * @param {{text: any, source?: string, seconds?: number}} cap
 */
export function showCaption(cap) {
	const text = cleanCaption(cap?.text);
	if (!text) return '';
	const next = pushCaption(get(activeCaptions), { text, source: cap?.source, ms: Number(cap?.seconds) * 1000 || undefined }, Date.now(), nextId++);
	activeCaptions.set(next);
	debug.pushed++;
	debug.last = [...debug.last, text].slice(-10);
	schedulePrune();
	return text;
}

/**
 * A sound fired: caption it by the authored text, else the built-in game sound's default.
 * @param {any} authored node/clip caption @param {{source: string, sound?: string, seconds?: number}} from
 */
export function captionSound(authored, from) {
	const text = captionFor(authored, from.sound);
	if (!text) return '';
	return showCaption({ text, source: from.source, seconds: from.seconds });
}

// ---- 77 C1: SUBTITLES — the cues of caption TRACKS (sequenceCore `captionsAt`), keyed by the
// sequence showing them (a run's playhead or a parked scrub). Unlike the bus above they are
// AUTHORED content: shown to everyone while their sequence plays, whatever the Captions switch.
/** @typedef {{id: string, text: string, speaker?: string, seq: string}} SubtitleLine */
/** @type {import('svelte/store').Writable<SubtitleLine[]>} */
export const subtitleLines = writable([]);
/** @type {Map<string, {sig: string, lines: SubtitleLine[]}>} */
const subtitleBy = new Map();

/**
 * The cues `key` (a sequence id) shows now; [] takes them down. Writes the store only on a
 * CHANGE (the player calls this every frame).
 * @param {string} key @param {{id: string, text: string, speaker?: string}[]} cues
 */
export function setSubtitles(key, cues) {
	const sig = cues.map((c) => c.id + '\u0001' + c.text + '\u0001' + (c.speaker ?? '')).join('\u0002');
	if ((subtitleBy.get(key)?.sig ?? '') === sig) return;
	if (cues.length) subtitleBy.set(key, { sig, lines: cues.map((c) => ({ ...c, seq: key })) });
	else subtitleBy.delete(key);
	subtitleLines.set([...subtitleBy.values()].flatMap((v) => v.lines));
}

/** One string per subtitle line, speaker first ("Ana: text"). @param {SubtitleLine[]} lines */
export function subtitleTexts(lines) {
	return lines.map((l) => (l.speaker ? l.speaker + ': ' : '') + l.text);
}

/** Clear every line (a scene switch, leaving play). */
export function clearCaptions() {
	activeCaptions.set([]);
}

/** the suites' view */
export function captionsDebug() {
	return { pushed: debug.pushed, last: [...debug.last], live: get(activeCaptions).map((c) => ({ text: c.text, source: c.source })), shown: get(captionsShown), subtitles: get(subtitleLines).map((l) => ({ text: l.text, speaker: l.speaker ?? '', seq: l.seq })) };
}
