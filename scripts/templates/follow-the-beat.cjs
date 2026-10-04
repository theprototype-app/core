// Template def `follow-the-beat` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');
const { CONTEST_JUDGING, ALL_TOGETHER } = require('./_contest.cjs');

// The track: CC0 on freesound, 72 s, and MEASURED at 120.00 BPM (onset autocorrelation,
// the "Party Retro Organ ... 120bpm" candidate read 122 despite its title, and was
// dropped). The HQ preview is the same CC0 work transcoded to mp3; the sha256 pins it.
const BEAT_TRACK = {
	url: 'https://cdn.freesound.org/previews/622/622426_2282212-hq.mp3',
	sha256: '8542ef29eb53aad159230fa8dd6cab54e6b3bedc829f9a9ecaa5758cbd80a0fb',
	name: 'szegvari - Happy Ethno Jazz Dance 120bpm (CC0).mp3',
	volume: 0.8,
	credit: {
		what: 'track',
		title: 'Happy Experimental Ethno Jazz Vocal Instruments Dance Cinematic Music 120Bpm Mastered',
		author: 'szegvari',
		license: 'CC0-1.0',
		source: 'https://freesound.org/people/szegvari/sounds/622426/'
	}
};

const BEAT_BPM = 120;
const BEAT_SECONDS = 60 / BEAT_BPM; // 0.5
// THREE bars per loop, because there are three cameras: a Sequence off one cue per loop
// cuts Wide / Dolly / Detail on bars 1 / 2 / 3 and the loop brings Wide back. (A trigger
// stamp comes only from EVENT nodes, so "counter mod 3 -> which camera" cannot be wired;
// the Sequence is the one node that fans a single pulse out in time.)
const BEAT_BARS = 3;
const BEAT_LOOP = BEAT_BARS * 4 * BEAT_SECONDS; // 6 s
// The cue sits 60 ms AFTER the downbeat, never on it: a marker at exactly t = 0 is not
// crossed on the FIRST lap (the tick has no previous head to travel from), so a cue at 0
// would give lap one no camera cuts. 60 ms is under a frame's worth of error at the cut
// and past two frames of start-up hitch; the Sequence's second delay takes it back off.
const BEAT_CUE_AT = 0.06;
function beatMarkers() {
	const markers = [];
	for (let beat = 0; beat < BEAT_BARS * 4; beat++) {
		markers.push({ t: beat * BEAT_SECONDS, name: 'beat' });
		if (beat % 4 === 0) markers.push({ t: beat * BEAT_SECONDS, name: 'bar' });
	}
	markers.push({ t: BEAT_CUE_AT, name: 'cue' });
	return markers;
}

function beatGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	// selectors — every trigger and action names its object through one
	N('selcond', 'objectselector', 'Conductor', 760, 190, { selected: 'Conductor' });
	N('selstage', 'objectselector', 'Stage', 760, 340, { selected: 'Stage' });
	N('sellight', 'objectselector', 'Beat light', 760, 640, { selected: 'Beat light' });
	N('sellamp', 'objectselector', 'Beat lamp', 760, 790, { selected: 'Beat lamp' });
	N('selpad', 'objectselector', 'Pad', 760, 940, { selected: 'Pad' });
	N('selwide', 'objectselector', 'Wide camera', 760, 40, { selected: 'Wide' });
	N('seldolly', 'objectselector', 'Dolly camera', 1000, 1160, { selected: 'Dolly' });
	N('seldetail', 'objectselector', 'Detail camera', 1000, 1400, { selected: 'Detail' });

	// ---- Start: the HUD button enters `playing`; everyone starts on Wide -----------
	N('bstart', 'hudbutton', 'Start button', 40, 40, { element: 'start-btn' });
	N('gostart', 'setgamestate', 'Start', 280, 40, { state: 'playing', outcome: '', reset: false });
	E('bstart', 'gostart', 'trigger');
	N('gcam', 'gamestart', 'Everyone starts on Wide', 520, 40, { camera: '' });
	E('selwide', 'gcam', 'camera');
	// entering `playing` restarts the clock, plays the track once and flashes the downbeat.
	// THROUGH A ZERO-SECOND DELAY, measured: On Game State (like HUD Button) has a trigger
	// STAMP but no VALUE in the evaluator, and Play Animation acts on the rising edge of
	// its resolved `trigger` VALUE — so wired straight, the clock never started while the
	// stamp-reading Sound node beside it played. A Delay is pure and value-evaluable
	// (pulseAt(stamp + 0)), which turns the stamp into the pulse Play Animation can see.
	// Recorded as a core follow-up (playanim could read the stamp like setcamera does).
	N('onplay', 'ongamestate', 'When play starts', 40, 190, { state: 'playing', edge: 'enter', pulse: 0.3 });
	N('startpulse', 'delay', 'Start pulse (0 s)', 280, 190, { seconds: 0, pulse: 0.3 });
	E('onplay', 'startpulse', 'trigger');
	N('clock', 'playanim', 'Start the beat clock', 520, 190, { clip: 'Beat clock', action: 'restart', speed: 1 });
	E('startpulse', 'clock', 'trigger');
	E('clock', 'selcond');
	// the track as a ONE-SHOT on the stage: no falloff (rolloff 0) so it is heard everywhere
	N('track', 'sound', 'Play the track', 520, 340, {
		hash: '$music', file: BEAT_TRACK.name, volume: BEAT_TRACK.volume, radius: 40, rolloff: 0, loop: false, playing: false
	});
	E('startpulse', 'track', 'trigger');
	E('track', 'selstage');
	N('downbeat', 'playanim', 'Flash on the downbeat', 520, 490, { clip: 'Flash', action: 'restart', speed: 1 });
	E('startpulse', 'downbeat', 'trigger');
	E('downbeat', 'sellight');

	// ---- every beat: the light and the lamp restart their Flash clip ----------------
	N('beat', 'animmarker', 'Every beat', 40, 640, { name: 'beat', pulse: 0.3 });
	E('beat', 'selcond');
	N('flash', 'playanim', 'Pulse the light', 280, 640, { clip: 'Flash', action: 'restart', speed: 1 });
	E('beat', 'flash', 'trigger');
	E('flash', 'sellight');
	N('lamp', 'playanim', 'Pulse the lamp', 280, 790, { clip: 'Flash', action: 'restart', speed: 1 });
	E('beat', 'lamp', 'trigger');
	E('lamp', 'sellamp');

	// ---- every bar: a burst of stars off the Pad -------------------------------------
	N('bar', 'animmarker', 'Every bar', 40, 940, { name: 'bar', pulse: 0.3 });
	E('bar', 'selcond');
	N('burst', 'particle', 'Burst on the bar', 280, 940, {
		mode: 'burst', count: 80, lifetime: 1.2, speed: 2.2, gravity: 0, turbulence: 0.4,
		sizeStart: 0.1, opacity: 0.9, sprite: 'star', blending: 'additive', space: 'world',
		colorStart: '#fffbe8', colorEnd: '#b48ead'
	});
	E('bar', 'burst', 'trigger');
	E('burst', 'selpad');

	// ---- the camera cuts: one cue per loop fans out to the three bars -----------------
	N('cue', 'animmarker', 'Cue (once per loop)', 40, 1090, { name: 'cue', pulse: 0.3 });
	E('cue', 'selcond');
	const barLen = 4 * BEAT_SECONDS;
	N('cuts', 'sequence', 'Cuts on the bars', 280, 1090, {
		delay1: 0, delay2: +(barLen - BEAT_CUE_AT).toFixed(3), delay3: barLen, delay4: 0, pulse: 0.3
	});
	E('cue', 'cuts', 'trigger');
	N('cutwide', 'setcamera', 'Bar 1: Wide', 520, 1040, { camera: '' });
	E('cuts', 'cutwide', 'trigger', 'step1');
	E('selwide', 'cutwide', 'camera');
	N('cutdolly', 'setcamera', 'Bar 2: Dolly', 520, 1160, { camera: '' });
	E('cuts', 'cutdolly', 'trigger', 'step2');
	E('seldolly', 'cutdolly', 'camera');
	// ...and the Dolly TRUCKS for its bar: its own 2 s clip, restarted on the same step
	N('truck', 'playanim', 'Truck the Dolly', 760, 1280, { clip: 'Truck', action: 'restart', speed: 1 });
	E('cuts', 'truck', 'trigger', 'step2');
	E('truck', 'seldolly');
	N('cutdetail', 'setcamera', 'Bar 3: Detail', 520, 1400, { camera: '' });
	E('cuts', 'cutdetail', 'trigger', 'step3');
	E('seldetail', 'cutdetail', 'camera');
	return g.done();
}

const BEAT_HUD_PANEL = {
	bg: 'rgba(20, 26, 36, 0.92)',
	radius: 16,
	border: '1px solid rgba(180, 142, 173, 0.35)'
};
const BEAT_DEF = {
	kind: 'contest',
	slug: 'follow-the-beat',
	title: 'Follow the beat',
	description:
		'A 120 BPM track, a Conductor whose clip marks every beat and bar, a light that pulses on the beat and three cameras that cut on the bars. Press Start, then make the scene move. ' +
		'Track: "' + BEAT_TRACK.credit.title + '" by ' + BEAT_TRACK.credit.author + ' (freesound, CC0 1.0).',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['contest', 'music', 'animation', 'cameras'],
	env: { preset: 'sunset', exposure: 1 },
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.6, luminanceThreshold: 0.8 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [3, 4, 15], target: [0, 1.6, -0.5] },
	thumb: { camera: 'Wide' },
	// `music` = the scene's track slot (playing OFF: the Start button plays it through the
	// Sound node above, so the editor stays quiet) and the bytes bundled into the .tpscene
	music: BEAT_TRACK,
	objects: [
		{ type: 'box', name: 'Stage', color: 0x2b2f36, size: [16, 0.3, 10], pos: [0, -0.15, 0], roughness: 0.9 },
		{ type: 'cylinder', name: 'Riser', color: 0x3b4252, r: 2.6, h: 0.3, pos: [0, 0.15, -0.5] },
		{ type: 'box', name: 'Backdrop', color: 0x1f2430, size: [16, 6.5, 0.3], pos: [0, 3.1, -5.2] },
		{ type: 'box', name: 'Pillar left', color: 0x434c5e, size: [0.5, 6, 0.5], pos: [-7, 3, -4.5], emissive: 0x88c0d0, emissiveIntensity: 0.35 },
		{ type: 'box', name: 'Pillar right', color: 0x434c5e, size: [0.5, 6, 0.5], pos: [7, 3, -4.5], emissive: 0x88c0d0, emissiveIntensity: 0.35 },
		// a few primitives to animate — the contest is what you do with them
		{ type: 'box', name: 'Bass', color: 0xd08770, size: [1.5, 1.5, 1.5], pos: [-3.6, 0.75, 0.2] },
		{ type: 'cylinder', name: 'Snare', color: 0xebcb8b, r: 0.7, h: 0.5, pos: [0, 0.55, 1.2] },
		{ type: 'cone', name: 'Hat', color: 0xa3be8c, r: 0.6, h: 1.2, pos: [3.6, 0.6, 0.2] },
		{ type: 'sphere', name: 'Pad', color: 0xb48ead, r: 0.9, pos: [0, 2.6, -2.6], emissive: 0x7a5a9e, emissiveIntensity: 0.5 },
		// the beat: a lamp you can see and a light that lights the stage, both pulsed
		{ type: 'sphere', name: 'Beat lamp', color: 0xfff3d6, r: 0.35, pos: [0, 4.6, 0.6], emissive: 0xffd45e, emissiveIntensity: 0.6, shadow: false },
		{ type: 'light', name: 'Beat light', kind: 'point', color: 0xffd9a0, intensity: 6, pos: [0, 4.6, 0.6] },
		// the Conductor: an EMPTY whose clip is the clock (markers, one gentle turn)
		{ type: 'empty', name: 'Conductor', pos: [0, 5.6, 0.6] },
		{ type: 'camera', name: 'Wide', pos: [0, 3.4, 13], lookAt: [0, 1.6, -0.5], fov: 45 },
		// the Dolly faces straight at the backdrop and TRUCKS left-to-right for its bar
		{ type: 'camera', name: 'Dolly', pos: [-4.5, 1.7, 6.5], lookAt: [-4.5, 1.4, -0.5], fov: 40 },
		{ type: 'camera', name: 'Detail', pos: [2.4, 1.3, 3.2], lookAt: [0, 0.6, 1.2], fov: 32 }
	],
	animations: {
		Conductor: {
			active: 'clock',
			changedAt: 0,
			clips: {
				clock: {
					name: 'Beat clock', duration: BEAT_LOOP, loop: 'loop', fps: 30,
					tracks: [{ id: 'turn', channel: 'rot.y', keys: [{ t: 0, v: 0 }, { t: BEAT_LOOP, v: 6.2832 }] }],
					markers: beatMarkers()
				}
			}
		},
		'Beat light': {
			active: 'flash',
			changedAt: 0,
			clips: {
				flash: {
					name: 'Flash', duration: 0.5, loop: 'once',
					tracks: [{ id: 'i', channel: 'light.intensity', keys: [{ t: 0, v: 60, ease: [0.2, 0.6, 0.4, 1] }, { t: 0.45, v: 6 }] }]
				}
			}
		},
		'Beat lamp': {
			active: 'flash',
			changedAt: 0,
			clips: {
				flash: {
					name: 'Flash', duration: 0.5, loop: 'once',
					tracks: [
						{ id: 'glow', channel: 'emissive', keys: [{ t: 0, v: 4 }, { t: 0.45, v: 0.6 }] },
						{ id: 'size', channel: 'scale', keys: [{ t: 0, v: 1.35 }, { t: 0.4, v: 1 }] }
					]
				}
			}
		},
		// position keys are RELATIVE to where the object is (R1): 0 -> 9 trucks 9 m right
		Dolly: {
			active: 'truck',
			changedAt: 0,
			clips: {
				truck: {
					name: 'Truck', duration: 4 * BEAT_SECONDS, loop: 'once',
					tracks: [{ id: 'x', channel: 'pos.x', keys: [{ t: 0, v: 0 }, { t: 4 * BEAT_SECONDS, v: 9 }] }]
				}
			}
		}
	},
	graphs: { scene: beatGraph() },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'menu',
					name: 'Menu',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 320, z: 0, label: '', style: BEAT_HUD_PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -105, w: 440, h: 54, z: 1, label: 'FOLLOW THE BEAT', style: { size: 38, weight: '700', color: '#ebcb8b', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -50, w: 440, h: 48, z: 1, label: 'Press Start: the track plays, the light pulses on every beat and the cameras cut on the bars. Make the scene move with it.', style: { size: 14, color: '#d8dee9', align: 'center' }, wrap: true },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: 30, w: 220, h: 48, z: 1, label: 'Start', enabled: true, style: { size: 17, weight: '600', bg: '#b48ead', color: '#1f2430', radius: 10 } },
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 105, w: 440, h: 40, z: 1, label: 'Judged in play mode from the Wide camera  ·  Esc leaves play', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'play-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 560, h: 20, z: 1, label: 'Wide · Dolly · Detail cut on the bars  ·  Esc to leave play', style: { size: 11, color: '#8b97a8', align: 'center' } }
					]
				}
			]
		}
	},
	contest: {
		brief:
			'Make the scene move with the track: animate objects to the beat, cut between cameras on ' +
			'the bars, add a look. The starter gives you the clock — a **Conductor** whose clip carries ' +
			'a marker on every beat and every bar, a light that pulses on the beat and three cameras ' +
			'that cut on the bars. Open the node editor to see how, then make it yours. Entries are ' +
			'judged in play mode from the **Wide** camera.\n\n' +
			ALL_TOGETHER,
		rules:
			'- Keep the track (it ships inside the scene, CC0).\n' +
			'- Add anything: objects, clips, cameras, a look, a HUD.\n' +
			'- The entry must play from **Start** without any other input.',
		durationDays: 14,
		opensAfterDays: 7,
		judging: CONTEST_JUDGING,
		credits: [BEAT_TRACK.credit]
	}
};

module.exports = BEAT_DEF;
