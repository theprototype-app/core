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
// positional audio: voices come from the peer's avatar (PannerNode per peer)
export const spatialVoice = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('spatialVoice') !== 'false'
);
/** @type {import('svelte/store').Writable<'ptt' | 'open' | 'off'>} VR mic mode (quick-menu tile) */
export const vrMicMode = writable('ptt');
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

/** Shared AudioContext (ping chimes ride the same spatial listener, 87) */
export function ensureAudioContext() {
	audioContext ??= new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
	return audioContext;
}

/** @param {any} call @param {'in'|'out'} direction */
function trackCall(call, direction) {
	(direction === 'in' ? incomingCalls : outgoingCalls)[call.peer] = call;
	call.on('stream', (/** @type {MediaStream} */ stream) => {
		remoteStreams.update((map) => ({ ...map, [call.peer]: stream }));
		watchStream(call.peer, stream);
		if (get(spatialVoice)) buildSpatialChain(call.peer, stream);
	});
	call.on('close', () => cleanupCall(call.peer, direction));
	call.on('error', () => cleanupCall(call.peer, direction));
}

// --- spatial audio: stream -> panner (HRTF) -> gain (per-peer mute) -> out.
// The hidden <audio> element stays attached at volume 0: Chrome only pumps
// WebRTC audio into WebAudio while a media element consumes the stream.
/** @type {Record<string, {source: any, panner: any, gain: any}>} */
const spatialChains = {};

/** @param {string} peerId @param {MediaStream} stream */
function buildSpatialChain(peerId, stream) {
	if (spatialChains[peerId]) return;
	try {
		audioContext ??= new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
		const source = audioContext.createMediaStreamSource(stream);
		const panner = audioContext.createPanner();
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'inverse';
		panner.refDistance = 2;
		panner.maxDistance = 40;
		panner.rolloffFactor = 1;
		const gain = audioContext.createGain();
		gain.gain.value = get(mutedPeers).includes(peerId) ? 0 : 1;
		source.connect(panner).connect(gain).connect(audioContext.destination);
		spatialChains[peerId] = { source, panner, gain };
	} catch (error) {
		console.log('spatial chain failed', error);
	}
}

/** @param {string} peerId */
function dropSpatialChain(peerId) {
	const chain = spatialChains[peerId];
	if (!chain) return;
	try {
		chain.source.disconnect();
		chain.panner.disconnect();
		chain.gain.disconnect();
	} catch {}
	delete spatialChains[peerId];
}

/** Peer ids with an active spatial chain + their panner positions (tests/UI) */
export function spatialDebug() {
	/** @type {Record<string, number[]>} */
	const out = {};
	Object.entries(spatialChains).forEach(([id, chain]) => {
		out[id] = [chain.panner.positionX.value, chain.panner.positionY.value, chain.panner.positionZ.value];
	});
	return out;
}

let lastSpatialUpdate = 0;

/**
 * Called every frame from the scene: aim the listener at the camera and each
 * panner at its peer's avatar (throttled to ~10/s).
 * @param {any} camera @param {any} scene
 */
export function updateSpatialAudio(camera, scene) {
	if (!audioContext || !get(spatialVoice) || !camera || !scene) return;
	const now = performance.now();
	if (now - lastSpatialUpdate < 100) return;
	lastSpatialUpdate = now;

	const listener = audioContext.listener;
	// matrix columns instead of three helpers, so this module stays three-free
	const world = camera.matrixWorld?.elements;
	if (!world) return;
	const px = world[12], py = world[13], pz = world[14];
	const fx = -world[8], fy = -world[9], fz = -world[10]; // -Z column = forward
	const ux = world[4], uy = world[5], uz = world[6];
	if (listener.positionX) {
		listener.positionX.value = px;
		listener.positionY.value = py;
		listener.positionZ.value = pz;
		listener.forwardX.value = fx;
		listener.forwardY.value = fy;
		listener.forwardZ.value = fz;
		listener.upX.value = ux;
		listener.upY.value = uy;
		listener.upZ.value = uz;
	} else {
		listener.setPosition(px, py, pz);
		listener.setOrientation(fx, fy, fz, ux, uy, uz);
	}

	Object.entries(spatialChains).forEach(([peerId, chain]) => {
		const avatar = scene.getObjectByName(peerId);
		if (!avatar) return;
		const m = avatar.matrixWorld.elements;
		if (chain.panner.positionX) {
			chain.panner.positionX.value = m[12];
			chain.panner.positionY.value = m[13];
			chain.panner.positionZ.value = m[14];
		} else {
			chain.panner.setPosition(m[12], m[13], m[14]);
		}
	});
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
		dropSpatialChain(peerId);
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

/** VR A-button push-to-talk (same track path as hold-V) @param {boolean} held */
export async function setPttHeld(held) {
	if (get(vrMicMode) === 'off' || get(micActive)) return;
	pttHeld = held;
	if (held) {
		if (await ensureStream()) applyTrackState();
		else pttHeld = false;
	} else applyTrackState();
}

/** Quick-menu tile: PTT -> Open -> Off -> PTT */
export async function cycleMicMode() {
	const mode = get(vrMicMode);
	if (mode === 'ptt') {
		vrMicMode.set('open');
		if (!get(micActive)) await toggleMic();
	} else if (mode === 'open') {
		vrMicMode.set('off');
		if (get(micActive)) await toggleMic();
		pttHeld = false;
		applyTrackState();
	} else {
		vrMicMode.set('ptt');
	}
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
	if (get(micActive) || get(vrMicMode) === 'off') return;
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

// keep the spatial chains in line with per-peer mutes and the mode toggle
mutedPeers.subscribe((list) => {
	Object.entries(spatialChains).forEach(([peerId, chain]) => {
		chain.gain.gain.value = list.includes(peerId) ? 0 : 1;
	});
});
spatialVoice.subscribe((on) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('spatialVoice', String(on));
	if (on) Object.entries(get(remoteStreams)).forEach(([peerId, stream]) => buildSpatialChain(peerId, stream));
	else Object.keys(spatialChains).forEach(dropSpatialChain);
});

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
