import { once } from "node:events";

// Appelé uniquement par integration.mjs, contre son serveur et sa base éphémères.
export async function runGuestJourney({ request, openSocket, guest, member, memberSocket, check }) {
  const incoming = (socket, event) => once(socket, event, { signal: AbortSignal.timeout(5000) });
  const guestSocket = await openSocket(guest.token);
  const me = await request("/api/auth/me", guest.token);
  check(me.status === 200 && me.json.user.guest === true, "guest session restores the temporary identity");
  check((await request("/api/age-status", guest.token)).json.accepted === true, "adult guest can proceed to the community rules");
  check((await request("/api/messages", guest.token, "POST", { room: "cafe", body: "Avant acceptation" })).status === 403, "guest cannot send before accepting the rules");
  check((await request("/api/rules-accept", guest.token, "POST", { accepted: true })).status === 200, "guest can accept the community rules");

  const publicEvent = incoming(memberSocket, "message");
  const first = await request("/api/messages", guest.token, "POST", { room: "cafe", body: "Bonjour depuis le parcours invité" });
  const [publicMessage] = await publicEvent;
  check(first.status === 201 && publicMessage.id === first.json.id && publicMessage.user_id === guest.user.id, "guest first public message reaches another connected member");
  check((await request("/api/messages?room=cafe", guest.token)).json.some(row => row.id === first.json.id), "guest can reload their public message");

  const privateEvent = incoming(memberSocket, "private-message");
  const notificationEvent = incoming(memberSocket, "notification");
  const dm = await request("/api/private", guest.token, "POST", { recipientId: member.user.id, body: "Bonjour en privé depuis mon compte invité" });
  const [privateMessage] = await privateEvent, [notification] = await notificationEvent;
  check(dm.status === 201 && privateMessage.id === dm.json.id, "guest private message arrives live");
  check(notification.actor_id === guest.user.id && notification.type === "private_message", "recipient receives the guest private-message notification");
  check((await request(`/api/private/${guest.user.id}`, member.token)).json.some(row => row.id === dm.json.id), "recipient can reload the guest conversation");

  await request(`/api/private/${guest.user.id}/read`, member.token, "PATCH");
  const history = await request(`/api/private/${member.user.id}`, guest.token);
  check(Boolean(history.json.find(row => row.id === dm.json.id)?.read_at), "guest sees that the recipient read their message");

  guestSocket.disconnect();
  const offline = await request("/api/private", member.token, "POST", { recipientId: guest.user.id, body: "Réponse envoyée pendant la coupure" });
  check(offline.status === 201, "reply persists while the guest is disconnected");
  const restoredSocket = await openSocket(guest.token);
  const conversations = await request("/api/private-conversations", guest.token);
  const conversation = conversations.json.find(row => row.user_id === member.user.id);
  check(Number(conversation?.unread_count) === 1 && conversation?.last_body === offline.json.body, "reconnected guest can recover the missed reply and unread count");
  check((await request("/api/notifications", guest.token)).json.some(row => row.actor_id === member.user.id), "reconnected guest can recover missed notifications");
  const replyEvent = incoming(restoredSocket, "private-message");
  const online = await request("/api/private", member.token, "POST", { recipientId: guest.user.id, body: "Réponse après le retour du réseau" });
  check((await replyEvent)[0].id === online.json.id, "reconnected guest receives new messages live");

  check((await request(`/api/blocks/${member.user.id}`, guest.token, "POST")).status === 201, "guest can block a member");
  check((await request("/api/private", member.token, "POST", { recipientId: guest.user.id, body: "Message bloqué" })).status === 403, "blocking prevents a new message to the guest");
  check((await request(`/api/blocks/${member.user.id}`, guest.token, "DELETE")).status === 200, "guest can undo the block");
  restoredSocket.disconnect();
}
