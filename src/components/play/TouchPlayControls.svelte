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
	// EVERY LISTENER IS DIRECT AND ON THE WINDOW, for two documented reasons: svelte
	// DELEGATES attribute handlers, so panel chrome swallows them on the way up, and the
	// Threlte Canvas wrapper eats pointermove/pointerup mid-gesture.
	//
	// THE HALVES DRAW NOTHING THEY CATCH. The stick visuals are `pointer-events: none`
	// and the gesture is decided from the window listener by coordinate, so this overlay
	// swallows no click that was not aimed at the 3D canvas: a HUD button, a toast and a
	// modal are all still reachable with a finger, and a hybrid device's MOUSE is
	// untouched (a gesture is claimed only for `pointerType === 'touch'`).
	import { onMount, untrack } from 'svelte';
	import { X } from '@lucide/svelte';
	import { isLocked, isVRMode, playPointerFree } from '../../stores/sceneStore';
	import { coarsePointer } from '$lib/inputDevice';
	import { inputClaims } from '$lib/inputRuntime';
	import { exitPlay } from '$lib/playMode';
	import {
		TOUCH_STICK_RADIUS,
		TOUCH_TAP_SLOP,
		touchMove,
		touchSticks,
		pushTouchLook,
		resetTouchInput,
		stickAxes
	} from '$lib/touchControls';

	// matchMedia is read ONCE on mount rather than at module scope: the module evaluates
	// during the SSR prerender, where there is no window at all.
	let coarse = $state(false);
	onMount(() => {
		coarse = coarsePointer();
		if (!window.matchMedia) return;
		const query = window.matchMedia('(pointer: coarse)');
		const onChange = () => (coarse = query.matches);
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	});

	const playing = $derived($isLocked === true && !$isVRMode);
	const shown = $derived(playing && coarse);
	// The sticks stand down where the movement code they feed stands down, and nowhere
	// else. `keys` is the claim PointerLockControls' own task honours — a module driving
	// movement (possess) owns the thumb for the same reason it owns WASD. 'locomotion'
	// is deliberately NOT consulted: PLC's keyboard does not consult it either, and a
	// stick that stopped where the keyboard kept going would move the same scene two
	// different ways depending on the device.
	const inputLive = $derived(shown && !$playPointerFree && !$inputClaims.includes('keys'));

	/** @type {{id: number, ox: number, oy: number} | null} */
	let moveTouch = null;
	/** @type {{id: number, x: number, y: number, t: number, travel: number} | null} */
	let lookTouch = null;

	function clearGestures() {
		moveTouch = null;
		lookTouch = null;
		resetTouchInput();
	}

	// A stick may not survive the thing that turned it off. Same discipline as the pad's
	// `quietPad` and for the same failure: a finger still down when a menu opens (or when
	// a peer stops the game) would otherwise leave the axes deflected forever.
	$effect(() => {
		if (inputLive) return;
		untrack(() => clearGestures());
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

	/** @param {PointerEvent} event */
	function onPointerDown(event) {
		if (!inputLive || event.pointerType !== 'touch' || !onCanvas(event.target)) return;
		const left = event.clientX < window.innerWidth / 2;
		// ONE stick per half: a second finger on the same side is ignored rather than
		// stealing the first, so resting a palm cannot teleport the stick out from under
		// the thumb that is steering.
		if (left) {
			if (moveTouch) return;
			moveTouch = { id: event.pointerId, ox: event.clientX, oy: event.clientY };
			touchSticks.update((s) => ({
				...s,
				move: { ox: event.clientX, oy: event.clientY, x: event.clientX, y: event.clientY }
			}));
		} else {
			if (lookTouch) return;
			lookTouch = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, travel: 0 };
			touchSticks.update((s) => ({ ...s, look: { x: event.clientX, y: event.clientY } }));
		}
	}

	/** @param {PointerEvent} event */
	function onPointerMove(event) {
		if (moveTouch && event.pointerId === moveTouch.id) {
			const axes = stickAxes(event.clientX - moveTouch.ox, event.clientY - moveTouch.oy);
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
	 * look, which is the convention a player already has in their thumbs.
	 * @param {PointerEvent} event
	 */
	function onPointerUp(event) {
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
		window.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp, true);
		window.addEventListener('pointercancel', onPointerUp, true);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp, true);
			window.removeEventListener('pointercancel', onPointerUp, true);
			clearGestures();
		};
	});

	const sticks = $derived($touchSticks);
	const nub = $derived.by(() => {
		const move = sticks.move;
		if (!move) return { x: 0, y: 0 };
		return stickAxes(move.x - move.ox, move.y - move.oy);
	});
</script>

{#if shown}
	<!-- presentation only, and never in the way: the halves catch nothing (the window
	     listeners above decide), so a HUD button under a thumb still wins. -->
	<div class="touch-play" aria-hidden="true">
		{#if sticks.move}
			<div
				id="touch-move-stick"
				class="stick-base"
				style:left="{sticks.move.ox}px"
				style:top="{sticks.move.oy}px"
			>
				<div
					class="stick-nub"
					style:transform="translate(-50%, -50%) translate({nub.x * TOUCH_STICK_RADIUS}px, {nub.y *
						TOUCH_STICK_RADIUS}px)"
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
		<X size={20} aria-hidden="true" />
	</button>
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
	.stick-base {
		position: absolute;
		width: 128px;
		height: 128px;
		margin: -64px 0 0 -64px;
		border-radius: 9999px;
		border: 2px solid rgba(255, 255, 255, 0.35);
		background: rgba(0, 0, 0, 0.18);
		box-shadow: 0 0 6px rgba(0, 0, 0, 0.4);
	}
	.stick-nub {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 52px;
		height: 52px;
		border-radius: 9999px;
		background: rgba(255, 255, 255, 0.5);
		box-shadow: 0 0 6px rgba(0, 0, 0, 0.5);
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
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(17, 24, 39, 0.72);
		color: var(--icon-strong, #e5e7eb);
		backdrop-filter: blur(4px);
		/* ONE above the HUD: this is the only piece of play chrome that must outrank an
		   authored overlay, because a game whose menu covers it leaves the player with no
		   way out but the Back button. It still loses to modal / toast / menu, so an
		   approval toast covers it exactly as it covers the HUD. */
		z-index: calc(var(--z-hud, 45) + 1);
		touch-action: manipulation;
	}
	.play-exit:active {
		background: rgba(31, 41, 55, 0.9);
	}
</style>
