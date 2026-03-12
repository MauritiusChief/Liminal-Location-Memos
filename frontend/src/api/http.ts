interface ErrorResponse {
  error: string;
}

async function parseError(response: Response): Promise<string> {
  const errorPayload = (await response.json().catch(() => ({ error: 'Request failed.' }))) as ErrorResponse;
  return errorPayload.error || 'Request failed.';
}

export async function getJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response.json() as Promise<T>;
}

export async function postJson<TResponse, TBody>(url: string, body: TBody): Promise<TResponse> {
  return getJson<TResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
