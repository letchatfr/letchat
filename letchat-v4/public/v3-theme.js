(function () {
  const storageKey = "letchat-theme";
  const root = document.documentElement;

  function preferredTheme() {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    const button = document.getElementById("themeBtn");
    if (!button) return;
    const dark = theme === "dark";
    button.textContent = dark ? "☀" : "☾";
    button.setAttribute("aria-pressed", String(dark));
    button.setAttribute("aria-label", dark ? "Activer le mode clair" : "Activer le mode sombre");
    button.title = dark ? "Mode clair" : "Mode sombre";
  }

  applyTheme(preferredTheme());

  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(preferredTheme());
    document.getElementById("themeBtn")?.addEventListener("click", function () {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem(storageKey, next);
      applyTheme(next);
    });
  });
})();
