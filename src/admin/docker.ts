import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  created: string;
  taskId: string | null;
  image: string;
}

export interface ContainerStats {
  name: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
}

export async function killContainer(containerName: string): Promise<void> {
  await exec("docker", ["rm", "-f", containerName]);
}

/**
 * Snapshot CPU/memory for every container whose name starts with `lastlight-`
 * (the agent itself plus any active sandboxes). Uses `docker stats --no-stream`
 * so each call is one read of cgroup counters — slower than a metadata lookup
 * but still ~sub-second on a small fleet.
 */
export async function getContainerStats(): Promise<ContainerStats[]> {
  try {
    const { stdout } = await exec("docker", [
      "stats",
      "--no-stream",
      "--format", "{{json .}}",
    ]);
    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>)
      .filter((c) => (c.Name ?? "").startsWith("lastlight"))
      .map((c) => {
        const name = c.Name ?? "";
        const cpuPercent = parsePercent(c.CPUPerc);
        const memPercent = parsePercent(c.MemPerc);
        const [usage, limit] = parseMemUsage(c.MemUsage);
        return {
          name,
          cpuPercent,
          memUsageBytes: usage,
          memLimitBytes: limit,
          memPercent,
        };
      });
  } catch {
    return [];
  }
}

function parsePercent(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseFloat(raw.replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

// Docker formats memory like "123.4MiB / 7.7GiB" — convert each side to bytes.
function parseMemUsage(raw: string | undefined): [number, number] {
  if (!raw) return [0, 0];
  const parts = raw.split("/").map((p) => p.trim());
  return [parseSize(parts[0] ?? ""), parseSize(parts[1] ?? "")];
}

function parseSize(raw: string): number {
  const m = raw.match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return 0;
  const value = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  };
  return value * (multipliers[unit] ?? 1);
}

export async function listRunningContainers(): Promise<ContainerInfo[]> {
  try {
    const { stdout } = await exec("docker", [
      "ps",
      "--filter", "name=lastlight-sandbox",
      "--format", "{{json .}}",
    ]);

    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split("\n")
      .map((line) => {
        const c = JSON.parse(line) as Record<string, string>;
        const name = c.Names ?? c.Name ?? "";
        // Parse taskId from: lastlight-sandbox-{taskId}-{uuid}
        const match = name.match(/^lastlight-sandbox-(.+?)-[a-f0-9]{8}$/);
        return {
          id: c.ID ?? "",
          name,
          status: c.Status ?? "",
          created: c.CreatedAt ?? c.RunningFor ?? "",
          taskId: match?.[1] ?? null,
          image: c.Image ?? "",
        };
      });
  } catch {
    return [];
  }
}
