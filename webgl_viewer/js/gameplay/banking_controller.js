function currency(value) {
    return `$${Math.max(0, Number(value) || 0).toLocaleString()}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[char]));
}

function optionList(accounts, selected) {
    return accounts.map((account) => (
        `<option value="${escapeHtml(account.name)}"${account.name === selected ? ' selected' : ''}>${escapeHtml(account.name)} (${currency(account.balance)})</option>`
    )).join('');
}

export class BankingController {
    constructor(app) {
        this.app = app;
        this.mode = 'bank';
        this.view = 'overview';
        this.selectedAccountName = 'checking';
        this.pending = '';
        this.notice = '';
        this.pinInput = '';
        this.atmUnlocked = false;
        this.dialog = document.createElement('dialog');
        this.dialog.id = 'bankingDialog';
        this.dialog.setAttribute('aria-label', 'Nexus Bank');
        this.style = document.createElement('style');
        this.style.textContent = `
            #bankingDialog{width:min(960px,calc(100vw - 28px));height:min(640px,calc(100vh - 34px));margin:auto;padding:0;border:1px solid rgba(184,205,215,.28);border-radius:6px;overflow:hidden;background:#101518;color:#eef3f5;box-shadow:0 22px 72px rgba(0,0,0,.72);font-family:Arial,sans-serif}
            #bankingDialog::backdrop{background:rgba(0,0,0,.58)}
            .banking-shell{display:grid;grid-template-rows:auto minmax(0,1fr) auto;height:100%}
            .banking-header{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:60px;padding:0 14px 0 18px;border-bottom:1px solid rgba(255,255,255,.11);background:#151d21}
            .banking-brand{color:#77c8e6;font-size:10px;font-weight:800;letter-spacing:0;text-transform:uppercase}.banking-title{margin-top:2px;font-size:19px;font-weight:800}
            .banking-close{width:34px;height:34px;padding:0;border:1px solid rgba(255,255,255,.18);border-radius:4px;background:#242d32;color:#fff;font-size:21px;cursor:pointer}.banking-close:hover{border-color:#77c8e6;background:#303b42}
            .banking-layout{display:grid;grid-template-columns:244px minmax(0,1fr);min-height:0}.banking-sidebar{overflow:auto;border-right:1px solid rgba(255,255,255,.1);background:#131a1e}
            .banking-identity{padding:16px;border-bottom:1px solid rgba(255,255,255,.09)}.banking-identity strong{display:block;font-size:15px}.banking-identity span,.banking-account-number{display:block;margin-top:5px;color:rgba(238,243,245,.58);font-size:11px}.banking-cash{color:#8dda9b!important;font-size:14px!important;font-weight:700}
            .banking-side-label{margin:15px 16px 7px;color:rgba(238,243,245,.52);font-size:10px;font-weight:800;letter-spacing:0;text-transform:uppercase}.banking-account,.banking-nav{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:42px;padding:8px 16px;border:0;border-left:3px solid transparent;background:transparent;color:#eef3f5;text-align:left;cursor:pointer}.banking-account:hover,.banking-account.is-active,.banking-nav:hover,.banking-nav.is-active{border-left-color:#77c8e6;background:rgba(119,200,230,.1)}.banking-account-name{overflow:hidden;font-size:12px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.banking-account-balance{margin-left:8px;color:#8dda9b;font-size:11px;font-weight:700;white-space:nowrap}.banking-nav{justify-content:flex-start;font-size:12px;font-weight:700}
            .banking-main{min-width:0;overflow:auto;background:#101518}.banking-content{max-width:760px;margin:0 auto;padding:22px}.banking-content-heading{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:18px}.banking-content-heading h2{margin:0;font-size:20px}.banking-content-heading span{color:rgba(238,243,245,.58);font-size:12px}
            .banking-balance{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:16px 0;border-top:1px solid rgba(255,255,255,.1);border-bottom:1px solid rgba(255,255,255,.1)}.banking-balance-label{color:rgba(238,243,245,.66);font-size:12px}.banking-balance-value{color:#8dda9b;font-size:24px;font-weight:800}
            .banking-section{margin-top:22px}.banking-section h3{margin:0 0 10px;font-size:13px}.banking-section-note{margin:-4px 0 11px;color:rgba(238,243,245,.58);font-size:11px}.banking-statements{border-top:1px solid rgba(255,255,255,.1)}.banking-statement{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:11px 2px;border-bottom:1px solid rgba(255,255,255,.07)}.banking-statement strong{display:block;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.banking-statement span{display:block;margin-top:3px;color:rgba(238,243,245,.54);font-size:10px}.banking-statement-amount{align-self:center;font-size:12px;font-weight:800}.banking-statement-amount.deposit{color:#8dda9b}.banking-statement-amount.withdraw{color:#ff9c8a}
            .banking-workflow-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.banking-workflow{padding:0 0 16px;border-bottom:1px solid rgba(255,255,255,.1)}.banking-workflow h3{margin:0 0 12px;font-size:14px}.banking-workflow label{display:block;margin:12px 0 5px;color:rgba(238,243,245,.66);font-size:11px;font-weight:700}.banking-workflow input,.banking-workflow select{width:100%;height:36px;padding:0 9px;box-sizing:border-box;border:1px solid rgba(255,255,255,.17);border-radius:3px;outline:0;background:#0b0f12;color:#f3f7f8;font:600 12px Arial,sans-serif}.banking-workflow input:focus,.banking-workflow select:focus{border-color:#77c8e6}.banking-workflow button{min-height:34px;margin-top:15px;padding:7px 11px;border:1px solid #4e9fbe;border-radius:3px;background:#1d5b72;color:#fff;font:700 12px Arial,sans-serif;cursor:pointer}.banking-workflow button:hover:not(:disabled){background:#28718b}.banking-workflow button:disabled{cursor:default;opacity:.48}.banking-workflow .banking-danger{border-color:#c96055;background:#6d2d2a}.banking-workflow .banking-danger:hover:not(:disabled){background:#853a35}.banking-inline{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.banking-inline button{margin-top:0}
            .banking-notice{min-height:17px;padding:0 18px 14px;color:#b9c9d0;font-size:12px}.banking-notice.is-error{color:#ff9c8a}.banking-notice.is-success{color:#8dda9b}
            .banking-atm-lock{display:grid;place-items:center;min-height:100%;padding:26px}.banking-pin{width:min(340px,100%);text-align:center}.banking-pin h2{margin:0;font-size:20px}.banking-pin p{margin:7px 0 18px;color:rgba(238,243,245,.62);font-size:12px}.banking-pin-display{height:42px;line-height:42px;border:1px solid rgba(119,200,230,.5);border-radius:4px;background:#090c0e;color:#eef3f5;font-size:20px;letter-spacing:8px}.banking-keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px}.banking-keypad button{height:42px;border:1px solid rgba(255,255,255,.14);border-radius:3px;background:#1b2429;color:#fff;font:700 14px Arial,sans-serif;cursor:pointer}.banking-keypad button:hover{border-color:#77c8e6;background:#27343a}.banking-pin-submit{width:100%;height:38px;margin-top:10px;border:1px solid #4e9fbe;border-radius:3px;background:#1d5b72;color:#fff;font:700 12px Arial,sans-serif;cursor:pointer}
            @media(max-width:720px){#bankingDialog{width:calc(100vw - 16px);height:calc(100vh - 16px)}.banking-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.banking-sidebar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-right:0;border-bottom:1px solid rgba(255,255,255,.1)}.banking-identity{grid-column:1/-1;padding:10px 14px}.banking-side-label{display:none}.banking-account,.banking-nav{min-height:34px;padding:7px 10px}.banking-workflow-grid{grid-template-columns:1fr}.banking-content{padding:16px}.banking-balance-value{font-size:20px}}
        `;
        document.head.append(this.style);
        document.body.append(this.dialog);
        this._bindEvents();
    }

    get isOpen() {
        return !!this.dialog?.open;
    }

    handleInteraction(action) {
        if (action?.type === 'open_bank') return this.open('bank');
        if (action?.type === 'open_atm') return this.open('atm');
        return false;
    }

    applyProfile() {
        if (this.isOpen) this.render();
    }

    handleServerEvent(message) {
        if (!String(message?.kind || '').startsWith('bank_')) return;
        if (message?.id && message.id !== this.app?.multiplayer?.id) return;
        this.pending = '';
        this.notice = String(message?.result?.message || 'Banking updated');
        this.noticeType = message?.result?.success ? 'success' : 'error';
        if (this._atmVerifying && message?.result?.success) this.atmUnlocked = true;
        this._atmVerifying = false;
        if (this.isOpen) this.render();
    }

    open(mode = 'bank') {
        if (!this._banking()) {
            this._showSystemMessage('Banking is unavailable until multiplayer connects');
            return false;
        }
        this._releaseGameplayInput();
        this.mode = mode === 'atm' ? 'atm' : 'bank';
        this.view = this.mode === 'atm' ? 'money' : this.view;
        this.atmUnlocked = this.mode !== 'atm';
        this.pinInput = '';
        this.pending = '';
        this.notice = '';
        this.noticeType = '';
        this.render();
        try { this.dialog.showModal(); } catch { this.dialog.setAttribute('open', ''); }
        requestAnimationFrame(() => this.dialog.querySelector('[data-bank-autofocus]')?.focus());
        return true;
    }

    close({ recapturePointer = true } = {}) {
        if (!this.isOpen) return false;
        try { this.dialog.close(); } catch { this.dialog.removeAttribute('open'); }
        if (recapturePointer) this.app?._requestGameplayPointerLock?.();
        return true;
    }

    render() {
        const banking = this._banking();
        if (!banking) {
            this.dialog.innerHTML = '<div class="banking-atm-lock"><div class="banking-pin"><h2>Banking unavailable</h2></div></div>';
            return;
        }
        const accounts = this._accounts(banking);
        if (!accounts.some((account) => account.name === this.selectedAccountName)) this.selectedAccountName = 'checking';
        const selected = accounts.find((account) => account.name === this.selectedAccountName) || accounts[0];
        if (this.mode === 'atm' && !this.atmUnlocked) {
            this.dialog.innerHTML = `<div class="banking-atm-lock">${this._renderPinGate(banking)}</div>`;
            return;
        }
        const isAtm = this.mode === 'atm';
        this.dialog.innerHTML = `
            <section class="banking-shell">
                <header class="banking-header">
                    <div><div class="banking-brand">NexusAI Financial</div><div class="banking-title">${isAtm ? 'Nexus ATM' : 'Nexus Bank'}</div></div>
                    <button class="banking-close" type="button" data-bank-action="close" aria-label="Close banking" title="Close">&times;</button>
                </header>
                <div class="banking-layout">
                    <aside class="banking-sidebar">
                        <div class="banking-identity"><strong>${escapeHtml(this.app?.multiplayer?.name || 'Account holder')}</strong><span class="banking-cash">Cash ${currency(this.app?.multiplayer?.profile?.money)}</span><span class="banking-account-number">Account ${escapeHtml(banking.accountNumber)}</span></div>
                        <div class="banking-side-label">Accounts</div>
                        ${accounts.map((account) => `<button class="banking-account${account.name === selected.name ? ' is-active' : ''}" type="button" data-bank-action="select-account" data-bank-account="${escapeHtml(account.name)}"><span class="banking-account-name">${escapeHtml(account.name)}</span><span class="banking-account-balance">${currency(account.balance)}</span></button>`).join('')}
                        ${isAtm ? '' : `<div class="banking-side-label">Services</div>
                            <button class="banking-nav${this.view === 'overview' ? ' is-active' : ''}" type="button" data-bank-action="view" data-bank-view="overview">Overview</button>
                            <button class="banking-nav${this.view === 'money' ? ' is-active' : ''}" type="button" data-bank-action="view" data-bank-view="money">Deposit and withdraw</button>
                            <button class="banking-nav${this.view === 'transfer' ? ' is-active' : ''}" type="button" data-bank-action="view" data-bank-view="transfer">Transfer</button>
                            <button class="banking-nav${this.view === 'accounts' ? ' is-active' : ''}" type="button" data-bank-action="view" data-bank-view="accounts">Account options</button>`}
                    </aside>
                    <main class="banking-main">${this._renderContent({ banking, accounts, selected, isAtm })}</main>
                </div>
                <div class="banking-notice${this.noticeType ? ` is-${this.noticeType}` : ''}" aria-live="polite">${escapeHtml(this.notice)}</div>
            </section>`;
    }

    _renderPinGate(banking) {
        if (banking.card?.active === false) return `<div class="banking-pin"><h2>Debit card required</h2><p>Visit a Nexus Bank branch to issue a card.</p><button class="banking-pin-submit" type="button" data-bank-action="close">Close</button></div>`;
        const dots = this.pinInput.replace(/./g, '*');
        return `<div class="banking-pin"><h2>Enter debit card PIN</h2><p>Nexus ATM</p><div class="banking-pin-display">${dots || '&nbsp;'}</div><div class="banking-keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => `<button type="button" data-bank-action="pin-key" data-bank-key="${digit}">${digit}</button>`).join('')}<button type="button" data-bank-action="pin-key" data-bank-key="clear">Clear</button><button type="button" data-bank-action="pin-key" data-bank-key="0">0</button><button type="button" data-bank-action="pin-key" data-bank-key="backspace">Back</button></div><button class="banking-pin-submit" type="button" data-bank-action="unlock-atm"${this.pinInput.length === 4 ? '' : ' disabled'}>Continue</button></div>`;
    }

    _renderContent({ banking, accounts, selected, isAtm }) {
        if (isAtm) return this._renderMoney(accounts, selected, true);
        if (this.view === 'money') return this._renderMoney(accounts, selected, false);
        if (this.view === 'transfer') return this._renderTransfer(accounts);
        if (this.view === 'accounts') return this._renderAccountOptions(accounts, banking);
        const statements = Array.isArray(banking.statements?.[selected.name]) ? banking.statements[selected.name] : [];
        return `<div class="banking-content"><div class="banking-content-heading"><div><h2>${escapeHtml(selected.name)}</h2><span>${selected.type === 'checking' ? 'Personal checking account' : selected.owner ? 'Shared account owner' : 'Shared account access'}</span></div><span>${statements.length} transactions</span></div><div class="banking-balance"><span class="banking-balance-label">Available balance</span><strong class="banking-balance-value">${currency(selected.balance)}</strong></div><section class="banking-section"><h3>Transactions</h3><div class="banking-statements">${statements.length ? statements.map((statement) => `<div class="banking-statement"><div><strong>${escapeHtml(statement.reason || 'Bank transaction')}</strong><span>${escapeHtml(new Date(statement.date).toLocaleString())}</span></div><div class="banking-statement-amount ${statement.type === 'deposit' ? 'deposit' : 'withdraw'}">${statement.type === 'deposit' ? '+' : '-'}${currency(statement.amount)}</div></div>`).join('') : '<div class="banking-statement"><span>No transactions yet</span></div>'}</div></section></div>`;
    }

    _renderMoney(accounts, selected, atm) {
        const options = optionList(accounts, selected.name);
        return `<div class="banking-content"><div class="banking-content-heading"><div><h2>${atm ? 'Withdraw cash' : 'Manage money'}</h2><span>${atm ? 'Debit card verified' : 'Cash and account transfers'}</span></div></div><div class="banking-workflow-grid">${atm ? '' : `<section class="banking-workflow"><h3>Deposit</h3><label>Account<select name="deposit-account">${options}</select></label><label>Amount<input name="deposit-amount" type="number" min="1" step="1" inputmode="numeric" data-bank-autofocus></label><label>Reason<input name="deposit-reason" maxlength="50" placeholder="Bank Deposit"></label><button type="button" data-bank-action="deposit"${this.pending ? ' disabled' : ''}>${this.pending ? 'Processing' : 'Deposit'}</button></section>`}<section class="banking-workflow"><h3>Withdraw</h3><label>Account<select name="withdraw-account">${options}</select></label><label>Amount<input name="withdraw-amount" type="number" min="1" step="1" inputmode="numeric"${atm ? ' data-bank-autofocus' : ''}></label><label>Reason<input name="withdraw-reason" maxlength="50" placeholder="Bank Withdrawal"></label><button type="button" data-bank-action="withdraw"${this.pending ? ' disabled' : ''}>${this.pending ? 'Processing' : 'Withdraw'}</button></section></div></div>`;
    }

    _renderTransfer(accounts) {
        const options = optionList(accounts, 'checking');
        return `<div class="banking-content"><div class="banking-content-heading"><div><h2>Transfer</h2><span>Internal and online account transfers</span></div></div><div class="banking-workflow-grid"><section class="banking-workflow"><h3>Internal transfer</h3><label>From<select name="internal-from">${options}</select></label><label>To<select name="internal-to">${options}</select></label><label>Amount<input name="internal-amount" type="number" min="1" step="1" inputmode="numeric" data-bank-autofocus></label><label>Reason<input name="internal-reason" maxlength="50" placeholder="Internal transfer"></label><button type="button" data-bank-action="internal-transfer"${this.pending ? ' disabled' : ''}>${this.pending ? 'Processing' : 'Transfer'}</button></section><section class="banking-workflow"><h3>External transfer</h3><label>Recipient account number<input name="external-recipient" maxlength="16" placeholder="NX0000000000"></label><label>From<select name="external-from">${options}</select></label><label>Amount<input name="external-amount" type="number" min="1" step="1" inputmode="numeric"></label><label>Reason<input name="external-reason" maxlength="50" placeholder="External transfer"></label><button type="button" data-bank-action="external-transfer"${this.pending ? ' disabled' : ''}>${this.pending ? 'Processing' : 'Send transfer'}</button></section></div></div>`;
    }

    _renderAccountOptions(accounts, banking) {
        const owned = accounts.filter((account) => account.type === 'shared' && account.owner);
        const options = owned.map((account) => `<option value="${escapeHtml(account.name)}">${escapeHtml(account.name)}</option>`).join('');
        return `<div class="banking-content"><div class="banking-content-heading"><div><h2>Account options</h2><span>Debit card and shared accounts</span></div></div><div class="banking-workflow-grid"><section class="banking-workflow"><h3>Debit card</h3><p class="banking-section-note">${banking.card?.active === false ? 'Issue a debit card with a four-digit PIN.' : 'Replace your debit card PIN.'}</p><label>New PIN<input name="card-pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" data-bank-autofocus></label><button type="button" data-bank-action="set-card-pin"${this.pending ? ' disabled' : ''}>Save PIN</button></section><section class="banking-workflow"><h3>Open shared account</h3><label>Name<input name="new-account-name" maxlength="48" placeholder="Account name"></label><label>Initial deposit<input name="new-account-amount" type="number" min="1" step="1" inputmode="numeric"></label><button type="button" data-bank-action="open-account"${this.pending ? ' disabled' : ''}>Open account</button></section>${owned.length ? `<section class="banking-workflow"><h3>Manage shared account</h3><label>Account<select name="manage-account">${options}</select></label><label>New name<input name="rename-account" maxlength="48" placeholder="New account name"></label><div class="banking-inline"><button type="button" data-bank-action="rename-account"${this.pending ? ' disabled' : ''}>Rename</button><button class="banking-danger" type="button" data-bank-action="delete-account"${this.pending ? ' disabled' : ''}>Delete</button></div></section><section class="banking-workflow"><h3>Manage users</h3><label>Account<select name="user-account">${options}</select></label><label>User account number<input name="user-account-number" maxlength="16" placeholder="NX0000000000"></label><div class="banking-inline"><button type="button" data-bank-action="add-user"${this.pending ? ' disabled' : ''}>Add user</button><button type="button" data-bank-action="remove-user"${this.pending ? ' disabled' : ''}>Remove</button></div></section>` : ''}</div></div>`;
    }

    _bindEvents() {
        this.dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
        this.dialog.addEventListener('click', (event) => {
            if (event.target === this.dialog) { this.close(); return; }
            const button = event.target?.closest?.('[data-bank-action]');
            if (!button || button.disabled) return;
            event.preventDefault();
            this._handleAction(button.dataset.bankAction, button.dataset);
        });
    }

    _handleAction(action, data) {
        if (action === 'close') return this.close();
        if (action === 'view') { this.view = data.bankView || 'overview'; this.notice = ''; this.render(); return; }
        if (action === 'select-account') { this.selectedAccountName = String(data.bankAccount || 'checking'); this.view = 'overview'; this.render(); return; }
        if (action === 'pin-key') {
            const key = data.bankKey;
            if (key === 'clear') this.pinInput = '';
            else if (key === 'backspace') this.pinInput = this.pinInput.slice(0, -1);
            else if (/^\d$/.test(key) && this.pinInput.length < 4) this.pinInput += key;
            this.render();
            return;
        }
        if (action === 'unlock-atm') {
            this._atmVerifying = true;
            this._send('bank_withdraw', { accountName: 'checking', amount: 0, channel: 'atm', pin: this.pinInput, verifyOnly: true });
            return;
        }
        if (action === 'deposit') return this._send('bank_deposit', { accountName: this._value('deposit-account'), amount: this._value('deposit-amount'), reason: this._value('deposit-reason') });
        if (action === 'withdraw') return this._send('bank_withdraw', { accountName: this._value('withdraw-account'), amount: this._value('withdraw-amount'), reason: this._value('withdraw-reason') });
        if (action === 'internal-transfer') return this._send('bank_internal_transfer', { fromAccountName: this._value('internal-from'), toAccountName: this._value('internal-to'), amount: this._value('internal-amount'), reason: this._value('internal-reason') });
        if (action === 'external-transfer') return this._send('bank_external_transfer', { fromAccountName: this._value('external-from'), toAccountNumber: this._value('external-recipient'), amount: this._value('external-amount'), reason: this._value('external-reason') });
        if (action === 'set-card-pin') return this._send('bank_set_card_pin', { pin: this._value('card-pin') });
        if (action === 'open-account') return this._send('bank_open_account', { accountName: this._value('new-account-name'), amount: this._value('new-account-amount') });
        if (action === 'rename-account') return this._send('bank_rename_account', { accountName: this._value('manage-account'), newName: this._value('rename-account') });
        if (action === 'delete-account') return this._send('bank_delete_account', { accountName: this._value('manage-account') });
        if (action === 'add-user') return this._send('bank_add_user', { accountName: this._value('user-account'), userAccountNumber: this._value('user-account-number') });
        if (action === 'remove-user') return this._send('bank_remove_user', { accountName: this._value('user-account'), userAccountNumber: this._value('user-account-number') });
    }

    _send(kind, payload) {
        if (this.pending) return false;
        const action = {
            kind,
            eventId: `${this.app?.multiplayer?.sessionId || 'bank'}:${kind}:${Date.now()}`,
            ...payload,
        };
        if (this.mode === 'atm') Object.assign(action, { channel: 'atm', pin: this.pinInput });
        if (!this.app?.multiplayer?.sendGameplayAction?.(action)) {
            this.notice = 'Banking connection unavailable';
            this.noticeType = 'error';
            this.render();
            return false;
        }
        this.pending = action.eventId;
        this.notice = 'Processing banking request';
        this.noticeType = '';
        this.render();
        return true;
    }

    _accounts(banking) {
        return [
            { name: 'checking', type: 'checking', owner: true, balance: Math.max(0, Number(banking.checking) || 0) },
            ...(Array.isArray(banking.sharedAccounts) ? banking.sharedAccounts.map((account) => ({
                name: String(account.name || ''), type: 'shared', owner: !!account.owner, balance: Math.max(0, Number(account.balance) || 0),
            })).filter((account) => account.name) : []),
        ];
    }

    _banking() {
        const profile = this.app?.multiplayer?.profile;
        return profile?.banking && typeof profile.banking === 'object' ? profile.banking : null;
    }

    _value(name) {
        return String(this.dialog.querySelector(`[name="${name}"]`)?.value || '').trim();
    }

    _releaseGameplayInput() {
        for (const key of Object.keys(this.app?.keyState || {})) this.app.keyState[key] = false;
        try { this.app?.weaponController?.clearPointerState?.(); } catch { /* ignore */ }
        try { this.app?.meleeController?.clearInput?.(); } catch { /* ignore */ }
        this.app._suppressPointerUnlockMenu = true;
        try { document.exitPointerLock?.(); } catch { /* ignore */ }
    }

    _showSystemMessage(text) {
        this.app?.chatMenu?.addMessage?.({ system: true, text });
    }
}
