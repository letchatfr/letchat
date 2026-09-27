const types = new Set(["invite", "join", "offer", "answer", "ice", "decline", "leave"]);
export const callUser = user => ({ id: user.id, name: user.name, photo: user.photo || null });

export class CallRegistry {
  constructor({ sockets, permitted, now = Date.now }) {
    this.sockets = sockets; this.permitted = permitted; this.now = now;
    this.calls = new Map(); this.bySocket = new Map(); this.invites = new Map();
  }
  end(socketId, reason = "ended") {
    const id = this.bySocket.get(socketId), call = this.calls.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    this.calls.delete(id);
    for (const member of [call.caller, call.callee]) {
      this.bySocket.delete(member);
      this.sockets.get(member)?.emit("webrtc", { from: member === call.caller ? call.callee : call.caller,
        data: { type: "leave", callId: id, reason } });
    }
  }
  endBetween(a, b) {
    for (const call of this.calls.values()) {
      const ids = [this.sockets.get(call.caller)?.user.id, this.sockets.get(call.callee)?.user.id];
      if (ids.includes(a) && ids.includes(b)) this.end(call.caller, "blocked");
    }
  }
  async handle(socket, payload = {}) {
    const { target, data } = payload || {};
    if (!data || !types.has(data.type) || typeof data.callId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(data.callId) || JSON.stringify(data).length > 65536) return;
    const { type, callId } = data;
    let call = this.calls.get(callId);
    if (type === "leave") {
      if (call && this.bySocket.get(socket.id) === callId) this.end(socket.id);
      return;
    }
    const recipient = this.sockets.get(String(target));
    if (!recipient || recipient.id === socket.id || recipient.user.id === socket.user.id) return;
    if (type === "invite") {
      const recent = (this.invites.get(socket.user.id) || []).filter(t => this.now() - t < 60000);
      if (recent.length >= 6) return socket.emit("webrtc-error", { error: "Trop d’appels. Patientez une minute." });
      recent.push(this.now()); this.invites.set(socket.user.id, recent);
    }
    if (socket.room !== recipient.room || !await this.permitted(socket, recipient)) {
      if (call && this.bySocket.get(socket.id) === callId) this.end(socket.id, "forbidden");
      return socket.emit("webrtc-error", { error: "Appel indisponible pour ce membre." });
    }
    // Recheck after asynchronous authorization (disconnect/room change/concurrent invite).
    if (!this.sockets.has(socket.id) || !this.sockets.has(recipient.id) || socket.room !== recipient.room) return;
    call = this.calls.get(callId);
    if (type === "invite") {
      if (call || this.bySocket.has(socket.id) || this.bySocket.has(recipient.id))
        return socket.emit("webrtc-error", { error: "Un des participants est déjà en appel." });
      call = { caller: socket.id, callee: recipient.id, room: socket.room, accepted: false, expires: this.now() + 30000 };
      call.timer = setTimeout(() => this.end(socket.id, "timeout"), 30000);
      call.timer.unref?.();
      this.calls.set(callId, call);
      this.bySocket.set(socket.id, callId); this.bySocket.set(recipient.id, callId);
    } else {
      if (!call || this.bySocket.get(socket.id) !== callId || this.bySocket.get(recipient.id) !== callId
        || call.room !== socket.room) return;
      if (!call.accepted && this.now() >= call.expires) return this.end(socket.id, "timeout");
      if (type === "join") {
        if (call.accepted || call.callee !== socket.id || call.caller !== recipient.id) return;
        call.accepted = true; clearTimeout(call.timer);
      } else if (type === "decline") {
        if (call.accepted || call.callee !== socket.id) return;
        return this.end(socket.id, "declined");
      } else if (!call.accepted) return;
    }
    const safeData = { type, callId };
    if (type === "offer" || type === "answer") {
      if (data.sdp?.type !== type || typeof data.sdp.sdp !== "string" || data.sdp.sdp.length > 60000) return;
      safeData.sdp = { type, sdp: data.sdp.sdp };
    }
    if (type === "ice") {
      if (!data.candidate || typeof data.candidate.candidate !== "string" || data.candidate.candidate.length > 4096) return;
      safeData.candidate = { candidate: data.candidate.candidate, sdpMid: data.candidate.sdpMid,
        sdpMLineIndex: data.candidate.sdpMLineIndex, usernameFragment: data.candidate.usernameFragment };
    }
    recipient.emit("webrtc", { from: socket.id, user: callUser(socket.user), data: safeData });
  }
  prune() {
    for (const [id, times] of this.invites) if (!times.some(t => this.now() - t < 60000)) this.invites.delete(id);
  }
}
