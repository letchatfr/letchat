let token = localStorage.getItem("letchat_token");
let me = null;
let socket = null;
let mode = "login";
let typingTimer = null;
let privateUser = null;

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function setMode(newMode) {
  mode = newMode;

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle(
      "active",
      tab.dataset.mode === newMode
    );
  });

  $("authSubmit").textContent =
    newMode === "login"
      ? "Se connecter"
      : "Créer mon compte";

  $("authError").textContent = "";
}

function updateProfileUI() {
  if (!me) return;

  $("myName").textContent =
    me.username || "";

  $("myAvatar").textContent =
    me.avatar || "🙂";

  $("myStatusLabel").textContent =
    me.status || "En ligne";

  $("profileAvatar").textContent =
    me.avatar || "🙂";

  $("profileTitle").textContent =
    "Profil de " + (me.username || "");
}


/* =========================
   CONNEXION / INSCRIPTION
   ========================= */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    setMode(tab.dataset.mode);
  };
});

$("authForm").onsubmit = async (event) => {
  event.preventDefault();

  $("authError").textContent = "";

  const username =
    $("username").value.trim();

  const password =
    $("password").value;

  try {
    const response = await fetch(
      mode === "login"
        ? "/api/login"
        : "/api/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username,
          password
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      $("authError").textContent =
        data.error || "Erreur de connexion.";
      return;
    }

    token = data.token;

    localStorage.setItem(
      "letchat_token",
      token
    );

    me = data.user;

    updateProfileUI();

    await showChat();

  } catch (error) {
    console.error(error);

    $("authError").textContent =
      "Impossible de contacter le serveur.";
  }
};


/* =========================
   AFFICHAGE DU CHAT
   ========================= */

async function showChat() {
  if (!token) {
    return;
  }

  try {
    const response = await fetch(
      "/api/me",
      {
        headers: {
          Authorization: "Bearer " + token
        }
      }
    );

    if (!response.ok) {
      localStorage.removeItem(
        "letchat_token"
      );

      token = null;
      me = null;

      $("auth").classList.remove(
        "hidden"
      );

      $("chat").classList.add(
        "hidden"
      );

      return;
    }

    const data =
      await response.json();

    me = data.user;

    updateProfileUI();

    $("auth").classList.add(
      "hidden"
    );

    $("chat").classList.remove(
      "hidden"
    );

    connect();

    await loadMessages();

    await loadUsers();

  } catch (error) {
    console.error(error);
  }
}


/* =========================
   SOCKET.IO
   ========================= */

function connect() {
  if (socket) {
    socket.disconnect();
  }

  socket = io({
    auth: {
      token
    }
  });

  socket.on(
    "connect",
    () => {
      console.log(
        "Letchat connecté"
      );
    }
  );

  socket.on(
    "connect_error",
    (error) => {
      console.error(
        "Erreur Socket.IO :",
        error.message
      );
    }
  );

  socket.on(
    "message:new",
    (message) => {
      if (!privateUser) {
        addMessage(message);
      }
    }
  );

  socket.on(
    "private:new",
    (message) => {
      if (!privateUser) {
        return;
      }

      const fromCurrentUser =
        String(message.senderId) ===
        String(me.id);

      const fromPrivateUser =
        String(message.senderId) ===
        String(privateUser.id);

      const toPrivateUser =
        String(message.toUserId) ===
        String(privateUser.id);

      if (
        fromCurrentUser &&
        toPrivateUser
      ) {
        addPrivateMessage(message);
        return;
      }

      if (fromPrivateUser) {
        addPrivateMessage(message);
      }
    }
  );

  socket.on(
    "presence",
    () => {
      loadUsers();
    }
  );

  socket.on(
    "typing",
    (data) => {
      if (privateUser) {
        return;
      }

      $("typing").textContent =
        (data.username || "Quelqu'un") +
        " écrit…";
    }
  );

  socket.on(
    "stop-typing",
    () => {
      $("typing").textContent = "";
    }
  );
}


/* =========================
   TCHAT GÉNÉRAL
   ========================= */

async function loadMessages() {
  privateUser = null;

  $("roomTitle").textContent =
    "Tchat général";

  $("messageInput").placeholder =
    "Écrire un message...";

  $("typing").textContent = "";

  const response = await fetch(
    "/api/messages",
    {
      headers: {
        Authorization:
          "Bearer " + token
      }
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    return;
  }

  $("messages").innerHTML = "";

  data.forEach((message) => {
    addMessage(message);
  });

  scrollMessages();
}

function addMessage(message) {
  if (
    document.querySelector(
      '[data-message-id="' +
      message.id +
      '"]'
    )
  ) {
    return;
  }

  const element =
    document.createElement("div");

  element.className =
    "message" +
    (
      String(message.userId) ===
      String(me.id)
        ? " mine"
        : ""
    );

  element.dataset.messageId =
    message.id;

  const time =
    new Date(
      message.createdAt
    ).toLocaleTimeString(
      "fr-FR",
      {
        hour: "2-digit",
        minute: "2-digit"
      }
    );

  element.innerHTML =
    '<div class="meta">' +
      esc(message.username) +
      " · " +
      time +
    "</div>" +
    '<div class="text">' +
      esc(message.text) +
    "</div>";

  $("messages").appendChild(
    element
  );

  scrollMessages();
}


/* =========================
   UTILISATEURS
   ========================= */

async function loadUsers() {
  try {
    const response = await fetch(
      "/api/users",
      {
        headers: {
          Authorization:
            "Bearer " + token
        }
      }
    );

    const users =
      await response.json();

    if (!response.ok) {
      return;
    }

    const onlineUsers =
      users.filter(
        (user) => user.online
      );

    $("onlineCount").textContent =
      onlineUsers.length;

    $("users").innerHTML = "";

    users.forEach((user) => {
      const element =
        document.createElement("div");

      element.className = "user";

      element.dataset.id =
        user.id;

      const avatar =
        user.avatar ||
        (
          user.username || "?"
        )
          .slice(0, 1)
          .toUpperCase();

      element.innerHTML =
        '<div class="avatar">' +
          esc(avatar) +
        "</div>" +
        "<span>" +
          esc(user.username) +
        "</span>" +
        (
          user.online
            ? "<small>●</small>"
            : ""
        );

      element.onclick = () => {
        openPrivate(user.id);
      };

      $("users").appendChild(
        element
      );
    });

  } catch (error) {
    console.error(
      "Erreur utilisateurs :",
      error
    );
  }
}


/* =========================
   MESSAGE PRIVÉ
   ========================= */

async function openPrivate(userId) {
  if (
    String(userId) ===
    String(me.id)
  ) {
    return;
  }

  try {
    const response = await fetch(
      "/api/users",
      {
        headers: {
          Authorization:
            "Bearer " + token
        }
      }
    );

    const users =
      await response.json();

    if (!response.ok) {
      return;
    }

    privateUser =
      users.find(
        (user) =>
          String(user.id) ===
          String(userId)
      );

    if (!privateUser) {
      return;
    }

    $("roomTitle").textContent =
      "Message avec " +
      privateUser.username;

    $("messageInput").placeholder =
      "Message privé…";

    $("typing").textContent = "";

    $("messages").innerHTML = "";

    const messagesResponse =
      await fetch(
        "/api/private/" +
        encodeURIComponent(
          privateUser.id
        ),
        {
          headers: {
            Authorization:
              "Bearer " + token
          }
        }
      );

    const messages =
      await messagesResponse.json();

    if (
      messagesResponse.ok &&
      Array.isArray(messages)
    ) {
      messages.forEach(
        (message) => {
          addPrivateMessage(
            message
          );
        }
      );
    }

    scrollMessages();

  } catch (error) {
    console.error(
      "Erreur message privé :",
      error
    );
  }
}

function addPrivateMessage(message) {
  const element =
    document.createElement("div");

  element.className =
    "message" +
    (
      String(message.senderId) ===
      String(me.id)
        ? " mine"
        : ""
    );

  const time =
    new Date(
      message.createdAt
    ).toLocaleTimeString(
      "fr-FR",
      {
        hour: "2-digit",
        minute: "2-digit"
      }
    );

  element.innerHTML =
    '<div class="meta">' +
      esc(message.username) +
      " · " +
      time +
    "</div>" +
    '<div class="text">' +
      esc(message.text) +
    "</div>";

  $("messages").appendChild(
    element
  );

  scrollMessages();
}


/* =========================
   RETOUR AU TCHAT GÉNÉRAL
   ========================= */

$("generalRoom").onclick = () => {
  loadMessages();
};


/* =========================
   PROFIL
   ========================= */

$("profileBtn").onclick =
  async () => {

    try {
      const response =
        await fetch(
          "/api/me",
          {
            headers: {
              Authorization:
                "Bearer " + token
            }
          }
        );

      if (!response.ok) {
        return;
      }

      const data =
        await response.json();

      me = data.user;

      updateProfileUI();

      $("profileAvatarInput").value =
        me.avatar || "🙂";

      $("profileStatus").value =
        me.status || "";

      $("profileBio").value =
        me.bio || "";

      $("profileTitle").textContent =
        "Profil de " +
        me.username;

      if (me.createdAt) {
        $("profileMeta").textContent =
          "Membre depuis " +
          new Date(
            me.createdAt
          ).toLocaleDateString(
            "fr-FR"
          );
      } else {
        $("profileMeta").textContent =
          "";
      }

      $("profileError").textContent =
        "";

      $("profileModal").classList.remove(
        "hidden"
      );

    } catch (error) {
      console.error(error);
    }
  };


$("closeProfile").onclick = () => {
  $("profileModal").classList.add(
    "hidden"
  );
};


$("profileModal").addEventListener(
  "click",
  (event) => {

    if (
      event.target.id ===
      "profileModal"
    ) {
      $("profileModal").classList.add(
        "hidden"
      );
    }

  }
);


$("saveProfile").onclick =
  async () => {

    const body = {
      avatar:
        $("profileAvatarInput")
          .value
          .trim(),

      status:
        $("profileStatus")
          .value
          .trim(),

      bio:
        $("profileBio")
          .value
          .trim()
    };

    try {
      const response =
        await fetch(
          "/api/me",
          {
            method: "PATCH",

            headers: {
              Authorization:
                "Bearer " + token,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(body)
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        $("profileError").textContent =
          data.error ||
          "Impossible de modifier le profil.";

        return;
      }

      me = data.user;

      updateProfileUI();

      $("profileModal").classList.add(
        "hidden"
      );

      await loadUsers();

    } catch (error) {
      console.error(error);

      $("profileError").textContent =
        "Erreur réseau.";
    }
  };


/* =========================
   ENVOI DES MESSAGES
   ========================= */

$("messageForm").onsubmit =
  (event) => {

    event.preventDefault();

    const text =
      $("messageInput")
        .value
        .trim();

    if (!text || !socket) {
      return;
    }

    if (privateUser) {

      socket.emit(
        "private:send",
        {
          toUserId:
            privateUser.id,

          text
        },
        (result) => {

          if (result?.ok) {
            $("messageInput")
              .value = "";
          } else if (result?.error) {
            console.error(
              result.error
            );
          }

        }
      );

    } else {

      socket.emit(
        "message:send",
        {
          text
        },
        (result) => {

          if (result?.ok) {
            $("messageInput")
              .value = "";
          } else if (result?.error) {
            console.error(
              result.error
            );
          }

        }
      );

    }
  };


/* =========================
   INDICATEUR "ÉCRIT..."
   ========================= */

$("messageInput").addEventListener(
  "input",
  () => {

    if (!socket) {
      return;
    }

    socket.emit("typing");

    clearTimeout(
      typingTimer
    );

    typingTimer =
      setTimeout(
        () => {
          socket.emit(
            "stop-typing"
          );
        },
        800
      );
  }
);


/* =========================
   DÉCONNEXION
   ========================= */

$("logout").onclick = () => {

  localStorage.removeItem(
    "letchat_token"
  );

  if (socket) {
    socket.disconnect();
  }

  location.reload();
};


/* =========================
   SCROLL
   ========================= */

function scrollMessages() {
  const messages =
    $("messages");

  messages.scrollTop =
    messages.scrollHeight;
}


/* =========================
   DÉMARRAGE
   ========================= */

showChat();
