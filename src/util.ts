import type { Client } from './types.js';

// WHMCS dates are plain `YYYY-MM-DD` strings in the installation's timezone.
// Keeping them as strings avoids the off-by-one-day drift that comes from
// parsing them into a Date (UTC) and printing them back out in local time.

export function isoDate(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The date part of a WHMCS date/datetime, or null for empty and zero dates. */
export function datePart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== '0000-00-00' ? day : null;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** The `months` month keys (YYYY-MM) ending with the month of `today`, oldest first. */
export function recentMonths(months: number, today = isoDate()): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/** Like Promise.all over `items.map(fn)`, but with at most `limit` calls in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function clientName(client: Partial<Client> | undefined): string {
  if (!client) return '';
  const person = `${client.firstname ?? ''} ${client.lastname ?? ''}`.trim();
  return client.companyname ? (person ? `${person} (${client.companyname})` : client.companyname) : person;
}

/** WHMCS wraps a list in `{ items: { item: [...] } }`, or an empty string when there are none. */
export function listOf<T>(container: unknown, key: string): T[] {
  if (!container || typeof container !== 'object') return [];
  const value = (container as Record<string, unknown>)[key];
  if (Array.isArray(value)) return value as T[];
  return value && typeof value === 'object' ? [value as T] : [];
}

export function money(amount: number): string {
  return amount.toFixed(2);
}
