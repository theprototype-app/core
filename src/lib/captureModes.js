// 78 F5: the five viewport-capturing tools, bridged onto the capture stack (captureStack.js).
// Each tool keeps its own store and its own exits; this module only WATCHES those stores and
// pushes / pops the stack entry, so arming order = stack order and the newest tool owns the
// clicks and the next Esc. Started once from App (`startCaptureModes`).

import { get } from 'svelte/store';
import { pushCapture, popCapture, updateCapture, installCaptureKeys } from './captureStack';
import { pathCaptureNode, endPathCapture } from './pathCapture';
import { measureMode, measureEditing, measureEscape, stopMeasure } from './measure';
import { drawMode, drawTool, toggleDrawMode } from './drawMode';
import { flattenPicking, cancelFlattenPick } from './flattenActions';
import { scopeOfEvent, viewportHasKeys } from './keyScope';
import { showToast } from '../stores/appStore';

/** Esc in a field or a code editor is that field's (the path capture's old rule) @param {KeyboardEvent} event */
const notTyping = (event) => {
	const scope = scopeOfEvent(event);
	return scope !== 'text' && scope !== 'code';
};

const drawLabel = () => (get(drawTool) === 'spline' ? 'Placing a spline' : 'Drawing');
const drawHint = () =>
	get(drawTool) === 'spline' ? 'Click to place points · Enter finishes' : 'Drag on a surface to draw';

let started = false;
/** @returns {() => void} stop */
export function startCaptureModes() {
	if (started) return () => {};
	started = true;
	const stopKeys = installCaptureKeys();
	const subs = [
		pathCaptureNode.subscribe((id) => {
			if (id)
				pushCapture({
					id: 'path',
					label: 'Placing waypoints',
					hint: 'Click the scene to add a point',
					icon: 'waypoints',
					escape: () => endPathCapture(),
					keyOk: notTyping
				});
			else popCapture('path');
		}),
		measureMode.subscribe((on) => {
			if (on)
				pushCapture({
					id: 'measure',
					label: get(measureEditing) ? 'Editing a measurement' : 'Measuring',
					hint: 'Click points · Enter keeps',
					icon: 'ruler',
					escape: () => measureEscape(),
					done: () => stopMeasure(),
					keyOk: viewportHasKeys
				});
			else popCapture('measure');
		}),
		measureEditing.subscribe((editing) => updateCapture('measure', { label: editing ? 'Editing a measurement' : 'Measuring' })),
		drawMode.subscribe((on) => {
			if (on)
				pushCapture({
					id: 'draw',
					label: drawLabel(),
					hint: drawHint(),
					icon: 'pencil',
					escape: () => {
						if (get(drawMode)) toggleDrawMode();
					},
					keyOk: viewportHasKeys
				});
			else popCapture('draw');
		}),
		drawTool.subscribe(() => updateCapture('draw', { label: drawLabel(), hint: drawHint() })),
		flattenPicking.subscribe((pick) => {
			if (pick)
				pushCapture({
					id: 'flatten',
					label: pick.kind === 'carve' ? 'Pick the terrain to flatten' : 'Pick the surface to drape onto',
					hint: 'Click it in the scene',
					icon: 'mountain',
					escape: () => {
						if (cancelFlattenPick()) showToast('Flatten cancelled');
					}
				});
			else popCapture('flatten');
		})
	];
	return () => {
		started = false;
		subs.forEach((stop) => stop());
		stopKeys();
	};
}
