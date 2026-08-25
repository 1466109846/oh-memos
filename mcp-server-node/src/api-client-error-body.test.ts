/**
 * 400 响应体必须活着传回调用方。
 *
 * ## 实测症状
 *
 * `memos_get` 传一个已被淘汰的 id，用户看到的是
 * `❌ [API_ERROR] Get failed: HTTP 400` —— 通用错误、无可操作信息。
 * 但后端实际回的是可读的诊断：
 *
 * ```
 * {"code":400,"message":"Memory with ID 00000000-... not found","data":null}
 * ```
 *
 * ## 消息在哪一步丢的
 *
 * `doFetch` 第 115 行**特意**为 400 保留了响应体（`response.status !== 400`
 * 才丢），因为后端把 not-found 也映射成 400。但 `apiCallWithRetry` 的
 * 400 分支在重注册重试失败后 `return { data: null }`，把它扔了。
 *
 * 于是 `handleMemosGet` 已经写好的 not-found 分支（检查 message 含
 * "not found"）永远进不去 —— 它前面那层 `else if (result.data)` 拿到 null。
 *
 * ## 为什么后端 not-found 是 400 而不是 404
 *
 * `start_api.py` 的 `@app.exception_handler(ValueError)` 把所有 ValueError
 * 映射成 400，而 `text_mem.get` 用 `ValueError` 报 not-found。改后端语义
 * 影响面大（该 handler 覆盖所有端点），所以客户端必须能从消息正文识别。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiCallWithRetry } from "./api-client.js";

/** 后端 not-found 的真实形状，取自 curl 实测。 */
const NOT_FOUND_BODY = {
  code: 400,
  message: "Memory with ID 00000000-0000-0000-0000-000000000000 not found",
  data: null,
};

/** 用给定的 (status, body) 序列应答，并记录调用次数。 */
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiCallWithRetry 的 400 分支", () => {
  it("重注册重试后仍 400 时，保留后端诊断消息", async () => {
    stubFetch([{ status: 400, body: NOT_FOUND_BODY }]);
    // 注册成功但重试仍 400 —— 即真实的 not-found，不是 cube 未加载。
    const ensure = vi.fn(async (): Promise<[boolean, string | null]> => [
      true,
      null,
    ]);

    const result = await apiCallWithRetry(
      "GET",
      "http://x/memories/c/id",
      "c",
      {},
      ensure,
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    // 关键断言：消息必须还在。若 data 为 null，调用方只能打印 "HTTP 400"。
    expect(result.data).not.toBeNull();
    expect(String(result.data?.message)).toContain("not found");
  });

  it("重注册失败时同样保留原始响应体", async () => {
    stubFetch([{ status: 400, body: NOT_FOUND_BODY }]);
    const ensure = vi.fn(async (): Promise<[boolean, string | null]> => [
      false,
      "cube not registered",
    ]);

    const result = await apiCallWithRetry(
      "GET",
      "http://x/memories/c/id",
      "c",
      {},
      ensure,
    );

    expect(result.status).toBe(400);
    expect(String(result.data?.message)).toContain("not found");
  });

  it("无 ensureCubeRegistered 时也带回 400 正文", async () => {
    stubFetch([{ status: 400, body: NOT_FOUND_BODY }]);

    const result = await apiCallWithRetry(
      "GET",
      "http://x/memories/c/id",
      "c",
      {},
    );

    expect(result.status).toBe(400);
    expect(String(result.data?.message)).toContain("not found");
  });

  it("重试成功时仍返回重试结果，不被错误体覆盖", async () => {
    // 第一次 400（cube 未加载），重注册后第二次成功 —— 既有行为必须保住。
    stubFetch([
      { status: 400, body: { code: 400, message: "cube not loaded" } },
      { status: 200, body: { code: 200, data: { id: "abc" } } },
    ]);
    const ensure = vi.fn(async (): Promise<[boolean, string | null]> => [
      true,
      null,
    ]);

    const result = await apiCallWithRetry(
      "GET",
      "http://x/memories/c/id",
      "c",
      {},
      ensure,
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect((result.data?.data as Record<string, unknown>).id).toBe("abc");
  });

  it("400 无 JSON 正文时 data 为 null 而不抛异常", async () => {
    const fn = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          json: async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          },
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fn);

    const result = await apiCallWithRetry(
      "GET",
      "http://x/memories/c/id",
      "c",
      {},
    );

    expect(result.status).toBe(400);
    expect(result.data).toBeNull();
  });
});
