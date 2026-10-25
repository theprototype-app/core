// 77 C1/C2 — THE CAPTION ENGINES: who turns speech into timed text. A LEAF (svelte/store +
// safeStorage only), so the SDK, Settings and the lazy caption-job code all reach it without
// pulling anything heavy into the boot bundle.
//
// An ENGINE is `{id, label, local, languages, transcribe(job)}`:
//   · `local` = it runs on this device (no audio leaves it) — the in-browser module `captions`
//     (Moonshine) registers one through `api.captions.registerEngine`;
//   · `languages` = ISO-639-1 codes it can hear, or ['*'];
//   · `transcribe({audio, sampleRate, language, signal, onProgress})` — `audio` is 16 kHz MONO
//     Float32 PCM — resolves `{segments: [{start, end, text}], text?, language?}` in seconds of the clip.
// Core registers ONE built-in, 'whisper' (captionJobs.js): the Settings ▸ AI ▸ Voice typing server
// (OpenAI whisper-1, Groq whisper-large-v3, a self-hosted whisper.cpp / faster-whisper).
//
// The CHOICE is a LOCAL per-device setting (`captions:engine`): 'auto' picks a local engine
// that speaks the language when one is installed, else the server; any other value names one.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

/** @typedef {{start: number, end: number, text: string}} Segment */
/** @typedef {{audio: Float32Array, sampleRate: number, language?: string, signal?: AbortSignal, onProgress?: (p: number) => void}} CaptionJob */
/** @typedef {{id: string, label: string, local: boolean, languages: string[], owner?: string, transcribe: (job: CaptionJob) => Promise<{segments: Segment[], text?: string, language?: string}>, status?: () => string}} CaptionEngine */

/** @type {import('svelte/store').Writable<CaptionEngine[]>} */
export const captionEngines = writable([]);

export const ENGINE_KEY = 'captions:engine';
export const LANGUAGE_KEY = 'captions:language';

/** 'auto' | an engine id @type {import('svelte/store').Writable<string>} */
export const captionEnginePref = writable(safeStorage.getItem(ENGINE_KEY) || 'auto');
/** '' = English / let the engine tell; else ISO-639-1 @type {import('svelte/store').Writable<string>} */
export const captionLanguage = writable(safeStorage.getItem(LANGUAGE_KEY) || '');
captionEnginePref.subscribe((v) => (v && v !== 'auto' ? safeStorage.setItem(ENGINE_KEY, v) : safeStorage.removeItem(ENGINE_KEY)));
captionLanguage.subscribe((v) => (v ? safeStorage.setItem(LANGUAGE_KEY, v) : safeStorage.removeItem(LANGUAGE_KEY)));

/**
 * Add an engine (a later one with the same id replaces it). Returns the remover.
 * @param {Partial<CaptionEngine> & {id: string, transcribe: CaptionEngine['transcribe']}} def @returns {() => void}
 */
export function registerCaptionEngine(def) {
	if (!def || typeof def.transcribe !== 'function' || !String(def.id ?? '').trim()) throw new Error('registerCaptionEngine: needs {id, transcribe}');
	/** @type {CaptionEngine} */
	const engine = {
		...def,
		id: String(def.id).trim(),
		label: String(def.label ?? def.id),
		local: !!def.local,
		languages: Array.isArray(def.languages) && def.languages.length ? def.languages.map((l) => String(l).toLowerCase()) : ['*']
	};
	captionEngines.update((list) => [...list.filter((e) => e.id !== engine.id), engine]);
	return () => captionEngines.update((list) => list.filter((e) => e !== engine));
}

/** @param {CaptionEngine} engine @param {string} language */
export function speaks(engine, language) {
	const lang = String(language || 'en').toLowerCase();
	return engine.languages.includes('*') || engine.languages.includes(lang);
}

/**
 * The engine a job uses: the named one, else ('auto') a LOCAL engine that speaks the language,
 * else the server preset. Null when nothing can run (the caller says what to set up).
 * @param {{pref?: string, language?: string, serverReady?: boolean, needLocal?: boolean}} [opts]
 * @returns {CaptionEngine | null}
 */
export function pickCaptionEngine(opts = {}) {
	const list = get(captionEngines);
	const pref = opts.pref ?? get(captionEnginePref);
	const language = opts.language ?? get(captionLanguage);
	const usable = (/** @type {CaptionEngine} */ e) => (e.id !== 'whisper' || opts.serverReady !== false) && (!opts.needLocal || e.local);
	if (pref && pref !== 'auto') {
		const named = list.find((e) => e.id === pref);
		if (named && usable(named)) return named;
	}
	return list.find((e) => e.local && speaks(e, language) && usable(e)) ?? list.find((e) => !e.local && speaks(e, language) && usable(e)) ?? null;
}
