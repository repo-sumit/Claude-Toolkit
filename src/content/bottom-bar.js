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

	// Shown on the model pill before the user has typed a draft (the design keeps
	// a suggestion visible at all times). Real, tailored advice replaces it the
	// moment there's composer text.
	const NEUTRAL_SUGGESTION = Object.freeze({
		tier: 'sonnet',
		finalTier: 'sonnet',
		baseTier: 'sonnet',
		model: 'Sonnet',
		displayName: 'Sonnet',
		emoji: '\u{1F7E1}',
		confidence: 0.5,         // legacy numeric field
		confidenceScore: 0.5,
		confidenceLabel: 'low',
		reason: 'Balanced default \u2014 start typing for a tailored suggestion.',
		cost: 'medium',
		speed: 'medium',
		category: 'unknown',
		escalators: [],
		signals: [],
		alternative: { model: null, condition: '' },
		explanation: 'Sonnet is a balanced default. Type a draft or attach a file for a tailored recommendation.',
		detectedAvailableModelName: null
	});

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
			// label · rail · value per metric, then a clickable model-suggestion
			// pill, a divider, and the Tools + panel icons. Model lives OUTSIDE the
			// usage button so it can be applied with one click.
			bar.innerHTML = `
				<button class="ct-strip__usage" data-act="usage" aria-haspopup="dialog" aria-expanded="false" aria-label="Usage details">
					<span class="ct-seg" data-seg="five"><span class="ct-seg__lab"></span><span class="ct-rail"><i></i></span><span class="ct-seg__txt"></span></span>
					<span class="ct-seg__div" data-div="seven" aria-hidden="true"></span>
					<span class="ct-seg" data-seg="seven"><span class="ct-seg__lab"></span><span class="ct-rail"><i></i></span><span class="ct-seg__txt"></span></span>
					<span class="ct-seg__div" data-div="ctx" aria-hidden="true"></span>
					<span class="ct-seg" data-seg="ctx"><span class="ct-seg__lab"></span><span class="ct-seg__txt"></span></span>
					<span class="ct-seg__div" data-div="cache" aria-hidden="true"></span>
					<span class="ct-seg" data-seg="cache" hidden><span class="ct-seg__lab"></span><span class="ct-seg__txt"></span></span>
					<span class="ct-strip__spacer"></span>
				</button>
				<button class="ct-strip__model" data-act="apply-model" hidden aria-label="Apply suggested model" title="">${CT.icon('star', 13)}<span class="ct-strip__model-lbl"></span></button>
				<span class="ct-seg__div" aria-hidden="true"></span>
				<button class="ct-strip__icon" data-act="tools" aria-haspopup="dialog" aria-expanded="false" aria-label="Quick Tools" title="Quick Tools (Ctrl/Cmd+Shift+K)">${CT.icon('sparkles')}</button>
				<button class="ct-strip__icon" data-act="panel" aria-label="Open Claude Toolkit panel" title="Open panel">${CT.icon('panel')}</button>`;
			this.bar = bar; // detached until attach()
			this.usageBtn = bar.querySelector('[data-act="usage"]');
			this.toolsBtn = bar.querySelector('[data-act="tools"]');
			this.modelPill = bar.querySelector('[data-act="apply-model"]');

			this.usageBtn.addEventListener('click', () => this.toggleUsagePopover());
			this.toolsBtn.addEventListener('click', () => {
				CT.popover.toggle('tools', () => CT.tools.openLauncher(this.toolsBtn.getBoundingClientRect(), this.toolsBtn));
			});
			this.modelPill.addEventListener('click', async (e) => {
				e.stopPropagation();
				const sug = this._suggestion;
				if (!sug) return;
				const ok = await CT.model.applyModel(sug.model);
				CT.model.toast(ok ? `Switched to ${sug.model}` : `Couldn’t switch automatically — pick ${sug.model} manually`);
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
			this._updateModel(); // seed the model pill so it shows on first load
		}

		setSettings(s) {
			this.settings = s;
			this.attach();
			this.render();
		}

		// ---- native docking ----
		// Resolve the element to dock the strip AFTER. We must always land below
		// the *whole* composer card so the strip can never sit among Claude's own
		// model/effort/mic/send controls — so resolution is fail-safe: if we can't
		// confidently find the input card, we return null and stay hidden rather
		// than mis-anchoring inside the control rows.
		_resolveAnchor() {
			// 1) Preferred: Claude's own composer grid container.
			for (const sel of CT.SEL.COMPOSER_GRID) {
				const el = document.querySelector(sel);
				if (el) return el;
			}
			// 2) Fallback (selectors drifted): derive the composer card from the
			//    editor by climbing to the outermost ancestor that still tightly
			//    wraps the input — i.e. stop once the parent is clearly the wider
			//    page column. Anchoring after that whole card keeps every native
			//    control above the strip.
			const ed = CT.getComposer && CT.getComposer();
			if (ed) {
				let card = ed;
				for (let i = 0; i < 8 && card.parentElement && card.parentElement !== document.body; i++) {
					const pr = card.parentElement.getBoundingClientRect();
					const cr = card.getBoundingClientRect();
					if (pr.width - cr.width > 24) break; // parent is the column, not a wrapper
					card = card.parentElement;
				}
				// Accept only if we climbed past the editor to a real card wrapper.
				if (card !== ed && card.parentElement) return card;
			}
			return null; // fail-safe: don't anchor among native controls
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
			const att = CT.attachments ? CT.attachments.estimateForComposer() : { tokens: 0, attachmentsCount: 0, types: [] };
			this._suggestion = ((text || att.attachmentsCount) && CT.model.suggestModel({
				text,
				contextPct: ctxPct,
				hasAttachment: att.attachmentsCount > 0,
				attachmentTokens: att.tokens,
				attachmentCount: att.attachmentsCount,
				attachmentTypes: att.types,
				attachments: att.list || []
			})) || NEUTRAL_SUGGESTION;
			CT.state.suggestion = this._suggestion; // shared with the panel's Overview advisor card
			this._renderModel();
		}
		_renderModel() {
			if (!this.modelPill) return;
			const sug = this._suggestion;
			const show = this.settings.showModelSuggestion !== false && !!sug && this.mode !== 'tiny';
			this.modelPill.hidden = !show;
			if (!show) return;
			this.modelPill.querySelector('.ct-strip__model-lbl').textContent = sug.displayName || sug.model;
			this.modelPill.dataset.tier = sug.finalTier || sug.tier || 'sonnet'; // tints the star by tier
			const cs = sug.cost && sug.speed ? ` · ${sug.cost} cost, ${sug.speed}` : '';
			this.modelPill.title = `Suggested: ${sug.displayName || sug.model} — ${sug.reason}${cs} (click to switch)`;
			this.modelPill.setAttribute('aria-label', `Suggested model ${sug.displayName || sug.model}. ${sug.reason}. Activate to switch.`);
		}

		// ---- value rendering ----
		render() {
			if (!this._built) return;
			const map = CT.state.map;
			const usage = CT.state.usage;
			const wide = this.mode === 'wide';
			const mid = this.mode === 'mid';
			this._aria = []; // collected into one summary on the usage button

			const setUsageSeg = (seg, w, longLabel, shortLabel, name) => {
				const el = this.bar.querySelector(`[data-seg="${seg}"]`);
				const lab = el.querySelector('.ct-seg__lab');
				const txt = el.querySelector('.ct-seg__txt');
				const rail = el.querySelector('.ct-rail i');
				const pct = w?.utilization;
				const lvl = pct == null ? null : CT.usage.level(pct);
				el.classList.remove('ct-lvl-healthy', 'ct-lvl-moderate', 'ct-lvl-high', 'ct-lvl-critical');
				if (lvl) el.classList.add(`ct-lvl-${lvl.key}`);
				lab.textContent = wide || mid ? longLabel : shortLabel;
				if (rail) {
					rail.style.width = `${pct || 0}%`;
					rail.className = '';
					rail.classList.add(`ct-lvlbg-${lvl ? lvl.key : 'healthy'}`);
				}
				txt.textContent = pct == null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
				const resets = w?.resets_at ? `, resets in ${fmtCountdown(Date.parse(w.resets_at))}` : '';
				this._aria.push(`${name} ${pct == null ? 'unknown' : Math.round(pct) + ' percent'}${lvl ? ', ' + lvl.label : ''}${resets}`);
			};
			setUsageSeg('five', usage?.five_hour, 'Session', '5h', 'Session');
			setUsageSeg('seven', usage?.seven_day, 'Weekly', '7d', 'Weekly');

			const ctxSeg = this.bar.querySelector('[data-seg="ctx"]');
			const ctxLab = ctxSeg.querySelector('.ct-seg__lab');
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
				ctxLab.textContent = 'Context';
				ctxTxt.textContent = `${ctxPct.toFixed(ctxPct < 10 ? 1 : 0)}%`;
				this._aria.push(`Context window ${Math.round(ctxPct)} percent, ${lvl.label}`);
			}

			this._renderCache();
			this._renderModel();
			this.usageBtn.setAttribute('aria-label', this._aria.length ? `Usage — ${this._aria.join('; ')}. Open usage details.` : 'Usage details');
		}

		_renderCache() {
			const seg = this.bar.querySelector('[data-seg="cache"]');
			const div = this.bar.querySelector('[data-div="cache"]');
			const cu = CT.state.map?.cachedUntil;
			const isCacheActive = cu && Date.now() < cu; // strip shows cache ONLY while active
			const show = isCacheActive && this.settings.showCacheCountdown !== false && (this.mode === 'wide' || this.mode === 'mid');
			seg.hidden = !show;
			if (div) div.hidden = !show;
			if (show) {
				seg.querySelector('.ct-seg__lab').textContent = 'Cache';
				seg.querySelector('.ct-seg__txt').textContent = fmtClock(cu);
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
						(() => {
							const sug = this._suggestion;
							if (!sug) return '';
							const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
							const mtier = sug.finalTier || sug.tier || 'sonnet';
							const alt = sug.alternative && sug.alternative.model ? `💡 Consider ${cap(sug.alternative.model)} ${esc(sug.alternative.condition || '')}` : '';
							return `<div class="ct-urow"><div class="ct-urow__top"><span class="ct-urow__name">Suggested model</span><span class="ct-urow__val"><span class="ct-modeltag" data-tier="${mtier}">${sug.emoji || ''} ${esc(sug.displayName || sug.model)}</span></span></div><div class="ct-hint">${esc(sug.reason)}</div><div class="ct-hint ct-hint--help">Cost: ${esc(cap(sug.cost) || '—')} · Speed: ${esc(cap(sug.speed) || '—')} · Confidence: ${esc(cap(sug.confidenceLabel || 'medium'))}</div>${alt ? `<div class="ct-hint ct-hint--help">${alt}</div>` : ''}</div>`;
						})();
					api.place();
				}
			});
		}
	}

	CT.BottomBar = BottomBar;
})();
