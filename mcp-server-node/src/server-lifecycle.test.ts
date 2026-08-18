import { describe, expect, it, vi } from "vitest";

import { createOnceFireAndForget } from "./server-lifecycle.js";

describe("createOnceFireAndForget", () => {
  it("starts the initializer once even when called repeatedly", async () => {
    const initializer = vi.fn(async () => undefined);
    const onError = vi.fn();
    const start = createOnceFireAndForget(initializer, onError);

    expect(start()).toBe(true);
    expect(start()).toBe(false);
    await Promise.resolve();

    expect(initializer).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports rejected and synchronously thrown initializers without leaking unhandled rejections", async () => {
    const rejected = new Error("rejected init");
    const thrown = new Error("thrown init");
    const rejectedError = vi.fn();
    const thrownError = vi.fn();
    const rejectedStart = createOnceFireAndForget(async () => {
      throw rejected;
    }, rejectedError);
    const thrownStart = createOnceFireAndForget(() => {
      throw thrown;
    }, thrownError);

    expect(rejectedStart()).toBe(true);
    expect(thrownStart()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(rejectedError).toHaveBeenCalledWith(rejected);
    expect(thrownError).toHaveBeenCalledWith(thrown);
  });
});
