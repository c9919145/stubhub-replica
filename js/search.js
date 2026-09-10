document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const query = urlParams.get('q') || '';

  const searchInput = document.getElementById('header-search-input');
  if (searchInput) searchInput.value = query;

  const titleEl = document.getElementById('search-title');
  const subtitleEl = document.getElementById('search-subtitle');
  const resultsGrid = document.getElementById('results-grid');
  const noResults = document.getElementById('no-results');
  const resultsCount = document.getElementById('results-count');
  const paginationEl = document.getElementById('pagination');
  const artistNetworkEl = document.getElementById('artist-network');

  const PAGE_SIZE = 12;
  let allResults = [];
  let currentPage = 1;

  function parseSortDate(event) {
    const d = new Date(event.date);
    return isNaN(d.getTime()) ? null : d;
  }

  function matchesDateFilter(event) {
    const checked = Array.from(document.querySelectorAll('.date-filter:checked')).map(cb => cb.value);
    if (checked.length === 0) return true;

    const d = new Date(event.date);
    if (isNaN(d.getTime())) return true;

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - now) / 86400000);
    const monthDiff = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());

    return checked.some(f => {
      switch (f) {
        case 'today': return diffDays === 0;
        case 'this-week': return diffDays >= 0 && diffDays < 7;
        case 'this-month': return monthDiff === 0;
        case 'next-month': return monthDiff === 1;
        default: return true;
      }
    });
  }

  function createEventCard(event) {
    return `
      <a href="event.html?id=${event.id}" class="card">
        <div class="card-image">
          <img src="${event.image}" alt="${event.name}" loading="lazy">
          <div class="card-save" onclick="event.preventDefault(); event.stopPropagation();">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </div>
          ${event.soldOut ? '<span class="card-badge badge badge-sold-out">Sold out</span>' : ''}
        </div>
        <div class="card-body">
          <div class="card-title">${event.name}</div>
          <div class="card-date">${event.date}</div>
          <div class="card-venue">${event.venue}, ${event.city}</div>
          <div class="card-price">From $${event.price} <span>USD</span></div>
        </div>
      </a>
    `;
  }

  function renderArtistNetwork(events) {
    if (!artistNetworkEl) return;
    if (!query || events.length === 0) {
      artistNetworkEl.classList.add('hidden');
      return;
    }
    const artist = findArtistNetwork(query);
    if (!artist) {
      artistNetworkEl.classList.add('hidden');
      return;
    }
    artistNetworkEl.classList.remove('hidden');
    artistNetworkEl.innerHTML = `
      <a href="${artist.href}" class="artist-network-card">
        <img src="${artist.image}" alt="${artist.name}">
        <div class="artist-network-info">
          <span class="badge badge-accent">Artist Network</span>
          <h3>${artist.name}</h3>
          <p>${artist.description} · ${artist.eventCount} event dates</p>
        </div>
        <span class="artist-network-arrow">View all dates
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </span>
      </a>
    `;
  }

  function renderPagination(totalPages) {
    if (totalPages <= 1) {
      paginationEl.innerHTML = '';
      return;
    }

    const buttons = [];
    if (currentPage > 1) {
      buttons.push(`<button class="page-btn nav" data-page="${currentPage - 1}" aria-label="Previous page">&lsaquo;</button>`);
    }
    for (let p = 1; p <= totalPages; p++) {
      buttons.push(`<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`);
    }
    if (currentPage < totalPages) {
      buttons.push(`<button class="page-btn nav" data-page="${currentPage + 1}" aria-label="Next page">&rsaquo;</button>`);
    }
    paginationEl.innerHTML = buttons.join('');

    paginationEl.querySelectorAll('.page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPage = parseInt(btn.dataset.page);
        renderResults(allResults);
        document.querySelector('.results-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function renderResults(events) {
    allResults = events;

    if (events.length === 0) {
      resultsGrid.classList.add('hidden');
      noResults.classList.remove('hidden');
      resultsCount.textContent = '0 results';
      paginationEl.innerHTML = '';
      renderArtistNetwork(events);
      return;
    }

    resultsGrid.classList.remove('hidden');
    noResults.classList.add('hidden');
    resultsCount.textContent = `${events.length} result${events.length !== 1 ? 's' : ''}`;

    const totalPages = Math.ceil(events.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageEvents = events.slice(start, start + PAGE_SIZE);
    resultsGrid.innerHTML = pageEvents.map(createEventCard).join('');

    renderArtistNetwork(events);
    renderPagination(totalPages);
  }

  function applyFilters() {
    let results = query ? searchEvents(query) : [...EVENTS];

    const checkedCategories = Array.from(document.querySelectorAll('.filter-checkbox:checked')).map(cb => cb.value);
    if (checkedCategories.length > 0) {
      results = results.filter(e => checkedCategories.includes(e.category));
    }

    results = results.filter(matchesDateFilter);

    const minPrice = document.getElementById('price-min').value;
    const maxPrice = document.getElementById('price-max').value;
    if (minPrice) results = results.filter(e => e.price >= parseInt(minPrice));
    if (maxPrice) results = results.filter(e => e.price <= parseInt(maxPrice));

    const sortBy = document.getElementById('sort-select').value;
    switch (sortBy) {
      case 'price-low': results.sort((a, b) => a.price - b.price); break;
      case 'price-high': results.sort((a, b) => b.price - a.price); break;
      case 'date':
        results.sort((a, b) => {
          const da = parseSortDate(a);
          const db = parseSortDate(b);
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return da - db;
        });
        break;
      default: break;
    }

    currentPage = 1;
    renderResults(results);
  }

  // Initial render
  if (query) {
    titleEl.textContent = `Results for "${query}"`;
    subtitleEl.textContent = `Showing events matching your search`;
  } else {
    titleEl.textContent = 'All Events';
    subtitleEl.textContent = 'Browse all available events';
  }

  applyFilters();

  // Filter event listeners
  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', applyFilters);
  });

  document.querySelectorAll('.date-filter').forEach(cb => {
    cb.addEventListener('change', applyFilters);
  });

  document.getElementById('price-min').addEventListener('input', debounce(applyFilters, 300));
  document.getElementById('price-max').addEventListener('input', debounce(applyFilters, 300));
  document.getElementById('sort-select').addEventListener('change', applyFilters);

  window.resetFilters = () => {
    document.querySelectorAll('.filter-checkbox, .date-filter').forEach(cb => { cb.checked = false; });
    document.getElementById('price-min').value = '';
    document.getElementById('price-max').value = '';
    document.getElementById('sort-select').value = 'relevance';
    applyFilters();
  };

  // View toggle
  const gridView = document.getElementById('grid-view');
  const listView = document.getElementById('list-view');

  gridView.addEventListener('click', () => {
    resultsGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    gridView.classList.add('active');
    listView.classList.remove('active');
  });

  listView.addEventListener('click', () => {
    resultsGrid.style.gridTemplateColumns = '1fr';
    listView.classList.add('active');
    gridView.classList.remove('active');
  });

  // Search header
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) {
      window.location.href = 'search.html?q=' + encodeURIComponent(searchInput.value.trim());
    }
  });

  function debounce(fn, delay) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), delay);
    };
  }
});
