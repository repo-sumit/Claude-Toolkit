(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

	// /usage endpoint: utilization already a percentage (0-100).
	function fromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;
		const win = (w, hours) => {
			if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			return {
				utilization: Math.max(0, Math.min(100, w.utilization)),
				resets_at: typeof w.resets_at === 'string' ? w.resets_at : null,
				window_hours: hours
			};
		};
		const five = win(raw.five_hour, 5);
		const seven = win(raw.seven_day, 24 * 7);
		const models = parseModels(raw, (w) => win(w, 24 * 7));
		return five || seven || models ? { five_hour: five, seven_day: seven, models } : null;
	}

	// SSE message_limit: utilization is a fraction (0-1); resets_at epoch sec.
	function fromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;
		const win = (w, hours) => {
			if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			return {
				utilization: Math.max(0, Math.min(100, w.utilization * 100)),
				resets_at: typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? new Date(w.resets_at * 1000).toISOString() : null,
				window_hours: hours
			};
		};
		const five = win(raw.windows['5h'], 5);
		const seven = win(raw.windows['7d'], 24 * 7);
		return five || seven ? { five_hour: five, seven_day: seven, models: null } : null;
	}

	// Best-effort, tolerant extraction of any per-model weekly breakdown the
	// endpoint might expose (e.g. a `models`/`per_model` map or array of
	// `{name, utilization, resets_at}`). Returns null when none is present — the
	// /usage endpoint the extension reads does NOT currently include this, so
	// model-specific reset data only appears on Claude's own usage page. Written
	// defensively so it lights up automatically if the API later adds it.
	function parseModels(raw, normalize) {
		const src = raw.models || raw.per_model || raw.seven_day?.per_model;
		if (!src || typeof src !== 'object') return null;
		const entries = Array.isArray(src) ? src.map((m) => [m?.name || m?.model || m?.key, m]) : Object.entries(src);
		const out = {};
		for (const [name, m] of entries) {
			if (!name || !m || typeof m.utilization !== 'number') continue;
			const w = normalize(m);
			if (w) out[String(name).toLowerCase()] = w;
		}
		return Object.keys(out).length ? out : null;
	}

	// Threshold labels used everywhere (bars, bar pills, overview, warnings).
	// <70 Healthy · 70-84 Moderate · 85-94 High · ≥95 Near limit
	function level(pct) {
		if (pct == null || !Number.isFinite(pct)) return null;
		if (pct < 70) return { key: 'healthy', label: 'Healthy' };
		if (pct < 85) return { key: 'moderate', label: 'Moderate' };
		if (pct < 95) return { key: 'high', label: 'High' };
		return { key: 'critical', label: 'Near limit' };
	}

	// ---- derived reset-timer view ------------------------------------------
	// Turns the normalized usage windows into the reset-aware shape the UI
	// renders. Source/confidence are honest about where each reset time came
	// from so the UI never shows a fake countdown.

	function pct(w) {
		return w && Number.isFinite(w.utilization) ? w.utilization : null;
	}

	// Rolling 5-hour "session". Prefers the exact API reset timestamp; falls back
	// to a local estimate (sessionStartedAt + 5h) only when a message was sent
	// but no API reset is known yet; otherwise reports "not started".
	function deriveSession(usage, opts = {}) {
		const now = opts.now ?? Date.now();
		const w = usage?.five_hour || null;
		const out = {
			percent: pct(w),
			status: 'unknown',
			resetAt: null,
			resetLabel: null,
			resetCountdown: null,
			source: 'unknown',
			confidence: 'unknown'
		};

		// 1) Exact reset from the usage API / message_limit stream.
		const apiMs = w?.resets_at ? CT.time.toMs(w.resets_at) : null;
		if (apiMs != null && apiMs > now) {
			out.status = 'active';
			out.resetAt = new Date(apiMs);
			out.resetCountdown = CT.time.formatCountdown(apiMs, now);
			out.resetLabel = `Resets in ${out.resetCountdown}`;
			out.source = 'claude-usage-api';
			out.confidence = 'exact';
			return out;
		}

		// 2) Local estimate — a message was sent but the API hasn't surfaced an
		//    active session window yet (brief gap, or SSE missed).
		const startedAt = Number.isFinite(opts.sessionStartedAt) ? opts.sessionStartedAt : null;
		if (startedAt != null) {
			const est = startedAt + SESSION_WINDOW_MS;
			if (est > now) {
				out.status = 'active';
				out.resetAt = new Date(est);
				out.resetCountdown = CT.time.formatCountdown(est, now);
				out.resetLabel = `Resets ~${out.resetCountdown}`;
				out.source = 'local-estimate';
				out.confidence = 'estimated';
				return out;
			}
		}

		// 3) Usage loaded and the session is idle → it starts on the next send.
		if (usage && (out.percent == null || out.percent < 0.5)) {
			out.status = 'not_started';
			out.resetLabel = 'Starts when a message is sent';
			out.source = w ? 'claude-usage-api' : 'unknown';
			out.confidence = w ? 'exact' : 'unknown';
			return out;
		}

		// 4) Have utilization but no reset time and no estimate.
		if (out.percent != null) {
			out.status = 'active';
			out.source = 'claude-usage-api';
			out.confidence = 'visible-only';
		}
		return out;
	}

	// Rolling 7-day "weekly" window. Always exact when the API provides resets_at.
	function deriveWeekly(usage, opts = {}) {
		const now = opts.now ?? Date.now();
		const w = usage?.seven_day || null;
		const out = { percent: pct(w), resetAt: null, resetLabel: null, resetCountdown: null, source: 'unknown', confidence: 'unknown' };
		const ms = w?.resets_at ? CT.time.toMs(w.resets_at) : null;
		if (ms != null) {
			out.resetAt = new Date(ms);
			out.resetCountdown = CT.time.formatCountdown(ms, now);
			out.resetLabel = CT.time.formatResetLabel(ms); // "Sun 1:30 PM"
			out.source = 'claude-usage-api';
			out.confidence = 'exact';
		}
		return out;
	}

	function deriveModels(usage, opts = {}) {
		const now = opts.now ?? Date.now();
		const models = usage?.models;
		if (!models || typeof models !== 'object') return {};
		const out = {};
		for (const [name, w] of Object.entries(models)) {
			const ms = w?.resets_at ? CT.time.toMs(w.resets_at) : null;
			out[name] = {
				percent: pct(w),
				resetAt: ms != null ? new Date(ms) : null,
				resetLabel: ms != null ? CT.time.formatResetLabel(ms) : null,
				resetCountdown: ms != null ? CT.time.formatCountdown(ms, now) : null,
				source: ms != null ? 'claude-usage-api' : 'unknown',
				confidence: ms != null ? 'exact' : 'unknown'
			};
		}
		return out;
	}

	// Full reset-aware snapshot matching the documented usage state shape.
	function buildView(usage, opts = {}) {
		const now = opts.now ?? Date.now();
		return {
			session: deriveSession(usage, opts),
			weekly: deriveWeekly(usage, opts),
			models: deriveModels(usage, opts),
			lastUpdated: new Date(now)
		};
	}

	CT.usage = { fromUsageEndpoint, fromMessageLimit, level, deriveSession, deriveWeekly, deriveModels, buildView, SESSION_WINDOW_MS };
})();
