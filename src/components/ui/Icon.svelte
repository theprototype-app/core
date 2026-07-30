<script>
	// Data-driven icon lookup (Explorer kind icons, menu item defs — anywhere the
	// icon NAME lives in data). Markup with a static icon imports the component
	// from '@lucide/svelte' directly instead (tree-shaking stays exact); see the
	// icons note in CLAUDE.md. Names are lucide kebab-case.
	import {
		Archive,
		Box,
		Boxes,
		FileText,
		Folder,
		Image,
		Music,
		Package,
		PackageOpen
	} from '@lucide/svelte';

	/** @type {Record<string, any>} */
	const MAP = {
		archive: Archive,
		box: Box,
		boxes: Boxes,
		'file-text': FileText,
		folder: Folder,
		image: Image,
		music: Music,
		package: Package,
		'package-open': PackageOpen
	};

	/** @type {{ name: string, size?: number } & Record<string, any>} */
	let { name, size = 16, ...rest } = $props();
	const Cmp = $derived(MAP[name] ?? Box);
</script>

<Cmp {size} aria-hidden="true" {...rest} />
