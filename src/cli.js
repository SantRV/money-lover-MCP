#!/usr/bin/env node
import { clip } from './redact.js';
import { startMoneyloverServer } from './server.js';

startMoneyloverServer().catch((error) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(clip(`Money Lover MCP server failed to start: ${err.message}`));
  process.exitCode = 1;
});
