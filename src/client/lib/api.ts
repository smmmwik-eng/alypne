export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[] | undefined;

async function request<T>(method: string, url: string, body?: Json | FormData, opts: { idempotent?: boolean; signal?: AbortSignal; onProgress?: (p: number) => void } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-alypne-client': 'web' };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  if (opts.idempotent) headers['idempotency-key'] = crypto.randomUUID();

  if (opts.onProgress && body instanceof FormData) return uploadWithProgress<T>(method, url, body, headers, opts.onProgress);

  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Could not reach Alypne. Check your connection and try again.');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

function uploadWithProgress<T>(method: string, url: string, body: FormData, headers: Record<string, string>, onProgress: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `/api${url}`);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Upload failed. Check your connection.'));
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.error?.code ?? 'error', data?.error?.message ?? `Upload failed (${xhr.status})`));
    };
    xhr.send(body);
  });
}

export const api = {
  get: <T = any>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, { signal }),
  post: <T = any>(url: string, body?: Json | FormData, opts?: { idempotent?: boolean; onProgress?: (p: number) => void }) => request<T>('POST', url, body ?? {}, opts),
  patch: <T = any>(url: string, body?: Json) => request<T>('PATCH', url, body ?? {}),
  put: <T = any>(url: string, body?: Json) => request<T>('PUT', url, body ?? {}),
  del: <T = any>(url: string, body?: Json) => request<T>('DELETE', url, body),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
