document.addEventListener('DOMContentLoaded', () => {
  const currentUser = 'Alex Johnson';
  const headerSearch = document.getElementById('header-search-input');
  if (headerSearch) {
    headerSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && headerSearch.value.trim()) {
        window.location.href = 'search.html?q=' + encodeURIComponent(headerSearch.value.trim());
      }
    });
  }

  const ticketsList = document.getElementById('tickets-list');
  const tabs = document.querySelectorAll('.tickets-tab');
  let currentTab = 'upcoming';

  function svgIcon(type) {
    const icons = {
      calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>',
      pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>',
      ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path><line x1="13" y1="5" x2="13" y2="7"></line><line x1="13" y1="11" x2="13" y2="13"></line><line x1="13" y1="17" x2="13" y2="19"></line></svg>',
      phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>',
      mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>'
    };
    return icons[type] || '';
  }

  function seatInfoHTML(ticket) {
    const parts = [
      { label: 'Section', value: ticket.section },
      { label: 'Row', value: ticket.row },
      { label: 'Seats', value: ticket.seats },
      { label: 'Qty', value: ticket.quantity }
    ];
    return parts.map(p => `
      <div class="seat-detail">
        <span class="label">${p.label}</span>
        <span class="value">${p.value}</span>
      </div>
    `).join('');
  }

  function deliveryHTML(ticket) {
    const icon = ticket.delivery === 'Mobile Entry' ? 'phone' : 'mail';
    const text = ticket.delivery === 'Mobile Entry'
      ? 'View on your phone at the venue'
      : 'E-Ticket ready to download';
    return `
      <div class="delivery-type">${svgIcon(icon)} ${ticket.delivery} &middot; ${text}</div>
    `;
  }

  function actionButtons(ticket, event) {
    return `
      <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); alert('Demo: Opening your digital ticket for ${event.name}')">View Ticket</button>
      <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); alert('Demo: Transfer initiated. Recipient will receive an email.')">Transfer</button>
      <a href="event.html?id=${ticket.eventId}" class="btn btn-ghost btn-sm" onclick="event.stopPropagation()">Event Details</a>
    `;
  }

  function upcomingTicketCard(ticket) {
    const event = getTicketEvent(ticket);
    return `
      <div class="ticket-card" style="cursor:pointer;" onclick="window.location.href='event.html?id=${event.id}'">
        <div class="ticket-card-image">
          <img src="${event.image}" alt="${event.name}" loading="lazy">
          <span class="status badge badge-onsale">Upcoming</span>
        </div>
        <div class="ticket-card-body">
          <h3>${event.name}</h3>
          <div class="ticket-card-meta">
            <span>${svgIcon('calendar')} ${event.date}</span>
            <span>${svgIcon('pin')} ${event.venue}, ${event.city}</span>
            <span>${svgIcon('ticket')} Order #${ticket.orderId}</span>
          </div>
          <div class="ticket-seat-info">
            ${seatInfoHTML(ticket)}
          </div>
          ${deliveryHTML(ticket)}
        </div>
        <div class="ticket-card-actions">
          ${actionButtons(ticket, event)}
        </div>
      </div>
    `;
  }

  function pastTicketCard(ticket) {
    const event = getTicketEvent(ticket);
    return `
      <div class="ticket-card is-past">
        <div class="ticket-card-image">
          <img src="${event.image}" alt="${event.name}" loading="lazy">
          <span class="status badge badge-sold-out">Attended</span>
        </div>
        <div class="ticket-card-body">
          <h3>${event.name}</h3>
          <div class="ticket-card-meta">
            <span>${svgIcon('calendar')} ${event.date} &middot; ${event.venue}</span>
          </div>
          <div class="ticket-seat-info">
            ${seatInfoHTML(ticket)}
          </div>
          <div class="delivery-type">Purchased ${ticket.boughtOn} &middot; $${ticket.price} each</div>
        </div>
        <div class="ticket-card-actions">
          <a href="event.html?id=${event.id}" class="btn btn-secondary btn-sm">Buy Again</a>
        </div>
      </div>
    `;
  }

  function sellingCard(ticket) {
    const event = getTicketEvent(ticket);
    return `
      <div class="ticket-card selling-card">
        <div style="display:flex;align-items:center;gap:var(--spacing-250);min-width:0;">
          <img src="${event.image}" alt="${event.name}" style="width:96px;height:72px;object-fit:cover;border-radius:var(--radius-sm);flex-shrink:0;" loading="lazy">
          <div class="selling-card-info" style="min-width:0;">
            <h3>${event.name}</h3>
            <p>${event.date} &middot; ${event.venue} &middot; ${ticket.section}, Row ${ticket.row}</p>
            <p style="margin-top:var(--spacing-50);"><strong>Listed at $${ticket.sellPrice}</strong> &middot; Order #${ticket.orderId}</p>
          </div>
        </div>
        <div class="selling-card-progress">
          <div class="progress-bar"><div style="width:${ticket.progress}%"></div></div>
          <span>${ticket.progress >= 100 ? 'Sold!' : `Watch activity - ${ticket.progress}% toward goal`}</span>
        </div>
        <div class="ticket-card-actions" style="border:none;padding:0;">
          <button class="btn btn-secondary btn-sm" onclick="alert('Demo: Editing your listing for ${event.name}')">Edit Listing</button>
          <button class="btn btn-ghost btn-sm" onclick="alert('Demo: Listing removed')">Remove</button>
        </div>
      </div>
    `;
  }

  function emptyState(tab) {
    const copy = {
      upcoming: 'No upcoming events',
      past: 'No past events',
      selling: 'No active listings'
    };
    const sub = {
      upcoming: 'When you purchase tickets, they\'ll appear here.',
      past: 'Tickets you\'ve attended will show up here.',
      selling: 'List tickets you\'ve bought to start selling.'
    };
    return `
      <div class="tickets-empty">
        ${svgIcon('ticket')}
        <h2>${copy[tab]}</h2>
        <p>${sub[tab]}</p>
        <a href="search.html" class="btn btn-primary">Browse Events</a>
      </div>
    `;
  }

  function render() {
    const tickets = getUserTickets(currentTab);

    document.querySelectorAll('.tickets-tab').forEach(t => {
      const count = getUserTickets(t.dataset.tab).length;
      const countEl = document.getElementById('count-' + t.dataset.tab);
      if (countEl) countEl.textContent = count;
    });

    if (tickets.length === 0) {
      ticketsList.innerHTML = emptyState(currentTab);
      return;
    }

    const renderers = {
      upcoming: upcomingTicketCard,
      past: pastTicketCard,
      selling: sellingCard
    };

    ticketsList.innerHTML = tickets.map(renderers[currentTab]).join('');

    if (currentTab === 'upcoming') {
      const total = tickets.reduce((sum, t) => sum + t.price * t.quantity, 0);
      const p = document.createElement('p');
      p.style.cssText = 'font-size:var(--font-size-350);color:var(--color-text-secondary);';
      p.innerHTML = `${tickets.length} upcoming event${tickets.length > 1 ? 's' : ''} &middot; ${tickets.reduce((s, t) => s + t.quantity, 0)} tickets &middot; Total paid: <strong>$${total.toLocaleString()}</strong>`;
      ticketsList.prepend(p);
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      render();
    });
  });

  render();

  document.querySelector('.tickets-header p').textContent =
    `Hi ${currentUser.split(' ')[0]}, manage your orders, view tickets, and track upcoming events`;
});