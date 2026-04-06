/**
 * Message delivery service for sending output to messaging platforms.
 * Used by cron jobs (health reports, alerts) and other async notifications.
 */

export type DeliveryTarget = (message: string) => Promise<void>;

export class MessageDeliveryService {
  private targets = new Map<string, DeliveryTarget>();

  /** Register a delivery target for a platform */
  register(platform: string, target: DeliveryTarget): void {
    this.targets.set(platform, target);
    console.log(`[delivery] Registered target: ${platform}`);
  }

  /** Deliver a message to a specific platform, or all if none specified */
  async deliver(message: string, platform?: string): Promise<void> {
    if (platform) {
      const target = this.targets.get(platform);
      if (!target) {
        console.warn(`[delivery] No target registered for platform: ${platform}`);
        return;
      }
      await target(message);
      return;
    }

    // Deliver to all registered targets
    for (const [name, target] of this.targets) {
      try {
        await target(message);
      } catch (err) {
        console.error(`[delivery] Failed to deliver to ${name}:`, err);
      }
    }
  }

  /** Check if any delivery targets are registered */
  hasTargets(): boolean {
    return this.targets.size > 0;
  }
}
