// Comment webhook — the third notify channel (besides email/SMS). Fire-and-
// forget: a webhook failure must never touch the comment flow.
import { getOption } from "./options.js";
import { getSettings } from "./queries.js";
import { createLogger } from "./logger.js";

const log = createLogger("webhook");

/** The request body, split out so the test can assert shape without a server. */
export function buildPayload(event: string, payload: object, siteName?: string) {
  return {
    event,
    ...(siteName ? { site: siteName } : {}),
    data: payload,
    ts: new Date().toISOString(),
  };
}

export async function fireWebhook(event: string, payload: object): Promise<void> {
  try {
    const url = await getOption<string>("webhook_url", "");
    if (!url) return; // not configured — zero cost
    let siteName: string | undefined;
    try {
      siteName = (await getSettings()).siteTitle || undefined;
    } catch {
      // site name is garnish; a settings read failure must not block the fire
    }
    const body = buildPayload(event, payload, siteName);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) log.error(`[webhook] ${event} -> ${url} responded ${res.status}`);
  } catch (e) {
    log.error("[webhook] fire failed:", e);
  }
}
