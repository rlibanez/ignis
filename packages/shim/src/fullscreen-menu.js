// Request fullscreen only from a deliberate menu click (browser user activation).
export function addFullscreenMenuItem(menu, obsidian, spanish, doc = document) {
  if (!doc.fullscreenEnabled || !doc.documentElement.requestFullscreen || !doc.exitFullscreen) return;
  const active = !!doc.fullscreenElement;
  menu.addItem(item => item
    .setTitle(spanish
      ? (active ? "Salir de pantalla completa" : "Pantalla completa")
      : (active ? "Exit fullscreen" : "Enter fullscreen"))
    .setIcon(active ? "minimize" : "maximize")
    .onClick(async () => {
      try {
        if (doc.fullscreenElement) await doc.exitFullscreen();
        else await doc.documentElement.requestFullscreen();
      } catch {
        new obsidian.Notice(spanish
          ? "El navegador no ha permitido cambiar el modo de pantalla completa."
          : "The browser could not change fullscreen mode.");
      }
    }));
}
