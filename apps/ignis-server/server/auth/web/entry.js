/* Shared fallback policy; the editor itself is not started on entry pages. */
const environment = globalThis.IgnisUiEnvironment;
environment.initialize(window);
if (["/setup", "/login"].includes(location.pathname)) {
  document.addEventListener("DOMContentLoaded", () => {
    const footer = document.querySelector(".ignis-language");
    if (!footer) return;
    const button = document.createElement("button");
    button.type = "button";
    const t = text => globalThis.IgnisI18n?.t(text) ?? text;
    const render = () => {
      button.textContent = t(environment.theme(window) === "dark" ? "Light mode" : "Dark mode");
      button.setAttribute("aria-label", t("Toggle Ignis screen theme"));
    };
    button.addEventListener("click", () => {
      if (environment.setTheme(window, environment.theme(window) === "dark" ? "light" : "dark")) {
        environment.applyTheme(window);
        render();
      } else button.textContent = t("Request failed");
    });
    window.addEventListener("ignis:external-theme",render);
    window.addEventListener("storage",render);
    document.addEventListener("ignis:languagechange",render);
    render();
    footer.prepend(button);
  }, {once:true});
}
