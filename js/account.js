(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);

  const els = {
    greeting: document.getElementById('account-greeting'),
    balance: document.getElementById('wallet-balance'),
    txnCard: document.getElementById('transactions-card'),
    txnList: document.getElementById('transactions-list'),
    toggleTxns: document.getElementById('toggle-transactions'),
    orders: document.getElementById('orders-list'),
    toggleOrders: document.getElementById('toggle-orders'),
    logout: document.getElementById('logout-btn')
  };

  const ORDER_STATUS_LABEL = { paid: 'Paid', pending: 'Pending', cancelled: 'Cancelled' };

  function money(cents) {
    return '$' + (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function dateLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function api(url, options) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    return { res, body };
  }

  function renderBalance(balanceCents) {
    els.balance.textContent = money(balanceCents);
  }

  function renderTxns(transactions) {
    if (!transactions || transactions.length === 0) {
      els.txnList.innerHTML = '<p class="muted">No wallet transactions yet. Add money to get started.</p>';
      return;
    }
    const list = document.createElement('ul');
    transactions.forEach(t => {
      const positive = t.kind === 'deposit' || t.kind === 'refund';
      const label = t.kind === 'deposit' ? 'Deposit · ' + (t.method || '')
        : t.kind === 'refund' ? 'Refund'
        : 'Order payment';
      const item = document.createElement('li');
      item.className = 'txn-item';
      item.innerHTML = `
        <div class="txn-top">
          <span>${escapeHTML(label)}</span>
          <span class="amount-${positive ? 'positive' : 'negative'}">${positive ? '+' : '−'}${money(t.amountCents)}</span>
        </div>
        <div class="txn-sub">${escapeHTML(t.id)} · ${escapeHTML(t.status)} · ${escapeHTML(dateLabel(t.createdAt))}${t.reference ? ' · ' + escapeHTML(t.reference) : ''}</div>`;
      list.appendChild(item);
    });
    els.txnList.innerHTML = '';
    els.txnList.appendChild(list);
  }

  function renderOrders(orders) {
    if (!orders || orders.length === 0) {
      els.orders.innerHTML = '<p class="muted">No orders yet. Browse events to get started.</p>';
      return;
    }
    const list = document.createElement('ul');
    orders.forEach(o => {
      const firstEvent = o.items && o.items[0] && o.items[0].event;
      const title = firstEvent ? firstEvent.name : o.orderNumber;
      const sub = [
        o.items ? o.items.length + ' line item(s)' : '',
        o.paymentMethod
      ].filter(Boolean).join(' · ');
      const item = document.createElement('li');
      item.className = 'order-item';
      item.innerHTML = `
        <div class="order-top">
          <span><a href="confirm.html?order=${encodeURIComponent(o.orderNumber)}" style="color:#5e29ba;text-decoration:none;">${escapeHTML(title)}</a></span>
          <span>${money(o.totalCents)}</span>
        </div>
        <div class="order-sub">
          <span class="order-status order-${escapeHTML(o.status)}">${escapeHTML(ORDER_STATUS_LABEL[o.status] || o.status)}</span>
          <span>${escapeHTML(o.orderNumber)}</span>
          <span>${escapeHTML(sub)}</span>
          <span>${escapeHTML(dateLabel(o.createdAt))}</span>
        </div>`;
      list.appendChild(item);
    });
    els.orders.innerHTML = '';
    els.orders.appendChild(list);
  }

  async function loadAccount() {
    const { res: authRes, body: authBody } = await api('/api/auth/me');
    if (authRes.status === 401) {
      els.greeting.textContent = 'You are not signed in.';
      els.balance.textContent = '—';
      els.balance.closest('.wallet-card').innerHTML +=
        '<p class="muted">Sign in to view your wallet and orders.</p>';
      els.txnList.innerHTML = '<p class="muted">Not available.</p>';
      els.orders.innerHTML = '<p class="muted">Not available.</p>';
      els.logout.classList.add('hidden');
      return;
    }
    if (authRes.ok && authBody && authBody.user) {
      const user = authBody.user;
      const name = (user.name || (user.email ? user.email.split('@')[0] : 'there')).split(' ')[0];
      els.greeting.textContent = 'Welcome back, ' + name + '.';
    }

    const [walletRes, ordersRes] = await Promise.all([
      api('/api/wallet'),
      api('/api/orders')
    ]);

    if (walletRes.ok && walletRes.body && walletRes.body.wallet) {
      renderBalance(walletRes.body.wallet.balanceCents);
      renderTxns(walletRes.body.wallet.transactions);
    } else {
      els.balance.textContent = 'Unavailable';
      els.txnList.innerHTML = '<p class="muted">Could not load wallet.</p>';
    }

    if (ordersRes.ok && ordersRes.body) {
      renderOrders(ordersRes.body.orders);
    } else {
      els.orders.innerHTML = '<p class="muted">Could not load orders.</p>';
    }
  }

  els.toggleTxns.addEventListener('click', () => {
    els.txnCard.classList.toggle('hidden');
    els.toggleTxns.textContent = els.txnCard.classList.contains('hidden') ? 'Show Transactions' : 'Hide Transactions';
  });

  els.toggleOrders.addEventListener('click', loadAccount);

  els.logout.addEventListener('click', async () => {
    els.logout.disabled = true;
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { /* ignore */ }
    window.location.href = 'index.html';
  });

  loadAccount();
})();