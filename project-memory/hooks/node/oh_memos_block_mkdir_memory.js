#!/usr/bin/env node
/**
 * MemOS Hook: PreToolUse - Block mkdir for memory directories
 *
 * Prevents the model from creating memory directories manually.
 * After context compaction, models sometimes try to mkdir memory folders
 * instead of using MCP memos tools.
 *
 * Hook type: PreToolUse
 * Matcher:   Bash
 *
 * NOTE: the matcher must be the bare tool name. `matcher` is evaluated against
 * the TOOL NAME only — a value containing characters outside
 * [A-Za-z0-9_-, |*] is treated as an unanchored regex, so an expression like
 * `tool == "Bash" && tool_input.command matches "mkdir.*memory"` never matches
 * and the hook silently never fires. The mkdir/memory condition is checked in
 * this script instead. See README "matcher 语法陷阱".
 *
 * Exit codes: 2 blocks the call. 1 does NOT block — it is a non-blocking error.
 */

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const command = (data.tool_input?.command || '').toLowerCase();

    if (command.includes('mkdir') && command.includes('memory')) {
      const cwd = data.cwd || process.cwd();
      console.error('[oh-memos] BLOCKED: Do not create memory directories manually.');
      console.error('[oh-memos] Use MCP oh-memos tools instead: oh_memos_save, oh_memos_search, oh_memos_list_v2');
      console.error(`[oh-memos] Pass project_path for correct cube routing, e.g. project_path="${cwd}"`);
      process.exit(2);
    }

    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch (e) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
