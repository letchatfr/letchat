import { ECDH } from "node:crypto";
import { lookup } from "node:dns";
import { Agent } from "node:https";
import { BlockList, isIP } from "node:net";

export const MAX_PUSH_SUBSCRIPTIONS = 10;

// Only browser push services are valid destinations. Never accept arbitrary
// HTTPS hosts, suffix lookalikes, credentials, custom ports or fragments.
export function isPushHost(host) {
  return host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+push\.apple\.com$/.test(host) ||
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.notify\.windows\.com$/.test(host);
}

export function validatePushSubscription(value) {
  const invalid = () => Object.assign(new Error("Abonnement aux notifications incorrect"), { status: 400, expose: true });
  if (typeof value?.endpoint !== "string" || value.endpoint.length > 2000 ||
      /[\s\\]/.test(value.endpoint)) throw invalid();
  let url;
  try { url = new URL(value.endpoint); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.hash || !isPushHost(url.hostname) || url.pathname === "/") throw invalid();
  const key = (name, size) => {
    const encoded = value?.keys?.[name];
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) ||
        encoded.length > 90) throw invalid();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length !== size || bytes.toString("base64url") !== encoded.replace(/=+$/, "")) throw invalid();
    return bytes;
  };
  const publicKey = key("p256dh", 65), authKey = key("auth", 16);
  if (publicKey[0] !== 4) throw invalid();
  try { ECDH.convertKey(publicKey, "prime256v1"); } catch { throw invalid(); }
  return { endpoint: url.href, keys: { p256dh: publicKey.toString("base64url"), auth: authKey.toString("base64url") } };
}

// Pin the addresses checked by this lookup to the actual HTTPS connection.
// DNS changes cannot cause a second, unchecked lookup to a private address.
const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) denied.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]])
  denied.addSubnet(address, prefix, "ipv6");

export function isPublicPushAddress(address) {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}

export function createPushLookup(resolve = lookup) {
  return (hostname, options, callback) => {
    const blocked = () => Object.assign(new Error("Destination de notification non autorisée"), { code: "EACCES" });
    if (!isPushHost(hostname)) return callback(blocked());
    const family = typeof options === "number" ? options : options?.family;
    resolve(hostname, { all: true, family: family || 0 }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses?.length || addresses.some(entry => !isPublicPushAddress(entry.address))) return callback(blocked());
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export const pushAgent = new Agent({ lookup: createPushLookup(), maxSockets: 10 });

export async function sendValidatedPush(webpush, subscription, payload) {
  const validated = validatePushSubscription(subscription);
  // web-push uses https.request and rejects 3xx; it does not follow redirects.
  return webpush.sendNotification(validated, JSON.stringify(payload), {
    TTL: 60 * 60, timeout: 5000, agent: pushAgent
  });
}
