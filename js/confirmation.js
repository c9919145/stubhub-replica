(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const orderNumber = params.get('order');

  const els = {
    loading: document.getElementById('confirmation-loading'),
    error: document.getElementById('confirmation-error'),
    content: document.getElementById('confirmation-content')
  };

  const money = cents => '$' + (Number(cents) / 100).toFixed(2);

  const STATUSES = {
    paid: { icon: '✔', tone: 'paid', title: 'Payment confirmed!' },
    pending: { icon: '…', tone: 'pending', title: 'Confirming your payment…' },
    processing: { icon: '…', tone: 'pending', title: 'Confirming your payment…' },
    failed: { icon: '✕', tone: 'failed', title: 'Payment failed' },
    cancelled: { icon: '✕', tone: 'cancelled', title: 'Checkout cancelled' },
    expired: { icon: '✕', tone: 'expired', title: 'Checkout expired' },
    refunded: { icon: '↩', tone: 'refunded', title: 'Order refunded' }
  };

  const PAYMENT_COPY = {
    paid: 'Your tickets are confirmed. A confirmation was sent to your account on file.',
    pending: 'Waiting for the payment provider to confirm your payment. Refresh or wait a moment.',
    failed: 'The payment was not successful. No tickets were released and no charge was made.',
    cancelled: 'No charge was made. Your ticket reservation has been released.',
    expired: 'The checkout session expired. Your reservation has been released.',
    refunded: 'This order has been refunded.'
  };

  async function fetchOrder() {
    const res = await fetch('/api/orders/' + encodeURIComponent(orderNumber || ''), { headers: { 'Content-Type': 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    return { res, body };
  }

  function render(order) {
    const meta = STATUSES[order.status] || { icon: '?', tone: 'pending', title: order.status };
    const firstItem = order.items[0] || {};
    const eventMeta = [firstItem.event && firstItem.event.venue, firstItem.event && firstItem.event.city, firstItem.event && firstItem.event.date]
      .filter(Boolean).join(' · ');

    els.content.innerHTML = `
      <div class="confirmation-card">
        <div class="confirmation-status">
          <div class="status-icon ${meta.tone}"><span aria-hidden="true">${meta.icon}</span></div>
          <div>
            <h1>${meta.title}</h1>
            <p class="note">${PAYMENT_COPY[order.status] || ''}</p>
            <p class="note">Order number: <span class="order-number">${escapeHTML(order.orderNumber)}</span></p>
            ${order.paidAt ? `<p class="note">Paid: <strong>${money(order.totalCents)}</strong> on ${escapeHTML(order.paidAt)}</p>` : ''}
          </div>
        </div>
      </div>

      <div class="confirmation-card">
        <h2 style="font-size:var(--font-size-400);font-weight:700;margin-bottom:var(--spacing-200);">
          ${escapeHTML(firstItem.event ? firstItem.event.name : 'Your tickets')}
        </h2>
        <p class="note" style="margin:0 0 var(--spacing-200);">${escapeHTML(eventMeta)}</p>
        <div class="ticket-list">
          ${order.items.map(i => `
            <div class="ticket-list-item">
              <span>${escapeHTML(i.ticketType)} <span class="qty-badge">x${i.quantity}</span></span>
              <span>${money(i.unitPriceCents * i.quantity)}</span>
            </div>`).join('')}
        </div>
        <div class="summary-row"><span>Subtotal</span><span style="float:right;">${money(order.subtotalCents)}</span></div>
        <div class="summary-row"><span>Service fee &amp; taxes</span><span style="float:right;">${money(order.feesCents)}</span></div>
        ${order.discountCents ? `<div class="summary-row"><span>Discount</span><span style="float:right;">−${money(order.discountCents)}</span></div>` : ''}
        ${order.giftCardCents ? `<div class="summary-row"><span>Gift card</span><span style="float:right;">−${money(order.giftCardCents)}</span></div>` : ''}
        <div class="summary-row summary-total"><span>Total</span><span style="float:right;">${money(order.totalCents)}</span></div>

        <div class="payment-details" style="margin-top:var(--spacing-200);padding-top:var(--spacing-200);border-top:1px solid var(--border);">
          <p class="note" style="margin:0 0 var(--spacing-100);"><strong>Payment</strong></p>
          ${paymentSummary(order)}
        </div>
      </div>

      <div class="confirmation-card">
        <div class="confirmation-actions">
          <a href="tickets.html" class="btn btn-primary">Go to My Tickets</a>
          <a href="index.html" class="btn btn-secondary">Back to Home</a>
          ${order.status === 'pending' ? `<button class="btn btn-ghost" id="refresh-status">Refresh status</button>` : ''}
        </div>
      </div>`;

    const refreshBtn = document.getElementById('refresh-status');
    if (refreshBtn) refreshBtn.addEventListener('click', init);
  }

  function paymentSummary(order) {
    const providerLabels = { stripe: 'Card', paypal: 'PayPal', gift_card: 'Gift card', wallet: 'Wallet balance', btc: 'BTC', eth: 'ETH' };
    const method = providerLabels[order.paymentMethod] || order.paymentMethod || 'Card';
    const lines = [`<span class="note" style="display:flex;justify-content:space-between;gap:var(--spacing-200);"><span>Method</span><strong>${escapeHTML(method)}</strong></span>`];

    if (order.payment && order.payment.amountCents > 0) {
      const paidBy = providerLabels[order.payment.provider] || order.payment.provider;
      const paidByLabel = paidBy === 'Gift card' && order.giftCardCents > 0
        ? `Gift card (${money(order.giftCardCents)})`
        : paidBy;
      lines.push(`
        <span class="note" style="display:flex;justify-content:space-between;gap:var(--spacing-200);">
          <span>Paid via ${escapeHTML(paidByLabel)}</span><strong>${money(order.payment.amountCents)}</strong>
        </span>`);
      if (order.payment.transactionId) {
        lines.push(`<span class="note" style="display:flex;justify-content:space-between;gap:var(--spacing-200);">
          <span>Reference</span><span style="word-break:break-all;">${escapeHTML(order.payment.transactionId)}</span></span>`);
      }
    }

    if (order.status === 'refunded') {
      lines.push('<span class="note" style="color:var(--danger, #b00020);">This order was refunded; gift card balance (if any) was restored.</span>');
    }
    if (order.status === 'paid' && order.paymentMethod === 'gift_card') {
      lines.push('<span class="note">Your order was covered by a gift card. No card was charged.</span>');
    }
    if (order.status === 'paid' && order.paymentMethod === 'wallet') {
      lines.push('<span class="note">Paid with your wallet balance.</span>');
    }
    if (order.status === 'pending' && (order.paymentMethod === 'btc' || order.paymentMethod === 'eth')) {
      lines.push('<span class="note">This crypto payment is waiting for on-chain confirmation. Your order is completed by our team after the blockchain confirms the transaction.</span>');
    }
    return lines.join('');
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function init() {
    if (!orderNumber) {
      els.loading.classList.add('hidden');
      els.error.textContent = 'Missing order reference.';
      els.error.classList.remove('hidden');
      return;
    }

    const { res, body } = await fetchOrder();

    if (res.status === 401) {
      els.loading.classList.add('hidden');
      els.error.innerHTML = 'Please <a href="index.html">sign in</a> to view this order.';
      els.error.classList.remove('hidden');
      return;
    }

    if (!res.ok) {
      els.loading.classList.add('hidden');
      els.error.textContent = (body && body.error) || 'Order not found.';
      els.error.classList.remove('hidden');
      return;
    }

    render(body.order);
    els.loading.classList.add('hidden');
    els.content.classList.remove('hidden');

    if (body.order.status === 'pending') {
      // Poll until the webhook flips it to a terminal state (max ~90s).
      let attempts = 0;
      const timer = window.setInterval(async () => {
        attempts += 1;
        const again = await fetchOrder();
        if (again.res.ok && again.body.order.status !== 'pending') {
          window.clearInterval(timer);
          render(again.body.order);
        } else if (attempts >= 30) {
          window.clearInterval(timer);
        }
      }, 3000);
    }
  }

  // Header search
  const headerSearch = document.getElementById('header-search-input');
  if (headerSearch) {
    headerSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && headerSearch.value.trim()) {
        window.location.href = 'search.html?q=' + encodeURIComponent(headerSearch.value.trim());
      }
    });
  }

  init();
})();