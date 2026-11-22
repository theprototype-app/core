<script lang="ts">
	// 2.0 N2 — the Nodes editor's CODE tab (flag codeView): the current graph as read-only code, one
	// statement per node (src/lib/nodes/flowCode.js via flowCodeView — the same text the agent reads).
	// Line -> node: pressing a node's line selects and frames it (flowFocus, the code workspace's "show me
	// this node" path). Node -> line: the selected node's line is marked and scrolled into view. Copy puts
	// the whole text on the clipboard. On a phone this is the same panel as a full-width sheet.
	import { tick } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { codeForGraph } from '$lib/nodes/flowCodeView.js';
	import { flowFocus, showToast } from '../../stores/appStore';

	let { graph, graphId, selectedId = null }: { graph: { nodes: any[]; edges: any[] } | undefined; graphId: string; selectedId?: string | null } = $props();

	const result = $derived(codeForGraph(graph ?? { nodes: [], edges: [] }, graphId));
	const lines = $derived(result.code.replace(/\n$/, '').split('\n'));
	let list: HTMLOListElement | undefined = $state();

	/** a node's line, split so the id comment can be dimmed */
	function parts(text: string) {
		const cut = text.lastIndexOf(' // #');
		return cut < 0 ? { body: text, id: '' } : { body: text.slice(0, cut), id: text.slice(cut + 1) };
	}

	// node -> line: keep the selected node's line in view
	$effect(() => {
		const id = selectedId;
		if (!id || !list) return;
		void result;
		tick().then(() => {
			const el = list?.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
			(el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
		});
	});

	async function copy() {
		try {
			await navigator.clipboard.writeText(result.code);
			showToast('Code copied');
		} catch {
			showToast('Could not reach the clipboard — select the text and copy it');
		}
	}
</script>

<div id="flow-code" class="flex min-h-0 flex-1 flex-col gap-1" data-graph-id={graphId}>
	<div class="flex items-center gap-1">
		<p class="ui-section-label truncate">Code · read-only</p>
		<button
			id="flow-code-copy"
			type="button"
			class="ml-auto flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 hover:bg-surface-active"
			title="Copy the code"
			aria-label="Copy the code"
			onclick={copy}><Icon name="copy" size={16} class="shrink-0" /> Copy</button>
	</div>
	<p class="text-[length:var(--fs-badge)] leading-snug text-text-muted">Generated from the graph. Press a node's line to select it.</p>
	<ol
		id="flow-code-lines"
		bind:this={list}
		use:minimalScroll
		class="code-lines min-h-0 flex-1 overflow-auto rounded-sm bg-surface-2 py-1 font-mono text-[length:var(--fs-badge)] leading-relaxed text-text-2"
		aria-label="The graph as code, read-only"
	>
		{#each lines as text, i (i)}
			{@const id = result.nodeAt[i + 1]}
			{@const p = parts(text)}
			<li class="flex" data-line={i + 1} data-node-id={id ?? null}>
				<span class="w-7 shrink-0 select-none pr-1.5 text-right text-text-muted" aria-hidden="true">{i + 1}</span>
				{#if id}
					<button
						type="button"
						class="code-line min-w-0 flex-1 rounded-sm pr-2 text-left hover:bg-surface-active {id === selectedId ? 'bg-accent-soft text-accent-soft-text' : ''}"
						aria-current={id === selectedId ? 'true' : undefined}
						title="Select this node"
						onclick={() => flowFocus.set(id)}
					><span class="whitespace-pre">{p.body}</span> <span class="whitespace-pre text-text-muted">{p.id}</span></button>
				{:else}
					<span class="min-w-0 flex-1 whitespace-pre pr-2 {text.trimStart().startsWith('//') ? 'text-text-muted' : ''}">{text}</span>
				{/if}
			</li>
		{/each}
	</ol>
</div>

<style>
	.code-lines {
		tab-size: 2;
	}
</style>
