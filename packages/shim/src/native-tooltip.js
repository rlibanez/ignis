// Use Obsidian's delegated aria-label tooltip renderer for all Ignis help.
// Delegated events bridge keyboard/touch activation; no tooltip DOM or CSS is owned here.
const bound = new WeakSet();
export function nativeTooltip(host, element, text, { help = false } = {}) {
  element.removeAttribute?.('title');
  element.setAttribute('aria-label', text);
  if (!element.addEventListener || bound.has(element)) return;
  bound.add(element);
  const pointer = type => {
    const view = element.ownerDocument?.defaultView || host;
    // A plain event is deliberate: Obsidian filters physical PointerEvents
    // until a mouse has moved, which would suppress keyboard and touch help.
    element.dispatchEvent(new view.Event(type, { bubbles: true }));
  };
  const show = () => {
    // The native renderer defaults to a one-second hover delay. Explicit help
    // activation should be immediate (a positive value is required by its API).
    element.setAttribute('data-tooltip-delay', '1');
    pointer('pointerover');
  };
  const hide = () => pointer('pointerout');
  element.addEventListener('focus', show);
  element.addEventListener('blur', hide);
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') { hide(); event.preventDefault(); event.stopPropagation(); }
    else if (help && element.tagName !== 'BUTTON' && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); show();
    }
  });
  if (help) {
    element.tabIndex = 0;
    if (element.tagName !== 'BUTTON') element.setAttribute('role', 'button');
    // click follows pointerup, which dismisses the native tooltip on touch.
    element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); show(); });
  }
}
