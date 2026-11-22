/* Formulário público de visita e horários do ônibus do Sesc. */
(function () {
  'use strict';
  var HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
  var OCUPA = { Agendado: 1, Confirmado: 1, Realizado: 1 };
  var TIPOS = ['Particular', 'Escola Estadual', 'Escola Municipal', 'ONG', 'Universidade', 'Empresa', 'Sesc / funcionários', 'Outros'];
  var API = {};
  var timers = new WeakMap();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function horaOk(s) { return HORA.test(String(s || '')); }
  function maisMin(hora, add) {
    var m = String(hora || '').match(/^(\d{2}):(\d{2})$/);
    if (!m) return '';
    var t = (+m[1]) * 60 + (+m[2]) + add;
    if (t < 0 || t >= 24 * 60) return '';
    return ('0' + Math.floor(t / 60)).slice(-2) + ':' + ('0' + (t % 60)).slice(-2);
  }
  function normHora(s) {
    var m = String(s || '').trim().match(/^(\d{1,2})\s*[:h]\s*(\d{2})$/i);
    if (!m) return '';
    var h = ('0' + m[1]).slice(-2), mm = m[2];
    return horaOk(h + ':' + mm) ? h + ':' + mm : '';
  }
  function parseHoras(txt) {
    var out = [], seen = {};
    String(txt || '').split(/[\n,;]+/).forEach(function (p) {
      var h = normHora(p);
      if (h && !seen[h]) { seen[h] = 1; out.push(h); }
    });
    return out.sort();
  }
  function num(v, fb, min, max) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) n = fb;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }
  function cfgAtual() {
    var raw = API.cfg ? API.cfg() : {};
    raw = raw || {};
    var horas = Array.isArray(raw.horarios) ? raw.horarios.map(normHora).filter(Boolean) : [];
    var grades = {};
    if (raw.grades && typeof raw.grades === 'object') {
      Object.keys(raw.grades).forEach(function (dia) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !Array.isArray(raw.grades[dia])) return;
        var hs = raw.grades[dia].map(normHora).filter(Boolean);
        if (hs.length) grades[dia] = hs;
      });
    }
    var durPadrao = num(raw.durPadrao, 60, 20, 240);
    var durMin = num(raw.durMin, 40, 15, 240);
    if (durMin > durPadrao) durMin = durPadrao;
    return {
      enderecoSesc: String(raw.enderecoSesc || '').trim(),
      horarios: horas.length ? horas : ['09:00', '10:30', '14:00', '15:30'],
      durPadrao: durPadrao,
      durMin: durMin,
      margem: num(raw.margem, 10, 0, 60),
      lotacao: num(raw.lotacao, 40, 1, 80),
      grades: grades,
      salvo: !!(raw.horarios || raw.enderecoSesc || raw.grades)
    };
  }
  function listaDia(dia) {
    var c = cfgAtual();
    if (dia && c.grades[dia] && c.grades[dia].length) return c.grades[dia].slice();
    return c.horarios.slice();
  }
  function avisar(m) {
    if (API.toast) return API.toast(m);
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = m;
    t.style.display = 'block';
    clearTimeout(avisar._t);
    avisar._t = setTimeout(function () { t.style.display = 'none'; }, 4600);
  }
  function supervision() { return !!(window.__logEd && window.__logEd()); }

  function rowEnd(valor) {
    return '<div class=endrow><label>Endereço de embarque<input name=end value="' + esc(valor || '') + '" placeholder="Rua, número, bairro, cidade" autocomplete=street-address></label><button type=button class="btn g" data-logact=tirar-end aria-label="Tirar endereço">✕</button></div>';
  }
  function fld(k, l, t, v) {
    if (t === 'slot') return slotHtml(v);
    if (t === 'ends') return endsHtml(v);
    if (t === 'busbox') return busHtml();
    return null;
  }
  function slotHtml(v) {
    var atual = typeof v === 'string' ? v : '';
    return '<label>Horário da visita no Sesc<select name=hora data-slot data-atual="' + esc(atual) + '"><option value="">Selecione…</option></select></label>';
  }
  function endsHtml(v) {
    var list = Array.isArray(v) ? v.filter(Boolean) : [];
    if (!list.length) list = [''];
    var varios = list.length > 1;
    return '<div class=medw data-tr data-ends hidden><label class=chk><input type=checkbox name=varios' + (varios ? ' checked' : '') + '> Embarque em mais de um endereço, antes de ir ao Sesc</label><div data-endlist>' + list.map(rowEnd).join('') + '</div><p data-maiswrap' + (varios ? '' : ' hidden') + '><button type=button class="btn g" data-logact=mais-end>Incluir outro endereço</button></p><p class=mut data-maiswrap' + (varios ? '' : ' hidden') + '>A conta soma uma margem em cada trecho, para imprevisto.</p></div>';
  }
  function busHtml() {
    var ed = supervision();
    return '<div class=medw data-busbox><div data-tr hidden data-logres><b class=mlb>Horários do ônibus</b><div class=mut data-logmsg>Informe a data, o horário e o endereço para calcular o embarque e a volta.</div></div><label>Fim da mediação<input name=fim type=time></label>' + (ed ? '<label class="chk" data-tr hidden><input type=checkbox name=logmanual> Ajustar embarque e volta à mão</label><label data-manual hidden>Embarque no primeiro endereço<input name=embOrigem type=time></label><label data-manual hidden>Embarque da volta no Sesc<input name=embSesc type=time></label>' : '') + '</div>';
  }
  function sync(f) {
    if (!f || !f.elements) return;
    var sel = f.elements.hora;
    if (sel && sel.dataset && sel.dataset.slot != null) {
      var dia = f.elements.data ? f.elements.data.value : '';
      var atual = sel.value || sel.dataset.atual || '';
      var vid = f.dataset.vid || '';
      var horas = listaDia(dia);
      if (atual && horas.indexOf(atual) < 0) horas.push(atual);
      var visitas = (API.visitas ? API.visitas() : []).filter(function (v) { return v.data === dia && OCUPA[v.status || 'Agendado']; });
      var html = '<option value="">Selecione…</option>' + horas.map(function (h) {
        var ocup = visitas.some(function (v) { return v.hora === h && v.id !== vid; });
        return '<option value="' + h + '"' + (h === atual ? ' selected' : '') + (ocup ? ' disabled' : '') + '>' + h + (ocup ? ' (reservado)' : '') + '</option>';
      }).join('');
      if (sel.dataset.sig !== html) { sel.innerHTML = html; sel.dataset.sig = html; if (atual) sel.value = atual; }
    }
    var on = f.elements.transporte && f.elements.transporte.value === 'Ônibus do Sesc';
    var varios = f.elements.varios && f.elements.varios.checked;
    f.querySelectorAll('[data-maiswrap]').forEach(function (el) { el.hidden = !on || !varios; });
    var manual = f.elements.logmanual && f.elements.logmanual.checked && on;
    f.querySelectorAll('[data-manual]').forEach(function (el) { el.hidden = !manual; });
    if (f.elements.fim) f.elements.fim.readOnly = !!(on && !manual);
  }
  function hidratar(f, rec) {
    if (!f) return;
    rec = rec || {};
    if (rec.id) f.dataset.vid = rec.id;
    var list = f.querySelector('[data-endlist]');
    if (list && Array.isArray(rec.enderecos) && rec.enderecos.length) {
      list.innerHTML = rec.enderecos.map(rowEnd).join('');
      if (f.elements.varios) f.elements.varios.checked = rec.enderecos.length > 1;
    }
    if (f.elements.fim && rec.fim) f.elements.fim.value = rec.fim;
    if (f.elements.embOrigem && rec.embOrigem) f.elements.embOrigem.value = rec.embOrigem;
    if (f.elements.embSesc && rec.embSesc) f.elements.embSesc.value = rec.embSesc;
    if (f.elements.logmanual) f.elements.logmanual.checked = !!rec.logisticaManual;
    if (f.elements.hora && rec.hora) f.elements.hora.dataset.atual = rec.hora;
    sync(f);
    if (rec.transporte === 'Ônibus do Sesc') {
      pintar(f, {
        ok: !rec.logisticaPendente && !!rec.embOrigem,
        pendente: !!rec.logisticaPendente,
        motivo: rec.logisticaMotivo || '',
        embarques: rec.embarques || [],
        embSesc: rec.embSesc || '',
        fim: rec.fim || '',
        duracao: 0
      }, rec.hora || '');
    }
  }
  function textoRes(r, chegada) {
    if (!r) return '';
    if (r.pendente) return r.motivo || 'A supervisão confirma o horário de embarque.';
    if (!r.ok) {
      var alt = (r.alternativas || []).filter(Boolean);
      return (r.motivo || 'O ônibus não chega a tempo neste horário.') + (alt.length ? ' Nestes horários o trajeto cabe: ' + alt.join(', ') + '.' : ' Nenhum outro horário deste dia comporta o trajeto.');
    }
    var linhas = (r.embarques || []).map(function (e) { return 'Embarque às ' + e.hora + (e.endereco ? ' · ' + e.endereco : ''); });
    if (chegada) linhas.push('Chegada no Sesc às ' + chegada + '.');
    if (r.fim) linhas.push('A mediação vai até ' + r.fim + (r.duracao ? ' (' + r.duracao + ' min)' : '') + '.');
    if (r.embSesc) linhas.push('O grupo embarca no Sesc para voltar às ' + r.embSesc + '.');
    return linhas.join('\n');
  }
  function pintar(f, r, chegada) {
    if (!f) return;
    var box = f.querySelector('[data-logmsg]');
    if (box) box.textContent = textoRes(r, chegada || (f.elements.hora && f.elements.hora.value) || '');
    var manual = f.elements.logmanual && f.elements.logmanual.checked;
    if (r && r.ok && !manual) {
      if (f.elements.fim && r.fim) f.elements.fim.value = r.fim;
      if (f.elements.embOrigem && r.embOrigem) f.elements.embOrigem.value = r.embOrigem;
      if (f.elements.embSesc && r.embSesc) f.elements.embSesc.value = r.embSesc;
    }
    f.dataset.logok = r && r.ok ? '1' : '';
    f.dataset.logpend = r && r.pendente ? '1' : '';
  }
  function endsDe(f) {
    return Array.prototype.map.call(f.querySelectorAll('[name=end]'), function (el) { return el.value.trim(); }).filter(Boolean).slice(0, 4);
  }
  function prever(f) {
    if (!f || f.id === 'logcfg' || f.id === 'logdia' || f.id === 'logkey') return;
    clearTimeout(timers.get(f));
    timers.set(f, setTimeout(function () { preview(f); }, 450));
  }
  async function preview(f) {
    if (!f.elements || !f.elements.transporte || f.elements.transporte.value !== 'Ônibus do Sesc') return;
    var dia = f.elements.data && f.elements.data.value;
    var hora = f.elements.hora && f.elements.hora.value;
    var enderecos = endsDe(f);
    if (!dia || !hora || !enderecos.length || !window.painelLogistica) return;
    try {
      var r = await window.painelLogistica({
        acao: 'calcular', data: dia, hora: hora, enderecos: enderecos,
        alunos: f.elements.alunos ? f.elements.alunos.value : '',
        transporte: 'Ônibus do Sesc', ignoreId: f.dataset.vid || ''
      });
      pintar(f, r, hora);
    } catch (e) {
      var box = f.querySelector('[data-logmsg]');
      if (box) box.textContent = 'Não consegui calcular o trajeto agora. A supervisão pode confirmar o embarque.';
    }
  }
  async function preparar(d, f) {
    if (!f) return '';
    var bus = d.transporte === 'Ônibus do Sesc';
    var ends = endsDe(f);
    d.enderecos = bus ? ends : [];
    d.embarques = [];
    d.busLivreHora = '';
    d.busLivreEndereco = '';
    d.logisticaManual = false;
    d.logisticaPendente = false;
    d.logisticaMotivo = '';
    if (!bus) {
      d.embOrigem = '';
      d.embSesc = '';
      var fimProprio = f.elements.fim && f.elements.fim.value;
      if (!fimProprio && d.hora) fimProprio = maisMin(d.hora, cfgAtual().durPadrao);
      if (fimProprio) d.fim = fimProprio;
      return '';
    }
    if (!ends.length) return 'No ônibus do Sesc, informe o endereço de embarque';
    var manual = !!(f.elements.logmanual && f.elements.logmanual.checked);
    if (manual) {
      d.logisticaManual = true;
      d.embOrigem = f.elements.embOrigem ? f.elements.embOrigem.value : '';
      d.embSesc = f.elements.embSesc ? f.elements.embSesc.value : '';
      d.fim = (f.elements.fim && f.elements.fim.value) || d.embSesc;
      d.embarques = [{ endereco: ends[0], hora: d.embOrigem }];
      d.busLivreHora = d.embSesc;
      d.busLivreEndereco = ends[0];
      if (!d.embOrigem || !d.embSesc) return 'Informe o embarque e a volta, ou desmarque o ajuste manual para o sistema calcular.';
      if (d.hora && d.fim && d.fim <= d.hora) return 'O fim da mediação precisa ser depois do início';
      return '';
    }
    if (!window.painelLogistica) return 'Não consegui calcular o trajeto agora.';
    var r;
    try {
      r = await window.painelLogistica({
        acao: 'calcular', data: d.data, hora: d.hora, enderecos: ends, alunos: d.alunos || '',
        transporte: 'Ônibus do Sesc', ignoreId: f.dataset.vid || ''
      });
    } catch (e) {
      return 'Não consegui calcular o trajeto. Tente de novo ou ajuste os horários à mão.';
    }
    pintar(f, r, d.hora);
    var reserva = OCUPA[d.status || 'Agendado'];
    if (r.pendente) {
      d.logisticaPendente = true;
      d.logisticaMotivo = r.motivo || '';
      d.embOrigem = '';
      d.embSesc = '';
      if (reserva) return (r.motivo || 'O tempo de deslocamento ainda não foi calculado.') + ' Reserve só quando o horário estiver calculado, ou ajuste à mão.';
      return '';
    }
    if (!r.ok) return r.motivo || 'O ônibus não chega a tempo neste horário.';
    d.embarques = r.embarques || [];
    d.embOrigem = r.embOrigem || '';
    d.embSesc = r.embSesc || '';
    d.fim = r.fim || '';
    d.busLivreHora = r.busLivreHora || '';
    d.busLivreEndereco = r.busLivreEndereco || '';
    return '';
  }

  function linha(i) {
    var t = String(i && i.transporte || '').trim();
    if (!t || t === 'Não informado') return '';
    if (t !== 'Ônibus do Sesc') return t;
    var p = [];
    var emb = Array.isArray(i.embarques) ? i.embarques : [];
    if (emb.length) emb.forEach(function (e) { if (e && e.hora) p.push('embarque ' + e.hora + (e.endereco ? ' · ' + e.endereco : '')); });
    else if (i.embOrigem) p.push('embarque na origem ' + i.embOrigem);
    if (i.embSesc) p.push('volta no Sesc ' + i.embSesc);
    if (i.logisticaPendente) p.push('embarque a confirmar');
    return [t].concat(p).join(' · ');
  }

  function painelCard() {
    var c = cfgAtual();
    var url = location.origin + location.pathname + '?visita=1';
    return '<section class="card" id=logcard><h3>Ônibus e horários de visita</h3><p class=d>A lista vale em todos os dias. A grade de uma data, quando existir, substitui a lista só naquele dia. O link público não mostra equipe, status nem pós-visita.</p><p><a href="' + esc(url) + '" target=_blank rel=noopener>' + esc(url) + '</a></p><p><button type=button class="btn g" data-logact=copiar>Copiar link do formulário</button></p><form id=logcfg><label>Endereço do Sesc<input name=enderecoSesc value="' + esc(c.enderecoSesc) + '" placeholder="Rua, número, bairro, Piracicaba"></label><label>Horários da visita (um por linha)<textarea name=horarios rows=4>' + esc(c.horarios.join('\n')) + '</textarea></label><label>Duração padrão da mediação (min)<input name=durPadrao type=number min=20 max=240 value="' + c.durPadrao + '"></label><label>Duração mínima (min)<input name=durMin type=number min=15 max=240 value="' + c.durMin + '"></label><label>Margem por trecho (min)<input name=margem type=number min=0 max=60 value="' + c.margem + '"></label><label>Lotação do ônibus<input name=lotacao type=number min=1 max=80 value="' + c.lotacao + '"></label><button class=btn>Salvar lista geral</button></form><details><summary>Ativar o mapa (só na primeira vez)</summary><p class=d>A conta do trajeto usa o Google, com Geocoding API e Distance Matrix API. A chave fica guardada no banco e o site não mostra de novo. Sem a chave, a instituição envia a solicitação e a supervisão completa o embarque.</p><p><a href="https://console.cloud.google.com/google/maps-apis/start" target=_blank rel=noopener>Abrir as APIs de mapa do Google</a></p><form id=logkey><label>Chave<input name=chave type=password autocomplete=off placeholder="Cole a chave aqui"></label><button class="btn g" type=submit>Salvar chave do mapa</button></form></details><h3 style="margin-top:16px">Grade de um dia</h3><p class=d>Muda os horários de mediação só na data escolhida. Uma visita já reservada não muda sozinha: use Mover para recalcular o embarque e a volta dela.</p><form id=logdia><label>Data<input name=data type=date></label><label>Horários deste dia (um por linha)<textarea name=horarios rows=4></textarea></label><button class=btn>Salvar este dia</button> <button type=button class="btn g" data-logact=limpar-dia>Usar a lista geral neste dia</button></form><div id=logvisitas></div></section>';
  }
  function cfgBody(extra) {
    var c = cfgAtual();
    var body = {
      enderecoSesc: c.enderecoSesc,
      horarios: c.horarios.slice(),
      durPadrao: c.durPadrao,
      durMin: c.durMin,
      margem: c.margem,
      lotacao: c.lotacao,
      grades: Object.assign({}, c.grades)
    };
    return Object.assign(body, extra || {});
  }
  async function gravarCfg(body) {
    if (!API.db) return avisar('Abra o painel de novo para salvar.');
    await API.db().collection('config').doc('logistica').set(body);
    if (API.draw) API.draw();
  }
  function visitasDia(dia) {
    return (API.visitas ? API.visitas() : []).filter(function (v) { return v.data === dia && v.status !== 'Cancelado'; })
      .sort(function (a, b) { return String(a.hora || '').localeCompare(String(b.hora || '')); });
  }
  function desenhaDia(dia) {
    var box = document.getElementById('logvisitas');
    var f = document.getElementById('logdia');
    if (!box || !f) return;
    var c = cfgAtual();
    var horas = (dia && c.grades[dia] && c.grades[dia].length) ? c.grades[dia] : (dia ? c.horarios : []);
    if (f.elements.horarios && document.activeElement !== f.elements.horarios) f.elements.horarios.value = horas.join('\n');
    if (!dia) { box.innerHTML = ''; return; }
    var lista = visitasDia(dia);
    if (!lista.length) { box.innerHTML = '<p class=mut>Nenhuma visita neste dia.</p>'; return; }
    var op = horas.slice();
    box.innerHTML = lista.map(function (v) {
      var opts = op.indexOf(v.hora) < 0 ? [v.hora].concat(op) : op.slice();
      return '<div class=it><div><b>' + esc(v.escola || 'Grupo') + '</b> <span class=tag>' + esc(v.status || '') + '</span><div class=mut>' + esc(v.transporte || '') + (v.logisticaManual ? ' · horário ajustado à mão' : '') + '</div></div><label>Início da mediação<select data-movsel="' + esc(v.id) + '">' + opts.map(function (h) { return '<option' + (h === v.hora ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('') + '</select></label><button type=button class="btn g" data-logact=mover data-id="' + esc(v.id) + '">Mover</button></div>';
    }).join('');
  }
  async function mover(id) {
    var sel = document.querySelector('[data-movsel="' + CSS.escape(id) + '"]');
    var hora = sel ? sel.value : '';
    var v = (API.visitas ? API.visitas() : []).find(function (x) { return x.id === id; });
    if (!v || !horaOk(hora)) return;
    if (hora === v.hora) return avisar('Esse já é o horário da visita.');
    if (v.logisticaManual && API.ask) {
      var ok = await API.ask('Esta visita está com embarque ajustado à mão. Mover o horário recalcula e substitui esse ajuste.');
      if (!ok) return;
    }
    var transporte = v.transporte === 'Ônibus do Sesc' ? 'Ônibus do Sesc' : 'Transporte próprio';
    var enderecos = Array.isArray(v.enderecos) ? v.enderecos : [];
    var r;
    try {
      r = await window.painelLogistica({ acao: 'calcular', data: v.data, hora: hora, enderecos: enderecos, alunos: v.alunos || '', transporte: transporte, ignoreId: id });
    } catch (e) {
      return avisar('Não consegui recalcular esse horário.');
    }
    if (!r.ok && !r.pendente) return avisar(r.motivo || 'O ônibus não chega a tempo nesse horário.');
    if (r.pendente && transporte === 'Ônibus do Sesc') return avisar(r.motivo || 'Ainda não dá para recalcular o ônibus nesse horário.');
    try {
      await API.db().collection('agendamentos').doc(id).update({
        hora: hora,
        fim: r.fim || '',
        embOrigem: transporte === 'Ônibus do Sesc' ? (r.embOrigem || '') : '',
        embSesc: transporte === 'Ônibus do Sesc' ? (r.embSesc || '') : '',
        embarques: transporte === 'Ônibus do Sesc' ? (r.embarques || []) : [],
        busLivreHora: r.busLivreHora || '',
        busLivreEndereco: r.busLivreEndereco || '',
        logisticaPendente: false,
        logisticaManual: false,
        logisticaMotivo: ''
      });
      avisar('Horário deste dia atualizado');
      if (API.draw) API.draw();
      desenhaDia(v.data);
    } catch (e) {
      avisar('Não foi possível salvar o horário.');
    }
  }

  function publico() {
    return '<section class="card vpub"><h2>Pedir uma visita</h2><p class=d>Mediação cultural · Sesc Piracicaba. A supervisão confirma o agendamento. Se o grupo vier no ônibus do Sesc, o formulário calcula o embarque, a volta e se esse horário comporta o trajeto.</p><form id=vpub novalidate><label>Escola ou grupo<input name=escola required autocomplete=organization></label><label>Data<input name=data type=date required></label><label>Horário da visita no Sesc<select name=hora required><option value="">Escolha a data primeiro</option></select></label><label>Nº de pessoas<input name=alunos type=number min=1 max=500></label><label>Tipo de instituição<select name=tipo>' + TIPOS.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('') + '</select></label><label>Faixa etária / ano ou série<input name=serie></label><label>Responsável pelo grupo<input name=resp autocomplete=name></label><label>Telefone<input name=contato type=tel autocomplete=tel required></label><label>Pessoas com deficiência (quantas e qual)<input name=pcd></label><label>Transporte<select name=transporte><option>Transporte próprio</option><option>Ônibus do Sesc</option></select></label><div class=medw data-tr data-ends hidden><label class=chk><input type=checkbox name=varios> Embarque em mais de um endereço, antes de ir ao Sesc</label><div data-endlist>' + rowEnd('') + '</div><p data-maiswrap hidden><button type=button class="btn g" data-logact=mais-end>Incluir outro endereço</button></p><p class=mut data-maiswrap hidden>A conta soma uma margem em cada trecho, para imprevisto.</p></div><div class=medw data-tr hidden data-logres><b class=mlb>Horários do ônibus</b><div class=mut data-logmsg>Ao pedir o ônibus, informe o endereço. O embarque e a volta aparecem aqui.</div></div><label>Observações da visita<textarea name=obs rows=3 placeholder="Acessibilidade, interesses, temas"></textarea></label><div class=cfsb><button class=btn type=submit>Enviar solicitação</button></div></form></section>';
  }
  function bootPublico() {
    var hold = document.getElementById('visita-pub');
    if (!hold) return;
    if (!document.getElementById('vpub')) hold.innerHTML = publico();
    sync(document.getElementById('vpub'));
  }
  async function abrirDia(f) {
    if (!f || !f.elements || !f.elements.data || !f.elements.hora) return;
    var dia = f.elements.data.value;
    var sel = f.elements.hora;
    var atual = sel.value;
    if (!dia) { sel.innerHTML = '<option value="">Escolha a data primeiro</option>'; return; }
    var horas = listaDia(dia).map(function (h) { return { hora: h, ocupado: false }; });
    if (window.painelLogistica) {
      try {
        var r = await window.painelLogistica({ acao: 'abrir', data: dia });
        if (r && Array.isArray(r.horarios) && r.horarios.length) horas = r.horarios;
      } catch (e) {}
    }
    sel.innerHTML = '<option value="">Selecione…</option>' + horas.map(function (h) {
      var hora = typeof h === 'string' ? h : h.hora;
      var ocup = !!(h && h.ocupado);
      return '<option value="' + esc(hora) + '"' + (ocup ? ' disabled' : '') + (hora === atual ? ' selected' : '') + '>' + esc(hora) + (ocup ? ' (reservado)' : '') + '</option>';
    }).join('');
    if (atual) sel.value = atual;
  }
  function coletarPublico(f) {
    function val(n) { return f.elements[n] ? String(f.elements[n].value || '').trim() : ''; }
    return {
      escola: val('escola'), data: val('data'), hora: val('hora'), alunos: val('alunos'), tipo: val('tipo'),
      serie: val('serie'), resp: val('resp'), contato: val('contato'), pcd: val('pcd'), obs: val('obs'),
      transporte: val('transporte') === 'Ônibus do Sesc' ? 'Ônibus do Sesc' : 'Transporte próprio',
      enderecos: endsDe(f)
    };
  }
  function sucesso(r) {
    var hold = document.getElementById('visita-pub');
    if (!hold) return;
    var extra = '';
    if (r && r.embOrigem) extra = '<p>' + esc(textoRes(r, r.hora || '')) + '</p>';
    else if (r && r.pendente) extra = '<p>A supervisão confirma o horário de embarque.</p>';
    hold.innerHTML = '<section class="card vpub"><h2>Solicitação enviada</h2><p>A supervisão recebe o pedido e confirma a visita. Este envio ainda não reserva o horário.</p>' + extra + '<p><button type=button class=btn data-logact=outra>Enviar outra solicitação</button></p></section>';
  }
  async function enviarPublico(f) {
    var d = coletarPublico(f);
    if (d.escola.length < 2) return avisar('Informe a escola ou o grupo.');
    if (!d.data) return avisar('Informe a data.');
    if (!d.hora) return avisar('Escolha um horário.');
    if (!d.contato) return avisar('Informe um telefone.');
    if (d.transporte === 'Ônibus do Sesc' && !d.enderecos.length) return avisar('Informe o endereço de embarque.');
    var bt = f.querySelector('button[type=submit]');
    if (bt) { bt.disabled = true; bt.textContent = 'Enviando…'; }
    try {
      var r = await window.painelLogistica(Object.assign({ acao: 'enviar' }, d));
      r.hora = d.hora;
      sucesso(r);
    } catch (e) {
      if (e && e.status === 409) {
        avisar(e.message);
        if (bt) { bt.disabled = false; bt.textContent = 'Enviar solicitação'; }
        return;
      }
      var rede = !e || !e.status || e.status === 404 || e.status >= 500;
      if (rede && window.painelSolicitarVisita) {
        try {
          await window.painelSolicitarVisita(Object.assign({}, d, { logisticaMotivo: 'A supervisão confirma o horário de embarque.' }));
          sucesso({ pendente: true });
          return;
        } catch (e2) {}
      }
      avisar((e && e.message) || 'Não foi possível enviar a solicitação.');
      if (bt) { bt.disabled = false; bt.textContent = 'Enviar solicitação'; }
    }
  }

  function onChange(e) {
    var f = e.target.closest && e.target.closest('form');
    if (!f) return;
    if (f.id === 'logdia' && e.target.name === 'data') { desenhaDia(e.target.value); return; }
    if (e.target.name === 'data' && f.id === 'vpub') abrirDia(f);
    if (e.target.name === 'varios' || e.target.name === 'logmanual' || e.target.name === 'data' || e.target.name === 'transporte') sync(f);
    if (['data', 'hora', 'transporte', 'alunos', 'varios'].indexOf(e.target.name) >= 0) prever(f);
  }
  function onInput(e) {
    var f = e.target.closest && e.target.closest('form');
    if (!f) return;
    if (f.id === 'logcfg') f.dataset.user = '1';
    if (e.target.name === 'end') prever(f);
  }
  async function onSubmit(e) {
    var f = e.target;
    if (!f || !f.id) return;
    if (f.id === 'vpub') { e.preventDefault(); e.stopPropagation(); return enviarPublico(f); }
    if (f.id === 'logcfg') {
      e.preventDefault(); e.stopPropagation();
      var horarios = parseHoras(f.horarios.value);
      if (!horarios.length) return avisar('Informe ao menos um horário, no formato 09:00.');
      var body = cfgBody({
        enderecoSesc: f.enderecoSesc.value.trim(),
        horarios: horarios,
        durPadrao: num(f.durPadrao.value, 60, 20, 240),
        durMin: num(f.durMin.value, 40, 15, 240),
        margem: num(f.margem.value, 10, 0, 60),
        lotacao: num(f.lotacao.value, 40, 1, 80)
      });
      if (body.durMin > body.durPadrao) return avisar('A duração mínima não pode passar da duração padrão.');
      try { await gravarCfg(body); avisar('Lista de horários salva'); }
      catch (err) { avisar('Não foi possível salvar a lista.'); }
      return;
    }
    if (f.id === 'logdia') {
      e.preventDefault(); e.stopPropagation();
      var dia = f.elements.data.value;
      var hs = parseHoras(f.elements.horarios.value);
      if (!dia) return avisar('Escolha a data.');
      if (!hs.length) return avisar('Informe ao menos um horário neste dia.');
      var atual = cfgBody();
      atual.grades[dia] = hs;
      var fora = visitasDia(dia).filter(function (v) { return OCUPA[v.status] && hs.indexOf(v.hora) < 0; });
      try {
        await gravarCfg(atual);
        avisar(fora.length ? 'Grade do dia salva. ' + fora.length + ' visita(s) já reservada(s) ficaram fora da grade, até você mover o horário.' : 'Grade deste dia salva');
        desenhaDia(dia);
      } catch (err) { avisar('Não foi possível salvar a grade do dia.'); }
      return;
    }
    if (f.id === 'logkey') {
      e.preventDefault(); e.stopPropagation();
      var chave = (f.chave.value || '').trim();
      if (chave.length < 20) return avisar('Cole a chave completa.');
      try {
        await window.painelSalvarChaveMapa(chave);
        f.reset();
        avisar('Mapa ativado. Já dá para calcular o embarque.');
      } catch (err) { avisar('Não foi possível salvar a chave.'); }
    }
  }
  function onClick(e) {
    var b = e.target.closest && e.target.closest('[data-logact]');
    if (!b) return;
    var act = b.dataset.logact;
    var f = b.closest('form');
    if (act === 'copiar') {
      var url = location.origin + location.pathname + '?visita=1';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { avisar('Link copiado'); }, function () { avisar(url); });
      else avisar(url);
      return;
    }
    if (act === 'mais-end') {
      e.preventDefault();
      var list = f && f.querySelector('[data-endlist]');
      if (!list || list.querySelectorAll('[name=end]').length >= 4) return avisar('O embarque aceita até 4 endereços.');
      list.insertAdjacentHTML('beforeend', rowEnd(''));
      return;
    }
    if (act === 'tirar-end') {
      e.preventDefault();
      var rows = f ? f.querySelectorAll('.endrow') : [];
      if (rows.length <= 1) { var inp = b.closest('.endrow').querySelector('input'); if (inp) inp.value = ''; return; }
      b.closest('.endrow').remove();
      if (f) prever(f);
      return;
    }
    if (act === 'limpar-dia') {
      e.preventDefault();
      var diaF = document.getElementById('logdia');
      var dia = diaF && diaF.elements.data.value;
      if (!dia) return avisar('Escolha a data.');
      var body = cfgBody();
      delete body.grades[dia];
      gravarCfg(body).then(function () { avisar('Este dia voltou a usar a lista geral'); desenhaDia(dia); }, function () { avisar('Não foi possível atualizar o dia.'); });
      return;
    }
    if (act === 'mover') { e.preventDefault(); mover(b.dataset.id); return; }
    if (act === 'outra') { var hold = document.getElementById('visita-pub'); if (hold) { hold.innerHTML = publico(); } }
  }

  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('click', onClick);
  if (!document.getElementById('log-css')) {
    var s = document.createElement('style');
    s.id = 'log-css';
    s.textContent = '.vpub{max-width:760px;margin:0 auto}.vpub h2{font-family:Bevan,Georgia,serif;font-weight:400;color:#2d2e5f;font-size:1.6rem}[data-logmsg]{white-space:pre-wrap}.endrow{display:flex;gap:8px;align-items:end}.endrow label{flex:1}.endrow .btn{flex:none}#logvisitas .it{align-items:end}html.sovis nav,html.sovis #wa,html.sovis #authbtn,html.sovis .vsel{display:none!important}html.sovis [data-hhome]{cursor:default}';
    document.head.appendChild(s);
  }

  window.LOG = {
    fld: fld,
    sync: sync,
    hidratar: hidratar,
    preparar: preparar,
    linha: linha,
    painelCard: painelCard,
    bootPublico: bootPublico,
    ligar: function (o) { API = o || {}; },
    cfgChegou: function () {
      var f = document.getElementById('logcfg');
      var c = cfgAtual();
      if (f && f.dataset.user !== '1' && c.salvo) {
        if (document.activeElement !== f.enderecoSesc) f.enderecoSesc.value = c.enderecoSesc;
        if (document.activeElement !== f.horarios) f.horarios.value = c.horarios.join('\n');
        f.durPadrao.value = c.durPadrao;
        f.durMin.value = c.durMin;
        f.margem.value = c.margem;
        f.lotacao.value = c.lotacao;
      }
      document.querySelectorAll('form').forEach(sync);
      var dia = document.querySelector('#logdia [name=data]');
      if (dia && dia.value) desenhaDia(dia.value);
      var pub = document.getElementById('vpub');
      if (pub && pub.elements.data && pub.elements.data.value) abrirDia(pub);
    }
  };
})();
