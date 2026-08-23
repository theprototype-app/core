<script>
	// A2 — the HUD render layer. Mounted at the App root BESIDE <DungeonMinimap />, OUTSIDE
	// the `{#if !$isLocked}` block: a game HUD that dies the moment you press play is no HUD
	// at all, and every editor window in that block is correctly hidden in Play mode.
	//
	// `position: fixed; inset: 0; pointer-events: none; z-index: var(--z-hud)` — NO NEW TIER.
	// --z-hud is 45 ("toolbar pills, play button, burger"): it beats the camera PiP
	// (deliberately z-index 2) and LOSES to modal/toast/menu, which is right — an approval
	// toast must beat a game HUD. Only buttons opt back into pointer events.
	//
	// Not rendered in VR: DOM is invisible in a headset. The in-scene VR path is a later
	// phase (the AnnotationPins / AnnotationMarkers split).
	import { onMount } from 'svelte';
	import HudElement from './HudElement.svelte';
	import { hudDocs, hudRuntime, hudScreenOverride, hudPreviewInViewport, visibleScreen, activeHudKeys, setHudValue, hudValueOf } from '$lib/hudDocs';
	import { isVRMode, isLocked, playPointerFree } from '../../stores/sceneStore';
	import { hudEditorClose } from '../../stores/appStore.js';
	import { viewportOverrides, renderLayer } from '$lib/viewportOverrides';
	// 21-E7.4: RENDERABLE is no longer the same list as HUD_KINDS - a module kind is
	// renderable and is not in it, so every render-time filter reads the registry instead.
	import { isInteractiveKind, isRenderableKind } from '$lib/hudKinds';
	import { moduleHudKinds } from '$lib/moduleHudKinds';
	import { hudOptionsOf } from '$lib/flowRuntime';
	import { cameraPreview } from '$lib/cameraPreview';
	import { claimInput, releaseInput, onInput } from '$lib/inputRuntime';
	import { gamepadPrefs } from '$lib/gamepadPrefs';
	import { fireHudButton } from '$lib/flowRuntime';

	// 21-D5: WHICH documents are on screen — the scene HUD, plus the one keyed by the
	// camera being looked through (attaching a HUD to a camera IS keying it by that
	// camera's uuid, so there is no new concept here).
	const throughCamera = $derived($cameraPreview?.uuid ?? null);

	// 21-D5: is the HUD painted over the viewport at all?
	//
	// TWO separate switches, deliberately. `viewportOverrides.hud` is the persistent LOCAL
	// kill switch every authored layer gets ("the scene says X, but not on my screen") —
	// this is renderLayer()'s first real consumer. `hudPreviewInViewport` is about the
	// AUTHORING SESSION: while the HUD editor is open you work on the artboard and the
	// viewport stays clean, which is the answer to "why do I immediately see the HUD while
	// I am building it". $viewportOverrides is read as the dependency, since renderLayer
	// reaches the store through get().
	// the store is the DEPENDENCY, passed as an unused argument: renderLayer reaches it
	// through get(), and the comma-operator form is an error under svelte-check
	const allowed = (/** @type {any} */ _overrides) => renderLayer('hud');
	const layerAllowed = $derived(allowed($viewportOverrides));
	const authoringHidden = $derived(!$hudEditorClose && !$hudPreviewInViewport);

	// 21-E1.5: WHICH Z-TIER, and it depends on what you are doing.
	//
	// --z-hud (45) is right in PLAY: a HUD must beat the camera PiP and lose to
	// modal/toast/menu (the 21-A rule, unchanged — an approval toast covers a game HUD).
	// It is wrong while AUTHORING, where floating windows sit at 40 and the docked
	// editors at 35: a previewed HUD painted straight over the editor you were using to
	// build it, and an interactive kind (`pointer-events: auto`) SWALLOWED the clicks
	// meant for the window underneath. So the layer drops to 38 — under every window,
	// still over the viewport.
	//
	// `isLocked` is THREE-state (null = editor, true = playing, false = just exited, which
	// Controls turns back to null), so playing is `=== true` and everything else is
	// authoring. `=== false` would read the transient value and flip back a moment later.
	const playing = $derived($isLocked === true);

	// BOTH stores are read as dependencies. `visibleScreen` reaches the override through
	// `get()`, and a `get()` inside a $derived registers NOTHING — so with only $hudDocs
	// here, showing a screen wrote the store and the layer never re-rendered. It looked
	// like it worked, because the next write to the DOCUMENT flushed the stale override
	// too. (The `$derived`-cannot-see-a-plain-read family.)
	// `_override` is the DEPENDENCY, not an argument: visibleScreen reads the override
	// store through get(), which registers nothing.
	const screensFor = (/** @type {any} */ _override, /** @type {string|null} */ cam, /** @type {any} */ _docs) =>
		activeHudKeys(cam)
			.map((key) => ({ key, screen: visibleScreen(key) }))
			.filter((entry) => !!entry.screen);
	const screens = $derived(screensFor($hudScreenOverride, throughCamera, $hudDocs));

	// Unknown kinds are SKIPPED at render, never dropped from the document.
	// any[]: an element carries PER-KIND fields beyond the base typedef (enabled, min/max,
	// options, shared - declared open in hudKinds, the registry rule), and this component
	// reads several of them for the ring. The cast says so once instead of nine times.
	// $moduleHudKinds is the DEPENDENCY: isRenderableKind reads a plain map, which a
	// $derived cannot see, so installing a module would otherwise not make its elements
	// appear until something else happened to flush this (the non-reactive-registry family).
	const renderableOf = (/** @type {any} */ _registry, /** @type {any[]} */ list) => list;
	const elements = $derived(
		/** @type {any[]} */ (renderableOf($moduleHudKinds, screens).flatMap((entry) =>
			(entry.screen?.elements ?? [])
				.filter((/** @type {any} */ el) => isRenderableKind(el.kind))
				.map((/** @type {any} */ el) => ({ ...el, __key: entry.key }))
		))
	);
	// 21-E3: every INTERACTIVE kind, not buttons alone - a settings menu is sliders and
	// dropdowns, and under pointer lock the ring is the only hand a player has. A
	// disabled control is skipped the way it ignores presses.
	const focusables = $derived(elements.filter((el) => isInteractiveKind(el.kind) && el.enabled !== false));
	const anyVisible = $derived(elements.length > 0 && !$isVRMode && layerAllowed && !authoringHidden);

	// ---- 21-E3: the MENU SUBSTATE - this component is the SINGLE WRITER ------------
	// Visibility IS the state: any visible screen marked input:'menu' while playing
	// frees the pointer, and a menu hidden by ANY path (a node, showWhile, undo, a doc
	// edit) restores gameplay by construction. Per-peer correct, because isLocked and
	// the screen override are both local. An `inputmode` flow node was rejected for
	// exactly this: replicated pulses vs a per-peer pointer is a desync, and a second
	// source of truth strands the pointer free when the screen goes away.
	const menuWanted = $derived(screens.some((entry) => entry.screen?.input === 'menu') && anyVisible && playing);
	$effect(() => {
		playPointerFree.set(menuWanted);
		return () => playPointerFree.set(false);
	});

	// ---- the keyboard, under pointer lock -----------------------------------------
	// The dungeon-realms menu done properly. Claiming through inputRuntime is strictly
	// better than intercepting window keys on our own: PointerLockControls and
	// editorNavigation then STAND DOWN, which is exactly what DEVX #14 complains about.
	//
	// VERIFIED before shipping (the cannot-ship risk): the claim only sets a flag, and its
	// two consumers gate a per-frame MOVEMENT task (PointerLockControls' useTask) and
	// editorNavigation — NOT PointerLockControls' onKeyDown, which owns Escape ->
	// exitPointerLock. So the claim itself can never strand a player in a HUD screen.
	//
	// The real hazard is THIS handler: a window-CAPTURE stopImmediatePropagation would kill
	// that document-level onKeyDown. So Escape is never consumed here — it falls through,
	// and both the native pointer-lock exit and the component's rescue path still work.
	let focused = $state(0);
	const NAV = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Space', 'Tab']);

	/** @param {KeyboardEvent} event */
	function onKeyDown(event) {
		if (!anyVisible || focusables.length === 0) return;
		// 21-E3: pointer-free, a control the player has natively focused gets native
		// semantics - our Space on top of the browser's Space would double-fire it.
		if (!document.pointerLockElement && /** @type {any} */ (event.target)?.closest?.('#hud-layer')) return;
		// 21-E1.5: PLAY MODE ONLY. This is a window-CAPTURE listener that preventDefaults
		// and stopImmediatePropagations Tab / the arrows / Space, so while a screen with a
		// button was merely being PREVIEWED it took those keys off every panel in the app —
		// including the HUD editor whose own Tab cycles the selection. A menu ring is for a
		// player, and a player is someone who pressed play.
		if (!playing) return;
		// never steal keys from text entry (the inputRuntime / shortcuts guard)
		const target = /** @type {any} */ (event.target);
		if (
			target &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.tagName === 'SELECT' ||
				target.isContentEditable)
		)
			return;
		// ESCAPE IS NEVER OURS. See the note above — swallowing it here is how a player
		// gets stuck inside a HUD screen with no way back to the editor.
		if (event.code === 'Escape') return;
		// 21-E3: Tab drives the ring only UNDER LOCK. Pointer-free (the menu substate)
		// native DOM tabbing over the opted-in controls is strictly better - and a game
		// binding "hold Tab for the map" through keypress needs the key to reach it.
		if (event.code === 'Tab' && !document.pointerLockElement) return;
		if (!NAV.has(event.code)) return;
		event.preventDefault();
		// capture phase + stopImmediatePropagation, so the gizmo/nav digits and the flow
		// editor's own capture listeners do not also act on the same press
		event.stopImmediatePropagation();
		// 21-E5: the codes map to ring ACTIONS and the ring itself lives in one place
		// (ringAction), because a gamepad drives exactly the same five moves. Tab walks
		// FORWARD, which is what 'down' means here.
		const action =
			event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space'
				? 'activate'
				: event.code === 'ArrowUp'
					? 'up'
					: event.code === 'ArrowDown' || event.code === 'Tab'
						? 'down'
						: event.code === 'ArrowLeft'
							? 'left'
							: 'right';
		ringAction(/** @type {'up'|'down'|'left'|'right'|'activate'} */ (action));
	}

	/** WHAT THE RING DOES, once. The keyboard handler above translates its codes into
	 * these five actions and the gamepad channel below maps its d-pad and A onto the same
	 * five — so there is one implementation, and a pad cannot drift from the keyboard.
	 * @param {'up'|'down'|'left'|'right'|'activate'} action */
	function ringAction(action) {
		const el = focusables[focused % focusables.length];
		if (action === 'activate') {
			if (!el) return;
			// 21-E3: activation is PER KIND now that the ring reaches every input.
			if (el.kind === 'button') fireHudButton(el.id);
			else if (el.kind === 'toggle') {
				// the same pair a pointer click writes: flip the value, then the pulse
				setHudValue(el.id, !hudValueOf(el.id, el.value), { shared: !!el.shared });
				fireHudButton(el.id);
			}
			// slider/dropdown/textfield have no press semantics; left/right below adjust
			return;
		}
		const horizontal = action === 'left' || action === 'right';
		if (horizontal && el && (el.kind === 'slider' || el.kind === 'dropdown' || el.kind === 'tabs')) {
			// 21-E3: a focused slider/dropdown takes Left/Right for its VALUE; Up/Down
			// still walk the ring, so a menu of sliders stays navigable.
			const dir = action === 'right' ? 1 : -1;
			if (el.kind === 'tabs') {
				// 21-E7.6: a tabs element HOLDS the index, so the ring steps the number and
				// wraps - the dropdown branch below steps through option TEXT instead.
				const options = hudOptionsOf(el.id, el);
				if (options.length) {
					const at = Math.max(0, Math.round(Number(hudValueOf(el.id, el.value ?? 0))));
					setHudValue(el.id, (at + dir + options.length) % options.length, { shared: !!el.shared });
				}
			} else if (el.kind === 'slider') {
				const min = Number(el.min ?? 0);
				const max = Number(el.max ?? 100);
				const step = Number(el.step || 1);
				const held = Number(hudValueOf(el.id, el.value ?? min));
				const next = Math.min(max, Math.max(min, held + dir * step));
				setHudValue(el.id, next, { shared: !!el.shared });
			} else {
				// 21-E7.2: the LIVE list. A node feeding the options must move the ring's idea of
				// 'the next option' with them, or a pad player cycles through a stale list.
				const options = hudOptionsOf(el.id, el);
				if (options.length) {
					const held = String(hudValueOf(el.id, el.value ?? options[0]));
					const at = Math.max(0, options.indexOf(held));
					const next = options[(at + dir + options.length) % options.length];
					setHudValue(el.id, next, { shared: !!el.shared });
				}
			}
			return;
		}
		const forward = action === 'down' || action === 'right';
		const n = focusables.length;
		focused = (focused + (forward ? 1 : n - 1)) % n;
	}

	// ---- 21-E5: the same ring, from a gamepad --------------------------------------
	// The d-pad walks and A activates, through inputRuntime's OWN channel rather than
	// synthesized KeyboardEvents. Two reasons: a synthetic event does not travel the path
	// a real one does (svelte delegates key handlers, and this one is a window-CAPTURE
	// listener that preventDefaults), so faking a press would be fragile in exactly the
	// way this repo has been bitten before; and the ring is already factored, so there is
	// nothing to gain by pretending to be a keyboard.
	//
	// B IS DELIBERATELY UNBOUND. "Back" is a screen-STACK concern and this HUD has no
	// stack yet; wiring it to "hide the screen" would strand a player whose menu is
	// showWhile-bound and therefore cannot be hidden, and Escape already owns the
	// guaranteed way out. It becomes meaningful when screens gain history.
	/** @type {Record<string, 'up'|'down'|'left'|'right'|'activate'>} */
	const PAD_RING = {
		GamepadUp: 'up',
		GamepadDown: 'down',
		GamepadLeft: 'left',
		GamepadRight: 'right',
		GamepadA: 'activate'
	};

	/** @param {'down'|'up'} kind @param {string} code */
	function onPadInput(kind, code) {
		if (kind !== 'down') return; // the ring acts on the press, like the keyboard
		const action = PAD_RING[code];
		if (!action || !$gamepadPrefs.enabled) return;
		// the same premise the keyboard needs: a visible screen with something to focus,
		// while playing. No text-entry guard and no lock check - a pad edge has no target
		// element and no pointer, and this ring is precisely what a controller player has
		// INSTEAD of a pointer, free or locked.
		if (!anyVisible || focusables.length === 0 || !playing) return;
		ringAction(action);
	}

	onMount(() => {
		window.addEventListener('keydown', onKeyDown, true);
		const stopPad = onInput(onPadInput);
		return () => {
			window.removeEventListener('keydown', onKeyDown, true);
			stopPad();
		};
	});

	// Claim only while a screen with focusables is actually up, and release the moment it
	// is not — a claim left standing pauses editor fly for good.
	$effect(() => {
		const wants = anyVisible && focusables.length > 0;
		if (!wants) return;
		claimInput('keys');
		return () => releaseInput('keys');
	});

	// keep the ring inside the list as screens change
	$effect(() => {
		if (focusables.length && focused >= focusables.length) focused = 0;
	});

	/** Split an anchor into its vertical and horizontal halves. `'center'` is a SINGLE
	 * token, so a naive split gives ['center', undefined] and the horizontal half is lost
	 * — the element then sat with `left: 50%` and no counter-translate, i.e. half its own
	 * width to the right of centre. @param {string} anchor */
	function axes(anchor) {
		if (anchor === 'center') return { v: 'middle', h: 'center' };
		const [v, h] = String(anchor ?? 'top-left').split('-');
		return { v: v || 'top', h: h || 'left' };
	}

	/** The 9-grid: an anchor picks the corner, x/y are PIXEL offsets from it. Fractions
	 * would stretch text and borders on resize. @param {any} el */
	function place(el) {
		const { v, h } = axes(el.anchor);
		/** @type {string[]} */
		const out = [`width: ${el.w}px`, `height: ${el.h}px`, `z-index: ${el.z}`];
		if (v === 'top') out.push(`top: ${el.y}px`);
		else if (v === 'bottom') out.push(`bottom: ${el.y}px`);
		else out.push('top: 50%', `--hud-ty: ${el.y}px`);
		if (h === 'left') out.push(`left: ${el.x}px`);
		else if (h === 'right') out.push(`right: ${el.x}px`);
		else out.push('left: 50%', `--hud-tx: ${el.x}px`);
		return out.join('; ');
	}
	/** @param {any} el */
	function centering(el) {
		const { v, h } = axes(el.anchor);
		const cx = h === 'center';
		const cy = v === 'middle';
		if (!cx && !cy) return '';
		return `transform: translate(${cx ? 'calc(-50% + var(--hud-tx, 0px))' : '0'}, ${cy ? 'calc(-50% + var(--hud-ty, 0px))' : '0'})`;
	}
</script>

{#if anyVisible}
	<div id="hud-layer" class="hud-layer" class:hud-authoring={!playing} data-authoring={!playing}>
		{#each elements as el (el.__key + ':' + el.id)}
			<div
				class="hud-slot"
				class:hud-focused={playing &&
				isInteractiveKind(el.kind) &&
				focusables[focused % Math.max(1, focusables.length)]?.id === el.id}
				data-hud-id={el.id}
				data-hud-kind={el.kind}
				style="{place(el)}; {centering(el)}"
			>
				<HudElement element={el} runtime={$hudRuntime[el.id]} onpress={fireHudButton} />
			</div>
		{/each}
	</div>
{/if}

<style>
	.hud-layer {
		position: fixed;
		inset: 0;
		/* NO new tier: --z-hud is the toolbar-pill band, which beats the camera PiP and
		   loses to modal/toast/menu — an approval toast must cover a game HUD. */
		z-index: var(--z-hud, 45);
		/* the viewport keeps every click; only buttons opt back in */
		pointer-events: none;
		overflow: hidden;
	}
	/* 21-E1.5: while authoring, BELOW every window (--z-window 40, docked 35) and still
	   above the viewport. Not a new tier — the same band, one step down. */
	.hud-authoring {
		z-index: 38;
	}
	.hud-slot {
		position: absolute;
	}
	/* the keyboard ring, so a player under pointer lock can see where they are */
	.hud-focused {
		outline: 2px solid var(--accent, #ef562f);
		outline-offset: 2px;
		border-radius: 6px;
	}
	/* On a narrow screen the bottom Controls HUD owns the strip the layer would draw
	   over, so bottom-anchored elements lift above it — the --controls-inset bus. */
	@media (max-width: 640px) {
		.hud-layer {
			bottom: var(--controls-inset, 0px);
		}
	}
</style>
