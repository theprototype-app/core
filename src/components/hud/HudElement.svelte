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
	const value = $derived(Number(runtime?.value ?? 0));
	const min = $derived(Number(runtime?.min ?? 0));
	const max = $derived(Number(runtime?.max ?? 1));
	const pct = $derived(max - min > 1e-9 ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0);
	const rows = $derived(Array.isArray(runtime?.rows) ? runtime.rows : []);

	const boxStyle = $derived(
		[
			`color: ${paint(style.color, '#f3f4f6')}`,
			`background: ${paint(style.bg, kind === 'panel' || kind === 'button' ? 'rgb(17 24 39 / 0.72)' : 'transparent')}`,
			style.border ? `border: 1px solid ${paint(style.border, 'rgb(75 85 99 / 0.7)')}` : 'border: 0',
			`border-radius: ${Number(style.radius ?? (kind === 'crosshair' ? 999 : 6))}px`,
			`padding: ${Number(style.pad ?? (kind === 'text' ? 0 : 6))}px`,
			`font-size: ${Number(style.size ?? 14)}px`,
			`font-weight: ${Number(style.weight ?? 400)}`,
			style.font ? `font-family: ${style.font}` : '',
			`text-align: ${style.align ?? 'left'}`,
			`opacity: ${Number(style.opacity ?? 1)}`
		]
			.filter(Boolean)
			.join('; ')
	);
</script>

{#if kind === 'text' || kind === 'timer'}
	<div class="hud-el hud-text" style={boxStyle}>{text}</div>
{:else if kind === 'button'}
	<!-- buttons are the ONE thing that opts INTO pointer events; the layer itself is
	     pointer-events: none so the viewport keeps every click. In the editor the press is
	     swallowed, or laying out a menu would fire the game's own triggers. -->
	<button
		class="hud-el hud-button"
		style={boxStyle}
		tabindex={editor ? -1 : 0}
		onclick={(e) => {
			if (editor) return;
			e.stopPropagation();
			onpress?.(element.id);
		}}>{text}</button
	>
{:else if kind === 'bar'}
	<div class="hud-el hud-bar" style={boxStyle}>
		<div class="hud-bar-fill" style="width: {pct}%; background: {paint(style.color, 'var(--accent, #ef562f)')}"></div>
		{#if text}<span class="hud-bar-label">{text}</span>{/if}
	</div>
{:else if kind === 'panel'}
	<div class="hud-el hud-panel" style={boxStyle}>{text}</div>
{:else if kind === 'list'}
	<!-- a list is an element WRITTEN INTO by id, never a value that flows: the socket
	     system has no arrays, and every game needs a leaderboard -->
	<div class="hud-el hud-list" style={boxStyle}>
		{#if text}<div class="hud-list-title">{text}</div>{/if}
		{#each rows as row, i (i)}
			<div class="hud-list-row">{String(row)}</div>
		{/each}
	</div>
{:else if kind === 'crosshair'}
	<div class="hud-el hud-crosshair" style={boxStyle} aria-hidden="true">
		<span class="hud-cross-dot" style="background: {paint(style.color, '#f3f4f6')}"></span>
	</div>
{:else if kind === 'image'}
	<!-- the src is an Explorer content HASH resolved by the layer, never an embedded
	     dataURL: a document replicates WHOLE on every edit, so an inline image would
	     re-send the bytes on every slider nudge -->
	<div class="hud-el hud-image" style={boxStyle}>
		{#if runtime?.src}
			<img src={runtime.src} alt={text} />
		{:else}
			<span class="hud-image-wait">{text || 'image'}</span>
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
		white-space: pre-wrap;
	}
	.hud-button {
		cursor: pointer;
		pointer-events: auto;
		font: inherit;
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
		transition: width 120ms linear;
	}
	.hud-bar-label {
		position: relative;
		padding: 0 6px;
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
		white-space: nowrap;
		text-overflow: ellipsis;
		overflow: hidden;
	}
	.hud-crosshair {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.hud-cross-dot {
		width: 4px;
		height: 4px;
		border-radius: 999px;
	}
	.hud-image {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.hud-image img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	.hud-image-wait {
		opacity: 0.5;
		font-size: 0.8em;
	}
</style>
