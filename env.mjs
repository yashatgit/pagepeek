// env.mjs: settings come from the real environment first, then from a .env file next to
// this one. Docker Compose passes them as environment variables; a local run reads .env.

import fs from "node:fs";

function loadFile() {
  let text;
  try {
    text = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

const FILE_ENV = loadFile();

// An empty value counts as unset, so `KEY=` in .env behaves like a missing line.
export const readEnv = (key) => process.env[key] || FILE_ENV[key] || undefined;
