// server.mjs: pagecrawl. Loads a web page in a browser window and reads it for the caller.
//
//   POST /read    Authorization: Bearer <PAGECRAWL_TOKEN>, JSON body with "url" and exactly
//                 one of:
//                   "locator": "<css selector>"   the visible text of the first match
//                   "query": "<a question>"       answered by Claude Haiku from screenshots
//                   "html": true                  the rendered HTML
//   GET  /        the web page for trying it by hand (index.html)
//   GET  /health  {"ok": true, "queued": 0}
//
// README.md documents the fields and answers. AGENT.md explains why the code is the way it is.
//
// This is an Electron app: each page opens in an ordinary Chromium window, one at a time.
// Run it with `npm start` (electron .), not plain node.

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { app, BrowserWindow, session } from "electron";
import { readEnv } from "./env.mjs";
import { syncCookies } from "./cookies.mjs";
import { askAboutScreenshots, canAsk, describeAskError } from "./ask.mjs";

const TOKEN = readEnv("PAGECRAWL_TOKEN");
const PORT = Number(readEnv("PAGECRAWL_PORT") ?? 8787);
const BIND = readEnv("PAGECRAWL_BIND") ?? "127.0.0.1";
const COOKIES_DIR = readEnv("PAGECRAWL_COOKIES_DIR"); // optional folder of cookie JSON files
const HOST_GAP_MS = Number(readEnv("PAGECRAWL_HOST_GAP_MS") ?? 4000);
// Chrome 158's user agent for the platform this runs on, sent instead of Electron's default,
// which carries this app's name.
const OS = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
const USER_AGENT = `Mozilla/5.0 (${OS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36`;

const NAV_TIMEOUT_MS = 45_000;
const WAIT_FOR_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 5_000;
// With no selector to wait on, a screenshot gives client-side rendering this long after load.
const RENDER_PAUSE_MS = 2_500;
const SHOT_WIDTH = 1280;
const SHOT_HEIGHT = 1000;
// A question reads the page as a series of screenfuls from the top. One tall image of a whole
// page would be scaled down until its text is unreadable, and a long product page runs past
// 15 screens of reviews and recommendations. Four covers the main content of most pages, at
// about 1,700 tokens a screen.
const DEFAULT_SCREENS = 4;
const MAX_SCREENS = 12;
const SCROLL_PAUSE_MS = 500; // lets lazy-loaded content paint after each scroll
const PARTITION = "pagecrawl"; // in-memory: cookies last until restart; COOKIES_DIR refills them
const INDEX_HTML = fs.readFileSync(new URL("./index.html", import.meta.url));

if (!TOKEN || TOKEN.length < 24) {
  console.error("PAGECRAWL_TOKEN is missing or shorter than 24 characters. Set it in .env (see .env.example).");
  process.exit(1);
}

function tokenMatches(header) {
  const given = Buffer.from(String(header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- loading one page -------------------------------------------------

// What each open window's page has been answered so far, keyed by webContents id.
const responses = new Map();

function watchResponses(ses) {
  ses.webRequest.onCompleted((details) => {
    const seen = responses.get(details.webContentsId);
    if (!seen) return;
    if (details.resourceType === "mainFrame") seen.status = details.statusCode;
    else if (details.statusCode === 403 || details.statusCode === 429) seen.refused++;
  });
  // A page being read has no business asking for the camera, saving files or opening popups.
  ses.setPermissionRequestHandler((_wc, _permission, allow) => allow(false));
  ses.on("will-download", (event) => event.preventDefault());
}

async function pollUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true;
    await sleep(300);
  }
  return false;
}

// How to read a loaded page, by mode. Each gets the open page and returns the fields that
// mode adds to the answer.
const READERS = {
  html: async (page) => ({ html: await page.executeJavaScript("document.documentElement.outerHTML") }),

  locator: async (page, { locator }) => {
    const hit = await page.executeJavaScript(`(() => {
      const all = document.querySelectorAll(${JSON.stringify(locator)});
      return { matches: all.length, text: all[0] ? (all[0].innerText ?? all[0].textContent ?? "") : null };
    })()`);
    // Private-use characters are icon-font glyphs (some shops draw a currency sign with one)
    // and mean nothing as text.
    const text = hit.text?.replace(/[-]/g, "").replace(/\s+/g, " ").trim() ?? null;
    return { found: hit.matches > 0, text, matches: hit.matches };
  },

  // Only the capture happens here. The model call runs after the window has closed, so it
  // doesn't hold up the next page in the queue.
  screenshot: async (page, { waitFor, screens }) => {
    if (!waitFor) await sleep(RENDER_PAUSE_MS);
    const shots = [];
    while (shots.length < screens) {
      if (shots.length > 0) {
        // Scroll by a little under one screen, so a line cut by the edge is whole in the next.
        const moved = await page.executeJavaScript(`(() => {
          const before = window.scrollY;
          window.scrollBy(0, Math.round(window.innerHeight * 0.9));
          return window.scrollY - before;
        })()`);
        if (moved < 100) break; // the bottom of the page
        await sleep(SCROLL_PAUSE_MS);
      }
      let image = await page.capturePage();
      if (image.isEmpty()) throw new Error("screenshot came back empty");
      if (image.getSize().width > SHOT_WIDTH) image = image.resize({ width: SHOT_WIDTH });
      shots.push(image.toJPEG(80));
    }
    return { shots };
  },
};

const lastHit = new Map(); // hostname -> ms timestamp of the last page load

async function loadPage(url, mode, options = {}) {
  const waitFor = options.waitFor ?? options.locator;
  const wait = (lastHit.get(url.hostname) ?? 0) + HOST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);

  await syncCookies(session.fromPartition(PARTITION), COOKIES_DIR);

  const win = new BrowserWindow({
    width: SHOT_WIDTH,
    height: SHOT_HEIGHT,
    useContentSize: true,
    show: false,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const page = win.webContents;
  const seen = { status: 0, refused: 0 };
  responses.set(page.id, seen);
  page.setWindowOpenHandler(() => ({ action: "deny" }));
  // Web pages only: a redirect to file:// or chrome:// would read this machine, not a site.
  const stayOnTheWeb = (event, target) => {
    if (!/^https?:$/.test(new URL(target).protocol)) event.preventDefault();
  };
  page.on("will-navigate", stayOnTheWeb);
  page.on("will-redirect", stayOnTheWeb);

  try {
    const failure = await Promise.race([
      // ERR_ABORTED is a client-side redirect replacing the load, not a failure.
      page.loadURL(url.href).then(() => null, (e) => (e.code === "ERR_ABORTED" ? null : e)),
      sleep(NAV_TIMEOUT_MS).then(() => new Error(`no response in ${NAV_TIMEOUT_MS / 1000}s`)),
    ]);
    if (failure) throw failure;

    if (waitFor) {
      // A page that never grows the selector is not an error here. The reader reports the miss.
      const present = `!!document.querySelector(${JSON.stringify(waitFor)})`;
      await pollUntil(() => page.executeJavaScript(present), WAIT_FOR_TIMEOUT_MS);
    }
    await pollUntil(async () => !page.isLoading(), SETTLE_TIMEOUT_MS);
    const read = await READERS[mode](page, options);
    return { status: seen.status, finalUrl: page.getURL(), refused: seen.refused, ...read };
  } finally {
    lastHit.set(url.hostname, Date.now());
    responses.delete(page.id);
    win.destroy();
  }
}

// One page at a time: each request chains onto the previous one.
let queue = Promise.resolve();
let queued = 0;

function enqueue(job) {
  queued++;
  const run = queue.then(job).finally(() => queued--);
  queue = run.catch(() => {});
  return run;
}

// ---------- HTTP ---------------------------------------------------------------

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 4096) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error("request body too large");
  }
  return JSON.parse(raw);
}

// Check a request body and turn it into {url, mode, options}, or {error} with an HTTP code.
function planRequest(body) {
  let url;
  try {
    url = new URL(body.url);
  } catch {
    return { code: 400, error: 'body must be JSON with a "url"' };
  }
  if (!/^https?:$/.test(url.protocol)) return { code: 400, error: "url must be http or https" };

  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const waitFor = text(body.waitFor);
  const locator = text(body.locator);
  const query = text(body.query);
  const html = body.html === true;
  if ([locator, query, html].filter(Boolean).length !== 1) {
    return { code: 400, error: 'send exactly one of "locator" (a CSS selector), "query" (a question) or "html": true' };
  }
  if (html) return { url, mode: "html", options: { waitFor } };
  if (locator) return { url, mode: "locator", options: { locator } };

  if (!canAsk()) return { code: 503, error: "query mode needs ANTHROPIC_API_KEY, which is not set" };
  const asked = Number.isInteger(body.screens) ? body.screens : DEFAULT_SCREENS;
  const screens = Math.min(Math.max(asked, 1), MAX_SCREENS);
  return { url, mode: "screenshot", options: { waitFor, screens }, query, wantShots: body.includeScreenshots === true };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, queued });
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(INDEX_HTML);
  }
  if (req.method !== "POST" || req.url !== "/read") return send(res, 404, { error: "not found" });
  if (!tokenMatches(req.headers.authorization)) return send(res, 401, { error: "bad token" });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "body must be JSON" });
  }
  const plan = planRequest(body);
  if (plan.error) return send(res, plan.code, { error: plan.error });
  const { url, mode, options, query, wantShots } = plan;

  const started = Date.now();
  const log = (what) => console.log(`${what} ${url.hostname} ${mode} ${Date.now() - started}ms`);
  let page;
  try {
    page = await enqueue(() => loadPage(url, mode, options));
  } catch (e) {
    const message = String(e?.message || e).split("\n")[0];
    log(`ERR ${message}`);
    return send(res, 502, { error: message });
  }

  if (mode === "screenshot") {
    const { shots, ...rest } = page;
    try {
      page = { ...rest, screens: shots.length, ...(await askAboutScreenshots(shots, query)) };
    } catch (e) {
      log(`ERR ${describeAskError(e)}`);
      return send(res, 502, { error: describeAskError(e) });
    }
    if (wantShots) page.screenshots = shots.map((jpeg) => jpeg.toString("base64"));
  }
  log(`${page.status}${page.refused ? ` refused=${page.refused}` : ""}${page.found === false ? " not-found" : ""}`);
  send(res, 200, page);
});

// The app has no window of its own, so closing the last page window must not quit it.
app.on("window-all-closed", () => {});
app.dock?.hide();
app.userAgentFallback = USER_AGENT;

app.whenReady().then(() => {
  watchResponses(session.fromPartition(PARTITION));
  server.listen(PORT, BIND, () => {
    console.log(`pagecrawl on http://${BIND}:${PORT}, query mode ${canAsk() ? "on" : "off (no ANTHROPIC_API_KEY)"}`);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    app.quit();
  });
}
