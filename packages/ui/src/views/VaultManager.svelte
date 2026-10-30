<script>
  import { onMount, tick } from "svelte";
  import {
    Vault,
    Folder,
    Plus,
    SquarePlus,
    PenLine,
    Trash2,
    Check,
  } from "lucide-svelte";
  import VaultAccessDialog from "./VaultAccessDialog.svelte";
  import Modal from "../components/layout/Modal.svelte";
  import PromptDialog from "../components/layout/PromptDialog.svelte";
  import ConfirmDialog from "../components/layout/ConfirmDialog.svelte";
  import MessageDialog from "../components/layout/MessageDialog.svelte";
  import SearchInput from "../components/input/SearchInput.svelte";
  import Button from "../components/input/Button.svelte";
  import ListItem from "../components/display/ListItem.svelte";
  import PopoverMenu from "../components/menu/PopoverMenu.svelte";

  export let vaultService;

  const administrator = window.__ignisAuth?.role === "admin";
  let vaults = [];
  let searchQuery = "";
  let openMenuId = null;
  let modalRef;

  let activeDialog = null;
  let targetVault = null;
  let dialogValue = "";
  let errorMessage = "";
  let pendingReload = false;
  let deletedCurrentVault = false;
  let createOwners = [];
  let createOwner = "";
  let createError = "";
  let createBusy = false;
  let createRequest = 0;
  let createForm;
  let createNameInput;
  let registrationOwners = [];
  let registrationOwner = "";
  let registrationSnapshot = null;
  let registrationError = "";
  let registrationBusy = false;
  let version = "";

  const menuItems = [
    { id: "access", label: "Manage access" },
    { id: "rename", label: "Rename" },
    { id: "delete", label: "Delete", danger: true },
  ];

  let currentVaultId = vaultService.getCurrentVaultId();

  $: deleteMessage = targetVault
    ? 'Are you sure you want to delete "' + targetVault.name + '"?'
    : "";
  $: filteredVaults = searchQuery
    ? vaults.filter((v) =>
        v.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : vaults;

  async function fetchVersion() {
    try {
      const res = await fetch("/api/version");
      const data = await res.json();
      version = data.version;
    } catch (e) {
      console.warn("[VaultManager] Failed to fetch version:", e);
    }
  }

  async function refreshVaults() {
    try {
      vaults = await vaultService.listVaults();
    } catch {
      vaults = [];
    }
  }

  function openVault(vault) {
    if (vault.id === currentVaultId) {
      modalRef.dismiss();
      return;
    }
    vaultService.openVault(vault.id);
  }

  function toggleMenu(vaultId) {
    if (openMenuId === vaultId) {
      openMenuId = null;
    } else {
      openMenuId = vaultId;
    }
  }

  function onMenuSelect(vault, item) {
    openMenuId = null;
    if (item.id === "access") {
      targetVault = vault; activeDialog = "access";
    } else if (item.id === "register") {
      showRegistrationDialog(vault);
    } else if (item.id === "rename") {
      showRenameDialog(vault);
    } else if (item.id === "delete") {
      showDeleteDialog(vault);
    }
  }

  async function showRegistrationDialog(vault) {
    targetVault = vault;
    activeDialog = "register";
    registrationOwner = "";
    registrationOwners = [];
    registrationSnapshot = null;
    registrationError = "";
    registrationBusy = true;
    try {
      const options = await vaultService.registrationOptions();
      if (activeDialog !== "register" || targetVault !== vault) return;
      registrationOwners = options.owners;
      const candidate = options.vaults.find(entry => entry.directory === vault.id);
      if (!candidate?.eligible) {
        registrationError = candidate?.reason || "This vault is no longer available for registration. Refresh the vault list.";
      } else {
        registrationSnapshot = candidate.identity;
        if (!registrationOwners.length) registrationError = "An active user is required to own this vault.";
      }
    } catch (error) {
      if (activeDialog === "register" && targetVault === vault) registrationError = error.message;
    } finally {
      if (activeDialog === "register" && targetVault === vault) registrationBusy = false;
    }
  }

  async function onRegisterConfirm() {
    if (registrationBusy || !registrationOwner || !registrationSnapshot) return;
    const selected = targetVault;
    registrationBusy = true;
    registrationError = "";
    try {
      await vaultService.registerVault(selected.id, registrationOwner, registrationSnapshot);
      if (activeDialog === "register" && targetVault === selected) closeDialog();
      await refreshVaults();
    } catch (error) {
      if (activeDialog === "register" && targetVault === selected) registrationError = error.message;
    } finally {
      if (activeDialog === "register" && targetVault === selected) registrationBusy = false;
    }
  }

  async function showCreateDialog() {
    const request = ++createRequest;
    dialogValue = "";
    createOwner = "";
    createOwners = [];
    createError = "";
    createBusy = true;
    activeDialog = "create";
    try {
      const result = await vaultService.vaultOwners();
      if (activeDialog !== "create" || createRequest !== request) return;
      createOwners = result.owners;
      if (!createOwners.length) createError = "An active user is required to own this vault.";
    } catch (error) {
      if (activeDialog === "create" && createRequest === request) createError = error.message;
    } finally {
      if (activeDialog === "create" && createRequest === request) {
        createBusy = false;
        await tick();
        if (activeDialog === "create" && createRequest === request) createNameInput?.focus();
      }
    }
  }

  function showRenameDialog(vault) {
    targetVault = vault;
    dialogValue = vault.name;
    activeDialog = "rename";
  }

  function showDeleteDialog(vault) {
    targetVault = vault;
    activeDialog = "delete";
  }

  function closeDialog() {
    activeDialog = null;
    targetVault = null;
    dialogValue = "";
  }

  async function onCreateConfirm() {
    if (createBusy || !createForm?.reportValidity()) return;
    const name = dialogValue.trim();
    if (!name || !createOwner) return;
    const request = createRequest;
    createBusy = true;
    createError = "";
    try {
      vaults = await vaultService.createVault(name, createOwner);
      if (activeDialog === "create" && createRequest === request) closeDialog();
    } catch (error) {
      if (activeDialog === "create" && createRequest === request) createError = error.message;
    } finally {
      if (activeDialog === "create" && createRequest === request) createBusy = false;
    }
  }

  async function onRenameConfirm(e) {
    const trimmed = e.detail.trim();

    if (!trimmed || trimmed === targetVault.name) {
      closeDialog();
      return;
    }

    const wasCurrentVault = targetVault.id === currentVaultId;

    try {
      vaults = await vaultService.renameVault(targetVault.id, trimmed);
      closeDialog();

      if (wasCurrentVault) {
        currentVaultId = vaultService.getCurrentVaultId();
        pendingReload = true;
      }
    } catch (err) {
      errorMessage = "Failed to rename vault: " + err.message;
      activeDialog = "error";
    }
  }

  async function onDeleteConfirm() {
    try {
      const { wasCurrentVault, cleanupPending } = await vaultService.deleteVault(
        targetVault.id,
        targetVault.uuid,
      );

      closeDialog();

      vaults = await vaultService.listVaults();

      if (cleanupPending) {
        deletedCurrentVault = wasCurrentVault;
        activeDialog = "cleanup";
      } else if (wasCurrentVault) {
        vaultService.openVault("");
      }
    } catch (err) {
      errorMessage = "Failed to delete vault: " + err.message;
      activeDialog = "error";
    }
  }

  function onModalClose() {
    if (pendingReload) {
      window.location.reload();
    }
  }

  function onEscape() {
    if (openMenuId) {
      openMenuId = null;
    } else {
      modalRef.dismiss();
    }
  }

  onMount(() => {
    refreshVaults();
    fetchVersion();
  });
</script>

<Modal
  title="Vault Manager"
  overlayClass="vault-manager-overlay"
  width="600px"
  bind:this={modalRef}
  on:escape={onEscape}
  on:close={onModalClose}
  closeOnOverlayClick={false}
>
  <svelte:fragment slot="icon">
    <Vault size="1.25rem" />
  </svelte:fragment>

  <div class="section-header">
    <h3>Vaults</h3>
    <div class="search-wrapper">
      <SearchInput
        value={searchQuery}
        on:input={(e) => {
          searchQuery = e.detail;
        }}
      />
    </div>
  </div>

  <div class="section-body">
    <div class="vault-list">
      {#if vaults.length === 0}
        <div class="empty">{administrator ? "No vaults yet. Create one below." : "No vaults assigned. Ask an administrator to create a vault for you."}</div>
      {:else if filteredVaults.length === 0}
        <div class="empty">No vaults match your search.</div>
      {:else}
        {#each filteredVaults as vault (vault.id)}
          <ListItem
            primary={vault.name}
            secondary={vault.path || ""}
            active={vault.id === currentVaultId}
            on:click={() => openVault(vault)}
          >
            <svelte:fragment slot="icon">
              <Folder size="1.5rem" />
            </svelte:fragment>
            <svelte:fragment slot="default">
              <span class="vault-name">
                {vault.name}
                {#if !vault.uuid && window.__ignisAuth}
                  <span class="active-label">(not registered)</span>
                {/if}
                {#if vault.id === currentVaultId}
                  <span class="active-label">(active)</span>
                  <span class="active-check">&#10003;</span>
                {/if}
              </span>
              {#if vault.path}<span class="vault-path">{vault.path}</span>{/if}
            </svelte:fragment>
            <svelte:fragment slot="action">
              {#if vault.membership === "owner"}<PopoverMenu
                open={openMenuId === vault.id}
                items={!vault.uuid && window.__ignisAuth ? [{ id: "register", label: "Register vault" }] : (administrator ? menuItems : menuItems.filter(item => item.id === "access"))}
                on:toggle={() => toggleMenu(vault.id)}
                on:select={(e) => onMenuSelect(vault, e.detail)}
              />{/if}
            </svelte:fragment>
          </ListItem>
        {/each}
      {/if}
    </div>
  </div>

  <svelte:fragment slot="footer">
    <div class="footer-left">
      {#if version}
        <span class="version-info">Ignis v{version}</span>
      {/if}
    </div>
    <div class="footer-right">
      {#if window.__ignisAuth}
        <Button variant="ghost" on:click={() => window.location.assign("/account")}>Account</Button>
        <Button variant="ghost" on:click={() => window.__ignisAuth.logout()}>Sign out</Button>
      {/if}
      {#if administrator}<Button variant="ghost" on:click={showCreateDialog}>
        <svelte:fragment slot="icon">
          <Plus size="1rem" />
        </svelte:fragment>
        Create New Vault
      </Button>{/if}
    </div>
  </svelte:fragment>
</Modal>

{#if activeDialog === "access" && targetVault}
  <VaultAccessDialog vault={targetVault} {vaultService} on:close={closeDialog} on:transferred={async () => { closeDialog(); await refreshVaults(); }} />
{/if}

{#if activeDialog === "create"}
  <Modal title="Create Vault" width="500px" closeOnOverlayClick={false} on:escape={closeDialog} on:close={closeDialog}>
    <svelte:fragment slot="icon"><SquarePlus size="1.25rem" /></svelte:fragment>
    <form class="registration-body" bind:this={createForm} on:submit|preventDefault={onCreateConfirm}>
      <label for="new-vault-name">Vault name</label>
      <input id="new-vault-name" type="text" bind:this={createNameInput} bind:value={dialogValue} required maxlength="255" disabled={createBusy} />
      <label class="owner-label" for="new-vault-owner">Initial owner</label>
      <select id="new-vault-owner" bind:value={createOwner} required disabled={createBusy}>
        <option value="" disabled>Select a user</option>
        {#each createOwners as owner (owner.id)}
          <option value={owner.id}>{owner.login}</option>
        {/each}
      </select>
      {#if createError}<p class="registration-error" role="alert">{createError}</p>{/if}
    </form>
    <svelte:fragment slot="footer">
      <div class="registration-actions">
        <Button variant="secondary" on:click={closeDialog}>Cancel</Button>
        <Button variant="primary" disabled={createBusy || !dialogValue.trim() || !createOwner} on:click={onCreateConfirm}>
          <svelte:fragment slot="icon"><Plus size="0.875rem" /></svelte:fragment>
          {createBusy ? "Please wait…" : "Create Vault"}
        </Button>
      </div>
    </svelte:fragment>
  </Modal>
{/if}

{#if activeDialog === "rename"}
  <PromptDialog
    title="Rename Item"
    label="New Name:"
    confirmText="Save"
    bind:value={dialogValue}
    on:confirm={onRenameConfirm}
    on:cancel={closeDialog}
  >
    <svelte:fragment slot="icon">
      <PenLine size="1.25rem" />
    </svelte:fragment>
    <svelte:fragment slot="confirmIcon">
      <Check size="0.875rem" />
    </svelte:fragment>
  </PromptDialog>
{/if}

{#if activeDialog === "delete" && targetVault}
  <ConfirmDialog
    title="Delete Confirmation"
    message={deleteMessage}
    description={targetVault.uuid ? "This removes the vault and its access permissions. Its files will be permanently deleted. Interrupted file cleanup is retried on restart." : "This action cannot be undone. All notes and linked files within this vault will be permanently removed from your system."}
    confirmText="Confirm Delete"
    confirmVariant="danger"
    on:confirm={onDeleteConfirm}
    on:cancel={closeDialog}
  >
    <svelte:fragment slot="icon">
      <Trash2 size="1.25rem" />
    </svelte:fragment>
    <svelte:fragment slot="confirmIcon">
      <Check size="0.875rem" />
    </svelte:fragment>
  </ConfirmDialog>
{/if}

{#if activeDialog === "register" && targetVault}
  <Modal
    title={"Register vault " + targetVault.name}
    width="500px"
    closeOnOverlayClick={false}
    on:escape={closeDialog}
    on:close={closeDialog}
  >
    <div class="registration-body">
      <p>Register this existing folder without moving or changing its files.</p>
      <label for="vault-owner">Initial owner</label>
      <select id="vault-owner" bind:value={registrationOwner} disabled={registrationBusy || !registrationSnapshot}>
        <option value="" disabled>Select a user</option>
        {#each registrationOwners as owner (owner.id)}
          <option value={owner.id}>{owner.login}</option>
        {/each}
      </select>
      {#if registrationError}<p class="registration-error" role="alert">{registrationError}</p>{/if}
    </div>
    <svelte:fragment slot="footer">
      <div class="registration-actions">
        <Button variant="secondary" on:click={closeDialog}>Cancel</Button>
        <Button variant="primary" disabled={registrationBusy || !registrationOwner || !registrationSnapshot} on:click={onRegisterConfirm}>
          {registrationBusy ? "Please wait…" : "Register vault"}
        </Button>
      </div>
    </svelte:fragment>
  </Modal>
{/if}

{#if activeDialog === "cleanup"}
  <MessageDialog
    title="Vault removed"
    message="The vault has been removed from Ignis. File cleanup is pending and will be retried on restart."
    on:confirm={() => {
      closeDialog();
      if (deletedCurrentVault) vaultService.openVault("");
      deletedCurrentVault = false;
    }}
  />
{/if}

{#if activeDialog === "error"}
  <MessageDialog
    title="Error"
    message={errorMessage}
    on:confirm={() => {
      activeDialog = null;
      errorMessage = "";
    }}
  />
{/if}

<style>
  .registration-body { padding: 1.25rem 1.5rem; }
  .registration-body p { margin: 0 0 1rem; color: var(--text-muted); }
  .registration-body label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
  .registration-body .owner-label { margin-top: 1rem; }
  .registration-body input, .registration-body select {
    box-sizing: border-box;
    width: 100%;
    height: var(--input-height, 2.25rem);
    padding: 0 0.75rem;
    border: 1px solid var(--background-modifier-border);
    border-radius: 0.375rem;
    color: var(--text-normal);
    background: var(--background-primary);
    font: inherit;
    line-height: normal;
  }
  .registration-body select { appearance: auto; }
  .registration-body .registration-error { margin: 1rem 0 0; padding: 0.75rem; border: 1px solid var(--text-error, #e36d79); border-radius: 0.375rem; color: var(--text-error, #e36d79); }
  .registration-actions { display: flex; justify-content: flex-end; gap: 0.625rem; padding: 1rem 1.5rem; }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 2rem 0rem 1.5rem;
    flex-shrink: 0;
  }

  .section-header h3 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text-normal);
  }

  .search-wrapper {
    width: 11rem;
  }

  .section-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 1rem 1.1rem 0rem 1rem;
  }

  .vault-list {
    flex: 1;
    overflow-y: auto;
    scrollbar-gutter: stable;
    min-height: 300px;
    max-height: 300px;
    padding: 0rem 0 1rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .empty {
    color: var(--text-muted);
    padding: 2rem 1rem;
    text-align: center;
    font-size: 0.875rem;
  }

  .vault-name {
    font-weight: 600;
    font-size: 1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .active-label {
    color: var(--interactive-accent);
    font-weight: 400;
    font-size: 0.875rem;
    margin-left: 0.375rem;
  }

  .active-check {
    color: var(--interactive-accent);
    font-size: 0.875rem;
    margin-left: 0.125rem;
  }

  .vault-path {
    font-size: 0.8125rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .footer-left {
    display: flex;
    align-items: center;
  }

  .footer-right {
    display: flex;
    justify-content: flex-end;
  }

  .version-info {
    font-size: 0.75rem;
    color: var(--text-muted);
    user-select: none;
  }
</style>
