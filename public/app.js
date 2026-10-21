// BombPot Tracker: painel de filtros (estilo H2N) -> POST /api/consulta -> caixas de resultado.

const SIM_NAO = { 1: 'Sim', 0: 'Não' };
// Grupos e rótulos dos filtros. tipo: lista (chips), faixa (min/max), faixas (tamanho em fração do pote).
const GRUPOS = [
  ['Jogador', [
    ['hero', 'Quem', 'lista', { 0: 'População', 1: 'Hero' }],
    ['pos', 'Posição', 'lista'],
    ['pos_rel', 'Ordem na rua', 'lista'],
    ['ip', 'Posição na rua', 'lista', { 1: 'IP (último)', 0: 'OOP' }],
  ]],
  ['Rua e situação', [
    ['rua', 'Rua', 'lista'],
    ['situacao', 'Situação', 'lista'],
    ['tamanho_enfrentado', 'Tamanho da aposta enfrentada (× pote)', 'faixas'],
    ['decisao_n', 'Vez que age na rua', 'lista', { 1: '1ª', 2: '2ª', 3: '3ª', 4: '4ª', 5: '5ª' }],
    ['checou_antes', 'Checou antes na rua (check-raise / check-call)', 'lista', SIM_NAO],
  ]],
  ['Linha da mão', [
    ['agressor_anterior', 'Foi o agressor da rua anterior', 'lista', SIM_NAO],
    ['rua_anterior_checada', 'Rua anterior checada por todos', 'lista', SIM_NAO],
    ['acao_anterior', 'O que ele fez na rua anterior', 'lista'],
    ['linha_flop', 'Linha dele no flop (X check, B bet, C call, R raise)', 'lista'],
    ['linha_turn', 'Linha dele no turn', 'lista'],
  ]],
  ['Mesa e stacks', [
    ['n_jogadores', 'Jogadores na mão', 'faixa'],
    ['n_vivos', 'Ainda na mão no começo da rua', 'faixa'],
    ['pote', 'Pote antes da ação (BB)', 'faixa'],
    ['spr', 'SPR (stack efetivo / pote da rua)', 'faixa'],
    ['data', 'Período', 'datas'],
  ]],
  ['Board', [
    ['naipes_flop', 'Naipes do flop', 'lista'],
    ['flop_alta', 'Carta mais alta do flop', 'lista'],
    ['flop_pareado', 'Flop pareado', 'lista', SIM_NAO],
    ['flop_conectado', 'Flop conectado', 'lista', SIM_NAO],
    ['board_pareado', 'Board pareado até esta rua', 'lista', SIM_NAO],
    ['board_flush', 'Flush possível até esta rua', 'lista', SIM_NAO],
    ['texturas', 'Carta do turn / river (qualquer uma das marcadas)', 'tags'],
  ]],
  ['Ação e mão', [
    ['acao', 'Ação', 'lista'],
    ['tamanho', 'Tamanho da própria aposta (× pote)', 'faixas'],
    ['allin', 'All-in', 'lista', SIM_NAO],
    ['forca', 'Força da mão (categorias do H2N; só com cartas conhecidas)', 'lista'],
    ['draw', 'Draw (flop e turn)', 'lista'],
    ['weak', 'Mão weak (blefe / ar)', 'lista', SIM_NAO],
    ['marcada', 'Mão com seguro/jackpot', 'lista', SIM_NAO],
  ]],
  ['Resultado', [
    ['resposta', 'Resposta da mesa ao bet/raise dele', 'lista'],
    ['sd', 'Foi ao showdown', 'lista', SIM_NAO],
    ['ganhou', 'Ganhou a mão', 'lista', SIM_NAO],
  ]],
];
const DEF = Object.fromEntries(GRUPOS.flatMap(([, fs]) => fs.map(f => [f[0], f])));
const rotulo = (col, v) => (DEF[col][3] && DEF[col][3][v]) ?? String(v);

const PRESETS = {
  'Flop: tamanho da aposta (ninguém apostou)': { rua: ['flop'], situacao: ['livre'], acao: ['Bet'] },
  'Flop: contra aposta (fold / call / raise)': { rua: ['flop'], situacao: ['enfrenta aposta'] },
  'Flop: check-raise': { rua: ['flop'], situacao: ['enfrenta aposta'], checou_antes: [1] },
  'Turn: c-bet do agressor do flop': { rua: ['turn'], situacao: ['livre'], agressor_anterior: [1] },
  'Turn: probe depois do flop checado': { rua: ['turn'], situacao: ['livre'], rua_anterior_checada: [1] },
  'River: contra aposta': { rua: ['river'], situacao: ['enfrenta aposta'] },
  'Flop: o que a população mostra depois de raise': { rua: ['flop'], acao: ['Raise'], hero: [0] },
};
const AMOSTRA_MINIMA = 30;
// Ordem de leitura de poker, não alfabética; o que não está aqui vai ao fim na ordem do banco.
const ORDEM = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'flop', 'turn', 'river',
  'livre', 'enfrenta aposta', 'enfrenta raise', '1º a agir', 'meio', 'último', 'Check', 'Bet', 'Call', 'Raise', 'Fold',
  'rainbow', 'two-tone', 'monotone', 'A', 'K', 'Q', 'J', 'T-', 1, 0];
// Intervalo de confiança de Wilson, 95%, em pontos percentuais.
function wilson(n, total) {
  if (!total) return [0, 0];
  const z = 1.96, p = n / total, z2 = z * z / total;
  const centro = (p + z2 / 2) / (1 + z2);
  const meia = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total)) / (1 + z2);
  return [Math.max(0, 100 * (centro - meia)), Math.min(100, 100 * (centro + meia))];
}
const ordenar = (vs, col) => {
  const ordem = col === 'hero' ? [0, 1] : ORDEM;
  return [...vs].sort((a, b) => (ordem.indexOf(a) + 1 || 999) - (ordem.indexOf(b) + 1 || 999));
};

const $ = id => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const lerLocal = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const gravarLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } };

let opcoes = null;
let filtros = {};

// --- painel de filtros ------------------------------------------------------------------

function montarFiltros() {
  const raiz = $('filtros');
  raiz.replaceChildren();
  for (const [titulo, fs] of GRUPOS) {
    const cont = el('span', { className: 'n' });
    const det = el('details', { open: !['Board', 'Linha da mão', 'Resultado'].includes(titulo) },
      [el('summary', {}, [titulo, cont])]);
    det.dataset.grupo = titulo;
    for (const [col, nome, tipo] of fs) {
      const caixa = el('div', { className: 'filtro' }, [el('label', { textContent: nome })]);
      if (tipo === 'datas') {
        const [mn, mx] = opcoes.datas ?? [];
        const entrada = (lado, chave) => el('input', {
          type: 'date', min: mn ?? '', max: mx ?? '', value: filtros[col]?.[chave] ?? '', 'aria-label': `${nome} ${lado}`,
          onchange: e => {
            const f = { ...(filtros[col] ?? {}), [chave]: e.target.value };
            if (!f.min && !f.max) delete filtros[col]; else filtros[col] = f;
            mudou();
          },
        });
        caixa.append(el('div', { className: 'faixa' }, [entrada('de', 'min'), 'até', entrada('até', 'max')]));
      } else if (tipo === 'faixa') {
        const [mn, mx] = opcoes.faixa[col] ?? [];
        const entrada = lado => el('input', {
          type: 'number', step: 'any', placeholder: `${lado} ${lado === 'mín' ? fmt(mn) : fmt(mx)}`,
          value: filtros[col]?.[lado === 'mín' ? 'min' : 'max'] ?? '', 'aria-label': `${nome} ${lado}`,
          onchange: e => {
            const f = { ...(filtros[col] ?? {}) };
            f[lado === 'mín' ? 'min' : 'max'] = e.target.value;
            if (!f.min && !f.max) delete filtros[col]; else filtros[col] = f;
            mudou();
          },
        });
        caixa.append(el('div', { className: 'faixa' }, [entrada('mín'), 'até', entrada('máx')]));
      } else {
        const valores = tipo === 'faixas' ? opcoes.faixas : tipo === 'tags' ? opcoes.tags : ordenar(opcoes.lista[col] ?? [], col);
        const chips = el('div', { className: 'chips' });
        for (const v of valores) {
          const ativo = (filtros[col] ?? []).includes(v);
          chips.append(el('button', {
            className: 'chip', type: 'button', textContent: rotulo(col, v),
            ariaPressed: String(ativo),
            onclick: () => {
              const atual = new Set(filtros[col] ?? []);
              atual.has(v) ? atual.delete(v) : atual.add(v);
              if (atual.size) filtros[col] = [...atual]; else delete filtros[col];
              mudou();
            },
          }));
        }
        caixa.append(chips);
      }
      det.append(caixa);
    }
    const n = fs.filter(f => filtros[f[0]] !== undefined).length;
    cont.textContent = n ? `${n} ativo${n > 1 ? 's' : ''}` : '';
    raiz.append(det);
  }
}

const fmt = v => (v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 }));

function mudou() {
  // os <details> abertos ficam como estavam
  const antes = [...document.querySelectorAll('#filtros details')];
  const abertos = new Set(antes.filter(d => d.open).map(d => d.dataset.grupo));
  montarFiltros();
  montarAgrupar();
  if (antes.length) for (const d of document.querySelectorAll('#filtros details')) d.open = abertos.has(d.dataset.grupo);
  history.replaceState(null, '', Object.keys(filtros).length ? '#' + encodeURIComponent(JSON.stringify(filtros)) : '#');
  consultar();
}

// --- resultado ---------------------------------------------------------------------------

// Painel de tendencias: as stats prontas do servidor (PAINEL em servidor.py) sobre os filtros atuais.
let vista = lerLocal('bp.vista') === 'painel' ? 'painel' : 'filtros';
function trocarVista(v) {
  vista = v;
  gravarLocal('bp.vista', v);
  $('agrupar').hidden = v === 'painel';
  $('vista').textContent = v === 'painel' ? 'Ver filtros' : 'Painel de tendências';
  consultar();
}

async function consultarPainel(meu) {
  const r = await (await fetch('/api/painel', { method: 'POST', body: JSON.stringify(filtros) })).json();
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (!Array.isArray(r)) { $('resumo').textContent = 'Erro: ' + (r.erro ?? 'resposta inesperada'); return; }
  $('resumo').textContent = 'Painel de tendências: clique numa linha para abrir o spot nos filtros. '
    + 'Os filtros ligados (posição, mesa, período…) valem para todas as stats.';
  const secoes = {};
  for (const s of r) (secoes[s.secao] ??= []).push(s);
  $('caixas').replaceChildren(...Object.entries(secoes).map(([secao, stats]) => {
    const linhas = stats.map(s => {
      const tr = el('tr', { className: 'clicavel', tabIndex: 0, title: 'Abrir este spot nos filtros' }, [
        el('th', { textContent: s.nome }),
        celulaPct(...(s.pop ?? [0, 0])), celulaPct(...(s.hero ?? [0, 0]), 'col-hero')]);
      tr.onclick = tr.onkeydown = e => {
        if (e.type !== 'click' && e.key !== 'Enter') return;
        filtros = { ...filtros, ...structuredClone(s.base) };
        trocarVista('filtros');
        mudou();
      };
      return tr;
    });
    return el('div', { className: 'caixa painel' }, [el('h2', { textContent: secao }),
      tabela(['', 'População', 'Hero'], linhas)]);
  }));
}

// Comparar: o filtro fixado como A contra o filtro atual (B), para a população.
let filtroA = lerLocal('bp.filtroA');
async function caixaComparar(r) {
  const a = await (await fetch('/api/consulta', { method: 'POST', body: JSON.stringify(filtroA) })).json();
  const linhas = [];
  const bloco = (titulo, da, db, chaves) => {
    const ta = Object.values(da.pop).reduce((s, n) => s + n, 0), tb = Object.values(db.pop).reduce((s, n) => s + n, 0);
    linhas.push(el('tr', {}, [el('th', { className: 'sub-th', textContent: titulo, colSpan: 4 })]));
    for (const k of chaves.filter(k => da.pop[k] || db.pop[k])) {
      const pa = ta ? 100 * (da.pop[k] ?? 0) / ta : 0, pb = tb ? 100 * (db.pop[k] ?? 0) / tb : 0, d = pb - pa;
      linhas.push(el('tr', {}, [el('th', { textContent: k }), celulaPct(da.pop[k] ?? 0, ta), celulaPct(db.pop[k] ?? 0, tb),
        el('td', { className: d >= 0 ? 'ev-pos' : 'ev-neg' }, [el('span', { className: 'v', textContent: `${d >= 0 ? '+' : ''}${Math.round(d)}` })])]));
    }
  };
  bloco('Ações', a.acoes, r.acoes, ['Check', 'Bet', 'Call', 'Raise', 'Fold']);
  bloco('Tamanho da aposta', a.bet, r.bet, opcoes.faixas);
  const nomeA = Object.entries(filtroA).filter(([c]) => c !== '_agrupar')
    .map(([c, v]) => `${DEF[c]?.[1] ?? c}: ${Array.isArray(v) ? v.map(x => rotulo(c, x)).join(', ') : `${v.min || '…'} a ${v.max || '…'}`}`).join(' · ') || 'sem filtros';
  return el('div', { className: 'caixa', style: 'flex-basis:100%' }, [
    el('h2', {}, ['Comparar A × atual ', el('small', { textContent: `população · A = ${nomeA}` })]),
    tabela(['', 'A', 'Atual', 'Diferença (pontos)'], linhas)]);
}

let pedido = 0;
async function consultar() {
  const meu = ++pedido;
  mostrarAtivos();
  document.body.classList.add('carregando');
  if (vista === 'painel') return consultarPainel(meu);
  const res = await fetch('/api/consulta', { method: 'POST', body: JSON.stringify(filtros) });
  const r = await res.json();
  if (meu !== pedido) return; // chegou uma consulta mais nova enquanto esta voltava
  document.body.classList.remove('carregando');
  if (r.erro) { $('resumo').textContent = 'Erro: ' + r.erro; return; }
  const t = q => r.total[q] ?? { decisoes: 0, maos: 0 };
  $('resumo').innerHTML = `População: <b>${t('pop').decisoes.toLocaleString('pt-BR')}</b> decisões em `
    + `<b>${t('pop').maos.toLocaleString('pt-BR')}</b> mãos · Hero: <b>${t('hero').decisoes.toLocaleString('pt-BR')}</b> decisões`;
  $('caixas').replaceChildren(
    ...(r.agrupado ? caixasAgrupado(r.agrupado) : []),
    caixaDistribuicao('Ações', r.acoes, ['Check', 'Bet', 'Call', 'Raise', 'Fold'], 'das decisões'),
    caixaDistribuicao('Tamanho da aposta (Bet)', r.bet, opcoes.faixas, '× pote · % das apostas', true,
      allinNota(r.allin, 'Bet')),
    caixaDistribuicao('Tamanho do raise', r.raise, opcoes.faixas, 'aumento ÷ pote depois de pagar', true,
      allinNota(r.allin, 'Raise')),
    caixaResposta(r.resposta),
    caixaResultado(r.resultado),
    caixaForca(r),
    caixaDistribuicao('Draws', r.draw, opcoes.draws, 'flop e turn · entre as decisões com draw'),
    caixaMaos(r.maos),
  );
  if (filtroA) $('caixas').prepend(await caixaComparar(r));
}

function allinNota(allin, acao) {
  const p = allin.pop[acao] ?? 0, h = allin.hero[acao] ?? 0;
  return p || h ? `All-in: ${p} da população, ${h} do Hero.` : '';
}

const pct = (n, t) => (t ? `${Math.round(100 * n / t)}%` : '—');
const nomeQuem = q => (q === 'pop' ? 'População' : 'Hero');

function celulaPct(n, total, extra = '') {
  const [lo, hi] = wilson(n, total);
  const td = el('td', { className: extra + (total < AMOSTRA_MINIMA ? ' fraca' : ''),
    title: total ? `${n} de ${total} · IC 95%: ${Math.round(lo)}–${Math.round(hi)}%` : '' });
  td.append(el('span', { className: 'v', textContent: pct(n, total) }), el('span', { className: 's', textContent: String(total) }));
  return td;
}

function tabela(cabecalho, linhas) {
  return el('table', {}, [el('thead', {}, [el('tr', {}, cabecalho.map(h => el('th', { textContent: h })))]),
    el('tbody', {}, linhas)]);
}

const ACOES_ORDEM = ['Check', 'Bet', 'Call', 'Raise', 'Fold'];
function caixasAgrupado(ag) {
  const nome = DEF[ag.coluna]?.[1] ?? ag.coluna;
  return ['pop', 'hero'].filter(q => Object.keys(ag[q]).length).map(q => {
    const valor = k => (isNaN(k) ? k : Number(k));
    const chaves = DEF[ag.coluna]?.[2] === 'faixas' ? opcoes.faixas.filter(k => ag[q][k])
      : ordenar(Object.keys(ag[q]).map(valor), ag.coluna).map(String);
    // coluna de acao que e zero em todas as linhas so ocupa espaco (ex.: Call quando ninguem apostou)
    const acoesVistas = ACOES_ORDEM.filter(a => chaves.some(k => ag[q][k][a]));
    const linhas = chaves.map(k => {
      const acoes = ag[q][k], total = ACOES_ORDEM.reduce((s, a) => s + (acoes[a] ?? 0), 0);
      const [fr, conh] = acoes._weak ?? [0, 0];
      return el('tr', {}, [el('th', { textContent: rotulo(ag.coluna, valor(k)) }),
        el('td', {}, [el('span', { className: 'v', textContent: String(total) })]),
        ...acoesVistas.map(a => celulaPct(acoes[a] ?? 0, total)), celulaPct(fr, conh)]);
    });
    return el('div', { className: 'caixa', style: 'flex-basis:100%' }, [
      el('h2', {}, [`${nomeQuem(q)} agrupada por ${nome} `, el('small', { textContent: '% das decisões de cada linha · Weak% entre as mãos com cartas conhecidas' })]),
      el('div', { className: 'rolar' }, [tabela(['', 'Decisões', ...acoesVistas, 'Weak'], linhas)])]);
  });
}

function caixaResposta(resp) {
  const caixa = el('div', { className: 'caixa' }, [el('h2', {}, ['Resposta ao sizing ',
    el('small', { textContent: 'o que a mesa fez depois do bet · EV do blefe puro em % do pote' })])]);
  let algum = false;
  for (const acao of ['Bet', 'Raise']) for (const q of ['pop', 'hero']) {
    const dados = resp[acao]?.[q];
    if (!dados) continue;
    algum = true;
    const linhas = opcoes.faixas.filter(f => dados[f]).map(f => {
      const d = dados[f], total = (d['todos foldam'] ?? 0) + (d.pago ?? 0) + (d.aumentado ?? 0);
      const ev = total ? 100 * d.ev / total : 0;
      return el('tr', {}, [el('th', { textContent: f }), celulaPct(d['todos foldam'] ?? 0, total),
        celulaPct(d.pago ?? 0, total), celulaPct(d.aumentado ?? 0, total),
        el('td', { className: (ev >= 0 ? 'ev-pos' : 'ev-neg') + (total < AMOSTRA_MINIMA ? ' fraca' : ''),
          title: 'EV = F×100 − (1−F)×tamanho×100, F = todos foldam' },
          [el('span', { className: 'v', textContent: `${ev >= 0 ? '+' : ''}${Math.round(ev)}` })])]);
    });
    caixa.append(el('p', { className: 'sub', textContent: `${acao} · ${nomeQuem(q)}` }),
      tabela(['× pote', 'Todos foldam', 'Pago', 'Aumentado', 'EV blefe'], linhas));
  }
  if (!algum) caixa.append(el('p', { className: 'nota', textContent: 'Sem bet/raise com estes filtros.' }));
  return caixa;
}

function caixaResultado(res) {
  const linha = (nome, f) => el('tr', {}, [el('th', { textContent: nome }), ...['pop', 'hero'].map(q => f(res[q], q))]);
  const vazio = () => el('td', { textContent: '—' });
  const lucro = (x, q) => (x && x.n_lucro ? el('td', {
    className: (q === 'hero' ? 'col-hero' : '') + (x.n_lucro < AMOSTRA_MINIMA ? ' fraca' : '') }, [
    el('span', { className: 'v', textContent: (x.lucro >= 0 ? '+' : '') + fmt(x.lucro) }),
    el('span', { className: 's', textContent: String(x.n_lucro) })]) : vazio());
  return el('div', { className: 'caixa' }, [
    el('h2', {}, ['Resultado ', el('small', { textContent: 'a partir da decisão (a entrada já investida não conta)' })]),
    tabela(['', 'População', 'Hero'], [
      linha('Lucro médio (BB)', lucro),
      linha('Foi ao showdown (WTSD)', (x, q) => (x ? celulaPct(x.sd, x.n, q === 'hero' ? 'col-hero' : '') : vazio())),
      linha('Ganhou no showdown (W$SD)', (x, q) => (x ? celulaPct(x.wsd, x.n_wsd, q === 'hero' ? 'col-hero' : '') : vazio())),
    ]),
    el('p', { className: 'nota', textContent: 'Mãos com seguro/jackpot ficam fora do lucro e do W$SD.' })]);
}

function caixaForca(r) {
  const caixa = caixaDistribuicao('Força da mão', r.forca, opcoes.forcas, 'categorias do H2N, por rua', false,
    'População: só aparece quem mostrou no showdown, então a amostra puxa para mãos fortes. '
    + 'Weak = A-high, overcards, trash, draw que não chegou e par baixo.');
  const linha = q => {
    const w = r.weak[q]['1'] ?? 0, total = w + (r.weak[q]['0'] ?? 0);
    if (!total) return `${q === 'pop' ? 'População' : 'Hero'}: —`;
    const [lo, hi] = wilson(w, total);
    return `${q === 'pop' ? 'População' : 'Hero'}: ${Math.round(100 * w / total)}% weak (${Math.round(lo)}–${Math.round(hi)}%, ${total} mãos)`;
  };
  const w = r.weak.pop['1'] ?? 0, total = w + (r.weak.pop['0'] ?? 0);
  caixa.querySelector('h2').after(
    el('div', { className: 'weak', title: 'Barra: parte verde = weak (blefe/ar) entre as mãos com cartas conhecidas' }, [
      el('div', { className: 'barra-weak' }, [el('div', { style: `width:${total ? 100 * w / total : 0}%` })]),
      el('p', { className: 'nota', textContent: `${linha('pop')} · ${linha('hero')}` })]));
  return caixa;
}

function caixaDistribuicao(titulo, dados, chaves, sub, marcarMax = false, nota = '') {
  const soma = q => Object.values(dados[q]).reduce((a, b) => a + b, 0);
  const tot = { pop: soma('pop'), hero: soma('hero') };
  const linhas = chaves.filter(k => dados.pop[k] || dados.hero[k]);
  const max = marcarMax && linhas.length ? linhas.reduce((a, k) => ((dados.pop[k] ?? 0) > (dados.pop[a] ?? 0) ? k : a)) : null;
  const cel = (q, k) => {
    const n = dados[q][k] ?? 0, total = tot[q];
    const [lo, hi] = wilson(n, total);
    const td = el('td', { className: (q === 'hero' ? 'col-hero' : '') + (total < AMOSTRA_MINIMA ? ' fraca' : ''),
      title: total ? `${n} de ${total} · IC 95%: ${Math.round(lo)}–${Math.round(hi)}%` : '' });
    td.append(el('span', { className: 'v', textContent: total ? `${Math.round(100 * n / total)}%` : '—' }),
      el('span', { className: 's', textContent: String(n) }));
    return td;
  };
  const corpo = el('tbody');
  for (const k of linhas) {
    const pct = q => (tot[q] ? 100 * (dados[q][k] ?? 0) / tot[q] : 0);
    corpo.append(el('tr', { className: k === max ? 'max' : '' }, [
      el('th', { textContent: k }), cel('pop', k), cel('hero', k),
      el('td', { className: 'barra' }, [
        el('div', { style: `width:${pct('pop')}%` }), el('div', { className: 'hero', style: `width:${pct('hero')}%` })]),
    ]));
  }
  const caixa = el('div', { className: 'caixa' }, [el('h2', {}, [titulo + ' ', el('small', { textContent: sub })])]);
  if (!linhas.length) caixa.append(el('p', { className: 'nota', textContent: 'Nada com estes filtros.' }));
  else caixa.append(el('table', {}, [
    el('thead', {}, [el('tr', {}, [el('th'), el('th', { textContent: `População (${tot.pop})` }),
      el('th', { textContent: `Hero (${tot.hero})` }), el('th')])]), corpo]));
  if (nota) caixa.append(el('p', { className: 'nota', textContent: nota }));
  return caixa;
}

const NAIPE = { s: '♠', h: '♥', d: '♦', c: '♣' };
// Cartas com o naipe em símbolo e cor (4 cores, como o H2N): "Kc 10h" -> K♣ 10♥
function cartasEl(texto) {
  const span = el('span', { className: 'cartas' });
  for (const c of (texto ?? '').split(' ').filter(Boolean)) {
    span.append(el('span', { className: 'naipe-' + c.slice(-1), textContent: c.slice(0, -1) + (NAIPE[c.slice(-1)] ?? '?') }));
  }
  return span;
}

// A mão numa linha, rua por rua: board (pote) e as ações; as do jogador da linha ficam destacadas.
function linhaMao(m) {
  const td = el('td', { className: 'linha-mao' });
  for (const [rua, board, pote, acoes] of m.linha) {
    td.append(el('span', { className: 'rua' }, [cartasEl(board), el('small', { textContent: ` (${fmt(pote)}) ` }),
      ...acoes.map(([pos, a]) => el('span', { className: pos === m.pos ? 'eu' : '', title: pos, textContent: a + ' ' }))]));
  }
  return td;
}

function caixaMaos(maos) {
  const corpo = el('tbody');
  for (const m of maos) {
    const tam = m.tamanho === null ? '' : ` ${fmt(m.tamanho)}×${m.allin ? "'" : ''}`;
    const tr = el('tr', { tabIndex: 0, title: 'Abrir o print' }, [
      el('td', { textContent: m.data ?? '' }),
      el('td', { textContent: m.pos + (m.hero ? ' (Hero)' : '') }),
      el('td', {}, [cartasEl(m.cartas)]),
      el('td', { textContent: `${m.rua} ${m.acao}${tam}` }),
      el('td', { textContent: m.forca ?? '' }),
      linhaMao(m),
    ]);
    tr.onclick = tr.onkeydown = e => { if (e.type === 'click' || e.key === 'Enter') abrirPrint(m); };
    corpo.append(tr);
  }
  return el('div', { className: 'caixa', style: 'flex-basis:100%' }, [
    el('h2', {}, ['Mãos ', el('small', { textContent: `as ${maos.length} mais recentes · X check, B bet, C call, R raise, F fold, ' all-in, valores em BB · clique para ver o print` })]),
    el('div', { className: 'maos' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Data', 'Posição', 'Cartas', 'Decisão', 'Força', 'Mão']
        .map(t => el('th', { textContent: t })))]), corpo])]),
  ]);
}

function abrirPrint(m) {
  $('print-titulo').textContent = `Mão ${m.hand_id} · ${m.rua} · ${m.pos}`;
  $('print-img').src = '/print/' + encodeURIComponent(m.png);
  $('print').showModal();
}

function montarAgrupar() {
  const s = $('agrupar');
  const cols = GRUPOS.flatMap(([, fs]) => fs).filter(f => ['lista', 'faixas'].includes(f[2]));
  s.replaceChildren(el('option', { value: '', textContent: 'Agrupar por…' }),
    ...cols.map(([c, nome]) => el('option', { value: c, textContent: nome, selected: filtros._agrupar === c })));
  s.onchange = () => { if (s.value) filtros._agrupar = s.value; else delete filtros._agrupar; mudou(); };
}

function mostrarAtivos() {
  const box = $('ativos');
  box.replaceChildren();
  const ativos = Object.entries(filtros).filter(([c]) => c !== '_agrupar');
  if (!ativos.length) { box.append(el('span', { className: 'vazio', textContent: 'Sem filtros: todas as decisões.' })); return; }
  for (const [col, v] of ativos) {
    const txt = Array.isArray(v) ? v.map(x => rotulo(col, x)).join(', ')
      : `${v.min || '…'} a ${v.max || '…'}`;
    box.append(el('span', { textContent: `${DEF[col][1]}: ${txt}` }));
  }
}

// --- presets e filtros salvos -------------------------------------------------------------

function montarListas() {
  const p = $('presets');
  for (const nome of Object.keys(PRESETS)) p.append(el('option', { value: nome, textContent: nome }));
  p.onchange = () => { if (p.value) { filtros = structuredClone(PRESETS[p.value]); p.value = ''; mudou(); } };
  const s = $('salvos');
  const salvos = lerLocal('bp.salvos') ?? {};
  s.replaceChildren(el('option', { value: '', textContent: 'Meus filtros…' }),
    ...Object.keys(salvos).map(n => el('option', { value: n, textContent: n })));
  s.onchange = () => { if (s.value) { filtros = structuredClone(salvos[s.value]); s.value = ''; mudou(); } };
}

$('salvar').onclick = () => {
  const nome = prompt('Nome do filtro:');
  if (!nome) return;
  const salvos = lerLocal('bp.salvos') ?? {};
  salvos[nome] = filtros;
  gravarLocal('bp.salvos', salvos);
  montarListas();
};
$('limpar').onclick = () => { filtros = {}; mudou(); };
$('fixarA').onclick = () => {
  filtroA = filtroA ? null : structuredClone(filtros);
  gravarLocal('bp.filtroA', filtroA);
  $('fixarA').textContent = filtroA ? 'Parar de comparar' : 'Fixar como A';
  consultar();
};
$('exportar').onclick = async () => {
  const res = await fetch('/api/exportar', { method: 'POST', body: JSON.stringify(filtros) });
  const nome = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'bombpot.txt';
  const link = el('a', { href: URL.createObjectURL(await res.blob()), download: nome });
  link.click();
  URL.revokeObjectURL(link.href);
};
$('vista').onclick = () => trocarVista(vista === 'painel' ? 'filtros' : 'painel');
$('fechar').onclick = () => $('print').close();

// --- início -------------------------------------------------------------------------------

(async () => {
  opcoes = await (await fetch('/api/opcoes')).json();
  ORDEM.push(...opcoes.forcas, ...opcoes.draws, 'todos foldam', 'pago', 'aumentado');
  $('info').textContent = `${opcoes.maos.toLocaleString('pt-BR')} bomb pots`;
  try { filtros = location.hash.length > 1 ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : {}; } catch { filtros = {}; }
  montarListas();
  $('vista').textContent = vista === 'painel' ? 'Ver filtros' : 'Painel de tendências';
  $('agrupar').hidden = vista === 'painel';
  $('fixarA').textContent = filtroA ? 'Parar de comparar' : 'Fixar como A';
  mudou();
})();
