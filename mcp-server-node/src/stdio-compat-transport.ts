import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/server";

import { logger } from "./config.js";
import { recordRawArgKeys } from "./handlers/arg-contract.js";

type MessageHandler = NonNullable<Transport["onmessage"]>;

/**
 * Normalize the argument shape before SDK v2's era classifier and validator
 * see the message. Keeping this at the wire boundary preserves the legacy
 * client compatibility path for modern and initialize-era connections alike.
 */
function normalizeMessage(message: JSONRPCMessage): JSONRPCMessage {
  const candidate = message as {
    id?: unknown;
    method?: unknown;
    params?: Record<string, unknown>;
  };
  if (candidate.method !== "tools/call" || !candidate.params || Array.isArray(candidate.params)) {
    return message;
  }

  try {
    if (typeof candidate.params.arguments === "string") {
      const raw = candidate.params.arguments.trim();
      candidate.params.arguments = raw ? JSON.parse(raw) : {};
      logger.warning("Client sent tools/call arguments as a JSON string; parsed it into an object");
    }
    recordRawArgKeys(candidate.id, candidate.params.arguments);
  } catch (error) {
    // Preserve malformed input so the SDK can return its normal validation
    // error instead of turning a recoverable protocol error into a transport
    // failure.
    logger.warning(`Could not normalize string tools/call arguments: ${error}`);
  }
  return message;
}
/**
 * Transport decorator used by serveStdio. The SDK entry owns the decorator's
 * callbacks; the wrapped stdio wire remains responsible for process I/O.
 */
export class NormalizingStdioTransport implements Transport {
  private readonly inner: Transport;
  private messageHandler?: MessageHandler;

  constructor(inner: Transport = new StdioServerTransport()) {
    this.inner = inner;
    this.inner.onmessage = (message, extra) => {
      this.messageHandler?.(normalizeMessage(message), extra);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.onclose?.();
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  onclose?: () => void;
  onerror?: (error: Error) => void;

  get onmessage(): MessageHandler | undefined {
    return this.messageHandler;
  }

  set onmessage(handler: MessageHandler | undefined) {
    this.messageHandler = handler;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }
}
