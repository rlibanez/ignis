function mountPasswordVisibility({root, listen, onDispose}) {
  const document = root.ownerDocument || root;
var translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  const hideAll = [];
  for (const input of root.querySelectorAll('input[type="password"], input[data-masked-text]')) {
    const maskedText = input.hasAttribute("data-masked-text");
    let revealed = false;
    let wrapper = input.parentElement;
    if (!wrapper.classList.contains("password-control")) {
      wrapper = document.createElement("div");
      wrapper.className = "password-control";
      input.before(wrapper);
      wrapper.append(input);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "password-toggle";
    button.setAttribute("aria-controls", input.id);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }))
      svg.setAttribute(name, value);
    for (const d of ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"]) {
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    const slash = document.createElementNS(svg.namespaceURI, "path");
    slash.setAttribute("d", "M3 3l18 18");
    svg.append(slash);
    button.append(svg);
    wrapper.append(button);
    function setVisible(visible) {
      const label = input.labels?.[0]?.textContent.trim() || translateIgnis("Password");
      revealed = visible;
      if (maskedText) input.classList.toggle("masked-text", !visible);
      else input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", `${visible ? translateIgnis("Hide") : translateIgnis("Show")} ${label}`);
      button.title = `${visible ? translateIgnis("Hide") : translateIgnis("Show")} ${label}`;
      slash.style.display = visible ? "" : "none";
    }
    setVisible(false);
    listen(root, "ignis:languagechange", () => setVisible(revealed));
    button.addEventListener("click", () => setVisible(!revealed));
    const hide = () => setVisible(false);
    hideAll.push(hide);
    input.form?.addEventListener("reset", hide);
    input.closest("dialog")?.addEventListener("close", hide);
  }
  onDispose(() => hideAll.forEach(hide => hide()));
}

if (typeof module !== "undefined" && module.exports) module.exports = mountPasswordVisibility;
else mountPasswordVisibility({root:document,listen:(target,...args)=>target.addEventListener(...args),onDispose:fn=>window.addEventListener("pagehide",fn)});
