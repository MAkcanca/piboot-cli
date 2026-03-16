import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface PiNode {
  serial: string;
  mac: string;
  hostname: string;
  ip: string;
}

export interface Config {
  wan_if: string;
  lan_if: string;
  lan_subnet: string;
  lan_ip: string;
  lan_mask: string;
  dhcp_range_start: string;
  dhcp_range_end: string;
  dhcp_lease: string;
  tftp_root: string;
  nfs_root: string;
  image_url: string;
  image_file: string;
  image_raw: string;
  nodes: PiNode[];
}

const CONFIG_DIR = "/etc/piboot";
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  wan_if: "ens18",
  lan_if: "ens19",
  lan_subnet: "10.10.10",
  lan_ip: "10.10.10.1",
  lan_mask: "255.255.255.0",
  dhcp_range_start: "10.10.10.100",
  dhcp_range_end: "10.10.10.200",
  dhcp_lease: "12h",
  tftp_root: "/srv/tftp",
  nfs_root: "/srv/nfs",
  image_url: "https://downloads.raspberrypi.com/raspios_lite_arm64_latest",
  image_file: "/srv/rpios.img.xz",
  image_raw: "/srv/rpios.img",
  nodes: [],
};

export function loadConfig(): Config {
  if (existsSync(CONFIG_FILE)) {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  }
  return { ...DEFAULTS };
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  chmodSync(CONFIG_FILE, 0o644);
}

export function findNode(config: Config, hostname: string): PiNode | undefined {
  return config.nodes.find((n) => n.hostname === hostname);
}

export function tftpDir(config: Config, serial: string): string {
  return join(config.tftp_root, serial);
}

export function nfsDir(config: Config, hostname: string): string {
  return join(config.nfs_root, hostname);
}
