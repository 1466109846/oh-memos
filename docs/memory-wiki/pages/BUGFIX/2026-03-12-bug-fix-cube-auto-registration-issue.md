---
generator: oh-memos-wiki-export
id: 76bc0a43-e714-4bfc-87fe-2fb9dda2134f
type: BUGFIX
status: activated
tags: ["bug fix", "cube registration", "API endpoint", "audiocraft_studio_cube", "KeyError", "auto-registration", "start_api.py"]
confidence: 0.99
created: 2026-03-12T21:14:44.822685000+00:00
updated: 2026-03-12T21:14:44.824688000+00:00
---

# Bug Fix: Cube Auto-Registration Issue

On March 12, 2026 at 9:14 PM, the user identified and fixed a bug in the cube auto-registration system. The issue occurred when accessing the endpoint `/memories?mem_cube_id=audiocraft_studio_cube`, which threw a `KeyError` because the cube 'audiocraft_studio_cube' was not registered. The root cause was that the `get_all_memories` API endpoint directly called `mos_instance.get_all()` without checking if the cube was already registered, bypassing the MCP server's `ensure_cube_registered` protection. To fix this, the user added logic in `start_api.py` to check if the target cube exists in the user's accessible cubes, derive its path from the `MEMOS_CUBES_DIR` environment variable if missing, register it using `mos_instance.register_mem_cube()` if the path exists, and handle exceptions gracefully to avoid disrupting normal operations.

## 关联

- 被上级 ← [[2026-04-18-cube自动注册问题修复与api启动优化]]
