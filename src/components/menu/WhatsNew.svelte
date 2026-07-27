<script lang="ts">
	// RW/B4: the changelog as a floating window (same chrome as the other floating
	// windows — ui-panel + dragWindow + focusStack). Opened by the logo-menu row, the
	// update toast, or Settings ▸ About. Opening it marks the version seen.
	import { whatsNewOpen, closeWhatsNew, CHANGELOG } from '$lib/whatsNew';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';

	let winEl: any = $state(null);

	$effect(() => {
		if ($whatsNewOpen) setTimeout(() => winEl?.focus(), 0); // so Esc closes it
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeWhatsNew();
		}
	}

	// Deliberately tiny markdown subset instead of a dependency: the input is our own
	// bundled CHANGELOG.md, and everything is HTML-escaped BEFORE the inline rules run,
	// so the {@html} below cannot inject markup even if the file grows odd characters.
	function esc(s: string) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	function inline(s: string) {
		return esc(s)
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
	}
	/** Markdown -> a flat block list the template renders. */
	function blocks(source: string) {
		// HTML comments carry maintainer notes for the GitHub view — never render them
		const md = source.replace(/<!--[\s\S]*?-->/g, '');
		/** @type {{kind: string, html: string, items?: string[]}[]} */
		const out: { kind: string; html: string; items?: string[] }[] = [];
		let para: string[] = [];
		let list: string[] = [];
		const flushPara = () => {
			if (para.length) out.push({ kind: 'p', html: inline(para.join(' ')) });
			para = [];
		};
		const flushList = () => {
			if (list.length) out.push({ kind: 'ul', html: '', items: list.map(inline) });
			list = [];
		};
		const flush = () => {
			flushPara();
			flushList();
		};
		for (const raw of md.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) {
				flush();
				continue;
			}
			const heading = /^(#{1,4})\s+(.*)$/.exec(line);
			if (heading) {
				flush();
				out.push({ kind: 'h' + heading[1].length, html: inline(heading[2]) });
				continue;
			}
			const bullet = /^[-*]\s+(.*)$/.exec(line);
			if (bullet) {
				flushPara();
				list.push(bullet[1]);
				continue;
			}
			// a wrapped bullet continues the previous item
			if (list.length) list[list.length - 1] += ' ' + line;
			else para.push(line);
		}
		flush();
		return out;
	}

	// The leading "# Changelog" title is for the GitHub view — in here the window
	// header already says it, so h1s are dropped rather than duplicating it.
	const parsed = blocks(CHANGELOG).filter((b) => b.kind !== 'h1');
</script>

{#if $whatsNewOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="whats-new-window"
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel fixed flex flex-col overflow-hidden outline-none"
		use:dragWindow={{ key: 'whatsNewWin', defaultRect: { left: 220, top: 90 } }}
		use:focusStack
		style="z-index: var(--z-window); width: min(620px, 94vw); height: min(620px, 80vh)"
		onkeydown={onKeydown}
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span>✨ What's new</span>
			<span class="flex-1"></span>
			<button id="whats-new-close" class="ui-button-quiet" title="Close" onclick={closeWhatsNew}>✕</button>
		</div>
		<div class="wn-body min-h-0 flex-1 overflow-y-auto px-4 py-3">
			{#each parsed as block}
				{#if block.kind === 'h2'}
					<h2>{@html block.html}</h2>
				{:else if block.kind === 'h3'}
					<h3>{@html block.html}</h3>
				{:else if block.kind === 'h4'}
					<h4>{@html block.html}</h4>
				{:else if block.kind === 'ul'}
					<ul>
						{#each block.items ?? [] as item}
							<li>{@html item}</li>
						{/each}
					</ul>
				{:else}
					<p>{@html block.html}</p>
				{/if}
			{/each}
		</div>
	</div>
{/if}

<style>
	.wn-body {
		font-size: 13px;
		line-height: 1.6;
		color: #d1d5db;
	}
	.wn-body h2 {
		font-size: 15.5px;
		font-weight: 700;
		color: #f3f4f6;
		margin: 20px 0 8px;
		padding-bottom: 6px;
		border-bottom: 1px solid rgb(255 255 255 / 0.09);
	}
	.wn-body h2:first-child {
		margin-top: 0;
	}
	.wn-body h3 {
		font-size: 13.5px;
		font-weight: 650;
		color: #e5e7eb;
		margin: 16px 0 6px;
	}
	.wn-body h4 {
		font-size: 12.5px;
		font-weight: 600;
		color: #cbd5e1;
		margin: 12px 0 4px;
	}
	.wn-body p {
		margin: 7px 0;
	}
	.wn-body ul {
		margin: 6px 0 10px;
		padding-left: 18px;
		list-style: disc;
	}
	.wn-body li {
		margin: 4px 0;
	}
	.wn-body :global(strong) {
		color: #f3f4f6;
		font-weight: 620;
	}
	.wn-body :global(code) {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		padding: 1px 5px;
		border-radius: 5px;
		background: rgb(255 255 255 / 0.08);
		color: #e5e7eb;
	}
	.wn-body :global(a) {
		color: #93c5fd;
		text-decoration: underline;
	}
	.wn-body :global(a:hover) {
		color: #bfdbfe;
	}
</style>
