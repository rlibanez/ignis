import { it, expect } from "vitest";
import { createRequire } from "node:module";
const { applyAttachmentPolicy } = createRequire(import.meta.url)("./attachment-policy");

it("downloads active and unknown formats with a sandbox and no shared cache", () => {
  for (const name of ["note.html", "script.js", "style.css", "image.svg", "document.pdf", "unknown", "image.png.html"]) {
    const headers = {};
    applyAttachmentPolicy({ setHeader: (key, value) => { headers[key] = value; } }, name);
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Disposition"]).toBe("attachment");
    expect(headers["Content-Security-Policy"]).toBe("sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  }
});

it("keeps passive media inline with a fixed content type, including uppercase extensions", () => {
  for (const [name, type] of [["photo.PNG", "image/png"], ["song.mp3", "audio/mpeg"], ["movie.webm", "video/webm"]]) {
    const headers = {};
    applyAttachmentPolicy({ setHeader: (key, value) => { headers[key] = value; } }, name);
    expect(headers["Content-Type"]).toBe(type);
    expect(headers["Content-Disposition"]).toBe("inline");
  }
});
