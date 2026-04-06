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
