/**
 * Pre-flight checks for the Gondolin sandbox backend.
 *
 * The reason this exists at all: per upstream issue #51, Gondolin's
 * `VM.create()` returns a "VM ready" Promise even when the underlying QEMU
 * guest never actually boots (silently hangs at ~95% CPU). That happens any
 * time QEMU lacks a hypervisor accelerator — most commonly when running
 * inside a container with no `/dev/kvm`. We refuse to start in those
 * environments rather than let the orchestrator inherit a hung process.
 *
 * Empirically verified: works on macOS host (HVF auto-used by QEMU 11);
 * fails inside Colima / Docker Desktop (no /dev/kvm exposed). See
 * SPIKE-gondolin.md for the full evidence.
 */

import { existsSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";

export type PreflightStatus =
  | { ok: true; detail: string }
  | { ok: false; reason: PreflightFailureReason; hint: string };

export type PreflightFailureReason =
  | "qemu-not-installed"
  | "qemu-img-not-installed"
  | "linux-no-kvm"
  | "in-container-no-accel";

function which(bin: string): string | null {
  try {
    const out = execFileSync("/usr/bin/env", ["which", bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort container detection. We're conservative — false negatives are
 * tolerable (the only consequence is a slower failure inside QEMU itself).
 * False positives would block valid native runs, so we only flag the
 * obvious cases.
 */
function looksLikeContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env.container) return true;
  return false;
}

export function preflightGondolin(): PreflightStatus {
  const qemuX86 = which("qemu-system-x86_64");
  const qemuArm = which("qemu-system-aarch64");
  const qemu = qemuX86 || qemuArm;

  if (!qemu) {
    return {
      ok: false,
      reason: "qemu-not-installed",
      hint:
        "Install QEMU on the host: 'brew install qemu' (macOS) or " +
        "'apt install qemu-system-x86 qemu-system-arm qemu-utils' (Debian/Ubuntu). " +
        "See SPIKE-gondolin.md for context.",
    };
  }

  const qemuImg = which("qemu-img");
  if (!qemuImg) {
    return {
      ok: false,
      reason: "qemu-img-not-installed",
      hint:
        "qemu-img missing. On Debian/Ubuntu install 'qemu-utils'; on macOS " +
        "the 'qemu' brew formula already includes it — re-check $PATH.",
    };
  }

  // On Linux, the only practical accelerator is KVM. Without /dev/kvm,
  // Gondolin falls into the upstream-#51 silent-hang bug. Refuse early.
  if (process.platform === "linux" && !isReadable("/dev/kvm")) {
    const inContainer = looksLikeContainer();
    return {
      ok: false,
      reason: inContainer ? "in-container-no-accel" : "linux-no-kvm",
      hint: inContainer
        ? "Detected container environment with no readable /dev/kvm. " +
          "Gondolin requires KVM and Docker-in-Docker nested virt is not viable. " +
          "Run agentic-pi natively, or expose /dev/kvm with 'docker run --device /dev/kvm'."
        : "/dev/kvm not readable. Add the running user to the 'kvm' group, " +
          "or run as a user with read access. Without it Gondolin hangs (upstream issue #51).",
    };
  }

  // macOS: QEMU 11 auto-uses Hypervisor.framework (HVF). No /dev/kvm
  // needed. Empirically verified in SPIKE-gondolin.md.
  const accel = process.platform === "darwin" ? "HVF (auto)" : "KVM (/dev/kvm)";
  return { ok: true, detail: `qemu=${qemu} qemu-img=${qemuImg} accel=${accel}` };
}
