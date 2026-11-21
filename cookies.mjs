// cookies.mjs: loads browser cookies from JSON files into the page-reading session, so pages
// that need a login or a remembered region load as that visitor would see them.
//
// Every *.json file in PAGECRAWL_COOKIES_DIR holds an array of cookies in the shape of Chrome's
// chrome.cookies.getAll(): name, value, domain, path, secure, httpOnly, sameSite,
// expirationDate (seconds), hostOnly. A file is read again when its modification time
// changes, so copying a fresh export into the folder needs no restart. Deleting a file does
// not remove its cookies from the running session.

import fs from "node:fs";
import path from "node:path";

const SAME_SITE = new Set(["no_restriction", "lax", "strict", "unspecified"]);
const seen = new Map(); // file path -> mtimeMs last loaded

function toElectron(c) {
  const host = String(c.domain ?? "").replace(/^\./, "");
  if (!host || !c.name) return null;
  const cookie = {
    url: `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`,
    name: c.name,
    value: String(c.value ?? ""),
    path: c.path || "/",
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: SAME_SITE.has(c.sameSite) ? c.sameSite : "unspecified",
  };
  if (!c.hostOnly) cookie.domain = String(c.domain).startsWith(".") ? c.domain : `.${c.domain}`;
  if (!c.session && c.expirationDate) cookie.expirationDate = c.expirationDate;
  return cookie;
}

// Returns how many cookies were set from files that changed since the last call.
export async function syncCookies(ses, dir) {
  if (!dir) return 0;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return 0; // no folder yet
  }
  let set = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const mtime = fs.statSync(file).mtimeMs;
    if (seen.get(file) === mtime) continue;
    seen.set(file, mtime);
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(list)) throw new Error("not an array");
    } catch (e) {
      console.error(`cookies: skipping ${name}: ${e.message}`);
      continue;
    }
    for (const c of list) {
      const cookie = toElectron(c);
      if (!cookie) continue;
      try {
        await ses.cookies.set(cookie);
        set++;
      } catch (e) {
        console.error(`cookies: ${name}: ${c.name} on ${c.domain}: ${e.message}`);
      }
    }
    console.log(`cookies: loaded ${name} (${list.length} cookies)`);
  }
  return set;
}
