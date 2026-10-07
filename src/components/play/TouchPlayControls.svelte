<script>
	// W4: PLAY MODE ON A PHONE. Desktop play had no input path at all on touch —
	// pointer lock does not exist there, so there was no look; there is no keyboard, so
	// there was no movement; and there is no Escape, so there was no way out. This is
	// the standard mobile-FPS answer: the LEFT half of the viewport is a virtual move
	// stick, the RIGHT half is a look drag, and a ✕ leaves.
	//
	// It is deliberately NOT a new movement implementation. Every gesture here writes
	// into `touchControls`, which PointerLockControls folds into the same two places it
	// already reads the gamepad and the mouse — so walk mode, the grounded pin, the
	// dungeon wall slide, the 'keys' input claim and the E3 menu substate all apply to a
	// thumb exactly as they apply to WASD, because they gate the code the thumb feeds.
	//
	// 36 U8: AND THE GAME'S ACTION BUTTONS. The buttons are the game's INPUT ACTIONS
	// (touchSpec: what a module declared through api.input.actions, else what the scene
	// implies — a walking controller's jump, Key Press nodes), placed by the player's saved
	// layout (touchActions), and a press goes down the same seams a keyboard or a mouse
	// does (pressTouchAction). The stick, the look and any number of buttons are separate
	// pointers, so a thumb on the stick and two fingers on buttons all work at once.
	// Visibility is a setting (Auto / Always / Never); in the editor the buttons show only
	// with "Show in edit", and the stick and look never do.
	//
	// EVERY LISTENER IS DIRECT AND ON THE WINDOW, for two documented reasons: svelte
	// DELEGATES attribute handlers, so panel chrome swallows them on the way up, and the
	// Threlte Canvas wrapper eats pointermove/pointerup mid-gesture.
	//
	// THE HALVES DRAW NOTHING THEY CATCH. The stick visuals are `pointer-events: none`
	// and the gesture is decided from the window listener by coordinate, so this overlay
	// swallows no click that was not aimed at the 3D canvas: a HUD button, a toast and a
	// modal are all still reachable with a finger, and a hybrid device's MOUSE is
	// untouched (a gesture is claimed only for `pointerType === 'touch'`). A BUTTON is the
	// one thing that catches: a press on it is the button's, end to end — stopped in the
	// window's capture phase, so playInteract never reads the same finger as a world tap.
	import { onMount, untrack } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { isLocked, isVRMode, playPointerFree, globalRenderer } from '../../stores/sceneStore';
	import { coarsePointer } from '$lib/inputDevice';
	import { inputClaims } from '$lib/inputRuntime';
	import { exitPlay } from '$lib/playMode';
	import { gameId } from '$lib/gameSettings';
	import {
		TOUCH_STICK_RADIUS,
		TOUCH_TAP_SLOP,
		touchMove,
		touchSticks,
		pushTouchLook,
		resetTouchInput,
		stickAxes
	} from '$lib/touchControls';
	import {
		TOUCH_ACTION_EVENT,
		touchPrefs,
		touchSeen,
		touchWanted,
		touchControlsVisible,
		touchLayouts,
		touchTextures,
		touchLayoutEditorOpen,
		savedLayoutFor,
		effectiveTouchLayout,
		pressTouchAction,
		releaseAllTouchActions
	} from '$lib/touchActions';
	import { touchSpec } from '$lib/touchSpec';
	import TouchActionButton from './TouchActionButton.svelte';
	import TouchLayoutEditor from './TouchLayoutEditor.svelte';

	// matchMedia is read ONCE on mount rather than at module scope: the module evaluates
	// during the SSR prerender, where there is no window at all.
	let coarse = $state(false);
	let viewW = $state(1280);
	let viewH = $state(720);
	onMount(() => {
		coarse = coarsePointer();
		const onResize = () => {
			viewW = window.innerWidth;
			viewH = window.innerHeight;
		};
		onResize();
		window.addEventListener('resize', onResize);
		if (!window.matchMedia) return () => window.removeEventListener('resize', onResize);
		const query = window.matchMedia('(pointer: coarse)');
		const onChange = () => (coarse = query.matches);
		query.addEventListener('change', onChange);
		return () => {
			query.removeEventListener('change', onChange);
			window.removeEventListener('resize', onResize);
		};
	});

	const wanted = $derived(touchWanted($touchPrefs.visibility, coarse, $touchSeen));
	$effect(() => touchControlsVisible.set(wanted));
	const playing = $derived($isLocked === true && !$isVRMode);
	const editing = $derived($touchLayoutEditorOpen);
	const shown = $derived(playing && wanted && !editing);
	const spec = $derived($touchSpec);
	// The sticks stand down where the movement code they feed stands down, and nowhere
	// else. `keys` is the claim PointerLockControls' own task honours — a module driving
	// movement (possess) owns the thumb for the same reason it owns WASD. 'locomotion'
	// is deliberately NOT consulted: PLC's keyboard does not consult it either, and a
	// stick that stopped where the keyboard kept going would move the same scene two
	// different ways depending on the device.
	const inputLive = $derived(shown && !$playPointerFree && !$inputClaims.includes('keys'));
	const stickLive = $derived(inputLive && spec.stick);
	const lookLive = $derived(inputLive && spec.look);
	// buttons: in play while the menu substate is not up (a module's key claim does NOT
	// stop them — it still reads keys through api.onInput), or in the editor when asked
	const buttonsShown = $derived(
		wanted && !editing && !$isVRMode && spec.actions.length > 0 && (playing ? !$playPointerFree : $touchPrefs.showInEdit)
	);
	const layout = $derived(effectiveTouchLayout(spec, savedLayoutFor($touchLayouts, $gameId), viewW, viewH));
	const stickItem = $derived(layout.items.stick);
	const stickRadius = $derived((stickItem?.size ?? TOUCH_STICK_RADIUS * 2) / 2);

	/** @type {{id: number, ox: number, oy: number} | null} */
	let moveTouch = null;
	/** @type {{id: number, x: number, y: number, t: number, travel: number} | null} */
	let lookTouch = null;
	/** buttons held, by pointer id → action id */
	/** @type {Map<number, string>} */
	const buttonTouches = new Map();
	let pressedIds = $state(/** @type {string[]} */ ([]));

	function canvasEl() {
		return /** @type {any} */ ($globalRenderer)?.domElement ?? null;
	}

	function releaseButtons() {
		buttonTouches.clear();
		pressedIds = [];
		releaseAllTouchActions({ canvas: canvasEl() });
	}

	function clearGestures() {
		moveTouch = null;
		lookTouch = null;
		resetTouchInput();
	}

	// A stick may not survive the thing that turned it off. Same discipline as the pad's
	// `quietPad` and for the same failure: a finger still down when a menu opens (or when
	// a peer stops the game) would otherwise leave the axes deflected forever.
	$effect(() => {
		if (stickLive && lookLive) return;
		untrack(() => {
			if (!stickLive) {
				moveTouch = null;
				if (!lookLive) clearGestures();
				else {
					touchMove.set({ x: 0, y: 0 });
					touchSticks.update((s) => ({ ...s, move: null }));
				}
			} else if (!lookLive) {
				lookTouch = null;
				touchSticks.update((s) => ({ ...s, look: null }));
			}
		});
	});
	// ...and a held button may not survive its own disappearance (a held Space is a key
	// held forever).
	$effect(() => {
		if (buttonsShown) return;
		untrack(() => releaseButtons());
	});

	// THE CANVAS MUST NOT SCROLL WHILE PLAYING, and nothing was saying so. OrbitControls
	// sets `touch-action: none` on the renderer's canvas for its own sake — and it stands
	// down in play mode, so play left the canvas on `auto` under a body of
	// `pan-x pan-y`. Chromium then reads the second move of any drag as a page scroll and
	// fires POINTERCANCEL: measured, the first pointermove arrived and every one after it
	// was dropped, so a stick applied for a single frame and a look drag turned a third of
	// the way. Scoped to the class, so the editor's own touch behaviour is untouched.
	$effect(() => {
		if (!shown || typeof document === 'undefined') return;
		document.documentElement.classList.add('touch-play-on');
		return () => document.documentElement.classList.remove('touch-play-on');
	});

	/** A touch aimed at the 3D view — never at a button, a HUD control or a panel.
	 * Deciding by TARGET rather than by geometry is what keeps every piece of UI in
	 * front of the viewport reachable with no list of exceptions to maintain.
	 * @param {EventTarget | null} target */
	function onCanvas(target) {
		return target instanceof Element && target.tagName === 'CANVAS';
	}

	/** @param {EventTarget | null} target @returns {string | null} */
	function buttonOf(target) {
		if (!(target instanceof Element)) return null;
		const el = target.closest('[data-touch-btn]');
		return el ? el.getAttribute('data-touch-btn') : null;
	}

	/** @param {string} id */
	function actionById(id) {
		return spec.actions.find((a) => a.id === id) ?? null;
	}

	/**
	 * CAPTURE phase on the window: a press on a BUTTON is decided before anything else
	 * sees the finger (playInteract would otherwise read it as a world press), and the
	 * auto visibility learns that this device has a touch screen.
	 * @param {PointerEvent} event
	 */
	function onPointerDownCapture(event) {
		if (/** @type {any} */ (event)[TOUCH_ACTION_EVENT]) return;
		if (event.pointerType === 'touch' && !$touchSeen) touchSeen.set(true);
		if (!buttonsShown) return;
		const id = buttonOf(event.target);
		if (!id) return;
		const action = actionById(id);
		event.preventDefault();
		event.stopPropagation();
		if (!action || [...buttonTouches.values()].includes(id)) return;
		buttonTouches.set(event.pointerId, id);
		pressedIds = [...pressedIds, id];
		pressTouchAction(action, true, { canvas: canvasEl(), haptics: $touchPrefs.haptics });
	}

	/** @param {PointerEvent} event */
	function onPointerDown(event) {
		if (/** @type {any} */ (event)[TOUCH_ACTION_EVENT]) return;
		if (!inputLive || event.pointerType !== 'touch' || !onCanvas(event.target)) return;
		// the stick owns the left half (or its own base, wherever the player put it); with
		// no stick the whole view looks
		const nearBase =
			stickItem &&
			Math.hypot(event.clientX - stickItem.x * viewW, event.clientY - stickItem.y * viewH) <= stickRadius * 1.25;
		const left = stickLive && (nearBase || event.clientX < window.innerWidth / 2);
		// ONE stick per half: a second finger on the same side is ignored rather than
		// stealing the first, so resting a palm cannot teleport the stick out from under
		// the thumb that is steering.
		if (left) {
			if (moveTouch) return;
			// a touch ON the drawn base steers from its centre (a fixed stick); anywhere
			// else in the half the stick floats to the thumb (W4's behaviour)
			const ox = nearBase ? stickItem.x * viewW : event.clientX;
			const oy = nearBase ? stickItem.y * viewH : event.clientY;
			moveTouch = { id: event.pointerId, ox, oy };
			if (nearBase) touchMove.set(stickAxes(event.clientX - ox, event.clientY - oy, stickRadius));
			touchSticks.update((s) => ({ ...s, move: { ox, oy, x: event.clientX, y: event.clientY } }));
		} else if (lookLive) {
			if (lookTouch) return;
			lookTouch = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, travel: 0 };
			touchSticks.update((s) => ({ ...s, look: { x: event.clientX, y: event.clientY } }));
		}
	}

	/** @param {PointerEvent} event */
	function onPointerMove(event) {
		if (moveTouch && event.pointerId === moveTouch.id) {
			const axes = stickAxes(event.clientX - moveTouch.ox, event.clientY - moveTouch.oy, stickRadius);
			touchMove.set(axes);
			const { ox, oy } = moveTouch;
			touchSticks.update((s) => ({ ...s, move: { ox, oy, x: event.clientX, y: event.clientY } }));
			return;
		}
		if (lookTouch && event.pointerId === lookTouch.id) {
			const dx = event.clientX - lookTouch.x;
			const dy = event.clientY - lookTouch.y;
			lookTouch.x = event.clientX;
			lookTouch.y = event.clientY;
			lookTouch.travel += Math.hypot(dx, dy);
			// ACCUMULATED, not stored: several moves land between two frames and keeping
			// only the last would make a fast swipe turn less than a slow one over the
			// same distance.
			pushTouchLook(dx, dy);
			touchSticks.update((s) => ({ ...s, look: { x: event.clientX, y: event.clientY } }));
		}
	}

	/**
	 * CAPTURE phase, so this runs before playInteract's own window listener, and the
	 * two agree through the EVENT — `defaultPrevented` — never a one-shot store flag.
	 * That is this codebase's convention for two handlers claiming one input (the
	 * twin-Escape lesson), and it is exactly what playInteract itself does to
	 * PointerLockControls over the wheel.
	 *
	 * What is claimed: every left-half gesture (the movement pad is not a trigger), and a
	 * right-half gesture that TRAVELLED. What is not: a still tap on the right, which
	 * falls through to playInteract and fires the object click — tap to interact, drag to
	 * look, which is the convention a player already has in their thumbs. A button's
	 * release is the button's alone (stopped, like its press).
	 * @param {PointerEvent} event
	 */
	function onPointerUp(event) {
		if (/** @type {any} */ (event)[TOUCH_ACTION_EVENT]) return;
		const held = buttonTouches.get(event.pointerId);
		if (held) {
			buttonTouches.delete(event.pointerId);
			pressedIds = pressedIds.filter((id) => id !== held);
			const action = actionById(held);
			if (action) pressTouchAction(action, false, { canvas: canvasEl() });
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (moveTouch && event.pointerId === moveTouch.id) {
			moveTouch = null;
			touchMove.set({ x: 0, y: 0 });
			touchSticks.update((s) => ({ ...s, move: null }));
			event.preventDefault();
			return;
		}
		if (lookTouch && event.pointerId === lookTouch.id) {
			// TRAVEL alone — see TOUCH_TAP_SLOP for why the duration test that used to sit
			// beside it was measured out rather than tuned.
			const dragged = lookTouch.travel > TOUCH_TAP_SLOP;
			lookTouch = null;
			touchSticks.update((s) => ({ ...s, look: null }));
			if (dragged) event.preventDefault();
		}
	}

	onMount(() => {
		window.addEventListener('pointerdown', onPointerDownCapture, true);
		window.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp, true);
		window.addEventListener('pointercancel', onPointerUp, true);
		window.addEventListener('blur', releaseButtons);
		return () => {
			window.removeEventListener('pointerdown', onPointerDownCapture, true);
			window.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp, true);
			window.removeEventListener('pointercancel', onPointerUp, true);
			window.removeEventListener('blur', releaseButtons);
			clearGestures();
			releaseButtons();
		};
	});

	const sticks = $derived($touchSticks);
	const nub = $derived.by(() => {
		const move = sticks.move;
		if (!move) return { x: 0, y: 0 };
		return stickAxes(move.x - move.ox, move.y - move.oy, stickRadius);
	});

	/** keep a placed control fully on screen whatever the viewport did since it was saved
	 * @param {number} frac @param {number} span @param {number} size */
	function placed(frac, span, size) {
		return Math.min(span - size / 2 - 4, Math.max(size / 2 + 4, frac * span));
	}
</script>

{#if shown}
	<!-- presentation only, and never in the way: the halves catch nothing (the window
	     listeners above decide), so a HUD button under a thumb still wins. -->
	<div class="touch-play" aria-hidden="true">
		{#if stickLive && stickItem && !stickItem.hidden && !sticks.move}
			<div
				class="touch-stick-rest"
				style:left="{placed(stickItem.x, viewW, stickItem.size)}px"
				style:top="{placed(stickItem.y, viewH, stickItem.size)}px"
				style:width="{stickItem.size}px"
				style:height="{stickItem.size}px"
				style:opacity={stickItem.opacity * 0.7}
			></div>
		{/if}
		{#if sticks.move}
			<div
				id="touch-move-stick"
				class="stick-base"
				style:left="{sticks.move.ox}px"
				style:top="{sticks.move.oy}px"
				style:width="{stickRadius * 2}px"
				style:height="{stickRadius * 2}px"
				style:opacity={stickItem?.opacity ?? 1}
			>
				<div
					class="stick-nub"
					style:transform="translate(-50%, -50%) translate({nub.x * stickRadius}px, {nub.y * stickRadius}px)"
				></div>
			</div>
		{/if}
	</div>
	<button
		id="play-exit"
		class="play-exit"
		aria-label="Exit play"
		title="Exit play"
		onclick={exitPlay}
	>
		<Icon name="x" size={20} aria-hidden="true" />
	</button>
{/if}

{#if buttonsShown}
	<div id="touch-actions" class="touch-actions" class:in-editor={!playing}>
		{#each spec.actions as action (action.id)}
			{@const item = layout.items['btn:' + action.id]}
			{#if item && !item.hidden}
				<button
					type="button"
					id={'touch-btn-' + action.id.replace(/[^\w-]/g, '_')}
					class="touch-btn"
					data-touch-btn={action.id}
					data-hud-avoid
					aria-label={action.label}
					title={action.label}
					style:left="{placed(item.x, viewW, item.size)}px"
					style:top="{placed(item.y, viewH, item.size)}px"
					style:width="{item.size}px"
					style:height="{item.size}px"
				>
					<TouchActionButton
						{action}
						size={item.size}
						pressed={pressedIds.includes(action.id)}
						texture={$touchTextures[action.id] ?? null}
						opacity={item.opacity}
					/>
				</button>
			{/if}
		{/each}
	</div>
{/if}

{#if editing}
	<TouchLayoutEditor />
{/if}

<style>
	/* see the effect that adds this class: without it Chromium cancels the pointer on
	   the second move of every drag, and the halves get one frame of input each. */
	:global(html.touch-play-on canvas) {
		touch-action: none;
	}
	.touch-play {
		position: fixed;
		inset: 0;
		pointer-events: none;
		/* the viewport band the PlayReticle uses: every panel, HUD element and toast
		   draws over it, which is right for a decoration that catches nothing */
		z-index: 2;
		touch-action: none;
	}
	.stick-base,
	.touch-stick-rest {
		position: absolute;
		transform: translate(-50%, -50%);
		border-radius: 9999px;
		border: 2px solid color-mix(in srgb, var(--text) 45%, transparent);
		background: color-mix(in srgb, var(--bg-app) 22%, transparent);
		box-shadow: 0 0 6px color-mix(in srgb, var(--bg-app) 40%, transparent);
		box-sizing: border-box;
	}
	.touch-stick-rest {
		border-style: dashed;
	}
	.stick-nub {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 41%;
		height: 41%;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--text) 55%, transparent);
		box-shadow: 0 0 6px color-mix(in srgb, var(--bg-app) 50%, transparent);
	}
	.touch-actions {
		position: fixed;
		inset: 0;
		pointer-events: none;
		/* the HUD band, one under the ✕: buttons are play chrome a game's own HUD must not
		   bury, and they still lose to modal / toast / menu */
		z-index: var(--z-hud, 45);
	}
	.touch-actions.in-editor {
		z-index: 3;
	}
	.touch-btn {
		position: absolute;
		transform: translate(-50%, -50%);
		padding: 0;
		margin: 0;
		border: 0;
		background: transparent;
		pointer-events: auto;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		-webkit-tap-highlight-color: transparent;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.touch-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 9999px;
	}
	.play-exit {
		position: fixed;
		top: max(12px, env(safe-area-inset-top));
		right: max(12px, env(safe-area-inset-right));
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 72%, transparent);
		color: var(--text);
		backdrop-filter: blur(4px);
		/* ONE above the HUD: this is the only piece of play chrome that must outrank an
		   authored overlay, because a game whose menu covers it leaves the player with no
		   way out but the Back button. It still loses to modal / toast / menu, so an
		   approval toast covers it exactly as it covers the HUD. */
		z-index: calc(var(--z-hud, 45) + 1);
		touch-action: manipulation;
	}
	/* 36 U8: in a GAME the corner Menu button (GameShellMenu) owns the top-right, and the ✕
	   sat buried under it (measured in every game screenshot) — so it moves to the top-left */
	:global(body:has(#game-shell-menu-button)) .play-exit {
		right: auto;
		left: max(12px, env(safe-area-inset-left));
	}
	.play-exit:active {
		background: color-mix(in srgb, var(--surface-2) 90%, transparent);
	}
</style>
