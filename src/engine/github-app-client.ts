import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import { Octokit } from "octokit";
import { resolve } from "path";

export interface GitHubAppClientConfig {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}

export function githubAppClient(config: GitHubAppClientConfig): Octokit {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey,
      installationId: config.installationId,
    },
  });
}
