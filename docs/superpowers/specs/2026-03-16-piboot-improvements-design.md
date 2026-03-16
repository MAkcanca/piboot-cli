# piboot improvements — design spec

**Date:** 2026-03-16
**Scope:** Bug fixes, robustness, quality-of-life features
**Runtime:** Deno (standardize, remove bun artifacts)
**Target:** Opinionated for Proxmox/Debian 13 with ens18 (WAN) / ens19 (LAN)

---

## 1. Deno standardization

- Remove `bun.lock`, `package.json`, bun types from `tsconfig.json`
- Replace with `deno.json`: tasks (`start`, `compile`), compiler options
- Shebang: `#!/usr/bin/env -S deno run --allow-all`
- Deno resolves `node:fs`, `node:child_process` natively — no `node_modules`
- Update README install instructions to Deno-only
- Tasks: `"start": "deno run --allow-all src/cli.ts"`, `"compile": "deno compile --allow-all -o piboot src/cli.ts"`

## 2. Networking fix

Bug: `piboot init` writes systemd-networkd files to `/etc/systemd/network/`, but netplan overrides them. The LAN interface loses its static IP on reboot, breaking DHCP/TFTP.

Fix:
- Detect netplan: `ls /etc/netplan/*.yaml`
- If netplan: write `/etc/netplan/50-piboot.yaml` with static LAN IP, `chmod 600`, `netplan apply`
- If no netplan: use current systemd-networkd approach
- Always do `ip addr add` for immediate effect
- Remove blind `networkctl reload` + `sleep(2000)` — replace with IP presence check

## 3. Input validation

New `validate.ts` module. Pre-flight checks before `init` and `add`:

- Serial: exactly 8 hex characters
- MAC: `xx:xx:xx:xx:xx:xx` format
- IP: within configured subnet
- Interface exists: `ip link show` check for `--lan-if` and `--wan-if`
- Hostname: no spaces/special characters, reasonable length
- Duplicate check: serial, MAC, hostname, IP not already used by another node

All checks run upfront before side effects. Human-readable error messages.

## 4. `piboot doctor`

Diagnostic command that checks server health with actionable fix suggestions:

- LAN interface has expected IP
- dnsmasq running + config valid (`dnsmasq --test`)
- NFS server running
- NFS exports match all nodes
- TFTP dirs exist per node (with `cmdline.txt` and kernel image)
- NFS roots exist per node (with basic structure)
- IP forwarding enabled
- NAT/MASQUERADE iptables rule present

Output: green checkmark for pass, red X with explanation and suggested fix.

## 5. `piboot ssh <hostname>`

Looks up node IP from config, execs `ssh pi@<ip>`. Supports extra args:

```
piboot ssh rpi5-01
piboot ssh rpi5-01 -- -L 8080:localhost:80
```

Errors clearly if hostname not found.

## 6. Idempotency for `init`

- dnsmasq.conf: Write full file from config state (not append)
- `/etc/exports`: Regenerate from full node list (not append)
- iptables: Check before adding (`iptables -C` before `iptables -A`) consistently
- Image download: Already idempotent — no change
- Node extraction: If NFS root exists, warn and skip; suggest `piboot reset`

`init` becomes safe to re-run without accumulating duplicates.

## 7. Error handling

- Wrap key operations (mount, rsync, exportfs, systemctl) with descriptive messages explaining what was attempted and what to check
- Global error handler in `cli.ts` that prints clean messages; `--verbose` flag for full stack traces
- Non-zero exit codes on all error paths via `log.fail`

## File structure (after changes)

```
src/
  cli.ts        — CLI entry point, flag parsing, global error handler
  commands.ts   — init, add, reset, remove, list, status, logs, doctor, ssh
  config.ts     — config types, load/save, path helpers
  shell.ts      — shell execution helpers (unchanged)
  validate.ts   — input validation functions (new)
  network.ts    — network configuration (netplan detection + setup) (new)
deno.json       — replaces package.json + tsconfig.json
README.md       — updated for Deno
```
