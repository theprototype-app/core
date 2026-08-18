<script>
	// A2 — ONE renderer for a HUD element, shared by the runtime layer and the A4 editor
	// artboard (the "shared by the node card and the properties pane" precedent).
	//
	// This sharing is the whole reason the artboard is real DOM rather than a 2D canvas: a
	// HUD element IS a DOM box, and a canvas re-implementation would drift from the runtime
	// look, which is the one thing a layout editor must not do.
	//
	// An UNKNOWN kind renders NOTHING and is not an error — the document keeps it verbatim
	// so a newer peer's element survives a round trip through our editor.
	//
	// 21-D1: every kind reads its OWN params from the element (see `hudKinds.js`). The
	// element's param is the AUTHORED value — what it shows with nothing wired — and a node
	// always wins through `runtime`. So a bar with `value: 40` previews in the editor AND is
	// the runtime fallback; it is not a second source of truth.
	import { hudImageFor, resolveHudImage, registerHudImageListener } from '$lib/hudImages';
	import { onDestroy } from 'svelte';

	/** @type {{ element: any, runtime?: any, editor?: boolean, onpress?: (id: string) => void }} */
	let { element, runtime = null, editor = false, onpress = undefined } = $props();

	const style = $derived(element?.style ?? {});
	const kind = $derived(element?.kind ?? 'text');

	// Every var() chain ENDS IN A LITERAL. Neither the dark nor the light theme defines
	// --surface/--accent, so a token-only chain silently resolves to nothing (the
	// ToolboxWindow rule). A style value may itself be a token NAME, which is why the
	// authored value is wrapped rather than used raw.
	/** @param {any} value @param {string} fallback */
	function paint(value, fallback) {
		if (value === undefined || value === null || value === '') return fallback;
		const text = String(value);
		// a bare token name ('accent', 'surface') resolves through the theme with a literal
		// fallback; anything else (a hex, an rgb(), a keyword) is used as authored
		return /^[a-z][a-z0-9-]*$/i.test(text) && !CSS_KEYWORDS.has(text.toLowerCase())
			? `var(--${text}, ${fallback})`
			: text;
	}
	const CSS_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'none', 'white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'yellow', 'orange']);

	// what the element SAYS right now. `runtime` comes from the flow graph (A3) and is
	// absent until a node drives it — in which case the authored label is the text, which
	// is also exactly what the editor artboard should show.
	const text = $derived(
		runtime?.text !== undefined && runtime?.text !== null
			? String(runtime.text)
			: String(element?.label ?? '')
	);
	// 21-D1: the AUTHORED value is the fallback for every numeric channel, so an unwired
	// bar previews at what you set rather than always reading zero.
	const value = $derived(Number(runtime?.value ?? element?.value ?? 0));
	const min = $derived(Number(runtime?.min ?? element?.min ?? 0));
	const max = $derived(Number(runtime?.max ?? element?.max ?? 1));
	const pct = $derived(max - min > 1e-9 ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0);
	const rows = $derived(Array.isArray(runtime?.rows) ? runtime.rows : []);
	const vertical = $derived(element?.orientation === 'vertical');

	// ---- 21-D1: the image kind ------------------------------------------------------
	// A hash landing is not a store write and `hudImageFor` is a plain Map read, so a
	// $derived over it never re-runs — the listener bumps a tick used as a dependency
	// (the same fix ShaderTexturePicker needed).
	let imageTick = $state(0);
	const stopListening = registerHudImageListener(() => (imageTick += 1));
	onDestroy(stopListening);
	const hash = $derived(kind === 'image' ? String(element?.src ?? '') : '');
	const imageUrl = $derived.by(() => {
		void imageTick;
		if (!hash) return null;
		const hit = hudImageFor(hash);
		// resolve on a miss: it pulls from a peer when the bytes are not local, and the
		// retry watch notifies us when they land
		if (!hit) void resolveHudImage(hash);
		return hit;
	});

	const boxStyle = $derived(
		[
			`color: ${paint(style.color, '#f3f4f6')}`,
			`background: ${paint(style.bg, 'transparent')}`,
			style.border ? `border: 1px solid ${paint(style.border, 'rgb(75 85 99 / 0.7)')}` : 'border: 0',
			`border-radius: ${Number(style.radius ?? 0)}px`,
			`padding: ${Number(style.pad ?? 0)}px`,
			`font-size: ${Number(style.size ?? 14)}px`,
			`font-weight: ${Number(style.weight ?? 400)}`,
			style.font ? `font-family: ${style.font}` : '',
			`text-align: ${style.align ?? 'left'}`,
			`opacity: ${Number(style.opacity ?? 1) * (element?.enabled === false ? 0.45 : 1)}`
		]
			.filter(Boolean)
			.join('; ')
	);
</script>

{#if kind === 'text' || kind === 'timer'}
	<div class="hud-el hud-text" class:hud-wrap={element?.wrap} style={boxStyle}>{text}</div>
{:else if kind === 'button'}
	<!-- buttons are the ONE thing that opts INTO pointer events; the layer itself is
	     pointer-events: none so the viewport keeps every click. In the editor the press is
	     swallowed, or laying out a menu would fire the game's own triggers. -->
	<button
		class="hud-el hud-button"
		style={boxStyle}
		disabled={element?.enabled === false && !editor}
		tabindex={editor ? -1 : 0}
		onclick={(e) => {
			if (editor || element?.enabled === false) return;
			e.stopPropagation();
			onpress?.(element.id);
		}}>{text}</button
	>
{:else if kind === 'bar'}
	<div class="hud-el hud-bar" style={boxStyle}>
		<div
			class="hud-bar-fill"
			class:hud-bar-fill-v={vertical}
			style="{vertical ? 'height' : 'width'}: {pct}%; background: {paint(style.color, 'var(--accent, #ef562f)')}"
		></div>
		{#if element?.showPercent}
			<span class="hud-bar-label">{Math.round(pct)}%</span>
		{:else if text}
			<span class="hud-bar-label">{text}</span>
		{/if}
	</div>
{:else if kind === 'panel'}
	<div class="hud-el hud-panel" style={boxStyle}>{text}</div>
{:else if kind === 'list'}
	<!-- a list is an element WRITTEN INTO by id, never a value that flows: the socket
	     system has no arrays, and every game needs a leaderboard -->
	<div class="hud-el hud-list" style={boxStyle}>
		{#if text}<div class="hud-list-title">{text}</div>{/if}
		{#each rows as row, i (i)}
			<div class="hud-list-row" style="height: {Number(element?.rowHeight ?? 18)}px">{String(row)}</div>
		{/each}
	</div>
{:else if kind === 'crosshair'}
	<div class="hud-el hud-crosshair" style={boxStyle} aria-hidden="true">
		{#each ['t', 'b', 'l', 'r'] as arm (arm)}
			<span
				class="hud-cross-arm hud-cross-{arm}"
				style="background: {paint(style.color, '#f3f4f6')}; --cw: {Number(element?.thickness ?? 2)}px; --cg: {Number(element?.gap ?? 4)}px"
			></span>
		{/each}
		{#if element?.dot !== false}
			<span class="hud-cross-dot" style="background: {paint(style.color, '#f3f4f6')}; width: {Number(element?.thickness ?? 2)}px; height: {Number(element?.thickness ?? 2)}px"></span>
		{/if}
	</div>
{:else if kind === 'image'}
	<!-- the src is an Explorer content HASH resolved to an object URL, never an embedded
	     dataURL: a document replicates WHOLE on every edit, so an inline image would
	     re-send the bytes on every slider nudge -->
	<div class="hud-el hud-image" style={boxStyle}>
		{#if imageUrl}
			<img src={imageUrl} alt={element?.label ?? ''} style="object-fit: {element?.fit ?? 'contain'}" />
		{:else if hash}
			<span class="hud-image-wait">waiting for peer…</span>
		{:else if editor}
			<span class="hud-image-wait">pick an image</span>
		{/if}
	</div>
{/if}

<style>
	.hud-el {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		overflow: hidden;
		line-height: 1.25;
	}
	.hud-text,
	.hud-panel {
		display: flex;
		align-items: center;
		white-space: pre;
	}
	.hud-wrap {
		white-space: pre-wrap;
	}
	.hud-button {
		cursor: pointer;
		pointer-events: auto;
		font: inherit;
	}
	.hud-button:disabled {
		cursor: not-allowed;
	}
	.hud-bar {
		position: relative;
		display: flex;
		align-items: center;
		overflow: hidden;
	}
	.hud-bar-fill {
		position: absolute;
		inset: 0 auto 0 0;
		height: 100%;
		transition: width 120ms linear;
	}
	/* a vertical bar fills from the BOTTOM, which is what a health bar means */
	.hud-bar-fill-v {
		inset: auto 0 0 0;
		width: 100%;
		transition: height 120ms linear;
	}
	.hud-bar-label {
		position: relative;
		width: 100%;
		padding: 0 6px;
		text-align: inherit;
	}
	.hud-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.hud-list-title {
		opacity: 0.7;
		font-size: 0.85em;
	}
	.hud-list-row {
		display: flex;
		align-items: center;
		white-space: nowrap;
		text-overflow: ellipsis;
		overflow: hidden;
	}
	.hud-crosshair {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	/* four arms leaving a configurable GAP at the centre — the reticle every shooter has */
	.hud-cross-arm {
		position: absolute;
	}
	.hud-cross-t,
	.hud-cross-b {
		left: 50%;
		width: var(--cw);
		height: calc(50% - var(--cg));
		transform: translateX(-50%);
	}
	.hud-cross-t {
		top: 0;
	}
	.hud-cross-b {
		bottom: 0;
	}
	.hud-cross-l,
	.hud-cross-r {
		top: 50%;
		height: var(--cw);
		width: calc(50% - var(--cg));
		transform: translateY(-50%);
	}
	.hud-cross-l {
		left: 0;
	}
	.hud-cross-r {
		right: 0;
	}
	.hud-cross-dot {
		border-radius: 999px;
	}
	.hud-image {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.hud-image img {
		width: 100%;
		height: 100%;
		max-width: 100%;
		max-height: 100%;
	}
	.hud-image-wait {
		opacity: 0.5;
		font-size: 0.8em;
	}
</style>
