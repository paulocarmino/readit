#!/usr/bin/env node
/**
 * Entrypoint.
 *   readit-idgaf            → MCP server on stdio (what MCP clients run)
 *   readit-idgaf dashboard  → local dashboard (usage, logs, credentials) on 127.0.0.1
 */
if (process.argv[2] === 'dashboard') {
  const { startDashboard } = await import('./dashboard/server.js');
  await startDashboard({ open: !process.argv.includes('--no-open') });
} else {
  const { startMcp } = await import('./mcp.js');
  await startMcp();
}
