/**
 * memos_list_v2 取数序列的顺序守卫。
 *
 * 存在理由：这段逻辑原本内联在 handler 里，单测触达不到 —— 实测切断层级
 * 过滤后全部 319 项 vitest 依然通过。这与 P1.5 的 W3/W4 同源。
 * 测试与 handler 调用同一个 prepareListMemories，所以这里的断言真的守着
 * 生产路径，而不是只守着测试文件里的一份复制品。
 */
import { describe, expect, it } from "vitest";
import { prepareListMemories } from "./handlers/memory.js";
import type { MemoryNode, SearchData } from "./types.js";

/** tier 是 metadata.memory_type；业务类型走 tags（extractMcpType 的来源）。 */
const rec = (id: string, tier: string, type = "DECISION"): MemoryNode => ({
  id,
  memory: `[${type}] ${id}`,
  tags: [type],
  metadata: { memory_type: tier, type, tags: [type] },
});

const wrap = (memories: MemoryNode[]): SearchData => ({
  text_mem: [{ cube_id: "c", memories }],
});

const ids = (nodes: MemoryNode[]): string[] => nodes.map((n) => n.id!);

describe("prepareListMemories", () => {
  it("配对只留 LongTermMemory —— 用户实测看到的正是这个", () => {
    const data = wrap([
      rec("a2e2b97d", "WorkingMemory"),
      rec("49b59302", "LongTermMemory"),
    ]);
    expect(ids(prepareListMemories(data, undefined, 20))).toEqual(["49b59302"]);
  });

  it("滤层级发生在 slice 之前：limit 不被隐藏项吃掉", () => {
    // 交替 20 条，其中 10 条是 WorkingMemory。limit=10 必须拿到 10 条
    // LongTermMemory；若顺序反了，先 slice 再滤只会剩 5 条。
    const mixed: MemoryNode[] = [];
    for (let i = 0; i < 10; i += 1) {
      mixed.push(rec(`w${i}`, "WorkingMemory"), rec(`l${i}`, "LongTermMemory"));
    }
    const out = prepareListMemories(wrap(mixed), undefined, 10);
    expect(out).toHaveLength(10);
    expect(ids(out).every((id) => id.startsWith("l"))).toBe(true);
  });

  it("滤业务类型也在 slice 之前", () => {
    const mixed: MemoryNode[] = [];
    for (let i = 0; i < 10; i += 1) {
      mixed.push(
        rec(`bug${i}`, "LongTermMemory", "BUGFIX"),
        rec(`dec${i}`, "LongTermMemory", "DECISION"),
      );
    }
    const out = prepareListMemories(wrap(mixed), "DECISION", 10);
    expect(out).toHaveLength(10);
    expect(ids(out).every((id) => id.startsWith("dec"))).toBe(true);
  });

  it("层级与业务类型是两个正交轴，可叠加", () => {
    const data = wrap([
      rec("w-dec", "WorkingMemory", "DECISION"),
      rec("l-bug", "LongTermMemory", "BUGFIX"),
      rec("l-dec", "LongTermMemory", "DECISION"),
    ]);
    expect(ids(prepareListMemories(data, "DECISION", 20))).toEqual(["l-dec"]);
  });

  it("slice 是最后一步：limit 恒为输出上界", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      rec(`l${i}`, "LongTermMemory"),
    );
    expect(prepareListMemories(wrap(many), undefined, 7)).toHaveLength(7);
    expect(prepareListMemories(wrap(many), "DECISION", 3)).toHaveLength(3);
    expect(prepareListMemories(wrap(many), undefined, 0)).toHaveLength(0);
  });

  it("全是 WorkingMemory 时不返回空", () => {
    const all = wrap([rec("a", "WorkingMemory"), rec("b", "WorkingMemory")]);
    expect(ids(prepareListMemories(all, undefined, 20)).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("Lite 记录（无 memory_type）不被误滤", () => {
    const lite: MemoryNode = {
      id: "lite",
      memory: "[DECISION] lite 不写 memory_type",
      tags: ["DECISION"],
      metadata: { type: "DECISION", tags: ["DECISION"] },
    };
    expect(ids(prepareListMemories(wrap([lite]), undefined, 20))).toEqual([
      "lite",
    ]);
  });

  it("空输入与畸形结构不崩", () => {
    expect(prepareListMemories({}, undefined, 20)).toEqual([]);
    expect(prepareListMemories({ text_mem: [] }, undefined, 20)).toEqual([]);
    expect(prepareListMemories(wrap([]), undefined, 20)).toEqual([]);
  });
});
