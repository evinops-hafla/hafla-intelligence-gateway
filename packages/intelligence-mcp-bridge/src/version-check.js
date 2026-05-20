export function assertNode24(version = process.version) {
  if (!version.startsWith('v24.')) {
    throw new Error(
      `@hafla/intelligence-mcp-bridge requires Node 24 LTS (you are on ${version}). Install via a Node version manager — see README § "Prerequisites".`
    );
  }
}
