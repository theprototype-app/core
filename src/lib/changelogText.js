// 102-boot-diet-2 (card lazy-whats-new): the bundled CHANGELOG.md, on its own so it is a LAZY chunk (~100 KB gz of
// text the editor booted with). whatsNew.loadChangelog() imports it when the What's new window, Settings ▸ About ▸
// What's new or the update toast opens; the boot keeps only the version string (version.js).
import changelogRaw from '../../CHANGELOG.md?raw';

export default String(changelogRaw || '');
