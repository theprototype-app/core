<script lang="ts">
	import { get } from 'svelte/store';
	import * as THREE from 'three';
	import { MessageSquare, Star, Layers } from '@lucide/svelte';
	import {
		annotations,
		activeAnnotation,
		annotationOwner,
		openAnnotation,
		showNotePins,
		displayName,
		displayAuthor,
		contrastOn,
		rgbaOf,
		DEFAULT_NOTE_COLOR
	} from '$lib/annotationsHandler';
	import { globalCamera, globalRenderer, objectsGroup, isVRMode } from '../../stores/sceneStore';

	// Notes v3 markers: SCREEN-SPACE badges with a leader line to the exact 3D
	// point. The old in-scene quads could be CUT IN HALF by any surface they
	// touched (a billboard rotating into a face), and their occlusion depended on
	// the GPU depth test, which is all-or-nothing per pixel. Here the badge is
	// DOM, so it can never clip against geometry, and occlusion is decided once
	// per marker by a raycast with a few centimetres of slack: a marker sitting ON
	// a surface still counts as visible, one genuinely behind something goes
	// translucent (fill only — the number stays fully readable) with a dashed
	// leader. Clusters collapse into a single counted badge that fans out on click.
	//
	// VR keeps the in-scene meshes (AnnotationPins.svelte): DOM is invisible in a
	// headset. Everything here is LOCAL — no replication, no store writes.

	const LEADER = 38; // px from the exact point up to the badge centre
	const BADGE_H = 26; // px, keep in sync with .marker-badge height
	const CLUSTER_PX = 34; // badges closer than this overlap, so they collapse into one
	const FAN_RADIUS = 52; // px, expanded cluster members
	const OCCLUSION_SLACK = 0.08; // 8cm — geometry this close never counts as cover
	const OCCLUSION_MS = 120; // raycast budget: ~8Hz, positions still update per frame
	const NEAR_FADE = 0.9; // metres — fade out when the camera is right on top of it
	const NEAR_HIDE = 0.35;

	const ICONS: Record<string, any> = { round: MessageSquare, star: Star, square: MessageSquare };

	type Marker = {
		id: string;
		color: string;
		ink: string;
		shape: string;
		number: number;
		title: string;
		author: string;
		when: string;
		text: string;
		x: number;
		y: number;
		px: number;
		py: number;
		occluded: boolean;
		fade: number;
		cluster: string[] | null;
	};

	let markers = $state<Marker[]>([]);
	let hoverId = $state('');
	let expanded = $state(''); // cluster key currently fanned out
	const active = $derived($activeAnnotation?.id ?? '');
	const enabled = $derived($showNotePins && !$isVRMode);

	// --- geometry ---------------------------------------------------------------
	const world = new THREE.Vector3();
	const projected = new THREE.Vector3();
	const toPoint = new THREE.Vector3();
	const raycaster = new THREE.Raycaster();
	/** id -> resolved owner object (re-resolved on a slow schedule, not per frame) */
	const owners = new Map<string, any>();
	/** id -> last occlusion verdict (raycasts are throttled) */
	const occluded = new Map<string, boolean>();
	let lastResolve = 0;
	let lastOcclusion = 0;

	function resolveOwners(list: any[]) {
		owners.clear();
		for (const a of list) owners.set(a.id, annotationOwner(a.objectUuid));
	}

	/** Is `point` genuinely behind scene geometry, ignoring anything within the slack? */
	function isOccluded(camera: any, point: THREE.Vector3) {
		const group = get(objectsGroup);
		if (!group) return false;
		toPoint.subVectors(point, camera.position);
		const distance = toPoint.length();
		if (distance <= OCCLUSION_SLACK) return false;
		raycaster.set(camera.position, toPoint.normalize());
		raycaster.near = 0;
		raycaster.far = distance - OCCLUSION_SLACK;
		const hits = raycaster.intersectObject(group, true);
		// three does not filter hidden objects for us — a hidden mesh must not occlude
		return hits.some((hit) => {
			for (let node: any = hit.object; node && node !== group; node = node.parent)
				if (!node.visible) return false;
			return true;
		});
	}

	function when(ts: number) {
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return '';
		}
	}

	$effect(() => {
		if (!enabled) {
			markers = [];
			return;
		}
		let raf = requestAnimationFrame(step);
		function step() {
			raf = requestAnimationFrame(step);
			const list = get(annotations);
			const camera: any = get(globalCamera);
			const renderer: any = get(globalRenderer);
			if (!list.length || !camera || !renderer?.domElement) {
				if (markers.length) markers = [];
				return;
			}
			const now = performance.now();
			if (now - lastResolve > 250 || owners.size !== list.length) {
				lastResolve = now;
				resolveOwners(list);
			}
			const testOcclusion = now - lastOcclusion > OCCLUSION_MS;
			if (testOcclusion) lastOcclusion = now;
			const rect = renderer.domElement.getBoundingClientRect();

			/** @type {Marker[]} */
			const next: Marker[] = [];
			list.forEach((a, index) => {
				const owner = owners.get(a.id);
				if (!owner) return;
				owner.localToWorld(world.fromArray(a.offset));
				projected.copy(world).project(camera);
				if (projected.z >= 1) return; // behind the camera
				const px = rect.left + ((projected.x + 1) / 2) * rect.width;
				const py = rect.top + ((1 - projected.y) / 2) * rect.height;
				if (px < -80 || py < -80 || px > window.innerWidth + 80 || py > window.innerHeight + 80)
					return; // off-screen: skip the raycast too
				if (testOcclusion) occluded.set(a.id, isOccluded(camera, world));
				const distance = camera.position.distanceTo(world);
				if (distance < NEAR_HIDE) return;
				const color = a.color || DEFAULT_NOTE_COLOR;
				next.push({
					id: a.id,
					color,
					ink: contrastOn(color),
					shape: a.shape || 'round',
					number: index + 1,
					title: displayName(a),
					author: displayAuthor(a),
					when: when(a.ts),
					text: a.text || '',
					x: px,
					y: py - LEADER,
					px,
					py,
					occluded: occluded.get(a.id) ?? false,
					fade: distance < NEAR_FADE ? 0.35 : 1,
					cluster: null
				});
			});
			markers = cluster(next);
		}
		return () => cancelAnimationFrame(raf);
	});

	/**
	 * Greedy screen-space clustering in note order (deterministic): a marker joins
	 * the first cluster whose badge is within CLUSTER_PX. A cluster renders ONE
	 * counted badge; the expanded one fans its members around the centroid so each
	 * still points at its own 3D spot.
	 */
	function cluster(list: Marker[]): Marker[] {
		/** @type {Marker[][]} */
		const groups: Marker[][] = [];
		for (const marker of list) {
			const near = groups.find((g) => Math.hypot(g[0].x - marker.x, g[0].y - marker.y) < CLUSTER_PX);
			if (near) near.push(marker);
			else groups.push([marker]);
		}
		const out: Marker[] = [];
		for (const group of groups) {
			if (group.length === 1) {
				out.push(group[0]);
				continue;
			}
			const key = group.map((m) => m.id).join('|');
			if (expanded === key) {
				// fan out around the centroid, keeping every leader line honest
				const cx = group.reduce((sum, m) => sum + m.x, 0) / group.length;
				const cy = group.reduce((sum, m) => sum + m.y, 0) / group.length;
				const spread = Math.min(Math.PI * 1.5, group.length * 0.7);
				group.forEach((m, i) => {
					const angle = -Math.PI / 2 - spread / 2 + (spread * i) / Math.max(1, group.length - 1);
					out.push({ ...m, x: cx + Math.cos(angle) * FAN_RADIUS, y: cy + Math.sin(angle) * FAN_RADIUS });
				});
				continue;
			}
			const head = group[0];
			out.push({
				...head,
				id: key,
				title: group.length + ' notes here',
				text: group.map((m) => '#' + m.number + ' ' + m.title).join(' · '),
				occluded: group.every((m) => m.occluded),
				number: group.length,
				cluster: group.map((m) => m.id)
			});
		}
		return out;
	}

	function activate(marker: Marker) {
		if (marker.cluster) {
			expanded = expanded === marker.id ? '' : marker.id;
			return;
		}
		expanded = '';
		openAnnotation(marker.id, 'view');
	}
</script>

{#if enabled && markers.length}
	<!-- leader lines live in one SVG under the badges; the whole layer is
	     pointer-transparent so the viewport keeps every drag it had -->
	<svg class="marker-lines" aria-hidden="true">
		{#each markers as marker (marker.id)}
			<g
				opacity={(marker.occluded ? 0.5 : 1) * marker.fade}
				stroke-dasharray={marker.occluded ? '3 3' : 'none'}
			>
				<line
					x1={marker.x}
					y1={marker.y + BADGE_H / 2 - 2}
					x2={marker.px}
					y2={marker.py}
					stroke={marker.color}
					stroke-width="3"
					stroke-opacity="0.22"
					stroke-linecap="round"
				/>
				<line
					x1={marker.x}
					y1={marker.y + BADGE_H / 2 - 2}
					x2={marker.px}
					y2={marker.py}
					stroke={marker.color}
					stroke-width="1.25"
					stroke-opacity="0.95"
					stroke-linecap="round"
				/>
				<circle cx={marker.px} cy={marker.py} r="2.6" fill={marker.color} stroke-width="0" />
				<circle
					cx={marker.px}
					cy={marker.py}
					r="4"
					fill="none"
					stroke="var(--marker-outline, rgba(255,255,255,0.85))"
					stroke-width="1"
					stroke-dasharray="none"
				/>
			</g>
		{/each}
	</svg>

	<div class="marker-layer">
		{#each markers as marker (marker.id)}
			{@const Icon = marker.cluster ? Layers : ICONS[marker.shape] ?? MessageSquare}
			<button
				class="marker-badge"
				class:is-occluded={marker.occluded}
				class:is-active={!marker.cluster && active === marker.id}
				class:is-cluster={!!marker.cluster}
				class:is-square={marker.shape === 'square' && !marker.cluster}
				style="
					left:{marker.x}px; top:{marker.y}px; opacity:{marker.fade};
					--fill:{marker.occluded ? rgbaOf(marker.color, 0.5) : marker.color};
					--ink:{marker.ink};
					--ring:{marker.color};
				"
				title={marker.cluster ? marker.title : '#' + marker.number + ' ' + marker.title}
				aria-label={marker.cluster ? marker.title : 'Note ' + marker.number + ': ' + marker.title}
				onclick={() => activate(marker)}
				onpointerenter={() => (hoverId = marker.id)}
				onpointerleave={() => (hoverId = hoverId === marker.id ? '' : hoverId)}
			>
				<Icon size={12} aria-hidden="true" />
				<span class="marker-num">{marker.number}</span>
			</button>
			{#if hoverId === marker.id}
				<div
					class="marker-tip"
					style="left:{Math.min(marker.x + 16, window.innerWidth - 240)}px; top:{marker.y + 16}px;"
				>
					<span class="marker-tip-title">
						{#if !marker.cluster}<b>#{marker.number}</b>{/if}
						{marker.title}
					</span>
					{#if marker.text}<span class="marker-tip-text">{marker.text}</span>{/if}
					{#if !marker.cluster}
						<span class="marker-tip-meta">{marker.author} · {marker.when}</span>
					{:else}
						<span class="marker-tip-meta">Click to spread them out</span>
					{/if}
				</div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.marker-lines,
	.marker-layer {
		position: fixed;
		inset: 0;
		/* an <svg> is a REPLACED element: without an explicit size it falls back to
		   its 300x150 intrinsic box and silently clips every leader line away, even
		   with inset:0 */
		width: 100%;
		height: 100%;
		pointer-events: none;
		/* above the viewport, below every panel/drawer/menu tier */
		z-index: calc(var(--z-drawer) - 2);
	}
	.marker-badge {
		position: fixed;
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		height: 26px;
		padding: 0 0.5rem 0 0.4rem;
		border-radius: 9999px;
		border: 1.5px solid var(--marker-outline, rgba(255, 255, 255, 0.9));
		background: var(--fill);
		color: var(--ink);
		font-size: 13.5px;
		font-weight: 700;
		line-height: 1;
		letter-spacing: -0.01em;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.45),
			0 4px 10px rgb(0 0 0 / 0.35);
		transform: translate(-50%, -50%);
		transition:
			transform 120ms ease,
			box-shadow 120ms ease,
			border-color 120ms ease;
		pointer-events: auto;
		cursor: pointer;
	}
	.marker-badge.is-square {
		border-radius: 8px;
	}
	.marker-badge :global(svg) {
		opacity: 0.75;
	}
	.marker-num {
		font-variant-numeric: tabular-nums;
	}
	.marker-badge:hover {
		transform: translate(-50%, -50%) scale(1.12);
		border-color: #fff;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.5),
			0 6px 16px rgb(0 0 0 / 0.45);
		z-index: 1;
	}
	.marker-badge.is-occluded {
		/* the fill fades (see --fill) but the number must stay readable */
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
		border-color: var(--marker-outline-dim, rgba(255, 255, 255, 0.55));
	}
	.marker-badge.is-active {
		box-shadow:
			0 0 0 2px var(--ring),
			0 0 0 4px rgb(0 0 0 / 0.45),
			0 4px 12px rgb(0 0 0 / 0.4);
	}
	.marker-badge.is-cluster {
		/* a small pile: two offset plates behind the badge */
		box-shadow:
			2px 2px 0 0 var(--fill),
			2px 2px 0 1.5px var(--marker-outline, rgba(255, 255, 255, 0.55)),
			4px 4px 0 0 var(--fill),
			4px 4px 0 1.5px var(--marker-outline-dim, rgba(255, 255, 255, 0.35)),
			0 4px 12px rgb(0 0 0 / 0.4);
	}
	.marker-tip {
		position: fixed;
		display: flex;
		max-width: 230px;
		flex-direction: column;
		gap: 0.15rem;
		border-radius: 0.375rem;
		border: 1px solid rgb(55 65 81 / 0.8);
		background: rgb(17 24 39 / 0.96);
		padding: 0.3rem 0.45rem;
		box-shadow: 0 6px 18px rgb(0 0 0 / 0.5);
		pointer-events: none;
	}
	.marker-tip-title {
		font-size: 11px;
		font-weight: 600;
		color: rgb(243 244 246);
	}
	.marker-tip-text {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: 10px;
		color: rgb(209 213 219);
	}
	.marker-tip-meta {
		font-size: 9px;
		color: rgb(107 114 128);
	}
	/* adaptive outline: a light hairline reads on dark scenes, a dark one on bright
	   skies / light themes */
	@media (prefers-color-scheme: light) {
		.marker-badge {
			--marker-outline: rgb(15 23 42 / 0.55);
			--marker-outline-dim: rgb(15 23 42 / 0.3);
		}
	}
	:global(:root[data-theme='light']) .marker-badge,
	:global(:root[data-theme='contrast']) .marker-badge {
		--marker-outline: rgb(15 23 42 / 0.6);
		--marker-outline-dim: rgb(15 23 42 / 0.35);
	}
</style>
