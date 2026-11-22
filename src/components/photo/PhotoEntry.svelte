<script>
	// Roadmap 98 P2 (lane 98-photo) — the Look section's way into Photo mode: one row, one button. Registered
	// with one line in Inspector's "Scene look" section; it imports only the boot-safe photoOpen leaf.
	import Button from '../ui/Button.svelte';
	import { openPhoto } from '$lib/photo/photoOpen.js';
</script>

<div class="mb-2 flex items-center gap-2">
	<Button
		id="scene-look-photo"
		size="sm"
		icon="camera"
		text="Photo…"
		title="Render a path-traced still of this view (PNG)"
		onclick={() => openPhoto()}
	/>
	<span class="text-[length:var(--fs-badge)] text-text-muted">A path-traced still of your view, as a PNG.</span>
</div>
