let requestTimeoutMs = 15_000;
export function setRequestTimeoutMs(value: number): void { requestTimeoutMs = value; }
export function getRequestTimeoutMs(): number { return requestTimeoutMs; }

export function fetchWithTimeout(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
