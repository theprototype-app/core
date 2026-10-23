// 65 M7: vite.config.ts' tpHeroRuntime plugin — the website section runtime, bundled to a string
declare module 'virtual:tp-hero-runtime' {
	const code: string;
	export default code;
}

// 65 M4: gifenc 1.0.3 ships no types — the three calls exportSinks.js makes
declare module 'gifenc' {
	export function GIFEncoder(): {
		writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: number[][]; delay?: number; repeat?: number; transparent?: boolean }): void;
		finish(): void;
		bytes(): Uint8Array;
	};
	export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: string }): number[][];
	export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}
