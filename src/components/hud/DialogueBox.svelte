<script>
	// 92-dialogue (GC6): THE DIALOGUE BOX — the open talk on THIS device, at the bottom of the screen
	// inside #hud-layer. Loaded lazily by HudLayer the first time a talk opens.
	//
	// Continue: E / Enter / Space, a click or tap on the box (or anywhere while the pointer is locked),
	// gamepad A. A first press while the line is still typing shows it whole. Choices: 1-9, arrows or
	// W / S or the D-pad, then continue; or click / tap one (the pointer is freed while choices show,
	// HudLayer's menu rule). The player is held while a talk is open (the 'keys' claim).
	import { onMount } from 'svelte';
	import { dialogueView } from '$lib/dialogue/view.js';
	import { dialogueAdvance, dialogueChoose } from '$lib/dialogue/runtime.js';
	import { claimInput, releaseInput, onInput } from '$lib/inputRuntime';
	import { resolveHudImage, hudImageFor } from '$lib/hudImages';
	import { explorerItems } from '$lib/explorer';
	import { accessValues } from '$lib/playerAccess';
	import { hudTextScale } from '$lib/playerAccessCore';

	const view = $derived($dialogueView);
	let shown = $state(0);
	let sel = $state(0);
	let portraitUrl = $state(/** @type {string | null} */ (null));

	const reduced = () =>
		/** @type {any} */ ($accessValues)?.reducedMotion === true ||
		(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
	const typing = $derived(!!view && shown < view.text.length);

	// a new line: start typing it (or show it whole under reduced motion), first choice picked
	$effect(() => {
		const v = view;
		sel = 0;
		if (!v) return;
		if (reduced()) {
			shown = v.text.length;
			return;
		}
		shown = 0;
		const id = setInterval(() => {
			shown = Math.min(v.text.length, shown + 2);
			if (shown >= v.text.length) clearInterval(id);
		}, 30);
		return () => clearInterval(id);
	});

	// the speaker's picture: an Explorer hash, or an image's name in the library
	$effect(() => {
		const ref = view?.portrait ?? '';
		portraitUrl = null;
		if (!ref) return;
		const items = /** @type {any[]} */ ($explorerItems);
		const hash = items.some((i) => i.hash === ref) ? ref : items.find((i) => i.name === ref || i.name?.replace(/\.[^.]+$/, '') === ref)?.hash ?? ref;
		portraitUrl = hudImageFor(hash);
		if (!portraitUrl) resolveHudImage(hash).then((url) => (portraitUrl = url));
	});

	// hold the player while talking
	$effect(() => {
		if (!view) return;
		claimInput('keys');
		return () => releaseInput('keys');
	});

	/** continue: finish typing, else pick the selected choice, else the next line */
	function press() {
		if (!view) return;
		if (typing) {
			shown = view.text.length;
			return;
		}
		if (view.choices.length) dialogueChoose(sel);
		else dialogueAdvance();
	}

	/** @param {number} d */
	function move(d) {
		if (!view?.choices.length) return;
		const n = view.choices.length;
		sel = (sel + d + n) % n;
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (!view || e.repeat) return;
		const t = /** @type {any} */ (e.target);
		if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text') || t.isContentEditable)) return;
		const digit = /^Digit([1-9])$/.exec(e.code);
		if (digit && view.choices.length >= Number(digit[1])) {
			dialogueChoose(Number(digit[1]) - 1);
		} else if (e.code === 'KeyE' || e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') press();
		else if (e.code === 'ArrowUp' || e.code === 'KeyW') move(-1);
		else if (e.code === 'ArrowDown' || e.code === 'KeyS') move(1);
		else return;
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	/** under pointer lock a click has no target on screen: it continues the talk instead of reaching the world */
	/** @param {Event} e */
	function onLockedPointer(e) {
		if (!view || !document.pointerLockElement) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		if (e.type === 'pointerdown' && !view.choices.length) press();
	}

	onMount(() => {
		window.addEventListener('keydown', onKey, true);
		for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) window.addEventListener(type, onLockedPointer, true);
		const stopPad = onInput((kind, code) => {
			if (kind !== 'down' || !view) return;
			if (code === 'GamepadA') press();
			else if (code === 'GamepadUp') move(-1);
			else if (code === 'GamepadDown') move(1);
		});
		return () => {
			window.removeEventListener('keydown', onKey, true);
			for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) window.removeEventListener(type, onLockedPointer, true);
			stopPad();
		};
	});
</script>

{#if view}
	<div
		id="dialogue-box"
		class="dialogue-box"
		role="dialog"
		aria-label={view.speaker ? 'Talking with ' + view.speaker : 'Dialogue'}
		aria-live="polite"
		data-node={view.nodeId}
		style:--dlg-scale={hudTextScale(/** @type {any} */ ($accessValues)?.hudText)}
	>
		<button class="dialogue-body" type="button" onclick={press} aria-label="Continue">
			{#if portraitUrl}
				<img class="dialogue-portrait" src={portraitUrl} alt={view.speaker} />
			{/if}
			<span class="dialogue-words">
				{#if view.speaker}<span class="dialogue-speaker">{view.speaker}</span>{/if}
				<span class="dialogue-text" data-full={view.text}>{view.text.slice(0, shown)}</span>
			</span>
		</button>
		{#if view.choices.length && !typing}
			<ol class="dialogue-choices">
				{#each view.choices as choice, i (i)}
					<li>
						<button type="button" class="dialogue-choice" class:dialogue-choice-on={i === sel} data-choice={i} onclick={() => dialogueChoose(i)} onpointerenter={() => (sel = i)}>
							<span class="dialogue-key">{i + 1}</span>{choice}
						</button>
					</li>
				{/each}
			</ol>
		{:else if !typing}
			<div class="dialogue-hint" aria-hidden="true">{view.last ? 'E · close' : 'E · continue'}</div>
		{/if}
	</div>
{/if}

<style>
	.dialogue-box {
		position: absolute;
		left: 50%;
		bottom: calc(var(--hud-bottom-lift, 0px) + var(--space-6));
		transform: translateX(-50%);
		width: min(720px, calc(100vw - 2 * var(--space-4)));
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		pointer-events: auto;
		font-size: calc(var(--fs-body) * var(--dlg-scale, 1));
		color: var(--text);
	}
	.dialogue-body {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		width: 100%;
		min-height: 88px;
		padding: var(--space-4);
		text-align: left;
		border-radius: 10px;
		border: 1px solid var(--border-strong);
		background: color-mix(in srgb, var(--surface-1) 92%, transparent);
		box-shadow: var(--shadow-window);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.dialogue-portrait {
		width: 64px;
		height: 64px;
		flex: none;
		object-fit: cover;
		border-radius: 8px;
		border: 1px solid var(--border-strong);
	}
	.dialogue-words {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.dialogue-speaker {
		font-weight: 600;
		color: var(--accent-text);
	}
	.dialogue-text {
		white-space: pre-wrap;
		line-height: 1.45;
	}
	.dialogue-choices {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.dialogue-choice {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-height: var(--control-h);
		padding: var(--space-2) var(--space-3);
		text-align: left;
		border-radius: 8px;
		border: 1px solid var(--border-strong);
		background: color-mix(in srgb, var(--surface-1) 92%, transparent);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.dialogue-choice-on {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.dialogue-key {
		display: inline-grid;
		place-items: center;
		min-width: 1.5em;
		height: 1.5em;
		border-radius: 4px;
		background: var(--surface-inset);
		color: var(--text-muted);
		font-size: var(--fs-badge);
	}
	.dialogue-hint {
		align-self: flex-end;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	@media (max-width: 640px) {
		.dialogue-portrait {
			width: 48px;
			height: 48px;
		}
	}
</style>
