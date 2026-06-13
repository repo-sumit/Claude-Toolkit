(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});
	const { fmtTokens, heatColor, esc: escapeHtml, makeId, fmtCountdown, fmtClock } = CT.u;

	const TABS = [
		['overview', 'Overview'],
		['map', 'Map'],
		['tools', 'Tools'],
		['prompts', 'Prompts'],
		['export', 'Export'],
		['settings', '⚙ Settings']
	];

	class Panel {
		constructor(cbs = {}) {
			this.onRefresh = cbs.onRefresh || null;
			this.onSettingsChange = cbs.onSettingsChange || null;
			this.onToggle = cbs.onToggle || null;
			this.lastMap = null;
			this.lastConversation = null;
			this.usage = null;
			this.usageResetMs = { five: null, seven: null };
			this.cachedUntil = null;
			this.settings = CT.DEFAULTS;
			this.open = false;
			this.tab = 'overview';
			this.editingId = null;
			this._confirmReset = false;
			this._built = false;
		}

		mount() {
			if (this._built) return;
			this._built = true;

			const toggle = document.createElement('button');
			toggle.className = 'ct-toggle';
			toggle.title = 'Claude Toolkit';
			toggle.setAttribute('aria-label', 'Open Claude Toolkit panel');
			toggle.setAttribute('aria-expanded', 'false');
			CT.a11y.decorate(toggle);
			toggle.innerHTML = `<span class="ct-toggle__icon" aria-hidden="true">${CT.icon('panel', 16)}</span><span class="ct-toggle__label">Tools</span>`;
			toggle.addEventListener('click', () => this.setOpen(!this.open));

			const panel = document.createElement('aside');
			panel.className = 'ct-panel';
			panel.setAttribute('role', 'dialog');
			panel.setAttribute('aria-label', 'Claude Toolkit panel');
			CT.a11y.decorate(panel);

			const tabBtns = TABS.map(
				([k, label]) => `<button class="ct-tab" role="tab" data-tab="${k}" aria-selected="false" aria-label="${escapeHtml(label.replace('⚙ ', ''))} tab">${escapeHtml(label)}</button>`
			).join('');
			panel.innerHTML = `
				<div class="ct-head">
					<div class="ct-title">Claude&nbsp;Toolkit</div>
					<div class="ct-head__actions">
						<button class="ct-iconbtn" data-act="refresh" title="Refresh data" aria-label="Refresh data">${CT.icon('refresh', 16)}</button>
						<button class="ct-iconbtn" data-act="close" title="Close panel" aria-label="Close panel">${CT.icon('x', 16)}</button>
					</div>
				</div>
				<div class="ct-tabs" role="tablist" aria-label="Toolkit sections">${tabBtns}</div>
				<div class="ct-body">${TABS.map(([k]) => `<div class="ct-pane" data-pane="${k}" role="tabpanel" tabindex="0"></div>`).join('')}</div>`;

			panel.querySelector('[data-act="close"]').addEventListener('click', () => this.setOpen(false));
			panel.querySelector('[data-act="refresh"]').addEventListener('click', () => this.onRefresh && this.onRefresh());
			panel.querySelectorAll('.ct-tab').forEach((b) => {
				b.addEventListener('click', () => this.setTab(b.dataset.tab));
				b.addEventListener('keydown', (e) => {
					if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
					e.preventDefault();
					const keys = TABS.map(([k]) => k);
					let i = keys.indexOf(this.tab) + (e.key === 'ArrowRight' ? 1 : -1);
					i = (i + keys.length) % keys.length;
					this.setTab(keys[i]);
					panel.querySelector(`.ct-tab[data-tab="${keys[i]}"]`).focus();
				});
			});
			panel.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !CT.popover.isOpen()) {
					e.stopPropagation();
					this.setOpen(false);
				}
			});

			document.body.appendChild(toggle);
			document.body.appendChild(panel);
			this.toggle = toggle;
			this.panel = panel;
			this.panes = {};
			panel.querySelectorAll('.ct-pane').forEach((p) => (this.panes[p.dataset.pane] = p));

			this.setTab('overview');
			this.renderAll();
		}

		renderAll() {
			this.renderOverview();
			this.renderMap();
			this.renderTools();
			this.renderPrompts();
			this.renderExport();
			this.renderSettings();
		}

		setOpen(v) {
			this.open = v;
			this.panel.classList.toggle('ct-panel--open', v);
			this.toggle.classList.toggle('ct-toggle--hidden', v);
			this.toggle.setAttribute('aria-expanded', v ? 'true' : 'false');
			if (v) {
				this._releaseTrap = CT.a11y.trapFocus(this.panel);
				this.panel.querySelector(`.ct-tab[data-tab="${this.tab}"]`)?.focus();
			} else {
				this._releaseTrap?.();
				this._releaseTrap = null;
				this.toggle.focus();
			}
			if (this.onToggle) this.onToggle(v);
		}

		setTab(tab) {
			this.tab = tab;
			this.panel.querySelectorAll('.ct-tab').forEach((b) => {
				const on = b.dataset.tab === tab;
				b.classList.toggle('ct-tab--active', on);
				b.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			Object.entries(this.panes).forEach(([k, el]) => (el.style.display = k === tab ? '' : 'none'));
		}

		applyDark(isDark) {
			CT.theme.dark = isDark;
			CT.a11y.applyAll();
		}

		// ---- data setters ----
		setConversation(d) {
			this.lastConversation = d;
		}
		setMap(m) {
			this.lastMap = m;
			this.cachedUntil = m?.cachedUntil || null;
			this.renderMap();
			this.renderOverview();
		}
		setUsage(u) {
			this.usage = u;
			this.usageResetMs.five = u?.five_hour?.resets_at ? Date.parse(u.five_hour.resets_at) : null;
			this.usageResetMs.seven = u?.seven_day?.resets_at ? Date.parse(u.seven_day.resets_at) : null;
			this.renderOverview();
		}
		setSettings(s) {
			this.settings = s;
			this.renderPrompts();
			this.renderSettings();
		}

		// ================= OVERVIEW =================
		renderOverview() {
			const pane = this.panes.overview;
			if (!pane) return;
			const m = this.lastMap;
			const ctxPct = m?.count ? Math.min(100, (m.total / CT.CONST.CONTEXT_LIMIT_TOKENS) * 100) : null;
			const card = (name, pct, sub, extraTag) => {
				const lvl = pct == null ? null : CT.usage.level(pct);
				return `<div class="ct-card">
					<div class="ct-card__name">${escapeHtml(name)}</div>
					<div class="ct-card__val">${pct == null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}</div>
					${lvl ? `<span class="ct-tag ct-lvl-${lvl.key}">${lvl.label}</span>` : extraTag || ''}
					<div class="ct-bar-track"><div class="ct-bar-fill ct-lvlbg-${lvl ? lvl.key : 'healthy'}" style="width:${pct || 0}%"></div></div>
					<div class="ct-hint">${sub}</div>
				</div>`;
			};
			const cu = this.cachedUntil;
			const cacheVal = !cu ? '—' : Date.now() >= cu ? 'expired' : fmtClock(cu);
			const f = this.usage?.five_hour, s7 = this.usage?.seven_day;
			pane.innerHTML = `
				<div class="ct-ovgrid">
					${card('Context window', ctxPct, m?.count ? `<span data-ov="ctx">${CT.tokenizer.isApproximate() ? '~' : ''}${fmtTokens(m.total)} / ${fmtTokens(CT.CONST.CONTEXT_LIMIT_TOKENS)} tok · ${m.count} msgs</span>` : 'open a conversation')}
					<div class="ct-card">
						<div class="ct-card__name">Prompt cache</div>
						<div class="ct-card__val" data-ov="cache">${cacheVal}</div>
						<div class="ct-hint">~5 min after each Claude reply</div>
					</div>
					${card('Session (5h)', f?.utilization ?? null, `<span data-ov="five">${f?.resets_at ? `resets in ${fmtCountdown(Date.parse(f.resets_at))}` : ''}</span>`)}
					${card('Weekly (7d)', s7?.utilization ?? null, `<span data-ov="seven">${s7?.resets_at ? `resets in ${fmtCountdown(Date.parse(s7.resets_at))}` : ''}</span>`)}
				</div>
				<div class="ct-btns ct-btns--row">
					<button class="ct-btn" data-go="map">Open map</button>
					<button class="ct-btn" data-go="tools">Quick tools</button>
					<button class="ct-btn" data-go="export">Export</button>
				</div>`;
			pane.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => this.setTab(b.getAttribute('data-go'))));
		}

		// ================= MAP =================
		renderMap() {
			const pane = this.panes.map;
			if (!pane) return;
			const m = this.lastMap;
			if (!m || m.count === 0) {
				pane.innerHTML = `<div class="ct-empty">No conversation loaded yet. Open a chat (or hit Refresh) to map it.</div>`;
				return;
			}
			const approx = CT.tokenizer.isApproximate();
			const pct = Math.min(100, (m.total / CT.CONST.CONTEXT_LIMIT_TOKENS) * 100);
			pane.innerHTML = `
				<div class="ct-meter">
					<div class="ct-meter__row"><span class="ct-meter__text">${approx ? '~' : ''}${fmtTokens(m.total)} / ${fmtTokens(CT.CONST.CONTEXT_LIMIT_TOKENS)} tokens</span><span class="ct-meter__pct">${pct.toFixed(pct < 10 ? 1 : 0)}%</span></div>
					<div class="ct-bar-track"><div class="ct-bar-fill" style="width:${pct}%;background:${heatColor(m.total / CT.CONST.CONTEXT_LIMIT_TOKENS)}"></div></div>
					<div class="ct-hint">${m.count} messages on this branch${approx ? ' · approx. counts' : ''} · times shown per message · click a row to jump</div>
				</div>
				<div class="ct-list"></div>`;
			const list = pane.querySelector('.ct-list');
			const frag = document.createDocumentFragment();
			for (const it of m.items) {
				const ratio = m.max > 0 ? it.tokens / m.max : 0;
				const row = document.createElement('button');
				row.className = 'ct-row';
				const who = it.sender === 'assistant' ? 'Claude' : 'You';
				row.title = `${who}${it.timeLabel ? ` · ${it.timeLabel}` : ''} · ${it.tokens.toLocaleString()} tokens — click to jump`;
				row.setAttribute('aria-label', `Jump to message ${it.index + 1} from ${who}${it.timeLabel ? `, sent ${it.timeLabel}` : ''}, ${it.tokens.toLocaleString()} tokens`);
				const bar = document.createElement('div');
				bar.className = 'ct-row__bar';
				bar.style.width = `${Math.max(4, ratio * 100)}%`;
				bar.style.background = heatColor(ratio);
				const dot = document.createElement('span');
				dot.className = `ct-row__dot ct-row__dot--${it.sender}`;
				const label = document.createElement('span');
				label.className = 'ct-row__label';
				label.textContent = it.label;
				const time = document.createElement('span');
				time.className = 'ct-row__time';
				time.textContent = it.timeLabel || '';
				const tok = document.createElement('span');
				tok.className = 'ct-row__tokens';
				tok.textContent = fmtTokens(it.tokens);
				row.append(bar, dot, label, time, tok);
				row.addEventListener('click', () => this.jumpTo(it));
				frag.appendChild(row);
			}
			list.replaceChildren(frag);
		}

		findTurns() {
			for (const sel of CT.SEL.TURNS) {
				const els = Array.from(document.querySelectorAll(sel));
				if (els.length) return els;
			}
			return [];
		}
		jumpTo(item) {
			const turns = this.findTurns();
			let target = null;
			if (turns.length && this.lastMap && turns.length === this.lastMap.count) target = turns[item.index] || null;
			if (!target && item.searchKey) {
				const pool = turns.length ? turns : Array.from(document.querySelectorAll('main p, main li, [data-testid="user-message"], .font-claude-message'));
				for (const el of pool) {
					const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
					if (t && (t.startsWith(item.searchKey) || t.includes(item.searchKey))) {
						target = el;
						break;
					}
				}
			}
			if (!target) {
				this.panel.classList.add('ct-shake');
				setTimeout(() => this.panel.classList.remove('ct-shake'), 360);
				return;
			}
			target.scrollIntoView({ behavior: CT.a11y.systemReducedMotion() || this.settings.reducedMotion ? 'auto' : 'smooth', block: 'center' });
			target.classList.add('ct-flash');
			setTimeout(() => target.classList.remove('ct-flash'), 1300);
		}

		// ================= TOOLS =================
		renderTools() {
			const pane = this.panes.tools;
			if (!pane) return;
			pane.innerHTML = `
				<input class="ct-input" type="search" placeholder="Search tools…" aria-label="Search tools" data-toolsearch>
				<div class="ct-toollist" data-toollist></div>
				<div class="ct-hint">Tools build prompts from your selection or current draft and insert them into the composer. Shortcut to open this anywhere: Ctrl/Cmd+Shift+K.</div>`;
			const search = pane.querySelector('[data-toolsearch]');
			const listEl = pane.querySelector('[data-toollist]');
			const render = () => {
				const q = search.value.trim().toLowerCase();
				listEl.replaceChildren();
				for (const cat of CT.tools.categories()) {
					const tools = CT.tools.all().filter((t) => t.category === cat && (!q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q)));
					if (!tools.length) continue;
					const h = document.createElement('div');
					h.className = 'ct-toollist__cat';
					h.textContent = cat;
					listEl.appendChild(h);
					for (const t of tools) {
						const b = document.createElement('button');
						b.className = 'ct-tool';
						b.innerHTML = `<span class="ct-tool__name">${escapeHtml(t.name)}</span><span class="ct-tool__desc">${escapeHtml(t.description)}</span>`;
						b.addEventListener('click', () => CT.tools.run(t.id));
						listEl.appendChild(b);
					}
				}
			};
			search.addEventListener('input', render);
			render();
		}

		// ================= PROMPTS =================
		renderPrompts() {
			const pane = this.panes.prompts;
			if (!pane) return;
			const prompts = this.settings?.prompts || [];
			const q = (this._promptQuery || '').toLowerCase();
			const cats = ['All', ...new Set(prompts.map((p) => p.category || 'General'))];
			const packNames = Object.keys(CT.PROMPT_PACKS);

			const filtered = prompts.filter((p) => !q || `${p.name} ${p.keyword} ${p.body} ${p.category || ''}`.toLowerCase().includes(q));
			const byCat = {};
			for (const p of filtered) (byCat[p.category || 'General'] = byCat[p.category || 'General'] || []).push(p);

			const rows = Object.entries(byCat)
				.map(
					([cat, list]) => `<div class="ct-toollist__cat">${escapeHtml(cat)}</div>` +
						list.map((p) => `
						<div class="ct-prompt" data-id="${p.id}">
							<div class="ct-prompt__main">
								<span class="ct-prompt__name">${escapeHtml(p.name)}</span>
								<span class="ct-prompt__kw">/${escapeHtml(p.keyword || '')}</span>
							</div>
							<div class="ct-prompt__actions">
								<button class="ct-iconbtn" data-edit="${p.id}" title="Edit" aria-label="Edit ${escapeHtml(p.name)}">✎</button>
								<button class="ct-iconbtn" data-dup="${p.id}" title="Duplicate" aria-label="Duplicate ${escapeHtml(p.name)}">⧉</button>
								<button class="ct-iconbtn" data-del="${p.id}" title="Delete" aria-label="Delete ${escapeHtml(p.name)}">🗑</button>
							</div>
						</div>`).join('')
				)
				.join('');

			pane.innerHTML = `
				<div class="ct-hint">Type <b>/</b> in the message box to insert these. <code>{{placeholders}}</code> open a fill-in form.</div>
				<input class="ct-input" type="search" placeholder="Search prompts…" aria-label="Search prompts" data-psearch value="${escapeHtml(this._promptQuery || '')}">
				<div class="ct-prompts">${rows || '<div class="ct-empty">No prompts match.</div>'}</div>
				<div class="ct-btns ct-btns--row">
					<button class="ct-btn" data-pexport>Export JSON</button>
					<button class="ct-btn" data-pimport>Import JSON</button>
					<input type="file" accept="application/json" data-pfile class="ct-sr-only" aria-hidden="true" tabindex="-1">
				</div>
				<div class="ct-btns ct-btns--row">
					<select class="ct-input ct-input--inline" data-packsel aria-label="Choose a prompt pack">${packNames.map((n) => `<option>${escapeHtml(n)}</option>`).join('')}</select>
					<button class="ct-btn" data-packadd>Add pack</button>
					<button class="ct-btn" data-preset>${this._confirmReset ? 'Click again to confirm' : 'Reset to defaults'}</button>
				</div>
				<div class="ct-form">
					<div class="ct-form__title" data-formtitle>${this.editingId ? 'Edit prompt' : 'Add a prompt'}</div>
					<input class="ct-input" data-f="name" placeholder="Name (e.g. Summarize)" aria-label="Prompt name">
					<input class="ct-input" data-f="keyword" placeholder="Shortcut keyword (e.g. sum)" aria-label="Prompt keyword">
					<input class="ct-input" data-f="category" placeholder="Category (e.g. Writing)" list="ct-cats" aria-label="Prompt category">
					<datalist id="ct-cats">${cats.filter((c) => c !== 'All').map((c) => `<option>${escapeHtml(c)}</option>`).join('')}</datalist>
					<textarea class="ct-textarea" data-f="body" rows="4" placeholder="Prompt text. Use {{placeholders}} for blanks." aria-label="Prompt text"></textarea>
					<div class="ct-form__btns">
						<button class="ct-btn ct-btn--primary" data-save>Save</button>
						<button class="ct-btn" data-cancel ${this.editingId ? '' : 'style="display:none"'}>Cancel</button>
					</div>
				</div>`;

			const psearch = pane.querySelector('[data-psearch]');
			psearch.addEventListener('input', () => {
				this._promptQuery = psearch.value;
				const pos = psearch.selectionStart;
				this.renderPrompts();
				const np = this.panes.prompts.querySelector('[data-psearch]');
				np.focus();
				np.setSelectionRange(pos, pos);
			});

			pane.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => this._startEdit(b.getAttribute('data-edit'))));
			pane.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', () => this._dupPrompt(b.getAttribute('data-dup'))));
			pane.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => this._deletePrompt(b.getAttribute('data-del'))));
			pane.querySelector('[data-save]').addEventListener('click', () => this._savePrompt());
			pane.querySelector('[data-cancel]').addEventListener('click', () => {
				this.editingId = null;
				this.renderPrompts();
			});

			pane.querySelector('[data-pexport]').addEventListener('click', () => {
				const blob = new Blob([JSON.stringify(this.settings.prompts || [], null, 2)], { type: 'application/json' });
				const a = document.createElement('a');
				a.href = URL.createObjectURL(blob);
				a.download = 'claude-toolkit-prompts.json';
				a.click();
				setTimeout(() => URL.revokeObjectURL(a.href), 3000);
			});
			const fileInput = pane.querySelector('[data-pfile]');
			pane.querySelector('[data-pimport]').addEventListener('click', () => fileInput.click());
			fileInput.addEventListener('change', async () => {
				const f = fileInput.files?.[0];
				if (!f) return;
				try {
					const arr = JSON.parse(await f.text());
					if (!Array.isArray(arr)) throw new Error('not array');
					const existing = this.settings.prompts || [];
					const merged = [...existing];
					let added = 0;
					for (const p of arr) {
						if (!p?.name || !p?.body) continue;
						merged.push({ id: makeId(), name: String(p.name), keyword: String(p.keyword || ''), category: String(p.category || 'Imported'), body: String(p.body) });
						added++;
					}
					this._commitSettings({ prompts: merged });
					CT.model.toast(`Imported ${added} prompt(s)`);
				} catch {
					CT.model.toast('Import failed — not a valid prompts JSON');
				}
			});
			pane.querySelector('[data-packadd]').addEventListener('click', () => {
				const packName = pane.querySelector('[data-packsel]').value;
				const pack = CT.PROMPT_PACKS[packName] || [];
				const merged = [...(this.settings.prompts || [])];
				let added = 0;
				for (const p of pack) {
					if (merged.some((x) => x.name === p.name && (x.category || '') === packName)) continue;
					merged.push({ id: makeId(), category: packName, ...p });
					added++;
				}
				this._commitSettings({ prompts: merged });
				CT.model.toast(added ? `Added ${added} prompt(s) from ${packName}` : `${packName} pack already added`);
			});
			pane.querySelector('[data-preset]').addEventListener('click', () => {
				if (!this._confirmReset) {
					this._confirmReset = true;
					this.renderPrompts();
					setTimeout(() => {
						this._confirmReset = false;
						if (this.tab === 'prompts') this.renderPrompts();
					}, 4000);
					return;
				}
				this._confirmReset = false;
				this._commitSettings({ prompts: JSON.parse(JSON.stringify(CT.DEFAULTS.prompts)) });
				CT.model.toast('Prompts reset to defaults');
			});

			if (this.editingId) this._fillForm();
		}

		_formInputs() {
			const pane = this.panes.prompts;
			return {
				name: pane.querySelector('[data-f="name"]'),
				keyword: pane.querySelector('[data-f="keyword"]'),
				category: pane.querySelector('[data-f="category"]'),
				body: pane.querySelector('[data-f="body"]')
			};
		}
		_fillForm() {
			const p = (this.settings.prompts || []).find((x) => x.id === this.editingId);
			if (!p) return;
			const f = this._formInputs();
			f.name.value = p.name || '';
			f.keyword.value = p.keyword || '';
			f.category.value = p.category || '';
			f.body.value = p.body || '';
		}
		_startEdit(id) {
			this.editingId = id;
			this.setTab('prompts');
			this.renderPrompts();
			this._formInputs().name.focus();
		}
		_dupPrompt(id) {
			const p = (this.settings.prompts || []).find((x) => x.id === id);
			if (!p) return;
			const prompts = [...this.settings.prompts];
			const i = prompts.findIndex((x) => x.id === id);
			prompts.splice(i + 1, 0, { ...p, id: makeId(), name: `${p.name} (copy)` });
			this._commitSettings({ prompts });
		}
		_savePrompt() {
			const f = this._formInputs();
			const name = f.name.value.trim();
			const keyword = f.keyword.value.trim().replace(/\s+/g, '');
			const category = f.category.value.trim() || 'General';
			const body = f.body.value;
			if (!name || !body.trim()) return CT.model.toast('Name and prompt text are required');
			const prompts = [...(this.settings.prompts || [])];
			if (this.editingId) {
				const i = prompts.findIndex((x) => x.id === this.editingId);
				if (i >= 0) prompts[i] = { ...prompts[i], name, keyword, category, body };
			} else {
				prompts.push({ id: makeId(), name, keyword, category, body });
			}
			this.editingId = null;
			this._commitSettings({ prompts });
		}
		_deletePrompt(id) {
			this._commitSettings({ prompts: (this.settings.prompts || []).filter((x) => x.id !== id) });
		}

		// ================= EXPORT =================
		renderExport() {
			const pane = this.panes.export;
			if (!pane) return;
			pane.innerHTML = `
				<div class="ct-exporthint">Everything exports the current branch only. Includes title, date, message count and token metadata.</div>
				<div class="ct-toollist__cat">Whole conversation</div>
				<div class="ct-btns">
					<button class="ct-btn" data-ex="copy">Copy as Markdown</button>
					<button class="ct-btn" data-ex="md">Download .md</button>
					<button class="ct-btn" data-ex="json">Download .json</button>
					<button class="ct-btn" data-ex="pdf">Open print / PDF view</button>
				</div>
				<div class="ct-toollist__cat">Pieces</div>
				<div class="ct-btns">
					<button class="ct-btn" data-ex="lastanswer">Copy last Claude answer</button>
					<button class="ct-btn" data-ex="lastcode">Copy last code block</button>
					<button class="ct-btn" data-ex="sumprompt">Insert summary prompt</button>
				</div>
				<div class="ct-toollist__cat">Filtered</div>
				<div class="ct-btns">
					<button class="ct-btn" data-ex="useronly">Download only my messages (.md)</button>
					<button class="ct-btn" data-ex="claudeonly">Download only Claude replies (.md)</button>
				</div>
				<div class="ct-toollist__cat">Range</div>
				<div class="ct-btns ct-btns--row ct-rangebox">
					<label class="ct-rangelab">From <input class="ct-input ct-input--num" type="number" min="1" value="1" data-rfrom aria-label="Range start message number"></label>
					<label class="ct-rangelab">To <input class="ct-input ct-input--num" type="number" min="1" data-rto aria-label="Range end message number"></label>
					<button class="ct-btn" data-ex="range">Download range (.md)</button>
				</div>
				<div class="ct-exportnote" data-note role="status"></div>`;

			const note = pane.querySelector('[data-note]');
			const need = () => {
				if (!this.lastConversation) {
					note.textContent = 'Open a conversation first.';
					return false;
				}
				return true;
			};
			const on = (sel, fn) => pane.querySelector(`[data-ex="${sel}"]`).addEventListener('click', fn);

			on('copy', async () => need() && (note.textContent = (await CT.exporter.copyMarkdown(this.lastConversation)) ? 'Copied Markdown ✓' : 'Clipboard blocked — try Download .md'));
			on('md', () => need() && (CT.exporter.downloadMarkdown(this.lastConversation), (note.textContent = 'Markdown downloaded ✓')));
			on('json', () => need() && (CT.exporter.downloadJSON(this.lastConversation), (note.textContent = 'JSON downloaded ✓')));
			on('pdf', () => need() && (note.textContent = CT.exporter.printView(this.lastConversation) ? 'Opened print view — choose "Save as PDF"' : 'Popup blocked — allow popups for claude.ai'));
			on('lastanswer', async () => {
				if (!need()) return;
				const md = CT.exporter.lastAssistantMarkdown(this.lastConversation);
				note.textContent = !md ? 'No Claude answer found' : (await CT.exporter.copyText(md)) ? 'Copied last answer ✓' : 'Clipboard blocked';
			});
			on('lastcode', async () => {
				if (!need()) return;
				const blk = CT.exporter.lastCodeBlock(this.lastConversation);
				note.textContent = !blk ? 'No code block found' : (await CT.exporter.copyText(blk.code)) ? `Copied ${blk.lang || 'code'} block ✓` : 'Clipboard blocked';
			});
			on('sumprompt', () => {
				CT.insertIntoComposer(CT.exporter.summaryPrompt());
				note.textContent = 'Summary prompt inserted into composer ✓';
			});
			on('useronly', () => need() && (CT.exporter.downloadMarkdown(this.lastConversation, { who: 'human' }, '-you'), (note.textContent = 'Your messages downloaded ✓')));
			on('claudeonly', () => need() && (CT.exporter.downloadMarkdown(this.lastConversation, { who: 'assistant' }, '-claude'), (note.textContent = 'Claude replies downloaded ✓')));
			on('range', () => {
				if (!need()) return;
				const from = parseInt(pane.querySelector('[data-rfrom]').value, 10) || 1;
				const to = parseInt(pane.querySelector('[data-rto]').value, 10) || this.lastMap?.count || from;
				CT.exporter.downloadMarkdown(this.lastConversation, { from, to }, `-${from}-${to}`);
				note.textContent = `Messages ${from}–${to} downloaded ✓`;
			});
		}

		// ================= SETTINGS =================
		renderSettings() {
			const pane = this.panes.settings;
			if (!pane) return;
			const s = this.settings || {};
			const toggle = (key, label, sub) => `
				<label class="ct-setting">
					<span><span class="ct-setting__label">${label}</span>${sub ? `<span class="ct-setting__sub">${sub}</span>` : ''}</span>
					<input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''} aria-label="${escapeHtml(label)}">
				</label>`;
			const cats = ['All', ...new Set((s.prompts || []).map((p) => p.category || 'General'))];
			pane.innerHTML = `
				<div class="ct-toollist__cat">Bottom bar</div>
				${toggle('showBottomBar', 'Show bottom status strip', 'Thin live-metrics strip near the composer')}
				${toggle('bottomBarCompact', 'Compact labels', 'Abbreviated labels (5h / 7d / Ctx) to save space')}
				${toggle('showModelSuggestion', 'Show model suggestion', 'Suggested Haiku / Sonnet / Opus for your draft')}
				${toggle('showCacheCountdown', 'Show cache countdown', 'Only while the prompt cache is active')}
				${toggle('showInlineExport', 'Inline export button', 'Small Export button at the bottom of the last reply')}
				<div class="ct-toollist__cat">Features</div>
				${toggle('enableQuickTools', 'Quick Tools', 'Tool launcher in the bar and Ctrl/Cmd+Shift+K')}
				${toggle('enablePalette', 'Slash-command prompt palette', 'Type / in the composer to insert prompts')}
				${toggle('showAdvisor', 'Model advisor chip', 'Live token meter + suggested model above the composer')}
				${toggle('autoApplyModel', 'Auto-apply suggested model', 'Experimental — drives the claude.ai model picker')}
				<div class="ct-toollist__cat">Usage warnings</div>
				${toggle('usageWarnings', 'Show usage warnings', 'Toasts + compact badges in the bar')}
				${toggle('warningThreshold70', 'Warn at 70%', '')}
				${toggle('warningThreshold85', 'Warn at 85%', '')}
				${toggle('warningThreshold95', 'Warn at 95%', '')}
				<div class="ct-toollist__cat">Accessibility</div>
				${toggle('reducedMotion', 'Reduce motion', 'Also follows your system preference automatically')}
				${toggle('highContrast', 'High contrast', 'Stronger borders and focus outlines')}
				<div class="ct-toollist__cat">Prompts</div>
				<label class="ct-setting"><span><span class="ct-setting__label">Default prompt category</span><span class="ct-setting__sub">Pre-selected in pickers</span></span>
					<select class="ct-input ct-input--inline" data-setval="defaultPromptCategory" aria-label="Default prompt category">
						${cats.map((c) => `<option ${s.defaultPromptCategory === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
					</select>
				</label>
				<div class="ct-hint ct-settingsfoot">Settings + prompts are stored locally in your browser. Nothing leaves the page.</div>`;
			pane.querySelectorAll('[data-set]').forEach((cb) => cb.addEventListener('change', () => this._commitSettings({ [cb.getAttribute('data-set')]: cb.checked })));
			pane.querySelectorAll('[data-setval]').forEach((sel) => sel.addEventListener('change', () => this._commitSettings({ [sel.getAttribute('data-setval')]: sel.value })));
		}

		_commitSettings(patch) {
			this.settings = { ...this.settings, ...patch };
			if (this.onSettingsChange) this.onSettingsChange(patch, this.settings);
			this.renderSettings();
			this.renderPrompts();
		}

		// ---- per-second updates ----
		tick() {
			// Overview cache + countdowns
			const ov = this.panes.overview;
			if (ov && this.tab === 'overview') {
				const cacheEl = ov.querySelector('[data-ov="cache"]');
				if (cacheEl) {
					const cu = this.cachedUntil;
					cacheEl.textContent = !cu ? '—' : Date.now() >= cu ? 'expired' : fmtClock(cu);
				}
				const five = ov.querySelector('[data-ov="five"]');
				if (five && this.usageResetMs.five) five.textContent = `resets in ${fmtCountdown(this.usageResetMs.five)}`;
				const seven = ov.querySelector('[data-ov="seven"]');
				if (seven && this.usageResetMs.seven) seven.textContent = `resets in ${fmtCountdown(this.usageResetMs.seven)}`;
			}
		}
	}

	CT.Panel = Panel;
})();
