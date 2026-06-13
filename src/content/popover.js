(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	// Exactly one popover is active at a time. Opening another closes the first.
	// Close is synchronous (DOM removed immediately) — no animation gate, so the
	// × button and Escape both close instantly and reopening is consistent.
	let active = null; // { el, kind, close, triggerEl }

	function clamp(v, lo, hi) {
		return Math.max(lo, Math.min(hi, v));
	}
	function isOpen(kind) {
		return !!active && (kind === undefined || active.kind === kind);
	}
	function closeActive(result) {
		if (active) active.close(result);
	}

	function show(opts = {}) {
		closeActive(); // enforce single active

		const prevFocus = document.activeElement;
		const id = opts.id || CT.u.makeId('pop');
		let backdrop = null;
		if (opts.modal) {
			backdrop = document.createElement('div');
			backdrop.className = 'ct-backdrop';
			CT.a11y.decorate(backdrop);
			backdrop.addEventListener('mousedown', (e) => {
				if (e.target === backdrop) close(null);
			});
			document.body.appendChild(backdrop);
		}

		const pop = document.createElement('div');
		pop.className = 'ct-popover';
		pop.id = id;
		pop.setAttribute('role', opts.role || 'dialog');
		pop.setAttribute('aria-modal', opts.modal ? 'true' : 'false');
		if (opts.title) pop.setAttribute('aria-label', opts.title);
		CT.a11y.decorate(pop);
		if (opts.width) pop.style.maxWidth = `${opts.width}px`;

		const head = document.createElement('div');
		head.className = 'ct-popover__head';
		head.innerHTML = `<span class="ct-popover__title">${CT.u.esc(opts.title || '')}</span>`;
		const x = document.createElement('button');
		x.className = 'ct-iconbtn';
		x.type = 'button';
		x.setAttribute('aria-label', 'Close');
		x.innerHTML = CT.icon('x', 16);
		x.addEventListener('mousedown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			close(null);
		});
		head.appendChild(x);
		pop.appendChild(head);

		const body = document.createElement('div');
		body.className = 'ct-popover__body';
		pop.appendChild(body);
		document.body.appendChild(pop);

		const place = () => {
			const r = pop.getBoundingClientRect();
			const margin = 8;
			if (opts.anchorRect) {
				const a = opts.anchorRect;
				const left = clamp(a.left + a.width / 2 - r.width / 2, margin, window.innerWidth - r.width - margin);
				let top = a.top - r.height - 8; // prefer above the anchor (the strip)
				if (top < margin) top = clamp(a.bottom + 8, margin, window.innerHeight - r.height - margin);
				pop.style.left = `${left}px`;
				pop.style.top = `${top}px`;
			} else {
				pop.style.left = `${clamp((window.innerWidth - r.width) / 2, margin, window.innerWidth - margin)}px`;
				pop.style.top = `${clamp((window.innerHeight - r.height) / 2.4, margin, window.innerHeight - r.height - margin)}px`;
			}
		};

		const releaseTrap = opts.modal ? CT.a11y.trapFocus(pop) : () => {};
		const triggerEl = opts.triggerEl || null;
		triggerEl?.setAttribute('aria-expanded', 'true');
		triggerEl?.setAttribute('aria-controls', id);

		let closed = false;
		function close(result) {
			if (closed) return;
			closed = true;
			releaseTrap();
			if (active && active.el === pop) active = null;
			pop.remove();
			backdrop?.remove();
			triggerEl?.setAttribute('aria-expanded', 'false');
			if (typeof opts.onClose === 'function') opts.onClose(result);
			if (prevFocus && document.contains(prevFocus)) {
				try {
					prevFocus.focus({ preventScroll: true });
				} catch {
					prevFocus.focus();
				}
			}
		}

		active = { el: pop, kind: opts.kind || null, close, triggerEl };
		if (typeof opts.build === 'function') opts.build(body, { close, place });
		place();
		const first = CT.a11y.focusables(body)[0] || x;
		first.focus({ preventScroll: true });
		return close;
	}

	function toggle(kind, factory) {
		if (isOpen(kind)) {
			closeActive(null);
			return null;
		}
		return factory();
	}

	document.addEventListener(
		'mousedown',
		(e) => {
			if (!active) return;
			if (active.el.contains(e.target)) return;
			if (active.triggerEl && active.triggerEl.contains(e.target)) return;
			closeActive(null);
		},
		true
	);
	document.addEventListener(
		'keydown',
		(e) => {
			if (e.key !== 'Escape' || !active) return;
			e.preventDefault();
			e.stopPropagation();
			closeActive(null);
		},
		true
	);

	// ---- Placeholder filling --------------------------------------------------
	function parsePlaceholders(template) {
		const names = [];
		const re = /\{\{([^{}]+?)\}\}/g;
		let m;
		while ((m = re.exec(template || ''))) {
			const name = m[1].trim();
			if (name && !names.includes(name)) names.push(name);
		}
		return names;
	}
	function applyValues(template, values) {
		return (template || '').replace(/\{\{([^{}]+?)\}\}/g, (_, raw) => {
			const k = raw.trim();
			return values[k] !== undefined && values[k] !== '' ? values[k] : `{{${k}}}`;
		});
	}
	function fillPlaceholders(template, choices = {}) {
		const names = parsePlaceholders(template);
		if (!names.length) return Promise.resolve(template);
		return new Promise((resolve) => {
			show({
				title: 'Fill in the blanks',
				kind: 'fill',
				modal: true,
				width: 360,
				onClose: (r) => resolve(r ?? null),
				build: (body, api) => {
					const form = document.createElement('div');
					form.className = 'ct-fillform';
					const fields = {};
					for (const name of names) {
						const row = document.createElement('label');
						row.className = 'ct-fillform__row';
						const cap = document.createElement('span');
						cap.className = 'ct-fillform__label';
						cap.textContent = name;
						row.appendChild(cap);
						let input;
						if (Array.isArray(choices[name]) && choices[name].length) {
							input = document.createElement('select');
							input.className = 'ct-input';
							for (const opt of choices[name]) {
								const o = document.createElement('option');
								o.value = o.textContent = opt;
								input.appendChild(o);
							}
						} else if (/text|code|data|notes|content/i.test(name)) {
							input = document.createElement('textarea');
							input.className = 'ct-textarea';
							input.rows = 3;
						} else {
							input = document.createElement('input');
							input.className = 'ct-input';
							input.type = 'text';
						}
						input.setAttribute('aria-label', name);
						fields[name] = input;
						row.appendChild(input);
						form.appendChild(row);
					}
					const btns = document.createElement('div');
					btns.className = 'ct-form__btns';
					const ok = document.createElement('button');
					ok.className = 'ct-btn ct-btn--primary';
					ok.type = 'button';
					ok.textContent = 'Insert';
					const cancel = document.createElement('button');
					cancel.className = 'ct-btn';
					cancel.type = 'button';
					cancel.textContent = 'Cancel';
					btns.append(ok, cancel);
					form.appendChild(btns);
					body.appendChild(form);

					const submit = () => {
						const values = {};
						for (const [k, el] of Object.entries(fields)) values[k] = el.value;
						api.close(applyValues(template, values));
					};
					ok.addEventListener('click', submit);
					cancel.addEventListener('click', () => api.close(null));
					form.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
							e.preventDefault();
							submit();
						}
					});
					api.place();
				}
			});
		});
	}

	CT.popover = { show, toggle, closeActive, isOpen, fillPlaceholders, parsePlaceholders, applyValues };
})();
