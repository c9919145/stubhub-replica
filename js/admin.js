(() => {
  'use strict';

  const els = {
    login: document.getElementById('admin-login'),
    email: document.getElementById('admin-email'),
    password: document.getElementById('admin-password'),
    loginBtn: document.getElementById('admin-login-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    error: document.getElementById('admin-error'),
    errorBanner: document.getElementById('admin-error-banner'),
    successBanner: document.getElementById('admin-success-banner'),
    loading: document.getElementById('admin-loading'),
    tabs: document.getElementById('admin-tabs'),
    tabBtns: Array.from(document.querySelectorAll('.admin-tab')),
    panelOrders: document.getElementById('panel-orders'),
    panelGiftcards: document.getElementById('panel-giftcards'),

    // Orders
    tableWrap: document.getElementById('admin-table-wrap'),
    tbody: document.getElementById('admin-tbody'),
    empty: document.getElementById('admin-empty'),

    // Gift cards
    gcCreateForm: document.getElementById('gc-create-form'),
    gcValue: document.getElementById('gc-value'),
    gcCount: document.getElementById('gc-count'),
    gcResults: document.getElementById('gc-results'),
    gcCodeList: document.getElementById('gc-code-list'),
    gcTableWrap: document.getElementById('gc-table-wrap'),
    gcTable: document.getElementById('gc-table'),
    gcTbody: document.getElementById('gc-tbody'),
    gcEmpty: document.getElementById('gc-empty'),
    gcHistory: document.getElementById('gc-history'),
    gcHistoryTable: document.getElementById('gc-history-table'),
    gcHistoryTbody: document.getElementById('gc-history-tbody'),
    gcHistoryClose: document.getElementById('gc-history-close')
  };

  const money = cents => '$' + (Number(cents) / 100).toFixed(2);

  function fmtDate(value) {
    if (!value) return '—';
    return new Date(String(value).replace(' ', 'T') + 'Z').toLocaleString();
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const PAYMENT_BADGE = {
    succeeded: ['bg-success', 'Paid'],
    pending: ['bg-pending', 'Pending'],
    processing: ['bg-pending', 'Processing'],
    requires_action: ['bg-pending', 'Action'],
    failed: ['bg-error', 'Failed'],
    refunded: ['bg-error', 'Refunded']
  };

  const ORDER_BADGE = {
    paid: ['bg-success', 'PAID'],
    pending: ['bg-pending', 'PENDING'],
    failed: ['bg-error', 'FAILED'],
    expired: ['bg-muted', 'EXPIRED'],
    cancelled: ['bg-muted', 'CANCELLED'],
    refunded: ['bg-error', 'REFUNDED']
  };

  const KIND_LABEL = {
    hold: 'Hold',
    redeem: 'Redeemed',
    release: 'Released',
    refund: 'Refund'
  };

  function badge(tone, label) {
    return `<span class="badge ${tone}">${escapeHTML(label)}</span>`;
  }

  async function api(url, options) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    return { res, body };
  }

  async function checkAuth() {
    const { res, body } = await api('/api/auth/me');
    return { authed: res.ok, isAdmin: Boolean(body && body.user && body.user.isAdmin) };
  }

  function banner(kind, text) {
    const el = kind === 'success' ? els.successBanner : els.errorBanner;
    (kind === 'success' ? els.errorBanner : els.successBanner).classList.add('hidden');
    el.textContent = text;
    el.classList.remove('hidden');
  }

  /* ---------- Orders tab ---------- */

  async function loadOrders() {
    if (els.panelOrders.classList.contains('hidden')) return;
    els.loading.classList.remove('hidden');
    els.errorBanner.classList.add('hidden');
    const { res, body } = await api('/api/admin/orders');

    if (!res.ok) {
      els.loading.classList.add('hidden');
      banner('error', (body && body.error) || 'Could not load orders.');
      return;
    }

    const orders = body.orders || [];
    els.tbody.innerHTML = orders.length
      ? orders.map(o => {
        const p = PAYMENT_BADGE[o.payment_status] || ['bg-muted', o.payment_status || '—'];
        const st = ORDER_BADGE[o.order_status] || ['bg-muted', o.order_status];
        const refundable = o.order_status === 'paid';
        const methodLabel = o.payment_method === 'gift_card' ? 'Gift card'
          : o.payment_method === 'paypal' ? 'PayPal'
          : 'Card';
        return `<tr>
            <td><strong>${escapeHTML(o.order_number)}</strong></td>
            <td>${escapeHTML(o.customer_name || '')}<br><span class="muted">${escapeHTML(o.email)}</span></td>
            <td>${escapeHTML(o.tickets || '—')}</td>
            <td><strong>${money(o.total_cents)}</strong>${o.gift_card_cents ? `<br><span class="muted">gift card −${money(o.gift_card_cents)}</span>` : ''}
              <br><span class="muted">${escapeHTML(o.currency || '').toUpperCase()} · ${escapeHTML(methodLabel)}</span></td>
            <td>${badge(p[0], p[1])}</td>
            <td>${badge(st[0], st[1])}</td>
            <td class="nowrap">${fmtDate(o.created_at)}</td>
            <td class="mono">${escapeHTML(o.provider_payment_id || o.payment_intent_id || '—')}</td>
            <td>
              ${refundable ? `<button class="btn btn-secondary btn-sm refund-btn" data-order="${escapeHTML(o.order_number)}">Refund</button>` : ''}
            </td>
          </tr>`;
      }).join('')
      : '';

    els.empty.classList.toggle('hidden', orders.length > 0);
    els.loading.classList.add('hidden');
    els.tableWrap.classList.remove('hidden');
  }

  async function refund(orderNumber) {
    if (!window.confirm(`Refund order ${orderNumber}? The payment provider will be refunded and any gift card balance restored.`)) return;
    banner('success', '');
    const { res, body } = await api('/api/admin/orders/' + encodeURIComponent(orderNumber) + '/refund', { method: 'POST' });
    if (!res.ok) {
      banner('error', (body && body.error) || 'Refund failed.');
      return;
    }
    banner('success', `Order ${orderNumber} refunded.`);
    await loadOrders();
  }

  /* ---------- Gift card tab ---------- */

  async function loadGiftCards() {
    if (els.panelGiftcards.classList.contains('hidden')) return;
    els.loading.classList.remove('hidden');
    const { res, body } = await api('/api/admin/gift-cards');
    els.loading.classList.add('hidden');
    if (!res.ok) {
      banner('error', (body && body.error) || 'Could not load gift cards.');
      return;
    }

    const cards = body.giftCards || [];
    els.gcTbody.innerHTML = cards.length
      ? cards.map(g => {
        const available = g.available_cents;
        const active = Boolean(g.is_active);
        return `<tr>
            <td class="mono"><strong>${escapeHTML(g.code_masked)}</strong></td>
            <td>${money(g.original_value_cents)}</td>
            <td>${money(g.redeemed_cents)}</td>
            <td>${money(g.held_cents)}</td>
            <td><strong>${money(available)}</strong></td>
            <td>${active ? badge('bg-success', 'ACTIVE') : badge('bg-error', 'DISABLED')}</td>
            <td>${fmtDate(g.expires_at)}</td>
            <td class="nowrap">${fmtDate(g.created_at)}</td>
            <td>
              <button class="btn btn-secondary btn-sm gc-history-btn" data-id="${g.id}" data-code="${escapeHTML(g.code_masked)}">History</button>
              <button class="btn btn-ghost btn-sm gc-toggle-btn" data-id="${g.id}">${active ? 'Disable' : 'Enable'}</button>
            </td>
          </tr>`;
      }).join('')
      : '';

    els.gcEmpty.classList.toggle('hidden', cards.length > 0);
    els.gcTableWrap.classList.remove('hidden');
  }

  async function createGiftCards() {
    const valueCents = Math.round(Number(els.gcValue.value) * 100);
    const count = Math.max(1, Math.min(100, Math.round(Number(els.gcCount.value) || 1)));
    if (!Number.isFinite(valueCents) || valueCents <= 0) {
      banner('error', 'Enter a valid gift card value.');
      return;
    }
    banner('success', '');
    els.loading.classList.remove('hidden');
    const { res, body } = await api('/api/admin/gift-cards', {
      method: 'POST',
      body: JSON.stringify({ valueCents, count })
    });
    els.loading.classList.add('hidden');
    if (!res.ok) {
      banner('error', (body && body.error) || 'Could not create gift cards.');
      return;
    }
    els.gcCodeList.innerHTML = (body.codes || []).map(c => `<li class="mono">${escapeHTML(c)}</li>`).join('');
    els.gcResults.classList.remove('hidden');
    await loadGiftCards();
  }

  async function toggleGiftCard(id) {
    banner('success', '');
    const { res, body } = await api('/api/admin/gift-cards/' + id + '/toggle', { method: 'POST' });
    if (!res.ok) {
      banner('error', (body && body.error) || 'Could not update gift card.');
      return;
    }
    await loadGiftCards();
  }

  async function showHistory(id, code) {
    const { res, body } = await api('/api/admin/gift-cards/' + id + '/redemptions');
    if (!res.ok) {
      banner('error', (body && body.error) || 'Could not load redemption history.');
      return;
    }
    const rows = body.redemptions || [];
    els.gcHistoryTbody.innerHTML = rows.length
      ? rows.map(r => `
          <tr>
            <td class="mono">${escapeHTML(r.order_number || '—')}</td>
            <td>${money(r.amount_cents)}</td>
            <td>${badge('bg-muted', KIND_LABEL[r.kind] || r.kind)}</td>
            <td>${fmtDate(r.created_at)}</td>
          </tr>`).join('')
      : '<tr><td colspan="4" class="muted">No redemptions yet.</td></tr>';
    els.gcHistory.querySelector('h3').textContent = `Redemption history — ${code || ''}`;
    els.gcHistory.classList.remove('hidden');
  }

  /* ---------- Tabs ---------- */

  function switchTab(name) {
    els.tabBtns.forEach(b => b.classList.toggle('is-active', b.dataset.tab === name));
    els.panelOrders.classList.toggle('hidden', name !== 'orders');
    els.panelGiftcards.classList.toggle('hidden', name !== 'giftcards');
    if (name === 'orders') {
      els.gcHistory.classList.add('hidden');
      loadOrders();
    } else {
      loadGiftCards();
    }
  }

  /* ---------- Init ---------- */

  async function init() {
    const { authed, isAdmin } = await checkAuth();
    if (authed && isAdmin) {
      els.login.classList.add('hidden');
      els.logoutBtn.classList.remove('hidden');
      els.tabs.classList.remove('hidden');
      els.panelOrders.classList.remove('hidden');
      await loadOrders();
      return;
    }
    els.loading.classList.add('hidden');
    // not logged in or not admin -> show login
  }

  els.loginBtn.addEventListener('click', async () => {
    els.error.textContent = '';
    const { res } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: els.email.value.trim(), password: els.password.value })
    });
    if (!res.ok) {
      els.error.textContent = 'Invalid admin credentials.';
      return;
    }
    window.location.reload();
  });

  els.password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.loginBtn.click();
  });

  els.logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.reload();
  });

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  els.tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.refund-btn');
    if (btn) refund(btn.dataset.order);
  });

  els.gcCreateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    createGiftCards();
  });

  els.gcTbody.addEventListener('click', (e) => {
    const toggle = e.target.closest('.gc-toggle-btn');
    if (toggle) toggleGiftCard(toggle.dataset.id);
    const history = e.target.closest('.gc-history-btn');
    if (history) showHistory(history.dataset.id, history.dataset.code);
  });

  els.gcHistoryClose.addEventListener('click', () => {
    els.gcHistory.classList.add('hidden');
  });

  init();
})();