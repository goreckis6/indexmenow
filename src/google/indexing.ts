import { googleRequest } from "./http.js";

const PUBLISH_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications:publish";
const METADATA_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications/metadata";

export type NotificationType = "URL_UPDATED" | "URL_DELETED";

export interface PublishResult {
  urlNotificationMetadata?: {
    url?: string;
    latestUpdate?: { url?: string; type?: string; notifyTime?: string };
    latestRemove?: { url?: string; type?: string; notifyTime?: string };
  };
}

/** Informuje Google, ze adres zostal zmieniony albo usuniety. */
export function publishUrl(
  accessToken: string,
  url: string,
  notificationType: NotificationType = "URL_UPDATED",
): Promise<PublishResult> {
  return googleRequest<PublishResult>(PUBLISH_ENDPOINT, {
    method: "POST",
    accessToken,
    jsonBody: { url, type: notificationType },
  });
}

export function getUrlMetadata(accessToken: string, url: string): Promise<PublishResult> {
  return googleRequest<PublishResult>(METADATA_ENDPOINT, { accessToken, params: { url } });
}
