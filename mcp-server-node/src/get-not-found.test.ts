/**
 * not-found 文案必须指向可行的下一步。
 *
 * 旧文案的第一条建议是「核对 id 是否正确（从 memos_search 结果复制）」，
 * 而实测最常见的成因正是**照做了**：搜索返回 WorkingMemory 层的 id，
 * 该层每 `user_name` 只留 20 条（`manager.py` 的 memory_size），
 * 每次检索重写并淘汰。`oh_memos_cube` 的 20 条实测只覆盖 22 分钟。
 *
 * 这些断言防的是文案被改回「去 search 复制 id」这类死循环建议。
 */
import { describe, expect, it } from "vitest";
import { notFoundText } from "./handlers/memory.js";

const ID = "4522a094-1111-2222-3333-444455556666";

describe("notFoundText", () => {
  it("带上被查询的 id，便于用户核对", () => {
    expect(notFoundText(ID)).toContain(ID);
  });

  it("点明短期层淘汰是最常见成因", () => {
    const text = notFoundText(ID);
    expect(text).toContain("WorkingMemory");
    // 数量上限是用户能自行判断「隔多久会失效」的关键信息。
    expect(text).toContain("20");
  });

  it("给出取持久 id 的替代路径", () => {
    // 只说「重新 search」不够 —— 那还会拿到同样易失的 id。
    expect(notFoundText(ID)).toContain("memos_list_v2");
  });

  it("不把淘汰断言成唯一原因", () => {
    const text = notFoundText(ID);
    // Lite 模式没有 WorkingMemory 层，那里的 not-found 是单纯不存在。
    expect(text).toContain("删除");
    expect(text).toContain("project_path");
  });
});
