import { JWT } from "google-auth-library";
import { GoogleApiError } from "./errors.js";

export const INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing";
export const WEBMASTERS_SCOPE = "https://www.googleapis.com/auth/webmasters";

export interface ServiceAccountInfo {
  type?: string;
  client_email: string;
  private_key: string;
  project_id?: string;
  private_key_id?: string;
  token_uri?: string;
}

export function parseServiceAccountJson(raw: string): ServiceAccountInfo {
  let info: unknown;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new GoogleApiError("Plik nie jest poprawnym JSON-em konta serwisowego.");
  }
  if (typeof info !== "object" || info === null) {
    throw new GoogleApiError("Plik nie jest poprawnym JSON-em konta serwisowego.");
  }

  const record = info as Record<string, unknown>;
  if (record["type"] !== "service_account") {
    throw new GoogleApiError('Plik JSON musi miec pole "type": "service_account".');
  }
  for (const field of ["client_email", "private_key"] as const) {
    if (!record[field]) {
      throw new GoogleApiError(`Brak pola '${field}' w pliku konta serwisowego.`);
    }
  }
  return record as unknown as ServiceAccountInfo;
}

export async function getServiceAccountToken(
  info: ServiceAccountInfo,
  scopes: string[] = [INDEXING_SCOPE, WEBMASTERS_SCOPE],
): Promise<string> {
  const client = new JWT({
    email: info.client_email,
    // Klucze z JSON-a maja znaki nowej linii zapisane jako \n. Jesli ktos
    // przekleil klucz przez pole tekstowe, trafiaja tu doslownie i OpenSSL
    // odrzuca taki PEM.
    key: info.private_key.replace(/\\n/g, "\n"),
    scopes,
  });

  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Google nie zwrocilo tokena.");
    return token;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GoogleApiError(`Nie udalo sie pobrac tokena konta serwisowego: ${reason}`);
  }
}

/** Minimalny zestaw pol potrzebny do podpisania JWT. */
export function credentialsInfo(
  clientEmail: string,
  privateKey: string,
  projectId?: string | null,
): ServiceAccountInfo {
  return {
    type: "service_account",
    client_email: clientEmail,
    private_key: privateKey,
    token_uri: "https://oauth2.googleapis.com/token",
    project_id: projectId ?? "",
  };
}
