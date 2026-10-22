# DA extraction while the app tab stays active

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
