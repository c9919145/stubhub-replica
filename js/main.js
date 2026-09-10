document.addEventListener('DOMContentLoaded', () => {
  // ===== RENDER EVENT CARDS =====
  function createEventCard(event) {
    return `
      <a href="event.html?id=${event.id}" class="card">
        <div class="card-image">
          <img src="${event.image}" alt="${event.name}" loading="lazy">
          <div class="card-save" onclick="event.preventDefault(); event.stopPropagation();">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </div>
          ${event.category === 'sports' ? '<span class="card-badge badge badge-brand">Sports</span>' : ''}
          ${event.subcategory === 'Festival' ? '<span class="card-badge badge badge-accent">Festival</span>' : ''}
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

  // ===== POPULATE CAROUSELS =====
  function populateCarousel(containerId, events) {
    const container = document.getElementById(containerId);
    if (container) {
      container.innerHTML = events.map(createEventCard).join('');
    }
  }

  populateCarousel('trending-carousel', getTrendingEvents());
  populateCarousel('popular-carousel', getPopularEvents());
  populateCarousel('lastminute-carousel', getLastMinuteDeals());

  // ===== CAROUSEL NAVIGATION =====
  document.querySelectorAll('.carousel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const carouselId = btn.dataset.carousel;
      const track = document.getElementById(carouselId + '-carousel');
      if (!track) return;
      const scrollAmount = 280;
      if (btn.dataset.dir === 'next') {
        track.scrollBy({ left: scrollAmount, behavior: 'smooth' });
      } else {
        track.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
      }
    });
  });

  // ===== GENRE FILTER =====
  const genreFilter = document.querySelector('.genre-filter');
  if (genreFilter) {
    genreFilter.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;

      genreFilter.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const filter = pill.dataset.filter;
      const carousel = document.getElementById('trending-carousel');
      let events = getTrendingEvents();

      if (filter !== 'all') {
        if (filter === 'theater') {
          events = events.filter(e => e.category === 'theater' || e.category === 'comedy');
        } else {
          events = events.filter(e => e.category === filter);
        }
      }

      carousel.innerHTML = events.length > 0
        ? events.map(createEventCard).join('')
        : '<p style="padding:40px;color:var(--color-text-muted);">No events found for this category.</p>';
    });
  }

  // ===== MEGA MENU =====
  const navLinks = document.querySelectorAll('.nav-link[data-menu]');
  let activeMenu = null;
  let menuTimeout = null;

  navLinks.forEach(link => {
    link.addEventListener('mouseenter', () => {
      clearTimeout(menuTimeout);
      const menuId = 'mega-menu-' + link.dataset.menu;
      const menu = document.getElementById(menuId);

      if (activeMenu && activeMenu !== menu) {
        activeMenu.classList.remove('active');
      }

      if (menu) {
        menu.classList.add('active');
        activeMenu = menu;
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
      }
    });

    link.addEventListener('mouseleave', () => {
      menuTimeout = setTimeout(() => {
        if (activeMenu) {
          activeMenu.classList.remove('active');
          activeMenu = null;
        }
        navLinks.forEach(l => l.classList.remove('active'));
      }, 200);
    });
  });

  const megaMenus = document.querySelectorAll('.mega-menu');
  megaMenus.forEach(menu => {
    menu.addEventListener('mouseenter', () => {
      clearTimeout(menuTimeout);
    });
    menu.addEventListener('mouseleave', () => {
      menuTimeout = setTimeout(() => {
        menu.classList.remove('active');
        activeMenu = null;
        navLinks.forEach(l => l.classList.remove('active'));
      }, 200);
    });
  });

  // Close mega menu on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.header-nav')) {
      megaMenus.forEach(m => m.classList.remove('active'));
      navLinks.forEach(l => l.classList.remove('active'));
    }
  });

  // ===== FAQ ACCORDION =====
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const wasActive = item.classList.contains('active');

      document.querySelectorAll('.faq-item.active').forEach(i => i.classList.remove('active'));

      if (!wasActive) {
        item.classList.add('active');
      }
    });
  });

  // ===== SEARCH =====
  function handleSearch(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        window.location.href = 'search.html?q=' + encodeURIComponent(input.value.trim());
      }
    });
  }

  handleSearch('header-search-input');
  handleSearch('hero-search-input');

  // ===== POPULATE CATEGORIES GRID =====
  const categoriesGrid = document.getElementById('categories-grid');
  if (categoriesGrid) {
    categoriesGrid.innerHTML = Object.entries(CATEGORIES).map(([key, cat]) => `
      <div class="category-card">
        <div class="category-card-bg" style="background-image: url('${cat.image}')"></div>
        <div class="category-card-overlay"></div>
        <div class="category-card-content">
          <h3>${cat.name}</h3>
          <ul>
            ${cat.subcategories.map(sub => `<li><a href="${sub.url}">${sub.name}</a></li>`).join('')}
          </ul>
        </div>
      </div>
    `).join('');
  }

  // ===== POPULATE COUNTRIES =====
  const countriesList = document.getElementById('countries-list');
  if (countriesList) {
    countriesList.innerHTML = COUNTRIES.map(c => `<a href="#">${c}</a>`).join('');
  }

  // ===== HEADER SCROLL EFFECT =====
  let lastScrollY = 0;
  const header = document.getElementById('header');

  window.addEventListener('scroll', () => {
    const currentScrollY = window.scrollY;
    if (currentScrollY > 100) {
      header.style.boxShadow = 'var(--shadow-300)';
    } else {
      header.style.boxShadow = 'none';
    }
    lastScrollY = currentScrollY;
  }, { passive: true });
});
