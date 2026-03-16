import { spawn } from "node:child_process";

const RED = "\x1b[0;31m";
const GRN = "\x1b[0;32m";
const YEL = "\x1b[1;33m";
const CYN = "\x1b[0;36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export const log = {
  info: (...args: unknown[]) =>
    console.log(`${GRN}[INFO]${NC} `, ...args),
  warn: (...args: unknown[]) =>
    console.log(`${YEL}[WARN]${NC} `, ...args),
  fail: (...args: unknown[]) => {
    console.error(`${RED}[FAIL]${NC} `, ...args);
    process.exit(1);
  },
  step: (n: number, label: string) =>
    console.log(`\n${CYN}[${n}]${NC} ${BOLD}${label}${NC}`),
  dim: (...args: unknown[]) =>
    console.log(`     ${DIM}${args.join(" ")}${NC}`),
  banner: (text: string) => {
    const line = "═".repeat(60);
    console.log(`\n${GRN}╔${line}╗${NC}`);
    console.log(`${GRN}║${NC} ${BOLD}${text.padEnd(59)}${NC}${GRN}║${NC}`);
    console.log(`${GRN}╚${line}╝${NC}\n`);
  },
  table: (rows: [string, string][]) => {
    const maxKey = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) {
      console.log(`  ${DIM}${k.padEnd(maxKey)}${NC}  ${v}`);
    }
  },
};

/** Run a shell command, stream output, throw on failure */
export async function $(
  cmd: string,
  opts?: { silent?: boolean; allowFail?: boolean }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", cmd], {
      stdio: opts?.silent ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";

    if (opts?.silent) {
      proc.stdout?.on("data", (data) => (stdout += data.toString()));
      proc.stderr?.on("data", (data) => (stderr += data.toString()));
    }

    proc.on("close", (exitCode) => {
      if (exitCode !== 0 && !opts?.allowFail) {
        if (opts?.silent && stderr) {
          reject(new Error(`Command failed (${exitCode}): ${cmd}\n${stderr}`));
        } else {
          reject(new Error(`Command failed (${exitCode}): ${cmd}`));
        }
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", reject);
  });
}

/** Run a shell command silently, return stdout */
export async function $quiet(cmd: string): Promise<string> {
  return $(cmd, { silent: true });
}

/** Run a shell command, don't throw on failure */
export async function $try(cmd: string): Promise<string> {
  return $(cmd, { silent: true, allowFail: true });
}

export function requireRoot(): void {
  if (process.getuid?.() !== 0) {
    log.fail("piboot must run as root: sudo piboot <command>");
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
