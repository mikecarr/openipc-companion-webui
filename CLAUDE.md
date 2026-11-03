# CLAUDE.md

Web firmware flasher for OpenIPC cameras, a lighter alternative to the OpenIPC Companion
desktop app (C#/Avalonia, Mike's checkout at ~/RiderProjects/companion). Goal: the minimum on
the user's machine; logic lives in this repo and deploys from GitHub.

## Layout
- `index.html`, `app.js`, `style.css`: static page (no build step), GitHub Pages.
- `commands.js`: pure functions for everything that runs on the camera (info line, flash
  command, scp command, fw_printenv parsing, firmware filtering). Unit tested.
- `helper-client.js`: talks to the optional local helper.
- `helper/`: Rust helper (`openipc-helper`), WebSocket on `ws://127.0.0.1:47811`, accepts only
  origin `https://mikecarr.github.io` (`--dev` adds localhost). Messages: hello, connect, exec
  (streamed), upload (legacy SCP `scp -t`, from a GitHub release URL or page bytes), close.
  No OpenIPC logic in it on purpose.
- `scripts/build-sensor-index.mjs`: builds `sensors.json` from OpenIPC/builder exclude lists at
  deploy time (sensor filter).

## Commands
- `npm test` (Node 22 `node --test`), `cd helper && cargo test`
- Dev: `python3 -m http.server` + `cd helper && cargo run -- --dev`
- Deploy: push to `main` (Pages workflow; also daily cron). Helper binaries: push tag `helper-v*`.

## Camera facts (learned the hard way)
- BusyBox `tar` on cameras may have no `-z`: unpack with `gzip -dc FILE | tar -xf -`.
- Cameras have no SFTP server: uploads must use legacy SCP (`scp -O` on the PC, `scp -t` remote).
- Read variables with `fw_printenv NAME | sed 's/^[^=]*=//'`, which works with or without `-n`.
  The failure that prompted this came from a bug in the test VM's mock; a real camera supports `-n`.
- Flash sequence mirrors Companion's SysUpgradeService: SoC check, unpack in /tmp/fw,
  `md5sum -c`, `sysupgrade --force_ver -n -z --kernel=... --rootfs=...`. `-n` wipes the overlay
  (saved settings) on every flash; this is deliberate, so keep it. An SSH drop only means success
  if the output reached the rootfs verify or the reboot line (`FlashTracker`, `flashOutcome`).
- `sysupgrade -n` leaves firmware built since 30 Aug 2026 unclaimed: no root password, no default,
  and `/setup.html` on port 80. Commands and scp are refused until claimed. The helper's password
  login just fails, so it can't tell this from a wrong password.
- Newer sysupgrade (seen on 2.6.11.02 NOR) moves into RAM before writing when the camera has
  `pivot_root` and `::restart:/sbin/init`: SSH ends with no writes done and no progress reaches the
  page. It streams its log over plain HTTP on port 80 instead. Don't power off after that drop.
- On nightly 2.6.11.02 NOR, Majestic listens on ports 80 and 554 and runs the web UI's CGI scripts
  in `/var/www/cgi-bin`. The web UI can flash by itself (`update.cgi`). Forks can differ: a
  `gilankpam` build ran `maburd` with no Majestic.
- A real flash from the page has worked end to end on a real camera: upload, RAM handoff, reboot,
  claim, log back in (ssc338q NOR, to `nightly-20261102-8cfa8f9`).
- `mtdparts` can use U-Boot variables for sizes, e.g. `${rootmtd}(rootfs)`.
- Real cameras may have no `sensor` variable in the environment; the info line falls back to the
  loaded `sensor_*` driver in `lsmod`.
- Firmware sources match Companion's defaults (`FIRMWARE_SOURCES` in `commands.js`). The helper only
  downloads GitHub release files, so the page fetches Greg APFPV's repository files itself.
- Firmware file names carry SoC and NOR/NAND, not sensor; sensor support comes from
  OpenIPC/builder `devices/*/general/scripts/excludes/*.list`.
- Mike's test VM acting as a camera: 10.0.0.169 (Ubuntu, OpenSSH not Dropbear, no /sys/class/mtd).
  Mock source is in `~/workspace` there (`fw_printenv-cli`, `sysupgrade-sim`). Env comes from
  `~/.fw_env`; `/usr/local/bin/sysupgrade` wraps `sysupgrade.real` and then drops the SSH session.

## Not done yet
- Companion's flashcp fallback when the kernel can't mount the new rootfs.
- Bootloader replacement, MTD backup/restore, other Companion tabs (WFB next).
- Signed helper binaries; Chrome extension + native messaging packaging (optional).
- Plan/estimate docs: https://claude.ai/artifact/7WcyrVrhPP1pesg7vtFxeG
