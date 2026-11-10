<script lang="ts">
	// 78 PL37 — a QR code drawn on this machine (src/lib/qr/qrEncode.js: no network, no dependency).
	// Black on white in every theme with the standard four-module quiet zone, one SVG path, crisp edges.
	import { encodeQr, qrSvgPath } from '$lib/qr/qrEncode';

	let {
		text,
		size = 176,
		label = 'QR code',
		id = undefined
	}: { text: string; size?: number; label?: string; id?: string } = $props();

	const BORDER = 4;
	const qr = $derived.by(() => {
		try {
			return text ? encodeQr(text, 'M') : null;
		} catch {
			return null;
		}
	});
	const box = $derived(qr ? qr.size + BORDER * 2 : 0);
	const path = $derived(qr ? qrSvgPath(qr, BORDER) : '');
</script>

{#if qr}
	<svg
		{id}
		class="qr"
		width={size}
		height={size}
		viewBox="0 0 {box} {box}"
		role="img"
		aria-label={label}
		shape-rendering="crispEdges"
		data-qr-version={qr.version}
		data-qr-text={text}
	>
		<rect class="qr-paper" width={box} height={box} />
		<path class="qr-ink" d={path} />
	</svg>
{/if}

<style>
	.qr {
		display: block;
		flex: 0 0 auto;
		border-radius: var(--radius-button);
	}
	.qr-paper {
		fill: var(--qr-paper);
	}
	.qr-ink {
		fill: var(--qr-ink);
	}
</style>
