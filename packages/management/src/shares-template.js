// Bundled internal form template. No standalone page or network fetch.
export default String.raw`<main><p id="status" role="alert"></p>
  <section id="workspace" hidden>
    <div class="toolbar page-actions"><button id="new-share" class="account-button" data-i18n="Share a resource">Share a resource</button></div>
    <section class="share-panel" aria-labelledby="received-heading"><header><div><h2 id="received-heading" data-i18n="Shared with me">Shared with me</h2></div></header><div id="received"></div></section>
    <section class="share-panel" aria-labelledby="owned-heading"><header><div><h2 id="owned-heading" data-i18n="Shared by me">Shared by me</h2></div></header><div id="owned"></div></section>
  </section>
  <section data-ui-dialog id="create-dialog" aria-labelledby="create-heading">
    <h2 id="create-heading" data-i18n="Share a resource">Share a resource</h2>
    <form id="create-form">
      <label for="vault" data-i18n="Vault">Vault</label><select id="vault" required></select>
      <input id="share-search" type="search" aria-label="Search files and folders..." data-i18n-aria-label="Search files and folders..." placeholder="Search files and folders..." data-i18n-placeholder="Search files and folders...">
      <div id="picker" aria-label="Vault files and folders" data-i18n-aria-label="Vault files and folders"></div>
      <p id="selection" class="resource-tree-destination" role="status" data-i18n="Select a file or folder.">Select a file or folder.</p>
      <p class="help" data-i18n="Folders include current and future content.">Folders include current and future content.</p>
      <label for="recipient" data-i18n="Username">Username</label><input id="recipient" required maxlength="64" autocomplete="off">
      <label for="permission" data-i18n="Permission">Permission</label><select id="permission"><option value="reader" data-i18n="Read">Read</option><option value="editor" data-i18n="Read / Write">Read / Write</option></select>
      <p class="error" role="alert"></p>
      <div class="dialog-actions"><button type="button" data-close="create-dialog" class="account-button secondary" data-i18n="Cancel">Cancel</button><button id="create-submit" type="submit" class="account-button" disabled data-i18n="Share">Share</button></div>
    </form>
  </section>
  <section data-ui-dialog id="location-dialog" aria-labelledby="location-heading">
    <h2 id="location-heading">Resource location</h2>
    <form id="location-form">
      <label for="destination-vault" data-i18n="Vault">Vault</label><select id="destination-vault"></select>
      <div id="location-folders">
        <label for="location-search" data-i18n="Folder">Folder</label>
        <input id="location-search" type="search" placeholder="Search folders..." data-i18n-placeholder="Search folders...">
        <div id="location-tree" class="resource-tree"></div>
        <p id="location-selection" class="resource-tree-destination"></p>
      </div>
      <label for="destination-path" data-i18n="Local name">Local name</label>
      <input id="destination-path" maxlength="255" required>
      <p class="error" role="alert"></p>
      <div class="dialog-actions"><button type="button" data-close="location-dialog" class="account-button secondary" data-i18n="Cancel">Cancel</button><button type="submit" class="account-button" data-i18n="Save location">Save location</button></div>
    </form>
  </section>
  <section data-ui-dialog id="manage-dialog" aria-labelledby="manage-heading">
    <h2 id="manage-heading">Manage resource</h2>
    <section class="share-panel access-section" aria-labelledby="access-heading">
      <header><h3 id="access-heading" data-i18n="People with access">People with access</h3><button id="add-access" type="button" class="account-button" data-i18n="Add access">Add access</button></header>
      <div id="grants"></div>
    </section>
    <p class="error" role="alert"></p>
    <div class="dialog-actions"><button type="button" data-close="manage-dialog" class="account-button secondary" data-i18n="Cancel">Cancel</button><button id="save-resource" type="button" class="account-button" data-i18n="Save">Save</button></div>
  </section>
  <section data-ui-dialog id="grant-dialog" aria-labelledby="grant-heading">
    <h2 id="grant-heading" data-i18n="Add access">Add access</h2>
    <form id="grant-form">
      <label for="grant-login" data-i18n="Username">Username</label><input id="grant-login" required maxlength="64" autocomplete="off">
      <label for="grant-role" data-i18n="Permission">Permission</label><select id="grant-role"><option value="reader" data-i18n="Read">Read</option><option value="editor" data-i18n="Read / Write">Read / Write</option></select>
      <p class="error" role="alert"></p>
      <div class="dialog-actions"><button type="button" data-close="grant-dialog" class="account-button secondary" data-i18n="Cancel">Cancel</button><button type="submit" class="account-button" data-i18n="Add access">Add access</button></div>
    </form>
  </section>
</main>`;
