# pagepeek

A small HTTP service that loads a web page in a real browser and reads it for you. Give it a
URL and one of three things:

- a **CSS locator**, and it returns the visible text of the first match
- a **question in plain English**, and Claude Haiku answers it from screenshots of the page
- `"html": true`, and it returns the rendered HTML

It exists for pages that only make sense after their JavaScript has run, and for the cases
where writing a selector is more work than asking "what is the price?".

It runs as one Docker container. There is a web page at `/` for trying it by hand.

## Run it

```bash
cp .env.example .env
# put a token in .env:  openssl rand -hex 24
docker compose up -d --build
```

Then open http://localhost:8787, paste the token, and try a page.

Query mode needs `ANTHROPIC_API_KEY` in `.env`. Locator and HTML modes work without it.

## API

Every read is `POST /read` with `Authorization: Bearer <PAGEPEEK_TOKEN>` and a JSON body
holding `url` plus exactly one of `locator`, `query` or `html`.

### Locator

```bash
curl -s -X POST http://localhost:8787/read \
  -H "authorization: Bearer $PAGEPEEK_TOKEN" \
  -d '{"url": "https://example.com/", "locator": "p"}'
```

```json
{
  "status": 200,
  "finalUrl": "https://example.com/",
  "refused": 0,
  "found": true,
  "text": "This domain is for use in documentation examples without needing permission. …",
  "matches": 6
}
```

The service waits up to 15 seconds for the selector to appear. `matches` is how many elements
it matched; `text` is from the first.

### Query

```bash
curl -s -X POST http://localhost:8787/read \
  -H "authorization: Bearer $PAGEPEEK_TOKEN" \
  -d '{"url": "https://www.amazon.ae/dp/B0FQTBSDRB", "query": "What is the price, and what is the average customer rating out of 5?"}'
```

```json
{
  "status": 200,
  "finalUrl": "https://www.amazon.ae/dp/B0FQTBSDRB?th=1",
  "refused": 1,
  "screens": 4,
  "found": true,
  "answer": "AED 179; 3.4 out of 5",
  "model": "claude-haiku-5-5",
  "usage": { "input_tokens": 7131, "output_tokens": 29 }
}
```

Optional fields:

| Field | Default | Meaning |
|---|---|---|
| `screens` | `4` | How many screenfuls to capture from the top of the page, 1 to 12 |
| `waitFor` | none | A CSS selector to wait for before taking screenshots |
| `includeScreenshots` | `false` | Return the JPEGs as base64 in `screenshots` |

### HTML

```bash
curl -s -X POST http://localhost:8787/read \
  -H "authorization: Bearer $PAGEPEEK_TOKEN" \
  -d '{"url": "https://example.com/", "html": true}'
```

Returns the page's `document.documentElement.outerHTML` in `html`, after scripts have run.
`waitFor` works here too.

### Fields in every answer

| Field | Meaning |
|---|---|
| `status` | The HTTP status of the page itself |
| `finalUrl` | Where the browser ended up after redirects |
| `refused` | How many of the page's own requests the site answered with 403 or 429 |
| `found` | `false` when the selector matched nothing, or the screenshots did not show the answer |

When a question can't be answered, `answer` says what the screenshots showed instead, such
as "an Access Denied error page".

Errors come back as `{"error": "…"}` with 400 (bad request), 401 (bad token), 502 (the page
would not load, or the model call failed) or 503 (query mode without an API key).

`GET /health` returns `{"ok": true, "queued": 0}` and needs no token.

## How much of the page a question sees

A question reads the page as screenfuls from the top, each 1280x1000. The service scrolls 90%
of a screen between captures and stops at the bottom of the page. The default of 4 screens is
about 3,700 px of page.

It sends screenfuls, not one tall image, because a whole page in a single image gets scaled
down until the text is unreadable.

Each screen costs about 1,700 input tokens. The default of 4 measured 7,131 tokens for one
question, and a single screen about 2,100. Check current Claude Haiku pricing for what that
costs you.

## Settings

All of these go in `.env`. See `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `PAGEPEEK_TOKEN` | required | Bearer token for `POST /read`, at least 24 characters |
| `ANTHROPIC_API_KEY` | none | Turns on query mode |
| `PAGEPEEK_PORT` | `8787` | Port on the host |
| `PAGEPEEK_MODEL` | `claude-haiku-5-5` | Model that answers questions |
| `PAGEPEEK_HOST_GAP_MS` | `4000` | Minimum pause between two page loads on the same host |
| `PAGEPEEK_BIND` | `127.0.0.1` | Listen address for `npm start`. The container always uses `0.0.0.0` |

## Things to know before you expose it

- **The token is the only gate.** pagepeek loads any `http` or `https` URL it is given.
  Whoever holds the token can make it load any page the container can reach, including pages
  on your own network.
- **Query mode sends screenshots to Anthropic.** Don't point it at pages you wouldn't share.
- **`compose.yaml` publishes the port on every interface**, so the web page works from other
  devices. To keep it to the local machine, change the port line to `"127.0.0.1:8787:8787"`.
- **It is meant for a few reads a day.** Pages load one at a time, with a pause between
  loads on the same host. A site that refuses it shows up as a `status` of 403, a `refused`
  count, or `found: false`.

## Run it without Docker

```bash
npm install
npm start        # needs a display; listens on 127.0.0.1:8787
```

## Layout

```
server.mjs    HTTP endpoint, the page queue, and the three ways of reading a page
ask.mjs       the Claude call for query mode
index.html    the web page served at /
env.mjs       reads settings from the environment or .env
Dockerfile    two-stage build, about 530 MB
compose.yaml  how to run it
AGENT.md      notes for whoever changes the code next
```
