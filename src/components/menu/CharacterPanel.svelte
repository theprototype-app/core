<script>
	// 36-avatars (plan 76.5, decision: "a Settings-style side panel — opening it moves the viewport
	// camera to YOUR character, every change previews live on it, Apply closes the panel and returns
	// the camera"). Replaces the 17/129 Customize Character modal.
	//
	// The panel edits a DRAFT. The draft is drawn on a LOCAL preview of your character (avatarPreview
	// -> Player renders it through the same AvatarRig every peer uses for you), standing where your
	// head is and facing where you look — exactly what peers see. Nothing replicates until Apply,
	// which writes userdata slot 5 (+ the ping prefs) the way the old modal did; Cancel / Esc / the
	// close button drop the draft. Either way the camera flies back to where it was.
	import { get } from 'svelte/store';
	import { tick } from 'svelte';
	import * as THREE from 'three';
	import { characterModalOpen, avatarConfig, userdata, peers } from '../../stores/appStore.js';
	import { globalCamera, globalRenderer, globalScene, orbitControls, isVRMode } from '../../stores/sceneStore.js';
	import { resolveAvatar, AVATAR_DEFAULTS } from '$lib/avatarModel';
	import { HEAD_OPTIONS, feetBelowHead, resolveCharacter } from '$lib/avatars/catalog';
	import { avatarPreview, studioOpen, studioInScene, studioIsolating, studioPingUntil } from '$lib/avatars/avatarState';
	// 41 G9: presets show their defaults, an edit after one is "Custom", Surprise me deals anew
	import { LOOK_KEYS, presetList, presetLook, presetOf, lookOf, randomLook } from '$lib/avatars/characterLooks';
	// 41 G8: the framing as pure arithmetic (fit distance + the centring view offset)
	import { BODY_HEIGHT, fitDistance, fitToCorners, centreOffset, freeRect } from '$lib/avatars/characterFraming';
	import { PING_TTL } from '$lib/ping';
	import { pingColor, pingSound, previewPing } from '$lib/ping';
	import { PING_SOUNDS, playPing } from '$lib/pingAudio';
	import { safeStorage } from '$lib/safeStorage';
	import { settleSheet } from '$lib/ui/sheetSnap.js';
	import { phoneSheetMaxH } from '$lib/ui/phoneShell.js';
	import { flyTo } from '$lib/objectActions';
	import Icon from '../ui/Icon.svelte';
	// 38 R7 + NOTES-38 #2: a resizable DRAWER on the redesign kit — WindowChrome size="modal" header,
	// chips with the accent selection (role=radio + the data-* hooks kept), a Toggle for the name
	// label, Cancel / Apply (the one primary) in the footer, the minimal scrollbar on the body.
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Button from '../ui/Button.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	const HATS = [
		{ value: 'none', name: 'None' },
		{ value: 'cap', name: 'Cap' },
		{ value: 'tophat', name: 'Top hat' },
		{ value: 'crown', name: 'Crown' }
	];
	const CLASSIC_SHAPES = HEAD_OPTIONS.filter((o) => o.value !== 'character');
	const presets = presetList();

	/** @type {any} */
	let draft = $state(resolveAvatar(null));
	let draftPingColor = $state('');
	let draftPingSound = $state('ding');
	let open = $state(false);
	/** @type {{position: number[], target: number[]} | null} */
	let savedView = null;
	/** @type {{position: number[], yaw: number} | null} */
	let stand = null;
	// the view the camera is flying back to, and when that flight ends: a reopen DURING it must take
	// this as home, not the mid-flight camera (or the next Apply returns you somewhere in between)
	/** @type {{position: number[], target: number[], until: number} | null} */
	let returning = null;

	const myId = () => /** @type {any} */ (get(peers))?.peer?.id ?? '';
	const myPhoto = () => safeStorage.getItem('avatar') || '';
	const hasPhoto = $derived(open && !!myPhoto());
	const rigged = $derived(!!resolveCharacter(draft.character, myId()));
	/** 41 G9: which entry is selected — a preset id, or 'custom' */
	let selected = $state('auto');
	/** the custom look this session made (null = no Custom entry yet) @type {Record<string, any> | null} */
	let customLook = $state(null);
	/** how many looks Surprise me has dealt this session (the live region re-reads on change) */
	let surprises = $state(0);
	const baseName = $derived(
		draft.character === 'auto'
			? (resolveCharacter('auto', myId())?.name ?? 'Auto')
			: (presets.find((p) => p.id === draft.character)?.name ?? draft.character)
	);
	const shownName = $derived(
		selected === 'custom' ? `Custom · ${baseName}` : draft.character === 'auto' ? `Auto · ${baseName}` : baseName
	);

	// 41 G10: while the studio hides the scene, the DOM layers drawn over the 3D view (note
	// markers, a game HUD) hide with it — they would float over an empty room
	$effect(() => {
		const on = open && $studioIsolating;
		document.documentElement.classList.toggle('character-studio', on);
		return () => document.documentElement.classList.remove('character-studio');
	});

	// open/close follow the store (the profile menu's "Customize Character" sets it)
	$effect(() => {
		const want = $characterModalOpen;
		if (want && !open) begin();
		else if (!want && open) end(false);
	});

	function begin() {
		open = true;
		draft = { ...resolveAvatar(get(avatarConfig)) };
		const preset = presetOf(draft);
		selected = preset ?? 'custom';
		customLook = preset ? null : lookOf(draft);
		surprises = 0;
		draftPingColor = get(pingColor) || '';
		draftPingSound = get(pingSound) || 'ding';
		/** @type {any} */
		const cam = get(globalCamera);
		/** @type {any} */
		const controls = get(orbitControls);
		if (!cam) return;
		// YOUR character stands where your head is, facing where you look — what peers see
		const fwd = cam.getWorldDirection(new cam.position.constructor());
		const yawNow = Math.atan2(-fwd.x, -fwd.z);
		const flying = returning && performance.now() < returning.until ? returning : null;
		const head = flying ? flying.position : cam.position.toArray();
		const homeTarget = flying ? flying.target : controls ? controls.target.toArray() : [head[0] + fwd.x, head[1] + fwd.y, head[2] + fwd.z];
		const yaw = flying ? Math.atan2(-(homeTarget[0] - head[0]), -(homeTarget[2] - head[2])) : yawNow;
		returning = null;
		stand = { position: head, yaw };
		savedView = { position: head, target: homeTarget };
		pushPreview();
		if (get(isVRMode)) return;
		// 41 G10: the isolated studio (CharacterStudio.svelte, beside the preview avatar)
		studioOpen.set(true);
		// frame once the drawer is on screen: the free part of the viewport is what it leaves
		tick().then(() => {
			if (open) frame(500, false);
		});
	}

	// NOTES-38 #2: the drawer is resizable (its inner edge — the left edge beside the viewport, the
	// top edge of the phone sheet) and the camera frames your character in the part of the viewport
	// the drawer leaves free, re-aimed when a resize ends. The size is a LOCAL view pref.
	const SIZE_KEY = 'characterDrawer:size';
	/** @returns {{w: number, h: number}} */
	function readSize() {
		try {
			const v = JSON.parse(safeStorage.getItem(SIZE_KEY) || 'null');
			return { w: Number(v?.w) || 340, h: Number(v?.h) || 0 };
		} catch {
			return { w: 340, h: 0 };
		}
	}
	const initial = readSize();
	let drawerW = $state(initial.w);
	let drawerH = $state(initial.h);
	let narrow = $state(typeof window !== 'undefined' && window.innerWidth <= 640);
	let resizing = $state(false);
	const MIN_W = 300;
	const MIN_H = 220;
	const maxW = () => Math.max(MIN_W, Math.round(window.innerWidth * 0.6));
	// 40 F1: on the phone the sheet's ceiling is the shell's sheet room (clear of the top bar and the
	// selection strip), like every other phone sheet
	const maxH = () => Math.max(MIN_H, Math.round(Math.min(window.innerHeight * 0.8, get(phoneSheetMaxH) || Infinity)));
	const sheetH = () => (drawerH > 0 ? Math.min(Math.max(drawerH, MIN_H), maxH()) : Math.min(window.innerHeight * 0.52, 460));
	const panelW = () => Math.min(Math.max(drawerW, MIN_W), maxW());

	/** the drawer element (the free part of the viewport is what it leaves) @type {HTMLElement | null} */
	let panelEl = $state(null);
	/** the layout the camera was last framed for: a re-frame only when it really changed */
	let framedFor = '';

	/** the renderer's canvas, whose box IS the viewport @returns {HTMLElement | null} */
	const canvasEl = () => /** @type {any} */ (get(globalRenderer))?.domElement ?? null;

	/** 41 G8: frame the WHOLE body in the free part of the viewport — left of the drawer on a
	 * wide screen, above the sheet on a phone. The distance fits the body's envelope in both
	 * directions, and a projection view offset puts the orbit target (the body's middle) at the
	 * free rect's centre, so orbiting turns the character in place like a turntable.
	 * `keepAngle` keeps the direction you orbited to (a re-frame after a layout change); the
	 * first frame takes the 3/4 front view. @param {number} ms @param {boolean} keepAngle */
	function frame(ms, keepAngle) {
		/** @type {any} */
		const cam = get(globalCamera);
		const canvas = canvasEl();
		if (!cam || !stand || !canvas || get(isVRMode)) return;
		const cr = canvas.getBoundingClientRect();
		if (cr.width < 2 || cr.height < 2) return;
		const sheet = window.innerWidth <= 640;
		const pr = panelEl?.getBoundingClientRect() ?? null;
		const free = freeRect(cr, pr, sheet);
		framedFor = layoutKey(cr, pr, sheet);
		let dist = fitDistance({ viewH: cr.height, free, fovDeg: cam.fov });
		const head = stand.position;
		const feetY = head[1] - feetBelowHead();
		const box = bodyBox();
		framedBox = boxKey(box);
		const target = box
			? [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2]
			: [head[0], feetY + BODY_HEIGHT / 2 - 0.12, head[2]];
		/** @type {any} */
		const controls = get(orbitControls);
		let dir;
		if (keepAngle && performance.now() < flightUntil && flightDir) dir = flightDir;
		else if (keepAngle && controls) {
			const d = cam.position.clone().sub(controls.target);
			dir = d.lengthSq() > 1e-6 ? d.normalize().toArray() : null;
		}
		if (!dir) {
			// a 3/4 front view, a little above the body's middle
			const fx = -Math.sin(stand.yaw);
			const fz = -Math.cos(stand.yaw);
			const v = [fx - fz * 0.3, 0.2, fz + fx * 0.3];
			const len = Math.hypot(v[0], v[1], v[2]);
			dir = [v[0] / len, v[1] / len, v[2] / len];
		}
		if (box) {
			// the measured body is the truth: fit its projected corners into the free rect
			const corners = [];
			for (const x of [box.min.x, box.max.x])
				for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
			const scratch = new THREE.PerspectiveCamera().copy(cam, false);
			dist = fitToCorners({ cam: scratch, corners, target, dir, dist, viewW: cr.width, viewH: cr.height, free });
		}
		flightDir = dir;
		flightUntil = performance.now() + ms + 50;
		const camPos = [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist];
		cam.setViewOffset(...centreOffset(cr.width, cr.height, free));
		cam.updateProjectionMatrix();
		flyTo(camPos, target, ms);
	}

	/** @param {DOMRect} cr @param {DOMRect | null} pr @param {boolean} sheet */
	function layoutKey(cr, pr, sheet) {
		const r = (/** @type {number} */ n) => Math.round(n);
		return [r(cr.width), r(cr.height), sheet ? 's' : 'd', pr ? [r(pr.left), r(pr.top), r(pr.width), r(pr.height)].join(',') : '-'].join('|');
	}

	/** the box of what the preview DRAWS (visible meshes of the head group and the rigged body),
	 * or null before the model is in @returns {THREE.Box3 | null} */
	function bodyBox() {
		/** @type {any} */
		const scene = get(globalScene) ?? /** @type {any} */ (get(globalCamera))?.parent;
		if (!scene) return null;
		const box = new THREE.Box3();
		for (const name of ['avatar-preview', 'avatar-preview-avatar']) {
			const root = scene.getObjectByName(name);
			if (!root) continue;
			root.updateMatrixWorld(true);
			root.traverseVisible((/** @type {any} */ o) => {
				if (!o.isMesh || !o.geometry) return;
				// the name label turns to face the camera, so its mesh's box changes as you orbit:
				// count where it is anchored (and its text height) instead
				for (let p = o; p && p !== root; p = p.parent)
					if (p.name?.endsWith('-label')) {
						const at = p.getWorldPosition(new THREE.Vector3());
						box.expandByPoint(at.clone().setY(at.y + 0.16)).expandByPoint(at.setY(at.y - 0.14));
						return;
					}
				box.expandByObject(o, false);
			});
		}
		// still parked at its spawn height (the first frame has not placed it yet): not a body
		return !box.isEmpty() && box.min.y < 900 ? box : null;
	}
	/** a coarse key of a box (5 cm), so a model loading or a new look re-frames and jitter does not */
	const boxKey = (/** @type {any} */ b) => (b ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 20)).join(',') : '');
	let framedBox = '';
	/** the direction the camera is flying in, and until when (a re-frame mid-flight keeps it) @type {number[] | null} */
	let flightDir = null;
	let flightUntil = 0;

	// 41 G8: the body itself changes size — its model arrives after the panel opens, and every
	// new look (a preset, a hat, Surprise me) is a different shape: re-frame when its box moves
	$effect(() => {
		if (!open) return;
		const timer = setInterval(() => {
			if (resizing || !stand || get(isVRMode)) return;
			if (boxKey(bodyBox()) !== framedBox) frame(300, true);
		}, 300);
		return () => clearInterval(timer);
	});

	/** the projection back to the plain full-viewport one (leaving, or VR) */
	function unframe() {
		/** @type {any} */
		const cam = get(globalCamera);
		if (!cam?.view) return;
		cam.clearViewOffset();
		cam.updateProjectionMatrix();
	}

	// 41 G8: re-frame on EVERY layout change — the canvas resizing (a window resize, a phone
	// folding or unfolding, the orientation) and the drawer resizing (its grip, the fold flipping
	// it between a side drawer and a bottom sheet). Coalesced to one frame; a layout identical to
	// the one already framed (the observer's first report) changes nothing.
	$effect(() => {
		const el = panelEl;
		const canvas = canvasEl();
		if (!open || !el || typeof ResizeObserver === 'undefined') return;
		let raf = 0;
		const ro = new ResizeObserver(() => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				narrow = window.innerWidth <= 640;
				const cr = canvasEl()?.getBoundingClientRect();
				if (!cr) return;
				const key = layoutKey(cr, panelEl?.getBoundingClientRect() ?? null, window.innerWidth <= 640);
				if (key !== framedFor) frame(resizing ? 0 : 250, true);
			});
		});
		ro.observe(el);
		if (canvas) ro.observe(canvas);
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
		};
	});

	/** @param {PointerEvent} e */
	function startResize(e) {
		if (e.button !== 0) return;
		e.preventDefault();
		resizing = true;
		const x0 = e.clientX;
		const y0 = e.clientY;
		const w0 = panelW();
		const h0 = sheetH();
		// 40 F1: the phone sheet closes like every other one — swiped down to the end, or flicked
		// down from its min (the shared rule, sheetSnap.settleSheet)
		let rawH = h0;
		/** @type {[number, number][]} */
		let samples = [[e.timeStamp, e.clientY]];
		/** @param {PointerEvent} ev */
		const move = (ev) => {
			rawH = h0 - (ev.clientY - y0);
			samples.push([ev.timeStamp, ev.clientY]);
			if (samples.length > 6) samples.shift();
			if (narrow) drawerH = Math.min(Math.max(rawH, MIN_H), maxH());
			else drawerW = Math.min(Math.max(w0 - (ev.clientX - x0), MIN_W), maxW());
		};
		/** @param {PointerEvent} ev */
		const up = (ev) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			resizing = false;
			if (narrow && ev.type === 'pointerup') {
				const first = samples[0];
				const velocity = (ev.clientY - first[1]) / Math.max(1, ev.timeStamp - first[0]);
				if (settleSheet({ height: rawH, velocity, min: MIN_H, max: maxH() }) === 'closed') {
					drawerH = h0; // the height it had: a swipe-away is not a resize
					end(false);
					return;
				}
			}
			safeStorage.setItem(SIZE_KEY, JSON.stringify({ w: drawerW, h: drawerH }));
			frame(200, true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}
	/** keyboard resize on the grip: arrows step 16 px (Shift 64), the separator pattern */
	function keyResize(/** @type {KeyboardEvent} */ e) {
		const step = e.shiftKey ? 64 : 16;
		const grow = narrow ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
		const shrink = narrow ? e.key === 'ArrowDown' : e.key === 'ArrowRight';
		if (!grow && !shrink) return;
		e.preventDefault();
		if (narrow) drawerH = Math.min(Math.max(sheetH() + (grow ? step : -step), MIN_H), maxH());
		else drawerW = Math.min(Math.max(panelW() + (grow ? step : -step), MIN_W), maxW());
		safeStorage.setItem(SIZE_KEY, JSON.stringify({ w: drawerW, h: drawerH }));
	}
	function onWindowResize() {
		narrow = window.innerWidth <= 640;
	}

	/** NOTES-38 #2: Apply AND Cancel put the viewport back EXACTLY where it was. The tween lands on
	 * the saved pose; OrbitControls' damping can still carry a sliver of orbit momentum past it, so
	 * once the flight is over the pose is written once more with damping briefly off (which also
	 * zeroes the momentum) — unless something else has taken the camera meanwhile.
	 * @param {{position: number[], target: number[]}} view @param {number} ms */
	function returnHome(view, ms) {
		flyTo(view.position, view.target, ms);
		setTimeout(() => {
			/** @type {any} */
			const cam = get(globalCamera);
			/** @type {any} */
			const controls = get(orbitControls);
			if (!cam || !controls || open) return;
			const p = cam.position;
			const off = Math.hypot(p.x - view.position[0], p.y - view.position[1], p.z - view.position[2]);
			if (off > 0.25) return; // a new flight or the user's own hands own the camera now
			const damping = controls.enableDamping;
			controls.enableDamping = false;
			controls.update();
			cam.position.fromArray(view.position);
			controls.target.fromArray(view.target);
			controls.update();
			controls.enableDamping = damping;
		}, ms + 80);
	}

	function end(/** @type {boolean} */ apply) {
		if (!open) return;
		if (apply) commit();
		open = false;
		studioOpen.set(false);
		unframe();
		avatarPreview.set(null);
		if (savedView && !get(isVRMode)) {
			returnHome(savedView, 450);
			returning = { ...savedView, until: performance.now() + 500 };
		}
		savedView = null;
		stand = null;
		if (get(characterModalOpen)) characterModalOpen.set(false);
	}

	function pushPreview() {
		if (!stand) return;
		avatarPreview.set({ config: { ...draft }, photo: myPhoto(), position: stand.position, yaw: stand.yaw, walk: false });
	}

	/** @param {Record<string, any>} patch */
	function edit(patch) {
		draft = { ...draft, ...patch };
		// 41 G9: touching any LOOK parameter makes this a custom look (the name label is a pref)
		if (Object.keys(patch).some((k) => /** @type {readonly string[]} */ (LOOK_KEYS).includes(k))) {
			customLook = lookOf(draft);
			selected = 'custom';
		}
		pushPreview();
	}

	/** a preset IS its defaults: picking one resets every look parameter @param {string} id */
	function pickPreset(id) {
		draft = { ...draft, ...presetLook(id) };
		selected = id;
		pushPreview();
	}

	/** back to the look you made (re-picking a preset reset the draft, never the Custom entry) */
	function pickCustom() {
		if (!customLook) return;
		draft = { ...draft, ...customLook };
		selected = 'custom';
		pushPreview();
	}

	/** a NEW random character on every press — body, head, hat, colours — never the last one */
	function surprise() {
		const look = randomLook(draft);
		draft = { ...draft, ...look };
		customLook = lookOf(draft);
		selected = 'custom';
		surprises += 1;
		pushPreview();
	}

	function commit() {
		const next = { ...draft };
		avatarConfig.set(next);
		safeStorage.setItem('avatarConfig', JSON.stringify(next));
		pingColor.set(draftPingColor);
		pingSound.set(draftPingSound);
		/** @type {any} */
		const p = get(peers);
		const id = p?.peer?.id;
		const rows = /** @type {any[]} */ (get(userdata));
		rows.forEach((/** @type {any[]} */ row) => {
			if (row[0] === id) row[5] = next;
		});
		userdata.set(/** @type {any} */ (rows));
		p?.send?.({ type: 'userdata', userdata: rows });
	}

	/** step through the presets (from a custom look: from the body it is built on) @param {number} dir */
	function cycle(dir) {
		const ids = presets.map((p) => p.id);
		const i = Math.max(0, ids.indexOf(draft.character));
		pickPreset(ids[(i + dir + ids.length) % ids.length]);
	}

	function pingHere() {
		if (!stand) return;
		const p = stand.position;
		const fx = -Math.sin(stand.yaw);
		const fz = -Math.cos(stand.yaw);
		// beside the character (its right hand side), so the beam does not stand in front of it
		previewPing([p[0] - fz * 1.3, p[1] - feetBelowHead() + 0.05, p[2] + fx * 1.3], draftPingColor, draftPingSound);
		studioPingUntil.set(performance.now() + PING_TTL); // the studio shows ping markers this long
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (!open || e.key !== 'Escape') return;
		e.stopPropagation();
		end(false);
	}
</script>

<svelte:window onkeydown={onKey} onresize={onWindowResize} />

{#if open}
	<aside
		bind:this={panelEl}
		id="character-panel"
		class="tp-ui cp"
		class:cp-resizing={resizing}
		aria-label="Customize character"
		data-tour="character-panel"
		style:--cp-w={narrow ? null : panelW() + 'px'}
		style:--cp-h={narrow ? sheetH() + 'px' : null}
	>
		<!-- the inner edge: drag (or arrow keys) to resize; the camera re-frames on release. A
		     focusable role=separator IS a widget (WAI-ARIA window splitter); svelte's a11y table
		     does not know it. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			id="character-resize"
			class="cp-grip"
			role="separator"
			aria-orientation={narrow ? 'horizontal' : 'vertical'}
			aria-label="Resize the character drawer"
			aria-valuenow={narrow ? Math.round(sheetH()) : Math.round(panelW())}
			tabindex="0"
			onpointerdown={startResize}
			onkeydown={keyResize}
		></div>
		<WindowChrome size="modal" body={false} title="Customize character">
			{#snippet actions()}
				<Button id="character-close" variant="icon" icon="x" label="Close without applying" title="Close (Esc)" onclick={() => end(false)} />
			{/snippet}
		</WindowChrome>

		<div class="cp-body" use:minimalScroll>
			{#if !$isVRMode}
				<!-- 41 G10: the studio hides the scene; this previews the character IN it instead -->
				<div class="cp-card cp-view">
					<div class="cp-row">
						<span id="character-in-scene-text" class="cp-row-label cp-row-wide">Show in scene</span>
						<Toggle
							id="character-show-in-scene"
							labelledby="character-in-scene-text"
							title="Off: a plain studio around your character. On: your character in the current scene."
							checked={$studioInScene}
							onchange={(/** @type {boolean} */ on) => studioInScene.set(on)}
						/>
					</div>
				</div>
			{/if}
			<section>
				<h3 class="cp-label">Character</h3>
				<div class="cp-cycle">
					<Button variant="icon" size="sm" icon="chevron-left" label="Previous character" onclick={() => cycle(-1)} />
					<span id="character-current" class="cp-current" data-selected={selected}>{shownName}</span>
					<Button variant="icon" size="sm" icon="chevron-right" label="Next character" onclick={() => cycle(1)} />
				</div>
				<!-- 41 G9: a NEW random character every press (body, head, hat, colours) -->
				<div class="cp-surprise">
					<Button id="character-surprise" variant="outline" size="sm" icon="wand-sparkles" title="A new random character every press" onclick={surprise}
						>Surprise me</Button
					>
					<span class="cp-sr" aria-live="polite">{surprises ? `New look: ${shownName}` : ''}</span>
				</div>
				<div class="cp-chips" role="radiogroup" aria-label="Character">
					{#if customLook}
						<button type="button" class="cp-chip" role="radio" aria-checked={selected === 'custom'} data-character="custom" title="The look you made" onclick={pickCustom}
							>Custom</button
						>
					{/if}
					{#each presets as p (p.id)}
						<button
							type="button"
							class="cp-chip"
							role="radio"
							aria-checked={selected === p.id}
							data-character={p.id}
							title={p.id === 'auto' ? 'Picked from your id — what peers see you as by default' : `${p.name} with its own look`}
							onclick={() => pickPreset(p.id)}>{p.name}</button
						>
					{/each}
				</div>
			</section>

			<section>
				<h3 class="cp-label">Head</h3>
				<div class="cp-chips" role="radiogroup" aria-label="Head">
					{#if rigged}
						<button type="button" class="cp-chip" role="radio" aria-checked={draft.face !== 'image' && draft.head === 'character'} data-head="character" onclick={() => edit({ head: 'character', face: 'label' })}
							>Character's own</button
						>
					{/if}
					{#each CLASSIC_SHAPES as o (o.value)}
						<button
							type="button"
							class="cp-chip"
							role="radio"
							aria-checked={draft.face !== 'image' && (rigged ? draft.head === o.value : draft.shape === o.value)}
							data-head={o.value}
							onclick={() => edit(rigged ? { head: o.value, face: 'label' } : { shape: o.value, face: 'label' })}>{o.name}</button
						>
					{/each}
					<button
						type="button"
						class="cp-chip"
						role="radio"
						aria-checked={draft.face === 'image'}
						data-head="photo"
						disabled={!hasPhoto}
						title={hasPhoto ? 'Your profile photo on a card' : 'Add a profile photo in Profile Settings first'}
						onclick={() => edit({ face: 'image' })}>My photo</button
					>
				</div>
			</section>

			<section>
				<h3 class="cp-label">Hat</h3>
				<div class="cp-chips" role="radiogroup" aria-label="Hat">
					{#each HATS as o (o.value)}
						<button type="button" class="cp-chip" role="radio" aria-checked={draft.hat === o.value} data-hat={o.value} onclick={() => edit({ hat: o.value })}>{o.name}</button>
					{/each}
				</div>
			</section>

			<section>
				<h3 class="cp-label">Colours</h3>
				<div class="cp-card">
					{#if rigged}
						<div class="cp-row">
							<span class="cp-row-label">Outfit</span>
							<input
								id="character-outfit"
								type="color"
								value={draft.outfit || AVATAR_DEFAULTS.body}
								oninput={(e) => edit({ outfit: e.currentTarget.value })}
								aria-label="Outfit colour"
							/>
							<button type="button" class="cp-chip" aria-pressed={!draft.outfit} disabled={!draft.outfit} onclick={() => edit({ outfit: '' })}>Original</button>
						</div>
					{/if}
					<div class="cp-row">
						<span class="cp-row-label">{rigged ? 'Head' : 'Body'}</span>
						<input id="character-body" type="color" value={draft.body} oninput={(e) => edit({ body: e.currentTarget.value })} aria-label="Head and body colour" />
					</div>
					<div class="cp-row">
						<span id="character-label-text" class="cp-row-label cp-row-wide">Show my name above me</span>
						<Toggle
							id="character-show-label"
							labelledby="character-label-text"
							checked={!!draft.showLabel}
							onchange={(/** @type {boolean} */ on) => edit({ showLabel: on })}
						/>
					</div>
				</div>
			</section>

			<section>
				<h3 class="cp-label">Ping</h3>
				<div class="cp-card">
					<div class="cp-row">
						<span class="cp-row-label">Colour</span>
						<input id="character-ping-color" type="color" value={draftPingColor || AVATAR_DEFAULTS.body} oninput={(e) => (draftPingColor = e.currentTarget.value)} aria-label="Ping colour" />
						<button type="button" class="cp-chip" aria-pressed={!draftPingColor} disabled={!draftPingColor} onclick={() => (draftPingColor = '')}>My peer colour</button>
					</div>
					<div class="cp-row">
						<span class="cp-row-label">Sound</span>
						<select id="character-ping-sound" class="cp-select" value={draftPingSound} onchange={(e) => { draftPingSound = e.currentTarget.value; playPing(draftPingSound); }}>
							{#each PING_SOUNDS as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
						</select>
						<Button id="character-ping-preview" variant="outline" size="sm" icon="play" title="Ping beside your character (only you see and hear it)" onclick={pingHere}>Preview</Button>
					</div>
				</div>
				<p class="cp-note">Peers see and hear your pings this way.</p>
			</section>
		</div>

		<footer class="cp-foot">
			<Button id="character-cancel" variant="outline" onclick={() => end(false)}>Cancel</Button>
			<Button id="character-apply" variant="primary" onclick={() => end(true)}>Apply</Button>
		</footer>
	</aside>
{/if}

<style>
	.cp {
		position: fixed;
		right: 0;
		top: 64px;
		bottom: calc(var(--bottom-inset, 0px) + var(--controls-inset, 0px));
		width: min(var(--cp-w, 340px), 92vw);
		z-index: calc(var(--z-bottom, 35) - 1);
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		border-right: none;
		border-radius: var(--radius-modal) 0 0 var(--radius-modal);
		box-shadow: var(--shadow-window);
		font-family: var(--font-ui);
		font-size: var(--fs-body);
	}
	@media (min-width: 641px) {
		:global(:root.connect-docked) .cp {
			top: calc(var(--connect-bottom, 0px) + 4px);
			z-index: 1000;
		}
	}
	/* narrow: a bottom sheet, so the character stays visible above it */
	@media (max-width: 640px) {
		.cp {
			top: auto;
			left: 0;
			width: 100vw;
			height: var(--cp-h, min(52vh, 460px));
			bottom: var(--controls-inset, 0px);
			border-radius: var(--radius-modal) var(--radius-modal) 0 0;
			border-right: 1px solid var(--border);
		}
	}
	.cp > :global(.wc) {
		flex-shrink: 0;
		background: transparent;
		border: 0;
		border-radius: 0;
	}
	/* the drag edge: the drawer's inner (left) edge, the sheet's top edge on a phone */
	.cp-grip {
		position: absolute;
		left: -4px;
		top: 0;
		bottom: 0;
		width: 8px;
		z-index: 2;
		cursor: ew-resize;
		touch-action: none;
	}
	.cp-grip::after {
		content: '';
		position: absolute;
		left: 3px;
		top: 50%;
		width: 2px;
		height: 40px;
		margin-top: -20px;
		border-radius: var(--radius-pill);
		background: var(--border-strong);
		opacity: 0;
		transition: opacity 0.15s ease;
	}
	.cp-grip:hover::after,
	.cp-grip:focus-visible::after,
	.cp-resizing .cp-grip::after {
		opacity: 1;
		background: var(--accent);
	}
	@media (max-width: 640px) {
		.cp-grip {
			left: 0;
			right: 0;
			top: -4px;
			bottom: auto;
			width: auto;
			height: 20px;
			cursor: ns-resize;
		}
		/* the sheet's grab handle, always shown */
		.cp-grip::after {
			left: 50%;
			top: 10px;
			width: 40px;
			height: 4px;
			margin: 0 0 0 -20px;
			opacity: 1;
		}
	}
	.cp-resizing {
		user-select: none;
	}
	.cp-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-1) var(--space-5) var(--space-4);
	}
	section {
		padding: var(--space-3) 0;
	}
	section + section {
		border-top: 1px solid var(--border);
	}
	.cp-label {
		margin: 0 0 var(--space-2);
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.cp-cycle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.cp-current {
		flex: 1;
		text-align: center;
		font-weight: 600;
	}
	.cp-surprise {
		display: flex;
		align-items: center;
		margin-bottom: var(--space-2);
	}
	.cp-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.cp-view {
		margin-top: var(--space-3);
	}
	/* 41 G10: the overlays drawn over the 3D view stand down while the studio hides the scene */
	:global(:root.character-studio .marker-layer),
	:global(:root.character-studio .marker-lines),
	:global(:root.character-studio #hud-layer) {
		visibility: hidden;
	}
	.cp-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	/* SPEC Chips: pill, border-strong; selected = accent-soft fill + accent border */
	.cp-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: var(--control-h-sm);
		padding: 0 12px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text-2);
		font: inherit;
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.cp-chip:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	.cp-chip[aria-checked='true'],
	.cp-chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.cp-chip:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.cp-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.cp-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: var(--row-h);
		padding: var(--space-1) var(--space-3);
	}
	.cp-row + .cp-row {
		border-top: 1px solid var(--border);
	}
	.cp-row-label {
		width: 3.6rem;
		color: var(--text-2);
		font-size: var(--fs-desc);
	}
	.cp-row-wide {
		flex: 1;
		width: auto;
		color: var(--text);
		font-size: var(--fs-body);
	}
	.cp-row input[type='color'] {
		width: 2.6rem;
		height: 1.9rem;
		padding: 0 2px;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-input);
		background: var(--surface-inset);
		cursor: pointer;
	}
	.cp-select {
		flex: 1;
		min-width: 0;
		height: var(--control-h-sm);
		padding: 0 8px;
		border-radius: var(--radius-input);
		border: 1px solid var(--border-input);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-input);
	}
	.cp-note {
		font-size: var(--fs-desc);
		color: var(--text-muted);
		margin: var(--space-2) 0 0;
	}
	.cp-foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		flex-shrink: 0;
		padding: var(--space-3) var(--space-5);
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 85%, var(--bg-app));
	}
</style>
