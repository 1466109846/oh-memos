const MINIMUM_NODE_MAJOR = 20;

export function unsupportedNodeMessage(version: string): string | null {
  const [majorText = ""] = version.split(".");
  const major = Number(majorText);
  if (Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR) return null;

  return (
    `oh-memos-mcp requires Node.js >=${MINIMUM_NODE_MAJOR}.0.0; detected ${version}. ` +
    "Upgrade Node.js and retry."
  );
}
