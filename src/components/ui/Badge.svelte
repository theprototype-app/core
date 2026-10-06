<script>
	// 38 R3 — a small pill (SPEC §2 Badge): scope ("This device", "Shared"), status, counts.
	// Scope replaces explanatory prose: a row says "This device" as a badge, not a sentence.
	//   scope    badge-bg / badge-text (the default)
	//   ok / warn / bad / off   status: the scope pill + a status DOT in the theme's state ink
	//            (--ink-good / -warn / -bad; off = faint). Status is a Badge, never a coloured
	//            pill of its own (SPEC §5 "Reconnecting…").
	//   count    a mono number, no fill
	//   live     ONLY live/streaming state (--live), pulsing dot
	//   neutral  quiet outline
	// `dot` forces a leading dot on any tone (an unread marker).
	/** @type {{tone?: 'scope'|'ok'|'warn'|'bad'|'off'|'count'|'live'|'neutral', dot?: boolean, title?: string, text?: string, children?: import('svelte').Snippet} & Record<string, any>} */
	let { tone = 'scope', dot = false, title = undefined, text = '', children = undefined, ...rest } = $props();
	const STATUS = ['ok', 'warn', 'bad', 'off', 'live'];
</script>

<span class="tp-ui badge badge-{tone}" {title} {...rest}>
	{#if dot || STATUS.includes(tone)}<span class="badge-dot" aria-hidden="true"></span>{/if}
	{#if children}{@render children()}{:else}{text}{/if}
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
		height: 20px;
		padding: 0 8px;
		border-radius: var(--radius-pill);
		font-size: var(--fs-badge);
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		vertical-align: middle;
		background: var(--badge-bg);
		color: var(--badge-text);
	}
	.badge-ok .badge-dot {
		background: var(--ink-good);
	}
	.badge-warn .badge-dot {
		background: var(--ink-warn);
		animation: badge-pulse 1.6s infinite;
	}
	.badge-bad .badge-dot {
		background: var(--ink-bad);
	}
	.badge-off .badge-dot {
		background: var(--text-faint);
	}
	.badge-live {
		background: color-mix(in srgb, var(--live) 18%, transparent);
		color: var(--live);
	}
	.badge-live .badge-dot {
		animation: badge-pulse 1.4s infinite;
	}
	@keyframes badge-pulse {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.badge-dot {
			animation: none !important;
		}
	}
	.badge-count {
		min-width: 20px;
		justify-content: center;
		padding: 0 6px;
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
	}
	.badge-neutral {
		background: transparent;
		border: 1px solid var(--border-strong);
		color: var(--text-muted);
	}
	.badge-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
</style>
