// Ignis renders Svelte only in the browser; SSR needs a separate security review.
module.exports = Object.freeze({ generate: "dom", css: "injected" });
