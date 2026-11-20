// check.mjs: checks a running pagecrawl. `npm run check`, with the service up (npm start or
// docker compose up). Query mode is left out because it costs an API call.
//
// Needs the network: it loads example.com. example.com changes now and then.
// It had no <h1> in November 2026, so the locator here is "p".

import { readEnv } from "./env.mjs";

const BASE = readEnv("PAGECRAWL_URL") ?? `http://127.0.0.1:${readEnv("PAGECRAWL_PORT") ?? 8787}`;
const TOKEN = readEnv("PAGECRAWL_TOKEN") ?? "";

async function read(body, token = TOKEN) {
  const res = await fetch(new URL("/read", BASE), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { code: res.status, body: await res.json().catch(() => ({})) };
}

let failed = 0;
async function check(name, run) {
  try {
    const problem = await run();
    console.log(`${problem ? "FAIL" : "ok  "} ${name}${problem ? `: ${problem}` : ""}`);
    if (problem) failed++;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    failed++;
  }
}
const expect = (cond, detail) => (cond ? null : detail);

const page = "https://example.com/";

await check("locator finds text", async () => {
  const { code, body } = await read({ url: page, locator: "p" });
  return expect(code === 200 && body.found && body.matches >= 1, JSON.stringify(body).slice(0, 200));
});
await check("html mode returns the page", async () => {
  const { code, body } = await read({ url: page, html: true });
  return expect(code === 200 && body.html?.includes("Example Domain"), `status ${code}`);
});
await check("two modes at once is a 400", async () => {
  const { code } = await read({ url: page, locator: "p", html: true });
  return expect(code === 400, `status ${code}`);
});
await check("file:// is a 400", async () => {
  const { code } = await read({ url: "file:///etc/passwd", locator: "body" });
  return expect(code === 400, `status ${code}`);
});
await check("a wrong token is a 401", async () => {
  const { code } = await read("{}", "nope");
  return expect(code === 401, `status ${code}`);
});

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
