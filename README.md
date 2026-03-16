# piboot

Raspberry Pi netboot cluster manager. Sets up a Debian server as a PXE/TFTP/NFS netboot host for Raspberry Pi 5 (and compatible) boards.

## Architecture

```
┌─────────────────────────────┐
│  Proxmox (Intel N100)       │
│  ┌───────────────────────┐  │
│  │  Debian 13 VM         │  │
│  │  ┌─────┐   ┌───────┐ │  │
│  │  │ens18│   │ens19  │ │  │
│  │  │ WAN │   │ LAN   │ │  │
│  │  └──┬──┘   └───┬───┘ │  │
│  └─────┼──────────┼─────┘  │
│        │          │         │
└────────┼──────────┼─────────┘
         │          │
      Internet    Switch
                    │
              ┌─────┼─────┐
              │     │     │
            Pi 5  Pi 5  Pi 5
```

## Requirements

- Debian 13 (Trixie) — fresh install
- Two network interfaces (`ens18` WAN, `ens19` LAN)
- Deno runtime (`curl -fsSL https://deno.land/install.sh | sh`)

## Install

```bash
# Install Deno (if not present)
curl -fsSL https://deno.land/install.sh | sh

# Clone / copy the project
cd /opt/piboot

# Create wrapper script
cat > /usr/local/bin/piboot << 'EOF'
#!/bin/sh
exec /root/.deno/bin/deno run --allow-all /opt/piboot/src/cli.ts "$@"
EOF
chmod +x /usr/local/bin/piboot

# Run
sudo piboot <command>
```

## Usage

### Initialize the server + first Pi

```bash
sudo piboot init \
  --serial a1b2c3d4 \
  --mac dc:a6:32:01:02:03 \
  --hostname rpi5-01 \
  --ip 10.10.10.50
```

This installs all packages, configures networking + NAT, sets up dnsmasq (DHCP/TFTP/DNS), downloads Raspberry Pi OS, extracts the rootfs, patches it for NFS boot, and configures NFS exports.

Optional overrides:
- `--wan-if ens18` — WAN interface
- `--lan-if ens19` — LAN interface
- `--lan-subnet 10.10.10` — subnet prefix

### Add another Pi

```bash
sudo piboot add \
  --serial aabbccdd \
  --mac aa:bb:cc:dd:ee:ff \
  --hostname rpi5-02 \
  --ip 10.10.10.51
```

### Reset a node to factory

```bash
sudo piboot reset rpi5-01
```

Wipes the NFS rootfs and re-extracts from the base image. DHCP/NFS config untouched.

### Remove a node completely

```bash
sudo piboot remove rpi5-01
```

Deletes NFS rootfs, TFTP boot dir, DHCP reservation, and NFS exports.

### List nodes

```bash
piboot list
```

### Server status

```bash
sudo piboot status
```

### Tail dnsmasq logs

```bash
sudo piboot logs --follow
```

## Config

After `init`, configuration is stored at `/etc/piboot/config.json`. This tracks all node definitions and server settings. The CLI reads and updates this file automatically.

## Default Credentials

- **User:** `pi`
- **Password:** `raspberry`
- SSH is enabled by default on all nodes.

## Keeping Nodes Updated

Each node is provisioned from the base Raspberry Pi OS image. Two strategies for keeping nodes updated:

### Strategy 1: First-boot update (simple)

SSH into each new node and run:
```bash
sudo apt update && sudo apt upgrade -y
```

Or automate with a first-boot service — add to `/etc/systemd/system/first-boot-update.service` in the NFS root before booting.

### Strategy 2: Shared root with overlays (efficient)

For larger clusters, all nodes can share a single read-only rootfs with per-node writable overlays:

```
/srv/nfs/base/              ← single shared root (read-only, ~5GB)
/srv/nfs/overlays/rpi5-01/  ← node-specific changes (~50MB)
/srv/nfs/overlays/rpi5-02/  ← node-specific changes (~50MB)
```

Benefits:
- Update once, all nodes get changes on next boot
- Storage efficient (~50MB per node vs ~5GB)
- How production netboot clusters work

This requires modifying the boot process to use OverlayFS. See [Raspberry Pi overlay documentation](https://www.raspberrypi.com/documentation/computers/configuration.html#overlay-file-system) for details.

## Remote Access

The Pi LAN (10.10.10.0/24) is behind NAT. Options to access nodes:

### SSH ProxyJump
```bash
ssh -J root@<provisioner-ip> pi@10.10.10.50
```

### Tailscale subnet router (recommended)
```bash
# On provisioner:
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --advertise-routes=10.10.10.0/24
```
Approve the route in Tailscale admin console. All Pis become directly accessible.

## Troubleshooting

### Node not booting

1. Check dnsmasq logs: `piboot logs --follow`
2. Verify TFTP directory exists: `ls /srv/tftp/<serial>`
3. Verify NFS exports: `exportfs -v`

### Orphaned files after failed remove

If `piboot remove` fails partway through, re-run it — the CLI will clean up any remaining artifacts by scanning TFTP directories.
