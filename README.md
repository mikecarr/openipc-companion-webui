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

## Develop

    python3 -m http.server     # then open http://localhost:8000
    npm test                   # unit tests for the command builders (Node 22)

`commands.js` holds everything that ends up on the camera; `app.js` is the page wiring.

## Deploy

Every push to `main` runs the tests and publishes to GitHub Pages
(`.github/workflows/pages.yml`). One-time setup: Settings → Pages → Source: **GitHub Actions**.

## Not covered yet

- Companion's fallback for cameras whose kernel can't mount the new rootfs (`flashcp` per partition).
- Bootloader replacement and MTD backup/restore.
- Assumes `tar -z` and `md5sum -c` in the camera's BusyBox, and enough RAM in `/tmp` for the
  archive plus its unpacked files (the archive is deleted right after unpacking).
