import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBillingTools } from './tools/billing.js';
import { registerClientTools } from './tools/clients.js';
import { registerOrderTools } from './tools/orders.js';
import { registerServiceTools } from './tools/services.js';
import { registerSystemTools } from './tools/system.js';
import { registerTicketTools } from './tools/tickets.js';
import { WriteGuard, type SafetySettings } from './safety.js';
import type { ToolHost } from './tool.js';
import type { WhmcsClient } from './whmcs-client.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export function createServer(whmcs: WhmcsClient, safety: SafetySettings): McpServer {
  const server = new McpServer({ name: 'whmcs-mcp-server', version });
  const host: ToolHost = { server, guard: new WriteGuard(safety, server) };

  registerSystemTools(host, whmcs);
  registerTicketTools(host, whmcs);
  registerClientTools(host, whmcs);
  registerServiceTools(host, whmcs);
  registerOrderTools(host, whmcs);
  registerBillingTools(host, whmcs);

  return server;
}
