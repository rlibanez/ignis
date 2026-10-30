<script>
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { Users, Trash2 } from "lucide-svelte";
  import Modal from "../components/layout/Modal.svelte";
  import Button from "../components/input/Button.svelte";
  export let vault;
  export let vaultService;
  const dispatch = createEventDispatcher();
  let data = null, busy = false, error = "", login = "", role = "reader", removal = null;
  let alive = true;
  onDestroy(() => { alive = false; });
  const close = () => dispatch("close");
  function apply(result) { data = { ...result, members: result.members.map(member => ({...member, selected: member.role})) }; }
  async function reload() {
    if (busy) return;
    busy = true; error = "";
    try { const result = await vaultService.vaultMembers(vault.uuid); if (alive) apply(result); }
    catch (failure) { if (alive) { data = null; error = failure.message; } }
    finally { if (alive) busy = false; }
  }
  async function save(username, permission, previous) {
    if (busy || !data) return;
    busy = true; error = "";
    try {
      const result = await vaultService.updateVaultMember(vault.uuid, username, permission, previous, data.revision);
      if (alive) { apply(result); login = ""; removal = null; }
    } catch (failure) { if (alive) { error = failure.message; removal = null; } }
    finally { if (alive) busy = false; }
  }
  onMount(reload);
</script>

<Modal title={"Manage access · " + vault.name} width="620px" closeOnOverlayClick={false} on:escape={close} on:close={close}>
  <svelte:fragment slot="icon"><Users size="1.25rem" /></svelte:fragment>
  <div class="access-body" aria-busy={busy}>
    {#if error}<p class="access-error" role="alert">{error}</p>{/if}
    {#if data}
      <div class="table-scroll">
        <table>
          <thead><tr><th>User</th><th>Permission</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {#each data.members as member (member.id)}
              <tr>
                <td><strong>{member.login}</strong>{#if member.status !== "active"}<small>Disabled</small>{/if}</td>
                <td>
                  {#if member.role === "owner"}<span class="owner">Owner</span>
                  {:else}<select aria-label={"Permission for " + member.login} bind:value={member.selected} disabled={busy || member.status !== "active"}>
                    <option value="reader">Read</option><option value="editor">Read / Write</option>
                  </select>{/if}
                </td>
                <td><div class="row-actions">
                  {#if member.role !== "owner"}
                    <Button variant="secondary" disabled={busy || member.selected === member.role || member.status !== "active"} on:click={() => save(member.login,member.selected,member.role)}>Save</Button>
                    <button class="remove" title={"Remove access for " + member.login} aria-label={"Remove access for " + member.login} disabled={busy} on:click={() => {removal = member;}}><Trash2 size="1rem" /></button>
                  {/if}
                </div></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <form on:submit|preventDefault={() => save(login.trim(),role,null)}>
        <h3>Add member</h3>
        <div class="add-fields">
          <label>Username<input bind:value={login} required minlength="3" maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" autocomplete="off" disabled={busy} placeholder="Exact username" /></label>
          <label>Permission<select bind:value={role} disabled={busy}><option value="reader">Read</option><option value="editor">Read / Write</option></select></label>
          <Button type="submit" disabled={busy || !login.trim()}>Add</Button>
        </div>
        <p class="hint">Write access includes shared plugins and their settings. Only add people you trust.</p>
      </form>
    {:else if busy}<p>Loading members…</p>{/if}
  </div>
  <svelte:fragment slot="footer"><div class="footer">
    <Button variant="secondary" disabled={busy} on:click={reload}>Reload members</Button>
    <Button variant="primary" disabled={busy} on:click={close}>Done</Button>
  </div></svelte:fragment>
</Modal>
{#if removal}
  <Modal title="Remove access" width="500px" closeOnOverlayClick={false} on:escape={() => {removal=null;}} on:close={() => {removal=null;}}>
    <div class="access-body"><p>Remove <strong>{removal.login}</strong> from <strong>{vault.name}</strong>?</p><p class="hint">Their access will be revoked. Their existing notes will remain in the vault.</p></div>
    <svelte:fragment slot="footer"><div class="footer">
      <Button variant="secondary" disabled={busy} on:click={() => {removal=null;}}>Cancel</Button>
      <Button variant="danger" disabled={busy} on:click={() => save(removal.login,null,removal.role)}>Remove access</Button>
    </div></svelte:fragment>
  </Modal>
{/if}
<style>
  .access-body { padding: 1.25rem 1.5rem; }
  .table-scroll { overflow-x: auto; max-height: 300px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--text-muted); font-size: .8rem; font-weight: 600; }
  th,td { padding: .6rem .4rem; border-bottom: 1px solid var(--background-modifier-border); }
  strong { overflow-wrap: anywhere; }
  small { display:block; color:var(--text-muted); }
  .owner { color: var(--interactive-accent); font-weight:600; }
  .row-actions,.footer { display:flex; gap:.5rem; justify-content:flex-end; align-items:center; }
  .remove { display:flex; align-items:center; padding:.4rem; color:var(--text-error); background:transparent; border:1px solid var(--background-modifier-border); border-radius:.375rem; }
  .footer { padding:1rem 1.5rem; }
  h3 { margin:1.25rem 0 .75rem; font-size:1rem; }
  .add-fields { display:flex; gap:.75rem; align-items:flex-end; }
  label { display:flex; flex-direction:column; gap:.4rem; font-size:.875rem; min-width:0; flex:1; }
  input,select { box-sizing:border-box; width:100%; height:var(--input-height,2.25rem); padding:0 .65rem; font:inherit; line-height:normal; color:var(--text-normal); background:var(--background-primary); border:1px solid var(--background-modifier-border); border-radius:.375rem; }
  select { appearance:auto; }
  .hint { color:var(--text-muted); font-size:.8rem; margin:.75rem 0 0; }
  .access-error { border:1px solid var(--text-error); color:var(--text-error); border-radius:.375rem; padding:.75rem; margin:0 0 1rem; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  @media(max-width:520px) { .access-body {padding:1rem;} .add-fields {flex-wrap:wrap;} .add-fields label {flex-basis:40%;} }
</style>
