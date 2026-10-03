// Module SDK — sounds, particle bursts, the announce banner and game music.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { announce as announceBanner } from '../gameAnnounce';
import { playGameMusic, stopGameMusic, gameMusicState, MUSIC_PRESET_IDS } from '../gameMusic';
import { isGameSound, playGameSound } from '../gameSfx';
import { get } from 'svelte/store';
import { pingAudioRef, effectsRef } from './refs.js';

/** the ping chimes `api.playSound` still reaches (pingAudio's PING_SOUNDS ids) */
const PING_NAMES = new Set(['ding', 'chime', 'pluck', 'bell']);

/** @param {import('./context.js').SdkContext} ctx */
export function sdkSound(ctx) {
	const { moduleId, onDispose } = ctx;
	/** 33 (L4): api.music journals its stop once per module */
	let musicDisposeHooked = false;
	return {
		/**
		 * A sound, LOCAL to this device — broadcast your own op if peers should hear it.
		 * 30b: the GAME set (procedural, no assets, the "Game sounds" volume): 'click',
		 * 'pop', 'whoosh', 'success', 'fail', 'hit', 'kick', 'shoot', 'laser',
		 * 'explosion', 'coin', 'levelup', 'goal', 'whistle', 'cheer', 'step', 'ring',
		 * 'sparkle', 'hurt', 'portal'; plus the ping chimes 'ding' (the default),
		 * 'chime', 'pluck', 'bell'. An unknown name is a quiet no-op. `position`
		 * spatialises it. Returns whether a sound started.
		 * @param {string=} sound @param {number[]=} position @returns {boolean}
		 */
		playSound(sound = 'ding', position = undefined) {
			const name = String(sound ?? 'ding');
			if (isGameSound(name)) return playGameSound(name, position ?? null);
			if (!PING_NAMES.has(name)) return false;
			pingAudioRef?.playPing(name, position ?? null);
			return !!pingAudioRef;
		},
		/**
		 * 30b: game MUSIC — procedural loops, LOCAL to this device, tempo-synced to the
		 * session clock (two peers on one preset hear the same bar), under the effects
		 * and on the "Music" volume. Plays only in Interact/Play (a call from Edit returns
		 * false) and stops by itself when the player leaves the game.
		 * Presets: 'arcade', 'ambient', 'dungeon', 'stadium', 'space', 'puzzle', 'studio'.
		 */
		/**
		 * 30b (C6): a short, pooled particle BURST at a world position — 'sparkle' (the
		 * default), 'confetti', 'smoke' or 'sparks', an optional CSS colour and a count
		 * (1..96). LOCAL: broadcast your own op if peers should see it too. Returns
		 * whether a burst started.
		 * @param {number[]} position @param {{kind?: string, color?: string, count?: number}=} options
		 * @returns {boolean}
		 */
		effects: {
			burst: (/** @type {number[]} */ position, /** @type {{kind?: string, color?: string, count?: number}} */ options = {}) =>
				!!effectsRef?.burst?.(position, options ?? {}),
			kinds: () => ['sparkle', 'confetti', 'smoke', 'sparks']
		},
		/**
		 * 30b: a BIG centred banner — "GOAL!", "Level 3", "Ring 2 reached" — on the desktop
		 * HUD and, in a headset, head-locked in front of the player. `sub` is a second,
		 * smaller line; `ms` how long it stays (300..15000, default 1800); `color` the
		 * title's colour. A new banner replaces the one showing. LOCAL. Returns its id.
		 * @param {string} text @param {{sub?: string, ms?: number, color?: string}=} options
		 * @returns {number}
		 */
		announce(text, options = {}) {
			return announceBanner(text, options ?? {});
		},
		// 33 (L4): the track is OWNED by this module — `stop` only stops ours, the module's
		// teardown stops it ("music from waves stays" after Waves was unloaded), and a module a
		// scene switch left behind cannot start one (gameMusic + sceneScope)
		music: {
			/** @param {string} preset @param {{volume?: number}=} options 0..1 @returns {boolean} */
			play: (preset, options = {}) => {
				if (!musicDisposeHooked) {
					musicDisposeHooked = true;
					onDispose(() => stopGameMusic(moduleId), 'music');
				}
				return playGameMusic(preset, options ?? {}, moduleId);
			},
			stop: () => stopGameMusic(moduleId),
			/** the preset playing now, or null @returns {string | null} */
			current: () => get(gameMusicState)?.preset ?? null,
			presets: () => [...MUSIC_PRESET_IDS]
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkSound.surface = {
	playSound: 'action',
	'effects.burst': 'action',
	'effects.kinds': 'read',
	announce: 'action',
	'music.play': 'registers',
	'music.stop': 'action',
	'music.current': 'read',
	'music.presets': 'read'
};
