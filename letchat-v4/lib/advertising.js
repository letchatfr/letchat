import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// This document contains only public editorial content. Never apply this CSP
// or load AdSense in the chat application, authentication or legal documents.
export async function installAdvertisingPage(app) {
  const html = await readFile(new URL("../templates/decouvrir.html", import.meta.url), "utf8");
  app.get("/decouvrir", (_req, res) => res.redirect(301, "/decouvrir.html"));
  app.get("/decouvrir.html", (_req, res) => {
    const nonce = randomBytes(24).toString("base64");
    // Google's documented nonce CSP: the advertising document has its own
    // policy; the restricted Firebase/chat CSP remains unchanged elsewhere.
    res.set({
      "Content-Security-Policy": [
        "object-src 'none'",
        `script-src 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:`,
        "script-src-attr 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : [])
      ].join("; "),
      "Cache-Control": "private, no-store"
    });
    res.type("html").send(html.replaceAll("__CSP_NONCE__", nonce));
  });
}
