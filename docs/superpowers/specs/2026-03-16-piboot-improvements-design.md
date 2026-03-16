# piboot improvements — design spec

**Date:** 2026-03-16
**Scope:** Bug fixes, robustness, quality-of-life features
**Runtime:** Deno (standardize, remove bun artifacts)
**Target:** Opinionated for Proxmox/Debian 13 with ens18 (WAN) / ens19 (LAN)

---

## 1. Deno standardization

- Remove `bun.lock`, `package.json`, `tsconfig.json`
- Replace with `deno.json`: tasks (`start`, `compile`), compiler options
- Shebang already correct (`#!/usr/bin/env -S deno run --allow-all`) — no change needed
- Deno resolves `node:fs`, `node:child_process` natively — no `node_modules`
- Update README install instructions to Deno-only
- Tasks: `"start": "deno run --allow-all src/cli.ts"`, `"compile": "deno compile --allow-all -o piboot src/cli.ts"`

## 2. Networking fix

Bug: `piboot init` writes systemd-networkd files to `/etc/systemd/network/`, but netplan overrides them. The LAN interface loses its static IP on reboot, breaking DHCP/TFTP.

Fix — extract networking into `network.ts` with two branches:

**If netplan detected** (`/etc/netplan/*.yaml` exists):
- Write `/etc/netplan/50-piboot.yaml` with both LAN (static) and WAN (DHCP) interface configs, `chmod 600`, `netplan apply`
- **Skip** writing systemd-networkd files entirely (no `10-wan.network`, `20-lan.network`)
- WAN config needed because the default netplan wildcard `en*` would conflict with the explicit LAN entry — piboot must own both interfaces to avoid ambiguity

**If no netplan:**
- Use current systemd-networkd approach (write to `/etc/systemd/network/`)

**Both paths:**
- `ip addr add` for immediate effect
- Replace blind `networkctl reload` + `sleep(2000)` with a verification loop: check `ip addr show <lan_if>` for the expected IP, retry up to 5 times with 1s delay, fail with actionable message

## 3. Input validation

New `validate.ts` module. Pre-flight checks before `init` and `add`:

- Serial: exactly 8 hex characters
- MAC: `xx:xx:xx:xx:xx:xx` format (case-insensitive hex)
- IP: must start with `config.lan_subnet` prefix and last octet must be 1-254 (simple prefix check — we only support /24)
- IP must not fall within the DHCP dynamic range (default 100-200)
- Interface exists: `ip link show` check for `--lan-if` and `--wan-if`
- Hostname: alphanumeric + hyphens, 1-63 characters, no leading/trailing hyphen
- Duplicate check: serial, MAC, hostname, IP not already used by another node in `config.nodes`

The existing hostname duplicate check in `cli.ts` `addNode` case is replaced by the validate module (single source of truth). All checks run upfront before side effects. Human-readable error messages via `log.fail`.

## 4. `piboot doctor`

Diagnostic command that checks server health with actionable fix suggestions. Loads config and iterates `config.nodes`.

Checks:
- LAN interface has expected IP
- dnsmasq running + config valid (`dnsmasq --test`)
- NFS server running
- NFS exports match all configured nodes
- TFTP dirs exist per node (with `cmdline.txt` and kernel image)
- NFS roots exist per node (with basic structure: `etc/`, `bin/`)
- IP forwarding enabled (`sysctl net.ipv4.ip_forward`)
- NAT/MASQUERADE iptables rule present
- Orphan detection: TFTP/NFS dirs that exist but have no matching config entry (warns, suggests `piboot remove`)

Output: green checkmark for pass, red X with explanation and suggested fix.

Requires root (uses systemctl, iptables, reads config).

## 5. `piboot ssh <hostname>`

Looks up node IP from config, execs `ssh pi@<ip>`.

Flag parser (`parseFlags`) must handle `--` as a stop-parsing sentinel. Everything after `--` is collected into a `_extra` array and passed through to SSH.

```
piboot ssh rpi5-01
piboot ssh rpi5-01 -- -L 8080:localhost:80
```

Does not require root — config file permissions loosened to `644` (it contains no secrets, just hostnames/IPs/MACs). This also benefits `piboot list` which currently works without root.

Errors clearly if hostname not found.

## 6. Idempotency for `init` and `add`

The core issue: `init` already writes full files (dnsmasq.conf, /etc/exports), but `addNode` appends to them. Both should regenerate from config state.

Extract two helpers:
- `writeDnsmasqConf(config)`: Generates full `/etc/dnsmasq.conf` from `config` and `config.nodes`
- `writeNfsExports(config)`: Generates full `/etc/exports` from `config` and `config.nodes`

Both `init` and `addNode` call these helpers after updating `config.nodes`.

**iptables fix:** Current code does `$try(iptables -C ...)` but ignores the result and unconditionally does `$try(iptables -A ...)`. Fix: use the exit code from `-C` to conditionally skip `-A`. Implement as a helper: `async function ensureIptablesRule(args: string)` that checks then adds.

**Node extraction:** If NFS root already exists for the node, warn and skip; suggest `piboot reset`.

## 7. Error handling

- `cli.ts` main switch wrapped in try/catch global handler
- On catch: print `log.fail`-style message with the error's `.message`
- `--verbose` flag: parsed early in `cli.ts` before command dispatch, stored as a boolean. When true, the global handler also prints the full stack trace
- `log.fail` refactored: instead of calling `process.exit(1)` directly, it throws a `PibootError` class. The global handler catches it and exits cleanly. This lets `log.fail` be used in deeply nested code without bypassing cleanup
- Key operations (mount, rsync, exportfs) wrapped with contextual messages in a helper: `async function withContext(description: string, fn: () => Promise<void>)` that catches and re-throws with the description prepended

## File structure (after changes)

```
src/
  cli.ts        — CLI entry point, flag parsing, global error handler, --verbose
  commands.ts   — init, add, reset, remove, list, status, logs, doctor, ssh
  config.ts     — config types, load/save, path helpers (config file chmod 644)
  shell.ts      — shell execution helpers, withContext helper
  validate.ts   — input validation functions (new)
  network.ts    — netplan/networkd detection and configuration (new)
deno.json       — replaces package.json + tsconfig.json
README.md       — updated for Deno
```
