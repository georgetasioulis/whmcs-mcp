// Shapes of the WHMCS payloads this server reads field-by-field. Responses are
// otherwise passed through untouched, so only the fields the code relies on are
// declared. WHMCS is loose with types (and the XML fallback returns every
// scalar as a string), so numeric fields are read through Number().

export interface WHMCSConfig {
  identifier?: string;
  secret?: string;
  username?: string;
  password?: string;
  apiUrl: string;
  /** Offer only read tools, and refuse any API action that is not a read. */
  readOnly?: boolean;
  /** Ask before every write (default true). */
  confirmWrites?: boolean;
  /** JSONL file recording every write; false turns it off. */
  auditLog?: string | false;
}

export interface WhmcsResponse {
  result: 'success' | 'error';
  message?: string;
  totalresults?: number | string;
  startnumber?: number | string;
  numreturned?: number | string;
  [key: string]: unknown;
}

export interface Invoice {
  id: number | string;
  userid: number | string;
  invoicenum?: string;
  firstname?: string;
  lastname?: string;
  companyname?: string;
  date: string;
  duedate: string;
  total: string;
  balance?: string;
  status: string;
  paymentmethod?: string;
  currencycode?: string;
  currencyprefix?: string;
}

export interface InvoiceItem {
  id: number | string;
  type: string;
  relid: number | string;
  description: string;
  amount: string;
  taxed?: number | string;
}

export interface ClientProduct {
  id: number | string;
  clientid: number | string;
  pid: number | string;
  regdate: string;
  name: string;
  groupname?: string;
  domain: string;
  nextduedate: string;
  firstpaymentamount: string;
  recurringamount: string;
  paymentmethod?: string;
  billingcycle: string;
  status: string;
  configoptions?: { configoption?: unknown[] } | string;
}

export interface Product {
  pid: number | string;
  gid: number | string;
  type: string;
  name: string;
  module: string;
  paytype: string;
  pricing?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

export interface Client {
  id: number | string;
  firstname: string;
  lastname: string;
  companyname?: string;
  email: string;
  phonenumber?: string;
  currency?: number | string;
  currency_code?: string;
}
