let token = localStorage.getItem("letchat_token");
let me = null;
let socket = null;
let mode = "login";
let typingTimer = null;
let privateUser = null;

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

function setMode(m) {
  mode = m;

  document.querySelectorAll(".tab").forEach((x) => {
    x.classList.toggle("active", x.dataset.mode === m);
  });

  $("authSubmit").textContent =
    m === "login" ? "Se connecter" : "Créer mon compte";

  $("authError").textContent = "";
}

function updateProfileUI() {
  if (!me) return;

  $("myName").textContent = me.username || "";
  $("myAvatar").textContent = me.avatar || "🙂";
  $("myStatusLabel").textContent = me.status || "En ligne";

  $("profileAvatar").textContent = me.avatar || "🙂";
  $("profileTitle").textContent = "Profil de " + (me.username || "");
}

document.querySelectorAll(".tab").forEach((x) => {
  x.onclick = () => setMode(x.dataset.mode);
});

$("authForm").onsubmit = async (e) => {
  e.preventDefault();

  $("authError").textContent = "";

  try {
    const r = await fetch(
      "/api/" + (mode === "login" ? "login" : "register"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username: $("username").value.trim(),
          password: $("password").value
        })
      }
    );

    const d = await r.json();

    if (!r.ok) {
      $("authError").textContent = d.error || "Erreur";
      return;
    }

    token = d.token;
    localStorage.setItem("letchat_token", token);

    me = d.user;

    updateProfileUI();

    await showChat();

  } catch (err) {
    console.error(err);
    $("authError").textContent =
      "Impossible de contacter le serveur.";
  }
};

async function showChat() {
  if (!token) return;

  try {
    const r = await fetch("/api/me", {
      headers: {
        Authorization: "Bearer " + token
      }
    });

    if (!r.ok) {
      localStorage.removeItem("letchat_token");
      token = null;
      me = null;

      $("auth").classList.remove("hidden");
      $("chat").classList.add("hidden");

      return;
    }

    me = (await r.json()).user;

    updateProfileUI();

    $("auth").classList.add("hidden");
    $("chat").classList.remove("hidden");

    connect();

    await loadMessages();
    await loadUsers();

  } catch (err) {
    console.error(err);
  }
}

function connect() {
  if (socket) {
    socket.disconnect();
  }

  socket = io({
    auth: {
      token
    }
  });

  socket.on("message:new", (m) => {
    if (!privateUser) {
      addMessage(m);
    }
  });

  socket.on("private:new", (m) => {
    if (
      privateUser &&
      (
        String(m.senderId) === String(privateUser.id) ||
        String(m.toUserId) === String(privateUser.id)
      )
    ) {
      addPrivateMessage(m);
    }
  });

  socket.on("presence", () => {
    loadUsers();
  });

  socket.on("typing", (d) => {
    if (!privateUser) {
      $("typing").textContent = d.username + " écrit…";
    }
  });

  socket.on("stop-typing", () => {
    $("typing").textContent = "";
  });

  socket.on("connect_error", (err) => {
    console.error("Socket error:", err.message);
  });
}

async function loadMessages() {
  privateUser = null;

  $("roomTitle").textContent = "Tchat général";
  $("messageInput").placeholder = "Écrire un message...";

  const r = await fetch("/api/messages", {
    headers: {
      Authorization: "Bearer " + token
    }
  });

  const a = await r.json();

  if (!r.ok) return;

  $("messages").innerHTML = "";

  a.forEach(addMessage);

  scroll();
}

function addMessage(m) {
  if (
    document.querySelector(
      '[data-msg="' + m.id + '"]'
    )
  ) {
    return;
  }

  const e = document.createElement("div");

  e.dataset.msg = m.id;

  e.className =
    "message" +
    (
      String(m.userId) === String(me.id)
        ? " mine"
        : ""
    );

  e.innerHTML =
    `<div class="meta">` +
    `${esc(m.username)} · ` +
    `${new Date(m.createdAt).toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit"
    })}` +
    `</div>` +
    `<div class="text">${esc(m.text)}</div>`;

  $("messages").appendChild(e);

  scroll();
}

async function loadUsers() {
  const r = await fetch("/api/users", {
    headers: {
      Authorization: "Bearer " + token
    }
  });

  const a = await r.json();

  if (!r.ok) return;

  $("onlineCount").textContent =
    a.filter((x) => x.online).length;

  $("users").innerHTML = a.map((u) => `
    <div class="user" data-id="${esc(u.id)}">
      <div class="avatar">
        ${esc((u.username || "?").slice(0, 1).toUpperCase())}
      </div>

      <span>${esc(u.username)}</span>

      ${u.online ? "<small>●</small>" : ""}

      ${
        String(u.id) !== String(me.id)
          ? `<button class="add-friend" data-id="${esc(u.id)}">
               Ajouter
             </button>`
          : ""
      }
    </div>
  `).join("");

  document.querySelectorAll(".user").forEach((x) => {
    x.onclick = () => openPrivate(x.dataset.id);
  });

  document.querySelectorAll(".add-friend").forEach((button) => {
    button.onclick = async (e) => {
      e.stopPropagation();

      const userId = button.dataset.id;

      button.disabled = true;
      button.textContent = "Envoi...";

      try {
        const r = await fetch("/api/friends/" + userId, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token
          }
        });

        const d = await r.json();

        if (!r.ok) {
          alert(d.error || "Impossible d'envoyer la demande.");
          button.disabled = false;
          button.textContent = "Ajouter";
          return;
       

  $("users").innerHTML = a.map((u) => `
    <div class="user" data-id="${esc(u.id)}">
      <div class="avatar">
        ${esc((u.username || "?").slice(0, 1).toUpperCase())}
      </div>
      <span>${esc(u.username)}</span>
      ${u.online ? "<small>●</small>" : ""}
    </div>
  `).join("");

  document.querySelectorAll(".user").forEach((x) => {
    x.onclick = () => openPrivate(x.dataset.id);
  });
}

async function openPrivate(uid) {
  const r = await fetch("/api/users", {
    headers: {
      Authorization: "Bearer " + token
    
  });

  const a = await r.json();

  if (!r.ok) return;

  privateUser = a.find(
    (x) => String(x.id) === String(uid)
  );

  if (
    !privateUser ||
    String(privateUser.id) === String(me.id)
  ) {
    return;
  }

  $("roomTitle").textContent =
    "Message avec " + privateUser.username;

  $("messageInput").placeholder =
    "Message privé…";

  $("messages").innerHTML = "";

  const p = await fetch(
    "/api/private/" +
    encodeURIComponent(privateUser.id),
    {
      headers: {
        Authorization: "Bearer " + token
      }
    }
  );

  const msgs = await p.json();

  if (p.ok && Array.isArray(msgs)) {
    msgs.forEach(addPrivateMessage);
  }

  scroll();
}

function addPrivateMessage(m) {
  const e = document.createElement("div");

  e.className =
    "message" +
    (
      String(m.senderId) === String(me.id)
        ? " mine"
        : ""
    );

  e.innerHTML =
    `<div class="meta">` +
    `${esc(m.username)} · ` +
    `${new Date(m.createdAt).toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit"
    })}` +
    `</div>` +
    `<div class="text">${esc(m.text)}</div>`;

  $("messages").appendChild(e);

  scroll();
}

$("generalRoom").onclick = () => {
  loadMessages();
};

$("profileBtn").onclick = async () => {
  try {
    const r = await fetch("/api/me", {
      headers: {
        Authorization: "Bearer " + token
      }
    });

    if (!r.ok) return;

    me = (await r.json()).user;

    updateProfileUI();

    $("profileAvatarInput").value =
      me.avatar || "🙂";

    $("profileStatus").value =
      me.status || "";

    $("profileBio").value =
      me.bio || "";

    $("profileTitle").textContent =
      "Profil de " + me.username;

    $("profileMeta").textContent =
      "Membre depuis " +
      new Date(me.createdAt).toLocaleDateString("fr-FR");

    $("profileError").textContent = "";

    $("profileModal").classList.remove("hidden");

  } catch (err) {
    console.error(err);
  }
};

$("closeProfile").onclick = () => {
  $("profileModal").classList.add("hidden");
};

$("profileModal").addEventListener("click", (e) => {
  if (e.target.id === "profileModal") {
    $("profileModal").classList.add("hidden");
  }
});

$("saveProfile").onclick = async () => {
  const body = {
    avatar: $("profileAvatarInput").value.trim(),
    status: $("profileStatus").value.trim(),
    bio: $("profileBio").value.trim()
  };

  try {
    const r = await fetch("/api/me", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const d = await r.json();

    if (!r.ok) {
      $("profileError").textContent =
        d.error || "Erreur";
      return;
    }

    me = d.user;

    updateProfileUI();

    $("profileModal").classList.add("hidden");

    await loadUsers();

  } catch (err) {
    console.error(err);

    $("profileError").textContent =
      "Erreur réseau.";
  }
};

$("messageForm").onsubmit = (e) => {
  e.preventDefault();

  const text =
    $("messageInput").value.trim();

  if (!text || !socket) return;

  if (privateUser) {

    socket.emit(
      "private:send",
      {
        toUserId: privateUser.id,
        text
      },
      (r) => {
        if (r?.ok) {
          $("messageInput").value = "";
        }
      }
    );

  } else {

    socket.emit(
      "message:send",
      { text },
      (r) => {
        if (r?.ok) {
          $("messageInput").value = "";
        }
      }
    );

  }
};

$("messageInput").addEventListener(
  "input",
  () => {

    if (!socket) return;

    socket.emit("typing");

    clearTimeout(typingTimer);

    typingTimer = setTimeout(() => {
      socket.emit("stop-typing");
    }, 800);

  }
);

$("logout").onclick = () => {
  localStorage.removeItem("letchat_token");

  if (socket) {
    socket.disconnect();
  }

  location.reload();
};

function scroll() {
  $("messages").scrollTop =
    $("messages").scrollHeight;
}

showChat();
