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
- Cameras have no SFTP server: uploads must use legacy SCP (`scp -O` on the PC, `scp -t` remote).
- Read variables with `fw_printenv NAME | sed 's/^[^=]*=//'`, which works with or without `-n`.
  The failure that prompted this came from a bug in the test VM's mock; a real camera supports `-n`.
- Flash sequence mirrors Companion's SysUpgradeService: SoC check, unpack in /tmp/fw,
  `md5sum -c`, `sysupgrade --force_ver -n -z --kernel=... --rootfs=...`. `-n` wipes the overlay
  (saved settings) on every flash; this is deliberate, so keep it. An SSH drop only means success
  if the output reached the rootfs verify or the reboot line (`FlashTracker`, `flashOutcome`).
- Newer sysupgrade (seen on 2.6.11.02 NOR) moves into RAM before writing when the camera has
  `pivot_root` and `::restart:/sbin/init`: SSH ends with no writes done and no progress reaches the
  page. It streams its log over plain HTTP on port 80 instead. Don't power off after that drop.
- `mtdparts` can use U-Boot variables for sizes, e.g. `${rootmtd}(rootfs)`.
- Real cameras may have no `sensor` variable in the environment; the info line falls back to the
  loaded `sensor_*` driver in `lsmod`.
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
