# Security and privacy boundaries

This preview supports Windows x64 only. It controls local applications, a separate visible browser, and optionally a user-enabled loopback Chrome/Edge debugging endpoint. It is not an OS sandbox, a trusted desktop boundary, a network firewall, or an audited isolation mechanism.

## Enforced in this plugin

- Exact executable-path and top-level-origin read/control checks with Session/turn lifetimes.
- Default `owner` mode uses Host approval for conservative write/sensitive operations; never, rejection, cancellation and unavailable approval do not become grants. Explicit user-selected `auto` mode skips this plugin's prompts, including with Host policy `never`; explicit target denials and other hard limits still apply. Returning to `owner` revokes automatic leases and invalidates pending approvals.
- Observation-local UIA handles, exact process/window identity revalidation and no automatic coordinate fallback.
- Bounded arguments/results, default-disabled arbitrary page script, confined non-overwriting URL downloads.
- Physical-Escape stop latch, redacted bounded logs and no screenshot retention in those logs.
- CDP connections and selected targets belong to an Agent/Session. Tab metadata needs each origin's read scope; switching, closing and other mutations need confirmation in owner mode. Page/loader changes during authorization stop stale input. Commands have timeouts and cancellation; Esc/unload closes these connections, without closing the user's browser.
- The mode route requires authenticated Host admission, same-origin requests, a JSON body/custom intent header, and explicit acknowledgement for auto mode. The UI asks before enabling auto. These checks are not proof of human intent against arbitrary authenticated local code.

The native UIA executable is a local implementation component, not a standalone authenticated authorization API. Local code can invoke it directly. The same is true of other libraries or shell tools available to an Agent with full local execution permission. Do not present scoped grants as protection against arbitrary local code.

Top-level-origin checks gate plugin operations and disclosure after observed navigation. They do not stop a webpage's own scripts, background requests, third-party frames, form handlers or navigation side effects. Read/control grants do not prove that a page or application is trustworthy. Coordinate/keyboard actions and UIA Invoke require conservative one-use approval; automatic sensitive-label detection for other semantic operations is supplementary and cannot understand every business consequence.

The code validates target identity immediately before native dispatch, but external applications can still change concurrently. A successful UIA call or changed UI state does not prove a remote transaction completed. Timeout/cancellation can leave an unknown result; observe before any retry. The plugin does not bypass UAC, lock screens, browser connection approval, authentication or CAPTCHA challenges.

Logs store only fixed metadata fields. Host chat logs, attachments and backend browser configuration/login data have their own retention and privacy rules. The separate provider instance disables upstream persistent visit history. Screenshots returned on explicit pixel requests may contain sensitive visible content; password-value exclusion in UIA does not redact pixels.

## Reporting

Use the repository Security tab's private vulnerability reporting feature when enabled. If no private channel is available, open a minimal issue requesting one, with affected versions only; do not post exploit details, credentials, private screenshots or user logs publicly.

No third-party security audit has been performed. Human approval UI, physical-key acceptance, elevated-window and multi-display matrices remain release checks; consult the verification report for exact coverage.
