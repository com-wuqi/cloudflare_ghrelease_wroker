/** Small HTTP response helpers shared by the router and the admin endpoints. */

export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

export function textResponse(
  text: string,
  status: number,
  contentType: string,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  return new Response(text, { status, headers });
}

export function redirect(location: string, cookie?: string, status = 302): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(null, { status, headers });
}

export function notFound(body: 'json' | 'text' = 'text'): Response {
  return body === 'json'
    ? jsonResponse({ error: 'not_found' }, 404)
    : textResponse('Not Found', 404, 'text/plain; charset=utf-8');
}

export function methodNotAllowed(allow: string, body: 'json' | 'text' = 'text'): Response {
  return body === 'json'
    ? jsonResponse({ error: 'method_not_allowed' }, 405, { allow })
    : textResponse('Method Not Allowed', 405, 'text/plain; charset=utf-8', { allow });
}
