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
		// W8b: `MAP[name] ?? Box` means an unmapped name renders a SQUARE, silently —
		// which is what the toolbar's reorder controls had been drawing since they
		// shipped, two identical boxes where a direction was meant to be. Any name a
		// menu passes has to exist here.
		ChevronDown,
		ChevronUp,
		Combine,
		Copy,
		Eye,
		FileText,
		Focus,
		Folder,
		FolderInput,
		Gamepad2,
		GitBranchPlus,
		Grid3x3,
		Group,
		Hand,
		HardDrive,
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
		RefreshCw,
		Save,
		Search,
		SlidersHorizontal,
		Sparkles,
		Spline,
		StickyNote,
		Trash2,
		Undo2,
		Ungroup,
		Workflow,
		Wrench,
		X
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
		'chevron-down': ChevronDown,
		'chevron-up': ChevronUp,
		combine: Combine,
		copy: Copy,
		eye: Eye,
		'file-text': FileText,
		focus: Focus,
		folder: Folder,
		'folder-input': FolderInput,
		'gamepad-2': Gamepad2,
		'git-branch-plus': GitBranchPlus,
		'grid-3x3': Grid3x3,
		group: Group,
		hand: Hand,
		'hard-drive': HardDrive,
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
		'refresh-cw': RefreshCw,
		save: Save,
		search: Search,
		'sliders-horizontal': SlidersHorizontal,
		sparkles: Sparkles,
		spline: Spline,
		'sticky-note': StickyNote,
		'trash-2': Trash2,
		'undo-2': Undo2,
		ungroup: Ungroup,
		workflow: Workflow,
		wrench: Wrench,
		x: X
	};

	/** @type {{ name: string, size?: number } & Record<string, any>} */
	let { name, size = 16, ...rest } = $props();
	const Cmp = $derived(MAP[name] ?? Box);
</script>

<Cmp {size} aria-hidden="true" {...rest} />
