import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";


const firebaseConfig = {
  apiKey: "AIzaSyCfOel5JKgjxmVslddn_Xdar1XR_vb2Cgs",
  authDomain: "letchat-ynyp.onrender.com",
  projectId: "letchat-1d79d",
  storageBucket: "letchat-1d79d.firebasestorage.app",
  messagingSenderId: "289359647477",
  appId: "1:289359647477:web:893d579c6bf94b98226bbc",
  measurementId: "G-L3Z35BP6FG"
};


const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();

const $ = selector => document.querySelector(selector);

let user = null;
let token = null;
let socket = null;
let stream = null;
let typingTimer = null;

const peers = new Map();
const pendingCandidates = new Map();


$("#googleLogin").onclick = async () => {
  try {
    await signInWithRedirect(auth, googleProvider);
  } catch (error) {
    alert(`Connexion Google impossible : ${error.message}`);
  }
};


$("#logout").onclick = async () => {
  hang();

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  await signOut(auth);
};


getRedirectResult(auth).catch(error => {
  alert(`Connexion Google impossible : ${error.message}`);
});


onAuthStateChanged(auth, async currentUser => {
  if (!currentUser) {
    user = null;
    token = null;

    $("#login").classList.remove("hidden");
    $("#app").classList.add("hidden");

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    return;
  }

  user = currentUser;
  token = await currentUser.getIdToken();

  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");

  $("#meName").textContent =
    currentUser.displayName ||
    currentUser.email ||
    "Utilisateur";

  $("#mePhoto").src = currentUser.photoURL || "";

  connect();
  loadMessages();
});


async function api(path, options = {}) {
  token = await user.getIdToken();

  options.headers = {
    ...options.headers,
    Authorization: `Bearer ${token}`
  };

  const response = await fetch(path, options);

  if (!response.ok) {
    let message = "Erreur du serveur";

    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      message = `Erreur HTTP ${response.status}`;
    }

    throw new Error(message);
  }

  return response;
}


async function loadMessages() {
  try {
    const response = await api("/api/messages");
    const messages = await response.json();
    renderMessages(messages);
  } catch (error) {
    showError(error.message);
  }
}


function renderMessages(messages) {
  const box = $("#messages");

  box.innerHTML = messages.length
    ? ""
    : `
      <div class="empty">
        <b>☀</b>
        <h2>Bienvenue au Café</h2>
        <p>Envoyez le premier message.</p>
      </div>
    `;

  messages.forEach(addMessage);
  box.scrollTop = box.scrollHeight;
}


function safe(value) {
  const element = document.createElement("div");
  element.textContent = String(value || "");
  return element.innerHTML;
}


function initials(name) {
  return String(name || "Utilisateur")
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();
}


function addMessage(message) {
  if (document.querySelector(`[data-id="${message.id}"]`)) {
    return;
  }

  const article = document.createElement("article");

  article.className =
    "message " +
    (message.user_id === user.uid ? "mine" : "");

  article.dataset.id = message.id;

  let media = "";

  if (message.has_media) {
    const mediaUrl =
      `/api/media/${message.id}?t=${encodeURIComponent(token)}`;

    if (message.media_type?.startsWith("image/")) {
      media = `
        <img
          class="media"
          src="${mediaUrl}"
          alt="Image envoyée"
        >
      `;
    } else {
      media = `
        <video
          class="media"
          src="${mediaUrl}"
          controls
        ></video>
      `;
    }
  }

  const author =
    message.user_id === user.uid
      ? "Vous"
      : safe(message.author);

  const avatar = message.photo
    ? `<img src="${safe(message.photo)}" class="avatar" alt="">`
    : initials(message.author);

  const time = new Date(message.created_at).toLocaleTimeString(
    "fr-FR",
    {
      hour: "2-digit",
      minute: "2-digit"
    }
  );

  article.innerHTML = `
    <div class="avatar">${avatar}</div>

    <div>
      <p class="meta">
        <strong>${author}</strong>
        <time>${time}</time>
      </p>

      ${
        message.body
          ? `<p class="bubble">${safe(message.body)}</p>`
          : ""
      }

      ${media}
    </div>
  `;

  $("#messages").append(article);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}


async function sendMessage(media = null) {
  const body = $("#input").value.trim();

  if (!body && !media) {
    return;
  }

  try {
    const response = await api("/api/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        body,
        ...(media || {})
      })
    });

    const message = await response.json();

    addMessage(message);
    $("#input").value = "";
  } catch (error) {
    showError(error.message);
  }
}


$("#send").onclick = () => {
  sendMessage();
};


$("#input").onkeydown = event => {
  if (socket) {
    socket.emit("typing", true);

    clearTimeout(typingTimer);

    typingTimer = setTimeout(() => {
      socket?.emit("typing", false);
    }, 800);
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
};


$("#emoji").onclick = () => {
  $("#input").value += " 😊";
  $("#input").focus();
};


$("#attach").onclick = () => {
  $("#file").click();
};


$("#cameraBtn").onclick = () => {
  $("#camera").click();
};


async function selectMedia(event) {
  const file = event.target.files[0];

  if (!file) {
    return;
  }

  if (file.size > 8e6) {
    showError("Le fichier ne doit pas dépasser 8 Mo");
    event.target.value = "";
    return;
  }

  if (
    !file.type.startsWith("image/") &&
    !file.type.startsWith("video/")
  ) {
    showError("Choisissez une image ou une vidéo");
    event.target.value = "";
    return;
  }

  try {
    const mediaBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        resolve(reader.result.split(",")[1]);
      };

      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    await sendMessage({
      mediaBase64,
      mediaType: file.type
    });
  } catch {
    showError("Impossible de lire ce fichier");
  }

  event.target.value = "";
}


$("#file").onchange = selectMedia;
$("#camera").onchange = selectMedia;


function showError(message) {
  $("#error").textContent = message;
  $("#error").classList.remove("hidden");

  setTimeout(() => {
    $("#error").classList.add("hidden");
  }, 5000);
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

  socket.on("connect_error", error => {
    console.error("Socket :", error);
    showError("Connexion au tchat impossible");
  });

  socket.on("message", addMessage);

  socket.on("presence", people => {
    $("#onlineCount").textContent = people.length;

    $("#people").innerHTML = people
      .map(person => {
        const photo = person.photo
          ? `<img src="${safe(person.photo)}" alt="">`
          : `<div class="avatar">${initials(person.name)}</div>`;

        return `
          <div class="person">
            ${photo}

            <div>
              <strong>${safe(person.name)}</strong>
              <small>En ligne</small>
            </div>
          </div>
        `;
      })
      .join("");
  });

  socket.on("typing", data => {
    $("#typing").textContent = data.active
      ? `${data.name} écrit…`
      : "";
  });

  socket.on("webrtc", data => {
    handleSignal(data).catch(error => {
      console.error("WebRTC :", error);
      showError("Erreur pendant l’appel");
    });
  });
}


async function startMedia() {
  const active =
    stream &&
    stream
      .getTracks()
      .some(track => track.readyState === "live");

  if (active) {
    $("#localVideo").srcObject = stream;
    $("#call").classList.remove("hidden");
    return true;
  }

  stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    $("#localVideo").srcObject = stream;
    $("#call").classList.remove("hidden");

    return true;
  } catch (error) {
    console.error("Caméra ou microphone :", error);

    showError(
      "Impossible d’ouvrir la caméra ou le microphone"
    );

    return false;
  }
}


function createPeer(id) {
  if (peers.has(id)) {
    return peers.get(id);
  }

  const connection = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302"
      },
      {
        urls: "stun:stun1.l.google.com:19302"
      }
    ]
  });

  if (stream) {
    stream.getTracks().forEach(track => {
      connection.addTrack(track, stream);
    });
  }

  connection.onicecandidate = event => {
    if (!event.candidate || !socket) {
      return;
    }

    socket.emit("webrtc", {
      target: id,
      data: {
        type: "ice",
        candidate: event.candidate
      }
    });
  };

  connection.ontrack = event => {
    if (event.streams[0]) {
      addRemoteVideo(id, event.streams[0]);
    }
  };

  connection.onconnectionstatechange = () => {
    if (
      connection.connectionState === "failed" ||
      connection.connectionState === "closed"
    ) {
      removePeer(id);
    }
  };

  peers.set(id, connection);
  return connection;
}


async function addPendingCandidates(id, connection) {
  const candidates = pendingCandidates.get(id) || [];

  for (const candidate of candidates) {
    try {
      await connection.addIceCandidate(candidate);
    } catch (error) {
      console.error("Candidat ICE :", error);
    }
  }

  pendingCandidates.delete(id);
}


async function handleSignal({ from, data }) {
  if (!from || !data) {
    return;
  }

  if (data.type === "leave") {
    removePeer(from);
    return;
  }

  if (data.type === "join") {
    const accepted = window.confirm(
      "Un utilisateur vous appelle. Accepter l’appel ?"
    );

    if (!accepted) {
      return;
    }

    const ready = await startMedia();

    if (!ready) {
      return;
    }

    const connection = createPeer(from);
    const offer = await connection.createOffer();

    await connection.setLocalDescription(offer);

    socket.emit("webrtc", {
      target: from,
      data: {
        type: "offer",
        sdp: connection.localDescription
      }
    });

    return;
  }

  if (data.type === "offer") {
    const ready = await startMedia();

    if (!ready) {
      return;
    }

    const connection = createPeer(from);

    await connection.setRemoteDescription(data.sdp);
    await addPendingCandidates(from, connection);

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);

    socket.emit("webrtc", {
      target: from,
      data: {
        type: "answer",
        sdp: connection.localDescription
      }
    });

    return;
  }

  if (data.type === "answer") {
    const connection = createPeer(from);

    await connection.setRemoteDescription(data.sdp);
    await addPendingCandidates(from, connection);

    return;
  }

  if (data.type === "ice") {
    const connection = createPeer(from);

    if (connection.remoteDescription) {
      try {
        await connection.addIceCandidate(data.candidate);
      } catch (error) {
        console.error("Candidat ICE :", error);
      }
    } else {
      const candidates = pendingCandidates.get(from) || [];
      candidates.push(data.candidate);
      pendingCandidates.set(from, candidates);
    }
  }
}


function addRemoteVideo(id, remoteStream) {
  let container = document.getElementById(`v-${id}`);

  if (!container) {
    container = document.createElement("div");
    container.id = `v-${id}`;
    container.className = "video";

    container.innerHTML = `
      <video autoplay playsinline></video>
      <span>Participant</span>
    `;

    $("#videoGrid").append(container);
  }

  const video = container.querySelector("video");
  video.srcObject = remoteStream;

  video.play().catch(() => {
    console.log("Lecture automatique en attente");
  });
}


function removePeer(id) {
  const connection = peers.get(id);

  if (connection) {
    connection.close();
    peers.delete(id);
  }

  pendingCandidates.delete(id);
  document.getElementById(`v-${id}`)?.remove();
}


$("#callBtn").onclick = async () => {
  if (!socket || !socket.connected) {
    showError("Le tchat n’est pas encore connecté");
    return;
  }

  const ready = await startMedia();

  if (!ready) {
    return;
  }

  socket.emit("webrtc", {
    target: null,
    data: {
      type: "join"
    }
  });
};


function hang() {
  if (socket?.connected) {
    socket.emit("webrtc", {
      target: null,
      data: {
        type: "leave"
      }
    });
  }

  if (stream) {
    stream.getTracks().forEach(track => {
      track.stop();
    });
  }

  stream = null;
  $("#localVideo").srcObject = null;

  peers.forEach(connection => {
    connection.close();
  });

  peers.clear();
  pendingCandidates.clear();

  document
    .querySelectorAll(
      "#videoGrid .video:not(:first-child)"
    )
    .forEach(element => {
      element.remove();
    });

  $("#call").classList.add("hidden");
}


$("#hangup").onclick = hang;
$("#closeCall").onclick = hang;


$("#mic").onclick = () => {
  if (!stream) {
    return;
  }

  stream.getAudioTracks().forEach(track => {
    track.enabled = !track.enabled;
  });
};


$("#cam").onclick = () => {
  if (!stream) {
    return;
  }

  stream.getVideoTracks().forEach(track => {
    track.enabled = !track.enabled;
  });
};


$("#screen").onclick = async () => {
  try {
    const screenStream =
      await navigator.mediaDevices.getDisplayMedia({
        video: true
      });

    const screenTrack = screenStream.getVideoTracks()[0];

    peers.forEach(connection => {
      const sender = connection
        .getSenders()
        .find(item => item.track?.kind === "video");

      if (sender) {
        sender.replaceTrack(screenTrack);
      }
    });

    screenTrack.onended = () => {
      const cameraTrack = stream?.getVideoTracks()[0];

      if (!cameraTrack) {
        return;
      }

      peers.forEach(connection => {
        const sender = connection
          .getSenders()
          .find(item => item.track?.kind === "video");

        if (sender) {
          sender.replaceTrack(cameraTrack);
        }
      });
    };
  } catch (error) {
    console.error("Partage d’écran :", error);
  }
};
