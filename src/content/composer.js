(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	const fmt = CT.u.fmtTokens;
	const escapeHtml = CT.u.esc;

	function getComposer() {
		const list = [];
		for (const sel of CT.SEL.COMPOSER) list.push(...document.querySelectorAll(sel));
		let best = null;
		let bestScore = -Infinity;
		for (const el of list) {
			const r = el.getBoundingClientRect();
			if (r.width < 60 || r.height < 8) continue;
			const visible = r.bottom > 0 && r.top < window.innerHeight;
			const score = (visible ? 1e6 : 0) + r.top; // visible editor nearest bottom
			if (score > bestScore) {
				bestScore = score;
				best = el;
			}
		}
		return best;
	}

	function insertIntoComposer(text) {
		const ed = getComposer();
		if (!ed) return false;
		ed.focus();
		const sel = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(ed);
		sel.removeAllRanges();
		sel.addRange(range);
		let ok = false;
		try {
			ok = document.execCommand('insertText', false, text);
		} catch {
			ok = false;
		}
		if (!ok) {
			ed.textContent = text;
			ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
		}
		return true;
	}

	class ComposerTools {
		constructor() {
			this.settings = null;
			this.chip = null;
			this.palette = null;
			this.matches = [];
			this.activeIndex = 0;
			this.paletteOpen = false;
			this._raf = null;
		}

		init(settings) {
			this.settings = settings;
			this._build();
			this._bind();
			this.update();
		}

		setSettings(s) {
			this.settings = s;
			if (!s.showAdvisor) this._hideChip();
			if (!s.enablePalette) this._hidePalette();
			this.update();
		}

		_build() {
			const chip = document.createElement('div');
			chip.className = 'ct-chip';
			chip.setAttribute('role', 'status');
			CT.a11y.decorate(chip);
			chip.innerHTML = `
				<span class="ct-chip__meter"></span>
				<span class="ct-chip__sep" aria-hidden="true">·</span>
				<span class="ct-chip__model" title=""></span>
				<button class="ct-chip__apply" aria-label="Apply suggested model">Apply</button>`;
			chip.querySelector('.ct-chip__apply').addEventListener('click', async () => {
				const sug = this._currentSuggestion;
				if (!sug) return;
				const ok = await CT.model.applyModel(sug.model);
				CT.model.toast(ok ? `Switched to ${sug.model}` : `Couldn't switch automatically — pick ${sug.model} manually`);
			});
			document.body.appendChild(chip);
			this.chip = chip;

			const pal = document.createElement('div');
			pal.className = 'ct-palette';
			pal.setAttribute('role', 'listbox');
			pal.setAttribute('aria-label', 'Prompt palette');
			CT.a11y.decorate(pal);
			pal.innerHTML = `<div class="ct-palette__head">Prompts — type to filter, ↑↓ to move, ↵ to insert, Esc to close</div><div class="ct-palette__list"></div>`;
			document.body.appendChild(pal);
			this.palette = pal;
			this.paletteList = pal.querySelector('.ct-palette__list');
		}

		_bind() {
			document.addEventListener(
				'input',
				(e) => {
					const ed = getComposer();
					if (ed && (e.target === ed || ed.contains(e.target))) this._onInput();
				},
				true
			);
			document.addEventListener('keydown', (e) => this._onKeydown(e), true);
			const loop = () => {
				if (this.chip?.classList.contains('ct-chip--show') || this.paletteOpen) this._position();
				this._raf = requestAnimationFrame(loop);
			};
			this._raf = requestAnimationFrame(loop);
			document.addEventListener(
				'focusout',
				() => setTimeout(() => {
					if (document.activeElement !== getComposer() && !CT.popover.isOpen()) this._hidePalette();
				}, 120),
				true
			);
		}

		_onInput() {
			this.update();
			this._maybeShowPalette();
		}

		update() {
			if (!this.settings?.showAdvisor) return this._hideChip();
			const ed = getComposer();
			const text = ed ? ed.textContent || '' : '';
			if (!ed || !text.trim() || this.paletteOpen) {
				if (!text.trim()) this._lastAutoApplied = null;
				return this._hideChip();
			}

			const tokens = CT.tokenizer.countTokens(text);
			const words = (text.match(/\S+/g) || []).length;
			const ctxPct = CT.state.map?.count ? Math.min(100, (CT.state.map.total / CT.CONST.CONTEXT_LIMIT_TOKENS) * 100) : 0;
			const sug = CT.model.suggestModel({ text, contextPct: ctxPct, hasAttachment: detectAttachment() });
			this._currentSuggestion = sug;
			if (sug) CT.state.suggestion = sug; // shared with the panel's Overview advisor

			if (this.settings.autoApplyModel && sug && sug.model !== this._lastAutoApplied) {
				clearTimeout(this._autoT);
				this._autoT = setTimeout(async () => {
					const ok = await CT.model.applyModel(sug.model);
					if (ok) {
						this._lastAutoApplied = sug.model;
						CT.model.toast(`Auto-switched to ${sug.model}`);
					}
				}, 1800);
			}

			this.chip.querySelector('.ct-chip__meter').textContent = `≈${fmt(tokens)} tok · ${words} words`;
			const modelEl = this.chip.querySelector('.ct-chip__model');
			modelEl.textContent = sug ? `${sug.model}` : '';
			modelEl.title = sug ? sug.reason : '';
			this.chip.querySelector('.ct-chip__apply').style.display = sug ? '' : 'none';
			this.chip.querySelector('.ct-chip__sep').style.display = sug ? '' : 'none';

			this.chip.classList.add('ct-chip--show');
			this._position();
		}

		_maybeShowPalette() {
			if (!this.settings?.enablePalette) return this._hidePalette();
			const ed = getComposer();
			if (!ed) return this._hidePalette();
			const text = ed.textContent || '';
			const m = text.match(/^\s*\/(\S*)$/);
			if (!m) return this._hidePalette();
			const q = m[1].toLowerCase();
			const prompts = this.settings.prompts || [];
			// Search across name, keyword, body, and category.
			this.matches = prompts.filter((p) => {
				if (!q) return true;
				const hay = `${p.name || ''} ${p.keyword || ''} ${p.body || ''} ${p.category || ''}`.toLowerCase();
				return (p.keyword || '').toLowerCase().startsWith(q) || hay.includes(q);
			});
			if (!this.matches.length) return this._hidePalette();
			this.activeIndex = 0;
			this._renderPalette();
			this.paletteOpen = true;
			this.palette.classList.add('ct-palette--show');
			this._hideChip();
			this._position();
		}

		_renderPalette() {
			const frag = document.createDocumentFragment();
			this.matches.forEach((p, i) => {
				const row = document.createElement('div');
				row.className = `ct-palette__row${i === this.activeIndex ? ' ct-palette__row--active' : ''}`;
				row.setAttribute('role', 'option');
				row.setAttribute('aria-selected', i === this.activeIndex ? 'true' : 'false');
				row.innerHTML = `<span class="ct-palette__name">${escapeHtml(p.name)}</span><span class="ct-palette__kw">/${escapeHtml(p.keyword || '')}</span>${p.category ? `<span class="ct-palette__cat">${escapeHtml(p.category)}</span>` : ''}<div class="ct-palette__preview">${escapeHtml((p.body || '').replace(/\s+/g, ' ').slice(0, 70))}</div>`;
				row.addEventListener('mousedown', (ev) => {
					ev.preventDefault();
					this._insert(p);
				});
				frag.appendChild(row);
			});
			this.paletteList.replaceChildren(frag);
		}

		async _insert(prompt) {
			this._hidePalette();
			const body = prompt.body || '';
			if (/\{\{[^{}]+\}\}/.test(body) && CT.popover) {
				const filled = await CT.popover.fillPlaceholders(body, prompt.choices || {});
				if (filled == null) return; // cancelled
				insertIntoComposer(filled);
			} else {
				insertIntoComposer(body);
			}
		}

		_onKeydown(e) {
			if (!this.paletteOpen) return;
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				this.activeIndex = (this.activeIndex + 1) % this.matches.length;
				this._renderPalette();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				this.activeIndex = (this.activeIndex - 1 + this.matches.length) % this.matches.length;
				this._renderPalette();
			} else if (e.key === 'Enter') {
				e.preventDefault();
				this._insert(this.matches[this.activeIndex]);
			} else if (e.key === 'Escape') {
				this._hidePalette();
			}
		}

		_position() {
			const ed = getComposer();
			if (!ed) return;
			const r = ed.getBoundingClientRect();
			if (this.chip?.classList.contains('ct-chip--show')) {
				this.chip.style.right = `${Math.max(8, window.innerWidth - r.right + 8)}px`;
				this.chip.style.top = `${Math.max(8, r.top - 40)}px`;
			}
			if (this.paletteOpen) {
				this.palette.style.left = `${r.left}px`;
				this.palette.style.width = `${Math.min(440, Math.max(260, r.width))}px`;
				this.palette.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
			}
		}

		_hideChip() {
			this.chip?.classList.remove('ct-chip--show');
		}
		_hidePalette() {
			this.paletteOpen = false;
			this.palette?.classList.remove('ct-palette--show');
		}
	}

	// Best-effort: is there a file/attachment chip near the composer? Used only
	// as a model-suggestion signal, so a miss simply means "no attachment".
	function detectAttachment() {
		for (const sel of CT.SEL.ATTACHMENT) {
			try {
				if (document.querySelector(sel)) return true;
			} catch {
				/* ignore bad selector */
			}
		}
		return false;
	}

	CT.composer = new ComposerTools();
	CT.getComposer = getComposer;
	CT.insertIntoComposer = insertIntoComposer;
	CT.detectAttachment = detectAttachment;
})();
