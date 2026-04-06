import type { Connector, EventEnvelope } from "./types.js";

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

/**
 * ConnectorRegistry manages all event source connectors.
 * Register connectors, attach a unified event handler, start/stop all.
 */
export class ConnectorRegistry {
  private connectors: Map<string, Connector> = new Map();
  private handler: EventHandler | null = null;

  register(connector: Connector) {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector "${connector.name}" already registered`);
    }
    this.connectors.set(connector.name, connector);

    // Wire up event handler
    connector.on("event", (envelope: EventEnvelope) => {
      if (this.handler) {
        this.handler(envelope).catch((err) => {
          console.error(`[${connector.name}] Event handler error:`, err);
        });
      }
    });
  }

  onEvent(handler: EventHandler) {
    this.handler = handler;
  }

  async startAll(): Promise<void> {
    for (const [name, connector] of this.connectors) {
      console.log(`[registry] Starting connector: ${name}`);
      await connector.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, connector] of this.connectors) {
      console.log(`[registry] Stopping connector: ${name}`);
      await connector.stop();
    }
  }
}

export { type Connector, type EventEnvelope, type EventType } from "./types.js";
export { GitHubWebhookConnector, type GitHubWebhookConfig } from "./github-webhook.js";
