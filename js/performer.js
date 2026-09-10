document.addEventListener('DOMContentLoaded', () => {
  const NEAR_CITY = { city: "Fort Worth", state: "TX" };
  const NEAR_RADIUS_MILES = 100;

  const RELATED_PERFORMERS = [
    { name: "Kevin Hart", tag: "Comedian", image: "https://picsum.photos/seed/kevinhart/240/240" },
    { name: "Bert Kreischer", tag: "Comedian", image: "https://picsum.photos/seed/bertk/240/240" },
    { name: "Sebastian Maniscalco", tag: "Comedian", image: "https://picsum.photos/seed/sebastian/240/240" },
    { name: "Tom Segura", tag: "Comedian", image: "https://picsum.photos/seed/tomsegura/240/240" },
    { name: "Gabriel Iglesias", tag: "Comedian", image: "https://picsum.photos/seed/gabriel/240/240" },
    { name: "Jo Koy", tag: "Comedian", image: "https://picsum.photos/seed/jokoy/240/240" },
    { name: "Chris Rock", tag: "Comedian", image: "https://picsum.photos/seed/chrisrock/240/240" },
    { name: "Theo Von", tag: "Comedian", image: "https://picsum.photos/seed/theovon/240/240" }
  ];

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let visibleCount = 6;
  let pageSize = 6;
  let selectedDate = 'all';
  let selectedLocation = 'all';

  function parseDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const inDays = Math.round((d - today) / 86400000);
    return {
      d,
      month: MONTHS[d.getMonth()],
      monthNum: d.getMonth(),
      day: d.getDate(),
      dayName: DAYS[d.getDay()],
      year: d.getFullYear(),
      fullName: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
      inDays
    };
  }

  function inDateRange(event) {
    if (selectedDate === 'all') return true;
    const { inDays, monthNum } = parseDate(event.date);
    switch (selectedDate) {
      case 'this-week': return inDays >= 0 && inDays <= 7;
      case 'this-month': return inDays >= 0 && monthNum === new Date().getMonth();
      case 'next-month': return monthNum === (new Date().getMonth() + 1) % 12;
      default: return true;
    }
  }

  function cityKey(event) {
    return event.city + ', ' + event.state;
  }

  function isNear(event) {
    if (!event.distance) return false;
    return event.distance <= NEAR_RADIUS_MILES;
  }

  function filterEvents(list) {
    return list.filter(e => inDateRange(e) && (selectedLocation === 'all' || cityKey(e) === selectedLocation));
  }

  function buildLocations() {
    const seen = {};
    MATT_RIFE_EVENTS.forEach(e => {
      const key = cityKey(e);
      if (!seen[key]) seen[key] = { city: e.city, state: e.state, count: 0 };
      seen[key].count++;
    });
    return Object.values(seen).sort((a, b) => b.count - a.count);
  }

  function eventRowHTML(event) {
    const { month, day } = parseDate(event.date);
    const priceHTML = event.soldOut
      ? '<span class="badge badge-sold-out">Sold out</span>'
      : `<div class="event-row-price"><span class="from">From</span> $${event.fromPrice}</div>`;
    const distanceHTML = event.distance
      ? `<span class="distance"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${event.distance} mi</span>`
      : '';
    return `
      <div class="event-row" onclick="window.location.href='event.html?id=${event.id}'">
        <div class="event-row-date">
          <span class="day">${day}</span>
          <span class="month">${month}</span>
        </div>
        <div class="event-row-info">
          <h3>${event.name}</h3>
          <div class="event-row-venue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            ${event.venue} &middot; ${event.city}, ${event.state}
          </div>
          <div class="event-row-meta">
            ${distanceHTML}
            <span>${event.time}</span>
          </div>
        </div>
        <div class="event-row-cta">
          <div>${priceHTML}</div>
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); window.location.href='event.html?id=${event.id}'">See tickets</button>
        </div>
      </div>
    `;
  }

  function buildCityLinks() {
    const grid = document.getElementById('city-links-grid');
    const locations = buildLocations();
    grid.innerHTML = locations.map(loc => `
      <div class="city-link" onclick="applyLocationFilter('${loc.city}, ${loc.state}', '${loc.city}')">
        <span class="city-name">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${loc.city}, ${loc.state}
        </span>
        <span class="city-count">${loc.count} event${loc.count !== 1 ? 's' : ''}</span>
      </div>
    `).join('');
  }

  function buildLocationFilterOptions() {
    const container = document.getElementById('location-options');
    const locations = buildLocations();
    container.innerHTML = `
      <div class="filter-option ${selectedLocation === 'all' ? 'active' : ''}" data-loc="all">
        All locations <span class="option-count">${MATT_RIFE_EVENTS.length}</span>
      </div>
      ${locations.map(loc => `
        <div class="filter-option ${selectedLocation === loc.city + ', ' + loc.state ? 'active' : ''}" data-loc="${loc.city}, ${loc.state}">
          ${loc.city}, ${loc.state} <span class="option-count">${loc.count}</span>
        </div>
      `).join('')}
    `;
    container.querySelectorAll('.filter-option').forEach(opt => {
      opt.addEventListener('click', () => {
        container.querySelectorAll('.filter-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        selectedLocation = opt.dataset.loc;
      });
    });
  }

  function buildDateFilterOptions() {
    document.getElementById('date-options').querySelectorAll('.filter-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.getElementById('date-options').querySelectorAll('.filter-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        selectedDate = opt.dataset.date;
      });
    });
  }

  function renderAll() {
    const nearEvents = filterEvents(MATT_RIFE_EVENTS.filter(isNear));
    const otherEvents = filterEvents(MATT_RIFE_EVENTS.filter(e => !isNear(e)));

    document.getElementById('near-events-list').innerHTML = nearEvents.length
      ? nearEvents.map(eventRowHTML).join('')
      : '<div class="tickets-empty" style="padding:60px 0;"><h2>No events near you</h2><p>Adjust filters or view all Matt Rife event locations.</p></div>';

    const shown = otherEvents.slice(0, visibleCount);
    const remaining = otherEvents.length - shown.length;
    document.getElementById('all-events-list').innerHTML = shown.map(eventRowHTML).join('');

    const seeMore = document.getElementById('see-more-btn');
    if (remaining > 0) {
      seeMore.style.display = 'flex';
      seeMore.innerHTML = `See more (${remaining} remaining)
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    } else {
      seeMore.style.display = 'none';
    }

    const nearTotal = MATT_RIFE_EVENTS.filter(isNear).length;
    document.getElementById('near-count-text').textContent = `Near ${NEAR_CITY.city}, ${NEAR_CITY.state}`;
    document.getElementById('other-count-text').textContent =
      `${MATT_RIFE_EVENTS.length - nearTotal} events in other locations · ${MATT_RIFE_EVENTS.length} total`;

    const totalShown = nearEvents.length + shown.length;
    const filteredTotal = filterEvents(MATT_RIFE_EVENTS).length;
    document.getElementById('event-count-label').innerHTML = filteredTotal > 0
      ? `<strong>${filteredTotal}</strong> event${filteredTotal !== 1 ? 's' : ''} found`
      : `<strong>0</strong> events found`;
  }

  function renderRelatedPerformers() {
    const track = document.getElementById('related-performers-track');
    track.innerHTML = RELATED_PERFORMERS.map(p => `
      <div class="related-performer-card" onclick="showFollowToast('${p.name}')">
        <div class="rp-avatar">
          <img src="${p.image}" alt="${p.name}" loading="lazy">
        </div>
        <div class="rp-body">
          <h4>${p.name}</h4>
          <span class="rp-tag">${p.tag}</span>
          <button class="btn btn-secondary btn-sm rp-follow" onclick="event.stopPropagation(); showFollowToast('${p.name}')">Follow</button>
        </div>
      </div>
    `).join('');
  }

  // Expose to inline handlers
  window.applyLocationFilter = (loc, cityName) => {
    selectedLocation = loc;
    const opts = document.getElementById('location-options');
    if (opts) {
      opts.querySelectorAll('.filter-option').forEach(o => o.classList.toggle('active', o.dataset.loc === loc));
    }
    closePanels();
    renderAll();
  };

  // Filter dropdowns
  const dateFilter = document.getElementById('date-filter');
  const locationFilter = document.getElementById('location-filter');

  document.getElementById('date-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    closePanels();
    document.getElementById('date-panel').classList.add('open');
    e.currentTarget.classList.add('active');
  });

  document.getElementById('location-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    closePanels();
    document.getElementById('location-panel').classList.add('open');
    e.currentTarget.classList.add('active');
  });

  document.getElementById('date-apply').addEventListener('click', () => { closePanels(); renderAll(); });
  document.getElementById('date-clear').addEventListener('click', () => {
    selectedDate = 'all';
    document.getElementById('date-options').querySelectorAll('.filter-option').forEach(o => o.classList.toggle('active', o.dataset.date === 'all'));
    renderAll();
  });

  document.getElementById('location-apply').addEventListener('click', () => { closePanels(); renderAll(); });
  document.getElementById('location-clear').addEventListener('click', () => {
    selectedLocation = 'all';
    buildLocationFilterOptions();
    renderAll();
  });

  document.addEventListener('click', () => closePanels());

  function closePanels() {
    document.querySelectorAll('.filter-panel').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.filter-trigger').forEach(t => t.classList.remove('active'));
  }

  // See more
  document.getElementById('see-more-btn').addEventListener('click', () => {
    visibleCount += pageSize;
    renderAll();
  });

  // Toasts
  window.showFavoritesToast = () => showToast('Added Matt Rife to your favorites');
  window.showShareToast = () => showToast('Link copied — share Matt Rife tickets with friends!');
  window.showLocationToast = () => showToast('Location selector is a demo in this replica.');
  window.showFollowToast = (name) => showToast(`You are now following ${name}`);

  function showToast(message) {
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

  // Header search
  const searchInput = document.getElementById('header-search-input');
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) {
      window.location.href = 'search.html?q=' + encodeURIComponent(searchInput.value.trim());
    }
  });

  // Init
  buildLocationFilterOptions();
  buildDateFilterOptions();
  renderRelatedPerformers();
  renderAll();
  buildCityLinks();
});