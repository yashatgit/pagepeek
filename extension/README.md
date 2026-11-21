# Pagecrawl cookies (Brave extension)

Lists every cookie in the browser profile, sites ordered by most recent browsing-history visit (the cookie API has no last-used time). Files are named `cookie-export-<site>` automatically; edit the name field to override. Tick the ones you want, then:

- **Download**: saves `cookie-export-<site>.json` to `Downloads/pagecrawl-cookies/` (browser downloads can only use a Downloads subfolder).
- **Save to folder**: writes it to `cookiestore/` in this repo, through the native helper.
- **Send to pagecrawl**: pipes the cookies straight into the service's `cookiestore/` folder over SSH. The service loads it on its next read, no restart.

## Install

1. `./native-host/install.sh` once. It registers the helper with Brave and creates `native-host/config.json` (edit `ssh_host` and `remote_dir`; the file is gitignored).
2. Brave: `brave://extensions`, turn on Developer mode, Load unpacked, pick this `extension/` folder. The ID is fixed by `manifest.json` and must match `native-host/extension-id.txt`.

Cookie files are secrets: they carry logged-in sessions. `cookiestore/` is gitignored; keep it that way.
