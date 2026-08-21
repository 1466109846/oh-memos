import { describe, expect, it } from "vitest";
import {
  filterEphemeralTier,
  isEphemeralTier,
  showsEphemeralTier,
} from "./memory-tier.js";
import { applyMemoryQualityPolicy } from "./memory-quality.js";
import type { MemoryNode } from "./types.js";

/** 只带 metadata 的最小节点。 */
const node = (memoryType?: string, id = "x") => ({
  id,
  metadata: memoryType === undefined ? {} : { memory_type: memoryType },
});
const metaOf = (n: { metadata: unknown }): unknown => n.metadata;

describe("isEphemeralTier", () => {
  it("只有 WorkingMemory 算短期层", () => {
    expect(isEphemeralTier({ memory_type: "WorkingMemory" })).toBe(true);
    expect(isEphemeralTier({ memory_type: "LongTermMemory" })).toBe(false);
    expect(isEphemeralTier({ memory_type: "UserMemory" })).toBe(false);
  });

  it("缺失 memory_type 视为可见（Lite 模式不写该字段）", () => {
    // 若这里返回 true，整个 Lite cube 会被过滤成空。
    expect(isEphemeralTier({})).toBe(false);
    expect(isEphemeralTier(undefined)).toBe(false);
    expect(isEphemeralTier(null)).toBe(false);
    expect(isEphemeralTier({ type: "DECISION" })).toBe(false);
  });

  it("不把业务类型误当层级", () => {
    // metadata.type 与 metadata.memory_type 是两个正交的轴。
    expect(isEphemeralTier({ type: "WorkingMemory" })).toBe(false);
  });

  it("大小写敏感 —— 后端写的是精确字符串", () => {
    expect(isEphemeralTier({ memory_type: "workingmemory" })).toBe(false);
  });
});

describe("showsEphemeralTier", () => {
  it("默认不显示", () => {
    expect(showsEphemeralTier({})).toBe(false);
  });

  it("仅 'true' 开启，大小写不敏感", () => {
    expect(showsEphemeralTier({ MEMOS_SHOW_WORKING_MEMORY: "true" })).toBe(
      true,
    );
    expect(showsEphemeralTier({ MEMOS_SHOW_WORKING_MEMORY: "TRUE" })).toBe(
      true,
    );
  });

  it("其他值一律不开启", () => {
    for (const v of ["", "1", "yes", "false", "no"]) {
      expect(showsEphemeralTier({ MEMOS_SHOW_WORKING_MEMORY: v })).toBe(false);
    }
  });
});

describe("filterEphemeralTier", () => {
  const OFF = {} as NodeJS.ProcessEnv;
  const ON = { MEMOS_SHOW_WORKING_MEMORY: "true" } as NodeJS.ProcessEnv;

  it("滤掉 WorkingMemory，保留其他层", () => {
    const items = [
      node("WorkingMemory", "w"),
      node("LongTermMemory", "l"),
      node("UserMemory", "u"),
    ];
    expect(filterEphemeralTier(items, metaOf, OFF).map((n) => n.id)).toEqual([
      "l",
      "u",
    ]);
  });

  it("配对场景：只留 LongTermMemory 那一条（用户实测的正是这个）", () => {
    const pair = [
      node("WorkingMemory", "a2e2b97d"),
      node("LongTermMemory", "49b59302"),
    ];
    expect(filterEphemeralTier(pair, metaOf, OFF).map((n) => n.id)).toEqual([
      "49b59302",
    ]);
  });

  it("全是 WorkingMemory 时原样返回，不返回空", () => {
    // 「一条都没有」比「多一层」伤害大得多。
    const all = [node("WorkingMemory", "a"), node("WorkingMemory", "b")];
    expect(filterEphemeralTier(all, metaOf, OFF).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("开关打开时原样返回", () => {
    const items = [node("WorkingMemory", "w"), node("LongTermMemory", "l")];
    expect(filterEphemeralTier(items, metaOf, ON).map((n) => n.id)).toEqual([
      "w",
      "l",
    ]);
  });

  it("空输入与无 metadata 的记录都不崩", () => {
    expect(filterEphemeralTier([], metaOf, OFF)).toEqual([]);
    const bare = [node(undefined, "a"), node("LongTermMemory", "b")];
    expect(filterEphemeralTier(bare, metaOf, OFF).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("不改动保留项，原对象引用透传", () => {
    const keep = node("LongTermMemory", "l");
    const [out] = filterEphemeralTier(
      [node("WorkingMemory", "w"), keep],
      metaOf,
      OFF,
    );
    expect(out).toBe(keep);
  });
});

// 与 quality policy 的联动。memory-tier 单测各自绿灯不代表接线正确。
describe("applyMemoryQualityPolicy 滤掉短期层", () => {
  const rec = (id: string, tier: string): MemoryNode => ({
    id,
    memory: `[DECISION] ${id} 内容各异以免被近重复折叠 ${id.repeat(8)}`,
    metadata: {
      memory_type: tier,
      relativity: 0.8,
      confidence: 0.8,
      type: "DECISION",
      status: "activated",
      updated_at: new Date().toISOString(),
    },
  });

  const ranked = (nodes: MemoryNode[], env?: NodeJS.ProcessEnv): string[] => {
    const out = applyMemoryQualityPolicy(
      { text_mem: [{ cube_id: "c", memories: nodes }] },
      { env: env ?? ({} as NodeJS.ProcessEnv) },
    );
    return (out.text_mem![0].memories as MemoryNode[]).map((m) => m.id!);
  };

  it("配对只剩 LongTermMemory 那条", () => {
    expect(ranked([rec("work", "WorkingMemory"), rec("long", "LongTermMemory")])).toEqual([
      "long",
    ]);
  });

  it("UserMemory 与 LongTermMemory 都保留", () => {
    expect(
      ranked([rec("u", "UserMemory"), rec("l", "LongTermMemory"), rec("w", "WorkingMemory")])
        .sort(),
    ).toEqual(["l", "u"]);
  });

  it("全是 WorkingMemory 时不返回空", () => {
    expect(ranked([rec("a", "WorkingMemory"), rec("b", "WorkingMemory")]).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("开关打开时两层都保留", () => {
    const env = { MEMOS_SHOW_WORKING_MEMORY: "true" } as NodeJS.ProcessEnv;
    expect(ranked([rec("w", "WorkingMemory"), rec("l", "LongTermMemory")], env).sort()).toEqual([
      "l",
      "w",
    ]);
  });

  it("Lite 记录（无 memory_type）不受影响", () => {
    const lite: MemoryNode = {
      id: "lite",
      memory: "[DECISION] lite 模式不写 memory_type 字段",
      metadata: { relativity: 0.8, type: "DECISION", status: "activated" },
    };
    expect(ranked([lite])).toEqual(["lite"]);
  });
});
