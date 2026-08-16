# 反查记录 — 2026-08-16（Lite 语义检索轮）

## 数据事故与恢复

本轮全量验证时发现文档守卫测试失败，根因是上一轮的
`perl -pi -e 's/\s+$//'`：`-p` 模式下 `\s` 匹配行终止符本身，把
`docs/CHANGELOG.md` 和 `docs/future/ROADMAP.md` 的全部换行剥掉，两文件压成单行。

恢复方式：`git show :<path>` 取回完好的暂存区版本，ARCHITECTURE.md 的
标记图块（受守卫测试保护）作为规范副本重建 CHANGELOG 的 🧭 章节，
其余 7 个 Unreleased 章节按对话中的原文重新写入；ROADMAP 状态表整块重写。
教训：行尾清理必须用 `s/[ \t]+$//`，绝不能用 `\s+$` 配合 `perl -pi`。

## 目标状态（本轮后）

- ✅ Lite 本地语义检索：可选 Ollama `/api/embeddings`，混合排序
  0.6 语义 + 0.4 词法，embedding 持久化于 JSONL 但永不外泄，
  Ollama 不可用自动回退纯词法（零配置默认不变）。
- ✅ 关系边回灌（上一轮）：`POST /product/graph/relation` + wiki-relations。
- ⏸ tree_text 原地更新：唯一保留项，需跨 Neo4j/Qdrant 的
  ID-preserving saga 与补偿合同，不做 delete+add 伪更新。

## 验证

- Node 测试 19 文件 / 153+ 测试（含 lite-embedding 3 个、provider 语义 5 个）。
- schema budget 0% 漂移；Python 编译通过。
- 文档守卫（architecture-docs.test.ts）恢复绿色。
