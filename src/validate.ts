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

  const rangeStart = parseInt(config.dhcp_range_start.split(".")[3], 10);
  const rangeEnd = parseInt(config.dhcp_range_end.split(".")[3], 10);
  if (lastOctet >= rangeStart && lastOctet <= rangeEnd) {
    throw new PibootError(
      `IP "${ip}" falls within DHCP dynamic range (${config.dhcp_range_start}–${config.dhcp_range_end}). Use a static IP outside this range.`
    );
  }

  if (ip === config.lan_ip) {
    throw new PibootError(
      `IP "${ip}" is the server's own LAN IP — pick a different address`
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
      throw new PibootError(`Serial "${node.serial}" already in use by node "${existing.hostname}"`);
    }
    if (existing.mac.toLowerCase() === node.mac.toLowerCase()) {
      throw new PibootError(`MAC "${node.mac}" already in use by node "${existing.hostname}"`);
    }
    if (existing.hostname === node.hostname) {
      throw new PibootError(`Hostname "${node.hostname}" already in use`);
    }
    if (existing.ip === node.ip) {
      throw new PibootError(`IP "${node.ip}" already in use by node "${existing.hostname}"`);
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
