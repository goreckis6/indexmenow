"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBMASTERS_SCOPE = exports.INDEXING_SCOPE = void 0;
exports.parseServiceAccountJson = parseServiceAccountJson;
exports.getServiceAccountToken = getServiceAccountToken;
exports.credentialsInfo = credentialsInfo;
const google_auth_library_1 = require("google-auth-library");
const errors_1 = require("./errors");
exports.INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing";
exports.WEBMASTERS_SCOPE = "https://www.googleapis.com/auth/webmasters";
function parseServiceAccountJson(raw) {
    let info;
    try {
        info = JSON.parse(raw);
    }
    catch {
        throw new errors_1.GoogleApiError("Plik nie jest poprawnym JSON-em konta serwisowego.");
    }
    if (typeof info !== "object" || info === null) {
        throw new errors_1.GoogleApiError("Plik nie jest poprawnym JSON-em konta serwisowego.");
    }
    const record = info;
    if (record["type"] !== "service_account") {
        throw new errors_1.GoogleApiError('Plik JSON musi miec pole "type": "service_account".');
    }
    for (const field of ["client_email", "private_key"]) {
        if (!record[field]) {
            throw new errors_1.GoogleApiError(`Brak pola '${field}' w pliku konta serwisowego.`);
        }
    }
    return record;
}
async function getServiceAccountToken(info, scopes = [exports.INDEXING_SCOPE, exports.WEBMASTERS_SCOPE]) {
    const client = new google_auth_library_1.JWT({
        email: info.client_email,
        // Klucze z JSON-a maja znaki nowej linii zapisane jako \n. Jesli ktos
        // przekleil klucz przez pole tekstowe, trafiaja tu doslownie i OpenSSL
        // odrzuca taki PEM.
        key: info.private_key.replace(/\\n/g, "\n"),
        scopes,
    });
    try {
        const { token } = await client.getAccessToken();
        if (!token)
            throw new Error("Google nie zwrocilo tokena.");
        return token;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new errors_1.GoogleApiError(`Nie udalo sie pobrac tokena konta serwisowego: ${reason}`);
    }
}
/** Minimalny zestaw pol potrzebny do podpisania JWT. */
function credentialsInfo(clientEmail, privateKey, projectId) {
    return {
        type: "service_account",
        client_email: clientEmail,
        private_key: privateKey,
        token_uri: "https://oauth2.googleapis.com/token",
        project_id: projectId ?? "",
    };
}
//# sourceMappingURL=serviceAccount.js.map