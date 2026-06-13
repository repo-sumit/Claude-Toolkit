(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});
	const { fmtClock, fmtCountdown, esc } = CT.u;

	const METRIC_HELP = {
		ctx: 'How full this conversation\u2019s 200k context window is.',
		cache: 'Claude caches the conversation ~5 min after each reply — sending within the window is faster.',
		five: 'Rolling 5-hour session usage (from claude.ai\u2019s usage API).',
		seven: 'Rolling 7-day usage (from claude.ai\u2019s usage API).'
	};

	// A slim status strip docked into Claude's own DOM, right after the composer
	// card (`chat-input-grid-container`). Because it lives in the normal flow
	// below the input — not as a fixed overlay — it can never cover the model
	// selector, effort selector, attachment, mic, or send button, and it inherits
	// Claude's width + typography so it reads as part of the input card.
	class BottomBar {
		constructor({ onOpenPanel } = {}) {
			this.onOpenPanel = onOpenPanel || (() => {});
			this.settings = CT.DEFAULTS;
			this.visible = false;
			this.mode = 'wide';
			this._raf = null;
			this._suggestion = null;
			this._built = false;
		}

		mount(settings) {
			if (this._built) return;
			this._built = true;
			this.settings = settings;

			const bar = document.createElement('div');
			bar.className = 'ct-strip ct-root';
			bar.setAttribute('role', 'group');
			bar.setAttribute('aria-label', 'Claude usage');
			CT.a11y.decorate(bar);
			bar.innerHTML = `
				<button class="ct-strip__usage" data-act="usage" aria-haspopup="dialog" aria-expanded="false" aria-label="Usage details">
					<span class="ct-seg" data-seg="five"><span class="ct-seg__txt"></span><span class="ct-rail"><i></i></span></span>
					<span class="ct-seg__div" aria-hidden="true"></span>
					<span class="ct-seg" data-seg="seven"><span class="ct-seg__txt"></span><span class="ct-rail"><i></i></span></span>
					<span class="ct-seg__div" data-div="ctx" aria-hidden="true"></span>
					<span class="ct-seg ct-seg--text" data-seg="ctx"><span class="ct-seg__txt"></span></span>
					<span class="ct-seg__div" data-div="cache" aria-hidden="true"></span>
					<span class="ct-seg ct-seg--text" data-seg="cache" hidden><span class="ct-seg__txt"></span></span>
					<span class="ct-seg__div" data-div="model" aria-hidden="true"></span>
					<span class="ct-seg ct-seg--text ct-seg--model" data-seg="model" hidden><span class="ct-seg__txt"></span></span>
				</button>
				<button class="ct-strip__icon" data-act="tools" aria-haspopup="dialog" aria-expanded="false" aria-label="Quick Tools" title="Quick Tools (Ctrl/Cmd+Shift+K)">${CT.icon('sparkles')}</button>
				<button class="ct-strip__icon" data-act="panel" aria-label="Open Claude Toolkit panel" title="Open panel">${CT.icon('panel')}</button>`;
			this.bar = bar; // detached until attach()
			this.usageBtn = bar.querySelector('[data-act="usage"]');
			this.toolsBtn = bar.querySelector('[data-act="tools"]');

			this.usageBtn.addEventListener('click', () => this.toggleUsagePopover());
			this.toolsBtn.addEventListener('click', () => {
				CT.popover.toggle('tools', () => CT.tools.openLauncher(this.toolsBtn.getBoundingClientRect(), this.toolsBtn));
			});
			bar.querySelector('[data-act="panel"]').addEventListener('click', () => this.onOpenPanel());

			document.addEventListener(
				'input',
				(e) => {
					const ed = CT.getComposer();
					if (ed && (e.target === ed || ed.contains(e.target))) this._updateModel();
				},
				true
			);

			// Responsive mode follows the strip's own width.
			this.ro = new ResizeObserver(() => this._applyMode(this.bar.clientWidth));
			try {
				this.ro.observe(this.bar);
			} catch {
				/* ignore */
			}
			window.addEventListener('resize', () => this.schedule());
			// React re-renders can detach the strip — reconcile cheaply on a timer.
			this._watch = setInterval(() => this.attach(), 350);

			this.attach();
			this.render();
		}

		setSettings(s) {
			this.settings = s;
			this.attach();
			this.render();
		}

		// ---- native docking ----
		_resolveAnchor() {
			for (const sel of CT.SEL.COMPOSER_GRID) {
				const el = document.querySelector(sel);
				if (el) return el;
			}
			for (const sel of CT.SEL.MODEL_TRIGGER) {
				const ms = document.querySelector(sel);
				if (ms) {
					for (const g of CT.SEL.COMPOSER_GRID) {
						const c = ms.closest(g);
						if (c) return c;
					}
					return ms.parentElement;
				}
			}
			const ed = CT.getComposer && CT.getComposer();
			if (ed) {
				for (const g of CT.SEL.COMPOSER_GRID) {
					const c = ed.closest(g);
					if (c) return c;
				}
				return ed.parentElement?.parentElement || ed.parentElement;
			}
			return null;
		}

		attach() {
			if (!this.settings?.showBottomBar) return this._detach();
			const anchor = this._resolveAnchor();
			if (!anchor || !anchor.parentElement) return this._detach();
			if (anchor.nextElementSibling !== this.bar) anchor.after(this.bar);
			if (!this.visible) {
				this.visible = true;
				this.bar.classList.add('ct-strip--show');
			}
			this._applyMode(this.bar.clientWidth || anchor.clientWidth || 700);
		}
		_detach() {
			if (this.bar && this.bar.parentElement) this.bar.remove();
			this.visible = false;
		}
		schedule() {
			if (this._raf) return;
			this._raf = requestAnimationFrame(() => {
				this._raf = null;
				this.attach();
			});
		}

		_applyMode(width) {
			width = width || 700;
			let mode = 'wide';
			if (this.settings.bottomBarCompact) mode = width >= 520 ? 'narrow' : 'tiny';
			else if (width >= 720) mode = 'wide';
			else if (width >= 520) mode = 'mid';
			else if (width >= 380) mode = 'narrow';
			else mode = 'tiny';
			if (this.bar.dataset.mode !== mode) {
				this.bar.dataset.mode = mode;
				this.mode = mode;
				this.render();
			} else {
				this.mode = mode;
			}
		}

		// ---- model suggestion ----
		_updateModel() {
			const ed = CT.getComposer();
			const text = ed ? (ed.textContent || '').trim() : '';
			const ctxPct = CT.state.map?.count ? Math.min(100, (CT.state.map.total / CT.CONST.CONTEXT_LIMIT_TOKENS) * 100) : 0;
			this._suggestion = text ? CT.model.suggestModel({ text, contextPct: ctxPct, hasAttachment: CT.detectAttachment?.() }) : null;
			this._renderModel();
		}
		_renderModel() {
			const seg = this.bar.querySelector('[data-seg="model"]');
			const div = this.bar.querySelector('[data-div="model"]');
			const show = this.settings.showModelSuggestion !== false && this._suggestion && this.mode !== 'tiny';
			seg.hidden = !show;
			if (div) div.hidden = !show;
			if (!show) return;
			seg.querySelector('.ct-seg__txt').textContent = this.mode === 'wide' ? `Suggested: ${this._suggestion.model}` : this._suggestion.model;
			seg.title = `Suggested model: ${this._suggestion.model} — ${this._suggestion.reason}`;
		}

		// ---- value rendering ----
		render() {
			if (!this._built) return;
			const map = CT.state.map;
			const usage = CT.state.usage;
			const wide = this.mode === 'wide';
			const mid = this.mode === 'mid';

			const setUsageSeg = (seg, w, longLabel, shortLabel, name) => {
				const el = this.bar.querySelector(`[data-seg="${seg}"]`);
				const txt = el.querySelector('.ct-seg__txt');
				const rail = el.querySelector('.ct-rail i');
				const pct = w?.utilization;
				const lvl = pct == null ? null : CT.usage.level(pct);
				el.classList.remove('ct-lvl-healthy', 'ct-lvl-moderate', 'ct-lvl-high', 'ct-lvl-critical');
				if (lvl) el.classList.add(`ct-lvl-${lvl.key}`);
				if (rail) {
					rail.style.width = `${pct || 0}%`;
					rail.className = '';
					rail.classList.add(`ct-lvlbg-${lvl ? lvl.key : 'healthy'}`);
				}
				if (pct == null) {
					txt.textContent = `${wide || mid ? longLabel : shortLabel} —`;
				} else if (wide && w.resets_at) {
					txt.textContent = `${longLabel} ${pct.toFixed(pct < 10 ? 1 : 0)}% · resets in ${fmtCountdown(Date.parse(w.resets_at))}`;
				} else {
					txt.textContent = `${wide || mid ? longLabel : shortLabel} ${pct.toFixed(pct < 10 ? 1 : 0)}%`;
				}
				const resets = w?.resets_at ? `, resets in ${fmtCountdown(Date.parse(w.resets_at))}` : '';
				el.setAttribute('aria-label', `${name} ${pct == null ? 'unknown' : Math.round(pct) + ' percent'}${lvl ? ', ' + lvl.label : ''}${resets}`);
			};
			setUsageSeg('five', usage?.five_hour, 'Session', '5h', 'Session usage');
			setUsageSeg('seven', usage?.seven_day, 'Weekly', '7d', 'Weekly usage');

			const ctxSeg = this.bar.querySelector('[data-seg="ctx"]');
			const ctxTxt = ctxSeg.querySelector('.ct-seg__txt');
			const ctxDiv = this.bar.querySelector('[data-div="ctx"]');
			// Context drops out first on narrow/tiny widths.
			const showCtx = (wide || mid) && map?.count;
			ctxSeg.hidden = !showCtx;
			if (ctxDiv) ctxDiv.hidden = !showCtx;
			if (showCtx) {
				const ctxPct = Math.min(100, (map.total / CT.CONST.CONTEXT_LIMIT_TOKENS) * 100);
				const lvl = CT.usage.level(ctxPct);
				ctxSeg.classList.remove('ct-lvl-healthy', 'ct-lvl-moderate', 'ct-lvl-high', 'ct-lvl-critical');
				ctxSeg.classList.add(`ct-lvl-${lvl.key}`);
				ctxTxt.textContent = `Ctx ${ctxPct.toFixed(ctxPct < 10 ? 1 : 0)}%`;
				ctxSeg.setAttribute('aria-label', `Context window ${Math.round(ctxPct)} percent, ${lvl.label}`);
			}

			this._renderCache();
			this._renderModel();
		}

		_renderCache() {
			const seg = this.bar.querySelector('[data-seg="cache"]');
			const div = this.bar.querySelector('[data-div="cache"]');
			const cu = CT.state.map?.cachedUntil;
			const isCacheActive = cu && Date.now() < cu; // strip shows cache only while active
			const show = isCacheActive && this.settings.showCacheCountdown !== false && (this.mode === 'wide' || this.mode === 'mid');
			seg.hidden = !show;
			if (div) div.hidden = !show;
			if (show) {
				seg.querySelector('.ct-seg__txt').textContent = `Cache ${fmtClock(cu)}`;
				seg.setAttribute('aria-label', `Prompt cache active, ${fmtClock(cu)} remaining`);
			}
		}

		tick() {
			if (this.visible) this._renderCache();
		}

		// ---- usage details popover ----
		toggleUsagePopover() {
			CT.popover.toggle('usage', () => this._openUsagePopover());
		}
		_openUsagePopover() {
			const anchorRect = this.bar.getBoundingClientRect();
			const map = CT.state.map;
			const usage = CT.state.usage;
			return CT.popover.show({
				title: 'Usage',
				kind: 'usage',
				width: 300,
				anchorRect,
				triggerEl: this.usageBtn,
				build: (body, api) => {
					const row = (name, pct, sub, help) => {
						const lvl = pct == null ? null : CT.usage.level(pct);
						return `<div class="ct-urow">
							<div class="ct-urow__top"><span class="ct-urow__name">${esc(name)}</span>
							<span class="ct-urow__val">${pct == null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}${lvl ? ` <span class="ct-tag ct-lvl-${lvl.key}">${lvl.label}</span>` : ''}</span></div>
							<div class="ct-bar-track"><div class="ct-bar-fill ct-lvlbg-${lvl ? lvl.key : 'healthy'}" style="width:${pct || 0}%"></div></div>
							${sub ? `<div class="ct-hint">${esc(sub)}</div>` : ''}
							<div class="ct-hint ct-hint--help">${esc(help)}</div>
						</div>`;
					};
					const ctxPct = map?.count ? Math.min(100, (map.total / CT.CONST.CONTEXT_LIMIT_TOKENS) * 100) : null;
					const cu = map?.cachedUntil;
					const cacheActive = cu && Date.now() < cu;
					const f = usage?.five_hour, s7 = usage?.seven_day;
					body.innerHTML =
						row('Session (5h)', f?.utilization ?? null, f?.resets_at ? `Resets in ${fmtCountdown(Date.parse(f.resets_at))}` : '', METRIC_HELP.five) +
						row('Weekly (7d)', s7?.utilization ?? null, s7?.resets_at ? `Resets in ${fmtCountdown(Date.parse(s7.resets_at))}` : '', METRIC_HELP.seven) +
						row('Context window', ctxPct, map?.count ? `${CT.tokenizer.isApproximate() ? '~' : ''}${CT.u.fmtTokens(map.total)} / ${CT.u.fmtTokens(CT.CONST.CONTEXT_LIMIT_TOKENS)} tokens · ${map.count} messages` : 'Open a conversation', METRIC_HELP.ctx) +
						`<div class="ct-urow"><div class="ct-urow__top"><span class="ct-urow__name">Prompt cache</span><span class="ct-urow__val ct-urow__val--muted">${cacheActive ? fmtClock(cu) + ' left' : 'expired'}</span></div><div class="ct-hint ct-hint--help">${esc(METRIC_HELP.cache)}</div></div>` +
						(this._suggestion ? `<div class="ct-urow"><div class="ct-urow__top"><span class="ct-urow__name">Suggested model</span><span class="ct-urow__val">${esc(this._suggestion.model)}</span></div><div class="ct-hint ct-hint--help">${esc(this._suggestion.reason)}</div></div>` : '');
					api.place();
				}
			});
		}
	}

	CT.BottomBar = BottomBar;
})();
