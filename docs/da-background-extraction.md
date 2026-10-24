# DA extraction while the app tab stays active

The user must already be signed in to Amazon Logistics. The extension does not
provide login. Start extraction from the top-level page at
`https://recon.amngtpro.com`; the toolbar icon does not start extraction.

The DA flow opens an inactive blank tab, attaches Chrome's debugger transport,
enables `Emulation.setFocusEmulationEnabled`, and then navigates to Amazon.
This allows visibility-dependent rendering to run without activating the Amazon
tab. Per-driver extraction, API requests, retries, and completion notifications
use the existing flow. Other extraction flows do not attach the debugger.

Reload the extension after installing this change. The manifest now includes
the `debugger` permission; Chrome may require approval of the changed permissions.

Chrome displays its debugging notification while extraction runs. This method
avoids switching focus, but is not completely invisible. Do not cancel that
session or open DevTools on the extraction tab during a run, since that can
interrupt it. Emulation is disabled and the session is detached when the run
finishes or throws, including when `closeTab: false` leaves the tab open.
If startup fails, the existing flow-level failure notification reports the error.

After the last driver attempt, the page explicitly hands its final summary to the
worker. Either that handoff or the original script return can finish the date;
they share one notification callback. Final-result delivery to the app's content
script has three attempts, each with a five-second acknowledgment timeout.
Retries share a notification ID to avoid posting duplicate events to the same
document. A reloaded top-level app page can receive the result only if its origin
is unchanged. Driver API payloads and public completion/failure payloads are
unchanged.

Reload both the extension and the app tab when installing content-script changes.
The app console logs `[AMP Extractor] AMAZON_EXTRACTION_COMPLETE for <date>
posted to webpage` when forwarding succeeds. This confirms `window.postMessage`
was called, not that the app's listener handled it. The app must register its
message listener before triggering extraction and keep it registered until the
matching date/period completes.

Validation includes local lifecycle tests and an isolated headless Chrome check:
a never-selected page ran animation callbacks after emulation was enabled before
navigation, then stopped when emulation was disabled. This does not substitute
for a live Amazon run. A fully invisible approach without the debugging banner
would require inspecting Amazon's authenticated data requests and extracting
from their responses instead of rendered UI.

References:

- https://developer.chrome.com/docs/devtools/rendering/apply-effects#emulate_a_focused_page
- https://developer.chrome.com/docs/extensions/reference/api/debugger

## Production security checks

The app bridge accepts only same-window, same-origin requests. The worker
independently authorizes the app origin and validates the requested flow, dates,
service area, token format, and Amazon URL before creating a tab. Loaded URLs
are checked again before extraction. Known DA routes/itineraries redirects are
allowed; a redirect may omit the service area, but a different explicit area is
rejected. Persistent login/wrong-page redirects fail with a sign-in/retry message.

The token stays in the worker and is included in the API's Bearer header. It is
not passed to the injected extractor, logged, or stored persistently. Backend
token signature, expiry, scope, and tenant checks remain necessary. There is no
token-refresh endpoint or protocol in this extension.

The supported maximum is 150 drivers per date. Larger rosters fail before any
driver is submitted. This avoids silently reporting a capped roster as complete.
The five-second inter-driver spacing is unchanged: 150 drivers need at least
745 seconds of spacing alone. A fixed 10-minute token can therefore expire
before the run finishes. Coordinate a run-scoped renewal protocol with the app
and backend, or choose an explicitly bounded run credential lifetime sufficient
for measured extraction time. Do not reduce the spacing to work around expiry.

Duplicate starts for active flow/area/period/date keys are ignored without
emitting a failure for the existing sync. Other concurrent runs are refused.
Tab loading has a 90-second timeout and detects tab closure; HTTP requests,
including reading their response bodies, have a 60-second abort deadline.
Network timeouts are not automatically retried, since a timed-out write may
already have been accepted. Existing DA rate-limit retries are unchanged.

Production logs retain counts, HTTP status, and generic lifecycle warnings.
They omit tokens, full URLs, employee identifiers, route/stop records, raw API
responses, and DOM snapshots. Bounded API failure details remain in the existing
per-driver error result for compatibility; backend errors should not contain
credentials or unnecessary personal data.

Run `node --test tests/*.test.mjs` for local regression tests. After applying
these changes, reload both the extension and the AMP app tab and perform a
controlled authenticated sync. Unit tests use mocked DOM, Chrome, and network
APIs and do not prove compatibility with a changed Amazon page or backend.
