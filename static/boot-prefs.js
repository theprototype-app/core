// Applied before first paint (src/app.html loads this synchronously in <head>). A file and not an
// inline <script>: 69 T3's Content-Security-Policy allows no inline script.
// apply the saved theme before first paint (themes.js takes over after)
try {
	var savedTheme = localStorage.getItem('theme');
	if (savedTheme) {
		document.documentElement.dataset.theme = savedTheme;
		if (savedTheme === 'light') document.documentElement.classList.remove('dark');
	}
} catch (e) {}
// 53 (A5): reduced motion, before first paint ($lib/motion.js takes over after)
try {
	var motionPref = localStorage.getItem('ui:motion');
	var reduceMotion = motionPref === 'reduce' || (motionPref !== 'full' && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
	document.documentElement.dataset.motion = reduceMotion ? 'reduce' : 'full';
} catch (e) {}
// 53 (A1): the saved UI scale, before first paint ($lib/uiScale.js takes over after)
try {
	var savedScale = parseFloat(localStorage.getItem('ui:scale') || '');
	if (savedScale >= 90 && savedScale <= 150 && savedScale !== 100) document.documentElement.style.setProperty('--ui-scale', String(Math.round(savedScale / 10) / 10));
	if (savedScale >= 120 && savedScale <= 150) document.documentElement.dataset.uiLarge = '';
} catch (e) {}
// phone-polish: Touch size (Settings ▸ Interface), before first paint ($lib/touchDensity.js takes over
// after). `?density=touch|compact|auto` sets it on this device; auto = on for a coarse pointer.
try {
	var tsUrl = new URLSearchParams(location.search).get('density');
	var ts = tsUrl === 'touch' || tsUrl === 'large' ? 'touch' : tsUrl === 'compact' || tsUrl === 'standard' ? 'standard' : tsUrl === 'auto' ? 'auto' : localStorage.getItem('ui:touchSize');
	var tsCoarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
	if (ts === 'touch' || (ts !== 'standard' && tsCoarse)) document.documentElement.dataset.touchUi = '';
} catch (e) {}
