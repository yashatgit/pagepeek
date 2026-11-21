// Popup: lists every cookie Brave holds, groups them by site, and exports the ticked ones.
const HOST = "com.pagecrawl.cookies";
const $ = (id) => document.getElementById(id);
const key = (c) => `${c.storeId}|${c.domain}|${c.path}|${c.name}`;

let cookies = [];
const ticked = new Set();
const openGroups = new Set();
const lastVisit = new Map(); // site -> most recent history visit, ms
let nameEdited = false;

function site(domain) {
  const parts = domain.replace(/^\./, "").split(".");
  const n = parts.length >= 3 && parts.at(-1).length === 2 && /^(co|com|org|net|gov|ac)$/.test(parts.at(-2)) ? 3 : 2;
  return parts.slice(-n).join(".");
}

function say(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

function shown() {
  const q = $("q").value.trim().toLowerCase();
  return cookies.filter((c) => !q || c.domain.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
}

function expiry(c) {
  if (c.session || !c.expirationDate) return "session";
  return new Date(c.expirationDate * 1000).toISOString().slice(0, 10);
}

function makeRow(c) {
  const r = document.createElement("label");
  r.className = "row";
  const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: ticked.has(key(c)) });
  cb.addEventListener("change", () => {
    cb.checked ? ticked.add(key(c)) : ticked.delete(key(c));
    render();
  });
  const name = Object.assign(document.createElement("span"), { className: "name", textContent: c.name, title: `${c.domain}${c.path}` });
  const meta = Object.assign(document.createElement("span"), {
    className: "meta",
    textContent: `${c.domain} · ${expiry(c)}${c.httpOnly ? " · httpOnly" : ""}${c.secure ? " · secure" : ""}`,
  });
  r.append(cb, name, meta);
  return r;
}

// Sites with ticked cookies float to the top, still collapsed.
const hasTick = (items) => Number(items.some((c) => ticked.has(key(c))));

function render() {
  const rows = shown();
  const groups = new Map();
  for (const c of rows) {
    const g = site(c.domain);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const list = $("list");
  list.textContent = "";
  for (const [g, items] of [...groups].sort((a, b) => hasTick(b[1]) - hasTick(a[1]) || (lastVisit.get(b[0]) ?? 0) - (lastVisit.get(a[0]) ?? 0) || a[0].localeCompare(b[0]))) {
    const d = document.createElement("details");
    d.className = "group";
    d.open = openGroups.has(g);
    d.addEventListener("toggle", () => (d.open ? openGroups.add(g) : openGroups.delete(g)));
    const s = document.createElement("summary");
    const box = document.createElement("input");
    box.type = "checkbox";
    const on = items.filter((c) => ticked.has(key(c))).length;
    box.checked = on === items.length;
    box.indeterminate = on > 0 && on < items.length;
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      for (const c of items) box.checked ? ticked.add(key(c)) : ticked.delete(key(c));
      render();
    });
    s.append(box, Object.assign(document.createElement("b"), { textContent: g }),
      Object.assign(document.createElement("span"), { className: "count", textContent: `${on}/${items.length}` }));
    d.append(s);
    items.sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0));
    for (const c of items) d.append(makeRow(c));
    list.append(d);
  }
  if (!rows.length) list.append(Object.assign(document.createElement("div"), { className: "muted", style: "padding:10px", textContent: "No cookies match." }));
  if (!nameEdited) $("name").value = autoName();
  $("picked").textContent = `${ticked.size} ticked of ${cookies.length}`;
  for (const id of ["dl", "save", "send"]) $(id).disabled = ticked.size === 0;
}

// cookie-export-<site>, or the sites joined with "+" when the ticks span several.
function autoName() {
  const sites = [...new Set(cookies.filter((c) => ticked.has(key(c))).map((c) => site(c.domain)))].sort();
  return `cookie-export-${sites.length ? sites.join("+") : "site"}`;
}

function payload() {
  const name = $("name").value.trim().replace(/\.json$/i, "").replace(/[^\w.+-]+/g, "-") || "cookie-export";
  const picked = cookies.filter((c) => ticked.has(key(c)));
  return { name, cookies: picked };
}

async function download() {
  const { name, cookies: picked } = payload();
  const bytes = new TextEncoder().encode(JSON.stringify(picked, null, 2));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const id = await chrome.downloads.download({
    url: `data:application/json;base64,${btoa(bin)}`,
    filename: `pagecrawl-cookies/${name}.json`,
    conflictAction: "overwrite",
    saveAs: false,
  });
  say(`Downloaded ${picked.length} cookies to Downloads/pagecrawl-cookies/${name}.json (download ${id}).`, "ok");
}

async function viaHost(action) {
  const { name, cookies: picked } = payload();
  say(action === "send" ? "Saving and copying…" : "Saving…");
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST, { action, name, cookies: picked });
    say(r.message, r.ok ? "ok" : "bad");
  } catch (e) {
    say(`Helper not reachable: ${e.message}\nRun native-host/install.sh once, then reload the extension.`, "bad");
  }
}

$("q").addEventListener("input", render);
$("all").addEventListener("click", () => { for (const c of shown()) ticked.add(key(c)); render(); });
$("none").addEventListener("click", () => { ticked.clear(); render(); });
$("dl").addEventListener("click", () => download().catch((e) => say(e.message, "bad")));
$("save").addEventListener("click", () => viaHost("save"));
$("send").addEventListener("click", () => viaHost("send"));
$("name").addEventListener("input", () => { nameEdited = $("name").value.trim() !== ""; });
$("theme").addEventListener("click", () => {
  const now = document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = now === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  chrome.storage.local.set({ theme: next });
});

(async () => {
  const saved = await chrome.storage.local.get(["theme"]);
  if (saved.theme) document.documentElement.dataset.theme = saved.theme;
  cookies = await chrome.cookies.getAll({});
  const visits = await chrome.history.search({ text: "", startTime: Date.now() - 90 * 864e5, maxResults: 20000 }).catch(() => []);
  for (const v of visits) {
    try {
      const g = site(new URL(v.url).hostname);
      if ((lastVisit.get(g) ?? 0) < v.lastVisitTime) lastVisit.set(g, v.lastVisitTime);
    } catch {}
  }
  say(`${cookies.length} cookies in this profile, sites ordered by most recent visit.`);
  render();
})();
