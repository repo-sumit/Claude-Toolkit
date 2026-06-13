(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});
	CT.settingsRef = CT.settingsRef || null; // set by main.js

	const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

	function focusables(container) {
		return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && !el.disabled;
		});
	}

	// Keep Tab focus inside `container`. Returns a dispose function.
	function trapFocus(container) {
		const onKey = (e) => {
			if (e.key !== 'Tab') return;
			const items = focusables(container);
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		};
		container.addEventListener('keydown', onKey);
		return () => container.removeEventListener('keydown', onKey);
	}

	function systemReducedMotion() {
		try {
			return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch {
			return false;
		}
	}

	// Apply theme + a11y classes to one .ct-root element.
	function decorate(el) {
		if (!el) return el;
		el.classList.add('ct-root');
		el.classList.toggle('ct-dark', !!CT.theme?.dark);
		const s = CT.settingsRef || {};
		el.classList.toggle('ct-rm', !!s.reducedMotion || systemReducedMotion());
		el.classList.toggle('ct-hc', !!s.highContrast);
		return el;
	}

	// Re-apply to every existing root (after settings/theme change).
	function applyAll() {
		document.querySelectorAll('.ct-root').forEach(decorate);
	}

	// Polite screen-reader announcements (used by toasts/warnings).
	let liveEl = null;
	function announce(msg) {
		if (!liveEl) {
			liveEl = document.createElement('div');
			liveEl.className = 'ct-sr-only';
			liveEl.setAttribute('aria-live', 'polite');
			liveEl.setAttribute('role', 'status');
			document.body.appendChild(liveEl);
		}
		liveEl.textContent = '';
		setTimeout(() => (liveEl.textContent = msg), 30);
	}

	CT.a11y = { trapFocus, focusables, decorate, applyAll, announce, systemReducedMotion };
})();
