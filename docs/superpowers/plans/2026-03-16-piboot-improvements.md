# piboot Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make piboot robust, idempotent, and self-diagnosable — fix the netplan networking bug, add input validation, doctor command, ssh shortcut, and standardize on Deno.

**Architecture:** piboot is a single CLI tool (~4 source files) that manages Raspberry Pi netboot on a Debian 13 Proxmox VM. Changes add 2 new modules (`validate.ts`, `network.ts`), refactor error handling in `shell.ts`, and update `cli.ts`/`commands.ts` for new commands and idempotency. No external dependencies beyond Deno + node: builtins.

**Tech Stack:** Deno, TypeScript, node:fs/node:child_process compat, systemd/netplan/dnsmasq/NFS on Debian 13.

**Spec:** `docs/superpowers/specs/2026-03-16-piboot-improvements-design.md`

---

## Chunk 1: Foundation (Deno, error handling, validation)

### Task 1: Deno standardization

**Files:**
- Delete: `package.json`, `tsconfig.json`, `bun.lock`
- Create: `deno.json`
- Modify: `README.md` (install section)

- [ ] **Step 1: Create `deno.json`**

```json
{
  "tasks": {
    "start": "deno run --allow-all src/cli.ts",
    "compile": "deno compile --allow-all -o piboot src/cli.ts"
  },
  "compilerOptions": {
    "strict": true
  }
}
```

- [ ] **Step 2: Delete bun/node artifacts**

```bash
rm package.json tsconfig.json bun.lock
rm -rf node_modules
```

- [ ] **Step 3: Verify Deno can parse the project**

Run: `deno check src/cli.ts`
Expected: No errors (Deno supports `node:fs`, `node:child_process`, `node:path` natively)

- [ ] **Step 4: Update README.md install section**

Replace the Install section. Remove bun/tsx references. Keep it Deno-only:

```markdown
## Install

\`\`\`bash
# Install Deno (if not present)
curl -fsSL https://deno.land/install.sh | sh

# Clone / copy the project
cd /opt/piboot

# Create wrapper script
cat > /usr/local/bin/piboot << 'EOF'
#!/bin/sh
exec deno run --allow-all /opt/piboot/src/cli.ts "$@"
EOF
chmod +x /usr/local/bin/piboot

# Run
sudo piboot <command>
\`\`\`

Optionally compile to a single binary:

\`\`\`bash
deno compile --allow-all -o piboot src/cli.ts
cp piboot /usr/local/bin/piboot
\`\`\`
```

Also update the Requirements section to remove the `Deno runtime (curl ...)` line since the install section covers it, and replace with just:
```markdown
## Requirements

- Debian 13 (Trixie) — fresh install
- Two network interfaces (`ens18` WAN, `ens19` LAN)
- [Deno](https://deno.land) runtime
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: standardize on Deno, remove bun artifacts"
```

---

### Task 2: Error handling — PibootError and global handler

**Files:**
- Modify: `src/shell.ts` — add `PibootError` class, refactor `log.fail`, add `withContext`
- Modify: `src/cli.ts` — add `--verbose` flag parsing, global try/catch

- [ ] **Step 1: Add `PibootError` class to `shell.ts`**

Add after the color constants (before `export const log`):

```typescript
export class PibootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PibootError";
  }
}
```

- [ ] **Step 2: Refactor `log.fail` to throw instead of exit**

Replace the `fail` method in the `log` object:

```typescript
  fail: (...args: unknown[]): never => {
    throw new PibootError(args.map(String).join(" "));
  },
```

- [ ] **Step 3: Add `withContext` helper to `shell.ts`**

Add after the `sleep` function:

```typescript
export async function withContext<T>(description: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PibootError(`${description}: ${msg}`);
  }
}
```

- [ ] **Step 4: Add global error handler and `--verbose` to `cli.ts`**

Replace the main execution block in `cli.ts`. After `const flags = parseFlags(rest);` and before the `switch`, add verbose extraction. Wrap the entire `switch` in a try/catch:

```typescript
const verbose = flags.verbose === "true";
// Remove verbose from flags so it doesn't interfere with commands
delete flags.verbose;

try {
  switch (command) {
    // ... all existing cases unchanged ...
  }
} catch (err) {
  if (err instanceof PibootError) {
    console.error(`${RED}[FAIL]${NC}  ${err.message}`);
    if (verbose) console.error(err.stack);
    process.exit(1);
  }
  // Unexpected errors always show stack
  console.error(`${RED}[FAIL]${NC}  Unexpected error:`, err);
  process.exit(2);
}
```

Import `PibootError` from `./shell` at the top of `cli.ts`. Also import `RED` and `NC` color constants — or better, export a `colors` object from shell.ts. Simplest: just import `PibootError` and use a plain `console.error` without colors for the global handler:

```typescript
import { loadConfig, type PiNode } from "./config";
import { log, requireRoot, PibootError } from "./shell";
```

For the catch block, use log methods instead of raw colors:

```typescript
} catch (err) {
  if (err instanceof PibootError) {
    console.error(`\x1b[0;31m[FAIL]\x1b[0m  ${err.message}`);
    if (verbose) console.error(err.stack);
    process.exit(1);
  }
  console.error(`\x1b[0;31m[FAIL]\x1b[0m  Unexpected error:`, err);
  process.exit(2);
}
```

- [ ] **Step 5: Update HELP text to mention --verbose**

Add to the HELP string after the COMMANDS section:

```
\x1b[1mGLOBAL OPTIONS\x1b[0m
  --verbose  Show full stack traces on error
```

- [ ] **Step 6: Update HELP text to mention new commands**

Add `doctor`, `ssh` to the COMMANDS list in HELP:

```
  doctor   Diagnose common server issues
  ssh      SSH into a node (piboot ssh <hostname>)
```

- [ ] **Step 7: Commit**

```bash
git add src/shell.ts src/cli.ts
git commit -m "feat: add PibootError, global error handler, --verbose flag"
```

---

### Task 3: Input validation module

**Files:**
- Create: `src/validate.ts`
- Modify: `src/cli.ts` — call validation before init/add

- [ ] **Step 1: Create `src/validate.ts`**

```typescript
import { type Config, type PiNode } from "./config";
import { $quiet, PibootError } from "./shell";

export function validateSerial(serial: string): void {
  if (!/^[0-9a-fA-F]{8}$/.test(serial)) {
    throw new PibootError(
      `Invalid serial "${serial}" — must be exactly 8 hex characters (e.g. a1b2c3d4)`
    );
  }
}

export function validateMac(mac: string): void {
  if (!/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(mac)) {
    throw new PibootError(
      `Invalid MAC "${mac}" — must be xx:xx:xx:xx:xx:xx format (e.g. dc:a6:32:01:02:03)`
    );
  }
}

export function validateHostname(hostname: string): void {
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(hostname)) {
    throw new PibootError(
      `Invalid hostname "${hostname}" — alphanumeric + hyphens, 1-63 chars, no leading/trailing hyphen`
    );
  }
}

export function validateIp(ip: string, config: Config): void {
  if (!ip.startsWith(config.lan_subnet + ".")) {
    throw new PibootError(
      `IP "${ip}" is not in subnet ${config.lan_subnet}.0/24`
    );
  }
  const lastOctet = parseInt(ip.split(".")[3], 10);
  if (isNaN(lastOctet) || lastOctet < 1 || lastOctet > 254) {
    throw new PibootError(
      `IP "${ip}" has invalid last octet — must be 1-254`
    );
  }

  // Warn if IP is in DHCP dynamic range
  const rangeStart = parseInt(config.dhcp_range_start.split(".")[3], 10);
  const rangeEnd = parseInt(config.dhcp_range_end.split(".")[3], 10);
  if (lastOctet >= rangeStart && lastOctet <= rangeEnd) {
    throw new PibootError(
      `IP "${ip}" falls within DHCP dynamic range (${config.dhcp_range_start}–${config.dhcp_range_end}). Use a static IP outside this range.`
    );
  }
}

export async function validateInterface(name: string): Promise<void> {
  const result = await $quiet(`ip link show "${name}" 2>&1`).catch(() => "");
  if (!result || result.includes("does not exist")) {
    throw new PibootError(
      `Network interface "${name}" does not exist. Check with: ip link show`
    );
  }
}

export function validateNoDuplicates(node: PiNode, config: Config): void {
  for (const existing of config.nodes) {
    if (existing.serial === node.serial) {
      throw new PibootError(
        `Serial "${node.serial}" already in use by node "${existing.hostname}"`
      );
    }
    if (existing.mac.toLowerCase() === node.mac.toLowerCase()) {
      throw new PibootError(
        `MAC "${node.mac}" already in use by node "${existing.hostname}"`
      );
    }
    if (existing.hostname === node.hostname) {
      throw new PibootError(
        `Hostname "${node.hostname}" already in use`
      );
    }
    if (existing.ip === node.ip) {
      throw new PibootError(
        `IP "${node.ip}" already in use by node "${existing.hostname}"`
      );
    }
  }
}

export async function validateNode(node: PiNode, config: Config): Promise<void> {
  validateSerial(node.serial);
  validateMac(node.mac);
  validateHostname(node.hostname);
  validateIp(node.ip, config);
  validateNoDuplicates(node, config);
}

export async function validateInterfaces(config: Config): Promise<void> {
  await validateInterface(config.lan_if);
  await validateInterface(config.wan_if);
}
```

- [ ] **Step 2: Wire validation into `cli.ts`**

Import at top of `cli.ts`:

```typescript
import { validateNode, validateInterfaces } from "./validate";
```

In the `init` case, after the node object is created and before `await init(config, node)`:

```typescript
    await validateNode(node, config);
    await validateInterfaces(config);
```

In the `add` case, replace the existing hostname duplicate check with:

```typescript
    await validateNode(node, config);
```

(This replaces the `if (config.nodes.find(...))` block since `validateNoDuplicates` covers it.)

- [ ] **Step 3: Verify Deno can parse**

Run: `deno check src/cli.ts`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/validate.ts src/cli.ts
git commit -m "feat: add input validation for serial, MAC, hostname, IP, duplicates"
```

---

## Chunk 2: Networking fix and idempotency

### Task 4: Network configuration module

**Files:**
- Create: `src/network.ts`
- Modify: `src/commands.ts` — replace inline networking code in `init` with `configureNetwork` call

- [ ] **Step 1: Create `src/network.ts`**

```typescript
import { existsSync, writeFileSync, readdirSync, chmodSync } from "node:fs";
import { type Config } from "./config";
import { $, $try, $quiet, log, sleep, PibootError } from "./shell";

function hasNetplan(): boolean {
  try {
    const files = readdirSync("/etc/netplan");
    return files.some((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return false;
  }
}

async function configureNetplan(config: Config): Promise<void> {
  log.info("Detected netplan — writing /etc/netplan/50-piboot.yaml");

  const yaml = `network:
    version: 2
    ethernets:
        ${config.lan_if}:
            dhcp4: false
            dhcp6: false
            addresses:
                - ${config.lan_ip}/24
        ${config.wan_if}:
            dhcp4: true
            dhcp4-overrides:
                use-domains: true
            dhcp6: true
            dhcp6-overrides:
                use-domains: true
`;

  writeFileSync("/etc/netplan/50-piboot.yaml", yaml);
  chmodSync("/etc/netplan/50-piboot.yaml", 0o600);
  await $(`netplan apply`, { silent: true });
}

async function configureNetworkd(config: Config): Promise<void> {
  log.info("No netplan — writing systemd-networkd config");
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/etc/systemd/network", { recursive: true });

  writeFileSync("/etc/systemd/network/10-wan.network",
`[Match]
Name=${config.wan_if}

[Network]
DHCP=yes
`);

  writeFileSync("/etc/systemd/network/20-lan.network",
`[Match]
Name=${config.lan_if}

[Network]
Address=${config.lan_ip}/24
DHCPServer=false
`);

  await $(`systemctl enable --now systemd-networkd`);
  await $try(`networkctl reload`);
}

async function verifyLanIp(config: Config): Promise<void> {
  // Ensure IP is assigned immediately
  await $try(`ip addr add ${config.lan_ip}/24 dev ${config.lan_if} 2>/dev/null`);
  await $(`ip link set ${config.lan_if} up`);

  // Verify with retries
  for (let i = 0; i < 5; i++) {
    const out = await $quiet(`ip addr show ${config.lan_if}`);
    if (out.includes(`inet ${config.lan_ip}/`)) {
      log.info(`${config.lan_if} → ${config.lan_ip}/24`);
      return;
    }
    await sleep(1000);
  }
  throw new PibootError(
    `Failed to assign ${config.lan_ip} to ${config.lan_if} after 5 attempts. ` +
    `Check interface status: ip addr show ${config.lan_if}`
  );
}

export async function configureNetwork(config: Config): Promise<void> {
  if (hasNetplan()) {
    await configureNetplan(config);
  } else {
    await configureNetworkd(config);
  }
  await verifyLanIp(config);
}
```

- [ ] **Step 2: Replace networking code in `commands.ts` `init` function**

Import at top of `commands.ts`:

```typescript
import { configureNetwork } from "./network";
```

Replace step 2 in `init` (lines 155-181, from `log.step(2, ...)` through `log.info(...lan_if...)`) with:

```typescript
  // ── 2. Network ──
  log.step(2, `Configuring static IP on ${config.lan_if}`);
  await configureNetwork(config);
```

- [ ] **Step 3: Verify Deno can parse**

Run: `deno check src/cli.ts`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/network.ts src/commands.ts
git commit -m "fix: detect netplan and write proper persistent network config"
```

---

### Task 5: Idempotency — config-driven dnsmasq and NFS exports

**Files:**
- Modify: `src/commands.ts` — extract `writeDnsmasqConf`, `writeNfsExports`, `ensureIptablesRule`; refactor `init` and `addNode`

- [ ] **Step 1: Add `writeDnsmasqConf` helper**

Add to `commands.ts` in the shared helpers section (after `fstab` function):

```typescript
function writeDnsmasqConf(config: Config): void {
  const nodeLeases = config.nodes
    .map((n) => `dhcp-host=${n.mac},${n.ip},${n.hostname},infinite`)
    .join("\n");

  writeFileSync("/etc/dnsmasq.conf",
`# ── Interface ────────────────────────────────
interface=${config.lan_if}
bind-interfaces
except-interface=lo

# ── DNS (forward upstream) ───────────────────
server=1.1.1.1
server=8.8.8.8

# ── DHCP ─────────────────────────────────────
dhcp-range=${config.dhcp_range_start},${config.dhcp_range_end},${config.lan_mask},${config.dhcp_lease}
dhcp-option=option:router,${config.lan_ip}
dhcp-option=option:dns-server,${config.lan_ip}

# ── Static leases ────────────────────────────
${nodeLeases}

# ── TFTP / PXE (Raspberry Pi netboot) ───────
enable-tftp
tftp-root=${config.tftp_root}
pxe-service=0,"Raspberry Pi Boot"

# ── Logging ──────────────────────────────────
log-dhcp
log-facility=/var/log/dnsmasq.log
`);
}
```

- [ ] **Step 2: Add `writeNfsExports` helper**

```typescript
function writeNfsExports(config: Config): void {
  const entries = config.nodes.flatMap((n) => {
    const nfs = nfsDir(config, n.hostname);
    const tftp = tftpDir(config, n.serial);
    return [
      `${nfs}   ${config.lan_subnet}.0/24(rw,sync,no_subtree_check,no_root_squash)`,
      `${tftp}  ${config.lan_subnet}.0/24(rw,sync,no_subtree_check,no_root_squash)`,
    ];
  });

  writeFileSync("/etc/exports",
`# Netboot exports — managed by piboot
${entries.join("\n")}
`);
}
```

- [ ] **Step 3: Add `ensureIptablesRule` helper**

```typescript
async function ensureIptablesRule(rule: string): Promise<void> {
  const exists = await $try(`iptables -C ${rule}`);
  // $try returns empty string on failure; check exit wasn't successful
  // by re-checking — if -C succeeded, exists will have some output or no error
  const check = await $try(`iptables -C ${rule} 2>&1; echo $?`);
  if (check.trim().endsWith("0")) return; // rule already exists
  await $(`iptables -A ${rule}`);
}
```

Actually, simpler approach — `$try` returns stdout but we need the exit code. Better to use a dedicated check:

```typescript
async function ensureIptablesRule(rule: string): Promise<void> {
  const result = await $try(`iptables -C ${rule} 2>/dev/null && echo EXISTS`);
  if (result.trim() === "EXISTS") return;
  await $(`iptables -A ${rule}`);
}
```

- [ ] **Step 4: Refactor `init` to use helpers**

In the `init` function:

Replace the dnsmasq config section (step 4, the `writeFileSync("/etc/dnsmasq.conf", ...)` block). Since `config.nodes` doesn't have the first node yet at this point in `init`, we need to push the node first, then write. Restructure init:

Move `config.nodes.push(firstNode)` to happen **before** writing dnsmasq.conf and exports. Then use the helpers:

```typescript
  // ── 4. dnsmasq ──
  log.step(4, "Configuring dnsmasq (DHCP + TFTP + DNS)");
  await $try("systemctl stop dnsmasq");

  const resolvedActive = (await $try("systemctl is-active systemd-resolved")).trim();
  if (resolvedActive === "active") {
    log.warn("Stopping systemd-resolved (port 53 conflict)");
    await $(`systemctl stop systemd-resolved`);
    await $(`systemctl disable systemd-resolved`);
    writeFileSync("/etc/resolv.conf", "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
  }

  mkdirSync(config.tftp_root, { recursive: true });

  // Add node to config before writing generated files
  config.nodes.push(firstNode);
  writeDnsmasqConf(config);

  await $(`systemctl enable dnsmasq`);
  log.info(`DHCP ${config.dhcp_range_start}–${config.dhcp_range_end}, TFTP ${config.tftp_root}`);
```

Replace step 9 NFS exports:

```typescript
  // ── 9. NFS exports ──
  log.step(9, "Configuring NFS server");
  mkdirSync("/etc/nfs.conf.d", { recursive: true });
  writeFileSync("/etc/nfs.conf.d/netboot.conf", "[nfsd]\nvers3=y\nvers4=y\n");
  writeNfsExports(config);
  await $(`exportfs -ra`);
  await $(`systemctl enable --now nfs-kernel-server`);
  await $(`systemctl restart nfs-kernel-server`);
```

Remove the second `config.nodes.push(firstNode)` that was near the end (since we moved it up).

Replace iptables section (step 3) to use `ensureIptablesRule`:

```typescript
  // ── 3. Forwarding + NAT ──
  log.step(3, "Enabling IP forwarding and NAT");
  mkdirSync("/etc/sysctl.d", { recursive: true });
  writeFileSync("/etc/sysctl.d/99-netboot-forward.conf", "net.ipv4.ip_forward=1\n");
  await $(`sysctl -w net.ipv4.ip_forward=1`, { silent: true });

  await $(`iptables -t nat -F POSTROUTING`);
  await $(`iptables -t nat -A POSTROUTING -s ${config.lan_subnet}.0/24 -o ${config.wan_if} -j MASQUERADE`);
  await ensureIptablesRule(`FORWARD -i ${config.lan_if} -o ${config.wan_if} -j ACCEPT`);
  await ensureIptablesRule(`FORWARD -i ${config.wan_if} -o ${config.lan_if} -m state --state RELATED,ESTABLISHED -j ACCEPT`);
  await $try(`netfilter-persistent save`);
  log.info(`NAT: ${config.lan_subnet}.0/24 → ${config.wan_if}`);
```

Add idempotency check for node extraction (step 6):

```typescript
  // ── 6. Extract ──
  log.step(6, "Extracting boot + rootfs for first node");
  const piTftp = tftpDir(config, firstNode.serial);
  const piNfs = nfsDir(config, firstNode.hostname);
  if (existsSync(piNfs)) {
    log.warn(`NFS root already exists: ${piNfs} — skipping extraction. Use 'piboot reset ${firstNode.hostname}' to re-extract.`);
  } else {
    await extractImage(config, piNfs, piTftp);
  }
```

Save config uses `saveConfig(config)` at the end — no change needed since `firstNode` was already pushed.

- [ ] **Step 5: Refactor `addNode` to use helpers**

Replace the dnsmasq append and NFS append in `addNode`:

```typescript
  // DHCP + NFS — regenerate from config
  log.step(4, "Updating dnsmasq and NFS exports");
  config.nodes.push(node);
  writeDnsmasqConf(config);
  writeNfsExports(config);
  await $(`exportfs -ra`);
  await $(`systemctl restart dnsmasq`);

  // Save
  saveConfig(config);
```

Remove the old step 4 (DHCP reservation append) and step 5 (NFS exports append). Remove the second `config.nodes.push(node)` that was before `saveConfig`.

- [ ] **Step 6: Refactor `removeNode` to use helpers**

Replace the line-filtering approach in `removeNode` for dnsmasq and exports:

```typescript
  // Regenerate dnsmasq.conf and exports without this node
  config.nodes = config.nodes.filter((n) => n.hostname !== hostname);
  writeDnsmasqConf(config);
  writeNfsExports(config);
  await $try("exportfs -ra");
  await $try("systemctl restart dnsmasq");
  saveConfig(config);
  log.info(`Removed DHCP reservation and NFS exports`);
```

Remove the old separate dnsmasq.conf filtering block and the old exports filtering block and the old `config.nodes = ...` and `saveConfig` at the end (replaced by the above).

- [ ] **Step 7: Verify Deno can parse**

Run: `deno check src/cli.ts`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/commands.ts
git commit -m "feat: make init/add/remove idempotent via config-driven file generation"
```

---

## Chunk 3: New commands and config cleanup

### Task 6: `piboot doctor` command

**Files:**
- Modify: `src/commands.ts` — add `doctor` function
- Modify: `src/cli.ts` — add `doctor` case

- [ ] **Step 1: Add `doctor` function to `commands.ts`**

Add after the `logs` function:

```typescript
export async function doctor(config: Config): Promise<void> {
  log.banner("PIBOOT DOCTOR");

  let issues = 0;

  function pass(msg: string): void {
    console.log(`  \x1b[32m✓\x1b[0m  ${msg}`);
  }
  function fail(msg: string, fix?: string): void {
    issues++;
    console.log(`  \x1b[31m✗\x1b[0m  ${msg}`);
    if (fix) console.log(`      → ${fix}`);
  }

  // LAN interface IP
  const ipOut = await $try(`ip addr show ${config.lan_if} 2>/dev/null`);
  if (ipOut.includes(`inet ${config.lan_ip}/`)) {
    pass(`LAN interface ${config.lan_if} has ${config.lan_ip}`);
  } else {
    fail(
      `LAN interface ${config.lan_if} missing IP ${config.lan_ip}`,
      `Run: sudo ip addr add ${config.lan_ip}/24 dev ${config.lan_if}`
    );
  }

  // dnsmasq
  const dnsmasqActive = (await $try("systemctl is-active dnsmasq")).trim();
  if (dnsmasqActive === "active") {
    pass("dnsmasq: active");
  } else {
    fail("dnsmasq: " + dnsmasqActive, "Run: sudo systemctl restart dnsmasq");
  }

  const dnsmasqTest = await $try("dnsmasq --test 2>&1");
  if (dnsmasqTest.includes("OK") || dnsmasqTest.includes("syntax check is OK")) {
    pass("dnsmasq config: valid");
  } else {
    fail("dnsmasq config: invalid", "Check: dnsmasq --test");
  }

  // NFS
  const nfsActive = (await $try("systemctl is-active nfs-kernel-server")).trim();
  if (nfsActive === "active") {
    pass("nfs-kernel-server: active");
  } else {
    fail("nfs-kernel-server: " + nfsActive, "Run: sudo systemctl restart nfs-kernel-server");
  }

  // IP forwarding
  const fwd = (await $try("sysctl -n net.ipv4.ip_forward")).trim();
  if (fwd === "1") {
    pass("IP forwarding: enabled");
  } else {
    fail("IP forwarding: disabled", "Run: sudo sysctl -w net.ipv4.ip_forward=1");
  }

  // NAT rule
  const natCheck = await $try(
    `iptables -t nat -C POSTROUTING -s ${config.lan_subnet}.0/24 -o ${config.wan_if} -j MASQUERADE 2>/dev/null && echo EXISTS`
  );
  if (natCheck.trim() === "EXISTS") {
    pass(`NAT masquerade: ${config.lan_subnet}.0/24 → ${config.wan_if}`);
  } else {
    fail(
      "NAT masquerade rule missing",
      `Run: sudo iptables -t nat -A POSTROUTING -s ${config.lan_subnet}.0/24 -o ${config.wan_if} -j MASQUERADE`
    );
  }

  // Per-node checks
  const exportsList = await $try("cat /etc/exports 2>/dev/null");

  for (const node of config.nodes) {
    const tftp = tftpDir(config, node.serial);
    const nfs = nfsDir(config, node.hostname);

    // TFTP dir
    if (existsSync(join(tftp, "cmdline.txt"))) {
      pass(`Node ${node.hostname}: TFTP dir OK (${node.serial})`);
    } else {
      fail(
        `Node ${node.hostname}: TFTP dir missing or no cmdline.txt`,
        `Check: ls ${tftp}/`
      );
    }

    // Kernel
    if (existsSync(join(tftp, "kernel_2712.img")) || existsSync(join(tftp, "kernel8.img"))) {
      pass(`Node ${node.hostname}: kernel image present`);
    } else {
      fail(
        `Node ${node.hostname}: no kernel image in TFTP dir`,
        `May need: piboot reset ${node.hostname}`
      );
    }

    // NFS root
    if (existsSync(join(nfs, "etc")) && existsSync(join(nfs, "bin"))) {
      pass(`Node ${node.hostname}: NFS root OK`);
    } else {
      fail(
        `Node ${node.hostname}: NFS root missing or incomplete`,
        `Run: piboot reset ${node.hostname}`
      );
    }

    // Exports
    if (exportsList.includes(nfs)) {
      pass(`Node ${node.hostname}: NFS exports present`);
    } else {
      fail(
        `Node ${node.hostname}: missing from /etc/exports`,
        `Run: piboot init (re-run to regenerate) or manually add`
      );
    }
  }

  // Orphan detection
  if (existsSync(config.tftp_root)) {
    const tftpDirs = readdirSync(config.tftp_root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const knownSerials = new Set(config.nodes.map((n) => n.serial));
    for (const dir of tftpDirs) {
      if (!knownSerials.has(dir)) {
        fail(
          `Orphaned TFTP dir: ${join(config.tftp_root, dir)} (no matching node in config)`,
          "If unused, manually remove it"
        );
      }
    }
  }

  if (existsSync(config.nfs_root)) {
    const nfsDirs = readdirSync(config.nfs_root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const knownHostnames = new Set(config.nodes.map((n) => n.hostname));
    for (const dir of nfsDirs) {
      if (!knownHostnames.has(dir)) {
        fail(
          `Orphaned NFS dir: ${join(config.nfs_root, dir)} (no matching node in config)`,
          `If unused: piboot remove ${dir}`
        );
      }
    }
  }

  // Summary
  console.log();
  if (issues === 0) {
    log.info("All checks passed.");
  } else {
    log.warn(`${issues} issue${issues > 1 ? "s" : ""} found.`);
  }
}
```

Add the `readdirSync` import at the top if not already present (it already is in `commands.ts`).

Also add the `join` usage for orphan detection — `join` is already imported.

- [ ] **Step 2: Add `doctor` case to `cli.ts`**

Add to the switch in `cli.ts`:

```typescript
  case "doctor": {
    requireRoot();
    await doctor(loadConfig());
    break;
  }
```

Import `doctor` from `./commands`:

```typescript
import { init, addNode, resetNode, removeNode, listNodes, status, logs, doctor } from "./commands";
```

- [ ] **Step 3: Verify Deno can parse**

Run: `deno check src/cli.ts`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/commands.ts src/cli.ts
git commit -m "feat: add piboot doctor command for server diagnostics"
```

---

### Task 7: `piboot ssh` command

**Files:**
- Modify: `src/cli.ts` — update `parseFlags` for `--` sentinel, add `ssh` case
- Modify: `src/commands.ts` — add `sshNode` function

- [ ] **Step 1: Update `parseFlags` in `cli.ts` to handle `--` sentinel**

Replace the `parseFlags` function:

```typescript
interface ParsedFlags {
  flags: Record<string, string>;
  extra: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const extra: string[] = [];
  let seenDash = false;

  for (let i = 0; i < args.length; i++) {
    if (seenDash) {
      extra.push(args[i]);
    } else if (args[i] === "--") {
      seenDash = true;
    } else if (args[i].startsWith("--")) {
      const key = args[i].replace(/^--/, "").replace(/-/g, "_");
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      flags[key] = val;
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length > 0) {
    flags._target = positional[0];
  }

  return { flags, extra };
}
```

- [ ] **Step 2: Update all `parseFlags` call sites in `cli.ts`**

The call changes from:

```typescript
const flags = parseFlags(rest);
```

To:

```typescript
const { flags, extra } = parseFlags(rest);
```

All existing `flags.xxx` usage remains the same — no other changes needed.

- [ ] **Step 3: Add `sshNode` function to `commands.ts`**

```typescript
export async function sshNode(config: Config, hostname: string, extraArgs: string[]): Promise<void> {
  const node = config.nodes.find((n) => n.hostname === hostname);
  if (!node) {
    log.fail(`Node "${hostname}" not found. Run 'piboot list' to see nodes.`);
  }

  const args = ["pi@" + node!.ip, ...extraArgs];
  log.info(`ssh ${args.join(" ")}`);

  const proc = Deno.command
    ? new Deno.Command("ssh", { args, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    : null;

  // Use spawn for cross-compat
  const { spawn: nodeSpawn } = await import("node:child_process");
  const child = nodeSpawn("ssh", args, { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 0));
}
```

Actually, simpler — use the existing `$` helper pattern but with `stdio: "inherit"` and no capture. Even simpler: just `exec`:

```typescript
export function sshNode(config: Config, hostname: string, extraArgs: string[]): void {
  const node = config.nodes.find((n) => n.hostname === hostname);
  if (!node) {
    log.fail(`Node "${hostname}" not found. Run 'piboot list' to see nodes.`);
  }

  const args = ["ssh", "pi@" + node!.ip, ...extraArgs];
  log.info(args.join(" "));

  // Replace process with ssh
  const { execFileSync } = require("node:child_process");
  try {
    execFileSync("ssh", ["pi@" + node!.ip, ...extraArgs], { stdio: "inherit" });
  } catch (err: any) {
    process.exit(err.status ?? 1);
  }
}
```

Wait — we're using ES modules. Use the import approach:

```typescript
import { execFileSync } from "node:child_process";
// ... already have spawn imported, add execFileSync

export function sshNode(config: Config, hostname: string, extraArgs: string[]): void {
  const node = config.nodes.find((n) => n.hostname === hostname);
  if (!node) {
    log.fail(`Node "${hostname}" not found. Run 'piboot list' to see nodes.`);
  }

  const args = ["pi@" + node!.ip, ...extraArgs];
  log.info(`ssh ${args.join(" ")}`);

  try {
    execFileSync("ssh", args, { stdio: "inherit" });
  } catch (err: any) {
    process.exit(err.status ?? 1);
  }
}
```

Add `execFileSync` to the existing `node:child_process` import in `commands.ts`. Note: `commands.ts` doesn't directly import from `node:child_process` — it uses helpers from `shell.ts`. So add the import:

```typescript
import { execFileSync } from "node:child_process";
```

- [ ] **Step 4: Add `ssh` case to `cli.ts`**

```typescript
  case "ssh": {
    const hostname = flags._target;
    if (!hostname) log.fail("Usage: piboot ssh <hostname>");
    sshNode(loadConfig(), hostname, extra);
    break;
  }
```

Import `sshNode` from `./commands`:

```typescript
import { init, addNode, resetNode, removeNode, listNodes, status, logs, doctor, sshNode } from "./commands";
```

Note: `ssh` does NOT call `requireRoot()` — it only reads config.

- [ ] **Step 5: Loosen config file permissions**

In `src/config.ts`, update `saveConfig` to chmod 644:

```typescript
import { chmodSync } from "node:fs";
// ... in saveConfig, after writeFileSync:
  chmodSync(CONFIG_FILE, 0o644);
```

Add `chmodSync` to the existing `node:fs` import.

- [ ] **Step 6: Verify Deno can parse**

Run: `deno check src/cli.ts`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/commands.ts src/cli.ts src/config.ts
git commit -m "feat: add piboot ssh command, loosen config permissions"
```

---

### Task 8: Final cleanup and README update

**Files:**
- Modify: `README.md` — add doctor, ssh, --verbose to docs

- [ ] **Step 1: Update README.md**

Add after the "Tail dnsmasq logs" section:

```markdown
### Diagnose issues

\`\`\`bash
sudo piboot doctor
\`\`\`

Checks server health: interface IP, dnsmasq, NFS, TFTP dirs, IP forwarding, NAT rules, and detects orphaned directories. Shows actionable fix suggestions for each issue.

### SSH into a node

\`\`\`bash
piboot ssh rpi5-01
piboot ssh rpi5-01 -- -L 8080:localhost:80
\`\`\`

### Verbose error output

Add `--verbose` to any command to see full stack traces on error:

\`\`\`bash
sudo piboot init --verbose --serial ...
\`\`\`
```

Update the COMMANDS table in the Troubleshooting section — replace the "Node not booting" troubleshooting with a simpler reference:

```markdown
### Node not booting

Run `sudo piboot doctor` to diagnose. It checks all common failure points and suggests fixes.

For live debugging, watch the DHCP/TFTP logs:
\`\`\`bash
sudo piboot logs --follow
\`\`\`
```

- [ ] **Step 2: Final `deno check`**

Run: `deno check src/cli.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README with doctor, ssh, verbose, Deno instructions"
```

---

## Summary of all tasks

| Task | Description | Files |
|------|-------------|-------|
| 1 | Deno standardization | deno.json, README.md, delete bun artifacts |
| 2 | Error handling (PibootError, global handler, --verbose) | shell.ts, cli.ts |
| 3 | Input validation module | validate.ts (new), cli.ts |
| 4 | Network configuration module (netplan fix) | network.ts (new), commands.ts |
| 5 | Idempotency (config-driven dnsmasq/exports/iptables) | commands.ts |
| 6 | `piboot doctor` command | commands.ts, cli.ts |
| 7 | `piboot ssh` command | commands.ts, cli.ts, config.ts |
| 8 | README update | README.md |
