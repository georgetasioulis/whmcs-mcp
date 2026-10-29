#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadWHMCSConfig } from './config.js';
import { safetySettings } from './safety.js';
import { createServer } from './server.js';
import { WhmcsClient } from './whmcs-client.js';

async function main() {
  const config = loadWHMCSConfig();
  const safety = safetySettings(config);
  const server = createServer(new WhmcsClient(config), safety);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `WHMCS MCP Server running on stdio (${safety.readOnly ? 'read-only' : safety.confirmWrites ? 'writes need confirmation' : 'writes NOT confirmed'}` +
      `${safety.auditLog ? `, audit log ${safety.auditLog}` : ''})`,
  );

  // Hold the process open until the transport closes (from 26a8bdf, "Keep
  // stdio server alive for MCP").
  process.stdin.resume();
  const keepAlive = setInterval(() => {}, 60_000);
  await new Promise<void>((resolve) => {
    transport.onclose = () => {
      clearInterval(keepAlive);
      resolve();
    };
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
