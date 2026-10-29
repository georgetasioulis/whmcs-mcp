/**
 * Presentation helpers for WHMCS product payloads.
 *
 * Kept out of index.ts so the pricing and slimming rules can be unit-tested
 * without booting the stdio server.
 */

// WHMCS bills a product on one of six cycles and reports a matching setup fee
// for each. A cycle priced at -1 is disabled for that product. `name` is how a
// client service spells its billing cycle.
const BILLING_CYCLES: Array<{ name: string; price: string; setup: string; label: string }> = [
  { name: 'Monthly', price: 'monthly', setup: 'msetupfee', label: 'mo' },
  { name: 'Quarterly', price: 'quarterly', setup: 'qsetupfee', label: 'qtr' },
  { name: 'Semi-Annually', price: 'semiannually', setup: 'ssetupfee', label: '6mo' },
  { name: 'Annually', price: 'annually', setup: 'asetupfee', label: 'yr' },
  { name: 'Biennially', price: 'biennially', setup: 'bsetupfee', label: '2yr' },
  { name: 'Triennially', price: 'triennially', setup: 'tsetupfee', label: '3yr' },
];

/** Every billing cycle a client service can have, recurring or not. */
export const SERVICE_BILLING_CYCLES = [
  'Monthly',
  'Quarterly',
  'Semi-Annually',
  'Annually',
  'Biennially',
  'Triennially',
  'Free Account',
  'One Time',
] as const;

/**
 * The product pricing key for a service's billing cycle (`Semi-Annually` →
 * `semiannually`), or undefined for cycles that do not recur.
 */
export function pricingKeyForCycle(billingCycle: string): string | undefined {
  const wanted = billingCycle.toLowerCase();
  return BILLING_CYCLES.find((cycle) => cycle.name.toLowerCase() === wanted)?.price;
}

/**
 * The catalogue price of `product` for one billing cycle and currency, or
 * undefined when the product has no price there (missing or disabled).
 */
export function catalogPrice(
  pricing: unknown,
  currencyCode: string,
  billingCycle: string,
): number | undefined {
  const key = pricingKeyForCycle(billingCycle);
  const prices = (pricing as Record<string, Record<string, unknown>> | undefined)?.[currencyCode];
  if (!key || !prices || !isEnabledPrice(prices[key])) return undefined;
  return Number(prices[key]);
}

function isEnabledPrice(value: unknown): boolean {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

/**
 * Renders the pricing block WHMCS returns per currency into one compact cell,
 * e.g. `€49.90/mo, €499.00/yr (+€100.00 setup/yr)`. Only enabled cycles are
 * listed; a product with no enabled cycle reads as `free` or `-`. With several
 * currencies each gets its own labelled group, since a prefix such as `$` does
 * not say which dollar: `EUR: €20.00/mo; USD: $22.00/mo`.
 */
export function formatProductPricing(pricing: unknown): string {
  if (!pricing || typeof pricing !== 'object') {
    return '-';
  }

  const rendered = Object.entries(pricing as Record<string, any>)
    .map(([code, prices]) => [code, formatCurrencyPricing(code, prices)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);

  if (!rendered.length) return '-';
  if (rendered.length === 1) return rendered[0][1];
  return rendered.map(([code, text]) => `${code}: ${text}`).join('; ');
}

function formatCurrencyPricing(code: string, prices: unknown): string | null {
  if (!prices || typeof prices !== 'object') {
    return null;
  }
  const p = prices as Record<string, unknown>;

  // WHMCS ships the prefix with its trailing space ("R$ "), so keep it as-is.
  // The suffix repeats the currency code ("US$ 10.00 USD"), so it only earns
  // its place when there is no prefix to identify the currency.
  const prefix = String(p.prefix ?? '');
  const suffix = String(p.suffix ?? '').trim();
  const money = (value: unknown) =>
    prefix ? `${prefix}${String(value)}` : `${suffix || code} ${String(value)}`;

  const parts: string[] = [];
  const setups: string[] = [];
  let allZero = true;

  for (const cycle of BILLING_CYCLES) {
    const price = p[cycle.price];
    if (!isEnabledPrice(price)) continue;
    parts.push(`${money(price)}/${cycle.label}`);
    if (Number(price) > 0) {
      allZero = false;
    }

    const setup = p[cycle.setup];
    if (isEnabledPrice(setup) && Number(setup) > 0) {
      setups.push(`${money(setup)} setup/${cycle.label}`);
    }
  }

  if (!parts.length) {
    return null;
  }

  const summary = allZero && !setups.length ? 'free' : parts.join(', ');
  return setups.length ? `${summary} (+${setups.join(', ')})` : summary;
}

/**
 * Product descriptions are store HTML and dominate the payload — the full
 * catalogue runs to hundreds of KB, most of it markup no caller asked for.
 * Config options and custom fields are similarly bulky. Strip them unless the
 * caller opted into the full record.
 */
export function slimProducts<T>(result: T, includeFullDetails: boolean): T {
  if (includeFullDetails) {
    return result;
  }

  const products = (result as any)?.products?.product;
  if (!Array.isArray(products)) {
    return result;
  }

  return {
    ...result,
    products: {
      product: products.map(({ description, configoptions, customfields, ...rest }: any) => rest),
    },
  };
}
