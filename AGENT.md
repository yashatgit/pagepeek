# Notes for agents working on pagepeek

Read `README.md` first for what the service does and its API. This file holds what the code
can't tell you: why things are the way they are, what was measured, and how to check a change.

## What it is

One Electron app, no build step, plain ESM. Two dependencies: `electron` and
`@anthropic-ai/sdk`. Four source files, under 400 lines together.

```
request -> server.mjs  planRequest()   validate, pick a mode: locator | screenshot | html
                       enqueue()       one page at a time
                       loadPage()      open a hidden BrowserWindow, load, wait, call a READER
                       READERS[mode]   read the page while the window is still open
        -> ask.mjs     askAboutScreenshots()   query mode only, after the window has closed
```

Electron is used as a browser you can drive from Node in the same process. There is no
Playwright or Puppeteer, and no DevTools connection.

## How to check a change

There are no unit tests. Start the service, then run `npm run check`, which does the
requests below. The manual commands are kept as reference.

```bash
cp .env.example .env            # add a token; add ANTHROPIC_API_KEY for query mode
docker compose up -d --build
T=$(sed -n 's/^PAGEPEEK_TOKEN=//p' .env)
post() { curl -s -X POST http://127.0.0.1:8787/read -H "authorization: Bearer $T" -d "$1"; echo; }

post '{"url":"https://example.com/","locator":"p"}'            # found: true, matches: 6
post '{"url":"https://example.com/","html":true}'              # html of about 2 KB
post '{"url":"https://example.com/","query":"What does this page say?","screens":1}'
post '{"url":"https://example.com/","locator":"p","html":true}'  # 400, exactly one mode
post '{"url":"file:///etc/passwd","locator":"body"}'           # 400, http or https only
curl -s -X POST http://127.0.0.1:8787/read -H 'authorization: Bearer nope' -d '{}'   # 401
docker logs pagepeek | tail
```

Then open http://127.0.0.1:8787 and run one question with "Show the screenshots" ticked.
Looking at the screenshots is the fastest way to see what the model was given.

example.com changes now and then. It had no `h1` in November 2026, so a locator of `h1`
matching nothing there is not a bug.

## Decisions and the reasons for them

**One page at a time.** `enqueue()` chains every request onto the previous one, and
`lastHit` holds a per-host pause (`PAGEPEEK_HOST_GAP_MS`, 4 s). This is deliberate: the
service is for a few reads a day, and slow, spaced loads are what a site tolerates.

**The model call runs outside the queue.** The `screenshot` reader only captures. The window
closes, the next page can start, and then `ask.mjs` is called. Don't move the Claude call
into the reader.

**Hidden windows.** `show: false` with `backgroundThrottling: false`. `capturePage()` on a
never-shown window returned real images on macOS and under Xvfb in the container. It has not
been tried on Windows or on Linux with a real display.

**`useContentSize: true`.** It makes 1280x1000 the size of the page area. Without it the
height would include the window's title bar where there is one.

**Screenfuls, not one tall screenshot.** A full page in one image gets scaled down by the API
until text is unreadable. The reader scrolls `0.9 * innerHeight` per step so a line cut by
the bottom edge appears whole in the next image, and stops when a scroll moves less than
100 px. A fixed header repeats in every image; the system prompt tells the model so.
Default 4, maximum 12. On a retina Mac the capture is 2x and is resized to 1280 wide.

**Pages that scroll inside a panel yield one screen.** The reader scrolls `window`. A page
whose content scrolls in an inner element never moves. Not handled, not tested.

**`ERR_ABORTED` from `loadURL` is not a failure.** Some sites replace the first load with a
client-side redirect. The code treats it as success and carries on.

**`refused` counts the page's sub-requests answered 403 or 429.** Some sites serve the
document and then refuse its scripts, so a 200 with a missing element and `refused > 0`
usually means the site turned the browser away. The main document's status is in `status`.

**Private-use characters are stripped from locator text.** Icon fonts draw glyphs with code
points U+E000 to U+F8FF. One shop drew its currency sign that way, so the same selector
returned "69.00" on one load and a stray character before it on another.

**Only `http` and `https`.** `planRequest()` rejects other schemes and `stayOnTheWeb` blocks
redirects to them. `file://` or `chrome://` would read the container, not a website. There
is no host allow-list by choice: the token is the gate.

**Popups, downloads and permission prompts are denied** in `watchResponses()` and
`setWindowOpenHandler`.

**The user agent is a fixed string in `server.mjs`** (Chrome 158 on macOS), not a setting.

## The Claude call (`ask.mjs`)

- Model `claude-haiku-5-5`, set by `PAGEPEEK_MODEL`.
- Structured output through `output_config.format` with a JSON schema: `{found, answer}`.
  The reply is parsed with `JSON.parse` from the first `text` block.
- Thinking is on by default for this model, so `response.content[0]` is not always the text.
  The code uses `find((block) => block.type === "text")`. Don't index.
- `effort: "low"`. Reading a number off a screenshot doesn't need more.
- `stop_reason === "refusal"` is returned as `found: false`, not thrown.
- `describeAskError()` maps SDK error classes to one line. Never log or return the key.
- Measured in November 2026: about 2,100 input tokens for 1 screen, 7,131 for 4.

## The image

About 530 MB (arm64 build). It was 1.02 GB before these changes, each of which is in the
`Dockerfile` with a comment:

| Removed | Saved |
|---|---|
| Node and npm from the final stage | about 143 MB |
| Mesa's software 3D drivers (`libLLVM`, `libz3`, `dri/`) | about 152 MB |
| npm's and Electron's download caches | about 128 MB |
| Unused Electron files, GTK icons and docs | about 70 MB |

What is left is the Electron binary (217 MB) and the libraries Chromium links against.

Things that bite if you touch the Dockerfile:

- **Electron 45 has no postinstall script.** `npm ci` does not download the browser binary.
  It downloads on first run, which fails in a container that isn't root. The build runs
  `node node_modules/electron/install.js` to fetch it.
- **The final stage has no Node.** The command runs `node_modules/electron/dist/electron`
  directly. `npx electron` and `node_modules/.bin/electron` won't work there.
- **`--disable-gpu` is what makes removing Mesa safe.** Take the flag out and Chromium will
  look for the drivers the build deleted.
- **`--no-sandbox` is required in Docker.** Chromium's sandbox needs user namespaces, which
  the default seccomp profile blocks. The container is the isolation.
- **Xvfb's screen (1280x1024) must be at least as large as the window (1280x1000).**
- **`.dockerignore` is an allow-list.** A new source file must be added there and to the
  `COPY` line, or the container starts without it.
- The amd64 build has not been built or measured.

## Secrets

`.env` is gitignored and holds the token and the Anthropic key. `.env.example` is the
template. Compose reads `.env` to fill `${...}` in `compose.yaml`; the file is not copied
into the image. Don't commit a token, and don't put one in a URL.

## Not built yet

- Scrolling inside inner panels.
- Dismissing cookie walls before a screenshot. The model reports the wall instead.
- More than one page at a time.
- Tests that run without the network.
