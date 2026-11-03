# OpenIPC Firmware Flasher (web)

A single static page that flashes OpenIPC firmware without installing anything we have to version.
It never connects to the camera. It picks the firmware and builds two commands:

1. **Upload**, run in the computer's own terminal: `scp -O ~/Downloads/<file>.tgz root@<ip>:/tmp/`.
   `-O` forces legacy SCP; the camera has no SFTP server.
2. **Flash**, pasted into [Secure Shell](https://chromewebstore.google.com/search/secure%20shell)
   (opened from the page with an `ssh://` link). It runs in a subshell and stops before writing if
   the camera's SoC doesn't match or a checksum fails, then runs
   `sysupgrade --force_ver -n -z --kernel=... --rootfs=...`, the same call OpenIPC Companion makes.

Firmware lists come from the latest releases of `OpenIPC/builder` and `OpenIPC/firmware`
(GitHub API, called from the browser). A local `.tgz` can be picked instead; the page unpacks it in
the browser to check it contains a kernel, a rootfs and checksum files.

## Optional helper (Flash button)

`helper/` is a small Rust program that lets the page run SSH itself. It listens on
`ws://127.0.0.1:47811`, accepts only the page at `https://mikecarr.github.io`, and understands five
messages: `hello`, `connect`, `exec`, `upload` (legacy SCP, from a GitHub release URL or bytes the
page sends) and `close`. It has no OpenIPC logic, so flashing changes are still commits to this
repo. When it runs, the page shows a password field, Connect, and a Flash button with progress;
when it doesn't, the page falls back to the copy-and-paste steps.

Run from source (needs Rust): `cd helper && cargo run --release`. Add `--dev` to also accept
pages served from localhost. Prebuilt binaries: push a tag `helper-vX.Y.Z` and the
`Helper release` workflow attaches Mac, Windows and Linux builds to a GitHub release.
The binaries are not code-signed yet, so macOS and Windows will warn on first run.

## Develop

    python3 -m http.server     # then open http://localhost:8000
    npm test                   # unit tests for the command builders (Node 22)

`commands.js` holds everything that ends up on the camera; `app.js` is the page wiring;
`helper-client.js` talks to the helper. Helper tests: `cd helper && cargo test`.

## Deploy

Every push to `main` runs the tests and publishes to GitHub Pages
(`.github/workflows/pages.yml`). One-time setup: Settings → Pages → Source: **GitHub Actions**.

## Flash behaviour to expect

A flash wipes the camera's saved settings (`sysupgrade -n`), on purpose. Newer firmware moves
`sysupgrade` into RAM before writing, which ends SSH: the page then can't show progress, and says
to keep the camera powered until it reboots by itself. A dropped connection only counts as finished
if the output reached the end of the flash.

## Not covered yet

- Companion's fallback for cameras whose kernel can't mount the new rootfs (`flashcp` per partition).
- Bootloader replacement and MTD backup/restore.
- Assumes `tar -z` and `md5sum -c` in the camera's BusyBox, and enough RAM in `/tmp` for the
  archive plus its unpacked files (the archive is deleted right after unpacking).
