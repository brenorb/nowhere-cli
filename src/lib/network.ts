let requestTimeoutMs = 15_000;
export function setRequestTimeoutMs(value: number): void { requestTimeoutMs = value; }
export function getRequestTimeoutMs(): number { return requestTimeoutMs; }

export function fetchWithTimeout(input: string | URL): Promise<Response> {
  return fetch(input, { signal: AbortSignal.timeout(requestTimeoutMs) });
}
