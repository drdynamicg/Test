import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { SignJWT, jwtVerify } from 'jose';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers (for API calls)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ---------- Helper: Session & Admin ----------
    async function getUserFromSession(request) {
      const cookie = request.headers.get('Cookie');
      if (!cookie) return null;
      const match = cookie.match(/session=([^;]+)/);
      if (!match) return null;
      const token = match[1];
      try {
        const secret = new TextEncoder().encode(env.JWT_SECRET);
        const { payload } = await jwtVerify(token, secret);
        return payload;
      } catch (e) {
        return null;
      }
    }

    function isAdmin(user) {
      if (!user) return false;
      const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
      return adminEmails.includes(user.email.toLowerCase());
    }

    async function requireAdmin(request) {
      const user = await getUserFromSession(request);
      if (!user || !isAdmin(user)) {
        return json({ error: 'Unauthorized' }, 401);
      }
      return user;
    }

    // ---------- OAuth Routes ----------
    if (path === '/auth/login' && request.method === 'GET') {
      const state = crypto.randomUUID();
      const redirectUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid%20email%20profile&state=${state}&access_type=offline`;
      return new Response(null, {
        status: 302,
        headers: {
          'Location': redirectUrl,
          'Set-Cookie': `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`,
        },
      });
    }

    if (path === '/auth/callback' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const cookie = request.headers.get('Cookie');
      const stateMatch = cookie?.match(/oauth_state=([^;]+)/);
      if (!stateMatch || stateMatch[1] !== state) {
        return new Response('Invalid state', { status: 400 });
      }
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: env.GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.id_token) return new Response('Auth failed', { status: 400 });
      // verify id_token
      const idToken = tokens.id_token;
      const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;
      const verifyRes = await fetch(verifyUrl);
      const payload = await verifyRes.json();
      if (payload.aud !== env.GOOGLE_CLIENT_ID) return new Response('Invalid token', { status: 400 });
      const user = { email: payload.email, name: payload.name, picture: payload.picture };
      // store/update user in D1
      await env.DB.prepare(`
        INSERT INTO users (email, name, picture, last_login) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(email) DO UPDATE SET name = excluded.name, picture = excluded.picture, last_login = CURRENT_TIMESTAMP
      `).bind(user.email, user.name, user.picture).run();
      const secret = new TextEncoder().encode(env.JWT_SECRET);
      const jwt = await new SignJWT({ email: user.email, name: user.name, picture: user.picture })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(secret);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': `session=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
        },
      });
    }

    if (path === '/auth/logout' && request.method === 'POST') {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/', 'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' },
      });
    }

    if (path === '/api/me' && request.method === 'GET') {
      const user = await getUserFromSession(request);
      if (!user) return json({ authenticated: false });
      return json({ authenticated: true, email: user.email, name: user.name, picture: user.picture, isAdmin: isAdmin(user) });
    }

    // ---------- Public API Routes ----------
    if (path === '/api/wallpapers' && request.method === 'GET') {
      return handleListWallpapers(request, env, url);
    }
    if (path.match(/^\/api\/wallpapers\/[^\/]+$/) && request.method === 'GET') {
      const slug = path.split('/').pop();
      return handleGetWallpaper(slug, env);
    }
    if (path === '/api/categories' && request.method === 'GET') {
      return handleGetCategories(env);
    }
    if (path === '/api/tags' && request.method === 'GET') {
      return handleGetTags(env);
    }
    if (path === '/api/collections' && request.method === 'GET') {
      return handleGetCollections(env);
    }
    if (path === '/api/report' && request.method === 'POST') {
      return handleReport(request, env);
    }
    if (path === '/api/upload' && request.method === 'POST') {
      return handleUserUpload(request, env);
    }
    if (path.match(/^\/api\/download\/[^\/]+\/(1080p|2k|4k|8k)$/) && request.method === 'GET') {
      const parts = path.split('/');
      const wallpaperId = parts[3];
      const size = parts[4];
      return handleDownload(wallpaperId, size, request, env);
    }
    if (path === '/sitemap.xml' && request.method === 'GET') {
      return handleSitemap(env);
    }

    // ---------- Admin API Routes (require admin) ----------
    if (path === '/api/admin/pending' && request.method === 'GET') {
      if (await requireAdmin(request)) return handleListPending(env);
    }
    if (path.match(/^\/api\/admin\/approve\/\d+$/) && request.method === 'POST') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleApprove(id, request, env);
      }
    }
    if (path.match(/^\/api\/admin\/reject\/\d+$/) && request.method === 'POST') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleReject(id, env);
      }
    }
    // Taxonomy admin endpoints (same token check)
    if (path === '/api/admin/categories' && request.method === 'GET') {
      if (await requireAdmin(request)) return handleGetAllCategories(env);
    }
    if (path === '/api/admin/categories' && request.method === 'POST') {
      if (await requireAdmin(request)) return handleCreateCategory(request, env);
    }
    if (path.match(/^\/api\/admin\/categories\/\d+$/) && request.method === 'PUT') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleUpdateCategory(id, request, env);
      }
    }
    if (path.match(/^\/api\/admin\/categories\/\d+$/) && request.method === 'DELETE') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleDeleteCategory(id, env);
      }
    }
    if (path === '/api/admin/tags' && request.method === 'GET') {
      if (await requireAdmin(request)) return handleGetAllTags(env);
    }
    if (path === '/api/admin/tags' && request.method === 'POST') {
      if (await requireAdmin(request)) return handleCreateTag(request, env);
    }
    if (path.match(/^\/api\/admin\/tags\/\d+$/) && request.method === 'PUT') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleUpdateTag(id, request, env);
      }
    }
    if (path.match(/^\/api\/admin\/tags\/\d+$/) && request.method === 'DELETE') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleDeleteTag(id, env);
      }
    }
    if (path === '/api/admin/collections' && request.method === 'GET') {
      if (await requireAdmin(request)) return handleGetAllCollections(env);
    }
    if (path === '/api/admin/collections' && request.method === 'POST') {
      if (await requireAdmin(request)) return handleCreateCollection(request, env);
    }
    if (path.match(/^\/api\/admin\/collections\/\d+$/) && request.method === 'PUT') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleUpdateCollection(id, request, env);
      }
    }
    if (path.match(/^\/api\/admin\/collections\/\d+$/) && request.method === 'DELETE') {
      if (await requireAdmin(request)) {
        const id = parseInt(path.split('/').pop());
        return handleDeleteCollection(id, env);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

// ---------- Public Handlers ----------
async function handleListWallpapers(request, env, url) {
  const page = parseInt(url.searchParams.get('page') || '1');
  const perPage = 12;
  const offset = (page - 1) * perPage;
  const catSlug = url.searchParams.get('cat') || null;
  const tagSlug = url.searchParams.get('tag') || null;
  const collectionSlug = url.searchParams.get('collection') || null;
  const sort = url.searchParams.get('sort') || 'recent';
  const search = url.searchParams.get('search') || '';

  let query = `SELECT w.* FROM wallpapers w WHERE 1=1`;
  const params = [];
  if (catSlug) {
    query += ` AND EXISTS (SELECT 1 FROM wallpaper_category wc JOIN categories c ON wc.category_id = c.id WHERE wc.wallpaper_id = w.id AND c.slug = ?)`;
    params.push(catSlug);
  }
  if (tagSlug) {
    query += ` AND EXISTS (SELECT 1 FROM wallpaper_tag wt JOIN tags t ON wt.tag_id = t.id WHERE wt.wallpaper_id = w.id AND t.slug = ?)`;
    params.push(tagSlug);
  }
  if (collectionSlug) {
    query += ` AND EXISTS (SELECT 1 FROM wallpaper_collection wcol JOIN collections c ON wcol.collection_id = c.id WHERE wcol.wallpaper_id = w.id AND c.slug = ?)`;
    params.push(collectionSlug);
  }
  if (search) {
    query += ` AND (w.title LIKE ? OR w.description LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  if (sort === 'popular') {
    query += ` ORDER BY w.download_count DESC, w.approved_at DESC`;
  } else if (sort === 'random') {
    query += ` ORDER BY RANDOM()`;
  } else {
    query += ` ORDER BY w.approved_at DESC`;
  }
  query += ` LIMIT ? OFFSET ?`;
  params.push(perPage, offset);
  const result = await env.DB.prepare(query).bind(...params).all();
  const items = result.results;
  const hasMore = items.length === perPage;
  return new Response(JSON.stringify({ items, hasMore }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleGetWallpaper(slug, env) {
  const wallpaper = await env.DB.prepare('SELECT * FROM wallpapers WHERE slug = ?').bind(slug).first();
  if (!wallpaper) return new Response('Not found', { status: 404 });
  const categories = await env.DB.prepare(`SELECT c.name, c.slug FROM wallpaper_category wc JOIN categories c ON wc.category_id = c.id WHERE wc.wallpaper_id = ?`).bind(wallpaper.id).all();
  const tags = await env.DB.prepare(`SELECT t.name, t.slug FROM wallpaper_tag wt JOIN tags t ON wt.tag_id = t.id WHERE wt.wallpaper_id = ?`).bind(wallpaper.id).all();
  const collections = await env.DB.prepare(`SELECT c.name, c.slug FROM wallpaper_collection wc JOIN collections c ON wc.collection_id = c.id WHERE wc.wallpaper_id = ?`).bind(wallpaper.id).all();
  return new Response(JSON.stringify({ ...wallpaper, categories: categories.results, tags: tags.results, collections: collections.results }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDownload(wallpaperId, size, request, env) {
  await env.DB.prepare('UPDATE wallpapers SET download_count = download_count + 1 WHERE id = ?').bind(wallpaperId).run();
  const key = `sizes/${wallpaperId}/${size}.jpg`;
  const object = await env.R2_BUCKET.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const signedUrl = await env.R2_BUCKET.createSignedUrl(key, { expiry: 3600 });
  return new Response(JSON.stringify({ url: signedUrl }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleUserUpload(request, env) {
  // 1. Check authentication
  const user = await getUserFromSession(request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'You must be logged in to upload' }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const formData = await request.formData();
  const file = formData.get('image');
  // We ignore email/name from form – use session data
  const email = user.email;
  const name = user.name || user.email.split('@')[0];

  if (!file) return new Response(JSON.stringify({ error: 'No image provided' }), { status: 400 });
  if (!file.type.startsWith('image/')) return new Response(JSON.stringify({ error: 'Invalid file type' }), { status: 400 });
  if (file.size > 50 * 1024 * 1024) return new Response(JSON.stringify({ error: 'Max 50MB' }), { status: 400 });

  const buffer = await file.arrayBuffer();
  const metadata = await sharp(buffer).metadata();
  if (metadata.width < 1920 || metadata.height < 1080) {
    return new Response(JSON.stringify({ error: 'Minimum resolution is 1080p (1920×1080)' }), { status: 400 });
  }

  const tempKey = `temp-uploads/${uuidv4()}_${file.name}`;
  await env.R2_BUCKET.put(tempKey, buffer);
  await env.DB.prepare(`
    INSERT INTO pending_uploads (temp_key, original_width, uploader_email, uploader_name, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).bind(tempKey, metadata.width, email, name).run();

  return new Response(JSON.stringify({ success: true, message: 'Submitted for review' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleReport(request, env) {
  const body = await request.json();
  const { wallpaper_id, reporter_name, reporter_email, original_url, message } = body;
  if (!wallpaper_id || !reporter_name || !reporter_email || !original_url) return new Response('Missing fields', { status: 400 });
  await env.DB.prepare(`INSERT INTO reports (wallpaper_id, reporter_name, reporter_email, original_url, message) VALUES (?, ?, ?, ?, ?)`).bind(wallpaper_id, reporter_name, reporter_email, original_url, message || '').run();
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleSitemap(env) {
  const wallpapers = await env.DB.prepare('SELECT slug, approved_at FROM wallpapers ORDER BY approved_at DESC').all();
  const baseUrl = 'https://yourdomain.com'; // Replace with your domain
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`;
  for (const w of wallpapers.results) {
    xml += `<url><loc>${baseUrl}/wallpaper.html?slug=${w.slug}</loc><lastmod>${w.approved_at.split('T')[0]}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`;
  }
  xml += `</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
}

// ---------- Admin Handlers (Pending, Approve, Reject) ----------
async function handleListPending(env) {
  const pending = await env.DB.prepare('SELECT * FROM pending_uploads WHERE status = "pending" ORDER BY submitted_at DESC').all();
  return new Response(JSON.stringify(pending.results), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApprove(id, request, env) {
  const formData = await request.formData();
  const upscaledFile = formData.get('upscaled_image');
  const title = formData.get('title') || 'User submission';
  const categoryIds = formData.get('categories') ? formData.get('categories').split(',').map(Number) : [];
  const tagIds = formData.get('tags') ? formData.get('tags').split(',').map(Number) : [];
  const collectionIds = formData.get('collections') ? formData.get('collections').split(',').map(Number) : [];

  const pending = await env.DB.prepare('SELECT * FROM pending_uploads WHERE id = ?').bind(id).first();
  if (!pending) return new Response('Not found', { status: 404 });

  let finalBuffer, finalWidth;
  if (upscaledFile && upscaledFile.size > 0) {
    finalBuffer = await upscaledFile.arrayBuffer();
    const meta = await sharp(finalBuffer).metadata();
    finalWidth = meta.width;
  } else {
    const obj = await env.R2_BUCKET.get(pending.temp_key);
    finalBuffer = await obj.arrayBuffer();
    finalWidth = pending.original_width;
  }

  const newId = uuidv4();
  const slug = `wallpaper-${newId.slice(0, 8)}`;
  const originalKey = `originals/${newId}/image.jpg`;
  await env.R2_BUCKET.put(originalKey, finalBuffer);

  const sizes = [
    { name: '1080p', width: 1920, height: 1080 },
    { name: '2k', width: 2560, height: 1440 },
    { name: '4k', width: 3840, height: 2160 },
    { name: '8k', width: 7680, height: 4320 },
  ];
  for (const sz of sizes) {
    const resized = await sharp(finalBuffer).resize(sz.width, sz.height).jpeg({ quality: 85 }).toBuffer();
    await env.R2_BUCKET.put(`sizes/${newId}/${sz.name}.jpg`, resized);
  }

  await env.DB.prepare(`INSERT INTO wallpapers (id, title, slug, original_key, original_width, uploader_email, uploader_name, approved_at, upscaled_by_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId, title, slug, originalKey, finalWidth, pending.uploader_email, pending.uploader_name, new Date().toISOString(), upscaledFile ? 1 : 0).run();

  for (const catId of categoryIds) await env.DB.prepare('INSERT INTO wallpaper_category (wallpaper_id, category_id) VALUES (?, ?)').bind(newId, catId).run();
  for (const tagId of tagIds) await env.DB.prepare('INSERT INTO wallpaper_tag (wallpaper_id, tag_id) VALUES (?, ?)').bind(newId, tagId).run();
  for (const colId of collectionIds) await env.DB.prepare('INSERT INTO wallpaper_collection (wallpaper_id, collection_id) VALUES (?, ?)').bind(newId, colId).run();

  await env.R2_BUCKET.delete(pending.temp_key);
  await env.DB.prepare('DELETE FROM pending_uploads WHERE id = ?').bind(id).run();
  return new Response(JSON.stringify({ success: true, wallpaperId: newId }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleReject(id, env) {
  const pending = await env.DB.prepare('SELECT * FROM pending_uploads WHERE id = ?').bind(id).first();
  if (!pending) return new Response('Not found', { status: 404 });
  await env.R2_BUCKET.delete(pending.temp_key);
  await env.DB.prepare('UPDATE pending_uploads SET status = "rejected" WHERE id = ?').bind(id).run();
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

// ---------- Taxonomy CRUD ----------
async function handleGetAllCategories(env) { const cats = await env.DB.prepare('SELECT * FROM categories ORDER BY parent_id, name').all(); return new Response(JSON.stringify(cats.results), { headers: { 'Content-Type': 'application/json' } }); }
async function handleCreateCategory(request, env) { const { name, slug, parent_id } = await request.json(); const result = await env.DB.prepare('INSERT INTO categories (name, slug, parent_id) VALUES (?, ?, ?) RETURNING id').bind(name, slug, parent_id || null).first(); return new Response(JSON.stringify({ success: true, id: result.id }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleUpdateCategory(id, request, env) { const { name, slug, parent_id } = await request.json(); await env.DB.prepare('UPDATE categories SET name = ?, slug = ?, parent_id = ? WHERE id = ?').bind(name, slug, parent_id || null, id).run(); return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleDeleteCategory(id, env) { await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run(); return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleGetAllTags(env) { const tags = await env.DB.prepare('SELECT * FROM tags ORDER BY name').all(); return new Response(JSON.stringify(tags.results), { headers: { 'Content-Type': 'application/json' } }); }
async function handleCreateTag(request, env) { const { name, slug } = await request.json(); const result = await env.DB.prepare('INSERT INTO tags (name, slug) VALUES (?, ?) RETURNING id').bind(name, slug).first(); return new Response(JSON.stringify({ success: true, id: result.id }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleUpdateTag(id, request, env) { const { name, slug } = await request.json(); await env.DB.prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ?').bind(name, slug, id).run(); return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleDeleteTag(id, env) { await env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run(); return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleGetAllCollections(env) { const cols = await env.DB.prepare('SELECT * FROM collections ORDER BY name').all(); return new Response(JSON.stringify(cols.results), { headers: { 'Content-Type': 'application/json' } }); }
async function handleCreateCollection(request, env) { const { name, slug, description } = await request.json(); const result = await env.DB.prepare('INSERT INTO collections (name, slug, description) VALUES (?, ?, ?) RETURNING id').bind(name, slug, description || null).first(); return new Response(JSON.stringify({ success: true, id: result.id }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleUpdateCollection(id, request, env) { const { name, slug, description } = await request.json(); await env.DB.prepare('UPDATE collections SET name = ?, slug = ?, description = ? WHERE id = ?').bind(name, slug, description || null, id).run(); return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }); }
async function handleDeleteCollection(id, env) { await env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id).run(); return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }); }

// Public taxonomy endpoints (no auth)
async function handleGetCategories(env) { const cats = await env.DB.prepare('SELECT id, name, slug, parent_id FROM categories ORDER BY parent_id, name').all(); return new Response(JSON.stringify(cats.results), { headers: { 'Content-Type': 'application/json' } }); }
async function handleGetTags(env) { const tags = await env.DB.prepare('SELECT id, name, slug FROM tags ORDER BY name').all(); return new Response(JSON.stringify(tags.results), { headers: { 'Content-Type': 'application/json' } }); }
async function handleGetCollections(env) { const cols = await env.DB.prepare('SELECT id, name, slug FROM collections ORDER BY name').all(); return new Response(JSON.stringify(cols.results), { headers: { 'Content-Type': 'application/json' } }); }