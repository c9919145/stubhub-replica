document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const eventId = urlParams.get('id') || 1;
  const event = resolveEvent(eventId);

  if (!event) {
    document.querySelector('.event-page .container').innerHTML = `
      <div style="text-align:center;padding:80px 0;">
        <h1 style="font-size:24px;margin-bottom:16px;">Event not found</h1>
        <p style="color:var(--color-text-secondary);margin-bottom:24px;">The event you're looking for doesn't exist or has been removed.</p>
        <a href="index.html" class="btn btn-primary">Back to Home</a>
      </div>
    `;
    return;
  }

  // Populate event info
  document.title = `${event.name} - StubHub`;
  document.getElementById('event-image').src = event.image;
  document.getElementById('event-image').alt = event.name;
  document.getElementById('event-name').textContent = event.name;
  document.getElementById('buy-tickets-btn').href = `checkout.html?event=${event.id}`;
  document.getElementById('event-date').textContent = event.date;
  document.getElementById('event-venue').textContent = event.venue;
  document.getElementById('event-city').textContent = event.city;
  document.getElementById('venue-address').textContent = `${event.venue}, ${event.city}`;

  // Generate ticket listings
  const listings = generateTicketListings(event);
  const ticketTbody = document.getElementById('ticket-tbody');
  let currentListings = [...listings];

  function renderListings(filtered) {
    ticketTbody.innerHTML = filtered.slice(0, 30).map(listing => `
      <tr>
        <td><strong>${listing.section}</strong></td>
        <td>Row ${listing.row}</td>
        <td>${listing.seats}</td>
        <td>${listing.quantity}</td>
        <td>${listing.type}</td>
        <td class="price">$${listing.price}</td>
        <td><a class="btn btn-primary btn-sm" href="checkout.html?event=${event.id}">Buy Tickets</a></td>
      </tr>
    `).join('');
  }

  renderListings(currentListings);

  // Section filter
  document.querySelector('.ticket-filters').addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;

    document.querySelectorAll('.ticket-filters .pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');

    const section = pill.dataset.section;
    if (section === 'all') {
      currentListings = [...listings];
    } else {
      currentListings = listings.filter(l => l.section === section);
    }
    renderListings(currentListings);
  });

  // Similar events
  const similarEvents = EVENTS.filter(e => e.category === event.category && e.id !== event.id).slice(0, 6);
  const similarCarousel = document.getElementById('similar-events-carousel');
  if (similarCarousel) {
    similarCarousel.innerHTML = similarEvents.map(e => `
      <a href="event.html?id=${e.id}" class="card" style="min-width:260px;max-width:260px;flex-shrink:0;">
        <div class="card-image">
          <img src="${e.image}" alt="${e.name}" loading="lazy">
        </div>
        <div class="card-body">
          <div class="card-title">${e.name}</div>
          <div class="card-date">${e.date}</div>
          <div class="card-venue">${e.venue}, ${e.city}</div>
          <div class="card-price">From $${e.price} <span>USD</span></div>
        </div>
      </a>
    `).join('');
  }

  // Seat map section click
  document.querySelectorAll('.seat-map-section').forEach(section => {
    section.addEventListener('click', () => {
      const sectionName = section.textContent.trim();
      document.querySelectorAll('.ticket-filters .pill').forEach(p => {
        p.classList.toggle('active', p.dataset.section === sectionName);
      });
      currentListings = listings.filter(l => l.section === sectionName);
      renderListings(currentListings);
      document.getElementById('tickets-section').scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Search in header
  const searchInput = document.getElementById('header-search-input');
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchInput.value.trim()) {
        window.location.href = 'search.html?q=' + encodeURIComponent(searchInput.value.trim());
      }
    });
  }

  // Demo toasts for Sell / Share
  function demoToast(message) {
    let toast = document.getElementById('demo-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'demo-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--color-neutral-13);color:#fff;padding:12px 20px;border-radius:var(--radius-pill);font-size:14px;font-weight:500;z-index:9999;box-shadow:var(--shadow-500);opacity:0;transition:opacity .25s ease;';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2600);
  }

  document.getElementById('sell-btn').addEventListener('click', () => {
    demoToast('Selling is a demo in this replica. Head to My Tickets to manage listings.');
  });
  document.getElementById('share-btn').addEventListener('click', () => {
    demoToast('Link copied — share this event with friends!');
  });
});
