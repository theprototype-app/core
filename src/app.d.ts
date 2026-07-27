// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// Baked by vite `define` (see vite.config.ts). Read via src/lib/version.js.
	const __APP_VERSION__: string;
	const __COMMIT_SHA__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
