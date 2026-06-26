(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});
	if (CT.__started) return;
	CT.__started = true;

	const getConversationId = () => {
		const m = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return m ? m[1] : null;
	};
	const getOrgIdFromCookie = () => {
		try {
			return document.cookie.split('; ').find((r) => r.startsWith('lastActiveOrg='))?.split('=')[1] || null;
		} catch {
			return null;
		}
	};

	// Decide light/dark by MEASURING claude.ai's background luminance. This is
	// what keeps our surfaces opaque and correctly themed regardless of how
	// claude implements its theme.
	function pageIsDark() {
		const lum = (el) => {
			if (!el) return null;
			const c = getComputedStyle(el).backgroundColor || '';
			const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
			if (!m) return null;
			const a = m[4] === undefined ? 1 : parseFloat(m[4]);
			if (a === 0) return null;
			return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
		};
		let l = lum(document.body);
		if (l == null) l = lum(document.documentElement);
		if (l == null) return window.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
		return l < 0.45;
	}

	let currentConversationId = null;
	let currentOrgId = null;
	let lastUsageMs = 0;
	let usageInFlight = false;
	const warned = new Set(); // "metric:threshold" toasts already shown

	let panel, bottomBar, inlineExport, settings;
	let lastReconcileMs = 0;

	// Reset-aware snapshot built fresh on demand so countdowns are always current
	// at the moment a UI renders. CT.state.usageView holds the last snapshot for
	// any consumer that wants the cached value.
	CT.currentUsageView = () => CT.usage.buildView(CT.state.usage, { sessionStartedAt: CT.state.sessionStartedAt });
	function rebuildUsageView() {
		CT.state.usageView = CT.currentUsageView();
		return CT.state.usageView;
	}

	async function boot() {
		settings = await CT.storage.getSettings();
		CT.settingsRef = settings;

		// Restore a mid-session local-estimate start (dropped if already expired).
		CT.state.sessionStartedAt = await CT.storage.getSessionStart();
		if (Number.isFinite(CT.state.sessionStartedAt) && Date.now() - CT.state.sessionStartedAt >= CT.usage.SESSION_WINDOW_MS) {
			CT.state.sessionStartedAt = null;
			CT.storage.clearSessionStart();
		}

		panel = new CT.Panel({
			onRefresh: () => {
				refreshConversation();
				refreshUsage();
			},
			onSettingsChange: async (patch, full) => {
				settings = full;
				CT.settingsRef = full;
				await CT.storage.saveSettings(patch);
				CT.composer.setSettings(full);
				bottomBar.setSettings(full);
				inlineExport.setSettings(full);
				CT.a11y.applyAll();
			},
			// Keep CT.ui.panelOpen in sync so the strip + pill stay clear of the panel.
			onToggle: (open) => {
				CT.ui.panelOpen = open;
				bottomBar?.schedule();
				inlineExport?._schedule();
			}
		});
		panel.mount();
		panel.setSettings(settings);

		CT.composer.init(settings);

		bottomBar = new CT.BottomBar({ onOpenPanel: () => panel.setOpen(true) });
		bottomBar.mount(settings);

		inlineExport = new CT.InlineExport({ onOpenPanel: () => { panel.setOpen(true); panel.setTab('export'); } });
		inlineExport.mount(settings);

		// Attachments don't fire composer 'input' — observe them and recompute the
		// token chip + model suggestion when files are added/removed.
		if (CT.attachments) {
			CT.attachments.start();
			CT.attachments.onChange(() => {
				CT.composer.update();
				bottomBar._updateModel();
			});
		}

		applyTheme();
		new MutationObserver(applyTheme).observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'style', 'data-theme', 'data-mode']
		});

		const bridgeReady = CT.injectBridgeOnce();

		CT.bridge.on('ct:conversation', handleConversation);
		CT.bridge.on('ct:message_limit', (ml) => applyUsage(CT.usage.fromMessageLimit(ml)));
		CT.bridge.on('ct:generation_start', onGenerationStart);

		window.addEventListener('ct:urlchange', onUrlMaybeChanged);
		window.addEventListener('popstate', onUrlMaybeChanged);
		document.addEventListener('click', (e) => {
			if (e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]')) setTimeout(refreshConversation, 600);
		});

		// Global keyboard shortcuts.
		document.addEventListener(
			'keydown',
			(e) => {
				if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
				const k = e.key.toLowerCase();
				if (k === 'k') {
					e.preventDefault();
					e.stopPropagation();
					CT.tools.openLauncher(bottomBar.visible ? bottomBar.bar.getBoundingClientRect() : null);
				} else if (k === 'u') {
					e.preventDefault();
					e.stopPropagation();
					panel.setOpen(true);
					panel.setTab('overview');
				} else if (k === 'e') {
					e.preventDefault();
					e.stopPropagation();
					panel.setOpen(true);
					panel.setTab('export');
				}
			},
			true
		);

		await bridgeReady;
		await refreshConversation();
		if (!CT.state.usage) await refreshUsage();

		setInterval(tick, 1000);
	}

	function applyTheme() {
		try {
			CT.theme.dark = pageIsDark();
			CT.a11y.applyAll();
		} catch {
			/* ignore */
		}
	}

	async function refreshConversation() {
		currentConversationId = getConversationId();
		if (!currentConversationId) {
			CT.state.conversation = null;
			CT.state.map = { items: [], total: 0, max: 0, count: 0, cachedUntil: null };
			panel.setConversation(null);
			panel.setMap(CT.state.map);
			bottomBar.render();
			inlineExport._schedule();
			return;
		}
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		currentOrgId = orgId;
		try {
			await CT.bridge.requestConversation(orgId, currentConversationId);
		} catch {
			/* passive capture may still arrive */
		}
	}

	async function refreshUsage() {
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId || usageInFlight) return;
		currentOrgId = orgId;
		usageInFlight = true;
		try {
			const raw = await CT.bridge.requestUsage(orgId);
			applyUsage(CT.usage.fromUsageEndpoint(raw));
		} catch {
			/* ignore */
		} finally {
			usageInFlight = false;
		}
	}

	function applyUsage(normalized) {
		if (!normalized) return;
		CT.state.usage = normalized;
		lastUsageMs = Date.now();
		reconcileSessionStart();
		rebuildUsageView();
		panel.setUsage(normalized);
		bottomBar.render();
		checkWarnings();
	}

	// A message was sent → the rolling 5h session is (re)started. Record a local
	// start time as the estimate fallback, unless the API already knows an exact,
	// still-active session reset (exact always wins) or we're already inside an
	// estimated session.
	function onGenerationStart() {
		const five = CT.state.usage?.five_hour;
		const apiMs = five?.resets_at ? CT.time.toMs(five.resets_at) : null;
		const now = Date.now();
		if (apiMs != null && apiMs > now) return; // exact reset already known
		const existing = CT.state.sessionStartedAt;
		if (Number.isFinite(existing) && now - existing < CT.usage.SESSION_WINDOW_MS) return;
		CT.state.sessionStartedAt = now;
		CT.storage.setSessionStart(now);
		rebuildUsageView();
		bottomBar.render();
		panel.renderOverview();
	}

	// Clear the local estimate once the API gives an exact reset, reports the
	// session idle ("starts on send"), or the estimate window has elapsed.
	function reconcileSessionStart() {
		const s = CT.state.sessionStartedAt;
		if (!Number.isFinite(s)) return;
		const five = CT.state.usage?.five_hour;
		const apiMs = five?.resets_at ? CT.time.toMs(five.resets_at) : null;
		const now = Date.now();
		const exactKnown = apiMs != null && apiMs > now;
		const apiIdle = five && (five.utilization == null || five.utilization < 0.5);
		const expired = now - s >= CT.usage.SESSION_WINDOW_MS;
		if (exactKnown || apiIdle || expired) {
			CT.state.sessionStartedAt = null;
			CT.storage.clearSessionStart();
		}
	}

	function handleConversation({ orgId, conversationId, data }) {
		if (orgId) currentOrgId = orgId;
		const expected = getConversationId();
		if (expected && conversationId && conversationId !== expected) return;
		if (!data) return;
		CT.state.conversation = data;
		CT.state.map = CT.conversation.computeMap(data);
		panel.setConversation(data);
		panel.setMap(CT.state.map);
		bottomBar.render();
		inlineExport.refresh();
		inlineExport._schedule();
		checkWarnings();
	}

	// Usage warnings at 70/85/95, each fired once until the metric drops back.
	function checkWarnings() {
		if (settings.usageWarnings === false) return;
		const thresholds = [
			[70, settings.warningThreshold70 !== false],
			[85, settings.warningThreshold85 !== false],
			[95, settings.warningThreshold95 !== false]
		].filter(([, on]) => on).map(([t]) => t);
		if (!thresholds.length) return;

		const metrics = [];
		const map = CT.state.map;
		if (map?.count) metrics.push(['Context window', Math.min(100, (map.total / CT.CONST.CONTEXT_LIMIT_TOKENS) * 100)]);
		if (CT.state.usage?.five_hour) metrics.push(['Session (5h) usage', CT.state.usage.five_hour.utilization]);
		if (CT.state.usage?.seven_day) metrics.push(['Weekly (7d) usage', CT.state.usage.seven_day.utilization]);

		for (const [name, pct] of metrics) {
			for (const t of thresholds) {
				const key = `${name}:${t}`;
				if (pct >= t && !warned.has(key)) {
					warned.add(key);
					CT.model.toast(`${name} at ${Math.round(pct)}% — ${CT.usage.level(pct).label}`);
				}
				if (pct < t - 5) warned.delete(key);
			}
		}
	}

	let lastPath = window.location.pathname;
	function onUrlMaybeChanged() {
		const p = window.location.pathname;
		if (p === lastPath) return;
		lastPath = p;
		refreshConversation();
	}

	function tick() {
		panel.tick();
		bottomBar.tick();
		const now = Date.now();
		// Re-sync the local estimate + cached view roughly every 30s (countdown
		// labels move slowly; the per-second cache clock is handled in the UIs).
		if (now - lastReconcileMs >= 30000) {
			lastReconcileMs = now;
			reconcileSessionStart();
			rebuildUsageView();
		}
		for (const ms of [panel.usageResetMs.five, panel.usageResetMs.seven]) {
			if (ms && now >= ms && now - ms < 2000) refreshUsage();
		}
		if (!document.hidden && now - lastUsageMs > 3600000) refreshUsage();
	}

	boot();
})();
