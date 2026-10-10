# Collecting coverage

The Rust analyzer reads saved recordings. You can use your own tooling to create a [supported input](usage.md#coverage-inputs), or use the optional Playwright/Chromium collector, `coldpath collect`.

## Setup

```sh
npm install --save-dev playwright
npx playwright install chromium
```

Use Node.js 22.12+. On Linux CI, `npx playwright install --with-deps chromium` also installs Chromium's system dependencies. Playwright is an optional peer dependency of `coldpath`; only collection needs it.

coldpath launches Chromium only in headless mode, so `npx playwright install --only-shell chromium` (Playwright 1.49 or newer) is enough and skips the full browser. Behind a proxy, or on a network that blocks Playwright's download CDN, use Playwright's [proxy](https://playwright.dev/docs/browsers#install-behind-a-firewall-or-a-proxy) and [mirror](https://playwright.dev/docs/browsers#download-from-artifact-repository) settings. A mirror must serve the same paths as the CDN, which `npx playwright install --dry-run --only-shell chromium` prints. To record with a browser that is already installed instead, pass [`--browser-channel` or `--browser-path`](#device-throttling-and-authenticated-state).

Build with source maps, serve that build, and keep the exact generated files available on disk. For example, if `/assets/app.js` is served from `dist/assets/app.js`:

```sh
coldpath collect \
  --url http://127.0.0.1:3000/ \
  --dir dist/assets \
  --prefix /assets/ \
  --scenario initial \
  --out artifacts/initial.coverage.json

coldpath --dir dist/assets \
  --coverage artifacts/initial.coverage.json \
  --html artifacts/report.html
```

The default prefix is `/`. It is a URL path prefix, unlike the analyzer's `--url-prefix`, which is a full URL. Use `--prefix /_next/static/` and the corresponding build's `static` directory for a Next.js application.

## Custom interactions

An action module default-exports an async function receiving `{page, context}`. It runs after the initial navigation and observation window. Use Playwright to wait for the application to finish the interaction before returning:

```js
// scenarios/search.mjs
export default async function ({ page }) {
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox").fill("javascript");
  await page.getByTestId("search-result").first().waitFor({ state: "visible" });
}
```

```sh
coldpath collect \
  --url http://127.0.0.1:3000/ \
  --dir dist/assets --prefix /assets/ \
  --scenario search --actions scenarios/search.mjs \
  --out artifacts/search.coverage.json

coldpath --dir dist/assets \
  --coverage artifacts/initial.coverage.json \
  --coverage artifacts/search.coverage.json \
  --html artifacts/combined.html
```

The module runs as local Node.js code. Paths are resolved from the current working directory. Each collector invocation launches a fresh browser, so an interaction recording also contains its initial page load. Actions may navigate to other same-origin pages (links, form submissions, `page.goto`); see [multi-page flows](#multi-page-flows).

An actions module can also export `setup`, which receives the same `{page, context}` before the first navigation, or export only `setup`. Use it for what the first load depends on, such as answering API calls with `route.fulfill` instead of running a mock server:

```js
// scenarios/mocked.mjs
export async function setup({ context }) {
  await context.route("https://api.example.com/**", (route) => route.fulfill({ json: { items: [] } }));
}
```

Playwright runs the most recently registered route first, so routes from `setup` run before the collector's [origin policy](#other-origins). A fulfilled request never reaches the network and appears in neither `requests` nor `blockedOrigins`. `route.fallback()` hands a request to the origin policy; `route.continue()` sends it to the network even when its origin is not allowed. `environment.observation` starts with `setup before navigation` when a `setup` ran.

## Scenario files

A scenario file records several scenarios in order and gives the analyzer the matching order:

```json
{
  "url": "http://127.0.0.1:3000/",
  "dir": "dist/assets",
  "prefix": "/assets/",
  "out": "artifacts/coverage",
  "scenarios": [
    {"name": "initial"},
    {"name": "search", "actions": "scenarios/search.mjs"},
    {"name": "settings", "url": "/settings"}
  ]
}
```

```sh
coldpath collect --scenarios coldpath.scenarios.json
coldpath analyze --scenarios coldpath.scenarios.json --html artifacts/combined.html
```

`collect` writes `<out>/<name>.coverage.json` for each scenario (default `out`: `coldpath-coverage`), and `coldpath profile` writes `<out>/<name>.profile.json` from the same file ([CPU cost](cpu.md)). `analyze` adds `--dir`, one `--coverage` per scenario, `--scenario-order` in file order, and `--initial-scenario` set to the first scenario unless you pass it, then forwards your other options. Paths are relative to the scenario file. A scenario `url` resolves against the top-level `url`; `prefix`, `waitMs`, the [environment options](#device-throttling-and-authenticated-state), and the [page state checks](#checking-the-page-state) `expect` and `allowPageErrors` can be set at the top level or per scenario. Names may contain letters, digits, `_`, `.`, and `-`.

## Device, throttling, and authenticated state

By default the collector uses a 1280x900 desktop viewport with no throttling and an empty browser profile.

| CLI option | Scenario file key | Effect |
| --- | --- | --- |
| `--device NAME` | `device` | A [Playwright device descriptor](https://playwright.dev/docs/emulation#devices) such as `"Pixel 7"`: viewport, user agent, touch, mobile mode, and device scale factor. Recording always uses Chromium, whatever the descriptor's default browser. |
| `--viewport WxH` | `viewport: {width, height}` | Overrides the device viewport. |
| `--user-agent UA` | `userAgent` | Overrides the user agent. |
| `--device-scale-factor N` | `deviceScaleFactor` | Overrides the pixel ratio. |
| `--mobile`, `--touch` | `isMobile`, `hasTouch` | Mobile meta-viewport handling and touch events. |
| `--latency-ms N --download-kbps N --upload-kbps N` | `network: {latencyMs, downloadKbps, uploadKbps}` | Chromium network emulation. All three values are required. |
| `--cpu-slowdown N` | `cpuSlowdown` | Chromium CPU throttling rate (`1` is no slowdown). |
| `--storage-state FILE` | `storageState` | A Playwright [storage state](https://playwright.dev/docs/auth) file with cookies and local storage, for example from a logged-in session. |
| `--header 'NAME: VALUE'` | `extraHTTPHeaders: {NAME: VALUE}` | Extra headers on every request, including the document request, for a server that renders by a token or device header. Repeatable on the command line. |
| `--browser-channel NAME` | `browserChannel` | An installed browser by [Playwright channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge), such as `chrome` or `msedge`, instead of Playwright's Chromium. |
| `--browser-path FILE` | `browserPath` | An installed Chromium-based browser executable. Cannot be combined with `--browser-channel`. |

Explicit options override the device's values. The envelope's `environment` records the device name, viewport, effective user agent, scale factor, mobile and touch flags, network and CPU settings, whether a storage state was loaded, and the names of extra headers. It never records the storage state's contents or path, or header values. Keep storage state files out of version control; they usually contain session cookies. Rather than writing a token into the scenario file, set it in [`setup`](#custom-interactions) from an environment variable with `context.setExtraHTTPHeaders()`.

`environment.browser` records the browser version; `browserChannel` records the channel, and `browserPath: true` only that an executable was named, not its path. Recordings from different browser builds can differ in which code runs and how long it takes, so compare recordings made with the same browser.

Throttling changes which code runs only when the application reacts to timing (for example, timeouts or network-dependent fallbacks). Coverage from throttled recordings is still not a performance measurement; record [CPU profiles](cpu.md) for that.

## Multi-page flows

A full-page navigation discards the old document's scripts. The collector injects an empty `beforeunload` listener into every document and sets a debugger breakpoint on it. When a document is about to unload, the page pauses, the collector takes a coverage snapshot and reads the scripts' sources, and the page resumes. The final snapshot is taken after the actions. All snapshots go into one envelope, where a script path can appear once per snapshot; the analyzer unions them. `environment.observation` records the snapshot count.

Limitations: the injected listener runs in every document. Code that runs after `beforeunload` (for example `pagehide` or `unload` handlers) is not recorded. A page restored from the back/forward cache without unloading keeps its scripts, so it is covered by the next snapshot. Navigations to origins other than `--url`, `--cdn-prefix`, and `--allow-origin` origins are blocked.

## CDN scripts

Scripts served from another origin are recorded only when their URL starts with an explicit `--cdn-prefix` (repeatable; `cdnPrefixes` in a scenario file). The remainder of the URL, without query or fragment, is the path under `--dir`, and the same SHA-256 check applies: a CDN copy that differs from the local build fails the capture. Requests to a listed CDN origin are allowed; all other cross-origin requests remain blocked.

```sh
coldpath collect --url http://127.0.0.1:3000/ --dir dist \
  --prefix /assets/ --cdn-prefix https://cdn.example.com/app/1.4.0/ \
  --out artifacts/initial.coverage.json
```

Envelope scripts record the browser `url` they were matched from.

## Other origins

A scenario that calls an API or loads other resources from another origin needs that origin in `--allow-origin` (repeatable; `allowOrigins` in a scenario file, at the top level or per scenario), such as `https://api.example.com`. Requests to it pass through and appear in the envelope's `requests`; scripts it serves are not attributed, so list a script origin under `--cdn-prefix` instead. `environment.allowedOrigins` records the allowed origins. The recording then depends on what that service returned at the time, so a different response can change which code runs.

## Checking the page state

Coverage numbers describe the page the browser showed, which can be an error or loading screen when a request was blocked or failed. After each scenario, `collect` prints the final URL, the status of the last main document response, and the numbers of console errors and page errors to stderr, plus the number of aborted requests per origin when the [origin policy](#other-origins) blocked any:

```text
initial: final page http://127.0.0.1:3000/dashboard (document status 200), 2 console errors, 0 page errors
initial: aborted requests to origins outside --allow-origin and --cdn-prefix: https://api.example.com (3)
```

`expect` (`--expect SELECTOR`, repeatable) lists [Playwright selectors](https://playwright.dev/docs/other-locators) that must each match a visible element at the end of the scenario, such as `"expect": ["role=heading[name=\"Dashboard\"]", "text=Weekly orders", "main .chart"]`. The check runs once, without waiting, so the observation window stays as configured; actions should wait for what they need. A missing element fails the scenario, and nothing is written.

A page error (an uncaught exception or an unhandled promise rejection) fails the scenario by default. `allowPageErrors: true` tolerates every page error; a list of regular expressions (`--allow-page-error REGEX`, repeatable) tolerates errors whose message matches one of them. Tolerated errors stay in the envelope's `pageErrors`, and other errors still fail the scenario with their messages.

`profile` applies `expect` and `allowPageErrors` to every run and records the distinct tolerated messages in `pageErrors`.

## Unsupported: workers

Web Worker, shared worker, and service worker coverage is not recorded, and worker scripts in `--dir` stay unmeasured. The collector cannot start precise coverage in a dedicated worker before the worker's top-level code runs: Playwright attaches to new workers itself and resumes them immediately, so by the time a second CDP session sees the worker, its top-level code has already run and V8 reports only some functions, without block detail. Holding the worker script request until coverage starts does not work either, because the worker target appears only after its script is fetched, and holding `importScripts` requests deadlocks the worker. A partial recording would report code that ran as unobserved, so the collector records nothing rather than wrong evidence. Service workers remain blocked.

## What is recorded

The collector runs the actions module's optional `setup`, starts precise V8 coverage before navigation, waits for `networkidle`, waits another 1,000 ms by default, runs optional actions, and takes a final coverage snapshot (plus one before each unload). `--wait-ms 0` removes the extra observation window. Pages with persistent requests may never reach `networkidle`; use your own Playwright recording when a different readiness condition is required.

Only the page's CDP target is captured. Workers, other tabs, and server-side execution are outside its scope. Service workers and cross-origin requests other than `--cdn-prefix` and `--allow-origin` origins are blocked, so an application that calls an external API needs its origin in [`--allow-origin`](#other-origins). Unsuccessful navigation fails the capture, and so do page runtime errors that [`allowPageErrors`](#checking-the-page-state) does not tolerate. Precise coverage changes execution behavior, so capture durations are not performance measurements.

Matching `.js`, `.mjs`, and `.cjs` scripts are checked against the local build with SHA-256. The artifact records those hashes, local map hashes (or explicit map absence), V8 function ranges, and capture metadata. Inline and eval scripts without a matching file extension are excluded. A missing matching file, stale build, or path outside `--dir` is an error.

The collector supports adjacent `.js.map` files and relative local maps referenced by a final standalone `//# sourceMappingURL=...` or `//@ sourceMappingURL=...` comment. Its map support is narrower than the Rust analyzer: inline `data:` maps, block-comment references, explicit map overrides, and remote maps are not supported by this helper. Use external source-map files for these captures.

Preserve the JavaScript, maps, and recordings together. A recording from an earlier build cannot be safely applied to a changed bundle, even when its path or length is identical. The map hash binds the local map used during capture; it does not prove that the build system generated a correct map.
