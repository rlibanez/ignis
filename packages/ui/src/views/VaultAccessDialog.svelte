<script>
  import Field from "../components/input/Field.svelte";
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { Users, Trash2 } from "lucide-svelte";
  import Modal from "../components/management/NativeModal.svelte";
  import Button from "../components/management/NativeButton.svelte";
  export let vault;
  export let vaultService;
  const dispatch = createEventDispatcher();
  let data = null, busy = false, error = "", login = "", role = "reader", removal = null;
  let transferOpen = false, transferTarget = "", transferConfirmed = false;
  $: candidates = data?.members.filter(member => member.role !== "owner" && member.status === "active") || [];
  $: recipient = candidates.find(member => member.id === transferTarget);
  let alive = true;
  onDestroy(() => { alive = false; });
  const close = () => dispatch("close");
  function apply(result) { data = { ...result, members: result.members.map(member => ({...member, selected: member.role})) }; }
  async function reload() {
    if (busy) return;
    busy = true; error = "";
    try { const result = await vaultService.vaultMembers(vault.uuid); if (alive) apply(result); }
    catch (failure) { if (alive) { data = null; error = translateIgnis(failure.message); } }
    finally { if (alive) busy = false; }
  }
  async function save(username, permission, previous) {
    if (busy || !data) return;
    busy = true; error = "";
    try {
      const result = await vaultService.updateVaultMember(vault.uuid, username, permission, previous, data.revision);
      if (alive) { apply(result); login = ""; removal = null; }
    } catch (failure) { if (alive) { error = translateIgnis(failure.message); removal = null; } }
    finally { if (alive) busy = false; }
  }
  async function transfer() {
    if (busy || !recipient || !transferConfirmed || !data) return;
    busy = true; error = "";
    try {
      await vaultService.transferVaultOwnership(vault.uuid,recipient.id,recipient.role,data.revision);
      // The former owner no longer has permission to load the members endpoint.
      dispatch("transferred");
      if (alive) dispatch("close");
    } catch (failure) { if (alive) { error = translateIgnis(failure.message); transferOpen = false; transferConfirmed = false; } }
    finally { if (alive) busy = false; }
  }
  onMount(reload);
</script>

<Modal title={translateIgnis("Manage access · ") + vault.name} width="620px" closeOnOverlayClick={false} on:escape={close} on:close={close}>
  <svelte:fragment slot="icon"><Users size="1.25rem" /></svelte:fragment>
  <div class="access-body" aria-busy={busy}>
    {#if error}<p class="access-error" role="alert">{error}</p>{/if}
    {#if data}
      <div class="table-scroll">
        <table>
          <thead><tr><th>{translateIgnis("User")}</th><th>{translateIgnis("Permission")}</th><th><span class="sr-only">{translateIgnis("Actions")}</span></th></tr></thead>
          <tbody>
            {#each data.members as member (member.id)}
              <tr>
                <td><strong>{member.login}</strong>{#if member.status !== "active"}<small>{translateIgnis("Disabled")}</small>{/if}</td>
                <td>
                  {#if member.role === "owner"}<span class="owner">{translateIgnis("Owner")}</span>
                  {:else}<Field type="select" aria-label={translateIgnis("Permission for ") + member.login} bind:value={member.selected} disabled={busy || member.status !== "active"} options={[{value:'reader',label:translateIgnis('Read')},{value:'editor',label:translateIgnis('Read / Write')}]} />{/if}
                </td>
                <td><div class="row-actions">
                  {#if member.role !== "owner"}
                    <Button variant="secondary" disabled={busy || member.selected === member.role || member.status !== "active"} on:click={() => save(member.login,member.selected,member.role)}>{translateIgnis("Save")}</Button>
                    <Button variant="secondary" class="remove" title={translateIgnis("Remove access for ") + member.login} aria-label={translateIgnis("Remove access for ") + member.login} disabled={busy} on:click={() => {removal = member;}}><Trash2 size="1rem" /></Button>
                  {/if}
                </div></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <form on:submit|preventDefault={() => save(login.trim(),role,null)}>
        <h3>{translateIgnis("Add member")}</h3>
        <div class="add-fields">
          <label for="vault-access-login">{translateIgnis("Username")}<Field id="vault-access-login" bind:value={login} required minlength="3" maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" autocomplete="off" disabled={busy} placeholder="{translateIgnis("Exact username")}" /></label>
          <label for="vault-access-role">{translateIgnis("Permission")}<Field id="vault-access-role" type="select" bind:value={role} disabled={busy} options={[{value:'reader',label:translateIgnis('Read')},{value:'editor',label:translateIgnis('Read / Write')}]} /></label>
          <Button type="submit" disabled={busy || !login.trim()}>{translateIgnis("Add")}</Button>
        </div>
        <p class="hint">{translateIgnis("Write access includes shared plugins and their settings. Only add people you trust.")}</p>
      </form>
    {:else if busy}<p>{translateIgnis("Loading members…")}</p>{/if}
  </div>
  <svelte:fragment slot="footer"><div class="footer">
    <Button variant="secondary" disabled={busy} on:click={reload}>{translateIgnis("Reload members")}</Button>
    <Button variant="secondary" disabled={busy || !data || !candidates.length} title="{translateIgnis("Transfer ownership to an active member")}" on:click={() => {transferOpen=true; transferTarget=""; transferConfirmed=false;}}>{translateIgnis("Transfer ownership")}</Button>
    <Button variant="primary" disabled={busy} on:click={close}>{translateIgnis("Done")}</Button>
  </div></svelte:fragment>
</Modal>
{#if removal}
  <Modal title="{translateIgnis("Remove access")}" width="500px" closeOnOverlayClick={false} on:escape={() => {removal=null;}} on:close={() => {removal=null;}}>
    <div class="access-body"><p>{translateIgnis("Remove ")}<strong>{removal.login}</strong> from <strong>{vault.name}</strong>?</p><p class="hint">{translateIgnis("Their access will be revoked. Their existing notes will remain in the vault.")}</p></div>
    <svelte:fragment slot="footer"><div class="footer">
      <Button variant="secondary" disabled={busy} on:click={() => {removal=null;}}>{translateIgnis("Cancel")}</Button>
      <Button variant="danger" disabled={busy} on:click={() => save(removal.login,null,removal.role)}>{translateIgnis("Remove access")}</Button>
    </div></svelte:fragment>
  </Modal>
{/if}
{#if transferOpen}
  <Modal title={translateIgnis("Transfer ownership · ") + vault.name} width="500px" closeOnOverlayClick={false} on:escape={() => {transferOpen=false;}} on:close={() => {transferOpen=false;}}>
    <div class="access-body">
      <label for="vault-transfer-owner">{translateIgnis("New owner")}<Field id="vault-transfer-owner" type="select" bind:value={transferTarget} disabled={busy} on:change={() => {transferConfirmed=false;}}
        options={[{value:'',label:translateIgnis('Select a member'),disabled:true},...candidates.map(member=>({value:member.id,label:member.login}))]} /></label>
      <p class="hint">{translateIgnis("The new owner will control access to this vault. You will keep Read / Write access and will no longer manage its members. Community plugins will be disabled for the new owner.")}</p>
      <label class="confirmation" for="vault-transfer-confirm"><Field id="vault-transfer-confirm" type="checkbox" bind:checked={transferConfirmed} disabled={busy || !recipient} />
        <span>{translateIgnis("I confirm the transfer")}{recipient ? " to " + recipient.login : ""}. Only the new owner can transfer it back.</span>
      </label>
    </div>
    <svelte:fragment slot="footer"><div class="footer">
      <Button variant="secondary" disabled={busy} on:click={() => {transferOpen=false;}}>{translateIgnis("Cancel")}</Button>
      <Button variant="primary" disabled={busy || !recipient || !transferConfirmed} on:click={transfer}>{translateIgnis("Transfer ownership")}</Button>
    </div></svelte:fragment>
  </Modal>
{/if}

<style>
  .confirmation { flex-direction:row; align-items:flex-start; margin-top:1rem; }
  .access-body { padding: 0; }
  .table-scroll { overflow-x: auto; max-height: 300px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--text-muted); font-size: .8rem; font-weight: 600; }
  th,td { padding: .6rem .4rem; border-bottom: 1px solid var(--background-modifier-border); }
  strong { overflow-wrap: anywhere; }
  small { display:block; color:var(--text-muted); }
  .owner { color: var(--interactive-accent); font-weight:600; }
  .row-actions,.footer { display:flex; gap:.5rem; justify-content:flex-end; align-items:center; }
  h3 { margin:1.25rem 0 .75rem; font-size:1rem; }
  .add-fields { display:flex; gap:.75rem; align-items:flex-end; }
  label { display:flex; flex-direction:column; gap:.4rem; font-size:var(--font-ui-medium); min-width:0; flex:1; }
  .hint { color:var(--text-muted); font-size:var(--font-ui-small); margin:.75rem 0 0; }
  .access-error { border:1px solid var(--text-error); color:var(--text-error); border-radius:.375rem; padding:.75rem; margin:0 0 1rem; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  @media(max-width:520px) { .add-fields {flex-wrap:wrap;} .add-fields label {flex-basis:40%;} }
</style>
