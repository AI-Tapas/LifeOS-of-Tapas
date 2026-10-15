# UI, privacy and sign-in implementation notes

Implemented on 15 October 2026 following the Astra review. This is a handoff for Claude and future maintainers. The changes address review findings S5, S6, U1, U2 and the login portion of U4, plus the owner calendar confirmation UI for S2 and connection permission visibility for S4.

## Private offline data policy

The previous service worker persisted authenticated document and RSC responses under origin-wide cache keys. Removing auth cookies or signing out did not remove those pages. `public/sw.js` now persists only the public offline shell, icons and static build assets. Documents and RSC are network-only; failed document navigation returns the public offline page. The v5 worker deletes legacy Life OS caches on activation and navigation and never reads those caches, including entries recreated by an older worker's delayed request. It does not delete unrelated caches on the same origin.

Private offline access is deliberately disabled. This changes previous product behavior; Settings and the offline page explain it. A future opt-in implementation must partition data by authenticated session, revoke access on logout, control in-flight writes, and define device-lock/encryption guarantees before restoring private offline reading. Do not reintroduce generic `cache.put(request, response)` for HTML or RSC.

Sign-out checks the Auth result, purges legacy private caches, signals other tabs, and replaces the document with the login page so Next's in-memory router state is discarded. Other tabs respond to both Auth's signed-out event and the local sign-out signal. A restored back-forward-cache page also checks whether logout occurred after it was loaded. The public shell remains available. An offline browser running the old deployed worker must reconnect to receive the update; new code cannot remotely change a worker that has not downloaded it.

## Accessible drawers and visible controls

`components/ui.tsx` uses native modal `dialog.showModal()` with a named title. The browser makes the background inert and contains keyboard navigation; Escape and backdrop/Close dismissal close the drawer, and focus returns to the original control. The shared component preserves unsaved inputs unless the owner explicitly accepts a discard prompt. Explicit form Cancel actions remain intentional cancellation. Scrolling the document is locked while the drawer is open.

Calendar agenda buttons now sit in list items, small calendar labels use the secondary text color, and the calendar-hours and month-expenses scroll regions have names and keyboard focus. The own-cost badge and inactive bottom navigation labels use higher-contrast text. These changes preserve the existing layout and themes.

## Safe sign-in recovery

`lib/auth/safe-redirect.ts` is shared by the login client and magic-link callback. It accepts app-relative paths only and rejects external/protocol-relative destinations, backslashes and control characters. The callback retains a validated destination when a link fails. Login explains expired/used links, announces errors, provides a fresh-code path, distinguishes an unavailable service from an unauthorised address, and clears busy state after rejected network promises. Client allowlist messaging is convenience only; the database allowlist remains the authorization boundary.

## Calendar and connection integration

The calendar delete action defaults `confirmed` to false. The detail view sends true only after the second owner click, with explicit permanent-delete and guest-cancellation copy and a Cancel option. Guest edit confirmation covers updates/cancellations as well as invitations. Editing any field resets pending confirmation; the form is disabled while a provider request is pending. An explicitly emptied attendee field sends an empty array so confirmed guest removal is distinct from omitted attendee information. The event-writer agent owns the independent server/provider checks; the UI alone is not the security boundary.

Settings excludes revoked client tombstones, shows granted capabilities and mailbox/work-stream restrictions, and labels unapproved legacy connections as paused until fresh consent. Financial read-only grants are described as read-only. Changing capabilities requires disconnecting and reconnecting from the client application; the OAuth and MCP agents own permission enforcement and the consent flow.

## Reproducible validation

- `node --test scripts/review-ui-security.test.ts`: pure redirect adversarial cases plus the actual worker executed with synthetic CacheStorage/fetch. It verifies legacy cleanup, preserving unrelated caches, never storing private HTML/RSC, public offline fallback and an in-flight private request completing after purge.
- `scripts/review-ui-browser.cjs`: optional Playwright and axe fixture test. Install Playwright and `@axe-core/playwright` outside the repository or expose them through `NODE_PATH`. Set `CHROMIUM_EXECUTABLE` when using a system browser and `REVIEW_BASE_URL` if not using localhost:3000. The test covers modal keyboard behavior/dirty dismissal, light/dark contrast and semantics at 320/390/1280px, legacy cache purge, cross-tab sign-out signaling, offline shell and login error feedback. It excludes only the development preview's yellow section-marker paragraphs from contrast checks. Theme transitions are allowed to finish before contrast is sampled.

These checks use synthetic fixtures. They do not verify real OTP/passkeys, authenticated production logout, browser restart, assistive technology speech, or live Google/Microsoft guest notifications. Those require the separate signed-in integration checks in the main handoff.

Validation completed in this workspace: both security unit tests passed; the browser script passed all listed checks, including the six theme/viewport combinations, real service-worker offline fallback and a second tab's full navigation after the sign-out signal. Scoped ESLint passed. TypeScript checks found no UI errors; cross-agent integration is recorded by the orchestrator. The cross-tab test emits a synthetic logout signal rather than authenticating a real account.
