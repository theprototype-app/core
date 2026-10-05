<script lang="ts">
	// 36 B14 — the container the sections sit in (Settings.svelte imports it as `Accordion`, so
	// its `<Accordion multiple>` line is untouched). No chrome of its own: WindowShell is the
	// chrome now and the sidebar is the navigation. `multiple` is accepted and means nothing —
	// outside a search exactly one section is open (settingsNav), inside one all of them are.
	import type { Snippet } from 'svelte';
	let { children }: { multiple?: boolean; children?: Snippet } = $props();
</script>

<div id="settings-sections">{@render children?.()}</div>
