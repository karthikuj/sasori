# In-page instrumentation, an assist-mode extension, and a budgeted AI fallback

Tracked in [SCAN-239](https://linear.app/webscanner/issue/SCAN-239/sasori-in-page-instrumentation-an-assist-mode-extension-and-a-budgeted).
This is a design note, not a commitment: it records what each idea buys, what
Sasori already does, and the order worth building in.

The question behind it: would a browser extension, like the one an AI agent
uses to drive Chrome, help Sasori crawl? And can AI help without being paid for
on every crawl?

Short answer:

- An extension's power is code that runs inside every page from the start.
  Sasori can already do that through Puppeteer, so most of the gains do not
  need an extension at all (section 1).
- An extension earns its place in one case: a person clicking through the hard
  parts of an app in their own browser while Sasori records them (section 2).
- An AI agent driving the browser is the wrong model for crawling: every step
  is a model call. AI pays off only at the few points where the rules give up,
  with every answer cached and a hard budget (section 3).

## What Sasori does today

- **Clickable elements** come from the `crawler.elements` selectors. The
  `[click]` pseudo-selector runs `ActionDiscovery.findNodesWithClickListeners`:
  `DOM.querySelectorAll('*')`, then for every element `DOM.resolveNode`,
  `DOMDebugger.getEventListeners` and `DOM.describeNode`. That is three CDP
  round trips per element, on every new state, and it is one of the most
  expensive parts of a crawl (the probes run in a bounded pool to soften it).
  It sees only listeners attached to the element itself, and skips elements
  with no attributes, since the selector is built from them.
- **Settling after an action** is already done from inside the page:
  `ActionReplay.settleAfterAction` waits for a `MutationObserver` quiet window
  and network idle, both capped, and handles `history.pushState`
  navigations. That needs no change.
- **Form values** are fixed per input type (`CrawlInput.VALUES`): the same
  text, email, password, search and URL values for every form.
- **Shadow DOM** is not traversed. Buttons inside web components, open or
  closed, are not found.

## 1. In-page instrumentation script (SCAN-239, part 1)

One script, injected with `page.evaluateOnNewDocument` so it runs at document
start in every frame, before the app's own code. It records what the page does
as it happens, and Sasori reads the record instead of probing the page from
outside. No extension and no running cost.

- **Click handlers as they are added.** Wrap `EventTarget.prototype.addEventListener`
  (and `onclick` assignment) to record each element that gets a `click`,
  `mousedown` or `pointerdown` handler, in a `WeakSet`. Reading it is one
  `page.evaluate` per state instead of three CDP calls per element. Keep the
  CDP sweep as a fallback for handlers attached before the script could run.
- **Closed shadow DOM.** Wrap `Element.prototype.attachShadow` to force
  `mode: 'open'`, then extend discovery to walk shadow roots. Selectors that
  cross a shadow boundary need Puppeteer's `>>>` combinator, so replay must
  use them too. `domPath.ts` is not to be modified (see CLAUDE.md), so the
  shadow path is built around it, not inside it.
- **Delegated handlers.** React and Vue attach one listener at the root and
  dispatch from there, so neither the hook nor the CDP sweep sees which child
  is clickable. Use cheap signals instead: computed `cursor: pointer`,
  `role="button"`/`link`/`menuitem`/`tab`, and `tabindex` on non-form elements.
  These need their own dedup care, since a pointer cursor inherits to every
  child.

What to measure: time per state with the hook versus the sweep, and actions
found, with `make bench-crawlmaze` (coverage must not drop) and a React app.

Fingerprint note: wrapping prototypes is visible to a page that looks for it
(`Function.prototype.toString` on the wrapper). Keep the wrappers' `toString`
returning the native string, in line with keeping every fingerprint layer
consistent.

## 2. Assist-mode extension (SCAN-239, part 2)

For flows Sasori cannot get through on its own: MFA prompts, multi-step
wizards, steps that need a human choice, anything behind a CAPTCHA (which
Sasori must never try to get past). The person clicks through in their own
browser; the extension records each state and action and sends them to Sasori,
which adds them to the crawl graph and then crawls outward from everything the
person reached.

- **Same graph, same identity.** States are hashed with the same `DomStripper`
  rules, so a state the person reached merges with one Sasori reaches later.
  Each recorded request carries the session that made it, which IDOR detection
  needs: an endpoint with no identity attached is no use to it.
- **Replay.** Recorded actions become `CrawlAction`s with selectors, like any
  other, so workers can replay to those states. Steps that cannot be replayed
  (an MFA code, a CAPTCHA) mark the state as reachable only by navigation from
  its URL, or only in the person's session.
- **Transport.** The extension posts to Sasori's API (a scan in assist mode),
  so it works for the CLI and for Nara.
- **The capture stays untouched.** The extension observes; it never changes a
  request on the wire.

This is the only part that needs an extension: everything in part 1 works
without one.

## 3. Budgeted AI fallback (SCAN-239, part 3)

AI only at the points where the rules give up, never in the loop for every
action. Off by default; a per-run toggle in the crawl config (sent to Sasori
like other per-run options), with a hard cap on calls or cost per crawl, and a
small, fast model. When the budget is spent, Sasori falls back to the rules and
says so.

| Where | What the model does | What keeps it cheap |
|---|---|---|
| **Form values** | Picks a valid value for a field the fixed values do not fit: a date of birth, an IBAN, a product code, a value the server validates | Cached by field signature (label, `name`, `type`, `pattern`, nearby text): the same field on any later crawl or site costs nothing |
| **Dangerous actions** | Judges whether "Archive project" or "Revoke key" is destructive before it is clicked | One call per unique label, cached; a keyword list (logout, delete, remove) handles the obvious ones first |
| **Stuck crawls** | When new states stop appearing, looks at one screenshot and suggests an action | Only on a plateau, a few calls per crawl at most |
| **Broken login recordings** | When replay fails at a step, sees the page and proposes a repaired selector | Only on failure; the fix is saved, so it is paid for once |

Start with form values: a form that rejects the fixed values is the most common
reason a crawl stops short, and the cache makes it cheaper with every crawl.

## Order

1. Part 1, the instrumentation script: a pure win, and part 2 reuses it.
2. Part 3, starting with form values.
3. Part 2, the assist-mode extension.

## Not in scope

- **Parsing JavaScript for endpoints.** An endpoint found that way has no
  identity attached, and IDOR detection needs to know who reached it.
- **Anything that gets past CAPTCHAs or bot checks.** Assist mode hands those
  to a person.
