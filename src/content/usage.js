(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

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
		return five || seven ? { five_hour: five, seven_day: seven } : null;
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
		return five || seven ? { five_hour: five, seven_day: seven } : null;
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

	CT.usage = { fromUsageEndpoint, fromMessageLimit, level };
})();
