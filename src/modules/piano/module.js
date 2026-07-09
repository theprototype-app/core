import * as THREE from 'three';
import { hapticPulse } from '$lib/vrControls';

// One-octave piano: clicking a key (desktop or VR trigger) plays a synth
// note locally and broadcasts {op:'note', midi} so every peer hears and sees
// the same key dip. The keyboard itself is a module-owned group at the scene
// root, spawned/removed via the module menu and state-synced to late joiners.

const GROUP_NAME = 'piano-module';
const WHITE_MIDI = [60, 62, 64, 65, 67, 69, 71]; // C4..B4
const BLACK_MIDI = { 0: 61, 1: 63, 3: 66, 4: 68, 5: 70 }; // after C, D, F, G, A

/** @type {any} */ let apiRef = null;
let spawned = false;

/** @type {AudioContext | null} */ let audio = null;

/** @param {number} midi */
function playNote(midi) {
	try {
		audio ??= new AudioContext();
		if (audio.state === 'suspended') audio.resume();
		const osc = audio.createOscillator();
		const gain = audio.createGain();
		osc.type = 'triangle';
		osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
		gain.gain.setValueAtTime(0.0001, audio.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.35, audio.currentTime + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.5);
		osc.connect(gain).connect(audio.destination);
		osc.start();
		osc.stop(audio.currentTime + 0.55);
	} catch (error) {
		console.log('piano audio unavailable', error);
	}
}

/** Visual key dip + note bookkeeping @param {number} midi */
function pressKey(midi) {
	const group = apiRef?.scene()?.getObjectByName(GROUP_NAME);
	if (!group) return;
	group.userData.lastNote = { midi: midi, at: Date.now() };
	const key = group.children.find((child) => child.userData.midi === midi);
	if (!key || key.userData.dipped) return;
	key.userData.dipped = true;
	key.position.y -= 0.02;
	setTimeout(() => {
		key.position.y += 0.02;
		key.userData.dipped = false;
	}, 150);
}

/** @param {number[]} pos */
function buildPiano(pos) {
	const scene = apiRef?.scene();
	if (!scene || scene.getObjectByName(GROUP_NAME)) return;
	const group = new THREE.Group();
	group.name = GROUP_NAME;
	group.position.fromArray(pos);

	const whiteMaterial = new THREE.MeshStandardMaterial({ color: 0xf5f5f0 });
	const blackMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });
	WHITE_MIDI.forEach((midi, index) => {
		const key = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.9), whiteMaterial.clone());
		key.position.set(index * 0.24, 0.9, 0);
		key.userData.midi = midi;
		group.add(key);
	});
	Object.entries(BLACK_MIDI).forEach(([afterWhite, midi]) => {
		const key = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.55), blackMaterial.clone());
		key.position.set((+afterWhite + 0.5) * 0.24, 0.95, -0.17);
		key.userData.midi = midi;
		group.add(key);
	});
	// simple body under the keys
	const body = new THREE.Mesh(
		new THREE.BoxGeometry(7 * 0.24 + 0.1, 0.08, 1.05),
		new THREE.MeshStandardMaterial({ color: 0x5c3a21 })
	);
	body.position.set(3 * 0.24, 0.84, 0);
	group.add(body);

	scene.add(group);
	spawned = true;
}

function removePiano() {
	const scene = apiRef?.scene();
	const group = scene?.getObjectByName(GROUP_NAME);
	if (group) scene.remove(group);
	spawned = false;
}

export default {
	id: 'piano',
	name: 'Piano',
	version: '1.0.0',
	description: 'One-octave synth keyboard - every peer hears and sees your notes.',
	/** @param {any} api */
	register(api) {
		apiRef = api;

		api.registerInteractiveGroup(GROUP_NAME);

		api.registerMenu('Piano: spawn / remove', () => {
			if (spawned) {
				removePiano();
				api.send({ op: 'remove' });
			} else {
				const pos = [-1, 0, -2.5];
				buildPiano(pos);
				api.send({ op: 'spawn', pos: pos });
			}
		});

		api.registerClickHandler((object) => {
			const midi = object.userData?.midi;
			if (midi == null || object.parent?.name !== GROUP_NAME) return false;
			playNote(midi);
			pressKey(midi);
			hapticPulse(0.6, 60);
			api.send({ op: 'note', midi: midi });
			return true;
		});

		api.onMessage((data) => {
			if (data.op === 'spawn') buildPiano(data.pos);
			else if (data.op === 'remove') removePiano();
			else if (data.op === 'note') {
				playNote(data.midi);
				pressKey(data.midi);
			}
		});

		api.registerStateSync({
			getState: () => (spawned ? { pos: apiRef.scene()?.getObjectByName(GROUP_NAME)?.position.toArray() } : null),
			applyState: (state) => {
				if (state?.pos) buildPiano(state.pos);
			}
		});
	}
};
