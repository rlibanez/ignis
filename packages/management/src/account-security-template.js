export default String.raw`<main><p id="status" role="status"></p><section id="account-security" hidden><button id="set-own-password" type="button" class="account-button" data-i18n="Set local password">Set local password</button></section>
      <dialog id="password-dialog" aria-labelledby="password-heading">
        <h2 id="password-heading" data-i18n="Set local password">Set local password</h2>
        <p id="set-password-help" data-i18n="Setting a local password closes all your Ignis sessions. Your linked provider account is kept.">Setting a local password closes all your Ignis sessions. Your linked provider account is kept.</p>
        <form id="password-form">
          <div class="setup-field-heading">
            <label for="new-password" data-i18n="New password">New password</label>
            <span class="setup-field-help">
              <button type="button" class="setup-help-toggle" aria-label="About password requirements" aria-expanded="false" aria-controls="password-policy" data-i18n-aria-label="About password requirements">?</button>
              <span id="password-policy" class="setup-help-tooltip" role="tooltip" hidden></span>
            </span>
          </div>
          <div class="password-field">
            <input id="new-password" aria-describedby="password-policy" name="newPassword" type="password" autocomplete="new-password" required maxlength="1024" />
          </div>
          <label for="confirm-password" data-i18n="Confirm new password">Confirm new password</label>
          <div class="password-field">
            <input id="confirm-password" name="confirmation" type="password" autocomplete="new-password" required maxlength="1024" />
          </div>
          <div class="password-actions">
            <button class="account-button" type="submit" data-i18n="Set local password">Set local password</button>
            <button id="cancel-password" class="account-button secondary" type="button" data-i18n="Cancel">Cancel</button>
          </div>
        </form>
      </dialog>
</main>`;
