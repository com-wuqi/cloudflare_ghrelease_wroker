/**
 * Operational log context. Only edge metadata is included: never IPs, cookies,
 * tokens or request bodies.
 */
export function requestLogContext(request: Request): Record<string, unknown> {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const rayId = request.headers.get('cf-ray');
  return {
    ...(rayId ? { rayId } : {}),
    ...(typeof cf?.colo === 'string' ? { colo: cf.colo } : {}),
  };
}
