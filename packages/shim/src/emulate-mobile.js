// Activates Obsidian's mobile UI on small viewports via the EmulateMobile flag.

export function installEmulateMobile() {
  const environment = globalThis.IgnisUiEnvironment;
  const webDevice = environment?.hasWebDeviceSettings(window);
  const selected = webDevice ? environment.mode(window, {inherit:false}) : null;
  if (selected === "phone" || selected === "tablet") {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const media = matchMedia(query);
      if (query.replace(/\s+/g, "").toLowerCase() !== "(min-width:600px)and(min-height:600px)") return media;
      return new Proxy(media, {get(target, key) {
        if (key === "matches") return selected === "tablet";
        if (key === "addListener" || key === "removeListener") return () => {};
        if (key === "addEventListener" || key === "removeEventListener") {
          return (type, ...args) => { if (type !== "change") target[key](type, ...args); };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }});
    };
  }
  if (selected ? selected !== "desktop" : window.innerWidth < 600) {
    localStorage.setItem("EmulateMobile", "true");
    stripEmulateMobileClass();
  } else {
    localStorage.removeItem("EmulateMobile");
  }
}

// The emulate-mobile class only gates plugin requires.
// strip to allow desktop plugins to load on mobile UI.
function stripEmulateMobileClass() {
  const strip = () => {
    // only remove if present, otherwise observer loops forever
    if (document.body.classList.contains("emulate-mobile")) {
      document.body.classList.remove("emulate-mobile");
    }
  };

  const observer = new MutationObserver(strip);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
