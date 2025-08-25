// Video metadata
const VIDEO_DATA = [
  { id: 'v01', title: 'World Cup Qualifiers Deep Tactical Analysis', views: 1.2, age: '3 days', dur: '12:24', tags: ['Sports','Analysis'], quality: ['1080p','720p','480p'] },
  { id: 'v02', title: 'Perfect Persian Saffron Rice - Masterclass', views: 2.8, age: '1 day', dur: '08:41', tags: ['Cooking','Culture'], quality: ['4K','1080p','720p'] },
  { id: 'v03', title: 'Top 10 Coding Interview Tips in 2025', views: 0.9, age: '5 days', dur: '14:03', tags: ['Tech','Career'], quality: ['1080p','720p'] },
  { id: 'v04', title: 'Space Telescope Discovers New Exoplanet', views: 3.4, age: '7 hours', dur: '06:55', tags: ['Science','Space'], quality: ['4K','1080p','720p'] },
  { id: 'v05', title: 'Mountain Biking Rugged Desert Trails POV', views: 1.1, age: '2 days', dur: '10:18', tags: ['Adventure'], quality: ['1080p','720p'] },
  { id: 'v06', title: 'Urban Night Timelapse 4K Compilation', views: 5.6, age: '12 hours', dur: '04:58', tags: ['Travel','4K'], quality: ['4K','1080p'] },
  { id: 'v07', title: 'Beginner 20 Min Yoga Flow Routine', views: 0.7, age: '4 days', dur: '20:10', tags: ['Health','Wellness'], quality: ['1080p','720p','480p'] },
  { id: 'v08', title: 'Retro Gaming Hidden Gems (1990-95)', views: 1.9, age: '6 days', dur: '18:40', tags: ['Gaming','Retro'], quality: ['1080p','720p'] },
  { id: 'v09', title: 'Fastest Street Foods from 7 Countries', views: 4.3, age: '9 hours', dur: '11:37', tags: ['Food','Travel'], quality: ['4K','1080p'] },
  { id: 'v10', title: 'Architectural Wonders: Concrete & Light', views: 0.5, age: '8 days', dur: '09:13', tags: ['Design','Architecture'], quality: ['1080p','720p'] },
  { id: 'v11', title: 'Wildlife Safari Highlights Africa', views: 2.1, age: '2 days', dur: '13:07', tags: ['Wildlife','Nature'], quality: ['4K','1080p','720p'] },
  { id: 'v12', title: 'LoFi Chill Beats Focus Mix (No Ads)', views: 8.2, age: '16 hours', dur: '59:59', tags: ['Music','LoFi'], quality: ['1080p','720p'] },
  { id: 'v13', title: 'Building a Personal Productivity System', views: 0.4, age: '3 days', dur: '16:22', tags: ['Productivity'], quality: ['1080p','720p'] },
  { id: 'v14', title: 'Secure Coding: OWASP Top 10 Visual Guide', views: 0.6, age: '11 days', dur: '21:44', tags: ['Security','Tech'], quality: ['1080p','720p'] },
  { id: 'v15', title: 'Northern Lights Real-Time Capture 4K', views: 6.7, age: '5 hours', dur: '07:08', tags: ['Nature','4K'], quality: ['4K','1080p'] },
  { id: 'v16', title: 'Deep Sea Creatures Documentary', views: 3.8, age: '18 hours', dur: '24:10', tags: ['Documentary','Science'], quality: ['1080p','720p'] },
  { id: 'v17', title: 'FPV Drone Racing Championship Finals', views: 2.9, age: '1 day', dur: '15:17', tags: ['Drone','Sports'], quality: ['4K','1080p','720p'] },
  { id: 'v18', title: 'Indie Game Dev Log #12 Optimization', views: 0.3, age: '6 days', dur: '11:28', tags: ['DevLog','Gaming'], quality: ['1080p','720p'] },
  { id: 'v19', title: 'Sustainable Tiny House Interior Tour', views: 1.0, age: '3 days', dur: '08:06', tags: ['Lifestyle','Design'], quality: ['1080p','720p'] },
  { id: 'v20', title: 'Coffee Science: Extraction Variables', views: 0.8, age: '2 days', dur: '09:42', tags: ['Coffee','Science'], quality: ['1080p','720p'] },
  { id: 'v21', title: 'Marathon Training Week 5 Progress', views: 0.55, age: '4 days', dur: '05:55', tags: ['Running','Health'], quality: ['1080p','720p'] },
  { id: 'v22', title: 'Modern Frontend Crash Course (Fast)', views: 2.3, age: '14 hours', dur: '27:03', tags: ['Coding','Web'], quality: ['1080p','720p'] },
  { id: 'v23', title: 'Classic Piano Study Session 2 Hours', views: 9.1, age: '1 day', dur: '120:00', tags: ['Music','Classical'], quality: ['1080p','720p'] },
  { id: 'v24', title: 'Desert Rain Rare Weather Phenomenon', views: 0.95, age: '8 hours', dur: '07:33', tags: ['Weather','Nature'], quality: ['4K','1080p'] }
];

function formatViews(v) {
  return v >= 1 ? v.toFixed(1) + 'M views' : Math.round(v * 1000) + 'K views';
}

function imageUrl(id){
  // Deterministic seed-based random image (Picsum) for consistent look per video id
  return `https://picsum.photos/seed/${id}/480/270`;
}
function posterUrl(id){
  return `https://picsum.photos/seed/poster-${id}/960/540`;
}
function buildCard(v) {
  const img = imageUrl(v.id);
  return `
    <a class="card fade-in" href="watch.html?v=${v.id}" data-id="${v.id}">
      <div class="thumb">
        <img loading="lazy" src="${img}" alt="${v.title}" onerror="this.onerror=null;this.src='assets/thumbs/fallback.svg'">
        <div class="badges">${v.quality[0] ? `<span class='badge'>${v.quality[0]}</span>` : ''}</div>
        <div class="duration">${v.dur}</div>
      </div>
      <div class="meta">
        <div class="title">${v.title}</div>
        <div class="stats"><span>${formatViews(v.views)}</span><span>${v.age}</span></div>
      </div>
    </a>`;
}

function mountIndex() {
  const trending = document.querySelector('#trending');
  if (trending) {
    VIDEO_DATA.slice(0, 12).forEach((v) => trending.insertAdjacentHTML('beforeend', buildCard(v)));
  }
  const recent = document.querySelector('#recent');
  if (recent) {
    VIDEO_DATA.slice(12).forEach((v) => recent.insertAdjacentHTML('beforeend', buildCard(v)));
  }
  document.body.classList.add('loaded');
}

function qs(key) { return new URLSearchParams(location.search).get(key); }

function mountWatch() {
  const vid = VIDEO_DATA.find((v) => v.id === qs('v')) || VIDEO_DATA[0];
  const titleEl = document.querySelector('[data-video-title]');
  if (titleEl) titleEl.textContent = vid.title;
  const tagRow = document.querySelector('[data-tags]');
  if (tagRow) tagRow.innerHTML = vid.tags.map(t => `<span class='tag'>${t}</span>`).join('');
  const stats = document.querySelector('[data-stats]');
  if (stats) stats.textContent = `${formatViews(vid.views)} • ${vid.age}`;
  const qualBar = document.querySelector('.quality-bar');
  const video = document.querySelector('video');
  if (video) {
    // Update poster dynamically so each video feels unique
    video.setAttribute('poster', posterUrl(vid.id));
  }
  if (qualBar && video) {
    vid.quality.forEach((q, i) => {
      const b = document.createElement('button');
      b.textContent = q;
      b.className = i === 0 ? 'active' : '';
      b.onclick = () => {
        [...qualBar.children].forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        video.dataset.quality = q;
      };
      qualBar.appendChild(b);
    });
  }
}

function globalSearchInit() {
  const input = document.querySelector('#searchInput');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('.card').forEach((card) => {
      const t = card.querySelector('.title').textContent.toLowerCase();
      card.style.display = t.includes(q) ? '' : 'none';
    });
  });
}

window.addEventListener('DOMContentLoaded', () => {
  mountIndex();
  mountWatch();
  globalSearchInit();
});
