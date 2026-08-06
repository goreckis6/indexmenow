import { GoogleApiError, parseError, safeJson } from "./errors";

const TIMEOUT_MS = 45_000;

export interface RequestOptions {
  method?: string;
  accessToken: string;
  jsonBody?: unknown;
  params?: Record<string, string>;
}

/**
 * Jedno miejsce, przez ktore ida wszystkie zapytania do API Google.
 * Kazdy blad - sieciowy czy zwrocony przez Google - wychodzi stad jako
 * GoogleApiError, zeby warstwa wyzej nie musiala rozpoznawac typow wyjatkow.
 */
export async function googleRequest<T = unknown>(
  url: string,
  { method = "GET", accessToken, jsonBody, params }: RequestOptions,
): Promise<T> {
  const target = params ? `${url}?${new URLSearchParams(params).toString()}` : url;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (jsonBody !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      ...(jsonBody === undefined ? {} : { body: JSON.stringify(jsonBody) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GoogleApiError(`Blad polaczenia z Google: ${reason}`);
  }

  if (response.status === 204) return {} as T;
  const data = await safeJson(response);
  if (!response.ok) throw parseError(response.status, data);
  return (data === "" ? {} : data) as T;
}

export function encodeProperty(propertyUrl: string): string {
  return encodeURIComponent(propertyUrl);
}
