# Publication security review — October 21, 2026

## Changes implemented

- Launches restricted to the top-level `https://recon.amngtpro.com` page in both
  the content bridge and the worker. The bridge also verifies message source.
- Content script no longer installed on every website; unused Beeceptor host
  permission removed. Existing Amazon and AMP hosts, scripting, tabs, and
  debugger permissions retained for compatibility.
- Request fields validated before navigation. Only HTTPS Amazon URLs for the
  four supported flows, matching dates, and matching service areas are accepted.
  Loaded pages are rechecked; failed redirects no longer fall through to extraction.
- API credential retained in the worker and sent in the existing Bearer header.
  Sensitive console output and persistent-in-document diagnostic snapshots removed.
- Manual toolbar extraction handler and hardcoded test configuration removed.
  The icon's title directs users to start a sync in AMP.
- User-selected 150-driver maximum retained. Rosters above that limit fail
  before submission instead of silently dropping entries.
- Non-DA single submissions now reject unsuccessful HTTP responses.
- Duplicate starts suppressed; separate concurrent runs refused. Tab loading
  bounded to 90 seconds; HTTP requests/body reads bounded to 60 seconds.
- Manifest description added. Existing DA extraction selectors, background
  rendering, normal request bodies, completion messages, and rate-limit retry
  policy retained.

## Remaining findings and release checks

### High: 10-minute token versus extraction duration

150 drivers require at least `(150 - 1) * 5 = 745` seconds (12 minutes 25 seconds)
of inter-driver spacing, excluding extraction, network time, and retries.
The app's fixed 10-minute token can expire during a valid run. The extension
currently has no agreed renewal protocol and cannot renew or extend a signed
credential itself. Existing per-driver failures will report rejected requests.
Resolve this in the app/backend with authorized renewal scoped to the same run,
or a bounded lifetime based on measured run duration. Preserve rate-limit spacing.

### Backend authorization is outside this repository

Short-lived tokens protect API ingestion when the server correctly verifies
them. They do not authorize websites to command the extension; the new origin
checks provide that separate boundary. Existing Amazon login is a prerequisite,
not protection against misuse of that logged-in session.

Verify signature, expiry, issuer/audience or equivalent purpose, company,
service area, period/date and run binding; data access rules; idempotent writes;
and safe error responses against actual backend code. `test.json` contains
integration notes, not the backend implementation, and its older one-hour token
description is superseded by the user's current 10-minute lifetime information.
Origin checks do not protect against scripts compromised within the trusted app.

### Store disclosures and packaging remain necessary

Provide a public privacy policy, accurate data-use/recipient disclosures and
consent, retention/deletion information, support contact, sanitized screenshots,
and reviewer instructions covering AMP and Amazon login prerequisites. The
extension transmits personal driver, schedule, and delivery-address data to AMP;
it is not local-only processing. Actual downstream processors and retention
cannot be inferred from this repository.

Explain the debugger permission's background-rendering purpose and visible
Chrome banner. Keep it while this implementation depends on it. Evaluate
removing `tabs` separately with browser testing of navigation and app reloads.
Choose and test a minimum Chrome version before publication.

Package only `manifest.json`, `background.js`, `content.js`, `extract.png`, and
`flows/*.js`, with the manifest at ZIP root. Exclude `.git`, tests, docs and
`test.json` from the store package while retaining them in source control.

### Runtime limitations to verify before release

- Run a controlled authenticated DA sync after reloading both extension and app;
  verify actual Amazon redirects against the approved paths and data totals.
- Exercise a run longer than 10 minutes once token handling is resolved.
- Confirm AMP handles partial results, failed authentication and interrupted runs.
- Active runs live in worker memory. Browser/extension restarts can interrupt
  them; persistent resume is not implemented. Bounded individual waits do not
  constitute a complete crash-recovery or overall-run deadline mechanism.
- Non-DA DOM extraction still has limited automated coverage. Missing page
  sections can produce empty records, and weekly popup mismatches only warn.
  Validate these flows against the live UI before advertising them as supported.
- DA tabs still remain open by default, preserving current behavior.

## Validation

Run `node --test tests/*.test.mjs`. Coverage includes the previous 48 tests plus
origin/frame authorization, malformed payloads, URL redirects, tab timeouts and
closure, duplicate starts, non-DA rejection handling, credential/log isolation,
network abort, and 150/151-driver roster boundaries. Tests use isolated mocks;
no production extraction or API ingestion was performed for this review.

## Chrome references

- [Extension security](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)
- [Minimum permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions)
- [Privacy policy](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- [Disclosure requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Preparing a release](https://developer.chrome.com/docs/webstore/prepare)
