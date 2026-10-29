import { createHash } from 'node:crypto';
import { isJsonEncodingError, parseWhmcsXml } from './xml.js';
import type { WHMCSConfig, WhmcsResponse } from './types.js';

export type ParamValue = string | number | boolean | null | undefined;
export type Params = Record<string, ParamValue>;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type WhmcsClientOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
};

/**
 * Thin transport for the WHMCS API: authenticates every call, posts it as a
 * form, and turns `result: error` into a thrown Error. Endpoint knowledge lives
 * with the tools that use it; this class only knows how to talk to WHMCS.
 */
export class WhmcsClient {
  private readonly apiUrl: string;
  private readonly auth: Record<string, string>;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly readOnly: boolean;

  constructor(config: WHMCSConfig, options: WhmcsClientOptions = {}) {
    this.apiUrl = config.apiUrl;
    this.readOnly = config.readOnly ?? false;
    this.auth = authParams(config);
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async call<T extends WhmcsResponse = WhmcsResponse>(action: string, params: Params = {}): Promise<T> {
    // Second line of defence behind the tool layer: in read-only mode nothing
    // but a read action ever leaves this process.
    if (this.readOnly && !isReadAction(action)) {
      throw new Error(`Refusing ${action}: this WHMCS MCP server is in read-only mode (WHMCS_READ_ONLY).`);
    }
    const body = await this.post(action, params, 'json');

    let data: WhmcsResponse;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`WHMCS returned a non-JSON response to ${action}: ${snippet(body)}`);
    }

    if (data.result === 'error') {
      // WHMCS fails to encode JSON when a record holds non-UTF-8 bytes, which
      // makes calls like GetClientsProducts permanently unusable. XML has no
      // such encoder, so retry there and parse it into the same shape.
      if (isJsonEncodingError(data.message)) {
        return this.callAsXml<T>(action, params);
      }
      throw new Error(data.message || `WHMCS API error in ${action}`);
    }

    return data as T;
  }

  /**
   * Walks every page of a list action and returns the concatenated items.
   * `pick` extracts the item array from one page.
   */
  async fetchAll<T>(
    action: string,
    pick: (page: any) => T[] | undefined,
    params: Params = {},
    pageSize = 250,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.call(action, { ...params, limitstart: offset, limitnum: pageSize });
      const batch = pick(page) ?? [];
      items.push(...batch);

      const total = Number(page.totalresults ?? items.length);
      if (batch.length < pageSize || items.length >= total) {
        return items;
      }
    }
  }

  async checkConnection(): Promise<{ whmcsVersion: string }> {
    try {
      const result = await this.call<WhmcsResponse & { whmcs_version?: string }>('WhmcsDetails');
      return { whmcsVersion: String(result.whmcs_version ?? 'unknown') };
    } catch (error) {
      // WHMCS rejects unknown callers with "Invalid IP 1.2.3.4".
      const ip = error instanceof Error ? error.message.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/) : null;
      if (ip) {
        throw new Error(
          `Your IP ${ip[1]} is not whitelisted in WHMCS API Security settings. ` +
            'Add it at Configuration > System Settings > General Settings > Security > API IP Access Restriction.',
        );
      }
      throw error;
    }
  }

  private async callAsXml<T>(action: string, params: Params): Promise<T> {
    const parsed = parseWhmcsXml(await this.post(action, params, 'xml'));
    if (parsed.result === 'error') {
      throw new Error(typeof parsed.message === 'string' ? parsed.message : `WHMCS API error in ${action}`);
    }
    return parsed as T;
  }

  private async post(action: string, params: Params, responseType: 'json' | 'xml'): Promise<string> {
    const form = new URLSearchParams({ action, ...this.auth, responsetype: responseType });
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      // PHP reads the string "false" as true, so booleans go over the wire as 1/0.
      form.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }

    let response: Response;
    try {
      response = await this.fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`WHMCS API request failed (${action}): ${reason}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `WHMCS API request failed (${action}): HTTP ${response.status}${errorDetail(text)}`,
      );
    }
    return text;
  }
}

/** WHMCS read actions are the Get* family plus WhmcsDetails. */
export function isReadAction(action: string): boolean {
  return /^Get[A-Z]/.test(action) || action === 'WhmcsDetails';
}

function authParams(config: WHMCSConfig): Record<string, string> {
  if (config.identifier && config.secret) {
    return { identifier: config.identifier, secret: config.secret };
  }
  if (config.username && config.password) {
    // The admin-credential API login expects the MD5 of the password; accept
    // an already-hashed value too.
    const password = /^[a-f0-9]{32}$/i.test(config.password)
      ? config.password
      : createHash('md5').update(config.password).digest('hex');
    return { username: config.username, password };
  }
  throw new Error('WHMCS credentials are missing');
}

function errorDetail(body: string): string {
  try {
    const message = JSON.parse(body)?.message;
    if (typeof message === 'string' && message) return ` — ${message}`;
  } catch {
    // not JSON; fall through to the raw body
  }
  return body.trim() ? ` — ${snippet(body)}` : '';
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
