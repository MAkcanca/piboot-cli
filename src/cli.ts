#!/usr/bin/env -S deno run --allow-all
import { loadConfig, type PiNode } from "./config";
import { log, requireRoot } from "./shell";
import { init, addNode, resetNode, removeNode, listNodes, status, logs } from "./commands";

const HELP = `
\x1b[1mpiboot\x1b[0m — Raspberry Pi netboot cluster manager

\x1b[1mUSAGE\x1b[0m
  piboot <command> [options]

\x1b[1mCOMMANDS\x1b[0m
  init     Set up the netboot server and first Pi node
  add      Add a new Pi node to the cluster
  reset    Factory-reset a node's rootfs
  remove   Fully remove a node (rootfs, TFTP, DHCP, NFS exports)
  list     List all configured nodes
  status   Show server and service status
  logs     Show dnsmasq logs (--follow for tail -f)

\x1b[1mEXAMPLES\x1b[0m
  piboot init --serial a1b2c3d4 --mac dc:a6:32:01:02:03 --hostname rpi5-01 --ip 10.10.10.50
  piboot add  --serial aabbccdd --mac aa:bb:cc:dd:ee:ff --hostname rpi5-02 --ip 10.10.10.51
  piboot reset  rpi5-01
  piboot remove rpi5-01
  piboot logs --follow

\x1b[1mCONFIG\x1b[0m
  Server config is stored in /etc/piboot/config.json after init.
  Override network settings with flags on 'init':
    --wan-if, --lan-if, --lan-subnet
`;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].replace(/^--/, "").replace(/-/g, "_");
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      flags[key] = val;
    } else {
      positional.push(args[i]);
    }
  }

  // First positional goes into _target (for reset/remove)
  if (positional.length > 0) {
    flags._target = positional[0];
  }

  return flags;
}

function requireFlag(flags: Record<string, string>, key: string, hint: string): string {
  if (!flags[key]) {
    log.fail(`Missing required flag: --${key.replace(/_/g, "-")}  (${hint})`);
  }
  return flags[key];
}

// ── Main ────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

const flags = parseFlags(rest);

switch (command) {
  case "init": {
    requireRoot();
    const config = loadConfig();

    // Allow overriding network settings
    if (flags.wan_if) config.wan_if = flags.wan_if;
    if (flags.lan_if) config.lan_if = flags.lan_if;
    if (flags.lan_subnet) {
      config.lan_subnet = flags.lan_subnet;
      config.lan_ip = `${flags.lan_subnet}.1`;
      config.lan_mask = "255.255.255.0";
      config.dhcp_range_start = `${flags.lan_subnet}.100`;
      config.dhcp_range_end = `${flags.lan_subnet}.200`;
    }

    const node: PiNode = {
      serial: requireFlag(flags, "serial", "last 8 hex chars of Pi serial"),
      mac: requireFlag(flags, "mac", "Pi MAC address"),
      hostname: requireFlag(flags, "hostname", "e.g. rpi5-01"),
      ip: requireFlag(flags, "ip", "static IP for this Pi"),
    };

    await init(config, node);
    break;
  }

  case "add": {
    requireRoot();
    const config = loadConfig();
    const node: PiNode = {
      serial: requireFlag(flags, "serial", "last 8 hex chars of Pi serial"),
      mac: requireFlag(flags, "mac", "Pi MAC address"),
      hostname: requireFlag(flags, "hostname", "e.g. rpi5-02"),
      ip: requireFlag(flags, "ip", "static IP for this Pi"),
    };

    if (config.nodes.find((n) => n.hostname === node.hostname)) {
      log.fail(`Node "${node.hostname}" already exists. Remove it first or pick a different hostname.`);
    }

    await addNode(config, node);
    break;
  }

  case "reset": {
    requireRoot();
    const hostname = flags._target ?? flags.hostname;
    if (!hostname) log.fail("Usage: piboot reset <hostname>");
    await resetNode(loadConfig(), hostname);
    break;
  }

  case "remove": {
    requireRoot();
    const hostname = flags._target ?? flags.hostname;
    if (!hostname) log.fail("Usage: piboot remove <hostname>");
    await removeNode(loadConfig(), hostname);
    break;
  }

  case "list": {
    listNodes(loadConfig());
    break;
  }

  case "status": {
    await status(loadConfig());
    break;
  }

  case "logs": {
    await logs(flags.follow === "true");
    break;
  }

  default:
    log.fail(`Unknown command: ${command}\nRun 'piboot help' for usage.`);
}
