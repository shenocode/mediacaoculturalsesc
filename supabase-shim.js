/* Adaptador: faz o painel (feito para o runtime do Claude) falar com o Supabase.
   Implementa window.claude.use('db' | 'user' | 'assets' | 'downloads' | 'room').
   Também mostra a tela de login (e-mail + senha) antes de abrir o painel. */
(function () {
  'use strict';
  var CFG = window.PAINEL_CONFIG || {};
  var BUCKET = CFG.BUCKET || 'midia';
  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  var ME = null;                 // { id, email, nome, role }
  var readyResolve, ready = new Promise(function (r) { readyResolve = r; });

  /* ---------- erros no formato que o painel entende (ER) ---------- */
  function wrap(error) {
    if (!error) return null;
    var e = new Error(error.message || 'erro');
    var c = String(error.code || '');
    e.code = (c === '42501' || /row-level security|permission denied/i.test(error.message || '')) ? 'not_granted'
           : (c === 'P0002') ? 'not_granted'
           : (c === '22023' || c === '22P02' || c === '23502') ? 'invalid_argument'
           : (c === '53300' || c === '54000') ? 'resource_exhausted'
           : 'unavailable';
    return e;
  }
  async function ok(p) { var r = await p; if (r.error) throw wrap(r.error); return r; }

  /* ---------- dados ---------- */
  var USER_PREFIX = 'data/users/';
  function isUserPath(p) { return p.indexOf(USER_PREFIX) === 0; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function splitDel(d) {            // separa {__delete__:true} dos demais campos
    var patch = {}, del = [];
    Object.keys(d || {}).forEach(function (k) {
      var v = d[k];
      if (v && typeof v === 'object' && v.__delete__) del.push(k);
      else if (v !== undefined) patch[k] = v;
    });
    return { patch: patch, del: del };
  }
  function strip(d) {                // remove campos {__delete__} e undefined num set()
    return splitDel(d).patch;
  }

  var caches = {};                   // path -> Map(id -> data)
  var subs = {};                     // path -> Set(handlers)
  function cache(p) { return caches[p] || (caches[p] = new Map()); }
  function snap(p) {
    var docs = [];
    cache(p).forEach(function (data, id) {
      docs.push({ id: id, exists: true, data: function () { return clone(data); } });
    });
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); } };
  }
  function emit(p) {
    (subs[p] || new Set()).forEach(function (h) { try { h.ok(snap(p)); } catch (e) { console.error(e); } });
  }

  async function fetchPath(p) {
    var r;
    if (isUserPath(p)) {
      r = await ok(sb.from('user_docs').select('id,data').eq('owner', p.slice(USER_PREFIX.length)).limit(5000));
    } else {
      r = await ok(sb.from('docs').select('id,data').eq('path', p).limit(5000));
    }
    var m = new Map();
    (r.data || []).forEach(function (row) { m.set(row.id, row.data); });
    caches[p] = m;
    emit(p);
  }

  var channel = null;
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel('painel-db')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, function (pl) {
        var row = pl.new && pl.new.path ? pl.new : pl.old; if (!row || !row.path) return;
        apply(row.path, row.id, pl.eventType, pl.new && pl.new.data);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_docs' }, function (pl) {
        var row = pl.new && pl.new.owner ? pl.new : pl.old; if (!row || !row.owner) return;
        apply(USER_PREFIX + row.owner, row.id, pl.eventType, pl.new && pl.new.data);
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') Object.keys(subs).forEach(function (p) { if (subs[p].size) fetchPath(p).catch(function () {}); });
      });
  }
  function apply(p, id, type, data) {
    if (!subs[p] || !subs[p].size) return;
    if (type === 'DELETE') cache(p).delete(id); else cache(p).set(id, data);
    emit(p);
  }

  function collection(path) {
    return {
      onSnapshot: function (okCb, errCb) {
        var h = { ok: okCb, err: errCb || function () {} };
        (subs[path] = subs[path] || new Set()).add(h);
        ensureChannel();
        fetchPath(path).catch(function (e) { h.err(e); });
        return function () { subs[path].delete(h); };
      },
      doc: function (id) { return docRef(path, id); }
    };
  }

  function docRef(path, id) {
    id = String(id);
    var user = isUserPath(path);
    return {
      id: id,
      get: async function () {
        var r = user
          ? await ok(sb.from('user_docs').select('data').eq('owner', path.slice(USER_PREFIX.length)).eq('id', id).maybeSingle())
          : await ok(sb.from('docs').select('data').eq('path', path).eq('id', id).maybeSingle());
        var d = r.data ? r.data.data : null;
        return { id: id, exists: !!d, data: function () { return d ? clone(d) : undefined; } };
      },
      set: async function (d) {
        var body = strip(d);
        if (user) await ok(sb.from('user_docs').upsert({ owner: path.slice(USER_PREFIX.length), id: id, data: body, updated_at: new Date().toISOString() }));
        else await ok(sb.from('docs').upsert({ path: path, id: id, data: body, updated_at: new Date().toISOString() }));
        if (subs[path] && subs[path].size) { cache(path).set(id, body); emit(path); }
      },
      update: async function (d) {
        var s = splitDel(d);
        if (user) await ok(sb.rpc('user_doc_update', { p_id: id, p_patch: s.patch, p_del: s.del }));
        else await ok(sb.rpc('doc_update', { p_path: path, p_id: id, p_patch: s.patch, p_del: s.del }));
        if (subs[path] && subs[path].size && cache(path).has(id)) {
          var cur = Object.assign({}, cache(path).get(id), s.patch);
          s.del.forEach(function (k) { delete cur[k]; });
          cache(path).set(id, cur); emit(path);
        }
      },
      delete: async function () {
        if (user) await ok(sb.from('user_docs').delete().eq('owner', path.slice(USER_PREFIX.length)).eq('id', id));
        else await ok(sb.from('docs').delete().eq('path', path).eq('id', id));
        if (subs[path] && subs[path].size) { cache(path).delete(id); emit(path); }
      }
    };
  }
  var dbApi = { collection: collection };

  /* ---------- usuário ---------- */
  var userApi = {
    id: async function () { return ME ? ME.id : null; },
    isOwner: function () { return !!ME && ME.role === 'supervisao'; },
    canEdit: function () { return !!ME && ME.role === 'supervisao'; },
    me: async function () { return ME ? { id: ME.id, name: ME.nome, email: ME.email } : null; },
    profiles: async function (ids) {
      var r = await ok(sb.from('profiles').select('id,nome').in('id', ids));
      return (r.data || []).map(function (p) { return { id: p.id, name: p.nome }; });
    }
  };

  /* ---------- arquivos ---------- */
  function ext(file) {
    var n = (file.name || '').split('.').pop().toLowerCase();
    if (n && n.length <= 5 && n !== (file.name || '').toLowerCase()) return n;
    var t = file.type || '';
    return t.indexOf('png') > -1 ? 'png' : t.indexOf('webp') > -1 ? 'webp' : t.indexOf('mp4') > -1 ? 'mp4'
         : t.indexOf('quicktime') > -1 ? 'mov' : t.indexOf('gif') > -1 ? 'gif' : 'jpg';
  }
  function rid() {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var assetsApi = {
    upload: async function (file) {
      var id = rid(), name = id + '.' + ext(file);
      var r = await sb.storage.from(BUCKET).upload(name, file, { contentType: file.type || undefined, cacheControl: '31536000', upsert: false });
      if (r.error) { var e = new Error(r.error.message); e.code = /exceed|too large|size/i.test(r.error.message) ? 'quota_exceeded' : 'unavailable'; throw e; }
      return { id: id, url: sb.storage.from(BUCKET).getPublicUrl(name).data.publicUrl };
    }
  };

  var dlApi = {
    save: async function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: o.type || 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = o.filename || 'arquivo';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
  };

  /* ---------- presença (quem está online) ---------- */
  var roomApi = null;
  function makeRoom() {
    var cbs = [], ch = sb.channel('painel-room', { config: { presence: { key: ME.id } } });
    function peers() {
      var st = ch.presenceState(), out = [];
      Object.keys(st).forEach(function (k) { st[k].forEach(function (m) { out.push(Object.assign({}, m, { by: k })); }); });
      return out;
    }
    ch.on('presence', { event: 'sync' }, function () { var p = peers(); cbs.forEach(function (f) { f({ peers: p }); }); });
    var subscribed = new Promise(function (res) { ch.subscribe(function (s) { if (s === 'SUBSCRIBED') res(); }); });
    return {
      presence: async function (state) { await subscribed; await ch.track(Object.assign({}, state)); },
      onPeers: function (f) { cbs.push(f); return function () { cbs = cbs.filter(function (x) { return x !== f; }); }; }
    };
  }

  /* ---------- tela de login ---------- */
  var css = '#pm-login{position:fixed;inset:0;z-index:99999;background:#f4f1e8;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Nunito,system-ui,sans-serif}'
    + '#pm-login form{background:#fff;border-radius:16px;box-shadow:0 6px 30px rgba(0,0,0,.12);padding:24px;width:100%;max-width:360px}'
    + '#pm-login h1{font-size:20px;margin:0 0 4px}#pm-login p{margin:0 0 14px;color:#6b6858;font-size:14px}'
    + '#pm-login input{width:100%;box-sizing:border-box;padding:12px;margin:0 0 10px;border:1px solid #cfc9b5;border-radius:10px;font-size:16px}'
    + '#pm-login button{width:100%;padding:12px;border:0;border-radius:10px;font-size:16px;font-weight:800;background:#c8372d;color:#fff;margin-top:2px}'
    + '#pm-login .l{background:none;color:#555;font-weight:700;font-size:14px;margin-top:6px;text-decoration:underline}'
    + '#pm-login .m{min-height:20px;font-size:14px;color:#b3261e;margin:8px 0 0}';
  function el(h) { var d = document.createElement('div'); d.innerHTML = h; return d.firstChild; }

  function showLogin(msg) {
    var old = document.getElementById('pm-login'); if (old) old.remove();
    if (!document.getElementById('pm-css')) { var s = document.createElement('style'); s.id = 'pm-css'; s.textContent = css; document.head.appendChild(s); }
    var box = el('<div id="pm-login"><form>'
      + '<h1>Painel de Mediação Cultural</h1><p>Sesc Piracicaba · acesso da equipe</p>'
      + '<input name=email type=email autocomplete=username placeholder="E-mail" required>'
      + '<input name=senha type=password autocomplete=current-password placeholder="Senha (mín. 8 caracteres)" minlength=8>'
      + '<button type=submit>Entrar</button>'
      + '<button type=button class=l data-a=new>Primeiro acesso? Criar minha senha</button>'
      + '<button type=button class=l data-a=reset>Esqueci minha senha</button>'
      + '<div class=m></div></form></div>');
    document.body.appendChild(box);
    var f = box.querySelector('form'), m = box.querySelector('.m');
    if (msg) m.textContent = msg;
    function say(t, good) { m.style.color = good ? '#1b7f3b' : '#b3261e'; m.textContent = t; }
    f.onsubmit = async function (e) {
      e.preventDefault(); say('Entrando…', true);
      var r = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.senha.value });
      if (r.error) say(/invalid/i.test(r.error.message) ? 'E-mail ou senha incorretos.' : r.error.message);
    };
    box.querySelector('[data-a=new]').onclick = async function () {
      if (!f.email.value || f.senha.value.length < 8) return say('Informe seu e-mail e uma senha de pelo menos 8 caracteres.');
      var r = await sb.auth.signUp({ email: f.email.value.trim(), password: f.senha.value });
      if (r.error) return say(r.error.message);
      if (!r.data.session) say('Enviamos um e-mail de confirmação. Abra-o e depois volte aqui para entrar.', true);
    };
    box.querySelector('[data-a=reset]').onclick = async function () {
      if (!f.email.value) return say('Digite seu e-mail acima primeiro.');
      var r = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: location.origin + location.pathname });
      say(r.error ? r.error.message : 'Enviamos um link para redefinir a senha.', !r.error);
    };
  }
  function showNewPassword() {
    var old = document.getElementById('pm-login'); if (old) old.remove();
    var box = el('<div id="pm-login"><form><h1>Nova senha</h1><p>Escolha uma senha nova.</p>'
      + '<input name=senha type=password autocomplete=new-password minlength=8 placeholder="Nova senha (mín. 8)" required>'
      + '<button type=submit>Salvar</button><div class=m></div></form></div>');
    document.body.appendChild(box);
    box.querySelector('form').onsubmit = async function (e) {
      e.preventDefault();
      var r = await sb.auth.updateUser({ password: e.target.senha.value });
      if (r.error) box.querySelector('.m').textContent = r.error.message; else location.replace(location.pathname);
    };
  }
  function showPending() {
    var old = document.getElementById('pm-login'); if (old) old.remove();
    var box = el('<div id="pm-login"><form><h1>Aguardando liberação</h1><p>Sua conta foi criada, mas seu e-mail ainda não foi autorizado pela supervisão.</p><button type=button>Sair</button></form></div>');
    document.body.appendChild(box);
    box.querySelector('button').onclick = function () { sb.auth.signOut().then(function () { location.reload(); }); };
  }

  async function loadProfile(session) {
    var r = await sb.from('profiles').select('id,email,nome,role').eq('id', session.user.id).maybeSingle();
    return r.data || { id: session.user.id, email: session.user.email, nome: session.user.email, role: 'pendente' };
  }

  var started = false;
  async function onSession(session) {
    if (!session) { ME = null; showLogin(); return; }
    var p = await loadProfile(session);
    if (p.role === 'pendente') { showPending(); return; }
    ME = p;
    var box = document.getElementById('pm-login'); if (box) box.remove();
    if (!started) { started = true; readyResolve(); }
  }

  sb.auth.onAuthStateChange(function (ev, session) {
    if (ev === 'PASSWORD_RECOVERY') { showNewPassword(); return; }
    if (ev === 'SIGNED_OUT') { location.reload(); return; }
    if (ev === 'INITIAL_SESSION' || ev === 'SIGNED_IN') setTimeout(function () { onSession(session); }, 0);
  });

  window.painelSignOut = function () { return sb.auth.signOut(); };

  /* ---------- ponto de entrada esperado pelo painel ---------- */
  window.claude = {
    use: async function (name) {
      await ready;
      if (name === 'db') return dbApi;
      if (name === 'user') return userApi;
      if (name === 'assets') return assetsApi;
      if (name === 'downloads') return dlApi;
      if (name === 'room') return roomApi || (roomApi = makeRoom());
      return null;
    }
  };
  window.__painelShim = { sb: sb, wrap: wrap, collection: collection, _setMe: function (m) { ME = m; } }; // _setMe: só para testes
})();
