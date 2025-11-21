# Repository Guidelines

## Project Structure & Module Organization
- `manifest.json` (MV3) wires the background service worker, popup, content script, web-accessible resources, and permissions.
- `background.js` owns routing, blocklist/cooldown state, and Reading List selection; keep it the single source of truth.
- `content/overlay.js` + `overlay.css` render the in-page overlay shown on redirected articles.
- `focus/` is the empty-list fallback page; `popup/` is the toolbar UI; `shared/hold-to-override.js` is the shared hold-to-act helper; `icons/` and `assets/` house static art.

## Build, Test, and Development Commands
- No build step or npm stack; edit files directly.
- Load locally: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → repo root.
- After edits, hit **Reload** on the extension card. Check DevTools: content logs in the active tab; background/service-worker logs from the extension detail view.

## Coding Style & Naming Conventions
- JavaScript: ES2022 modules, 2-space indent, `const` by default, early returns, async/await over promise chains, semicolons on statements.
- Naming: camelCase for locals/functions; UPPER_SNAKE_CASE for shared constants (e.g., `DEFAULT_BLOCKLIST`). Keep helper names descriptive.
- CSS: scope rules to overlay/focus, prefer classes, keep shared values in custom properties. Avoid inline styles unless necessary for dynamic updates.
- JSON: manifest must stay valid—no trailing commas.

## Testing Guidelines
- Manual test checklist (no automated tests yet):
  - Visit a blocked domain → expect redirect to a Reading List item with overlay controls.
  - Use **Mark as read** → item disappears from Reading List.
  - Use **Load next** → rotates to a different unread item; no duplicate tab pairing.
  - Empty Reading List → focus page appears; hold-to-override requires the full duration (default 5s).
  - After a successful override, revisit within 15 minutes → domain should be allowed until cooldown expires.

## Commit & Pull Request Guidelines
- Use Conventional Commit prefixes (`feat`, `fix`, `chore`, `docs`, `refactor`, `style`, `test`) in imperative mood (e.g., `feat: add overlay cooldown badge`).
- PRs: summarize behavior change, attach screenshots/GIFs for popup/overlay/focus tweaks, list which manual checks you ran, and link issues if applicable.
- Keep diffs focused; call out refactors with “no user-visible change” when true.

## Security & Configuration Tips
- Keep permissions minimal; justify any additions in the manifest and PR notes.
- Avoid `eval` and remote scripts; ship assets locally.
- Confirm changes on Chrome 115+ where `readingList` exists; after manifest edits, reload and check both overlay and focus flows.
