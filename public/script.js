// Global state
let currentPage = 1;
let currentCat = 'all';
let currentSort = 'recent';
let isLoading = false;
let totalCardsRendered = 0;

const grid = document.getElementById('wallGrid');
const loadMoreBtn = document.getElementById('loadMoreBtn');

async function loadWallpapers(reset = false) {
  if (isLoading) return;
  isLoading = true;
  if (reset) {
    currentPage = 1;
    totalCardsRendered = 0;
    grid.innerHTML = '';
  }
  const params = new URLSearchParams({
    page: currentPage,
    sort: currentSort,
  });
  if (currentCat !== 'all') params.append('cat', currentCat);
  const res = await fetch(`/api/wallpapers?${params}`);
  const data = await res.json();
  if (data.items.length === 0) {
    loadMoreBtn.style.display = 'none';
    isLoading = false;
    return;
  }
  renderCards(data.items, reset);
  currentPage++;
  loadMoreBtn.style.display = data.hasMore ? 'block' : 'none';
  isLoading = false;
}

function renderCards(wallpapers, isFirstPage = false) {
  for (const w of wallpapers) {
    const resolutionClass = w.original_width >= 7680 ? 'badge-8k' :
                            w.original_width >= 3840 ? 'badge-4k' :
                            w.original_width >= 2560 ? 'badge-2k' : 'badge-1080p';
    const resolutionLabel = resolutionClass.split('-')[1].toUpperCase();
    const html = `
      <a href="/wallpaper.html?slug=${w.slug}" class="wall-item-link">
        <div class="wall-item">
          <img class="wall-img" src="/api/download/${w.id}/4k" loading="lazy" alt="${escapeHtml(w.title)}">
          <div class="wall-badge ${resolutionClass}">${resolutionLabel}</div>
          <div class="wall-overlay">
            <div class="wall-title-ov">${escapeHtml(w.title)}</div>
            <div class="wall-meta-ov">⬇ ${w.download_count}</div>
          </div>
        </div>
      </a>
    `;
    grid.insertAdjacentHTML('beforeend', html);
    totalCardsRendered++;
    // Inject in‑grid ad after every 8th card on first page only
    if (isFirstPage && totalCardsRendered % 8 === 0 && totalCardsRendered !== 0) {
      const adId = `grid-ad-${totalCardsRendered}`;
      const adDiv = document.createElement('div');
      adDiv.className = 'ad-break';
      adDiv.id = adId;
      grid.appendChild(adDiv);
      if (window.insertAd) {
        window.insertAd(adId, 'YOUR_INFEED_AD_SLOT', 'rectangle');
      }
    }
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

// Filter tabs
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentSort = tab.dataset.sort;
    loadWallpapers(true);
  });
});

// Category navigation (populated from API)
async function loadCategories() {
  const res = await fetch('/api/categories');
  const cats = await res.json();
  const container = document.getElementById('navCats');
  if (!container) return;
  container.innerHTML = `<span class="nav-cat active" data-cat="all">All</span>`;
  for (const cat of cats) {
    if (cat.parent_id === 0) {
      const catEl = document.createElement('span');
      catEl.className = 'nav-cat';
      catEl.dataset.cat = cat.slug;
      catEl.textContent = cat.name;
      catEl.addEventListener('click', () => {
        document.querySelectorAll('.nav-cat').forEach(c => c.classList.remove('active'));
        catEl.classList.add('active');
        currentCat = cat.slug;
        loadWallpapers(true);
      });
      container.appendChild(catEl);
    }
  }
}
loadCategories();

// Load more button
if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => loadWallpapers(false));

// Initial load
loadWallpapers(true);