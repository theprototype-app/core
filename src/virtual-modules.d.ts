// 65 M7: vite.config.ts' tpHeroRuntime plugin — the website section runtime, bundled to a string
declare module 'virtual:tp-hero-runtime' {
	const code: string;
	export default code;
}
