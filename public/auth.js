async function updateUserUI() {
  const res = await fetch('/api/me');
  const data = await res.json();
  const userArea = document.getElementById('userArea');
  if (!userArea) return;
  if (data.authenticated) {
    userArea.innerHTML = `
      <div class="user-dropdown">
        <img src="${data.picture}" width="32" height="32" style="border-radius:50%; cursor:pointer;">
        <div class="dropdown-menu" style="display:none; position:absolute; background:var(--bg2); padding:8px; border-radius:8px;">
          <span>${escapeHtml(data.name)}</span>
          ${data.isAdmin ? '<a href="/admin.html" class="btn-sm">Admin</a>' : ''}
          <a href="/upload.html" class="btn-sm">Upload</a>
          <button id="logoutBtn" class="btn-sm">Logout</button>
        </div>
      </div>
    `;
    const dropdown = userArea.querySelector('.dropdown-menu');
    const img = userArea.querySelector('img');
    img.addEventListener('click', () => { dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none'; });
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
      await fetch('/auth/logout', { method: 'POST' });
      window.location.reload();
    });
  } else {
    userArea.innerHTML = `<a href="/auth/login" class="btn btn-ghost btn-sm">Login with Google</a>`;
  }
}
function escapeHtml(str) { return str.replace(/[&<>]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[m])); }
updateUserUI();

console.log('auth.js loaded');
setTimeout(() => {
  const userArea = document.getElementById('userArea');
  console.log('userArea found?', userArea);
  if (userArea && userArea.innerHTML.trim() === '') {
    userArea.innerHTML = '<a href="/auth/login" class="btn btn-ghost btn-sm">Login with Google</a>';
  }
}, 500);