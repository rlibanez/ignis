import {createManagementView} from "./management-view.js";
import {mountUsers} from "./users-component.js";
import {mountShares} from "./shares-component.js";
import {mountAccountSecurity} from "./account-security-component.js";
import mountPasswordVisibility from "./password-visibility.cjs";
import {createComponentScope} from "./client.js";
const t = text => globalThis.IgnisI18n?.t(text) ?? text;
const titles = {users:"Manage users",shares:"Shared resources",password:"Set local password"};

function sizeManagementList(modal, centeredOnTablet) {
  const {body} = modal.ownerDocument;
  if (body.classList.contains("is-mobile") && !(centeredOnTablet && body.classList.contains("is-tablet"))) {
    // Let Obsidian position phone sheets within its native safe-area inset.
    modal.classList.add("mod-lg");
    return;
  }
  const size = modal.ownerDocument.querySelector(".modal.mod-settings")?.getBoundingClientRect();
  modal.style.width = size?.width ? `${size.width}px` : "var(--modal-width, 90vw)";
  modal.style.height = size?.height ? `${size.height}px` : "var(--modal-height, 85vh)";
  modal.style.maxWidth = size?.width ? "100vw" : "var(--modal-max-width, 1100px)";
  modal.style.maxHeight = size?.height ? "100dvh" : "var(--modal-max-height, 1000px)";
}

export function createManagementModal(Modal, setIcon) {
class DialogModal extends Modal {
  close(){if(this.requestClose)return this.requestClose();super.close();}
  forceClose(){super.close();}
}

return class ManagementModal extends Modal {
  constructor(app, kind, options = {}) { super(app); this.options = options; this.kind = kind; this.abort = new AbortController(); this.channels = []; this.cleanups = []; }
  close(){if(this.requestClose)return this.requestClose();super.close();}
  forceClose(){this.onClose();super.close();}
  async onOpen() {
    const title = titles[this.kind];
    const lost = () => this.forceClose();
    window.addEventListener("ignis:auth-lost", lost);
    this.cleanups.push(() => window.removeEventListener("ignis:auth-lost", lost));
    const resourceOnly = this.kind === "shares" && !!this.options.initialResource;
    this.setTitle(t(resourceOnly ? "Manage resource" : title));
    if (!resourceOnly && ["shares", "users", "password"].includes(this.kind)) {
      sizeManagementList(this.modalEl, this.kind !== "password");
    } else if (resourceOnly && document.body.classList.contains("is-mobile")) {
      this.modalEl.addClass("mod-lg", "mod-form");
    } else if (resourceOnly) {
      this.modalEl.addClass("mod-form");
    } else {
      this.modalEl.style.width = "min(1100px, 95vw)";
      this.modalEl.style.height = "min(850px, 90dvh)";
    }
    this.contentEl.style.overflow = "auto";
    const host = this.contentEl.createDiv();
    host.classList.add("ignis-management-root");
    const frame = document.createElement("div"); host.append(frame);
    frame.textContent = t("Loading…");
    try {
      const dialogs=createManagementView({frame,host,modal:this.modalEl,setIcon,kind:this.kind,resourceOnly,
        onDispose:fn=>this.cleanups.push(fn),owner:this,createModal:section=>{
          const dialog=new DialogModal(this.app);
          if(section.hasAttribute("data-ui-list")) {
            sizeManagementList(dialog.modalEl, true);
            dialog.contentEl.style.overflow = "auto";
          }
          return dialog;
        }});
      const signal = this.abort.signal;
      const scope = createComponentScope(dialogs.root, {...this.options,
        signal, cleanups:this.cleanups, channels:this.channels,
        decorate:dialogs.decorate,
        onResourceActionFinished: resourceOnly ? () => this.close() : undefined,
        onResourceDialogOpened: resourceOnly ? dialog => {
          if(this.options.initialResource?.action!=="revoke")dialog.addEventListener("close",()=>this.close(),{once:true,signal});
        } : undefined,
      });
      ({users:mountUsers,shares:mountShares,password:mountAccountSecurity})[this.kind](scope);
      mountPasswordVisibility(scope);
    } catch { if (!this.abort.signal.aborted) frame.textContent = t("Request failed"); }
  }
  onClose() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    for(const cleanup of this.cleanups) cleanup();
    for(const channel of this.channels)channel.close();
    this.contentEl.querySelectorAll("input").forEach(input=>{input.value="";});
    this.contentEl.empty();
  }
}

}
