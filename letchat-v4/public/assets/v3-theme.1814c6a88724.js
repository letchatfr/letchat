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
    const dark = theme === "dark";
    const label = dark ? "Activer le mode clair" : "Activer le mode sombre";
    const desktopButton = document.getElementById("themeBtn");
    const mobileButton = document.getElementById("mobileThemeBtn");
    if (desktopButton) {
      desktopButton.textContent = dark ? "☀" : "☾";
      desktopButton.setAttribute("aria-pressed", String(dark));
      desktopButton.setAttribute("aria-label", label);
      desktopButton.title = dark ? "Mode clair" : "Mode sombre";
    }
    if (mobileButton) {
      mobileButton.textContent = dark ? "☀ Mode clair" : "☾ Mode sombre";
      mobileButton.setAttribute("aria-pressed", String(dark));
      mobileButton.setAttribute("aria-label", label);
    }
  }

  function toggleTheme() {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, next);
    applyTheme(next);
  }

  applyTheme(preferredTheme());

  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(preferredTheme());
    document.getElementById("themeBtn")?.addEventListener("click", toggleTheme);
    document.getElementById("mobileThemeBtn")?.addEventListener("click", toggleTheme);
  });
})();
