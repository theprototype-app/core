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
	import { hudDocs, hudRuntime, hudScreenOverride, visibleScreen, HUD_KINDS } from '$lib/hudDocs';
	import { isVRMode } from '../../stores/sceneStore';
	import { claimInput, releaseInput } from '$lib/inputRuntime';
	import { fireHudButton } from '$lib/flowRuntime';

	// The visible screen of every document, flattened.
	//
	// BOTH stores are read as dependencies. `visibleScreen` reaches the override through
	// `get()`, and a `get()` inside a $derived registers NOTHING — so with only $hudDocs
	// here, showing a screen wrote the store and the layer never re-rendered. It looked
	// like it worked, because the next write to the DOCUMENT flushed the stale override
	// too. (The `$derived`-cannot-see-a-plain-read family.)
	// `_override` is the DEPENDENCY, not an argument: visibleScreen reads the override
	// store through get(), which registers nothing.
	const screensFor = (/** @type {any} */ _override) =>
		Object.keys($hudDocs)
			.map((key) => ({ key, screen: visibleScreen(key) }))
			.filter((entry) => !!entry.screen);
	const screens = $derived(screensFor($hudScreenOverride));

	// Unknown kinds are SKIPPED at render, never dropped from the document.
	const elements = $derived(
		screens.flatMap((entry) =>
			(entry.screen?.elements ?? [])
				.filter((el) => HUD_KINDS.includes(el.kind))
				.map((el) => ({ ...el, __key: entry.key }))
		)
	);
	const focusables = $derived(elements.filter((el) => el.kind === 'button'));
	const anyVisible = $derived(elements.length > 0 && !$isVRMode);

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
		if (!NAV.has(event.code)) return;
		event.preventDefault();
		// capture phase + stopImmediatePropagation, so the gizmo/nav digits and the flow
		// editor's own capture listeners do not also act on the same press
		event.stopImmediatePropagation();
		if (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') {
			const el = focusables[focused % focusables.length];
			if (el) fireHudButton(el.id);
			return;
		}
		const forward = event.code === 'ArrowDown' || event.code === 'ArrowRight' || event.code === 'Tab';
		const n = focusables.length;
		focused = (focused + (forward ? 1 : n - 1)) % n;
	}

	onMount(() => {
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
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
	<div id="hud-layer" class="hud-layer">
		{#each elements as el (el.__key + ':' + el.id)}
			<div
				class="hud-slot"
				class:hud-focused={el.kind === 'button' && focusables[focused % Math.max(1, focusables.length)]?.id === el.id}
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
