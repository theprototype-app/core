import { writable, get } from 'svelte/store';
import { userdata, showToast } from '../stores/appStore';
import { isLocked } from '../stores/sceneStore';

// Voice chat over the existing peerjs mesh (MediaConnection).
// - mic toggle transmits continuously; while OFF, holding V is push-to-talk
//   (the stream/call stays up, only the track is enabled/disabled — instant)
// - listeners never need mic permission: answering without a stream still
//   receives the caller's audio
// - only whitelisted peers (userdata) are answered, same trust rule as data

export const micActive = writable(false);
export const micGranted = writable(false);
export const pttActive = writable(false);
/** @type {import('svelte/store').Writable<Record<string, MediaStream>>} */
export const remoteStreams = writable({});
/** @type {import('svelte/store').Writable<string[]>} peer ids currently talking ('self' mapped to own id) */
export const speakingPeers = writable([]);
/** @type {import('svelte/store').Writable<string[]>} locally muted peers */
export const mutedPeers = writable([]);

/** @type {any} */ let peerConnection = null;
/** @type {MediaStream | null} */ let localStream = null;
let pttHeld = false;
/** @type {Record<string, any>} */ const outgoingCalls = {};
/** @type {Record<string, any>} */ const incomingCalls = {};
/** @type {any} */ let audioContext = null;
/** @type {Record<string, {analyser: any, data: Uint8Array}>} */ const analysers = {};

/** @param {any} call @param {'in'|'out'} direction */
function trackCall(call, direction) {
	(direction === 'in' ? incomingCalls : outgoingCalls)[call.peer] = call;
	call.on('stream', (/** @type {MediaStream} */ stream) => {
		remoteStreams.update((map) => ({ ...map, [call.peer]: stream }));
		watchStream(call.peer, stream);
	});
	call.on('close', () => cleanupCall(call.peer, direction));
	call.on('error', () => cleanupCall(call.peer, direction));
}

/** @param {string} peerId @param {'in'|'out'} direction */
function cleanupCall(peerId, direction) {
	delete (direction === 'in' ? incomingCalls : outgoingCalls)[peerId];
	if (!incomingCalls[peerId] && !outgoingCalls[peerId]) {
		remoteStreams.update((map) => {
			const next = { ...map };
			delete next[peerId];
			return next;
		});
		delete analysers[peerId];
	}
}

async function ensureStream() {
	if (localStream) return true;
	try {
		localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		micGranted.set(true);
		applyTrackState();
		callEveryone();
		watchStream('self', localStream);
		return true;
	} catch (error) {
		console.log('mic denied', error);
		showToast('Microphone permission denied');
		return false;
	}
}

function applyTrackState() {
	const enabled = get(micActive) || pttHeld;
	localStream?.getAudioTracks().forEach((track) => (track.enabled = enabled));
	pttActive.set(pttHeld && !get(micActive));
}

function callEveryone() {
	if (!localStream || !peerConnection) return;
	Object.keys(peerConnection.connections).forEach(callPeer);
}

/** @param {string} peerId */
function callPeer(peerId) {
	if (!localStream || outgoingCalls[peerId]) return;
	const call = peerConnection.peer.call(peerId, localStream);
	if (call) trackCall(call, 'out');
}

export async function toggleMic() {
	const next = !get(micActive);
	if (next && !(await ensureStream())) return;
	micActive.set(next);
	applyTrackState();
}

// --- push to talk (hold V while the toggle is off) ---
/** @param {KeyboardEvent} event */
function keyGuard(event) {
	/** @type {any} */
	const target = event.target;
	return (
		(target &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.tagName === 'SELECT' ||
				target.isContentEditable)) ||
		get(isLocked)
	);
}

/** @param {KeyboardEvent} event */
async function onKeydown(event) {
	if (event.key.toLowerCase() !== 'v' || event.repeat || keyGuard(event)) return;
	if (get(micActive)) return;
	pttHeld = true;
	if (await ensureStream()) applyTrackState();
	else pttHeld = false;
}

/** @param {KeyboardEvent} event */
function onKeyup(event) {
	if (event.key.toLowerCase() !== 'v') return;
	pttHeld = false;
	applyTrackState();
}

// --- speaking detection ---
/** @param {string} id @param {MediaStream} stream */
function watchStream(id, stream) {
	try {
		audioContext ??= new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);
		analysers[id] = { analyser, data: new Uint8Array(analyser.frequencyBinCount) };
	} catch (error) {
		console.log('analyser failed', error);
	}
}

function pollSpeaking() {
	/** @type {string[]} */
	const talking = [];
	const transmitting = get(micActive) || pttHeld;
	Object.entries(analysers).forEach(([id, entry]) => {
		if (id === 'self' && !transmitting) return;
		entry.analyser.getByteFrequencyData(entry.data);
		let sum = 0;
		for (let i = 0; i < entry.data.length; i++) sum += entry.data[i];
		if (sum / entry.data.length > 12) talking.push(id === 'self' ? peerConnection?.peer?.id : id);
	});
	const current = get(speakingPeers);
	if (JSON.stringify(current) !== JSON.stringify(talking)) speakingPeers.set(talking);
}

/** @param {string} peerId */
export function toggleMutePeer(peerId) {
	mutedPeers.update((list) =>
		list.includes(peerId) ? list.filter((id) => id !== peerId) : [...list, peerId]
	);
}

// --- lifecycle hooks called from the peer layer ---
/** @param {any} pc - the PeerConnection instance */
export function initVoiceChat(pc) {
	peerConnection = pc;
	pc.peer.on('call', (/** @type {any} */ call) => {
		const whitelisted = get(userdata).some((user) => user[0] === call.peer);
		if (!whitelisted) {
			call.close();
			return;
		}
		call.answer(localStream ?? undefined);
		trackCall(call, 'in');
	});
	window.addEventListener('keydown', onKeydown);
	window.addEventListener('keyup', onKeyup);
	// AudioContext starts suspended until a user gesture
	window.addEventListener('pointerdown', () => audioContext?.resume(), { once: false });
	setInterval(pollSpeaking, 150);
}

/** A data connection to this peer just opened — call them if we transmit @param {string} peerId */
export function voicePeerConnected(peerId) {
	if (localStream) callPeer(peerId);
}

/** @param {string} peerId */
export function voicePeerDisconnected(peerId) {
	incomingCalls[peerId]?.close();
	outgoingCalls[peerId]?.close();
	cleanupCall(peerId, 'in');
	cleanupCall(peerId, 'out');
}
