<script lang="ts">
	// 103 H7 — the app's transform gizmo, replacing threlte's <TransformControls> in Scene.svelte with
	// the SAME contract: one instance bound out as `controls`, attached to an empty group until a
	// selection takes it, its helper added to the scene, `change` invalidating the frame, camera
	// controls paused while a drag runs (Scene also does that itself, 16-Q5). On top: the face for the
	// style in force, loaded lazily (style A = three's own gizmo, nothing loaded).
	import { T, useThrelte, useThrelteUserContext } from '@threlte/core';
	import { Group } from 'three';
	import { writable, type Writable } from 'svelte/store';
	import { GizmoControls } from '$lib/gizmo/gizmoControls.js';
	import { activeGizmoStyle, handleSet, gizmoHide, gizmoSize, SIZE_FACTOR, selectionAppeared } from '$lib/gizmo/gizmoPrefs.js';
	import { theme } from '$lib/themes';
	import { selectedObjects, objectsGroup } from '../stores/sceneStore';
	import { get } from 'svelte/store';

	let { controls = $bindable(), onchange, oncreate }: { controls?: any; onchange?: (e: any) => void; oncreate?: (ref: any) => void } = $props();

	const { camera, dom, invalidate, scene } = useThrelte();
	const ctx: Record<string, Writable<any>> = useThrelteUserContext('threlte-controls', {
		orbitControls: writable(undefined),
		trackballControls: writable(undefined),
		cameraControls: writable(undefined),
		transformControls: writable(undefined)
	}) as any;

	const tc: any = new GizmoControls(camera.current, dom);
	// D's box around a multi-selection: the members the pivot moves
	tc.boxMembers = () => {
		const group: any = get(objectsGroup);
		return get(selectedObjects).map((u: string) => group?.getObjectByProperty('uuid', u)).filter(Boolean);
	};
	const attachGroup = new Group();
	let isDragging = $state(false);

	// pause whatever camera controls the context holds while a drag runs (threlte's rule, kept)
	for (const key of ['orbitControls', 'trackballControls', 'cameraControls']) {
		const store = ctx[key];
		$effect(() => {
			const unsub = store.subscribe((c: any) => {
				if (!c || (!c.enabled && isDragging)) return;
				c.enabled = !isDragging;
			});
			return () => {
				unsub();
				const c = (store as any) && getValue(store);
				if (c) c.enabled = true;
			};
		});
	}
	function getValue(store: Writable<any>) {
		let v: any;
		store.subscribe((x) => (v = x))();
		return v;
	}

	$effect(() => {
		tc.camera = $camera;
	});
	$effect.pre(() => {
		tc.attach(attachGroup);
		return () => tc.detach();
	});
	$effect(() => {
		ctx.transformControls.set(tc);
		return () => ctx.transformControls.set(undefined);
	});

	// --- the face for the style in force (row 8: style A's middle step borrows B's all in one) ---
	let faceToken = 0;
	const faceStyle = $derived($activeGizmoStyle === 'A' ? ($handleSet === 'all' ? 'B' : 'A') : $activeGizmoStyle);
	$effect(() => {
		const style = faceStyle;
		const token = ++faceToken;
		tc.gizmoStyle = $activeGizmoStyle;
		if (style === 'A') {
			tc.setFace(null);
			invalidate();
			return;
		}
		void import('$lib/gizmo/faces.js').then((m) => {
			if (token !== faceToken) return;
			tc.setFace(m.createFace(style, tc));
			invalidate();
		});
	});
	$effect(() => {
		tc.handleSet = $activeGizmoStyle === 'A' ? 'all' : $handleSet;
		tc.hiddenKinds = new Set($gizmoHide[faceStyle] ?? []);
		tc.syncFace();
		invalidate();
	});
	$effect(() => {
		// the size step multiplies whatever base size the theme set (High contrast: 1.35)
		tc.sizeFactor = SIZE_FACTOR[$gizmoSize as 'M'] ?? 1;
		tc.size = (tc.baseSize ?? 1) * tc.sizeFactor;
		invalidate();
	});

	// row 8: a selection that appears starts the style's cycle (B, C, D: all in one; A: the tool)
	let hadSelection = false;
	$effect(() => {
		const has = $selectedObjects.length > 0;
		if (has && !hadSelection) selectionAppeared();
		hadSelection = has;
	});

	// the faces paint from the theme's tokens (a GL colour cannot take var())
	$effect(() => {
		void $theme;
		requestAnimationFrame(() => {
			const cs = getComputedStyle(document.documentElement);
			const v = (n: string, d: number) => {
				const raw = cs.getPropertyValue(n).trim();
				return raw || d;
			};
			tc.faceColors = {
				x: v('--axis-x', 0xf0625a),
				y: v('--axis-y', 0x74c655),
				z: v('--axis-z', 0x5b97f5),
				hover: v('--gizmo-hover', 0xffd166),
				neutral: v('--gizmo-neutral', 0xe8e4d8)
			};
			invalidate();
		});
	});

	function handleChange(event: any) {
		invalidate();
		if (tc.dragging && !isDragging) isDragging = true;
		else if (!tc.dragging && isDragging) isDragging = false;
		onchange?.(event);
	}
</script>

<T
	is={tc}
	bind:ref={controls}
	onchange={handleChange}
	attach={({ ref }: { ref: any }) => {
		const helper = ref.getHelper();
		scene.add(helper);
		return () => {
			scene.remove(helper);
		};
	}}
	dispose={false}
	oncreate={(ref: any) => {
		return () => ref.dispose();
	}}
/>

<T is={attachGroup} {oncreate} />
