import { writeFileSync, readdirSync, chmodSync, mkdirSync } from "node:fs";
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
  await $try(`ip addr add ${config.lan_ip}/24 dev ${config.lan_if} 2>/dev/null`);
  await $(`ip link set ${config.lan_if} up`);

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
