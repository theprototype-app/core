<script>
	// Data-driven icon lookup (Explorer kind icons, menu item defs — anywhere the
	// icon NAME lives in data). Markup with a static icon imports the component
	// from '@lucide/svelte' directly instead (tree-shaking stays exact); see the
	// icons note in CLAUDE.md. Names are lucide kebab-case.
	import {
		Archive,
		ArrowDownToLine,
		Box,
		Boxes,
		Brush,
		Camera,
		Combine,
		Copy,
		Eye,
		FileText,
		Focus,
		Folder,
		GitBranchPlus,
		Grid3x3,
		Group,
		Hand,
		Image,
		Lock,
		Magnet,
		Music,
		Package,
		PackageOpen,
		Pencil,
		PenTool,
		Plus,
		Radar,
		Redo2,
		Search,
		SlidersHorizontal,
		Sparkles,
		StickyNote,
		Trash2,
		Undo2,
		Ungroup,
		Workflow,
		Wrench
	} from '@lucide/svelte';

	// 15-Q (context-menu redesign): the menu item defs carry icon NAMES in data,
	// so their icons resolve here too.
	/** @type {Record<string, any>} */
	const MAP = {
		archive: Archive,
		'arrow-down-to-line': ArrowDownToLine,
		box: Box,
		boxes: Boxes,
		brush: Brush,
		camera: Camera,
		combine: Combine,
		copy: Copy,
		eye: Eye,
		'file-text': FileText,
		focus: Focus,
		folder: Folder,
		'git-branch-plus': GitBranchPlus,
		'grid-3x3': Grid3x3,
		group: Group,
		hand: Hand,
		image: Image,
		lock: Lock,
		magnet: Magnet,
		music: Music,
		package: Package,
		'package-open': PackageOpen,
		pencil: Pencil,
		'pen-tool': PenTool,
		plus: Plus,
		radar: Radar,
		'redo-2': Redo2,
		search: Search,
		'sliders-horizontal': SlidersHorizontal,
		sparkles: Sparkles,
		'sticky-note': StickyNote,
		'trash-2': Trash2,
		'undo-2': Undo2,
		ungroup: Ungroup,
		workflow: Workflow,
		wrench: Wrench
	};

	/** @type {{ name: string, size?: number } & Record<string, any>} */
	let { name, size = 16, ...rest } = $props();
	const Cmp = $derived(MAP[name] ?? Box);
</script>

<Cmp {size} aria-hidden="true" {...rest} />
