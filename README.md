# Brain-Rot Rescue

Brain-Rot Rescue is a Chrome extension that diverts doom-scroll impulses back into intentional reading. When you try to open a site on your blocklist, the extension now routes you to its main dashboard with override controls and your Reading List surfaced. If the list is empty, the dashboard shows an empty-state nudge and you can still trigger an override.

## Feature highlights

- **Smart interception** – Blocked domains are detected via `chrome.webNavigation` and redirected to the dashboard, which shows the threat context plus your Reading List and tasks.
- **Dashboard override** – The hero card includes a hold-to-override button that grants a 15-minute cooldown for the blocked domain and returns you to the original URL.
- **Reading List surface** – Open or clear saved items directly from the dashboard; it pulls from Chrome's native Reading List.
- **Empty-list fallback** – When no unread items exist, the dashboard shows a calm empty state; the standalone focus page remains available as a backup.
- **Actionable popup** – Manage the blocklist, flip the global on/off switch, view active overrides, and one-tap “Add current tab to Reading List” without leaving the toolbar.

## Install & run locally

1. Clone or copy this directory to your machine.
2. In Chrome, open `chrome://extensions`, toggle on **Developer mode**, and choose **Load unpacked**.
3. Select the project folder and confirm the Brain-Rot Rescue card appears.
4. Pin the extension icon for quick access.

> **Note:** The extension relies on Chrome's `readingList` permission. It must be installed in a Chromium build that supports the API (Chrome 115+ on desktop).

## Using the extension

1. Open the popup and ensure the guard is **Active**.
2. Add or remove blocked domains as needed. Inputs normalize to bare hostnames (e.g. `twitter.com`).
3. Use **Add current tab** whenever you find an article worth revisiting – it lands in the Chrome Reading List immediately.
4. When you visit a blocked site, you'll land on the dashboard with an override card and your Reading List. Open something intentional or hold to reach the original site.
5. If the Reading List is empty, the dashboard shows an empty state; you can still hold to override. Overrides snooze that domain for 15 minutes.

## Manual test checklist

- Blocked navigation → lands on `dashboard.html` with the override card populated (not an auto-loaded article).
- Override behavior → Holding the override button returns to the original URL and starts a 15-minute cooldown for that domain.
- Reading List → Dashboard shows unread items; **[OPEN]** loads them in the same tab and **X** marks them read.
- Empty Reading List → Dashboard shows the empty-state messaging; override remains available.
- New tab override → Opening a blank tab still loads `dashboard.html`; blocked site interceptions keep using the dashboard flow.

## Project structure

```
manifest.json          # MV3 manifest (service worker background, content script, popup)
background.js          # Routing logic, storage, reading list orchestration, messaging
content/overlay.js     # In-page overlay widget + styles (used when an article is opened via the extension)
focus/                 # Empty-list fallback page (HTML/CSS/JS)
popup/                 # Toolbar popup UI (HTML/CSS/JS)
icons/                 # Simple vector-style PNG icons
README.md              # This file
```

The codebase is pure JavaScript/CSS/HTML so you can edit and reload immediately—no bundler needed. Run `chrome://extensions` → **Reload** after making changes.

## Ideas & next steps

- Sync overrides across devices (`chrome.storage.sync`): mirror the cooldown map with expirations, resolve conflicts by freshest `expiresAt`, and gate writes behind a simple version field to avoid clobbering active sessions.
- Per-domain schedules: allow optional quiet-hours windows per blocked host; during those windows treat the host as blocked, otherwise honor local cooldowns and skip intercepts.
- Streak tracking: reuse block event data to compute per-day streaks (consecutive days with ≥1 successful swap), persist lightweight counters locally, and surface them in the dashboard without sending any telemetry.
