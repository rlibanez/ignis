/* Shared fallback policy; the editor itself is not started on entry pages. */
const environment = globalThis.IgnisUiEnvironment;
environment.initialize(window);
if (["/setup", "/login"].includes(location.pathname)) {
  document.addEventListener("DOMContentLoaded", () => {
    const footer = document.querySelector(".ignis-language");
    if (!footer) return;
    const wrapper = document.createElement("span");
    wrapper.className = "ignis-language-dropdown";
    const select = document.createElement("select");
    select.setAttribute("data-ignis-theme", "");
    const t = text => globalThis.IgnisI18n?.t(text) ?? text;
    const options = {dark: "Dark", light: "Light", system: "Automatic"};
    for (const value of Object.keys(options)) {
      const option = document.createElement("option");
      option.value = value;
      select.append(option);
    }
    const render = () => {
      for (const option of select.options) option.textContent = t(options[option.value]);
      select.value = environment.themePreference(window);
      select.setAttribute("aria-label", t("Ignis screen theme"));
    };
    select.addEventListener("change", () => {
      if (environment.setTheme(window, select.value)) environment.applyTheme(window);
      render();
    });
    window.addEventListener("ignis:external-theme",render);
    window.addEventListener("storage",render);
    document.addEventListener("ignis:languagechange",render);
    render();
    wrapper.append(select);
    footer.prepend(wrapper);
  }, {once:true});
}
