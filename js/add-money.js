(() => {
  'use strict';

  const els = {
    form: document.getElementById('addmoney-form'),
    error: document.getElementById('am-error'),
    presets: Array.from(document.querySelectorAll('.amount-preset')),
    amount: document.getElementById('amount'),
    depositBtn: document.getElementById('deposit-btn'),
    pending: document.getElementById('am-pending'),
    pendingMsg: document.getElementById('am-pending-msg'),
    network: document.getElementById('am-network'),
    address: document.getElementById('am-address'),
    qr: document.getElementById('am-qr'),
    ref: document.getElementById('am-ref'),
    copyBtn: document.getElementById('copy-am-address')
  };

  let selectedMethod = 'card';

  function money(cents) {
    return '$' + (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function showError(msg) {
    els.error.textContent = msg || '';
    els.error.classList.toggle('hidden', !msg);
  }

  function setBusy(busy) {
    els.depositBtn.disabled = busy;
    els.depositBtn.textContent = busy ? 'Creating deposit…' : 'Continue';
  }

  els.presets.forEach(p => {
    p.addEventListener('click', () => {
      els.presets.forEach(x => x.classList.remove('is-active'));
      p.classList.add('is-active');
      els.amount.value = p.dataset.amount;
    });
  });

  document.querySelectorAll('input[name="deposit-method"]').forEach(r => {
    r.addEventListener('change', () => { selectedMethod = r.value; showError(''); });
  });

  async function api(url, options) {
    const res = await fetch(apiUrl(url), {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    return { res, body };
  }

  els.depositBtn.addEventListener('click', async () => {
    showError('');
    const amt = Math.round(Number(els.amount.value));
    if (!Number.isFinite(amt) || amt < 1 || amt > 50000) {
      showError('Enter an amount between $1.00 and $50,000.00.');
      els.amount.focus();
      return;
    }
    const amountCents = amt * 100;
    setBusy(true);

    const { res, body } = await api('/api/wallet/deposits', {
      method: 'POST',
      body: JSON.stringify({ amountCents, method: selectedMethod })
    });

    if (res.status === 401) {
      showError('Please sign in from My Account to add money.');
      setBusy(false);
      return;
    }
    if (res.status === 409 && body && body.code === 'METHOD_UNAVAILABLE') {
      showError(body.error || 'This payment method is currently unavailable.');
      setBusy(false);
      return;
    }
    if (!res.ok) {
      showError((body && body.error) || 'Could not start the deposit. Please try again.');
      setBusy(false);
      return;
    }

    if (body.status === 'pending' && body.checkoutUrl) {
      window.location.href = body.checkoutUrl;
      return;
    }

    if (body.payment) {
      const p = body.payment;
      els.pendingMsg.textContent = `Deposit of ${money(amountCents)} via ${selectedMethod.toUpperCase()} is PENDING.`;
      els.network.textContent = p.network || '';
      els.address.textContent = p.address || '';
      els.qr.src = p.qrImage || '';
      els.qr.alt = p.network ? `QR code for the ${p.network} address` : 'QR code';
      els.ref.textContent = body.txnId || '';
      els.form.classList.add('hidden');
      els.pending.classList.remove('hidden');
      setBusy(false);
    }
  });

  els.copyBtn.addEventListener('click', async () => {
    const addr = (els.address.textContent || '').trim();
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      els.copyBtn.textContent = 'Copied';
      setTimeout(() => { els.copyBtn.textContent = 'Copy'; }, 1500);
    } catch (e) { /* clipboard unavailable */ }
  });
})();