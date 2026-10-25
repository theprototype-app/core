import { writable, get } from 'svelte/store';
import { selectedObject } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import { noteDevice, deviceSpec, findDeviceObject, listDeviceObjects, isDeviceObject } from './audioDevices';

// WEB MIDI INPUT (roadmap 75 MU1): a hardware keyboard or pad controller plays the music
// devices.
//
// NOTHING NEW CROSSES THE WIRE. A key press becomes the same `noteDevice` call a click on
// the Piano's face makes — a local `onNote` plus one stamped `devicenote` — so every peer
// hears it, a peer without MIDI hears it, and a late joiner needs nothing. The MIDI side
// is purely LOCAL: which inputs this browser has, which device they play (two people with
// two keyboards play two instruments), and the permission.
//
// THE PERMISSION IS ASKED ONCE, BY A PERSON. `navigator.requestMIDIAccess` is never called
// at boot: the Music toolbox's "Connect MIDI keyboard" explains what happens, then asks
// the browser (sysex OFF — note and controller messages only). A grant is remembered, and
// a later boot reconnects silently ONLY when `navigator.permissions` already says
// 'granted'; an unknown or 'prompt' state waits for the button, so a reload never shows a
// prompt nobody asked for.
//
// HELD NOTES. A MIDI note has a length the player decides, so a device that says it can
// hold (`heldNotes: true` on its spec — music-voice's synth convention) gets
// `{note, velocity, gate: 0}` on key down and `{note, velocity: 0, off: true}` on key up.
// Every other device gets a plain note on key down (its own length) and NO off: an older
// device would read an off as a second, silent note. The sustain pedal (CC 64) defers the
// offs until it lifts. An off always goes to the device its note-on went to, even when
// the target changed while the key was down.

/** the remembered choice ('1' = the user connected MIDI here once) */
const STORAGE_KEY = 'midiInput';
const SUSTAIN_CC = 64;

/**
 * @typedef {{type: 'noteon'|'noteoff'|'cc'|'pitchbend'|'aftertouch'|'other', channel: number, note?: number, velocity?: number, controller?: number, value?: number, data: number[]}} MidiMessage
 */

/**
 * Parse one MIDI message (channel voice messages; system messages are 'other'). A note-on
 * with velocity 0 is a note-off — the running-status convention most keyboards use.
 * Velocities and controller values are 0..1, pitch bend -1..1.
 * @param {ArrayLike<number>} bytes @returns {MidiMessage|null}
 */
export function parseMidi(bytes) {
	if (!bytes || bytes.length < 1) return null;
	const data = Array.from(bytes, (b) => Number(b) & 0xff);
	const status = data[0];
	if (status < 0x80) return null; // a data byte with no status: running status is resolved by the browser
	const type = status & 0xf0;
	const channel = (status & 0x0f) + 1;
	const d1 = data[1] ?? 0;
	const d2 = data[2] ?? 0;
	if (status >= 0xf0) return { type: 'other', channel: 0, data };
	if (type === 0x90 && d2 > 0) return { type: 'noteon', channel, note: d1, velocity: d2 / 127, data };
	if (type === 0x80 || type === 0x90) return { type: 'noteoff', channel, note: d1, velocity: 0, data };
	if (type === 0xb0) return { type: 'cc', channel, controller: d1, value: d2 / 127, data };
	if (type === 0xe0) return { type: 'pitchbend', channel, value: Math.max(-1, (((d2 << 7) | d1) - 8192) / 8191), data };
	if (type === 0xa0 || type === 0xd0) return { type: 'aftertouch', channel, note: type === 0xa0 ? d1 : undefined, value: (type === 0xa0 ? d2 : d1) / 127, data };
	return { type: 'other', channel, data };
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** 60 -> 'C4' @param {number} note */
export function noteName(note) {
	const n = Math.round(Number(note));
	return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// ---- state ------------------------------------------------------------------------------

/**
 * What the toolbox row shows. `status`: 'off' (never connected here, or disconnected),
 * 'asking' (the browser prompt is up), 'on', 'denied', 'unsupported' (no Web MIDI in this
 * browser), 'error'.
 * @type {import('svelte/store').Writable<{status: string, inputs: {id: string, name: string, manufacturer: string}[], last: {note: number, velocity: number, at: number}|null, error: string}>}
 */
export const midiState = writable({ status: midiSupported() ? 'off' : 'unsupported', inputs: [], last: null, error: '' });

/** The device MIDI plays: a uuid the user picked, or '' = follow the selection (the last
 * selected device that plays notes stays the target when the selection moves on). LOCAL. */
export const midiTarget = writable('');

/** the last selected note device, for '' (follow) */
let followed = '';
/** @type {(() => void)|null} */
let stopFollow = null;

/** @type {any} the MIDIAccess while connected */
let access = null;
/** module listeners (api.audio.onMidi) @type {Set<(msg: MidiMessage & {input: string}) => void>} */
const listeners = new Set();
/** note -> the device uuid its note-on went to, while the key (or the pedal) holds it */
const held = new Map();
/** notes whose key went up while the pedal was down */
const sustained = new Set();
let pedal = false;
/** what the suite reads: how often the browser was asked, and every note routed */
const debug = { requests: 0, routed: 0, offs: 0, dropped: 0 };

export function midiSupported() {
	return typeof navigator !== 'undefined' && typeof (/** @type {any} */ (navigator).requestMIDIAccess) === 'function';
}

/** @param {any} object */
function playsNotes(object) {
	return isDeviceObject(object) && typeof deviceSpec(object.userData.device.kind)?.onNote === 'function';
}

/** Every device in the scene that plays notes (the picker's list). */
export function noteDevices() {
	return listDeviceObjects()
		.filter(playsNotes)
		.map((object) => ({ uuid: object.uuid, name: object.name || deviceSpec(object.userData.device.kind)?.label || object.userData.device.kind }));
}

/** The uuid MIDI plays right now, or '' when there is nothing to play. */
export function resolveMidiTarget() {
	const picked = get(midiTarget);
	if (picked) return playsNotes(findDeviceObject(picked)) ? picked : '';
	if (followed && playsNotes(findDeviceObject(followed))) return followed;
	const all = noteDevices();
	return all.length === 1 ? all[0].uuid : '';
}

function startFollow() {
	if (stopFollow) return;
	stopFollow = selectedObject.subscribe((object) => {
		if (playsNotes(object)) followed = object.uuid;
	});
}

// ---- connecting ---------------------------------------------------------------------------

/** @param {Partial<{status: string, inputs: any[], last: any, error: string}>} patch */
function setState(patch) {
	midiState.update((s) => ({ ...s, ...patch }));
}

function refreshInputs() {
	/** @type {{id: string, name: string, manufacturer: string}[]} */
	const inputs = [];
	if (access?.inputs) {
		for (const input of access.inputs.values()) {
			if (input.state === 'disconnected') continue;
			input.onmidimessage = onMessage;
			inputs.push({ id: String(input.id), name: String(input.name || 'MIDI input'), manufacturer: String(input.manufacturer || '') });
		}
	}
	setState({ inputs });
}

/**
 * Connect: ask the browser (the first time, a prompt), listen to every input, and follow
 * hot-plugging. Call it from a person's click — the boot path is `resumeMidiIfGranted`.
 * Resolves to the new status.
 */
export async function enableMidi() {
	if (!midiSupported()) {
		setState({ status: 'unsupported' });
		return 'unsupported';
	}
	if (access) return get(midiState).status;
	setState({ status: 'asking', error: '' });
	debug.requests++;
	try {
		access = await /** @type {any} */ (navigator).requestMIDIAccess({ sysex: false });
	} catch (error) {
		access = null;
		const denied = /** @type {any} */ (error)?.name === 'SecurityError' || /** @type {any} */ (error)?.name === 'NotAllowedError';
		setState({ status: denied ? 'denied' : 'error', error: denied ? '' : String(/** @type {any} */ (error)?.message || error) });
		return denied ? 'denied' : 'error';
	}
	access.onstatechange = () => refreshInputs();
	refreshInputs();
	startFollow();
	safeStorage.setItem(STORAGE_KEY, '1');
	setState({ status: 'on' });
	return 'on';
}

/** Disconnect: stop listening, release every held note, forget the choice. */
export function disableMidi() {
	if (access) {
		try {
			for (const input of access.inputs.values()) input.onmidimessage = null;
			access.onstatechange = null;
		} catch {}
	}
	access = null;
	releaseAll();
	safeStorage.setItem(STORAGE_KEY, '0');
	setState({ status: midiSupported() ? 'off' : 'unsupported', inputs: [] });
}

/**
 * Boot: reconnect WITHOUT a prompt when this browser connected before and the permission
 * is already granted. Anything else ('prompt', unknown, a browser that cannot say) waits
 * for the button. Resolves to whether it connected.
 */
export async function resumeMidiIfGranted() {
	if (!midiSupported() || safeStorage.getItem(STORAGE_KEY) !== '1') return false;
	try {
		const permission = await navigator.permissions?.query(/** @type {any} */ ({ name: 'midi', sysex: false }));
		if (permission?.state !== 'granted') return false;
	} catch {
		return false;
	}
	return (await enableMidi()) === 'on';
}

// ---- routing --------------------------------------------------------------------------------

/** @param {string} uuid */
function holds(uuid) {
	const object = findDeviceObject(uuid);
	return !!(object && deviceSpec(object.userData.device.kind)?.heldNotes);
}

/** @param {number} note */
function sendOff(note) {
	const uuid = held.get(note);
	held.delete(note);
	sustained.delete(note);
	if (!uuid || !holds(uuid)) return;
	debug.offs++;
	noteDevice(uuid, { note, velocity: 0, off: true });
}

function releaseAll() {
	pedal = false;
	for (const note of [...held.keys()]) sendOff(note);
	sustained.clear();
}

/**
 * One message from an input (exported: the suite and a module's synthetic input use it).
 * Notes route to the target device; every message goes to the module listeners.
 * @param {MidiMessage} msg @param {string} [input]
 */
export function handleMidiMessage(msg, input = '') {
	if (!msg) return;
	for (const fn of listeners) {
		try {
			fn({ ...msg, input });
		} catch (error) {
			console.warn('[midiInput] a listener threw', error);
		}
	}
	if (msg.type === 'noteon' && typeof msg.note === 'number') {
		const uuid = resolveMidiTarget();
		if (!uuid) {
			debug.dropped++;
			return;
		}
		// a re-struck key that is still held (or sustained) ends its old note first
		if (held.has(msg.note)) sendOff(msg.note);
		const velocity = Math.max(0.01, Math.min(1, msg.velocity ?? 1));
		if (holds(uuid)) {
			held.set(msg.note, uuid);
			noteDevice(uuid, { note: msg.note, velocity, gate: 0 });
		} else noteDevice(uuid, { note: msg.note, velocity });
		debug.routed++;
		setState({ last: { note: msg.note, velocity, at: Date.now() } });
	} else if (msg.type === 'noteoff' && typeof msg.note === 'number') {
		if (!held.has(msg.note)) return;
		if (pedal) sustained.add(msg.note);
		else sendOff(msg.note);
	} else if (msg.type === 'cc' && msg.controller === SUSTAIN_CC) {
		const down = (msg.value ?? 0) >= 0.5;
		if (down === pedal) return;
		pedal = down;
		if (!down) for (const note of [...sustained]) sendOff(note);
	}
}

/** @param {any} event a MIDIMessageEvent */
function onMessage(event) {
	handleMidiMessage(/** @type {MidiMessage} */ (parseMidi(event?.data)), String(event?.target?.id ?? ''));
}

/**
 * A module's listener for every parsed message (notes, controllers, pitch bend) — LOCAL:
 * what it does with them (a knob preview, a note) is what replicates. Returns an off.
 * @param {(msg: MidiMessage & {input: string}) => void} fn
 */
export function onMidiMessage(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** What the runtime holds — for `window.__stores` and the suite. */
export function midiDebug() {
	return { ...debug, connected: !!access, listeners: listeners.size, held: [...held.entries()], sustained: [...sustained], pedal, target: resolveMidiTarget(), followed };
}
