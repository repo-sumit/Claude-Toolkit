(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	const MIN = 60000;
	const HOUR = 60 * MIN;
	const DAY = 24 * HOUR;
	// First three letters of a weekday → JS getDay() index (Sun = 0).
	const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

	// Accepts a Date, an epoch-ms number, or an ISO string and returns epoch ms
	// (or null). Lets every helper take whichever form the caller already has.
	function toMs(v) {
		if (v == null) return null;
		if (v instanceof Date) {
			const t = v.getTime();
			return Number.isFinite(t) ? t : null;
		}
		if (typeof v === 'number') return Number.isFinite(v) ? v : null;
		if (typeof v === 'string') {
			const t = Date.parse(v);
			return Number.isFinite(t) ? t : null;
		}
		return null;
	}

	// Compact, low-noise countdown. Never shows seconds (callers refresh it on a
	// 30–60s cadence, not per-second).
	//   < 1 min      → "1m" (floor at 1 so an imminent reset never reads "0m")
	//   < 1 hour     → "23m"
	//   1–23 hours   → "4h 59m" / "6h"            (minutes zero-padded)
	//   1+ days      → "3d 4h" / "6d"
	//   expired/past → "now"
	function formatCountdown(resetAt, now = Date.now()) {
		const ms = toMs(resetAt);
		if (ms == null) return null;
		const nowMs = toMs(now) ?? Date.now();
		const diff = ms - nowMs;
		if (diff <= 0) return 'now';
		// Work entirely in rounded total-minutes so carries (59.7m → 1h, 23h59.7m
		// → 1d) never produce "0h 60m" or "24h" artifacts.
		const mins = Math.max(1, Math.round(diff / MIN));
		if (mins < 60) return `${mins}m`;
		const hrs = Math.floor(mins / 60);
		const remM = mins % 60;
		if (hrs < 24) return remM ? `${hrs}h ${String(remM).padStart(2, '0')}m` : `${hrs}h`;
		const days = Math.floor(hrs / 24);
		const remH = hrs % 24;
		return remH ? `${days}d ${remH}h` : `${days}d`;
	}

	// Short absolute label in the user's locale/timezone: "Sun 1:30 PM".
	function formatResetLabel(resetAt) {
		const ms = toMs(resetAt);
		if (ms == null) return null;
		const d = new Date(ms);
		const day = d.toLocaleDateString([], { weekday: 'short' });
		const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		return `${day} ${time}`;
	}

	// Sum a relative phrase like "3d 4h", "1h 45m", "45m", "2h" into ms. Returns
	// null when no <number><unit> token is present (so "Sun 1:30 PM" falls
	// through to the day/time parser — "PM" never matches the minute unit).
	function parseRelative(s) {
		const re = /(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi;
		let m;
		let total = 0;
		let found = false;
		while ((m = re.exec(s))) {
			found = true;
			const n = parseInt(m[1], 10);
			const unit = m[2][0].toLowerCase();
			total += unit === 'd' ? n * DAY : unit === 'h' ? n * HOUR : n * MIN;
		}
		return found ? total : null;
	}

	// Resolve an optional weekday + clock time ("Sun 1:30 PM", "1:30 PM") to the
	// next upcoming occurrence in LOCAL time. A weekday/time already past this
	// week rolls to next week; a bare time already past today rolls to tomorrow.
	function parseDayTime(s, nowMs) {
		const re = /^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
		const m = s.match(re);
		if (!m) return null;
		const dayKey = m[1] ? m[1].slice(0, 3).toLowerCase() : null;
		let hour = parseInt(m[2], 10);
		const min = m[3] ? parseInt(m[3], 10) : 0;
		const ap = m[4] ? m[4].toLowerCase() : null;
		if (ap === 'pm' && hour < 12) hour += 12;
		if (ap === 'am' && hour === 12) hour = 0;
		if (hour > 23 || min > 59) return null;

		const now = new Date(nowMs);
		const target = new Date(nowMs);
		target.setHours(hour, min, 0, 0);
		if (dayKey != null && DOW[dayKey] != null) {
			let delta = (DOW[dayKey] - now.getDay() + 7) % 7;
			if (delta === 0 && target.getTime() <= nowMs) delta = 7; // same weekday, already passed
			target.setDate(target.getDate() + delta);
		} else if (target.getTime() <= nowMs) {
			target.setDate(target.getDate() + 1); // bare time already passed today
		}
		return target.getTime();
	}

	// Parse a human reset label into a usable shape. confidence reflects how much
	// we can trust the result — a relative phrase is only as exact as the moment
	// it was read ("estimated"); a day/time label parsed from visible UI is
	// "visible-only"; an unparseable label is preserved verbatim for display.
	function parseResetLabel(label, now = new Date()) {
		const raw = String(label == null ? '' : label).trim();
		const out = { resetAt: null, countdown: null, label: raw, confidence: 'unknown' };
		if (!raw) return out;
		const nowMs = toMs(now) ?? Date.now();
		const text = raw.replace(/^resets?\s+(in\s+)?/i, '').trim();

		const rel = parseRelative(text);
		if (rel != null) {
			out.resetAt = new Date(nowMs + rel);
			out.countdown = formatCountdown(out.resetAt, nowMs);
			out.confidence = 'estimated';
			return out;
		}

		const dt = parseDayTime(text, nowMs);
		if (dt != null) {
			out.resetAt = new Date(dt);
			out.countdown = formatCountdown(out.resetAt, nowMs);
			out.confidence = 'visible-only';
			return out;
		}

		out.confidence = 'visible-only';
		return out;
	}

	CT.time = { toMs, formatCountdown, formatResetLabel, parseResetLabel, parseRelative, parseDayTime };

	// Upgrade the legacy formatter in place so every existing caller
	// (bottom-bar, panel) that captured CT.u.fmtCountdown picks up the new rules.
	// time-utils.js loads before those modules, so their destructure sees this.
	if (CT.u) CT.u.fmtCountdown = (ms) => formatCountdown(ms);
})();
