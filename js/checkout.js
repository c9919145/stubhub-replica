(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const eventId = Number(params.get('event'));
  const cancelled = params.get('cancelled') === '1';

  const els = {
    loading: document.getElementById('checkout-loading'),
    error: document.getElementById('checkout-error'),
    errorText: document.getElementById('checkout-error-text'),
    eventBox: document.getElementById('checkout-event'),
    eventImage: document.getElementById('event-image'),
    eventName: document.getElementById('event-name'),
    eventMeta: document.getElementById('event-meta'),
    eventAvailable: document.getElementById('event-available'),
    ticketOptions: document.getElementById('ticket-options'),
    crumbEvent: document.getElementById('crumb-event'),
    summaryLines: document.getElementById('summary-lines'),
    summarySubtotal: document.getElementById('summary-subtotal'),
    summaryFees: document.getElementById('summary-fees'),
    summaryTotal: document.getElementById('summary-total'),
    checkoutBtn: document.getElementById('checkout-btn'),
    checkoutBtnNote: document.getElementById('checkout-btn-note'),
    cancelBanner: document.getElementById('cancel-banner'),
    orderError: document.getElementById('order-error'),
    notice: document.getElementById('notice'),
    authGate: document.getElementById('auth-gate'),
    loginEmail: document.getElementById('login-email'),
    loginPassword: document.getElementById('login-password'),
    loginBtn: document.getElementById('login-btn'),
    authError: document.getElementById('auth-error'),
    showRegister: document.getElementById('show-register'),
    registerFields: document.getElementById('register-fields'),
    registerName: document.getElementById('register-name'),
    registerBtn: document.getElementById('register-btn'),
    paymentMethods: document.getElementById('payment-methods'),
    giftCardBox: document.getElementById('gift-card-box'),
    giftCardCode: document.getElementById('gift-card-code'),
    applyGiftCard: document.getElementById('apply-gift-card'),
    giftCardMsg: document.getElementById('gift-card-msg'),
    giftCardApplied: document.getElementById('gift-card-applied'),
    giftCardAppliedAmount: document.getElementById('gift-card-applied-amount'),
    summaryGiftRow: document.getElementById('summary-gift-row'),
    summaryGiftAmount: document.getElementById('summary-gift-amount'),
    summaryRemainingRow: document.getElementById('summary-remaining-row'),
    summaryRemaining: document.getElementById('summary-remaining'),
    walletBox: document.getElementById('wallet-box'),
    walletOrderTotal: document.getElementById('wallet-order-total'),
    walletBalance: document.getElementById('wallet-balance'),
    walletAmountUsed: document.getElementById('wallet-amount-used'),
    walletError: document.getElementById('wallet-error'),
    cryptoBox: document.getElementById('crypto-box'),
    cryptoAmount: document.getElementById('crypto-amount'),
    cryptoNetwork: document.getElementById('crypto-network'),
    cryptoAddress: document.getElementById('crypto-address'),
    copyCryptoAddress: document.getElementById('copy-crypto-address'),
    cryptoQr: document.getElementById('crypto-qr')
  };

  let ticketTypes = [];
  let quantities = new Map();
  /** Applied gift card: { orderNumber, totalCents, appliedCents, remainingCents, covered } or null */
  let gift = null;
  /** Wallet balance last fetched for the wallet payment option. */
  let walletBalanceCents = null;

  const FEE_DISPLAY_RATE = 0.10;

  function money(cents) {
    return '$' + (Number(cents) / 100).toFixed(2);
  }

  function showError(text) {
    els.orderError.textContent = text;
    els.orderError.classList.remove('hidden');
  }

  function clearError() {
    els.orderError.classList.add('hidden');
    els.orderError.textContent = '';
  }

  async function api(url, options) {
    const res = await fetch(apiUrl(url), {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    return { res, body };
  }

  function fmtDate(dt, venue, city) {
    return [dt, venue, city].filter(Boolean).join(' · ');
  }

  function renderTicketOptions() {
    els.ticketOptions.innerHTML = ticketTypes.map(tt => {
      const unavailable = tt.available <= 0;
      const qty = unavailable ? 0 : (quantities.get(tt.id) || 0);
      return `
        <div class="ticket-option ${unavailable ? 'is-unavailable' : ''}" data-id="${tt.id}">
          <div>
            <div class="to-name">${escapeHTML(tt.name)}</div>
            <div class="to-desc">${escapeHTML(tt.description || '')}</div>
            <div class="to-price">${money(tt.priceCents)}
              <small>/ ticket</small>
            </div>
            <div class="to-avail ${unavailable ? 'sold-out' : ''}">
              ${unavailable ? 'Sold out' : `${tt.available} available`}
            </div>
          </div>
          <div>
            <div class="stepper" aria-label="${escapeHTML(tt.name)} quantity">
              <button type="button" data-action="dec" aria-label="Decrease quantity" ${unavailable || qty <= 0 ? 'disabled' : ''}>−</button>
              <output aria-live="polite">${qty}</output>
              <button type="button" data-action="inc" aria-label="Increase quantity" ${unavailable || qty >= tt.available ? 'disabled' : ''}>+</button>
            </div>
          </div>
        </div>`;
    }).join('');
    updateSummary();
  }

  function selectedItems() {
    const items = [];
    quantities.forEach((qty, id) => {
      if (qty > 0) items.push({ ticketTypeId: id, quantity: qty });
    });
    return items;
  }

  function paymentMethod() {
    const checked = document.querySelector('input[name="payment-method"]:checked');
    return checked ? checked.value : 'card';
  }

  function updateSummary() {
    let subtotal = 0;
    const lines = [];
    quantities.forEach((qty, id) => {
      if (qty <= 0) return;
      const tt = ticketTypes.find(t => t.id === id);
      lines.push(`
        <div class="summary-line">
          <span>${escapeHTML(tt.name)} <span class="qty-badge">x${qty}</span></span>
          <strong>${money(tt.priceCents * qty)}</strong>
        </div>`
      );
      subtotal += tt.priceCents * qty;
    });

    const fees = Math.round(subtotal * FEE_DISPLAY_RATE);
    els.summaryLines.innerHTML = lines.length
      ? lines.join('')
      : '<div class="summary-line"><span>No tickets selected</span><span></span></div>';
    els.summarySubtotal.textContent = money(subtotal);
    els.summaryFees.textContent = money(fees);

    const gross = subtotal + fees;
    els.summaryTotal.textContent = money(gross);

    // Gift card + remaining balance rows.
    if (gift && gift.appliedCents > 0) {
      els.summaryGiftRow.classList.remove('hidden');
      els.summaryGiftAmount.textContent = '−' + money(gift.appliedCents);
    } else {
      els.summaryGiftRow.classList.add('hidden');
      els.summaryGiftAmount.textContent = '';
    }
    if (gift && gift.remainingCents > 0) {
      els.summaryRemainingRow.classList.remove('hidden');
      els.summaryRemaining.textContent = money(gift.remainingCents);
    } else {
      els.summaryRemainingRow.classList.add('hidden');
      els.summaryRemaining.textContent = '';
    }

    const hasItems = selectedItems().length > 0;
    els.checkoutBtn.disabled = !hasItems;
    els.paymentMethods.classList.toggle('hidden', !hasItems);
    updateCheckoutButton();
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadEvent() {
    if (!Number.isInteger(eventId) || eventId <= 0) {
      els.error.classList.remove('hidden');
      els.loading.classList.add('hidden');
      els.errorText.textContent = 'The event id is missing or invalid.';
      return;
    }
    const { res, body } = await api('/api/events/' + eventId);
    if (!res.ok) {
      els.error.classList.remove('hidden');
      els.loading.classList.add('hidden');
      els.errorText.textContent = (body && body.error) || 'We couldn\'t load this event.';
      return;
    }

    const { event, ticketTypes: types } = body;
    ticketTypes = types;
    quantities.clear();
    types.forEach(tt => quantities.set(tt.id, 0));

    els.eventBox.classList.remove('hidden');
    els.loading.classList.add('hidden');
    els.eventImage.src = event.imageUrl || '';
    els.eventImage.alt = event.name;
    els.eventName.textContent = event.name;
    els.eventMeta.textContent = fmtDate(event.date, event.venue, event.city);
    const totalAvailable = types.reduce((s, t) => s + Math.max(0, t.available), 0);
    els.eventAvailable.textContent = totalAvailable > 0
      ? `${totalAvailable} tickets available`
      : 'Currently sold out';
    els.crumbEvent.innerHTML = `<a href="event.html?id=${event.id}">${escapeHTML(event.name)}</a>`;

    renderTicketOptions();

    if (cancelled) {
      els.cancelBanner.classList.remove('hidden');
    }
  }

  function updateCheckoutButton() {
    const method = paymentMethod();
    els.checkoutBtnNote.textContent = '';
    if (!selectedItems().length) {
      els.checkoutBtn.textContent = 'Continue to secure checkout';
      els.checkoutBtnNote.textContent = 'Select at least one ticket to continue.';
      return;
    }
    if (!gift) {
      if (method === 'gift_card') {
        els.checkoutBtn.textContent = 'Apply gift card and review';
      } else if (method === 'wallet') {
        if (walletBalanceCents === null) {
          els.checkoutBtn.textContent = 'Check wallet balance';
        } else {
          els.checkoutBtn.textContent = 'Pay with wallet';
        }
      } else if (method === 'btc') {
        els.checkoutBtn.textContent = 'Record crypto payment';
      } else {
        els.checkoutBtn.textContent = 'Continue to secure checkout';
      }
      return;
    }
    // A gift card is already applied.
    if (gift.covered) {
      els.checkoutBtn.textContent = 'Place order';
      els.checkoutBtnNote.textContent = 'Your gift card covers the full order. No payment will be collected.';
    } else if (method === 'wallet') {
      els.checkoutBtn.textContent = 'Pay remaining with wallet';
      els.checkoutBtnNote.textContent = `${money(gift.remainingCents)} remaining after gift card.`;
    } else if (method === 'btc') {
      els.checkoutBtn.textContent = 'Record remaining payment with crypto';
      els.checkoutBtnNote.textContent = `${money(gift.remainingCents)} remaining after gift card.`;
    } else {
      els.checkoutBtn.textContent = 'Pay remaining with card';
      els.checkoutBtnNote.textContent = `${money(gift.remainingCents)} remaining after gift card.`;
    }
  }

  async function applyGiftCard() {
    clearError();
    const code = els.giftCardCode.value.trim();
    if (!code) {
      els.giftCardMsg.textContent = 'Enter a gift card code.';
      return;
    }
    els.applyGiftCard.disabled = true;
    els.giftCardMsg.textContent = 'Checking gift card…';

    const items = selectedItems();
    const { res, body } = await api('/api/orders/gift-card', {
      method: 'POST',
      body: JSON.stringify({ eventId, items, code })
    });

    els.applyGiftCard.disabled = false;
    if (res.status === 401) {
      els.giftCardMsg.textContent = 'Sign in to apply a gift card.';
      els.authGate.classList.remove('hidden');
      els.loginEmail.focus();
      return;
    }
    if (!res.ok) {
      els.giftCardMsg.textContent = (body && body.error) || 'Could not apply gift card.';
      return;
    }

    gift = {
      orderNumber: body.orderNumber,
      totalCents: body.totalCents,
      appliedCents: body.appliedCents,
      remainingCents: body.remainingCents,
      covered: body.giftCardCovered
    };
    els.giftCardBox.classList.add('hidden');
    els.giftCardApplied.classList.remove('hidden');
    els.giftCardAppliedAmount.textContent = money(gift.appliedCents);
    els.giftCardMsg.textContent = '';
    updateSummary();
  }

  async function submitOrder() {
    clearError();
    const items = selectedItems();
    if (items.length === 0) return;

    // If the user picked the gift card method but has no code applied yet, apply first.
    if (paymentMethod() === 'gift_card' && !gift) {
      await applyGiftCard();
      if (!gift) return; // apply failed or required sign-in
      if (gift.covered) {
        await completeGiftOrder();
        return;
      }
      // Otherwise fall through to remaining-balance checkout below.
    }

    els.checkoutBtn.disabled = true;
    const method = paymentMethod();
    let url;
    let payload = {};
    if (method === 'wallet') {
      url = '/api/orders/wallet';
      payload = { eventId, items };
      els.checkoutBtn.textContent = 'Paying with wallet…';
    } else if (method === 'btc') {
      url = '/api/orders/crypto';
      payload = { eventId, items, method };
      els.checkoutBtn.textContent = 'Recording crypto payment…';
    } else if (gift) {
      if (gift.covered) {
        url = `/api/orders/${gift.orderNumber}/gift-card/complete`;
      } else {
        url = `/api/orders/${gift.orderNumber}/pay-remaining/card`;
      }
    } else {
      url = '/api/orders';
      payload = { eventId, items };
      els.checkoutBtn.textContent = 'Creating secure checkout…';
    }

    const { res, body } = await api(url, { method: 'POST', body: JSON.stringify(payload) });
    afterOrderSubmit(res, body);
  }

  async function completeGiftOrder() {
    els.checkoutBtn.disabled = true;
    els.checkoutBtn.textContent = 'Placing order…';
    const { res, body } = await api(`/api/orders/${gift.orderNumber}/gift-card/complete`, { method: 'POST', body: '{}' });
    afterOrderSubmit(res, body);
  }

  function afterOrderSubmit(res, body) {
    if (res.status === 401) {
      els.authGate.classList.remove('hidden');
      els.loginEmail.focus();
      els.checkoutBtn.disabled = false;
      updateCheckoutButton();
      els.notice.textContent = 'Sign in to continue with your order.';
      els.notice.classList.remove('hidden');
      return;
    }

    if (res.status === 409 && body && body.code === 'INSUFFICIENT_INVENTORY') {
      reflectInventory(body);
      return;
    }

    if (res.status === 409 && body && body.code === 'INSUFFICIENT_WALLET_BALANCE') {
      els.walletError.textContent = (body && body.error) || 'Your wallet balance is not enough for this order.';
      els.walletError.classList.remove('hidden');
      els.checkoutBtn.disabled = false;
      updateCheckoutButton();
      return;
    }

    if (res.ok && body && body.checkoutUrl) {
      window.location.href = body.checkoutUrl;
      return;
    }
    if (res.ok && body && body.approveUrl) {
      window.location.href = body.approveUrl;
      return;
    }
    if (res.ok && body && body.order && body.order.status === 'paid') {
      window.location.href = 'confirm.html?order=' + encodeURIComponent(body.order.orderNumber);
      return;
    }
    if (res.ok && body && body.status === 'pending' && body.requiresVerification) {
      renderCryptoPending(body);
      return;
    }

    showError((body && body.error) || 'Something went wrong. Please try again.');
    els.checkoutBtn.disabled = false;
    updateCheckoutButton();
  }

  async function reflectInventory(body) {
    showError(body.error);
    const fresh = await api('/api/events/' + eventId);
    if (fresh.res.ok) {
      ticketTypes = fresh.body.ticketTypes;
      quantities.forEach((qty, id) => {
        const tt = ticketTypes.find(t => t.id === id);
        if (tt) quantities.set(id, Math.min(qty, Math.max(0, tt.available)));
      });
      renderTicketOptions();
    }
    els.checkoutBtn.disabled = false;
    updateCheckoutButton();
  }

  // Stepper events (delegate)
  els.ticketOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.ticket-option');
    const id = Number(row.dataset.id);
    const tt = ticketTypes.find(t => t.id === id);
    let qty = quantities.get(id) || 0;
    if (btn.dataset.action === 'inc') qty = Math.min(qty + 1, tt.available);
    else qty = Math.max(qty - 1, 0);
    quantities.set(id, qty);
    renderTicketOptions();
  });

  els.checkoutBtn.addEventListener('click', submitOrder);

  document.querySelectorAll('input[name="payment-method"]').forEach(r => {
    r.addEventListener('change', () => {
      els.giftCardBox.classList.toggle('hidden', r.value !== 'gift_card');
      if (r.value !== 'gift_card') els.giftCardMsg.textContent = '';
      els.walletBox.classList.toggle('hidden', r.value !== 'wallet');
      els.cryptoBox.classList.toggle('hidden', r.value !== 'btc' && r.value !== 'eth');
      if (r.value === 'wallet') selectWallet();
      updateCheckoutButton();
    });
  });

  function amountToPay() {
    const subtotal = selectedItems().reduce((sum, it) => {
      const tt = ticketTypes.find(t => t.id === it.ticketTypeId);
      return sum + tt.priceCents * it.quantity;
    }, 0);
    const fees = Math.round(subtotal * FEE_DISPLAY_RATE);
    return subtotal + fees - (gift ? gift.appliedCents : 0);
  }

  async function selectWallet() {
    els.walletError.classList.add('hidden');
    els.walletOrderTotal.textContent = money(amountToPay());
    els.walletAmountUsed.textContent = '—';
    const { res, body } = await api('/api/wallet');
    if (res.status === 401) {
      els.authGate.classList.remove('hidden');
      els.loginEmail.focus();
      els.walletBalance.textContent = 'Sign in required';
      return;
    }
    if (!res.ok) {
      els.walletBalance.textContent = 'Unavailable';
      return;
    }
    walletBalanceCents = body.wallet.balanceCents;
    els.walletBalance.textContent = money(walletBalanceCents);
    els.walletAmountUsed.textContent = money(Math.min(walletBalanceCents, amountToPay()));
    updateCheckoutButton();
  }

  els.copyCryptoAddress.addEventListener('click', async () => {
    const addr = (els.cryptoAddress.textContent || '').trim();
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      els.copyCryptoAddress.textContent = 'Copied';
      setTimeout(() => { els.copyCryptoAddress.textContent = 'Copy'; }, 1500);
    } catch (e) { /* clipboard unavailable */ }
  });

  function renderCryptoPending(body) {
    const p = body.payment || {};
    els.cryptoAmount.textContent = money(body.amountCents != null ? body.amountCents : amountToPay());
    els.cryptoNetwork.textContent = p.network || '';
    els.cryptoAddress.textContent = p.address || '';
    els.cryptoQr.src = p.qrImage || '';
    els.cryptoQr.alt = p.network ? `QR code for the ${p.network} address` : 'QR code';
    els.paymentMethods.classList.add('hidden');
    els.checkoutBtn.classList.add('hidden');
    els.checkoutBtnNote.classList.add('hidden');
    els.cryptoBox.classList.remove('hidden');
  }

  els.applyGiftCard.addEventListener('click', applyGiftCard);
  els.giftCardCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyGiftCard();
  });

  // Auth
  async function authRequest(path, payload) {
    const { res, body } = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    if (res.ok) {
      els.authGate.classList.add('hidden');
      els.notice.classList.add('hidden');
      return true;
    }
    els.authError.textContent = (body && body.error) || 'Sign in failed.';
    return false;
  }

  els.loginBtn.addEventListener('click', async () => {
    els.authError.textContent = '';
    const ok = await authRequest('/api/auth/login', {
      email: els.loginEmail.value.trim(),
      password: els.loginPassword.value
    });
    if (ok) submitOrder();
  });

  els.showRegister.addEventListener('click', () => {
    els.registerFields.classList.toggle('hidden');
  });

  els.registerBtn.addEventListener('click', async () => {
    els.authError.textContent = '';
    const ok = await authRequest('/api/auth/register', {
      email: els.loginEmail.value.trim(),
      name: els.registerName.value.trim() || null,
      password: els.loginPassword.value
    });
    if (ok) submitOrder();
  });

  // Header search
  const headerSearch = document.getElementById('header-search-input');
  if (headerSearch) {
    headerSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && headerSearch.value.trim()) {
        window.location.href = 'search.html?q=' + encodeURIComponent(headerSearch.value.trim());
      }
    });
  }

  loadEvent();
})();