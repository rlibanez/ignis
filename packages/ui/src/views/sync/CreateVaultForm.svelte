<script>
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  import { createEventDispatcher } from "svelte";
  import Button from "../../components/input/Button.svelte";

  const dispatch = createEventDispatcher();

  let name = "";
  let region = "";
  let encryption = "e2ee";
  let password = "";
  let creating = false;
  let error = "";

  async function onSubmit() {
    error = "";

    if (!name.trim()) {
      error = translateIgnis("Vault name is required");
      return;
    }

    if (encryption === "e2ee" && !password) {
      error = translateIgnis("Encryption password is required for end-to-end encryption");
      return;
    }

    creating = true;

    try {
      const res = await fetch("/api/ext/headless-sync/create-remote-vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          encryption,
          password: password || undefined,
          region: region || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || translateIgnis("Request failed: {p0}", {p0: (res.status)}));
      }

      dispatch("created");
    } catch (e) {
      error = e.message;
      creating = false;
    }
  }

  function onBack() {
    dispatch("back");
  }
</script>

<div class="create-form">
  <div class="form-row">
    <div class="form-label">
      <div class="form-name">{translateIgnis("Vault name")}</div>
      <div class="form-desc">{translateIgnis("Helps you remember what this vault is for")}</div>
    </div>
    <input type="text" placeholder="{translateIgnis("My awesome vault")}" bind:value={name} />
  </div>

  <div class="form-row">
    <div class="form-label">
      <div class="form-name">{translateIgnis("Region")}</div>
      <div class="form-desc">{translateIgnis("Select the server region closest to you")}</div>
    </div>
    <select bind:value={region}>
      <option value="">{translateIgnis("Automatic")}</option>
      <option value="europe">{translateIgnis("Europe")}</option>
      <option value="north-america">{translateIgnis("North America")}</option>
      <option value="asia">{translateIgnis("Asia")}</option>
      <option value="oceania">{translateIgnis("Oceania")}</option>
    </select>
  </div>

  <div class="form-row">
    <div class="form-label">
      <div class="form-name">{translateIgnis("Encryption")}</div>
      <div class="form-desc">{translateIgnis("\n        End-to-end encryption requires a password you must remember.\n        ")}<span class="form-warning">{translateIgnis("This cannot be changed later.")}</span>
      </div>
    </div>
    <select bind:value={encryption}>
      <option value="e2ee">{translateIgnis("End-to-end encryption")}</option>
      <option value="standard">{translateIgnis("Standard encryption")}</option>
    </select>
  </div>

  {#if encryption === "e2ee"}
    <div class="form-row">
      <div class="form-label">
        <div class="form-name">{translateIgnis("Encryption password")}</div>
        <div class="form-desc">
          <span class="form-warning">{translateIgnis("If you forget this password, any remote data will remain unusable forever.")}</span>{translateIgnis("\n          This does not affect your local data.\n        ")}</div>
      </div>
      <input type="password" placeholder="{translateIgnis("Your password")}" bind:value={password} />
    </div>
  {/if}

  {#if error}
    <div class="form-error">{error}</div>
  {/if}

  <div class="form-footer">
    <Button variant="secondary" on:click={onBack}>{translateIgnis("Back")}</Button>
    <Button variant="primary" disabled={creating} on:click={onSubmit}>
      {creating ? translateIgnis("Creating...") : translateIgnis("Create")}
    </Button>
  </div>
</div>

<style>
  .form-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0.75rem 0;
  }

  .form-row + .form-row {
    border-top: 1px solid var(--background-modifier-border);
  }

  .form-label {
    flex: 1;
    min-width: 0;
    margin-right: 1rem;
  }

  .form-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-normal);
  }

  .form-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
    line-height: 1.4;
  }

  .form-warning {
    color: var(--text-error);
  }

  input, select {
    font-family: var(--font-interface);
    font-size: 0.875rem;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--background-modifier-border);
    border-radius: 0.375rem;
    background: var(--background-primary);
    color: var(--text-normal);
    min-width: 200px;
    margin-top: 0.125rem;
  }

  input:focus, select:focus {
    outline: none;
    border-color: var(--interactive-accent);
  }

  .form-error {
    color: var(--text-error);
    font-size: 0.8125rem;
    padding: 0.5rem 0;
  }

  .form-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--background-modifier-border);
  }
</style>
