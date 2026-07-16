import { execFileSync } from "child_process";

/**
 * Sandbox image names + the docker availability probes. Kept in this
 * dependency-light module (only `child_process`, no `./docker.js`) so callers
 * like the workflow runner can check image availability without importing the
 * full `DockerSandbox` machinery — `docker.ts` runs `promisify(execFile)` at
 * module load, which trips test suites that mock `child_process`.
 */

/** The lean default sandbox image (`sandbox.Dockerfile`). */
export const SANDBOX_IMAGE = "lastlight-sandbox:latest";

/**
 * The enriched browser-QA image (Playwright + Chromium baked in). Built only
 * when QA is enabled (`sandbox-qa.Dockerfile`); a phase opts into it with
 * `sandbox_image: qa`. Fixed name, deliberately not overridable.
 */
export const SANDBOX_IMAGE_QA = "lastlight-sandbox-qa:latest";

/** Check if Docker sandbox mode is available (docker up + lean image built). */
export function isSandboxAvailable(): boolean {
  return dockerAvailable() && sandboxImageExists(SANDBOX_IMAGE);
}

/** Cached check — only probe for the QA image once per process. */
let _qaImageAvailable: boolean | null = null;

/**
 * Whether the browser-QA sandbox image is present on this host. Used by the
 * runner to gracefully skip a `sandbox_image: qa` phase when the image hasn't
 * been built (the lean default deploy), rather than failing the run.
 */
export function qaImageAvailable(): boolean {
  if (_qaImageAvailable === null) {
    _qaImageAvailable = dockerAvailable() && sandboxImageExists(SANDBOX_IMAGE_QA);
  }
  return _qaImageAvailable;
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function sandboxImageExists(imageName: string): boolean {
  try {
    const out = execFileSync("docker", ["images", "-q", imageName], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
