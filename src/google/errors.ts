/** Blad z dowolnego endpointu Google, sprowadzony do jednego kształtu. */
export class GoogleApiError extends Error {
  readonly statusCode: number | undefined;
  readonly payload: Record<string, unknown>;

  constructor(
    message: string,
    statusCode?: number | undefined,
    payload?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "GoogleApiError";
    this.statusCode = statusCode;
    this.payload = payload ?? {};
  }

  get isQuota(): boolean {
    return this.statusCode === 429 || this.message.toLowerCase().includes("quota");
  }

  get isPermission(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  override toString(): string {
    return this.statusCode ? `[${this.statusCode}] ${this.message}` : this.message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseError(statusCode: number, body: unknown): GoogleApiError {
  if (isRecord(body)) {
    const err = body["error"];
    if (isRecord(err)) {
      const message = typeof err["message"] === "string" ? err["message"] : JSON.stringify(err);
      return new GoogleApiError(message, statusCode, body);
    }
    if (typeof err === "string") {
      const description = body["error_description"];
      const message = typeof description === "string" ? `${err}: ${description}` : err;
      return new GoogleApiError(message, statusCode, body);
    }
    return new GoogleApiError(JSON.stringify(body).slice(0, 500), statusCode, body);
  }
  return new GoogleApiError(String(body).slice(0, 500), statusCode);
}

/**
 * Google zwraca JSON przy bledach API, ale przy awarii proxy albo bramki
 * potrafi przyslac HTML. Zwracamy wtedy surowy tekst, zeby komunikat
 * w panelu nie byl pusty.
 */
export async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
