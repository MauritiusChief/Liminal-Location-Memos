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

/**
 * 通用 NDJSON 读取器。
 * 之所以放在 API 层而不是页面组件里，是因为“半包拼接 / 解码 / JSON 行切分”属于传输细节，
 * 未来 game turn 若也改成 stream，可以直接复用这里，而不是再在页面里重写一遍。
 */
export async function streamNdjson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  onMessage: (message: T) => void,
): Promise<void> {
  const response = await fetch(input, init);

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  if (!response.body) {
    throw new Error('Stream response body is empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      onMessage(JSON.parse(trimmed) as T);
    }
  }

  buffer += decoder.decode();
  const trailingLine = buffer.trim();
  if (trailingLine) {
    onMessage(JSON.parse(trailingLine) as T);
  }
}
