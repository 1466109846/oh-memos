import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MEMOS_MODE = "lite";
  process.env.MEMOS_PROVIDER = "local";
  process.env.MEMOS_URL = "";
  process.env.MEMOS_USER = "transport-test";
  process.env.MEMOS_DEFAULT_CUBE = "transport_cube";
  process.env.MEMOS_CUBES_DIR = process.cwd();
  process.env.MEMOS_LITE_EMBED = "off";
});

import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/server";

import { checkArgContract } from "./handlers/arg-contract.js";
import { NormalizingStdioTransport } from "./stdio-compat-transport.js";

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  starts = 0;
  sent: Array<{ message: JSONRPCMessage; options?: TransportSendOptions }> = [];
  closes = 0;

  async start(): Promise<void> {
    this.starts += 1;
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sent.push({ message, options });
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  emit(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    this.onmessage?.(message, extra);
  }
}

describe("NormalizingStdioTransport", () => {
  it("normalizes stringified arguments before forwarding and records raw keys", () => {
    const inner = new FakeTransport();
    const transport = new NormalizingStdioTransport(inner);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);

    inner.emit({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "memos_suggest",
        arguments: JSON.stringify({ context: "protocol", extra_contract_key: "ignored" }),
      },
    });

    expect(received[0]).toMatchObject({
      id: 7,
      params: {
        arguments: { context: "protocol", extra_contract_key: "ignored" },
      },
    });
    expect(checkArgContract("memos_suggest", 7)).toMatchObject({
      ignored: ["extra_contract_key"],
    });
  });

  it("keeps malformed strings for the SDK validator and preserves message extras", () => {
    const inner = new FakeTransport();
    const transport = new NormalizingStdioTransport(inner);
    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    const extra = { classification: { era: "modern", revision: "2026-07-28" } } as MessageExtraInfo;
    const message = {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "memos_suggest", arguments: "not-json" },
    } as JSONRPCMessage;

    inner.emit(message, extra);

    expect(onmessage).toHaveBeenCalledWith(message, extra);
    expect((message as any).params.arguments).toBe("not-json");
  });

  it("delegates lifecycle, send, and error/close callbacks to the wrapped transport", async () => {
    const inner = new FakeTransport();
    const transport = new NormalizingStdioTransport(inner);
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onerror = onerror;
    transport.onclose = onclose;

    await transport.start();
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }, { relatedRequestId: 1 });
    inner.onerror?.(new Error("wire failure"));
    inner.onclose?.();
    await transport.close();

    expect(inner.starts).toBe(1);
    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0].options?.relatedRequestId).toBe(1);
    expect(onerror).toHaveBeenCalledWith(expect.any(Error));
    expect(onclose).toHaveBeenCalledOnce();
    expect(inner.closes).toBe(1);
  });
});
