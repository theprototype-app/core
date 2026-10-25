// 77 C3 — LIVE SUBTITLES OF VOICE CHAT, CONSENT FIRST. A LEAF on the eager path (svelte/store +
// the app store + safeStorage); the capture itself (Web Audio → voice gate → caption engine) is the
// LAZY `liveCaptionCapture.js`, loaded only on the one peer that transcribes.
//
// THE RULES:
//   · A voice is captioned ONLY while its speaker says so: `liveCaptionConsent` (LOCAL, default
//     OFF, key `captions:liveConsent`). The speaker's own peer announces it (`livecap` op 'state',
//     from that peer's connection only — nobody can consent for somebody else) and everyone shows
//     a "CC" marker beside that name (Users list, the avatar label). Turning it off stops capture
//     at once and every receiver drops that speaker's lines from then on.
//   · ONE peer transcribes for the session ("host transcribes"): among the peers that VOLUNTEER
//     (`liveTranscribe`, key `captions:liveTranscribe`: 'auto' = this device has an in-browser
//     engine and is a desktop; 'on' = any engine, the speech server included; 'off'), the LOWEST
//     peer id wins — every peer computes the same answer from the same rows, so nothing elects it.
//     A Quest or a phone gets captions without running a model.
//   · The transcriber relays text (`livecap` op 'line' {speaker, text, id}); a receiver keeps a
//     line only when its speaker consents AND it came from the elected transcriber or the speaker
//     themself. Nothing is stored: a line lives LINE_MS on screen and is gone.
//   · Showing them is each viewer's own choice (`liveCaptionsShown`, default ON).
// Mesh-wide like voice chat itself (never room-gated), and on cloudHooks' ALWAYS_ALLOWED floor:
// a viewer's consent is presence about the viewer, and gating it would silently never caption them.
import { writable, derived, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { safeStorage } from './safeStorage';
import { captionEngines } from './captionEngines';

export const LINE_MS = 6000;
export const LINE_MAX = 300;
const CONSENT_KEY = 'captions:liveConsent';
const SHOW_KEY = 'captions:liveShow';
const TRANSCRIBE_KEY = 'captions:liveTranscribe';

/** "Let others caption my voice" — LOCAL, default off */
export const liveCaptionConsent = writable(safeStorage.getItem(CONSENT_KEY) === 'true');
/** show live captions of the people who allow them — LOCAL, default on */
export const liveCaptionsShown = writable(safeStorage.getItem(SHOW_KEY) !== 'false');
/** 'auto' | 'on' | 'off' @type {import('svelte/store').Writable<string>} */
export const liveTranscribe = writable(safeStorage.getItem(TRANSCRIBE_KEY) || 'auto');
liveCaptionConsent.subscribe((v) => (v ? safeStorage.setItem(CONSENT_KEY, 'true') : safeStorage.removeItem(CONSENT_KEY)));
liveCaptionsShown.subscribe((v) => (v ? safeStorage.removeItem(SHOW_KEY) : safeStorage.setItem(SHOW_KEY, 'false')));
liveTranscribe.subscribe((v) => (v && v !== 'auto' ? safeStorage.setItem(TRANSCRIBE_KEY, v) : safeStorage.removeItem(TRANSCRIBE_KEY)));

/** the speech server is set up (learnt lazily, only while 'on' asks for it) */
const serverReady = writable(false);
/** @type {(() => void) | null} */
let serverWatch = null;
liveTranscribe.subscribe((v) => {
	if (v !== 'on' || serverWatch || typeof window === 'undefined') return;
	serverWatch = () => {};
	import('./ai/stt.js').then((m) => (serverWatch = m.sttConfig.subscribe((c) => serverReady.set(m.sttReady(c)))));
});

const desktop = () => typeof matchMedia === 'undefined' || !matchMedia('(pointer: coarse)').matches;

/** Can THIS device transcribe for the session right now? */
export const canTranscribe = derived([liveTranscribe, captionEngines, serverReady], ([$pref, $engines, $server]) => {
	if ($pref === 'off') return false;
	const local = $engines.some((e) => e.local);
	return $pref === 'on' ? local || $server : local && desktop();
});

/** what each OTHER peer said about itself @type {import('svelte/store').Writable<Record<string, {consent: boolean, transcribe: boolean}>>} */
export const liveStates = writable({});
/** the lines on screen, newest per speaker @type {import('svelte/store').Writable<{speaker: string, text: string, id: number, until: number}[]>} */
export const liveLines = writable([]);

const myId = () => /** @type {any} */ (get(peers))?.peer?.id ?? '';

/** the speakers who allow captions (our own id included when we do) */
export const consentingSpeakers = derived([liveStates, liveCaptionConsent, peers], ([$s, $mine, $p]) => {
	const out = Object.keys($s).filter((id) => $s[id].consent);
	const me = /** @type {any} */ ($p)?.peer?.id;
	if ($mine && me) out.push(me);
	return out.sort();
});

/** The elected transcriber: the lowest id among the volunteers. Pure, for the suites. @param {string[]} ids */
export function electTranscriber(ids) {
	return [...ids].filter(Boolean).sort()[0] ?? null;
}
export const transcriberId = derived([liveStates, canTranscribe, peers], ([$s, $can, $p]) => {
	const ids = Object.keys($s).filter((id) => $s[id].transcribe);
	const me = /** @type {any} */ ($p)?.peer?.id;
	if ($can && me) ids.push(me);
	return electTranscriber(ids);
});

// ---- the wire -------------------------------------------------------------------

/** @type {{consent: boolean, transcribe: boolean} | null} */
let sent = null;
function stateMsg() {
	return { type: 'livecap', op: 'state', consent: get(liveCaptionConsent), transcribe: get(canTranscribe) };
}
/** announce our row when it CHANGES (an explicit false, so a peer holding our row hears it) */
export function publishLiveState(force = false) {
	const msg = stateMsg();
	if (!force && sent && sent.consent === msg.consent && sent.transcribe === msg.transcribe) return false;
	const peer = /** @type {any} */ (get(peers));
	if (!peer?.send) return false;
	sent = { consent: msg.consent, transcribe: msg.transcribe };
	peer.send(msg);
	return true;
}
/** the late-joiner reply (rides getmodulestate): only when there is something to say */
export function sendLiveState() {
	const msg = stateMsg();
	if (msg.consent || msg.transcribe) publishLiveState(true);
}

/** @param {any} text */
function clean(text) {
	return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);
}

let pruneTimer = /** @type {any} */ (null);
function prune() {
	clearTimeout(pruneTimer);
	const now = Date.now();
	const list = get(liveLines).filter((l) => l.until > now);
	if (list.length !== get(liveLines).length) liveLines.set(list);
	if (list.length) pruneTimer = setTimeout(prune, Math.max(50, Math.min(...list.map((l) => l.until)) - now + 20));
}

/** May a line about `speaker` from `from` be shown? */
function allowed(/** @type {string} */ speaker, /** @type {string} */ from) {
	const me = myId();
	const consent = speaker === me ? get(liveCaptionConsent) : !!get(liveStates)[speaker]?.consent;
	return consent && (from === speaker || from === get(transcriberId));
}

/** put a line on screen (ours or a peer's) @param {string} speaker @param {string} text @param {number} id */
function showLine(speaker, text, id) {
	liveLines.update((list) => [...list.filter((l) => l.speaker !== speaker), { speaker, text, id, until: Date.now() + LINE_MS }]);
	prune();
}

/**
 * Inbound `livecap`. `from` is the CONNECTION's peer id — never a field of the message.
 * @param {any} data @param {string} from @returns {boolean} applied
 */
export function applyLiveCaption(data, from) {
	if (!from || !data) return false;
	if (data.op === 'state') {
		const row = { consent: data.consent === true, transcribe: data.transcribe === true };
		liveStates.update((m) => {
			if (!row.consent && !row.transcribe) {
				if (!(from in m)) return m;
				const next = { ...m };
				delete next[from];
				return next;
			}
			return { ...m, [from]: row };
		});
		if (!row.consent) dropLinesOf(from);
		return true;
	}
	if (data.op === 'line') {
		const speaker = typeof data.speaker === 'string' ? data.speaker : '';
		const text = clean(data.text);
		if (!speaker || !text || !allowed(speaker, from)) return false;
		showLine(speaker, text, Number(data.id) || 0);
		return true;
	}
	return false;
}

let lineSeq = 0;
/**
 * The transcriber's output (liveCaptionCapture): show it here and relay it. Refused for a speaker
 * who does not (or no longer) consent — the capture checks too, this is the last word.
 * @param {string} speaker @param {string} text
 */
export function relayLiveLine(speaker, text) {
	const t = clean(text);
	if (!t || !allowed(speaker, myId())) return false;
	const id = ++lineSeq;
	showLine(speaker, t, id);
	/** @type {any} */ (get(peers))?.send?.({ type: 'livecap', op: 'line', speaker, text: t, id });
	return true;
}

/** @param {string} speaker */
function dropLinesOf(speaker) {
	if (get(liveLines).some((l) => l.speaker === speaker)) liveLines.update((list) => list.filter((l) => l.speaker !== speaker));
}

/** A peer left the session. @param {string} peerId */
export function dropPeerLiveCaption(peerId) {
	liveStates.update((m) => {
		if (!(peerId in m)) return m;
		const next = { ...m };
		delete next[peerId];
		return next;
	});
	dropLinesOf(peerId);
}

// ---- wiring ---------------------------------------------------------------------

/** @type {(() => void)[]} */
let disposers = [];
/** @type {Promise<any> | null} */
let capture = null;

/**
 * Install the presence broadcast + the capture switch. Idempotent; the subscribes live HERE, not at
 * module scope (the TDZ / SSR rule startColocationPresence states).
 */
export function startLiveCaptions() {
	if (disposers.length) return;
	disposers.push(liveCaptionConsent.subscribe((on) => (publishLiveState(), on || dropLinesOf(myId()))));
	disposers.push(canTranscribe.subscribe(() => publishLiveState()));
	// the capture runs on the elected transcriber while somebody consents
	disposers.push(
		derived([transcriberId, consentingSpeakers, peers], ([$t, $c, $p]) => !!$t && $t === /** @type {any} */ ($p)?.peer?.id && $c.length > 0).subscribe((run) => {
			if (!run && !capture) return;
			capture ??= import('./liveCaptionCapture.js');
			capture.then((m) => (run ? m.startCapture() : m.stopCapture()));
		})
	);
}

/** test/debug view */
export function liveCaptionsDebug() {
	return {
		wired: disposers.length > 0,
		me: myId(),
		consent: get(liveCaptionConsent),
		shown: get(liveCaptionsShown),
		transcribePref: get(liveTranscribe),
		canTranscribe: get(canTranscribe),
		states: { ...get(liveStates) },
		speakers: get(consentingSpeakers),
		transcriber: get(transcriberId),
		lines: get(liveLines).map((l) => ({ speaker: l.speaker, text: l.text })),
		sent
	};
}
