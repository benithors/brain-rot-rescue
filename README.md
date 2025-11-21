# Brain-Rot Rescue

Brain-Rot Rescue is a Chrome extension that diverts doom-scroll impulses back into intentional reading. When you try to open a site on your blocklist, the extension instantly swaps in an unread item from Chrome's native Reading List. If the list is empty, it shows a gentle fallback screen with breathing room and the option to override.

## Feature highlights

- **Smart interception** – Blocked domains are detected via `chrome.webNavigation` and redirected to the oldest unread Reading List entry. Items currently displayed in other tabs are skipped so you never see the same article twice simultaneously.
- **Overlay widget** – Articles open with a compact overlay that lets you mark the item as read (removes it from the Reading List), load a different saved piece, or hold for 5 seconds to reach the original site.
- **Override cool-down** – Successful overrides pause blocking for that domain for 15 minutes, so the site stays reachable while you complete the task at hand.
- **Empty-list fallback** – When no unread items exist, the custom focus page explains what happened, nudges you to save more, and exposes the same hold-to-override control.
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
4. When you visit a blocked site:
   - If unread entries exist, you'll land on one with the overlay widget.
   - If the list is empty, you'll see the focus page.
5. Mark items as read when finished to prune the list, or hold the override button for 5 seconds if you truly need the destination. Overrides snooze that domain for 15 minutes.

## Project structure

```
manifest.json          # MV3 manifest (service worker background, content script, popup)
background.js          # Routing logic, storage, reading list orchestration, messaging
content/overlay.js     # In-page overlay widget + styles
focus/                 # Empty-list fallback page (HTML/CSS/JS)
popup/                 # Toolbar popup UI (HTML/CSS/JS)
icons/                 # Simple vector-style PNG icons
README.md              # This file
```

The codebase is pure JavaScript/CSS/HTML so you can edit and reload immediately—no bundler needed. Run `chrome://extensions` → **Reload** after making changes.

## Ideas & next steps

- Auto-sync overrides across devices via `chrome.storage.sync` if you bounce between machines.
- Optional focus durations per domain or schedule-based rules.
- Analytics-free streak tracking to visualize how often you convert distractions into intentional reading.
