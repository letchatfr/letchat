// Fonctions de présentation sans données persistantes ni appel réseau.
export function messageDayInfo(value, now = new Date()) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const key = dayKey(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const label = key === dayKey(now) ? "Aujourd’hui"
    : key === dayKey(yesterday) ? "Hier"
    : new Intl.DateTimeFormat("fr-FR", {
      day: "numeric", month: "long", year: "numeric",
    }).format(date);
  return { key, label, iso: date.toISOString(), full: date.toLocaleString("fr-FR") };
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function shouldSendOnEnter(event, touchMobile) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
  return !touchMobile || Boolean(event.ctrlKey || event.metaKey);
}
