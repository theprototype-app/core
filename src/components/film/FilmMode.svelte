<script>
	// 68 V1-V3: the Film mode overlay — the phone is the viewfinder. Mounted by App.svelte only while
	// `filmOpen` is set (a lazy chunk, so the boot carries none of it). The 3D view itself is the
	// #viewport region, RESIZED to the shot's letterbox (html.film-mode + --film-* vars): the camera
	// then renders at exactly the shot's aspect, so what you see is the frame you record. Every other
	// piece of chrome is hidden while filming (visibility, so nothing reflows), toasts excepted.
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import { filmOpen, closeFilm } from '$lib/film/filmState';
	import {
		film,
		startFilm,
		stopFilm,
		enableMotion,
		setStick,
		setLift,
		lookDrag,
		recentre,
		toggleHorizonLock,
		cycleSpeed,
		setFov,
		setRoll,
		setSmoothing,
		setAperture,
		pullFocus,
		setRig,
		pickAt,
		onFilmFrame,
		filmPose,
		placeCamera,
		setHeightLock,
		setMotion,
		setPreviewing
	} from '$lib/film/filmMode';
	import { walk, walkEntry, startWalk, stopWalk, setWalkScale, recentreWalk, teleportWalk, setPassthrough, setWalkHooks } from '$lib/film/filmWalk';
	import { worldRig } from '../../stores/sceneStore';
	import * as THREE from 'three';
	import { stickValue, formatTake, LENS_PRESETS, focalForFov, fovForFocal, pinchFov, snapToLens, rollOf, motionOptions, effectiveMotion, defaultMotion, motionLabel, WALK_SCALE_CHIPS, PASSTHROUGH } from '$lib/film/filmCore';
	import { take, record, pause, resume, finishTake, retake, closeRecorder, recorderDebug, addMarker, writeShots, beginShotsGesture, endShotsGesture, afterShotPreview } from '$lib/film/filmRecorder';
	import { thumbUrl } from '$lib/film/filmThumb';
	import { scrubSequence } from '$lib/sequencePlayer';
	import { showToast } from '../../stores/appStore';
	import { safeStorage } from '$lib/safeStorage';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { rolesInfo } from '$lib/cloudHooks';
	import { isViewer } from '$lib/objectPermissions';
	import { openTimeline } from '$lib/timelineOpen';
	import { recordingOpen, setRecordingPrefs, exportJob } from '$lib/recording/recordingStores.js';
	import { tipShown, dismissTip, TIP_FILM } from '$lib/tips.js';
	import { MIN_DURATION, MAX_DURATION } from '$lib/recording/recordingCore.js';
	import { filmShots, shotKind, shotName, renameShot, trimShot, deleteShot, restoreShot, exportPlanFor, exportLabel } from '$lib/film/filmTake';
	import { sequences, activeSequence } from '$lib/sequences';
	import { registerDebugHook } from '$lib/debugHooks';
	import { aspectRatio, listCameraObjects, setCameraFromView } from '$lib/cameraObjects';
	import { objectsGroup, selectedObject } from '../../stores/sceneStore';

	let vw = $state(typeof window !== 'undefined' ? window.innerWidth : 0);
	let vh = $state(typeof window !== 'undefined' ? window.innerHeight : 0);

	// the shot's box inside the window ('free' = the whole window)
	const box = $derived.by(() => {
		// walking, the XR view fills the screen (the runtime owns the projection)
		const ratio = $film && !$film.walk ? aspectRatio($film.aspect) : 0;
		if (!vw || !vh || !ratio) return { l: 0, t: 0, w: vw, h: vh };
		if (vw / vh > ratio) {
			const w = Math.round(vh * ratio);
			return { l: Math.round((vw - w) / 2), t: 0, w, h: vh };
		}
		const h = Math.round(vw / ratio);
		return { l: 0, t: Math.round((vh - h) / 2), w: vw, h };
	});

	$effect(() => {
		const root = document.documentElement;
		if (!$film) {
			root.classList.remove('film-mode');
			return;
		}
		root.classList.add('film-mode');
		root.style.setProperty('--film-l', box.l + 'px');
		root.style.setProperty('--film-t', box.t + 'px');
		root.style.setProperty('--film-w', box.w + 'px');
		root.style.setProperty('--film-h', box.h + 'px');
	});

	// ---- the camera picker (Film opened without a camera) ----
	const cameras = $derived.by(() => {
		void $objectsGroup;
		return listCameraObjects().map((o) => ({ uuid: o.uuid, name: o.name || 'Camera' }));
	});

	/** @param {string} uuid */
	function pick(uuid) {
		filmOpen.set({ uuid });
		if (!startFilm(uuid)) closeFilm();
	}

	async function newCamera() {
		const { sceneCommand } = await import('$lib/commandsHandler.svelte');
		sceneCommand('/create Camera');
		const object = /** @type {any} */ (get(selectedObject));
		if (!object?.userData?.camera) return;
		setCameraFromView(object.uuid);
		pick(object.uuid);
	}

	/** keep a pointer's moves on the control it pressed (a pointer id the page cannot capture is fine) @param {PointerEvent} e */
	function capture(e) {
		try {
			/** @type {any} */ (e.currentTarget).setPointerCapture?.(e.pointerId);
		} catch {
			/* a synthetic or already-gone pointer */
		}
	}

	// ---- thumbstick ----
	let stickEl = $state(/** @type {HTMLElement | null} */ (null));
	let knob = $state({ x: 0, y: 0 });
	/** @type {number | null} */
	let stickPointer = null;

	/** @param {PointerEvent} e */
	function stickMove(e) {
		if (!stickEl || e.pointerId !== stickPointer) return;
		const r = stickEl.getBoundingClientRect();
		const radius = r.width / 2;
		let dx = e.clientX - (r.left + radius);
		let dy = e.clientY - (r.top + radius);
		const m = Math.hypot(dx, dy);
		if (m > radius) {
			dx = (dx / m) * radius;
			dy = (dy / m) * radius;
		}
		knob = { x: dx, y: dy };
		const v = stickValue(dx, dy, radius);
		setStick(v.x, v.y);
	}
	/** @param {PointerEvent} e */
	function stickDown(e) {
		stickPointer = e.pointerId;
		capture(e);
		stickMove(e);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function stickUp(e) {
		if (e.pointerId !== stickPointer) return;
		stickPointer = null;
		knob = { x: 0, y: 0 };
		setStick(0, 0);
	}

	/** hold-to-fly buttons @param {number} v */
	const liftDown = (v) => (/** @type {PointerEvent} */ e) => {
		capture(e);
		setLift(v);
		e.preventDefault();
	};
	const liftUp = () => setLift(0);

	// ---- drag to look (the viewfinder surface) ----
	// one finger turns (grab the world), two pinch the zoom, a short still tap focuses / picks
	/** @type {Map<number, {x: number, y: number}>} */
	const looks = new Map();
	/** @type {{dist: number, fov: number} | null} */
	let pinch = null;
	/** @type {{id: number, x: number, y: number, at: number, moved: boolean} | null} */
	let tap = null;
	const spread = () => {
		const [a, b] = [...looks.values()];
		return Math.hypot(a.x - b.x, a.y - b.y) || 1;
	};
	/** @param {PointerEvent} e */
	function lookDown(e) {
		looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
		capture(e);
		tap = looks.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), moved: false } : null;
		if (looks.size === 2) pinch = { dist: spread(), fov: $film?.fov ?? 50 };
	}
	/** @param {PointerEvent} e */
	function lookMove(e) {
		const last = looks.get(e.pointerId);
		if (!last) return;
		looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap.moved = true;
		if (looks.size === 2 && pinch) {
			setFov(pinchFov(pinch.fov, spread() / pinch.dist, zoomSpeed));
			return;
		}
		if (looks.size !== 1 || pinch) return;
		lookDrag(e.clientX - last.x, e.clientY - last.y, box.h || vh);
	}
	/** @param {PointerEvent} e */
	function lookUp(e) {
		looks.delete(e.pointerId);
		if (pinch && looks.size < 2) {
			if ($film) setFov(snapToLens($film.fov));
			if (!looks.size) pinch = null;
		}
		if (tap && tap.id === e.pointerId && !tap.moved && performance.now() - tap.at < 350 && e.type === 'pointerup') onTap(e.clientX, e.clientY);
		tap = null;
	}

	// ---- tap: track a target (armed) or pull focus ----
	/** 'track' = the next tap picks what to follow @type {'' | 'track'} */
	let armed = $state('');
	/** @type {{x: number, y: number, at: number, label: string} | null} */
	let focusMark = $state(null);
	/** @param {number} cx @param {number} cy */
	function onTap(cx, cy) {
		if (!$film) return;
		const x = ((cx - box.l) / (box.w || 1)) * 2 - 1;
		const y = -(((cy - box.t) / (box.h || 1)) * 2 - 1);
		if (Math.abs(x) > 1 || Math.abs(y) > 1) return;
		const hit = pickAt(x, y);
		if (armed === 'track') {
			armed = '';
			if (hit && setRig('track', hit.uuid)) focusMark = { x: cx, y: cy, at: Date.now(), label: `Following ${hit.name}` };
			return;
		}
		if ($film.aperture === null || !hit) return;
		pullFocus(hit.distance);
		focusMark = { x: cx, y: cy, at: Date.now(), label: `${hit.distance.toFixed(1)} m` };
		const at = focusMark.at;
		setTimeout(() => {
			if (focusMark?.at === at) focusMark = null;
		}, 1200);
	}

	// ---- zoom rail (right edge): log focal length 14-200 mm, drag up = longer lens ----
	const FOCAL_MIN = 14;
	const FOCAL_MAX = 200;
	const focal = $derived($film ? focalForFov($film.fov) : 50);
	const railPos = $derived(Math.log(focal / FOCAL_MIN) / Math.log(FOCAL_MAX / FOCAL_MIN));
	let railEl = $state(/** @type {HTMLElement | null} */ (null));
	/** @type {number | null} */
	let railPointer = null;
	/** @param {PointerEvent} e */
	function railMove(e) {
		if (!railEl || e.pointerId !== railPointer) return;
		const r = railEl.getBoundingClientRect();
		const f = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / (r.height || 1)));
		setFov(fovForFocal(FOCAL_MIN * Math.pow(FOCAL_MAX / FOCAL_MIN, f)));
	}
	/** @param {PointerEvent} e */
	function railDown(e) {
		railPointer = e.pointerId;
		capture(e);
		railMove(e);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function railUp(e) {
		if (e.pointerId !== railPointer) return;
		railPointer = null;
		if ($film) setFov(snapToLens($film.fov));
	}
	/** @param {KeyboardEvent} e */
	function railKey(e) {
		if (!$film || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
		e.preventDefault();
		setFov(fovForFocal(focal * (e.key === 'ArrowUp' ? 1.05 : 1 / 1.05)));
	}

	// ---- the settings sheet + local prefs ----
	let settingsOpen = $state(false);
	/** @param {string} key @param {any} fallback */
	function pref(key, fallback) {
		try {
			const raw = safeStorage.getItem(key);
			return raw === null ? fallback : JSON.parse(raw);
		} catch {
			return fallback;
		}
	}
	let overlays = $state(pref('film:overlays', { thirds: false, safe: false, level: true }));
	let mask = $state(/** @type {string} */ (pref('film:mask', 'none')));
	let countdownOn = $state(!!pref('film:countdown', false));
	let zoomSpeed = $state(Number(pref('film:zoomSpeed', 1)) || 1);
	$effect(() => {
		safeStorage.setItem('film:overlays', JSON.stringify(overlays));
		safeStorage.setItem('film:mask', JSON.stringify(mask));
		safeStorage.setItem('film:countdown', JSON.stringify(countdownOn));
		safeStorage.setItem('film:zoomSpeed', JSON.stringify(zoomSpeed));
	});
	const MASKS = [
		{ key: 'none', label: 'Off', ratio: 0 },
		{ key: '16:9', label: '16:9', ratio: 16 / 9 },
		{ key: '9:16', label: '9:16', ratio: 9 / 16 },
		{ key: '2.39:1', label: '2.39:1', ratio: 2.39 }
	];
	// the mask's frame inside the shot box (a guide: the take itself keeps the camera's aspect)
	const maskBox = $derived.by(() => {
		const ratio = MASKS.find((m) => m.key === mask)?.ratio ?? 0;
		if (!ratio || !box.w || !box.h) return null;
		if (box.w / box.h > ratio) {
			const w = box.h * ratio;
			return { l: (box.w - w) / 2, t: 0, w, h: box.h };
		}
		const h = box.w / ratio;
		return { l: 0, t: (box.h - h) / 2, w: box.w, h };
	});
	const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
	const stopIndex = $derived.by(() => {
		const a = $film?.aperture ?? 2.8;
		let best = 0;
		F_STOPS.forEach((f, i) => {
			if (Math.abs(f - a) < Math.abs(F_STOPS[best] - a)) best = i;
		});
		return best;
	});
	/** @param {'handheld'|'tripod'|'track'} rig */
	function chooseRig(rig) {
		if (rig === 'track') {
			armed = 'track';
			settingsOpen = false;
			return;
		}
		armed = '';
		// fix-film: Tripod is a motion mode (the picker's) — the rig row is the same switch
		if (rig === 'tripod') setMotion('tripod');
		else if ($film?.rig === 'tripod') setMotion(handheldMotion());
		else setRig(rig);
	}

	// ---- level bubble, slow-frame (heat) + battery hints: sampled from the frame hook ----
	let level = $state(0);
	let slow = $state(false);
	let lowBattery = $state(false);
	let frameEma = 1 / 60;
	let slowSince = 0;
	let lastLevelAt = 0;
	/** @type {(() => void) | null} */
	let unFrame = null;
	/** @param {any} pose @param {number} dt */
	function sampleFrame(pose, dt) {
		if (dt > 0) frameEma += (Math.min(dt, 0.25) - frameEma) * 0.05;
		const now = performance.now();
		if (now - lastLevelAt < 100) return;
		lastLevelAt = now;
		level = rollOf(pose.q);
		if (mapOpen && now - lastMapAt > 200) {
			lastMapAt = now;
			drawMap(pose);
		}
		// sustained under ~24 fps: the phone is throttling (hot) or overloaded
		if (frameEma > 1 / 24) {
			if (!slowSince) slowSince = now;
			if (now - slowSince > 5000) slow = true;
		} else {
			slowSince = 0;
			slow = false;
		}
	}
	async function watchBattery() {
		try {
			const battery = await /** @type {any} */ (navigator).getBattery?.();
			if (!battery) return;
			const update = () => (lowBattery = battery.level <= 0.15 && !battery.charging);
			update();
			battery.addEventListener('levelchange', update);
			battery.addEventListener('chargingchange', update);
		} catch {
			/* no battery API (iOS, desktop Firefox) */
		}
	}

	// ---- 3-2-1 countdown (+ haptics) ----
	let countdown = $state(0);
	/** @type {ReturnType<typeof setTimeout> | null} */
	let countdownTimer = null;
	function buzz(/** @type {number} */ ms) {
		try {
			navigator.vibrate?.(ms);
		} catch {
			/* no haptics */
		}
	}
	/** @param {() => any} go */
	function withCountdown(go) {
		if (!countdownOn) {
			buzz(20);
			go();
			return;
		}
		countdown = 3;
		buzz(30);
		const step = () => {
			countdown -= 1;
			if (countdown > 0) {
				buzz(30);
				countdownTimer = setTimeout(step, 1000);
			} else {
				countdownTimer = null;
				buzz(80);
				go();
			}
		};
		countdownTimer = setTimeout(step, 1000);
	}
	function cancelCountdown() {
		if (countdownTimer) clearTimeout(countdownTimer);
		countdownTimer = null;
		countdown = 0;
	}

	// ---- V3 walk ("Track my movement") + the mini-map ----
	function onRecentre() {
		if ($walk.on) recentreWalk();
		else recentre();
	}
	const WALK_LOG = { min: Math.log10(0.1), max: Math.log10(20) };

	// ---- fix-film: the motion picker (the pill names the mode in effect; the choice is remembered) ----
	let keyboardSeen = $state(false);
	const finePointer = typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: fine)').matches;
	const touchScreen = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
	/** true = a motion sensor delivers, false = none here, null = not known yet */
	const gyro = $derived(!$film ? null : $film.sensor === 'gyro' ? true : $film.sensor === 'touch' || $film.sensor === 'denied' ? false : null);
	const motionCtx = $derived({ gyro, walking: $walk.on || $walk.starting, keyboard: finePointer || keyboardSeen, touch: touchScreen });
	const chosenMotion = $derived($film?.motion || defaultMotion({ touch: touchScreen }));
	const motion = $derived(effectiveMotion(chosenMotion, motionCtx));
	const motionPill = $derived(
		$film?.sensor === 'starting' && motion === 'tilt'
			? motionLabel('tilt', { starting: true })
			: motionLabel(motion, { waiting: chosenMotion === 'walk' && !motionCtx.walking })
	);
	const motionChoices = $derived(motionOptions({ touch: touchScreen, gyro, ar: $walkEntry, keyboard: motionCtx.keyboard }));
	/** @type {Record<string, string>} */
	const MOTION_ICONS = { tilt: 'smartphone', touch: 'hand', walk: 'footprints', tripod: 'camera', keys: 'keyboard' };
	let motionOpen = $state(false);
	/** @param {string} key */
	function chooseMotion(key) {
		if (key === 'walk') {
			setMotion('walk');
			// the AR session must start inside this press (requestSession needs the user activation)
			if (!$walk.on && !$walk.starting) {
				const p = filmPose();
				startWalk({ pos: p.pos, q: p.qBase });
			}
			motionOpen = false;
			return;
		}
		if ($walk.on || $walk.starting) stopWalk();
		setMotion(key);
		motionOpen = false;
	}
	/** the handheld mode a Tripod / walk falls back to: the sensor when there is one */
	const handheldMotion = () => (gyro === false ? (touchScreen || !motionCtx.keyboard ? 'touch' : 'keys') : 'tilt');
	let scalePop = $state(false);
	// a failed start, lost tracking, or the system ending AR: pause the take at a Mark, say why, carry
	// on with the stick (never a broken view) — this time only (the remembered choice stays Walk)
	const FALLBACK_WHY = { denied: 'AR was not allowed', failed: 'Walk could not start AR', lost: 'Tracking was lost', ended: 'AR stopped' };
	setWalkHooks({
		recording: () => get(take).state === 'recording',
		fallback: (why, recording) => {
			if (recording) {
				addMarker();
				pause();
			}
			scalePop = false;
			setMotion(handheldMotion(), { remember: false });
			showToast(`${FALLBACK_WHY[why] ?? 'Walking stopped'}${recording ? ' — the take paused at a mark' : ''}. Filming with the thumbstick now.`, [
				{ label: 'Recentre', action: () => recentre() }
			]);
		}
	});

	// ---- fix-film: first-use help (3 cards) ----
	let helpOpen = $state(safeStorage.getItem('film:help') !== 'seen');
	let helpStep = $state(0);
	const HELP_CARDS = [
		{ key: 'look', title: 'Look', icon: 'smartphone' },
		{ key: 'move', title: 'Move', icon: 'move-3d' },
		{ key: 'record', title: 'Record and cut', icon: 'clapperboard' }
	];
	/** close the cards; `never` = Don't show again (closing after the last card counts as seen too) @param {boolean} never */
	function closeHelp(never) {
		if (never || helpStep >= HELP_CARDS.length - 1) safeStorage.setItem('film:help', 'seen');
		helpOpen = false;
		helpStep = 0;
		if ($filmTip) dismissTip(TIP_FILM);
	}

	let mapOpen = $state(false);
	let mapEl = $state(/** @type {HTMLCanvasElement | null} */ (null));
	/** the map's world square (content frame): centre x/z and half size */
	let mapView = { x: 0, z: 0, half: 10 };
	let lastMapAt = 0;
	const MAP_PX = 160;
	/** @param {any} pose */
	function drawMap(pose) {
		const canvas = mapEl;
		const ctx = canvas?.getContext('2d');
		if (!canvas || !ctx) return;
		const group = /** @type {any} */ (get(objectsGroup));
		const rig = /** @type {any} */ (get(worldRig));
		const inv = rig ? rig.matrixWorld.clone().invert() : null;
		/** @type {{x: number, z: number}[]} */
		const dots = [];
		let far = 8;
		for (const o of group?.children ?? []) {
			if (!o.visible || o.userData?.camera) continue;
			const v = o.getWorldPosition(new THREE.Vector3());
			if (inv) v.applyMatrix4(inv);
			dots.push({ x: v.x, z: v.z });
			far = Math.max(far, Math.hypot(v.x - pose.pos[0], v.z - pose.pos[2]));
		}
		const half = Math.min(250, far * 1.15);
		mapView = { x: pose.pos[0], z: pose.pos[2], half };
		const k = MAP_PX / (2 * half);
		const css = getComputedStyle(canvas);
		ctx.clearRect(0, 0, MAP_PX, MAP_PX);
		ctx.fillStyle = css.getPropertyValue('--film-glass').trim() || 'black';
		ctx.fillRect(0, 0, MAP_PX, MAP_PX);
		ctx.fillStyle = css.getPropertyValue('--film-knob').trim() || 'white';
		for (const d of dots) {
			const x = (d.x - mapView.x) * k + MAP_PX / 2;
			const y = (d.z - mapView.z) * k + MAP_PX / 2;
			ctx.fillRect(x - 2, y - 2, 4, 4);
		}
		// the camera: a wedge along its heading (canvas +y is world +z)
		const [qx, qy, qz, qw] = pose.qBase;
		const fx = -(2 * (qx * qz + qw * qy));
		const fz = -(1 - 2 * (qx * qx + qy * qy));
		const a = Math.atan2(fz, fx);
		ctx.fillStyle = css.getPropertyValue('--film-rec').trim() || 'red';
		ctx.beginPath();
		ctx.moveTo(MAP_PX / 2, MAP_PX / 2);
		ctx.arc(MAP_PX / 2, MAP_PX / 2, 14, a - 0.45, a + 0.45);
		ctx.closePath();
		ctx.fill();
	}
	/** @param {PointerEvent} e */
	function mapTap(e) {
		if (!mapEl) return;
		const r = mapEl.getBoundingClientRect();
		const k = (2 * mapView.half) / r.width;
		const x = mapView.x + (e.clientX - r.left - r.width / 2) * k;
		const z = mapView.z + (e.clientY - r.top - r.height / 2) * k;
		const y = filmPose().pos[1];
		if (!($walk.on && teleportWalk([x, y, z]))) placeCamera([x, y, z]);
		buzz(15);
	}

	// ---- keys (desktop testing, a Bluetooth keyboard): WASD + E/Q, R recentre, Esc exits ----
	/** @type {Set<string>} */
	const held = new Set();
	function keyStick() {
		const x = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
		const y = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
		if (stickPointer === null) setStick(x, y);
		setLift((held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0));
	}
	const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ']);
	const SHUTTER_KEYS = new Set([' ', 'Enter', 'AudioVolumeUp', 'AudioVolumeDown', 'MediaPlayPause', 'Camera']);
	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (!$film) return;
		if (e.type === 'keydown' && !keyboardSeen && MOVE_KEYS.has(e.code)) keyboardSeen = true;
		const t = /** @type {any} */ (e.target);
		if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
		if (e.type === 'keydown' && e.code === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			closeFilm();
			return;
		}
		// a Bluetooth shutter (it sends a volume key or Enter) or Space: ● / ❚❚
		// (Space / Enter on a focused control stay that control's: keyboard users press buttons with them)
		const onControl = (e.key === ' ' || e.key === 'Enter') && !!t?.closest?.('button, [role="slider"], .film-sheet');
		if (e.type === 'keydown' && SHUTTER_KEYS.has(e.key) && !onControl && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			e.stopPropagation();
			if (!e.repeat && !viewer) onRecord();
			return;
		}
		if (e.type === 'keydown' && e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
			addMarker();
			e.stopPropagation();
			return;
		}
		if (e.type === 'keydown' && e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
			onRecentre();
			e.stopPropagation();
			return;
		}
		if (!MOVE_KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.type === 'keydown') held.add(e.code);
		else held.delete(e.code);
		keyStick();
		e.stopPropagation(); // the editor's own WASD must not also fly the (hidden) editor camera
	}

	onMount(() => {
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('keyup', onKey, true);
		const uuid = get(filmOpen)?.uuid;
		if (uuid && !startFilm(uuid)) closeFilm();
		unFrame = onFilmFrame(sampleFrame);
		void watchBattery();
	});

	// Film ended under us (the camera was deleted, the preview moved away): close the overlay
	let started = false;
	$effect(() => {
		if ($film) started = true;
		else if (started) closeFilm();
	});

	onDestroy(() => {
		if (typeof window === 'undefined') return;
		stopWalk();
		endPreview();
		setWalkHooks({ recording: () => false, fallback: () => {} });
		window.removeEventListener('keydown', onKey, true);
		window.removeEventListener('keyup', onKey, true);
		cancelCountdown();
		unFrame?.();
		void closeRecorder();
		stopFilm();
		document.documentElement.classList.remove('film-mode');
	});

	registerDebugHook('filmRecorder', { take, record, pause, resume, finishTake, retake, recorderDebug });

	// ---- the take ----
	// V7: recording writes the Timeline, so it is an editor's act; a viewer films (peers see it) only
	const viewer = $derived.by(() => {
		void $rolesInfo;
		return isViewer();
	});
	let shotsOpen = $state(false);
	/** V6: hand the take to the Timeline — fix-film: on one shot's row, at that shot's range @param {any} [shot] */
	async function editInTimeline(shot) {
		const seq = shotsSeqId;
		endPreview();
		await finishTake();
		closeFilm();
		void openTimeline(seq || undefined, shot ? { t0: shot.t, t1: shot.t + shot.dur, item: shot.id } : undefined);
	}
	/** 68: the first-use how-to, until the first take (or its ✕) */
	const filmTip = tipShown(TIP_FILM);
	$effect(() => {
		if ($take.state === 'recording' && $filmTip) dismissTip(TIP_FILM);
	});
	// ---- fix-film: the shots sheet ----
	/** the sequence whose shots this camera has: the take's, else the Timeline's own */
	/** @type {string} */
	const shotsSeqId = $derived($take.seq ?? $activeSequence ?? '');
	/** @type {any[]} */
	const shots = $derived.by(() => {
		const seq = shotsSeqId ? $sequences[shotsSeqId] : null;
		return seq && $film ? filmShots(seq, $film.uuid) : [];
	});
	/** ticked rows (export) @type {string[]} */
	let picked = $state([]);
	$effect(() => {
		const ids = new Set(shots.map((s) => s.id));
		if (picked.some((id) => !ids.has(id))) picked = picked.filter((id) => ids.has(id));
	});
	/** @param {string} id */
	function togglePick(id) {
		picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
	}
	/** hash -> object URL, read from the Library once per thumbnail @type {Record<string, string>} */
	let thumbs = $state({});
	$effect(() => {
		for (const s of shots) {
			const hash = s.thumb;
			if (!hash || hash in thumbs) continue;
			thumbs = { ...thumbs, [hash]: '' };
			void thumbUrl(hash).then((url) => (thumbs = { ...thumbs, [hash]: url }));
		}
	});
	/** the row whose actions are open @type {string} */
	let menuFor = $state('');
	/** the row being renamed @type {string} */
	let renaming = $state('');
	/** @param {any} s @param {string} name */
	function commitRename(s, name) {
		renaming = '';
		const seq = shotsSeqId ? get(sequences)[shotsSeqId] : null;
		if (seq && $film) writeShots(shotsSeqId, renameShot(seq, $film.uuid, s.id, name));
	}
	/** @param {any} s @param {number} i */
	function onDeleteShot(s, i) {
		const id = shotsSeqId;
		const seq = id ? get(sequences)[id] : null;
		const uuid = $film?.uuid;
		if (!seq || !uuid) return;
		const r = deleteShot(seq, uuid, s.id);
		menuFor = '';
		if (!r || !writeShots(id, r.seq)) return;
		showToast(`Deleted ${shotName(s, i)}`, [
			{
				label: 'Undo',
				action: () => {
					const now = get(sequences)[id];
					if (now) writeShots(id, restoreShot(now, uuid, r.removed));
				}
			}
		]);
	}

	// preview / trim one shot in the viewfinder (the camera follows the RECORDED track)
	/** @type {{id: string, name: string, t: number, t0: number, t1: number, playing: boolean, trim: boolean, recT: number, recEnd: number} | null} */
	let preview = $state(null);
	let previewRaf = 0;
	/** @param {any} s @param {number} i @param {boolean} [trim] */
	function startPreview(s, i, trim = false) {
		if (!shotsSeqId || $take.state === 'recording') return;
		shotsOpen = false;
		menuFor = '';
		setPreviewing(true);
		const recT = Number.isFinite(s.recT) ? s.recT : s.t;
		const recEnd = Number.isFinite(s.recDur) ? recT + s.recDur : s.t + s.dur;
		preview = { id: s.id, name: shotName(s, i), t: s.t, t0: s.t, t1: s.t + s.dur, playing: false, trim, recT, recEnd };
		scrubSequence(shotsSeqId, s.t);
	}
	/** @param {number} t */
	function scrubPreview(t) {
		if (!preview || !shotsSeqId) return;
		preview.t = Math.min(preview.t1, Math.max(preview.t0, t));
		scrubSequence(shotsSeqId, preview.t);
	}
	function togglePlay() {
		if (!preview) return;
		if (preview.playing) {
			preview.playing = false;
			cancelAnimationFrame(previewRaf);
			return;
		}
		if (preview.t >= preview.t1 - 1e-3) preview.t = preview.t0;
		preview.playing = true;
		let last = performance.now();
		const step = (/** @type {number} */ now) => {
			if (!preview?.playing) return;
			const t = preview.t + (now - last) / 1000;
			last = now;
			scrubPreview(t);
			if (t >= preview.t1) preview.playing = false;
			else previewRaf = requestAnimationFrame(step);
		};
		previewRaf = requestAnimationFrame(step);
	}
	/** a trim handle moved: the shot's in / out (one undo step per drag) @param {'in'|'out'} which @param {number} v */
	function trimTo(which, v) {
		if (!preview || !shotsSeqId || !$film) return;
		const seq = get(sequences)[shotsSeqId];
		if (!seq) return;
		const a = which === 'in' ? v : preview.t0;
		const b = which === 'out' ? v : preview.t1;
		const next = trimShot(seq, $film.uuid, preview.id, a, b);
		if (!next || !writeShots(shotsSeqId, next)) return;
		const it = filmShots(next, $film.uuid).find((/** @type {any} */ x) => x.id === preview?.id);
		if (!it) return;
		preview.t0 = it.t;
		preview.t1 = it.t + it.dur;
		scrubPreview(which === 'in' ? preview.t0 : preview.t1);
	}
	function endPreview() {
		if (!preview) return;
		cancelAnimationFrame(previewRaf);
		if (shotsSeqId) endShotsGesture(shotsSeqId);
		preview = null;
		setPreviewing(false);
		afterShotPreview();
	}

	// export: every shot, or the ticked ones — one video joined in recorded order, or one file each
	let exportAsk = $state(false);
	const exportBtn = $derived(exportLabel(shots.length, picked.length));
	function onExport() {
		const plan = exportPlanFor(shots, picked, true);
		if (!plan.count) return;
		if (plan.count === 1) return void exportShots(true);
		exportAsk = true;
	}
	/** 68 V9 Share as video, fix-film: only the chosen shots @param {boolean} joined */
	async function exportShots(joined) {
		exportAsk = false;
		const id = shotsSeqId;
		const plan = exportPlanFor(shots, picked, joined);
		endPreview();
		await finishTake();
		const seq = id ? get(sequences)[id] : null;
		closeFilm();
		if (!seq || !plan.count) return;
		const first = plan.queue[0] ?? [];
		const seconds = first.reduce((n, r) => n + (r[1] - r[0]), 0);
		exportJob.set({
			sequence: seq.id,
			queue: plan.queue,
			joined,
			total: plan.count,
			done: 0,
			label: plan.count === 1 ? '1 shot' : joined ? `${plan.count} shots joined (${plan.seconds.toFixed(1)} s)` : `${plan.count} shots, one file each`
		});
		setRecordingPrefs({ mode: 'timeline', sequence: seq.id, format: 'mp4', duration: Math.min(MAX_DURATION, Math.max(MIN_DURATION, seconds || MIN_DURATION)) });
		recordingOpen.set(true);
	}
	function onRecord() {
		if (countdown) return cancelCountdown();
		if ($take.state === 'recording') pause();
		else if ($take.state === 'paused') record();
		else withCountdown(record);
	}
	/** @param {'cut'|'move'} mode */
	function onResume(mode) {
		take.update((t) => ({ ...t, choosing: false }));
		withCountdown(() => resume(mode));
	}
	/** @param {string} id */
	function onRetake(id) {
		shotsOpen = false;
		menuFor = '';
		endPreview();
		void retake(id);
	}

</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

<div id="film-root" class="film-root tp-ui" data-sensor={$film?.sensor ?? 'none'}>
	{#if !$film}
		<div class="film-picker" use:minimalScroll role="dialog" aria-modal="true" aria-labelledby="film-picker-title">
			<h2 id="film-picker-title">Film with your phone</h2>
			<p class="film-picker-desc">Pick the camera to film through. Turn the phone to look around, the stick to move.</p>
			<div class="film-picker-list">
				{#each cameras as cam (cam.uuid)}
					<button class="film-pick-cam" data-uuid={cam.uuid} onclick={() => pick(cam.uuid)}>
						<Icon name="camera" size={20} />{cam.name}
					</button>
				{/each}
				<button id="film-new-camera" class="film-pick-cam film-pick-new" onclick={newCamera}>
					<Icon name="plus" size={20} />New camera here
				</button>
			</div>
			<button id="film-cancel" class="film-btn film-text" onclick={() => closeFilm()}>Cancel</button>
		</div>
	{:else}
		<!-- the look surface: everything the controls do not cover -->
		<div
			id="film-look"
			class="film-look"
			role="presentation"
			onpointerdown={lookDown}
			onpointermove={lookMove}
			onpointerup={lookUp}
			onpointercancel={lookUp}
		></div>

		<!-- guides inside the shot (never recorded): thirds, safe areas, aspect mask, level -->
		<div id="film-frame" class="film-frame" style="left:{box.l}px;top:{box.t}px;width:{box.w}px;height:{box.h}px" aria-hidden="true">
			{#if maskBox}
				<div
					id="film-mask"
					class="film-mask"
					data-mask={mask}
					style="left:{maskBox.l}px;top:{maskBox.t}px;width:{maskBox.w}px;height:{maskBox.h}px"
				></div>
			{/if}
			{#if overlays.thirds}
				<div id="film-thirds" class="film-thirds"><i></i><i></i><i></i><i></i></div>
			{/if}
			{#if overlays.safe}
				<div id="film-safe" class="film-safe"><i></i></div>
			{/if}
			{#if overlays.level}
				<div id="film-level" class="film-level" class:level={Math.abs(level) < 1} data-roll={level.toFixed(1)}>
					<span style="transform: rotate({level}deg)"></span>
				</div>
			{/if}
		</div>
		{#if focusMark}
			<div id="film-focus-mark" class="film-focus-mark" style="left:{focusMark.x}px;top:{focusMark.y}px">
				<span class="film-chip">{focusMark.label}</span>
			</div>
		{/if}
		{#if countdown}
			<div id="film-countdown-num" class="film-countdown" aria-live="assertive">{countdown}</div>
		{/if}
		<div class="film-hints">
			{#if $walk.on || $walk.starting}
				<span class="film-walk-group">
					<button
						id="film-walk-chip"
						class="film-chip"
						data-tracking={$walk.tracking}
						aria-expanded={scalePop}
						title="Walking scale: 1 m walked = this many metres in the scene"
						onclick={() => (scalePop = !scalePop)}
						>{$walk.starting ? 'Starting AR…' : $walk.lost > 0 ? 'Hold still — finding the room…' : $walk.tracking ? `Walking ×${$walk.scale}` : 'Finding the room…'}</button
					><button id="film-walk-stop" class="film-chip film-chip-x" title="Stop walking" aria-label="Stop walking" onclick={() => stopWalk()}>✕</button>
				</span>
				{#if scalePop}
					<span id="film-walk-scale-pop" class="film-walk-group" role="group" aria-label="Walking scale">
						{#each WALK_SCALE_CHIPS as k (k)}
							<button
								class="film-chip film-scale"
								data-scale={k}
								aria-pressed={$walk.scale === k}
								onclick={() => {
									setWalkScale(k);
									scalePop = false;
								}}>×{k}</button
							>
						{/each}
					</span>
				{/if}
			{/if}
			{#if armed === 'track'}
				<span id="film-track-hint" class="film-chip film-chip-ask">Tap what to follow</span>
			{:else if $film.rig === 'track'}
				<button id="film-track-chip" class="film-chip" title="Stop following" onclick={() => setRig('handheld')}>Following {$film.targetName} ✕</button>
			{:else if $film.rig === 'tripod'}
				<button id="film-tripod-chip" class="film-chip" title="Back to handheld" onclick={() => setMotion(handheldMotion())}>Tripod ✕</button>
			{/if}
			{#if lowBattery}<span id="film-battery" class="film-chip film-warn">Battery low</span>{/if}
			{#if slow}<span id="film-heat" class="film-chip film-warn" title="Frames are slow — the phone may be hot or busy">Slow frames · phone hot?</span>{/if}
		</div>

		{#if mapOpen}
			<canvas
				id="film-minimap"
				class="film-minimap"
				width={MAP_PX}
				height={MAP_PX}
				bind:this={mapEl}
				aria-label="Mini-map: tap to move the camera there"
				onpointerdown={mapTap}
			></canvas>
		{/if}

		<!-- the zoom rail + lens snaps (right edge) -->
		<div class="film-zoom">
			<span id="film-focal" class="film-chip">{Math.round(focal)} mm</span>
			<div
				id="film-zoom-rail"
				class="film-rail"
				bind:this={railEl}
				role="slider"
				tabindex="0"
				aria-label="Zoom (focal length)"
				aria-valuemin={FOCAL_MIN}
				aria-valuemax={FOCAL_MAX}
				aria-valuenow={Math.round(focal)}
				aria-orientation="vertical"
				onpointerdown={railDown}
				onpointermove={railMove}
				onpointerup={railUp}
				onpointercancel={railUp}
				onkeydown={railKey}
			>
				<span class="film-rail-knob" style="bottom: calc({railPos * 100}% - 10px)"></span>
			</div>
			<div class="film-lenses">
				{#each LENS_PRESETS.slice().reverse() as mm (mm)}
					<button class="film-lens" data-mm={mm} class:on={Math.abs(focal - mm) < 0.5} onclick={() => setFov(fovForFocal(mm))}>{mm}</button>
				{/each}
			</div>
		</div>

		<div class="film-top">
			<button id="film-exit" class="film-btn" title="Leave Film mode (Esc)" aria-label="Leave Film mode" onclick={() => closeFilm()}>
				<Icon name="x" size={20} />
			</button>
			<div class="film-title">
				<span class="film-name">{$film.name}</span>
				{#if $film.sensor === 'permission'}
					<button id="film-motion" class="film-chip film-chip-ask" onclick={() => enableMotion()}>Use phone motion</button>
				{:else}
					<button
						id="film-sensor"
						class="film-chip film-pill"
						data-sensor={$film.sensor}
						data-motion={motion}
						aria-expanded={motionOpen}
						aria-haspopup="dialog"
						title="How the camera moves"
						onclick={() => {
							motionOpen = !motionOpen;
							settingsOpen = false;
							shotsOpen = false;
						}}>{motionPill} <Icon name="chevron-down" size={16} /></button
					>
				{/if}
			</div>
			<div class="film-top-right">
				<button
					id="film-horizon"
					class="film-btn"
					class:on={$film.horizonLock}
					aria-pressed={$film.horizonLock}
					title="Horizon lock: keep the picture level however the phone tilts"
					aria-label="Horizon lock"
					onclick={toggleHorizonLock}><Icon name="ruler" size={20} /></button
				>
				<button
					id="film-map-btn"
					class="film-btn"
					class:on={mapOpen}
					aria-expanded={mapOpen}
					title="Mini-map: tap a spot to jump the camera there"
					aria-label="Mini-map"
					onclick={() => (mapOpen = !mapOpen)}><Icon name="map" size={20} /></button
				>
				<button
					id="film-settings-btn"
					class="film-btn"
					class:on={settingsOpen}
					aria-expanded={settingsOpen}
					title="Camera settings"
					aria-label="Camera settings"
					onclick={() => (settingsOpen = !settingsOpen)}><Icon name="sliders-horizontal" size={20} /></button
				>
				<button id="film-recentre" class="film-btn" title="Recentre: point the phone, press — that is straight ahead (R)" aria-label="Recentre" onclick={onRecentre}>
					<Icon name="locate-fixed" size={20} />
				</button>
			</div>
		</div>

		<div class="film-bottom">
			<div
				id="film-stick"
				class="film-stick"
				class:film-hidden={motion === 'tripod'}
				aria-hidden={motion === 'tripod'}
				bind:this={stickEl}
				role="slider"
				aria-label="Move the camera"
				aria-valuenow={0}
				tabindex="-1"
				onpointerdown={stickDown}
				onpointermove={stickMove}
				onpointerup={stickUp}
				onpointercancel={stickUp}
			>
				<span class="film-knob" style="transform: translate({knob.x}px, {knob.y}px)"></span>
			</div>
			<div class="film-center">
				{#if $take.state !== 'idle' || shots.length}
					<div class="film-take-row">
						{#if $take.state !== 'idle'}
							<span id="film-take-timer" class="film-chip film-timer" data-state={$take.state}
								>{#if $take.state === 'recording'}<span class="film-rec-dot" aria-hidden="true"></span>{/if}{formatTake($take.t)}</span
							>
						{/if}
						<!-- fix-film: from the first shot on, recording or not; never before it -->
						{#if shots.length}
							<button
								id="film-shots"
								class="film-chip"
								aria-expanded={shotsOpen}
								onclick={() => {
									shotsOpen = !shotsOpen;
									motionOpen = false;
									settingsOpen = false;
								}}>{shots.length} {shots.length === 1 ? 'shot' : 'shots'}</button
							>
						{/if}
						{#if $take.state === 'recording'}
							<button id="film-marker" class="film-chip" title="Drop a timeline marker here (M)" onclick={() => addMarker()}
								><Icon name="flag" size={16} />Mark{#if $take.markers}&nbsp;{$take.markers}{/if}</button
							>
						{/if}
						{#if $take.state === 'paused'}
							<button id="film-done" class="film-chip" title="End this take session (the shots stay in the Timeline)" onclick={() => finishTake()}
								>Done</button
							>
						{/if}
					</div>
				{/if}
				<button
					id="film-record"
					class="film-record"
					data-state={$take.state}
					aria-label={$take.state === 'recording' ? 'Pause recording' : $take.state === 'paused' ? 'Resume recording' : 'Record'}
					title={viewer
						? 'Only editors can record — ask the host for editor access'
						: $take.state === 'recording'
							? 'Pause — the shot so far goes into the Timeline'
							: 'Record into the Timeline (the timeline plays while you film)'}
					disabled={viewer || ($take.saving && $take.state !== 'recording')}
					onclick={onRecord}
				>
					<span class="film-record-mark" aria-hidden="true"></span>
				</button>
			</div>
			<div class="film-lift">
				<button id="film-up" class="film-btn" aria-label="Rise" title="Rise (E)" onpointerdown={liftDown(1)} onpointerup={liftUp} onpointercancel={liftUp}>
					<Icon name="chevron-up" size={20} />
				</button>
				<button id="film-speed" class="film-chip film-speed" title="Movement speed" onclick={cycleSpeed}>{$film.speed} m/s</button>
				<button id="film-down" class="film-btn" aria-label="Sink" title="Sink (Q)" onpointerdown={liftDown(-1)} onpointerup={liftUp} onpointercancel={liftUp}>
					<Icon name="chevron-down" size={20} />
				</button>
			</div>
		</div>

		{#if $take.choosing}
			<div id="film-resume" class="film-sheet" use:minimalScroll role="dialog" aria-label="Resume how?">
				<p class="film-sheet-title">Continue from here as…</p>
				<button id="film-resume-cut" class="film-sheet-btn primary" onclick={() => onResume('cut')}>
					<Icon name="scissors" size={20} /><span><strong>Cut</strong> — a new shot starts here</span>
				</button>
				<button id="film-resume-move" class="film-sheet-btn" onclick={() => onResume('move')}>
					<Icon name="move-3d" size={20} /><span><strong>Move</strong> — fly from the last frame to here, same shot</span>
				</button>
				<button class="film-sheet-btn film-sheet-cancel" onclick={() => take.update((t) => ({ ...t, choosing: false }))}>Not yet</button>
			</div>
		{/if}
		{#if settingsOpen}
			<div id="film-settings" class="film-sheet film-settings" use:minimalScroll role="dialog" aria-label="Camera settings">
				<p class="film-sheet-title">Camera</p>
				<div class="film-row">
					<span>Rig</span>
					<div class="film-seg">
						{#each [['handheld', 'Handheld'], ['tripod', 'Tripod'], ['track', 'Track']] as [key, label] (key)}
							<button
								class="film-rig"
								data-rig={key}
								aria-pressed={$film.rig === key || (key === 'track' && armed === 'track')}
								onclick={() => chooseRig(/** @type {any} */ (key))}>{label}</button
							>
						{/each}
					</div>
				</div>
				<label class="film-row"
					><span>Height lock</span><input
						id="film-height-lock"
						type="checkbox"
						class="tp-check"
						checked={!!$film.heightLock}
						onchange={(e) => setHeightLock(e.currentTarget.checked)}
					/></label
				>
				<label class="film-row"
					><span>Smoothing</span><input
						id="film-smoothing"
						type="range"
						min="0"
						max="1"
						step="0.05"
						value={$film.smoothing}
						oninput={(e) => setSmoothing(Number(e.currentTarget.value))}
					/><output>{Math.round($film.smoothing * 100)}%</output></label
				>
				<label class="film-row"
					><span>Dutch</span><input
						id="film-dutch"
						type="range"
						min="-45"
						max="45"
						step="0.5"
						value={$film.roll}
						oninput={(e) => setRoll(Number(e.currentTarget.value))}
						ondblclick={() => setRoll(0)}
					/><output>{$film.roll.toFixed(1)}°</output></label
				>
				<label class="film-row"
					><span>Depth of field</span><input
						id="film-dof"
						type="checkbox"
						class="tp-check"
						checked={$film.aperture !== null}
						onchange={(e) => setAperture(e.currentTarget.checked ? 2.8 : null)}
					/></label
				>
				{#if $film.aperture !== null}
					<label class="film-row"
						><span>Aperture</span><input
							id="film-aperture"
							type="range"
							min="0"
							max={F_STOPS.length - 1}
							step="1"
							value={stopIndex}
							oninput={(e) => setAperture(F_STOPS[Number(e.currentTarget.value)])}
						/><output>f/{$film.aperture}</output></label
					>
					<p class="film-note">Tap the picture to pull focus{$film.focus !== null ? ` · ${$film.focus.toFixed(1)} m` : ''}</p>
				{/if}
				<label class="film-row"
					><span>Pinch zoom speed</span><input id="film-zoom-speed" type="range" min="0.25" max="3" step="0.25" bind:value={zoomSpeed} /><output
						>{zoomSpeed}×</output
					></label
				>
				<p class="film-sheet-title">Guides</p>
				<div class="film-row film-checks">
					<label><input id="film-ov-thirds" type="checkbox" class="tp-check" bind:checked={overlays.thirds} />Thirds</label>
					<label><input id="film-ov-safe" type="checkbox" class="tp-check" bind:checked={overlays.safe} />Safe area</label>
					<label><input id="film-ov-level" type="checkbox" class="tp-check" bind:checked={overlays.level} />Level</label>
				</div>
				<div class="film-row">
					<span>Mask</span>
					<div class="film-seg">
						{#each MASKS as m (m.key)}
							<button class="film-mask-btn" data-mask={m.key} aria-pressed={mask === m.key} onclick={() => (mask = m.key)}>{m.label}</button>
						{/each}
					</div>
				</div>
				<label class="film-row"
					><span>3-2-1 countdown</span><input id="film-countdown" type="checkbox" class="tp-check" bind:checked={countdownOn} /></label
				>
				<button
					id="film-help-open"
					class="film-sheet-btn"
					onclick={() => {
						settingsOpen = false;
						helpStep = 0;
						helpOpen = true;
					}}><Icon name="circle-help" size={20} /><span><strong>How to film</strong> — the three cards again</span></button
				>
			</div>
		{/if}
		{#if motionOpen}
			<div id="film-motion-sheet" class="film-sheet film-motion-sheet" use:minimalScroll role="dialog" aria-label="How the camera moves">
				<p class="film-sheet-title">How the camera moves</p>
				{#each motionChoices as o (o.key)}
					<button
						id={o.key === 'walk' ? 'film-walk' : undefined}
						class="film-sheet-btn film-motion-opt"
						class:primary={motion === o.key || (o.key === 'walk' && chosenMotion === 'walk')}
						data-motion={o.key}
						aria-pressed={motion === o.key}
						disabled={!o.available}
						onclick={() => chooseMotion(o.key)}
					>
						<Icon name={MOTION_ICONS[o.key]} size={24} /><span><strong>{o.label}</strong><small>{o.reason || o.desc}</small></span>
					</button>
				{/each}
				{#if $walkEntry === 'unsupported'}
					<p class="film-note">Walk needs AR — Chrome on an Android phone with Google Play Services for AR.</p>
				{:else}
					<p class="film-sheet-title">While walking</p>
					<div class="film-row">
						<span>Passthrough</span>
						<div id="film-passthrough" class="film-seg">
							{#each PASSTHROUGH as pt (pt.key)}
								<button class="film-pass" data-pass={pt.key} aria-pressed={$walk.passthrough === pt.key} onclick={() => setPassthrough(pt.key)}>{pt.label}</button>
							{/each}
						</div>
					</div>
					<p class="film-note">Off shows the scene's own sky, On the scene over the room, Dimmed the room faint behind it. Only the live view changes — never the recorded take or its export.</p>
					<div class="film-row">
						<span>Walking scale</span>
						<div id="film-walk-scales" class="film-seg">
							{#each WALK_SCALE_CHIPS as k (k)}
								<button class="film-scale" data-scale={k} aria-pressed={$walk.scale === k} onclick={() => setWalkScale(k)}>×{k}</button>
							{/each}
						</div>
					</div>
					<label class="film-row"
						><span>Fine scale</span><input
							id="film-walk-scale"
							type="range"
							min={WALK_LOG.min}
							max={WALK_LOG.max}
							step="0.01"
							value={Math.log10($walk.scale)}
							oninput={(e) => setWalkScale(Math.round(Math.pow(10, Number(e.currentTarget.value)) * 100) / 100)}
						/><output>×{$walk.scale}</output></label
					>
					<p class="film-note">1 m walked = ×{$walk.scale} m in the scene.</p>
				{/if}
			</div>
		{/if}
		{#if helpOpen}
			{@const card = HELP_CARDS[helpStep]}
			<div id="film-help" class="film-sheet film-help" role="dialog" aria-label="How to film" data-card={card.key}>
				<div class="film-help-head">
					<Icon name={card.icon} size={32} />
					<p class="film-sheet-title">{card.title}</p>
					<span class="film-help-count">{helpStep + 1} / {HELP_CARDS.length}</span>
				</div>
				{#if card.key === 'look'}
					<p class="film-help-body">Turn the phone to look around. Or drag the picture: tap the pill at the top to choose Phone tilt, Touch, Walk or Tripod.</p>
					{#if gyro === false}
						<p id="film-help-nogyro" class="film-note">This device has no motion sensor, so Film uses Touch: drag to look, the stick to move.</p>
					{:else}
						<p class="film-note">On a phone without a gyroscope, Film switches to Touch on its own: drag to look.</p>
					{/if}
				{:else if card.key === 'move'}
					<p class="film-help-body">The stick moves the camera and ▲▼ raise and lower it. On an AR phone, Walk moves it with your own steps.</p>
				{:else}
					<p class="film-help-body">● records a shot while the timeline plays; ❚❚ adds it. Resume as a Cut (a new shot) or a Move (fly on from the last frame). The shots pill lists every shot.</p>
				{/if}
				<div class="film-help-foot">
					<button id="film-help-never" class="film-sheet-btn film-sheet-cancel" onclick={() => closeHelp(true)}>Don't show again</button>
					{#if helpStep < HELP_CARDS.length - 1}
						<button id="film-help-next" class="film-sheet-btn primary" onclick={() => (helpStep += 1)}>Next</button>
					{:else}
						<button id="film-help-done" class="film-sheet-btn primary" onclick={() => closeHelp(false)}>Done</button>
					{/if}
				</div>
			</div>
		{/if}
		{#if shotsOpen}
			<div id="film-shot-list" class="film-sheet film-shots-sheet" role="dialog" aria-label="Shots on this camera">
				<p class="film-sheet-title">Shots on this camera</p>
				<div class="film-shot-scroll" use:minimalScroll>
					{#each shots as s, i (s.id)}
						{@const name = shotName(s, i)}
						<div class="film-shot-row" data-item={s.id}>
							<input
								type="checkbox"
								class="tp-check film-shot-pick"
								aria-label="Select {name} to export"
								checked={picked.includes(s.id)}
								onchange={() => togglePick(s.id)}
							/>
							<button class="film-shot-main" title="Preview {name}" disabled={$take.state === 'recording'} onclick={() => startPreview(s, i)}>
								{#if s.thumb && thumbs[s.thumb]}
									<img class="film-shot-thumb" src={thumbs[s.thumb]} alt="" />
								{:else}
									<span class="film-shot-thumb film-shot-thumb-none"><Icon name="video" size={16} /></span>
								{/if}
								<span class="film-shot-text">
									{#if renaming === s.id}
										<!-- svelte-ignore a11y_autofocus -->
										<input
											class="film-shot-name ui-input"
											value={s.name ?? ''}
											placeholder={`Shot ${i + 1}`}
											maxlength="60"
											autofocus
											onclick={(e) => e.stopPropagation()}
											onkeydown={(e) => {
												e.stopPropagation();
												if (e.key === 'Enter') commitRename(s, e.currentTarget.value);
												if (e.key === 'Escape') renaming = '';
											}}
											onblur={(e) => commitRename(s, e.currentTarget.value)}
										/>
									{:else}
										<span class="film-shot-title">{name}</span>
									{/if}
									<span class="film-shot-meta">{formatTake(s.dur)} · {shotKind(s)}</span>
								</span>
							</button>
							<button
								class="film-btn film-shot-more"
								aria-label="More for {name}"
								aria-expanded={menuFor === s.id}
								onclick={() => (menuFor = menuFor === s.id ? '' : s.id)}><Icon name="ellipsis" size={20} /></button
							>
						</div>
						{#if menuFor === s.id}
							<div class="film-shot-actions" data-item={s.id}>
								<button class="film-chip film-act" data-act="preview" disabled={$take.state === 'recording'} onclick={() => startPreview(s, i)}><Icon name="play" size={16} />Preview</button>
								<button class="film-chip film-act" data-act="trim" disabled={$take.state === 'recording'} onclick={() => startPreview(s, i, true)}><Icon name="scissors" size={16} />Trim</button>
								<button
									class="film-chip film-act"
									data-act="rename"
									onclick={() => {
										renaming = s.id;
										menuFor = '';
									}}><Icon name="pencil" size={16} />Rename</button
								>
								<button class="film-chip film-act film-retake" data-act="retake" disabled={$take.state === 'recording'} onclick={() => onRetake(s.id)}
									><Icon name="rotate-ccw" size={16} />Retake</button
								>
								<button class="film-chip film-act" data-act="delete" disabled={$take.state === 'recording'} onclick={() => onDeleteShot(s, i)}><Icon name="trash-2" size={16} />Delete</button>
								<button class="film-chip film-act" data-act="timeline" onclick={() => editInTimeline(s)}><Icon name="clapperboard" size={16} />Edit in timeline</button>
							</div>
						{/if}
					{/each}
				</div>
				<!-- the footer stays put under the scrolling list -->
				<div class="film-shot-foot">
					<button id="film-edit" class="film-sheet-btn" onclick={() => editInTimeline()}>
						<Icon name="clapperboard" size={20} /><span><strong>Edit in timeline</strong></span>
					</button>
					<button id="film-export" class="film-sheet-btn primary" data-picked={picked.length} onclick={onExport}>
						<Icon name="video" size={20} /><span><strong>{exportBtn}</strong></span>
					</button>
				</div>
			</div>
		{/if}
		{#if exportAsk}
			{@const n = picked.length || shots.length}
			<div id="film-export-sheet" class="film-sheet" role="dialog" aria-label="Export video">
				<p class="film-sheet-title">Export {n} shots</p>
				<button id="film-export-joined" class="film-sheet-btn primary" onclick={() => exportShots(true)}>
					<Icon name="video" size={20} /><span><strong>One video</strong> — the shots joined in recorded order</span>
				</button>
				<button id="film-export-each" class="film-sheet-btn" onclick={() => exportShots(false)}>
					<Icon name="clapperboard" size={20} /><span><strong>One file per shot</strong> — each goes to Explorer ▸ Recordings</span>
				</button>
				<button class="film-sheet-btn film-sheet-cancel" onclick={() => (exportAsk = false)}>Cancel</button>
			</div>
		{/if}
		{#if preview}
			<div id="film-preview" class="film-sheet film-preview" role="dialog" aria-label="{preview.trim ? 'Trim' : 'Preview'} {preview.name}" data-mode={preview.trim ? 'trim' : 'preview'}>
				<div class="film-preview-head">
					<button id="film-preview-play" class="film-btn" aria-label={preview.playing ? 'Pause the preview' : 'Play the shot'} onclick={togglePlay}
						><Icon name={preview.playing ? 'pause' : 'play'} size={20} /></button
					>
					<span class="film-preview-name">{preview.trim ? 'Trim' : 'Preview'} · {preview.name}</span>
					<span class="film-preview-time">{formatTake(preview.t - preview.t0)} / {formatTake(preview.t1 - preview.t0)}</span>
					<button id="film-preview-done" class="film-chip" onclick={() => {
						endPreview();
						shotsOpen = true;
					}}>Done</button>
				</div>
				<input
					id="film-preview-scrub"
					type="range"
					aria-label="Scrub the shot"
					min={preview.t0}
					max={preview.t1}
					step="0.01"
					value={preview.t}
					oninput={(e) => scrubPreview(Number(e.currentTarget.value))}
				/>
				{#if preview.trim}
					<label class="film-row"
						><span>In</span><input
							id="film-trim-in"
							type="range"
							min={preview.recT}
							max={preview.recEnd}
							step="0.01"
							value={preview.t0}
							onpointerdown={() => shotsSeqId && beginShotsGesture(shotsSeqId)}
							oninput={(e) => trimTo('in', Number(e.currentTarget.value))}
							onchange={() => shotsSeqId && endShotsGesture(shotsSeqId)}
						/><output>{formatTake(preview.t0 - preview.recT)}</output></label
					>
					<label class="film-row"
						><span>Out</span><input
							id="film-trim-out"
							type="range"
							min={preview.recT}
							max={preview.recEnd}
							step="0.01"
							value={preview.t1}
							onpointerdown={() => shotsSeqId && beginShotsGesture(shotsSeqId)}
							oninput={(e) => trimTo('out', Number(e.currentTarget.value))}
							onchange={() => shotsSeqId && endShotsGesture(shotsSeqId)}
						/><output>{formatTake(preview.t1 - preview.recT)}</output></label
					>
					<p class="film-note">The handles stop at the shot as recorded; trimming back out brings it back.</p>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	/* THE TAKEOVER: the 3D view becomes the shot's box, every other piece of chrome goes invisible
	   (visibility, not display — nothing remounts or reflows, and it all comes back as it was) */
	:global(html.film-mode),
	:global(html.film-mode body) {
		background: #000 !important; /* tokens-ok: the letterbox bars around the shot, black in every theme */
	}
	:global(html.film-mode body *) {
		visibility: hidden !important;
	}
	:global(html.film-mode #viewport),
	:global(html.film-mode #viewport *),
	:global(html.film-mode #film-root),
	:global(html.film-mode #film-root *),
	:global(html.film-mode .toasts-container),
	:global(html.film-mode .toasts-container *) {
		visibility: visible !important;
	}
	:global(html.film-mode #viewport) {
		left: var(--film-l) !important;
		top: var(--film-t) !important;
		width: var(--film-w) !important;
		height: var(--film-h) !important;
		right: auto !important;
		bottom: auto !important;
	}

	.film-root {
		position: fixed;
		inset: 0;
		/* over every bar and popover, but UNDER the passive toasts: Film's own offers ("Add depth of field",
		   "Watch the shot", motion off) are toasts, and at --z-modal the settings sheet covered them */
		z-index: calc(var(--z-toast-low) - 1);
		pointer-events: none;
		/* tokens-ok-begin: the viewfinder is a camera screen — dark glass over the picture in every theme */
		--film-ink: #fff;
		--film-glass: rgba(0, 0, 0, 0.5);
		--film-glass-soft: rgba(0, 0, 0, 0.35);
		--film-shade: rgba(0, 0, 0, 0.45);
		--film-edge: rgba(255, 255, 255, 0.25);
		--film-knob: rgba(255, 255, 255, 0.75);
		--film-shadow: #000;
		--film-rec: #ef4444;
		--film-sheet: rgba(20, 20, 24, 0.92);
		--film-level: #4ade80;
		--film-focus: #facc15;
		--film-warn: #fbbf24;
		/* tokens-ok-end */
		color: var(--film-ink);
		font-size: var(--fs-body);
		user-select: none;
		-webkit-user-select: none;
	}
	.film-look {
		position: absolute;
		inset: 0;
		pointer-events: auto;
		touch-action: none;
	}
	.film-top,
	.film-bottom {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: max(10px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 10px max(12px, env(safe-area-inset-left));
		pointer-events: none;
	}
	.film-top {
		top: 0;
		background: linear-gradient(var(--film-shade), transparent);
	}
	.film-bottom {
		bottom: 0;
		align-items: flex-end;
		padding-bottom: max(16px, env(safe-area-inset-bottom));
		background: linear-gradient(transparent, var(--film-shade));
	}
	.film-top > *,
	.film-bottom > * {
		pointer-events: auto;
	}
	.film-title {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}
	.film-name {
		font-weight: 600;
		max-width: 40vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-shadow: 0 1px 2px var(--film-shadow);
	}
	.film-top-right,
	.film-lift {
		display: flex;
		gap: 8px;
	}
	.film-lift {
		flex-direction: column;
		align-items: center;
	}
	.film-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border-radius: 999px;
		background: var(--film-glass);
		border: 1px solid var(--film-edge);
		color: var(--film-ink);
		touch-action: none;
	}
	.film-btn.on {
		background: var(--accent);
		border-color: transparent;
	}
	.film-chip {
		display: inline-flex;
		align-items: center;
		padding: 2px 10px;
		border-radius: 999px;
		background: var(--film-glass);
		border: 1px solid var(--film-edge);
		font-size: var(--fs-desc);
		white-space: nowrap;
		color: var(--film-ink);
	}
	.film-chip-ask {
		background: var(--accent);
		padding: 6px 14px;
		font-size: var(--fs-body);
	}
	.film-speed {
		min-height: 32px;
	}
	.film-stick {
		position: relative;
		width: 120px;
		height: 120px;
		border-radius: 999px;
		background: var(--film-glass-soft);
		border: 2px solid var(--film-edge);
		touch-action: none;
	}
	.film-knob {
		position: absolute;
		left: calc(50% - 24px);
		top: calc(50% - 24px);
		width: 48px;
		height: 48px;
		border-radius: 999px;
		background: var(--film-knob);
		pointer-events: none;
	}
	.film-center {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}
	.film-take-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.film-timer {
		font-variant-numeric: tabular-nums;
		gap: 6px;
	}
	.film-rec-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--film-rec);
	}
	.film-record {
		width: 72px;
		height: 72px;
		border-radius: 999px;
		border: 4px solid var(--film-ink);
		background: var(--film-glass);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		touch-action: none;
	}
	.film-record:disabled {
		opacity: 0.5;
	}
	.film-record-mark {
		width: 52px;
		height: 52px;
		border-radius: 999px;
		background: var(--film-rec);
		transition: all 0.15s;
	}
	.film-record[data-state='recording'] .film-record-mark {
		width: 26px;
		height: 26px;
		border-radius: 6px;
	}
	.film-sheet {
		position: absolute;
		left: 50%;
		bottom: calc(max(16px, env(safe-area-inset-bottom)) + 140px);
		transform: translateX(-50%);
		width: min(92vw, 380px);
		max-height: 50vh;
		overflow: auto;
		padding: 12px;
		border-radius: 14px;
		background: var(--film-sheet);
		border: 1px solid var(--film-edge);
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.film-sheet-title {
		margin: 0 0 4px;
		font-weight: 600;
	}
	.film-sheet-btn {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 6px 12px;
		border-radius: 10px;
		background: var(--film-glass);
		color: var(--film-ink);
		text-align: left;
	}
	.film-sheet-btn.primary {
		background: var(--accent);
	}
	.film-sheet-cancel {
		justify-content: center;
		background: transparent;
	}
	.film-shot-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 52px;
		font-variant-numeric: tabular-nums;
	}
	/* fix-film: the motion pill, the picker, the walk chips, the help cards, the shots sheet, the preview bar */
	.film-pill {
		gap: 4px;
		min-height: 32px;
		padding: 2px 10px 2px 12px;
		pointer-events: auto;
	}
	.film-hidden {
		visibility: hidden;
		pointer-events: none !important;
	}
	.film-walk-group {
		display: inline-flex;
		gap: 4px;
		pointer-events: auto;
	}
	.film-walk-group .film-chip {
		min-height: 32px;
	}
	.film-chip-x {
		padding: 2px 10px;
	}
	.film-scale[aria-pressed='true'] {
		background: var(--accent);
		border-color: transparent;
	}
	.film-motion-sheet {
		top: calc(max(10px, env(safe-area-inset-top)) + 56px);
		bottom: auto;
		max-height: calc(100vh - 200px);
	}
	.film-motion-opt {
		min-height: 60px;
	}
	.film-motion-opt span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.film-motion-opt small {
		opacity: 0.8;
		font-size: var(--fs-desc);
	}
	.film-motion-opt:disabled {
		opacity: 0.5;
	}
	.film-help {
		top: 50%;
		bottom: auto;
		transform: translate(-50%, -50%);
		gap: 10px;
	}
	.film-help-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.film-help-head .film-sheet-title {
		margin: 0;
		flex: 1;
	}
	.film-help-count {
		opacity: 0.7;
		font-variant-numeric: tabular-nums;
	}
	.film-help-body {
		margin: 0;
		line-height: 1.4;
	}
	.film-help-foot {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}
	.film-help-foot .film-sheet-btn {
		justify-content: center;
		padding: 6px 16px;
	}
	.film-shots-sheet {
		overflow: hidden;
		max-height: min(60vh, 520px);
	}
	.film-shot-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.film-shot-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px;
		border-radius: 10px;
		color: var(--film-ink);
		text-align: left;
	}
	.film-shot-main:disabled {
		opacity: 0.6;
	}
	.film-shot-thumb {
		flex: 0 0 auto;
		width: 72px;
		height: 40px;
		border-radius: 6px;
		object-fit: cover;
		background: var(--film-glass);
	}
	.film-shot-thumb-none {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.film-shot-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.film-shot-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.film-shot-meta {
		opacity: 0.75;
		font-size: var(--fs-desc);
	}
	.film-shot-name {
		width: 100%;
		min-height: 30px;
	}
	.film-shot-more {
		flex: 0 0 auto;
		width: 36px;
		height: 36px;
	}
	.film-shot-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 0 4px 6px 32px;
	}
	.film-act {
		gap: 4px;
		min-height: 32px;
	}
	.film-shot-foot {
		flex: 0 0 auto;
		display: flex;
		gap: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--film-edge);
	}
	.film-shot-foot .film-sheet-btn {
		flex: 1;
		justify-content: center;
	}
	.film-preview {
		bottom: calc(max(16px, env(safe-area-inset-bottom)) + 140px);
	}
	.film-preview-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.film-preview-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.film-preview-time {
		font-variant-numeric: tabular-nums;
		opacity: 0.8;
	}
	#film-preview-scrub {
		width: 100%;
	}
	.film-frame {
		position: absolute;
		pointer-events: none;
	}
	.film-mask {
		position: absolute;
		outline: 1px solid var(--film-edge);
		box-shadow: 0 0 0 100vmax var(--film-glass);
	}
	.film-frame > div {
		overflow: hidden;
	}
	.film-thirds,
	.film-safe,
	.film-level {
		position: absolute;
		inset: 0;
	}
	.film-thirds i {
		position: absolute;
		background: var(--film-edge);
	}
	.film-thirds i:nth-child(1),
	.film-thirds i:nth-child(2) {
		top: 0;
		bottom: 0;
		width: 1px;
		left: 33.333%;
	}
	.film-thirds i:nth-child(2) {
		left: 66.666%;
	}
	.film-thirds i:nth-child(3),
	.film-thirds i:nth-child(4) {
		left: 0;
		right: 0;
		height: 1px;
		top: 33.333%;
	}
	.film-thirds i:nth-child(4) {
		top: 66.666%;
	}
	.film-safe i {
		position: absolute;
		inset: 5%;
		border: 1px dashed var(--film-edge);
	}
	.film-level {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.film-level span {
		width: 72px;
		height: 2px;
		border-radius: 2px;
		background: var(--film-knob);
		box-shadow: 0 0 2px var(--film-shadow);
	}
	.film-level.level span {
		background: var(--film-level);
	}
	.film-focus-mark {
		position: absolute;
		transform: translate(-50%, -50%);
		width: 64px;
		height: 64px;
		border: 2px solid var(--film-focus);
		border-radius: 6px;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		pointer-events: none;
	}
	.film-focus-mark .film-chip {
		transform: translateY(130%);
	}
	.film-countdown {
		position: absolute;
		left: 50%;
		top: 40%;
		transform: translate(-50%, -50%);
		font-size: 96px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		text-shadow: 0 2px 8px var(--film-shadow);
		pointer-events: none;
	}
	.film-hints {
		position: absolute;
		left: 0;
		right: 0;
		top: calc(max(10px, env(safe-area-inset-top)) + 58px);
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 6px;
		pointer-events: none;
	}
	.film-hints > * {
		pointer-events: auto;
	}
	/* 68: the first-use how-to — one line of chips' look, wraps on a folded phone */
	.film-warn {
		background: var(--film-warn);
		color: var(--film-shadow);
	}
	.film-minimap {
		position: absolute;
		left: max(12px, env(safe-area-inset-left));
		top: calc(max(10px, env(safe-area-inset-top)) + 96px);
		width: 160px;
		height: 160px;
		border-radius: 12px;
		border: 1px solid var(--film-edge);
		pointer-events: auto;
		touch-action: none;
	}
	.film-zoom {
		position: absolute;
		right: max(8px, env(safe-area-inset-right));
		top: 50%;
		transform: translateY(-60%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		pointer-events: auto;
	}
	.film-rail {
		position: relative;
		width: 36px;
		height: min(30vh, 200px);
		border-radius: 999px;
		background: var(--film-glass-soft);
		border: 1px solid var(--film-edge);
		touch-action: none;
	}
	.film-rail-knob {
		position: absolute;
		left: 7px;
		width: 20px;
		height: 20px;
		border-radius: 999px;
		background: var(--film-knob);
		pointer-events: none;
	}
	.film-lenses {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.film-lens {
		width: 36px;
		height: 28px;
		border-radius: 8px;
		background: var(--film-glass);
		border: 1px solid var(--film-edge);
		color: var(--film-ink);
		font-size: var(--fs-desc);
		font-variant-numeric: tabular-nums;
	}
	.film-lens.on {
		background: var(--accent);
		border-color: transparent;
	}
	.film-settings {
		top: calc(max(10px, env(safe-area-inset-top)) + 56px);
		bottom: auto;
		max-height: calc(100vh - 220px);
	}
	.film-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 40px;
	}
	.film-row > span {
		flex: 0 0 auto;
		min-width: 92px;
	}
	.film-row input[type='range'] {
		flex: 1;
		min-width: 0;
	}
	.film-row output {
		min-width: 44px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.film-checks {
		flex-wrap: wrap;
		gap: 14px;
	}
	.film-checks label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.film-seg {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.film-seg button {
		min-height: 32px;
		padding: 0 10px;
		border-radius: 8px;
		background: var(--film-glass);
		border: 1px solid var(--film-edge);
		color: var(--film-ink);
	}
	.film-seg button[aria-pressed='true'] {
		background: var(--accent);
		border-color: transparent;
	}
	.film-note {
		margin: 0;
		opacity: 0.75;
		font-size: var(--fs-desc);
	}
	.film-text {
		width: auto;
		padding: 0 18px;
	}
	.film-picker {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(92vw, 420px);
		max-height: 80vh;
		overflow: auto;
		padding: 18px;
		border-radius: 14px;
		color: var(--text);
		background: var(--surface-1);
		border: 1px solid var(--border-strong);
		box-shadow: var(--shadow-window);
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.film-picker h2 {
		font-size: var(--fs-modal-title);
		font-weight: 600;
		margin: 0;
	}
	.film-picker-desc {
		color: var(--text-muted);
		margin: 0;
	}
	.film-picker-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.film-pick-cam {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 0 12px;
		border-radius: 10px;
		background: var(--surface-hover);
		color: inherit;
		text-align: left;
	}
	.film-pick-new {
		background: transparent;
		border: 1px dashed var(--border-strong);
	}
	#film-cancel {
		align-self: flex-end;
		height: 36px;
	}
</style>
