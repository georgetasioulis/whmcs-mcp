// A stand-in for the WHMCS API: a fetch function that routes each form POST
// to a handler by its `action`, and records every call.

export function fakeWhmcs(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push(params);
    const handler = handlers[params.action];
    if (!handler) {
      return new Response(JSON.stringify({ result: 'error', message: `unmocked action ${params.action}` }));
    }
    const body = await handler(params, calls);
    if (body instanceof Response) return body;
    return new Response(typeof body === 'string' ? body : JSON.stringify({ result: 'success', ...body }));
  };
  return { fetch, calls, callsTo: (action) => calls.filter((c) => c.action === action) };
}

export const config = {
  identifier: 'test-identifier',
  secret: 'test-secret',
  apiUrl: 'https://whmcs.example.com/includes/api.php',
};

/** Slices `items` the way WHMCS pages a list action. */
export function page(items, params, key, item) {
  const start = Number(params.limitstart ?? 0);
  const num = Number(params.limitnum ?? 25);
  const slice = items.slice(start, start + num);
  return {
    totalresults: items.length,
    startnumber: start,
    numreturned: slice.length,
    [key]: { [item]: slice },
  };
}
