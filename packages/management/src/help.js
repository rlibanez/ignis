import {nativeTooltip} from "../../shim/src/native-tooltip.js";
// Descriptions remain inert markup; the host owns the tooltip/top layer.
export function refreshHelp(root) {
  for(const button of root.querySelectorAll('.help-toggle,.setup-help-toggle')) {
    const tip=root.querySelector(`#${CSS.escape(button.getAttribute("aria-controls"))}`);
    if(!tip)continue;
    tip.hidden=true;
    button.classList.add("ignis-password-help");
    nativeTooltip(root.ownerDocument.defaultView,button,tip.textContent,{help:true});
  }
}
