/**
 * `GET /memories/{cube}/{id}` 必须显式带 user_id。
 *
 * ## 实测症状
 *
 * `memos_get(memory_id=..., project_path="G:/work/jincaizhaopin")` 回：
 *
 * ```
 * ❌ [API_ERROR] Get failed: User 'root' does not have access to cube
 *    'jincaizhaopin_cube'. Please register the cube first or request access.
 * ```
 *
 * 而 MEMOS_USER 配的是 dev_user，root 从未出现在任何调用参数里。
 *
 * ## root 是哪来的
 *
 * `start_api.py` 的 `get_memory(mem_cube_id, memory_id, user_id=None)` 把
 * user_id 声明为可选；缺失时 `core.py` 的 `get()` 回退到 `self.user_id`
 * —— 即 MOS 实例自己的用户（root）。`ensureCubeRegistered` 注册的却是
 * MEMOS_USER，所以 root 对该 cube 无授权，`_validate_cube_access` 抛
 * ValueError，被 ValueError handler 映射成 400。
 *
 * ## 为什么重注册重试救不回来
 *
 * `apiCallWithRetry` 的 400 分支会重注册后重试，但重注册仍然按 MEMOS_USER
 * 注册，重试请求仍然不带 user_id —— 第二次照样落到 root。所以这不是「cube
 * 未加载」，重试永远无效，必须在请求里带上 user_id。
 *
 * 实测对照（同一个不存在的 id）：
 *   不带 user_id            -> "User 'root' does not have access to cube ..."
 *   带 user_id=dev_user     -> "Memory with ID ... not found"（正常语义）
 *
 * 同源缺陷也存在于 wiki-import.ts 的 getStoredMemory —— 那里更隐蔽：该消息
 * 既不含 "not found" 也不是 404，会被当成真实故障，把整页 import 判成失败。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // provider 必须是 api —— local 走 JSONL，根本不发这个请求。
  process.env.MEMOS_MODE = "full";
  process.env.MEMOS_PROVIDER = "api";
  process.env.MEMOS_URL = "http://stub";
  process.env.MEMOS_USER = "dev_user";
  process.env.MEMOS_DEFAULT_CUBE = "stub_cube";
  process.env.MEMOS_CUBES_DIR = process.cwd();
});

// 真实实现会去 POST /mem_cubes；这里只需要它放行。
vi.mock("./cube-manager.js", () => ({
  ensureCubeRegistered: vi.fn(async (): Promise<[boolean, string | null]> => [
    true,
    null,
  ]),
  getDefaultCubeId: () => "stub_cube",
}));

import { handleMemosGet } from "./handlers/memory.js";

/**
 * 记录每次 fetch 的 URL，并**按 user_id 是否存在分流** —— 复刻实测：
 * 同一个不存在的 id，缺 user_id 得到授权错误，带上才得到 not-found。
 * 无条件回 not-found 的 stub 守不住这个缺陷（去掉 user_id 也照样绿）。
 */
function stubFetch(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      const message = u.includes("user_id=")
        ? "Memory with ID probe not found"
        : "User 'root' does not have access to cube 'stub_cube'. Please register the cube first or request access.";
      return {
        ok: false,
        status: 400,
        json: async () => ({ code: 400, message, data: null }),
      } as unknown as Response;
    }),
  );
  return { urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleMemosGet 的请求参数", () => {
  it("请求 URL 带 user_id，否则后端回退到 root", async () => {
    const { urls } = stubFetch();

    await handleMemosGet({ cube_id: "stub_cube", memory_id: "probe" });

    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain("/memories/stub_cube/probe");
    // 这一条是整个缺陷的核心：缺了它，后端按自己的默认用户校验授权。
    expect(urls[0]).toContain("user_id=dev_user");
  });

  it("400 后的重注册重试也带 user_id", async () => {
    const { urls } = stubFetch();

    await handleMemosGet({ cube_id: "stub_cube", memory_id: "probe" });

    // 重试若丢掉 user_id，会第二次落到 root —— 用户看到的仍是权限错误。
    for (const url of urls) {
      expect(url).toContain("user_id=dev_user");
    }
  });

  it("拿到 not-found 正文时给 not-found 文案，而不是通用 API 错误", async () => {
    stubFetch();

    const out = await handleMemosGet({
      cube_id: "stub_cube",
      memory_id: "probe",
    });

    // 带上 user_id 后，同一个 id 的后端语义从「无授权」变回「不存在」。
    expect(out[0].text).toContain("Memory not found");
    expect(out[0].text).not.toContain("does not have access");
  });
});
