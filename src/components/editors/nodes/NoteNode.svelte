<script lang="ts">
	// 36 U11 / N1: a NOTE — a title and a markdown description on the canvas. No sockets,
	// never evaluated. A FRAME note (data.frame) was drawn around nodes and carries them
	// when it is dragged; it sits BEHIND the cards (flow.css). The description is edited in
	// the properties panel and rendered here from a token tree — never as HTML, since a
	// note arrives from peers.
	import { NodeResizer, type NodeProps } from '@xyflow/svelte';
	import { parseNote } from '$lib/noteMarkdown';
	import { runNodeAction } from '$lib/nodeEditorActions';
	import { NOTE_COLORS } from '$lib/noteColors';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;
	export let selected: boolean = false;

	$: blocks = parseNote(data?.text ?? '');
	$: color = NOTE_COLORS.includes(data?.color) ? data.color : 'yellow';
	$: framing = Array.isArray(data?.frame) && data.frame.length > 0;
	// live size while the resizer is dragged (the stored size lands on release)
	let live: { w: number; h: number } | null = null;
	$: w = live?.w ?? +(data?.w ?? 220);
	$: h = live?.h ?? +(data?.h ?? 140);
</script>

<NodeResizer
	isVisible={selected}
	minWidth={120}
	minHeight={60}
	color="var(--accent, #60a5fa)"
	onResize={(_e, p) => (live = { w: p.width, h: p.height })}
	onResizeEnd={(_e, p) => {
		live = null;
		runNodeAction('noteResized', { id, x: p.x, y: p.y, w: Math.round(p.width), h: Math.round(p.height) });
	}}
/>
<div
	class="tp-note tp-note-{color}"
	class:tp-note-frame={framing}
	style="width: {w}px; height: {h}px"
	data-note-color={color}
>
	<div class="tp-note-title">{data?.title || 'Note'}</div>
	<div class="tp-note-body">
		{#each blocks as block, bi (bi)}
			{#if block.t === 'hr'}
				<hr />
			{:else}
				<svelte:element
					this={block.t === 'h' ? 'h' + (block.level ?? 1) : block.t === 'quote' ? 'blockquote' : block.t === 'li' || block.t === 'oli' ? 'div' : 'p'}
					class="tp-note-{block.t}"
				>
					{#if block.t === 'li'}<span class="tp-note-bullet">•</span>{:else if block.t === 'oli'}<span class="tp-note-bullet">{block.n}.</span>{/if}
					{#each block.spans as span, si (si)}
						{#if span.t === 'b'}<strong>{span.v}</strong>
						{:else if span.t === 'i'}<em>{span.v}</em>
						{:else if span.t === 'code'}<code>{span.v}</code>
						{:else if span.t === 's'}<s>{span.v}</s>
						{:else if span.t === 'a'}<a href={span.href} target="_blank" rel="noopener noreferrer nofollow" class="nodrag">{span.v}</a>
						{:else}{span.v}{/if}
					{/each}
				</svelte:element>
			{/if}
		{/each}
		{#if !blocks.length && !framing}
			<p class="tp-note-empty">Select the note and write its description in the properties panel (⚙).</p>
		{/if}
	</div>
</div>

<style>
	/* theme tokens for the note tints: a translucent fill + a stronger edge, retuned for light */
	:global(:root) {
		--note-yellow: 234 179 8;
		--note-blue: 59 130 246;
		--note-green: 34 197 94;
		--note-pink: 236 72 153;
		--note-purple: 168 85 247;
		--note-gray: 148 163 184;
		--note-fill-alpha: 0.16;
		--note-ink: var(--text, #e5e7eb);
	}
	:global(:root[data-theme='light']) {
		--note-fill-alpha: 0.22;
		--note-ink: var(--text, #111827);
	}
	.tp-note {
		display: flex;
		flex-direction: column;
		border-radius: 8px;
		border: 1px solid rgb(var(--note-rgb) / 0.75);
		background: rgb(var(--note-rgb) / var(--note-fill-alpha));
		color: var(--note-ink);
		box-shadow: 0 6px 16px rgb(0 0 0 / 0.25);
		overflow: hidden;
	}
	.tp-note-frame {
		border-style: dashed;
		background: rgb(var(--note-rgb) / calc(var(--note-fill-alpha) * 0.6));
		box-shadow: none;
	}
	.tp-note-yellow { --note-rgb: var(--note-yellow); }
	.tp-note-blue { --note-rgb: var(--note-blue); }
	.tp-note-green { --note-rgb: var(--note-green); }
	.tp-note-pink { --note-rgb: var(--note-pink); }
	.tp-note-purple { --note-rgb: var(--note-purple); }
	.tp-note-gray { --note-rgb: var(--note-gray); }
	.tp-note-title {
		font-weight: 700;
		font-size: 12px;
		padding: 5px 9px;
		background: rgb(var(--note-rgb) / 0.32);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tp-note-body {
		flex: 1;
		overflow: hidden;
		padding: 6px 9px;
		font-size: 11px;
		line-height: 1.45;
	}
	.tp-note-body :global(h1),
	.tp-note-body :global(h2),
	.tp-note-body :global(h3) {
		font-weight: 700;
		margin: 2px 0 3px;
	}
	.tp-note-body :global(h1) { font-size: 14px; }
	.tp-note-body :global(h2) { font-size: 13px; }
	.tp-note-body :global(h3) { font-size: 12px; }
	.tp-note-body :global(p) { margin: 0 0 4px; }
	.tp-note-body :global(blockquote) {
		border-left: 2px solid rgb(var(--note-rgb) / 0.8);
		padding-left: 6px;
		opacity: 0.85;
		margin: 0 0 4px;
	}
	.tp-note-body :global(code) {
		font-family: ui-monospace, monospace;
		background: rgb(0 0 0 / 0.2);
		border-radius: 3px;
		padding: 0 3px;
	}
	.tp-note-body :global(a) {
		text-decoration: underline;
	}
	.tp-note-bullet {
		display: inline-block;
		min-width: 14px;
		opacity: 0.8;
	}
	.tp-note-empty {
		opacity: 0.6;
		font-style: italic;
	}
	hr {
		border-color: rgb(var(--note-rgb) / 0.6);
		margin: 4px 0;
	}
</style>
