<script>
	// 92-input GC3 — A PROMPT THAT SHOWS THE RIGHT GLYPH. `code` is the GAME's code (what the walker / a Key
	// Press node / a Gamepad Button node listens for). On a keyboard it is drawn as the key the PLAYER pressed
	// it to (their remap applied); on a pad as the button the same action sits on (Space -> A, Escape ->
	// Start …, remapped too), in the pad's own family (a PlayStation pad shows the cross, circle, square and
	// triangle shapes; a Nintendo pad its swapped letters). A key with no pad action stays a key, honestly.
	// Drawn in currentColor at the text's size, so it sits in any line: a HUD key hint, the banner, a row.
	import { activeInput } from '$lib/activeDevice.js';
	import { accessRemap } from '$lib/playerAccess';
	import { codeLabel, playerCodeFor } from '$lib/playerAccessCore';
	import { PAD_ACTIONS, PAD_FOR_KEY, padGlyph, hintCodeOf } from '$lib/playActions.js'; // this component is lazy: so is its half

	/** `raw`: the code is already the player's own key / button (a remap row), so no remap is applied.
	 * `name`: a typed key name (a HUD key hint's "E") the code is read from when `code` is empty; one that
	 * names no key is drawn as typed. @type {{code?: string, name?: string, as?: 'auto' | 'keys' | 'pad', raw?: boolean, class?: string}} */
	let { code: given = '', name = '', as = 'auto', raw = false, class: cls = '' } = $props();
	const code = $derived(hintCodeOf(given, name) ?? '');

	const isPad = $derived(String(code).startsWith('Gamepad'));
	// the pad button this game code is on, and the key a pad action is on (for a keyboard prompt of a pad code)
	const padCode = $derived(isPad ? code : (PAD_FOR_KEY[code] ?? null));
	const keyCode = $derived(isPad ? (PAD_ACTIONS.find((a) => a.pad === code)?.keys?.[0] ?? null) : code);
	const usePad = $derived(as === 'pad' ? !!padCode : as === 'keys' ? !keyCode : $activeInput.kind === 'pad' ? !!padCode : !keyCode);
	const physicalPad = $derived(padCode ? (raw ? padCode : playerCodeFor($accessRemap.pad ?? {}, padCode)) : null);
	const glyph = $derived(physicalPad ? padGlyph(physicalPad, $activeInput.family) : null);
	const keyText = $derived(keyCode ? codeLabel(raw ? keyCode : playerCodeFor($accessRemap.keys ?? {}, keyCode)) : codeLabel(code));
</script>

{#if usePad && glyph}
	<span class="ig ig-pad ig-{glyph.shape} {cls}" role="img" aria-label={glyph.text} title={glyph.text} data-glyph={glyph.shape} data-glyph-text={glyph.text}>
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			{#if glyph.shape === 'cross'}
				<circle cx="12" cy="12" r="10.5" class="ig-ring" />
				<path d="M7.5 7.5 16.5 16.5 M16.5 7.5 7.5 16.5" class="ig-mark" />
			{:else if glyph.shape === 'circle'}
				<circle cx="12" cy="12" r="10.5" class="ig-ring" />
				<circle cx="12" cy="12" r="5" class="ig-mark" />
			{:else if glyph.shape === 'square'}
				<circle cx="12" cy="12" r="10.5" class="ig-ring" />
				<rect x="7.5" y="7.5" width="9" height="9" class="ig-mark" />
			{:else if glyph.shape === 'triangle'}
				<circle cx="12" cy="12" r="10.5" class="ig-ring" />
				<path d="M12 6.5 17.5 16 6.5 16 Z" class="ig-mark" />
			{:else if glyph.shape === 'face'}
				<circle cx="12" cy="12" r="10.5" class="ig-ring" />
				<text x="12" y="12.5" class="ig-text">{glyph.text}</text>
			{:else if glyph.shape === 'dpad'}
				<path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7Z" class="ig-ring" />
				{#if glyph.dir === 'up'}<path d="M10 4h4v5h-4Z" class="ig-fill" />{/if}
				{#if glyph.dir === 'down'}<path d="M10 15h4v5h-4Z" class="ig-fill" />{/if}
				{#if glyph.dir === 'left'}<path d="M4 10h5v4H4Z" class="ig-fill" />{/if}
				{#if glyph.dir === 'right'}<path d="M15 10h5v4h-5Z" class="ig-fill" />{/if}
			{:else if glyph.shape === 'stick'}
				<circle cx="12" cy="12" r="10.5" class="ig-ring" />
				<circle cx="12" cy="12" r="6.5" class="ig-mark" />
				<text x="12" y="12.5" class="ig-text ig-small">{glyph.text}</text>
			{/if}
		</svg>
		{#if glyph.shape === 'shoulder' || glyph.shape === 'menu'}<span class="ig-label">{glyph.text}</span>{/if}
	</span>
{:else}
	<kbd class="ig ig-key {cls}" data-glyph="key">{code ? keyText : name || given}</kbd>
{/if}

<style>
	.ig {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		vertical-align: middle;
		line-height: 1;
	}
	.ig-pad svg {
		width: 1.35em;
		height: 1.35em;
		overflow: visible;
	}
	.ig-pad.ig-shoulder svg,
	.ig-pad.ig-menu svg {
		display: none;
	}
	.ig-ring {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
	}
	.ig-mark {
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.ig-fill {
		fill: currentColor;
	}
	.ig-text {
		fill: currentColor;
		font: 700 11px/1 var(--font-sans, system-ui, sans-serif);
		text-anchor: middle;
		dominant-baseline: central;
	}
	.ig-small {
		font-size: 7px;
	}
	.ig-label {
		min-width: 1.35em;
		padding: 0.1em 0.4em;
		border: 1.5px solid currentColor;
		border-radius: 0.45em;
		font-size: 0.85em;
		font-weight: 700;
	}
	.ig-menu .ig-label {
		border-radius: 999px;
	}
</style>
