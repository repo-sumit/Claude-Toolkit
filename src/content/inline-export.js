(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	// A single Export affordance that lives in the footer of the LATEST Claude
	// reply only — styled like Claude's own reply actions (SVG, quiet hover) and
	// accompanied by a lightweight token-estimate line so basic chat state is
	// visible without opening the Map. As newer replies stream in, the one
	// cluster element is moved to the new bottom-most reply (never duplicated,
	// never attached to user messages).
	class ReplyExport {
		constructor({ onOpenPanel } = {}) {
			this.onOpenPanel = onOpenPanel || (() => {});
			this.settings = CT.DEFAULTS;
			this._built = false;
			this._raf = null;
			this._lastApply = 0;
			this.cluster = null;
			this.btn = null;
			this.meta = null;
		}

		mount(settings) {
			if (this._built) return;
			this._built = true;
			this.settings = settings;
			this._buildCluster();

			// Re-host on DOM changes (streaming, navigation, rerenders).
			this._obs = new MutationObserver(() => this._schedule());
			try {
				this._obs.observe(document.body, { childList: true, subtree: true });
			} catch {
				/* ignore */
			}
			this._watch = setInterval(() => this._apply(), 600);
			this._apply();
		}

		setSettings(s) {
			this.settings = s;
			if (!s.showInlineExport) this._remove();
			this._apply();
			this._renderMeta();
		}

		// Public entry used by main.js on conversation/url updates.
		refresh() {
			this._apply();
		}

		_buildCluster() {
			const cluster = document.createElement('div');
			cluster.className = 'ct-replyx ct-root';
			cluster.setAttribute('data-ct-export', '1');
			CT.a11y.decorate(cluster);

			const meta = document.createElement('span');
			meta.className = 'ct-replyx__meta';

			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'ct-replyx__btn';
			btn.setAttribute('aria-haspopup', 'dialog');
			btn.setAttribute('aria-expanded', 'false');
			btn.setAttribute('aria-label', 'Export this reply');
			btn.innerHTML = `${CT.icon('share', 15)}<span class="ct-replyx__lbl">Export</span>`;
			btn.addEventListener('click', () => this._toggleMenu());

			cluster.append(meta, btn);
			this.cluster = cluster;
			this.btn = btn;
			this.meta = meta;
		}

		// throttled re-host
		_schedule() {
			if (this._raf) return;
			this._raf = requestAnimationFrame(() => {
				this._raf = null;
				const now = Date.now();
				if (now - this._lastApply < 250) return;
				this._apply();
			});
		}

		_findActionRow(container) {
			// Prefer the row that holds Claude's own copy/retry buttons.
			const copyBtn = container.querySelector(
				'button[aria-label*="copy" i], button[data-testid*="copy" i], button[aria-label*="retry" i], button[data-testid*="retry" i]'
			);
			if (copyBtn && copyBtn.parentElement && copyBtn.parentElement !== this.cluster) return copyBtn.parentElement;
			return null;
		}

		_apply() {
			this._lastApply = Date.now();
			if (!this.settings?.showInlineExport || !CT.state.conversation) return this._remove();

			let msgs = [];
			for (const sel of CT.SEL.ASSISTANT) {
				msgs = Array.from(document.querySelectorAll(sel));
				if (msgs.length) break;
			}
			const last = msgs.length ? msgs[msgs.length - 1] : null;
			if (!last) return this._remove();

			const container = last.closest('[data-test-render-count]') || last.parentElement?.parentElement || last.parentElement;
			if (!container || !container.parentElement) return this._remove();

			// Insert the cluster just after the native action row when we can find
			// it (so it reads as part of the same footer cluster), else right after
			// the reply content.
			const row = this._findActionRow(container);
			const anchor = row || last;
			if (this.cluster.previousElementSibling !== anchor || !this.cluster.parentElement) {
				anchor.after(this.cluster);
			}
			this._renderMeta();
		}

		_renderMeta() {
			if (!this.meta) return;
			if (this.settings?.showReplyMeta === false) {
				this.meta.hidden = true;
				return;
			}
			const items = CT.state.map?.items || [];
			let lastA = null;
			for (let i = items.length - 1; i >= 0; i--) {
				if (items[i].sender === 'assistant') {
					lastA = items[i];
					break;
				}
			}
			if (!lastA) {
				this.meta.hidden = true;
				return;
			}
			this.meta.hidden = false;
			const approx = CT.tokenizer.isApproximate() ? '≈' : '';
			this.meta.textContent = `${approx}${CT.u.fmtTokens(lastA.tokens)} tokens`;
			this.meta.title = `This reply is about ${lastA.tokens.toLocaleString()} tokens`;
		}

		_remove() {
			if (this.cluster && this.cluster.parentElement) this.cluster.remove();
		}

		_toggleMenu() {
			CT.popover.toggle('replyexport', () => this._openMenu());
		}

		_openMenu() {
			const conv = CT.state.conversation;
			return CT.popover.show({
				title: 'Export conversation',
				kind: 'replyexport',
				width: 256,
				anchorRect: this.btn.getBoundingClientRect(),
				triggerEl: this.btn,
				build: (body, api) => {
					const note = document.createElement('div');
					note.className = 'ct-exportnote';
					note.setAttribute('role', 'status');
					const wrap = document.createElement('div');
					wrap.className = 'ct-menulist';

					const item = (icon, label, fn) => {
						const b = document.createElement('button');
						b.type = 'button';
						b.className = 'ct-menuitem';
						b.innerHTML = `${CT.icon(icon, 15)}<span>${CT.u.esc(label)}</span>`;
						b.addEventListener('click', () => fn());
						return b;
					};

					if (!conv) {
						note.textContent = 'Open a conversation first.';
						body.append(wrap, note);
						api.place();
						return;
					}
					wrap.append(
						item('copy', 'Copy Markdown', async () => {
							note.textContent = (await CT.exporter.copyMarkdown(conv)) ? 'Copied Markdown ✓' : 'Clipboard blocked — try Download';
						}),
						item('download', 'Download Markdown', () => {
							CT.exporter.downloadMarkdown(conv);
							note.textContent = 'Markdown downloaded ✓';
						}),
						item('braces', 'Download JSON', () => {
							CT.exporter.downloadJSON(conv);
							note.textContent = 'JSON downloaded ✓';
						}),
						item('printer', 'Print / Save PDF', () => {
							note.textContent = CT.exporter.printView(conv) ? 'Opened print view' : 'Popup blocked — allow popups';
						})
					);
					body.append(wrap, note);
					api.place();
				}
			});
		}
	}

	// Kept under the existing export name so wiring stays stable.
	CT.InlineExport = ReplyExport;
})();
