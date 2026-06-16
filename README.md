# Claude Toolkit

A native-feeling productivity layer for `claude.ai`, in one extension. Everything
runs locally — it reads Claude's *own* API traffic in your browser, keeps settings
in local browser storage, and sends nothing anywhere.

## What's inside (v0.6 — Claude-native redesign)

This release implements the **Claude Toolkit Redesign** handoff from Claude
Design: a warm, claude.ai-native dark shell (`#262624`/`#211f1d`/`#2a2926`
surfaces, terracotta `#d97757` accent, green→amber→red usage levels) expressed
as a namespaced token system in `src/styles.css`. The floating edge "TOOLS" tab
is gone — the panel now opens from the strip; the model suggestion is a
clickable **pill** (accent star + tier) you can apply in one click; Settings use
iOS-style **toggle switches**; the Overview gains a **Model advisor** card; and
the Quick Tools launcher has a keyboard-hint footer. All chrome is SVG (no
emoji), light/dark both supported.


**Composer status strip, docked into the input card.** A slim status line is
inserted into Claude's own layout *right below the composer card* (after the
`chat-input-grid-container`), so it reads as part of the input and — because it
lives in the normal document flow rather than as a floating overlay — it can
**never cover** the attachment button, model selector, effort selector, mic, or
send button. It shows `Session %` and `Weekly %` with thin progress rails + reset
times, `Ctx %`, an active-only cache countdown, and a suggested model, plus one
**Tools** icon and one **panel** icon. It's responsive to its own width: full
labels when wide, Session/Weekly + model when medium, abbreviated when narrow,
rails dropped when tight. Click the usage area for a compact details popover
(thin bars, Healthy/Moderate/High/Near-limit, reset timers, brief explanations,
and the model rationale).

**Export on the latest reply only.** A subtle **Export** action sits in the
footer/action-row cluster of the **bottom-most Claude reply** — styled like
Claude's own reply actions (SVG icon, quiet hover, matching spacing). It is never
attached to user messages, never shown on older replies, and there's no floating
button anywhere. As new replies stream in, the single action moves to the new
latest reply (no duplicates) and re-attaches if the DOM re-renders. Click it for
**Copy Markdown / Download Markdown / Download JSON / Print / Save PDF**.

**Lightweight reply metadata.** Next to that Export action, an understated token
estimate for the latest reply (e.g. `≈1.2k tokens`) means you can read basic chat
state without opening the Map. The Map remains the deeper view.

**Chat Map with timestamps.** The Map tab lists every message on the active
branch as a token heatmap; each row shows the **time it was sent**, with the token
count as a muted secondary value. Click a row to jump to that message.

**Quick Tools** — 20 local tools (`src/content/tools.js`) that turn your selection
or draft into a high-quality prompt and insert it. One **Tools** trigger (or
`Ctrl/Cmd+Shift+K`) opens a searchable popover with a **Popular** section,
category grouping, and full keyboard nav (↑/↓ to move, Enter to run, Esc to
close). Nothing else clutters the strip.

**Prompt palette** — type `/` in the composer: categories, search, and a fill-in
form for `{{placeholders}}`. The Prompts tab adds duplicate, import/export JSON,
reset, and five installable packs.

**Side panel** — Overview, Map, Tools, Prompts, Export, Settings.

**Model advisor** — a multi-signal engine (`src/content/model.js`) weighs draft
length, context usage, attachments, code, and intent to recommend **Haiku /
Sonnet / Opus**, returning `{ tier, confidence, reason, signals,
detectedAvailableModelName }`. It picks **Haiku** confidently for lightweight
writing/summarizing/formatting, **Sonnet** for balanced product/code/analysis
work, and **Opus** only for genuinely complex, high-stakes tasks. The visible
label stays compact; the rationale shows on hover and in the usage popover.

## Design language

SVG icons throughout (stroke icons on a 24-grid, `currentColor`), quiet hover
states, minimal borders, soft contrast. Light vs dark is chosen by **measuring
the page's background luminance** at runtime (`.ct-dark`) — never by reusing
claude.ai's CSS channel variables — so surfaces stay opaque and legible in both
themes.

## Popovers (single-active)

Opening one popover closes any other; close is synchronous (the DOM is removed
immediately — no animation gate); the × fires on `mousedown`; a capture-phase
handler closes on outside-click or Escape; re-clicking a trigger toggles it. The
side panel becomes non-interactive the instant it starts closing.

## Keyboard shortcuts

- `/` at the start of the composer → prompt palette
- `Ctrl/Cmd+Shift+K` → Quick Tools · `+U` → Overview · `+E` → Export
- `Esc` closes any popover, the palette, or the panel
- Panel tabs: `←`/`→`; tool launcher: `↑`/`↓` + Enter

## Settings

Show bottom strip · Compact labels · Show model suggestion · Show cache countdown
· Inline export button · Show reply metadata · Quick Tools · Slash palette · Model
advisor chip · Auto-apply model (experimental) · usage-warning thresholds · Reduce
motion · High contrast. All persist locally.

## Accessibility

Aria-labels on every icon control; `aria-expanded`/`aria-controls` on popover
triggers; `role="dialog"`; focus trap + restoration; Escape + outside-click close;
visible focus rings; level *labels* (never color alone); a polite live region for
toasts; ~28–36px targets; `prefers-reduced-motion` honored (or forced); a
high-contrast mode.

## Install (unpacked)

**Chrome / Edge / Brave** — `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select this folder. If it's already loaded, hit reload (↻).

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on…** → pick `manifest.json` (temporary until restart).

Then open any `claude.ai` chat.

## Fragile selectors to monitor

All in `src/content/constants.js → CT.SEL`, tried in order with graceful
fallback: `COMPOSER_GRID` (where the strip docks), `ASSISTANT` (latest-reply
anchor for Export + metadata), `TURNS` (Map jump targets), `COMPOSER` (draft
metering, palette, insertion), `MODEL_TRIGGER` / `MENU_ITEM` (model Apply + name
detection — most fragile; auto-apply is off by default), and `ATTACHMENT` (a
model-suggestion signal only).

## Privacy

All processing is local. No external servers, analytics, tracking, or remote code.
The fetch bridge **reads passively** and never mutates claude.ai requests. Token
counting uses a bundled tokenizer.

## Credits & license

Token counting via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer)
(MIT — see THIRD_PARTY_NOTICES.md). MIT licensed.
