// 70 W6 — where pop-out windows exist at all: desktop only. A phone shell, a coarse pointer and VR
// stay single-window (as the 1.42 Code pop-out did), and every Pop out button / menu row hides
// with this. Moved here from $lib/codePopout (which re-exports it) when pop-outs became general.
import { derived } from 'svelte/store';
import { phoneShellActive } from '../ui/phoneShell.js';
import { isVRMode } from '../../stores/sceneStore.js';

const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/** the Pop out buttons show only where a second window makes sense */
export const popOutSupported = derived([phoneShellActive, isVRMode], ([phone, vr]) => !phone && !vr && !coarse && typeof window !== 'undefined' && typeof window.open === 'function');
