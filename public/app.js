// BombPot Tracker, no formato do SnapMDA: barra de comando (o spot) -> POST /api/consulta -> grade de relatório.
// Hero e população entram juntos em tudo.

// ---------------------------------------------------------------------------------------------- base

const $ = id => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null && k !== undefined) n.append(k);
  return n;
};
const svg = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
};
const lerLocal = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const gravarLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } };
const fmt = (v, casas = 2) => (v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: casas }));
const pct = (n, t) => (t ? Math.round(100 * n / t) : null);
const AMOSTRA_MINIMA = 30;

// Intervalo de confiança de Wilson, 95%, em pontos percentuais.
function wilson(n, total) {
  if (!total) return [0, 0];
  const z = 1.96, p = n / total, z2 = z * z / total;
  const centro = (p + z2 / 2) / (1 + z2);
  const meia = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total)) / (1 + z2);
  return [Math.max(0, 100 * (centro - meia)), Math.min(100, 100 * (centro + meia))];
}
const tituloIC = (n, total) => {
  if (!total) return '';
  const [lo, hi] = wilson(n, total);
  return `${n} de ${total} · intervalo de confiança 95%: ${Math.round(lo)}–${Math.round(hi)}%`
    + (total < AMOSTRA_MINIMA ? ' · amostra pequena' : '');
};

const SIM_NAO = { 1: 'Sim', 0: 'Não' };
const PALAVRA = { X: 'check', B: 'bet', C: 'call', R: 'raise', F: 'fold' };
const linhaEmPalavras = v => String(v).split('').map(l => PALAVRA[l] ?? l).join('-');
const ACOES = ['Check', 'Bet', 'Call', 'Raise', 'Fold'];
const COR = { Check: 'var(--x)', Bet: 'var(--b)', Call: 'var(--c)', Raise: 'var(--r)', Fold: 'var(--f)' };
const SITUACAO = { livre: 'ninguém apostou', 'enfrenta aposta': 'enfrenta bet', 'enfrenta raise': 'enfrenta raise' };
// Ordem de leitura de poker (não alfabética); o resto vai ao fim. Força e draws entram ao carregar as opções.
const ORDEM = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'flop', 'turn', 'river',
  'livre', 'enfrenta aposta', 'enfrenta raise', '1º a agir', 'meio', 'último', ...ACOES,
  'rainbow', 'two-tone', 'monotone', 'A', 'K', 'Q', 'J', 'T-', 1, 0];
const ordenar = (vs, col) => {
  const ordem = col === 'n_jogadores' ? [8, 7, 6, 5, 4, 3, 2] : ORDEM;
  return [...vs].sort((a, b) => (ordem.indexOf(a) + 1 || 999) - (ordem.indexOf(b) + 1 || 999));
};

let opcoes = null;
let filtros = {};
const cod = faixa => opcoes?.codigos?.[faixa] ?? faixa;  // "0,46–0,66" -> "B50"

// ------------------------------------------------------------------------- definição dos filtros
// [coluna, nome, tipo, rótulos]. tipo: lista (chips), faixa (mín/máx), faixas (tamanhos), tags, datas.

const DEF = {};
const def = (col, nome, tipo, rot) => (DEF[col] = [col, nome, tipo, rot]);
def('rua', 'Rua', 'lista');
def('situacao', 'Situação', 'lista', SITUACAO);
def('ip', 'Posição na rua', 'lista', { 1: 'IP (último)', 0: 'OOP' });
def('n_jogadores', 'Jogadores na mão', 'faixa');
def('pos', 'Posição', 'lista');
def('linha_flop', 'Flop · o que ele fez', 'lista', linhaEmPalavras);
def('tam_flop', 'Flop · tamanho da bet dele', 'faixas');
def('linha_turn', 'Turn · o que ele fez', 'lista', linhaEmPalavras);
def('tam_turn', 'Turn · tamanho da bet dele', 'faixas');
def('enf_flop', 'Flop · tamanho da bet que ele pagou', 'faixas');
def('enf_turn', 'Turn · tamanho da bet que ele pagou', 'faixas');
def('hero', 'Quem', 'lista', { 0: 'População', 1: 'Hero' });

// Os cartões da gaveta "Mais filtros" (o que não está na barra de comando).
const CARTOES = [
  ['Na rua', 'O que acontece nesta rua, antes e na decisão dele.', [
    def('pos_rel', 'Ordem na rua', 'lista'),
    def('decisao_n', 'Vez que age na rua', 'lista', { 1: '1ª', 2: '2ª', 3: '3ª', 4: '4ª', 5: '5ª' }),
    def('checou_antes', 'Checou antes nesta rua (check-raise / check-call)', 'lista', SIM_NAO),
    def('tamanho_enfrentado', 'Tamanho da bet que ele enfrenta', 'faixas'),
    def('acao', 'Ação dele', 'lista'),
    def('tamanho', 'Tamanho da bet dele nesta rua', 'faixas'),
    def('allin', 'All-in', 'lista', SIM_NAO),
  ]],
  ['Linha anterior', 'Como a mão chegou até aqui. Aqui dá para marcar vários tamanhos (ex.: B5 e B10 = 0,01–0,15).', [
    DEF.linha_flop, DEF.tam_flop, DEF.enf_flop, DEF.linha_turn, DEF.tam_turn, DEF.enf_turn,
    def('agressor_anterior', 'Foi o agressor da rua anterior', 'lista', SIM_NAO),
    def('rua_anterior_checada', 'Rua anterior checada por todos', 'lista', SIM_NAO),
    def('acao_anterior', 'O que ele fez por último na rua anterior', 'lista'),
  ]],
  ['Mão', 'Força nas categorias do H2N. Cartas só são conhecidas do Hero e de quem mostrou no showdown.', [
    def('forca', 'Força da mão nesta rua', 'lista'),
    def('draw', 'Draw (flop e turn)', 'lista'),
    def('weak', 'Mão weak (blefe / ar)', 'lista', SIM_NAO),
  ]],
  ['Board', 'Texturas não exclusivas, como no H2N.', [
    def('naipes_flop', 'Naipes do flop', 'lista'),
    def('flop_alta', 'Carta mais alta do flop', 'lista'),
    def('flop_pareado', 'Flop pareado', 'lista', SIM_NAO),
    def('flop_conectado', 'Flop conectado', 'lista', SIM_NAO),
    def('board_pareado', 'Board pareado até esta rua', 'lista', SIM_NAO),
    def('board_flush', 'Flush possível até esta rua', 'lista', SIM_NAO),
    def('texturas', 'Carta do turn / river (qualquer uma das marcadas)', 'tags'),
  ]],
  ['Mesa e stacks', '', [
    def('n_vivos', 'Ainda na mão no começo da rua', 'faixa'),
    def('pote', 'Pote antes da ação (BB)', 'faixa'),
    def('spr', 'SPR (stack efetivo ÷ pote da rua)', 'faixa'),
    def('data', 'Período', 'datas'),
  ]],
  ['Resultado', '', [
    def('resposta', 'O que a mesa fez depois da bet dele', 'lista'),
    def('sd', 'Foi ao showdown', 'lista', SIM_NAO),
    def('ganhou', 'Ganhou a mão', 'lista', SIM_NAO),
    def('marcada', 'Mão com seguro/jackpot', 'lista', SIM_NAO),
  ]],
];

const rotulo = (col, v) => {
  if (['tamanho', 'tamanho_enfrentado', 'tam_flop', 'tam_turn', 'enf_flop', 'enf_turn'].includes(col)) return `${cod(v)} (${v})`;
  const r = DEF[col]?.[3];
  return (typeof r === 'function' ? r(v) : r?.[v]) ?? String(v);
};
const TAMANHOS = ['tamanho', 'tamanho_enfrentado', 'tam_flop', 'tam_turn', 'enf_flop', 'enf_turn'];
const descreverValor = (col, v) => {
  if (Array.isArray(v) && TAMANHOS.includes(col) && v.length === opcoes.faixas.length) return 'qualquer tamanho';
  if (Array.isArray(v)) return v.map(x => rotulo(col, x)).join(', ');
  if (TAMANHOS.includes(col)) return `${fmt(v.min || 0)} até ${v.max === '' || v.max === undefined ? 'sem teto' : fmt(v.max)} × pote`;
  return `${v.min || '…'} a ${v.max || '…'}`;
};

// ------------------------------------------------------------------------- barra de comando (o spot)

// O que cabe no seletor de linha de uma rua: [rótulo, letras, faixa do tamanho].
function opcoesDeLinha() {
  return [['qualquer coisa', null, null], ['check', 'X', null], ['check-call', 'XC', null], ['check-raise', 'XR', null],
    ['call', 'C', null], ['raise', 'R', null], ['bet (qualquer tamanho), foi pago', 'B', null],
    ...opcoes.faixas.map(f => [`bet ${cod(f)} (${f}), foi pago`, 'B', f]),
    ['bet e pagou um raise', 'BC', null]];
}

function seletorLinha(rua) {
  const cl = `linha_${rua}`, ct = `tam_${rua}`;
  const atualL = filtros[cl], atualT = filtros[ct];
  const ops = opcoesDeLinha();
  const idx = ops.findIndex(([, l, t]) => (l === null ? !atualL && !atualT
    : atualL?.length === 1 && atualL[0] === l && (t ? atualT?.length === 1 && atualT[0] === t : !atualT)));
  const s = el('select', { 'aria-label': `Linha no ${rua}` });
  ops.forEach(([nome], i) => s.append(el('option', { value: i, textContent: nome, selected: i === idx })));
  if (idx < 0) s.append(el('option', { value: -1, textContent: 'personalizado (Mais filtros)', selected: true }));
  s.onchange = () => {
    const [, l, t] = ops[Number(s.value)] ?? [];
    delete filtros[cl];
    delete filtros[ct];
    if (l) filtros[cl] = [l];
    if (t) filtros[ct] = [t];
    mudou();
  };
  return el('label', { className: 'grupo-cmd cmd-linha' }, [el('span', { textContent: `Linha no ${rua}` }), s]);
}

// Botões segmentados. unico: clicar troca o valor (e clicar no ativo limpa); senão, marca vários.
function segmentado(nome, col, valores, unico = true) {
  const atual = new Set(filtros[col] ?? []);
  const seg = el('div', { className: 'seg', role: 'group', 'aria-label': nome });
  for (const [v, txt] of valores) {
    seg.append(el('button', {
      type: 'button', textContent: txt, ariaPressed: String(atual.has(v)),
      onclick: () => {
        if (unico) filtros[col] = atual.has(v) && atual.size === 1 ? [] : [v];
        else { atual.has(v) ? atual.delete(v) : atual.add(v); filtros[col] = [...atual]; }
        if (!filtros[col].length) delete filtros[col];
        mudou();
      },
    }));
  }
  return el('div', { className: 'grupo-cmd' }, [el('span', { textContent: nome }), seg]);
}

function montarComando() {
  const jog = filtros.n_jogadores;
  const n = Array.isArray(jog) ? jog : null;
  const segJog = el('div', { className: 'seg', role: 'group', 'aria-label': 'Jogadores' });
  for (let k = 8; k >= 2; k--) {
    segJog.append(el('button', {
      type: 'button', textContent: String(k), ariaPressed: String(!!n?.includes(k)), title: `mesas com ${k} jogadores`,
      onclick: () => {
        const s = new Set(n ?? []);
        s.has(k) ? s.delete(k) : s.add(k);
        if (s.size) filtros.n_jogadores = [...s].sort((a, b) => b - a); else delete filtros.n_jogadores;
        mudou();
      },
    }));
  }
  const rua = filtros.rua?.length === 1 ? filtros.rua[0] : null;
  const extras = CARTOES.flatMap(([, , fs]) => fs).filter(f => filtros[f[0]] !== undefined).length;
  $('comando').replaceChildren(...[
    segmentado('Rua', 'rua', [['flop', 'Flop'], ['turn', 'Turn'], ['river', 'River']]),
    segmentado('Situação', 'situacao', [['livre', 'Ninguém apostou'], ['enfrenta aposta', 'Enfrenta bet'], ['enfrenta raise', 'Enfrenta raise']]),
    segmentado('Posição na rua', 'ip', [[0, 'OOP'], [1, 'IP']]),
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Jogadores na mesa (marque vários)' }), segJog]),
    rua !== 'flop' ? seletorLinha('flop') : null,
    rua === 'river' || rua === null ? seletorLinha('turn') : null,
    el('div', { className: 'fim' }, [
      el('button', { className: 'btn', type: 'button', textContent: extras ? `Mais filtros (${extras})` : 'Mais filtros', onclick: abrirAvancado }),
      el('button', { className: 'btn', type: 'button', textContent: 'Limpar', onclick: () => { filtros = {}; mudou(); } }),
    ]),
  ].filter(Boolean));  // os seletores de linha que não cabem nesta rua vêm null
}

function mostrarAtivos() {
  const box = $('ativos');
  // na MDA, os filtros que a árvore controla não valem: não aparecem como pílula
  const ativos = Object.entries(filtros).filter(([c]) => c !== '_agrupar' && DEF[c] && !(vista === 'mda' && DA_ARVORE.has(c)));
  if (!ativos.length) { box.replaceChildren(el('span', { className: 'vazio', textContent: 'Sem filtros: todas as decisões de todas as mãos.' })); return; }
  box.replaceChildren(...ativos.map(([col, v]) => el('span', { className: 'pilula' }, [
    `${DEF[col][1]}: ${descreverValor(col, v)}`,
    el('button', { type: 'button', textContent: '×', title: 'Tirar este filtro', onclick: () => { delete filtros[col]; mudou(); } })])));
}

// ------------------------------------------------------------------------- quadros minimizáveis

const abertos = lerLocal('bp.abertos') ?? {};
function cartao(id, titulo, sub, corpo, extra = null) {
  const det = el('details', { className: 'card', open: abertos[id] ?? true, ontoggle: e => {
    abertos[id] = e.target.open;
    gravarLocal('bp.abertos', abertos);
  } });
  det.dataset.cartao = id;
  // controles (ex.: o "Dividir") ficam fora do cabeçalho: dentro dele, clicar neles abriria/fecharia o quadro
  det.append(...[el('summary', {}, [el('span', { className: 'seta', textContent: '▾' }), titulo,
    sub ? el('small', { textContent: sub }) : null]), extra ? el('div', { className: 'controles-card' }, [extra]) : null, ...corpo]
    .filter(Boolean));
  return det;
}

function minimizarTudo() {
  const quadros = [...document.querySelectorAll('#estudo details.card')];
  const fechar = quadros.some(d => d.open);
  for (const d of quadros) { d.open = !fechar; abertos[d.dataset.cartao] = !fechar; }
  gravarLocal('bp.abertos', abertos);
  $('minimizar').textContent = fechar ? 'Abrir todos os quadros' : 'Minimizar tudo';
}

// ------------------------------------------------------------------------- relatório (a grade)

const AGRUPAVEIS = ['pos', 'pos_rel', 'ip', 'n_jogadores', 'rua', 'situacao', 'tamanho', 'tamanho_enfrentado',
  'tam_flop', 'tam_turn', 'enf_flop', 'enf_turn', 'linha_flop', 'linha_turn', 'forca', 'draw', 'naipes_flop', 'flop_alta', 'flop_pareado',
  'board_pareado', 'board_flush', 'decisao_n', 'agressor_anterior', 'rua_anterior_checada'];

function celAmostra(l) {
  return el('td', { className: 'amostra' }, [el('b', { textContent: l.n.toLocaleString('pt-BR') }),
    el('small', { textContent: `decisões · ${l.maos.toLocaleString('pt-BR')} mãos` })]);
}

function celAcoes(l) {
  const pilha = el('div', { className: 'pilha' });
  for (const a of ACOES) {
    const p = l.n ? 100 * (l.acoes[a] ?? 0) / l.n : 0;
    if (p > 0) pilha.append(el('span', { style: `width:${p}%;background:${COR[a]}`, textContent: p >= 9 ? `${Math.round(p)}%` : '',
      title: `${a}: ${tituloIC(l.acoes[a] ?? 0, l.n)}` }));
  }
  return el('td', {}, [pilha]);
}

function celBetMais(l) {
  const total = Object.values(l.bets).reduce((a, b) => a + b, 0);
  if (!total) return el('td', { className: 'fraca', textContent: '—' });
  const [faixa, n] = Object.entries(l.bets).sort((a, b) => b[1] - a[1])[0];
  return el('td', { title: `das ${total} bets, ${tituloIC(n, total)}` }, [el('span', { className: 'tam' }, [
    el('b', { textContent: cod(faixa) }), `${pct(n, total)}% das bets`])]);
}

function celWeak(l) {
  const [fr, conh] = l.weak;
  if (!conh) return el('td', { className: 'fraca', textContent: '—' });
  const p = 100 * fr / conh;
  return el('td', { className: conh < AMOSTRA_MINIMA ? 'fraca' : '', title: `mãos com cartas conhecidas: ${tituloIC(fr, conh)}` }, [
    el('div', { className: 'weakbar' }, [el('span', { className: 'marca', style: `left:${p}%` }),
      el('span', { className: 'rot', textContent: `${Math.round(p)}% weak · ${conh}` })])]);
}

function celResposta(l) {
  const r = l.resposta, total = r['todos foldam'] + r.pago + r.aumentado;
  if (!total) return [el('td', { className: 'fraca', textContent: '—' }), el('td', { className: 'fraca', textContent: '—' })];
  const ev = 100 * r.ev / total, medio = r.tam / total, precisa = 100 * medio / (1 + medio);
  const item = (sigla, n, cls) => el('div', { title: tituloIC(n, total) }, [el('small', { textContent: sigla }),
    el('b', { className: cls, textContent: `${pct(n, total)}%` })]);
  const fraca = total < AMOSTRA_MINIMA ? 'fraca' : '';
  return [
    el('td', { className: fraca }, [el('div', { className: 'resp' }, [
      item('TODOS FOLDAM', r['todos foldam'], pct(r['todos foldam'], total) >= precisa ? 'bom' : 'ruim'),
      item('PAGO', r.pago, ''), item('AUMENTADO', r.aumentado, '')])]),
    el('td', { className: fraca, title: `precisa foldar ${Math.round(precisa)}% para empatar (bet média ${fmt(medio)} do pote) · ${total} bets` }, [
      el('b', { className: ev > 2 ? 'bom' : ev < -2 ? 'ruim' : 'neutro', textContent: `${ev >= 0 ? '+' : ''}${fmt(ev, 1)}%` })]),
  ];
}

// Lado de quem enfrenta bet: fold real contra o que precisaria foldar (bet ÷ (1 + bet), média das bets enfrentadas).
function celDefesa(l) {
  const [n, folds, precisa] = l.defesa ?? [0, 0, 0];
  if (!n) return el('td', { className: 'fraca', textContent: '—' });
  const fold = 100 * folds / n, p = 100 * precisa / n, d = fold - p;
  const item = (sigla, txt, cls = '') => el('div', {}, [el('small', { textContent: sigla }), el('b', { className: cls, textContent: txt })]);
  return el('td', { className: n < AMOSTRA_MINIMA ? 'fraca' : '',
    title: `fold: ${tituloIC(folds, n)} · precisa ${Math.round(p)}% = média de bet ÷ (1 + bet) das bets que ele enfrentou` }, [
    el('div', { className: 'resp' }, [item('FOLD', `${Math.round(fold)}%`, d > 0 ? 'bom' : 'ruim'), item('PRECISA', `${Math.round(p)}%`),
      item(d >= 0 ? 'OVERFOLD' : 'DEFENDE MAIS', `${d >= 0 ? '+' : ''}${Math.round(d)}`, d > 0 ? 'bom' : 'ruim')])]);
}

function celWsd(l) {
  const [g, n] = l.wsd;
  return n ? el('td', { className: n < AMOSTRA_MINIMA ? 'fraca' : '', title: tituloIC(g, n), textContent: `${pct(g, n)}%` })
    : el('td', { className: 'fraca', textContent: '—' });
}

function linhaGrade(l, nome, classe, filtroDoGrupo) {
  return el('tr', { className: classe }, [
    el('th', {}, [filtroDoGrupo ? el('button', { className: 'ver', type: 'button', textContent: nome,
      title: 'Filtrar só este grupo', onclick: () => { Object.assign(filtros, filtroDoGrupo); delete filtros._agrupar; mudou(); } }) : nome]),
    celAmostra(l), celAcoes(l), celDefesa(l), celBetMais(l), celWeak(l), ...celResposta(l), celWsd(l),
  ]);
}

function cartaoRelatorio(r, a) {
  const cab = [['Grupo'], ['Amostra'],
    ['Ações', 'Barra: quanto cada ação aparece entre as decisões (check, bet, call, raise, fold).'],
    ['Fold vs bet', 'Quando ele enfrenta bet/raise: quanto folda, quanto precisaria foldar para um blefe contra ele empatar (bet ÷ (1 + bet)) e a diferença. Verde = overfold: blefar contra ele dá lucro.'],
    ['Bet mais usada', 'O tamanho de bet mais usado (em fração do pote) e quanto ele representa das bets.'],
    ['Weak', 'Das mãos com cartas conhecidas, quantas eram weak (ar, A-high, draw que não chegou, par baixo): é o blefe.'],
    ['Mesa respondeu à bet', 'Depois das bets deste grupo: todos foldaram, alguém pagou ou alguém aumentou. Verde = folda mais que o necessário para o blefe empatar.'],
    ['EV blefe', 'Quanto um blefe puro com essas bets renderia, em % do pote: +1 pote quando todos foldam, −a bet quando não.'],
    ['W$SD', 'Ganhou no showdown, entre os que chegaram lá (sem mãos com seguro/jackpot).']];
  const corpo = el('tbody');
  if (a) corpo.append(linhaGrade(a, 'A (fixado)', 'linha-a'));
  if (r.geral) corpo.append(linhaGrade(r.geral, 'Geral', 'geral'));
  const col = r.agrupar;
  if (col) {
    const grupos = DEF[col]?.[2] === 'faixas' ? opcoes.faixas.map(f => r.grupos.find(g => g.chave === f)).filter(Boolean)
      : ordenar(r.grupos.map(g => (isNaN(g.chave) ? g.chave : Number(g.chave))), col).map(k => r.grupos.find(g => g.chave === String(k)));
    for (const g of grupos) {
      const valor = isNaN(g.chave) ? g.chave : Number(g.chave);
      const filtroGrupo = col === 'n_jogadores' ? { n_jogadores: [valor] } : { [col]: [valor] };
      corpo.append(linhaGrade(g, rotulo(col, valor), '', filtroGrupo));
    }
  }
  const agrupar = el('select', { 'aria-label': 'Agrupar por', onchange: e => {
    if (e.target.value) filtros._agrupar = e.target.value; else delete filtros._agrupar;
    mudou();
  } }, [el('option', { value: '', textContent: 'Só a linha geral' }),
    ...AGRUPAVEIS.map(c => el('option', { value: c, textContent: `por ${DEF[c][1].toLowerCase()}`, selected: filtros._agrupar === c }))]);
  return cartao('relatorio', 'Relatório', 'cada linha é um grupo de decisões; clique no nome do grupo para filtrar só ele', [
    el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, cab.map(([t, d]) => el('th', d ? { textContent: t, title: d } : { textContent: t })))]),
      corpo])]),
    el('div', { className: 'legenda', style: 'padding: 8px 16px 12px' }, ACOES.map(a => el('span', {}, [el('i', { style: `background:${COR[a]}` }), a.toLowerCase()]))),
  ], el('label', { className: 'dividir' }, ['Dividir: ', agrupar]));
}

// ------------------------------------------------------------------------- resposta ao sizing

// A tabela que mostra, para cada tamanho de bet, o que a mesa fez depois: o formato da grade com os números do H2N.
function cartaoResposta(g) {
  const totalBets = opcoes.faixas.reduce((s, f) => s + (g[f]?.usos ?? 0), 0);
  const corpo = el('tbody');
  const linhaResposta = (nome, d, classe = '') => {
    const total = d['todos foldam'] + d.pago + d.aumentado;
    const fraca = total < AMOSTRA_MINIMA ? 'fraca' : '';
    const medio = total ? d.tam / total : 0, precisa = 100 * medio / (1 + medio), ev = total ? 100 * d.ev / total : 0;
    const fold = pct(d['todos foldam'], total);
    const barra = el('div', { className: 'pilha', style: 'width:150px' });
    for (const [chave, cor] of [['todos foldam', 'var(--bom)'], ['pago', 'var(--c)'], ['aumentado', 'var(--r)']]) {
      const p = total ? 100 * d[chave] / total : 0;
      if (p > 0) barra.append(el('span', { style: `width:${p}%;background:${cor}`, title: `${chave}: ${tituloIC(d[chave], total)}` }));
    }
    const num = (n, cls = '') => el('td', { className: `num ${fraca}`, title: tituloIC(n, total) }, [
      el('b', { className: cls, textContent: total ? `${pct(n, total)}%` : '—' })]);
    return el('tr', { className: classe }, [
      el('th', {}, [nome]),
      el('td', { className: 'amostra' }, [el('b', { textContent: String(d.usos) }),
        el('small', { textContent: `${pct(d.usos, totalBets)}% das bets` })]),
      el('td', { className: fraca }, [barra]),
      num(d['todos foldam'], fold >= precisa ? 'bom' : 'ruim'), num(d.pago), num(d.aumentado),
      el('td', { className: `num ${fraca}`, title: `bet média ${fmt(medio)} do pote: ${fmt(medio)} ÷ (1 + ${fmt(medio)})` }, [
        el('b', { textContent: total ? `${Math.round(precisa)}%` : '—' })]),
      el('td', { className: `num ${fraca}`, title: total ? `${total} bets com resposta` : '' }, [
        el('b', { className: ev > 2 ? 'bom' : ev < -2 ? 'ruim' : 'neutro', textContent: total ? `${ev >= 0 ? '+' : ''}${fmt(ev, 0)}` : '—' })]),
    ]);
  };
  // "Total do filtro": todas as bets do filtro somadas. Com a faixa livre ligada, é a resposta para a faixa exata.
  const soma = { usos: 0, 'todos foldam': 0, pago: 0, aumentado: 0, ev: 0, tam: 0 };
  for (const d of Object.values(g)) for (const k of Object.keys(soma)) soma[k] += d[k] ?? 0;
  if (soma.usos) {
    const livre = filtros.tamanho && !Array.isArray(filtros.tamanho) ? descreverValor('tamanho', filtros.tamanho) : 'todas as bets';
    corpo.append(linhaResposta(el('span', { className: 'tam' }, [el('b', { textContent: 'Total' }), el('small', { textContent: livre })]), soma, 'geral'));
  }
  for (const f of opcoes.faixas) {
    if (g[f]) corpo.append(linhaResposta(el('span', { className: 'tam' }, [el('b', { textContent: cod(f) }), el('small', { textContent: f })]), g[f]));
  }
  const cab = [['Tamanho', 'Fração do pote da bet (B50 = 0,46–0,66).'], ['Bets', 'Quantas bets desse tamanho e quanto elas são do total.'],
    ['Mesa respondeu', 'Barra: verde = todos foldaram, azul = alguém pagou, vermelho = alguém aumentou.'],
    ['Todos foldam', 'Verde quando passa do "precisa foldar": aí o blefe com esse tamanho dá lucro.'], ['Pago'], ['Aumentado'],
    ['Precisa foldar', 'Fold necessário para um blefe empatar: bet ÷ (1 + bet).'], ['EV blefe', 'Em % do pote: +1 pote se todos foldam, −a bet se não.']];
  return cartao('resposta', 'Resposta ao sizing', 'o que a mesa fez depois de cada tamanho de bet', [
    corpo.children.length ? el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, cab.map(([tt, d]) => el('th', d ? { textContent: tt, title: d } : { textContent: tt })))]), corpo])])
      : el('p', { className: 'nota', textContent: 'Sem bets com estes filtros.' }),
    explicacaoEV()]);
}

// ------------------------------------------------------------------------- gráfico: tamanho × fold

// pontos: faixa -> { usos, n, real, precisa } (em %). real = "todos foldam" (quem aposta) ou "fold" (quem enfrenta).
function pontosAtaque(g) {
  const out = {};
  for (const [f, d] of Object.entries(g)) {
    const total = d['todos foldam'] + d.pago + d.aumentado, medio = total ? d.tam / total : 0;
    out[f] = { usos: d.usos, n: total, real: total ? 100 * d['todos foldam'] / total : null, precisa: 100 * medio / (1 + medio),
      vreal: d['todos foldam'] };
  }
  return out;
}
function pontosDefesa(d) {
  const out = {};
  for (const [f, v] of Object.entries(d)) {
    out[f] = { usos: v.n, n: v.n, real: v.n ? 100 * v.Fold / v.n : null, precisa: v.n ? 100 * v.precisa / v.n : 0, vreal: v.Fold };
  }
  return out;
}

function cartaoGrafico(pontos, lado) {
  const ataque = lado === 'ataque';
  const nomeReal = ataque ? 'todos foldam' : 'fold de quem enfrenta';
  const faixas = opcoes.faixas;
  const W = 560, H = 300, E = 40, D = 10, T = 14, B = 36;
  const x = i => E + (i + 0.5) * (W - E - D) / faixas.length;
  const y = v => T + (100 - v) * (H - T - B) / 100;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Fold por tamanho de bet (${nomeReal})` });
  for (const v of [0, 25, 50, 75, 100]) {
    s.append(svg('line', { x1: E, x2: W - D, y1: y(v), y2: y(v), class: v ? 'grade' : 'eixo' }),
      svg('text', { x: E - 6, y: y(v) + 4, 'text-anchor': 'end' }, [`${v}%`]));
  }
  const maxUso = Math.max(1, ...faixas.map(f => pontos[f]?.usos ?? 0));
  const pontosReal = [], pontosPrecisa = [];
  faixas.forEach((f, i) => {
    const d = pontos[f];
    s.append(svg('text', { x: x(i), y: H - B + 16, 'text-anchor': 'middle' }, [cod(f)]));
    if (!d) return;
    const larg = (W - E - D) / faixas.length * 0.5;
    const alt = (d.usos / maxUso) * (H - T - B) * 0.35;
    s.append(svg('rect', { x: x(i) - larg / 2, y: H - B - alt, width: larg, height: alt, fill: '#2a2f38', rx: 2 },
      [svg('title', {}, [`${cod(f)} (${f}): ${d.usos} ${ataque ? 'bets' : 'decisões contra esse tamanho'}`])]));
    if (d.real === null) return;
    pontosReal.push([x(i), y(d.real), d.n, `${cod(f)}: ${nomeReal} ${Math.round(d.real)}% (${tituloIC(d.vreal, d.n)})`]);
    pontosPrecisa.push([x(i), y(d.precisa), d.n, `${cod(f)}: precisa foldar ${Math.round(d.precisa)}% para um blefe empatar`]);
  });
  const linha = (pts, cor, tracejado) => {
    if (pts.length > 1) s.append(svg('polyline', { points: pts.map(([a, b]) => `${a},${b}`).join(' '), fill: 'none',
      stroke: cor, 'stroke-width': 2, ...(tracejado ? { 'stroke-dasharray': '5 4' } : {}) }));
    for (const [a, b, n, tit] of pts) {
      s.append(svg('circle', { cx: a, cy: b, r: 4.5, fill: n < AMOSTRA_MINIMA ? '#111317' : cor, stroke: cor, 'stroke-width': 2 },
        [svg('title', {}, [tit + (n < AMOSTRA_MINIMA ? ' · amostra pequena' : '')])]));
    }
  };
  linha(pontosPrecisa, 'var(--c)', true);
  linha(pontosReal, 'var(--accent)', false);
  return cartao('grafico', 'Tamanho da bet × fold', ataque ? 'lima acima da azul = o blefe dá lucro'
    : 'lado de quem enfrenta: lima acima da azul = ele folda demais (overfold)', [
    el('div', { className: 'grafico' }, [s]),
    el('div', { className: 'leg-graf' }, [
      el('span', {}, [el('i', { style: 'background:var(--accent)' }), ataque ? 'todos foldam (real)' : 'fold dele (real)']),
      el('span', {}, [el('i', { style: 'background:var(--c)' }), 'precisa foldar para um blefe empatar = bet ÷ (1 + bet)']),
      el('span', {}, [el('i', { style: 'background:#2a2f38;height:9px' }), ataque ? 'barras: quanto cada tamanho é usado' : 'barras: quantas vezes ele enfrentou cada tamanho']),
      el('span', { textContent: 'ponto vazio = menos de 30' })]),
  ]);
}

// Lado de quem ENFRENTA a bet: para cada tamanho enfrentado, o que ele fez e se folda mais do que deveria.
function cartaoDefesa(d) {
  const corpo = el('tbody');
  const linhaDefesa = (nome, v, classe = '') => {
    const fraca = v.n < AMOSTRA_MINIMA ? 'fraca' : '';
    const fold = 100 * v.Fold / v.n, precisa = 100 * v.precisa / v.n, dif = fold - precisa;
    const barra = el('div', { className: 'pilha', style: 'width:150px' });
    for (const [a, cor] of [['Fold', 'var(--f)'], ['Call', 'var(--c)'], ['Raise', 'var(--r)']]) {
      const pc = 100 * v[a] / v.n;
      if (pc > 0) barra.append(el('span', { style: `width:${pc}%;background:${cor}`, title: `${a}: ${tituloIC(v[a], v.n)}` }));
    }
    const num = (n, cls = '') => el('td', { className: `num ${fraca}`, title: tituloIC(n, v.n) }, [el('b', { className: cls, textContent: `${pct(n, v.n)}%` })]);
    return el('tr', { className: classe }, [
      el('th', {}, [nome]), el('td', { className: 'amostra' }, [el('b', { textContent: String(v.n) }), el('small', { textContent: 'decisões' })]),
      el('td', { className: fraca }, [barra]), num(v.Fold, dif > 0 ? 'bom' : 'ruim'), num(v.Call), num(v.Raise),
      el('td', { className: `num ${fraca}`, title: 'média de bet ÷ (1 + bet) das bets que ele enfrentou' }, [el('b', { textContent: `${Math.round(precisa)}%` })]),
      el('td', { className: `num ${fraca}` }, [el('b', { className: dif > 0 ? 'bom' : 'ruim', textContent: `${dif >= 0 ? '+' : ''}${Math.round(dif)}` })]),
    ]);
  };
  const soma = { n: 0, Fold: 0, Call: 0, Raise: 0, precisa: 0 };
  for (const v of Object.values(d)) for (const k of Object.keys(soma)) soma[k] += v[k] ?? 0;
  if (soma.n) corpo.append(linhaDefesa(el('span', { className: 'tam' }, [el('b', { textContent: 'Total' }), el('small', { textContent: 'todas as bets enfrentadas' })]), soma, 'geral'));
  for (const f of opcoes.faixas) {
    if (d[f]?.n) corpo.append(linhaDefesa(el('span', { className: 'tam' }, [el('b', { textContent: cod(f) }), el('small', { textContent: f })]), d[f]));
  }
  const cab = [['Bet enfrentada', 'Tamanho da bet/raise que ele enfrentou, em fração do pote.'], ['Decisões'],
    ['O que ele fez', 'Barra: violeta = fold, azul = call, vermelho = raise.'], ['Fold', 'Verde = folda mais do que precisaria (overfold).'],
    ['Call'], ['Raise'], ['Precisa foldar', 'Fold em que um blefe contra ele empata: bet ÷ (1 + bet).'],
    ['Overfold', 'Fold real menos o necessário, em pontos. Positivo = ele folda demais: blefar contra ele dá lucro.']];
  return cartao('defesa', 'Fold por sizing', 'o que ele faz contra cada tamanho de bet (lado de quem enfrenta)', [
    el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, cab.map(([tt, dd]) => el('th', dd ? { textContent: tt, title: dd } : { textContent: tt })))]), corpo])]),
    el('p', { className: 'nota', textContent: 'Em multiway, o fold aqui é de cada jogador. O "todos foldam" da Resposta ao sizing é do lado de quem aposta e exige que ninguém pague.' }),
  ]);
}

function explicacaoEV() {
  return el('details', { className: 'explica' }, [el('summary', { textContent: 'Como ler o EV blefe e o gráfico' }),
    el('p', { textContent: 'Para cada bet, olhamos o que a mesa fez depois. Se todos foldaram, um blefe teria levado o pote (+1 pote); '
      + 'se alguém pagou ou aumentou, um blefe puro perde o que apostou (−tamanho). A média disso é o EV blefe, em % do pote: '
      + 'EV = F × 100 − (1 − F) × tamanho × 100, com F = % de vezes em que todos foldaram.' }),
    el('p', { textContent: '"Precisa foldar" é o empate: tamanho ÷ (1 + tamanho). Uma bet B50 de 0,52 do pote empata com 0,52 ÷ 1,52 = 34% de fold. '
      + 'Se a mesa folda mais do que isso (linha lima acima da azul), o blefe com esse tamanho dá lucro.' }),
    el('p', { textContent: 'Cuidados: supõe que o blefe nunca ganha quando é pago e não olha as ruas seguintes. Em bomb pot multiway, '
      + 'F exige que TODOS foldem. As bets medidas são as do field, a maioria de valor; a mesa reage do mesmo jeito porque não vê as cartas.' }),
  ]);
}

// ------------------------------------------------------------------------- força, draws, mãos

function cartaoDistribuicao(id, titulo, sub, dados, chaves, nota) {
  const total = Object.values(dados).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...Object.values(dados));
  const linhas = chaves.filter(k => dados[k]).map(k => el('tr', {}, [
    el('th', { textContent: k }),
    el('td', { className: 'num', title: tituloIC(dados[k], total), textContent: `${pct(dados[k], total)}%` }),
    el('td', { className: 'num', style: 'color:var(--muted)', textContent: String(dados[k]) }),
    el('td', { style: 'width:45%' }, [el('div', { className: 'barra', style: `width:${100 * dados[k] / max}%` })])]));
  return cartao(id, titulo, sub, [
    linhas.length ? el('table', { className: 'dist' }, [el('tbody', {}, linhas)]) : el('p', { className: 'nota', textContent: 'Nada com estes filtros.' }),
    nota ? el('p', { className: 'nota', textContent: nota }) : null]);
}

// ------------------------------------------------------------------------- mesa (seletor de posição)

const HORARIO = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'];
const SAI = { 8: [], 7: ['UTG+1'], 6: ['UTG+1', 'MP'], 5: ['UTG+1', 'MP', 'HJ'], 4: ['UTG+1', 'MP', 'HJ', 'CO'],
  3: ['UTG', 'UTG+1', 'MP', 'HJ', 'CO'], 2: ['SB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'] };
const AGE = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN'];
const LUGARES = [[50, 94], [14, 80], [4, 46], [17, 11], [50, 4], [83, 11], [96, 46], [86, 80]];
const LETRA_ACAO = { Check: 'X', Bet: 'B', Call: 'C', Raise: 'R', Fold: 'F' };
let botao = Number(lerLocal('bp.botao') ?? 0);

function cartaoMesa(m) {
  const jog = Array.isArray(filtros.n_jogadores) ? filtros.n_jogadores : null;
  const k = jog ? Math.max(...jog) : 8;
  const posicoes = HORARIO.filter(p => !SAI[k].includes(p));
  const naMesa = AGE.filter(p => posicoes.includes(p));
  const marcadas = new Set(filtros.pos ?? []);
  const total = jog ? jog.reduce((s, n) => s + (m.por_n[n] ?? 0), 0) : Object.values(m.por_n).reduce((a, b) => a + b, 0);
  const mover = d => { botao = (botao + d + 8) % 8; gravarLocal('bp.botao', botao); consultar(); };
  const quadro = el('div', { className: 'mesa' }, [el('div', { className: 'feltro' }, [
    el('strong', { textContent: jog ? `${jog.join(', ')} jogadores` : 'Todas as mesas' }),
    el('span', { className: 'num', textContent: `${total.toLocaleString('pt-BR')} mãos` }),
    el('small', { textContent: marcadas.size ? `filtrando: ${[...marcadas].join(', ')}` : 'clique num assento para filtrar a posição' })])]);
  for (let i = posicoes.length; i < 8; i++) {
    const [x, y] = LUGARES[(botao + i) % 8];
    quadro.append(el('div', { className: 'assento vazio', style: `left:${x}%;top:${y}%`, textContent: 'vazio' }));
  }
  posicoes.forEach((pos, i) => {
    const [x, y] = LUGARES[(botao + i) % 8];
    const acoes = m.por_pos[pos] ?? {};
    const n = Object.values(acoes).reduce((a, b) => a + b, 0);
    const resumo = Object.entries(acoes).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, c]) => pct(c, n) >= 1)
      .map(([a, c]) => `${LETRA_ACAO[a] ?? a} ${pct(c, n)}%`).join(' · ');
    quadro.append(el('button', {
      type: 'button', className: 'assento' + (marcadas.has(pos) ? ' marcado' : ''), style: `left:${x}%;top:${y}%`,
      ariaPressed: String(marcadas.has(pos)), title: `${pos}: clique para ${marcadas.has(pos) ? 'tirar do' : 'pôr no'} filtro`,
      onclick: () => {
        marcadas.has(pos) ? marcadas.delete(pos) : marcadas.add(pos);
        if (marcadas.size) filtros.pos = [...marcadas]; else delete filtros.pos;
        mudou();
      },
    }, [el('b', { textContent: pos }), el('span', { className: 'p', textContent: `age em ${naMesa.indexOf(pos) + 1}º · ${n ? `${n.toLocaleString('pt-BR')} ${n === 1 ? 'decisão' : 'decisões'}` : 'sem decisões'}` }),
      el('span', { className: 'a', textContent: resumo })]));
    if (i === 0) quadro.append(el('span', { className: 'dealer', textContent: 'D', style: `left:${x + (50 - x) * 0.3}%;top:${y + (50 - y) * 0.3}%` }));
  });
  return cartao('mesa', 'Mesa', 'as posições em volta do botão; clique nos assentos para filtrar', [
    el('div', { className: 'mesa-controles' }, [
      el('span', { className: 'nota', style: 'padding:0', textContent: 'Em cada assento: a ordem em que age no flop, quantas decisões há e o que mais faz (X check, B bet, C call, R raise, F fold).' }),
      el('div', { className: 'seg' }, [
        el('button', { type: 'button', textContent: '◀', title: 'Mover o botão no sentido anti-horário', onclick: () => mover(-1) }),
        el('button', { type: 'button', textContent: 'botão', disabled: true }),
        el('button', { type: 'button', textContent: '▶', title: 'Mover o botão no sentido horário', onclick: () => mover(1) })])]),
    quadro]);
}

// ------------------------------------------------------------------------- MDA (árvore de ações, estilo H2N)
// Colunas FLOP / TURN / RIVER com os nós da árvore; clicar numa ação abre os bet sizes; "afunilar" leva a linha
// escolhida para a rua seguinte. Rua, situação, linha e tamanhos vêm da árvore; os outros filtros valem.

const DA_ARVORE = new Set(['rua', 'situacao', 'ip', 'linha_flop', 'linha_turn', 'tam_flop', 'tam_turn', 'enf_flop', 'enf_turn',
  'acao', 'tamanho', 'tamanho_enfrentado', 'decisao_n', 'checou_antes', 'resposta', '_agrupar']);
const RUAS_MDA = ['flop', 'turn', 'river'];
const NOME_RUA = { flop: 'Flop', turn: 'Turn', river: 'River' };
const MINIMO_NO = 10;  // nós com menos decisões ficam recolhidos em "mais linhas"
const FAIXAS_MDA = () => [...opcoes.faixas_h2n].reverse();  // as faixas do H2N, da maior para a menor
let caminho = lerLocal('bp.caminho') ?? {};
let mdaSel = null;  // { rua, chave, acao }
let mdaDados = null;
const ruasAbertas = new Set();  // os três boxes começam minimizados
let separarAI = false;          // sempre começa desligado: a bet all-in entra na faixa do tamanho dela
let buscaLinha = '';            // a linha digitada na busca: os boxes mostram só as que começam assim
// "x - b", "XB" e "X B" são a mesma linha: só as letras contam ("(sem bet)" fica de fora)
const normLinha = s => s.replace(/\(.*?\)/g, '').toUpperCase().replace(/[^XBCRF]/g, '');
const casaBusca = rotulo => !normLinha(buscaLinha) || normLinha(rotulo).startsWith(normLinha(buscaLinha));
const linhasDaRua = rua => (mdaDados?.[rua] ?? []).flatMap(no => ACOES.filter(a => no.acoes[a]).map(a => ({ rua, no, a })));

function escolherLinha({ rua, no, a }) {
  ruasAbertas.add(rua);
  mdaSel = { rua, chave: no.chave, acao: a };
  buscaLinha = rotuloLinha(no, a);
  desenharMda(true);
}

// As possibilidades que sobram para o que foi digitado, das mais jogadas para as menos.
function sugestoesMda() {
  if (!normLinha(buscaLinha)) return [];
  return RUAS_MDA.flatMap(linhasDaRua).filter(l => casaBusca(rotuloLinha(l.no, l.a)))
    .sort((x, y) => y.no.acoes[y.a] - x.no.acoes[x.a]).slice(0, 12);
}
function listaSugestoes() {
  const sug = sugestoesMda();
  return el('div', { className: 'mda-sugestoes' }, sug.length ? sug.map(l => el('button', { type: 'button',
    onmousedown: e => { e.preventDefault(); escolherLinha(l); } }, [
    el('small', { textContent: NOME_RUA[l.rua] }), el('b', { textContent: rotuloLinha(l.no, l.a) }),
    el('span', { textContent: `${pct(l.no.acoes[l.a], l.no.n)}% (${l.no.acoes[l.a]})` })]))
    : normLinha(buscaLinha) ? [el('p', { className: 'nota', textContent: 'Nenhuma linha começa assim.' })] : []);
}
// Ao digitar, troca só os boxes e a lista: refazer a barra inteira tiraria o foco da caixa.
function atualizarBusca() {
  document.querySelector('#mda .mda-grade')?.replaceWith(el('div', { className: 'mda-grade' }, RUAS_MDA.map(r => colunaMda(r, mdaDados[r]))));
  document.querySelector('#mda .mda-sugestoes')?.replaceWith(listaSugestoes());
}
function caixaBusca() {
  return el('div', { className: 'grupo-cmd mda-busca' }, [el('span', { textContent: 'Procurar linha' }),
    el('input', { type: 'search', value: buscaLinha, placeholder: 'ex.: x b, B - B, xc', ariaLabel: 'Procurar linha', autocomplete: 'off',
      oninput: e => { buscaLinha = e.target.value; atualizarBusca(); },
      onkeydown: e => {
        if (e.key === 'Enter') { const s = sugestoesMda()[0]; if (s) escolherLinha(s); }
        if (e.key === 'Escape') { buscaLinha = ''; e.target.value = ''; atualizarBusca(); }
      } }),
    listaSugestoes()]);
}

// Na linha do turn ou do river: o tamanho da bet dele (ou da que ele pagou) na rua anterior vira filtro da linha.
function escolherFaixaAnterior(rua, linha, faixa, lado) {
  const c = { ...caminho };
  if (faixa) c[rua] = { linha, faixa, lado }; else delete c[rua];
  caminho = c;
  salvarCaminho();
  consultar();
}
const letrasEmPalavras = s => (s ? linhaEmPalavras(s) : '');

function descreverNo(no) {
  if (!no.atual) return no.situ === 'livre' ? 'primeira ação, ninguém apostou' : 'primeira ação, enfrenta bet';
  if (no.atual.endsWith('X')) return `depois de ${letrasEmPalavras(no.atual)}, enfrenta bet`;
  return `depois de ${letrasEmPalavras(no.atual)}, ${no.atual.endsWith('B') || no.atual.endsWith('R') ? 'levou raise' : 'enfrenta bet'}`;
}
// Rótulo da linha no estilo do H2N: as ruas separadas por " - ", as letras dele em cada rua.
// o fold com a mesa em check (o WPT deixa) leva "(sem bet)": sem isso ele repetia o rótulo do fold contra bet
const rotuloLinha = (no, acao) => [...no.prefixo, no.atual + LETRA_ACAO[acao]].join(' - ')
  + (acao === 'Fold' && no.situ === 'livre' ? ' (sem bet)' : '');

function salvarCaminho() { gravarLocal('bp.caminho', caminho); }
function afunilar(rua, linha, faixa, lado) {
  caminho = { ...caminho, [rua]: { linha, faixa, lado } };
  if (rua === 'flop') delete caminho.turn;  // mudar o flop invalida o que estava escolhido no turn
  salvarCaminho();
  mdaSel = null;
  consultar();
}
function tirarCaminho(rua) {
  caminho = rua === 'flop' ? {} : { flop: caminho.flop };
  salvarCaminho();
  mdaSel = null;
  consultar();
}

function barraMda() {
  const pos = filtros.pos?.length === 1 ? filtros.pos[0] : null;
  const segPos = el('div', { className: 'seg', role: 'group', 'aria-label': 'Posição' });
  for (const p of ['Todas', ...AGE]) {
    const ativo = p === 'Todas' ? !filtros.pos : pos === p;
    segPos.append(el('button', { type: 'button', textContent: p, ariaPressed: String(ativo), onclick: () => {
      if (p === 'Todas') delete filtros.pos; else filtros.pos = [p];
      mdaSel = null;
      mudou();
    } }));
  }
  const jog = Array.isArray(filtros.n_jogadores) ? filtros.n_jogadores : null;
  const segJog = el('div', { className: 'seg', role: 'group', 'aria-label': 'Jogadores' });
  for (let k = 8; k >= 2; k--) {
    segJog.append(el('button', { type: 'button', textContent: String(k), ariaPressed: String(!!jog?.includes(k)), onclick: () => {
      const s = new Set(jog ?? []);
      s.has(k) ? s.delete(k) : s.add(k);
      if (s.size) filtros.n_jogadores = [...s].sort((a, b) => b - a); else delete filtros.n_jogadores;
      mudou();
    } }));
  }
  const passos = Object.entries(caminho).filter(([, v]) => v?.linha).map(([rua, v]) => el('span', { className: 'pilula' }, [
    `${NOME_RUA[rua]}: ${letrasEmPalavras(v.linha)}${v.faixa ? ` ${v.lado === 'pagou' ? 'pagando' : ''} ${cod(v.faixa)} (${v.faixa})` : ''}`,
    el('button', { type: 'button', textContent: '×', title: 'Tirar este passo', onclick: () => tirarCaminho(rua) })]));
  return el('div', { className: 'mda-barra' }, [
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Posição' }), segPos]),
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Jogadores na mesa (marque vários)' }), segJog]),
    caixaBusca(),
    el('div', { className: 'grupo-cmd caminho' }, [el('span', { textContent: 'Caminho (afunilar)' }),
      el('div', { className: 'chips' }, passos.length ? passos : [el('span', { className: 'vazio', textContent: 'clique numa ação e em "afunilar" para seguir a linha na rua seguinte' })])]),
    el('div', { className: 'fim' }, [
      el('button', { className: 'btn' + (separarAI ? ' primario' : ''), type: 'button', ariaPressed: String(separarAI),
        textContent: `All-in separado: ${separarAI ? 'sim' : 'não'}`,
        title: separarAI ? 'Ligado: as bets all-in aparecem nas linhas -AI e saem da conta do tamanho delas. Clique para juntar.'
          : 'Desligado: cada bet all-in soma na faixa do tamanho dela (a amostra de all-in costuma ser pequena). Clique para mostrar à parte.',
        onclick: () => { separarAI = !separarAI; desenharMda(); } }),
      el('button', { className: 'btn', type: 'button', textContent: 'Mais filtros', onclick: abrirAvancado })]),
  ]);
}

// Cada rua é um box com uma lista de linhas, como no perfil do H2N: "X - B  25%  (276)" = depois do flop em check,
// quantas vezes ele foi o primeiro a apostar no turn. Os boxes começam minimizados; clicar numa linha abre os bet
// sizes dela no painel embaixo dos três boxes.
function colunaMda(rua, nos) {
  const todas = nos.flatMap(no => ACOES.filter(a => no.acoes[a]).map(a => ({ no, a })));
  const linhas = todas.filter(({ no, a }) => casaBusca(rotuloLinha(no, a)));
  const buscando = !!normLinha(buscaLinha);
  const linha = ({ no, a }) => {
    const n = no.acoes[a], ativa = mdaSel && mdaSel.rua === rua && mdaSel.chave === no.chave && mdaSel.acao === a;
    return el('button', { type: 'button', className: 'mda-linha' + (ativa ? ' aberta' : ''), ariaPressed: String(!!ativa),
      title: `${descreverNo(no)} · ${a}: ${tituloIC(n, no.n)} · clique para ${ativa ? 'fechar' : 'ver os tamanhos embaixo'}`,
      onclick: () => { if (ativa) { mdaSel = null; desenharMda(); } else escolherLinha({ rua, no, a }); } }, [
      el('span', { className: 'rot', textContent: rotuloLinha(no, a) }),
      el('b', { className: no.n < AMOSTRA_MINIMA ? 'fraca' : '', textContent: `${pct(n, no.n)}%` }),
      el('small', { textContent: `(${n})` })]);
  };
  const grandes = linhas.filter(l => l.no.n >= MINIMO_NO), pequenas = linhas.filter(l => l.no.n < MINIMO_NO);
  const total = nos.reduce((s, no) => s + (no.atual ? 0 : no.n), 0);  // primeira decisão de cada um na rua
  const box = el('details', { className: 'mda-col', open: ruasAbertas.has(rua) || (buscando && linhas.length > 0),
    ontoggle: e => { if (e.target.open) ruasAbertas.add(rua); else ruasAbertas.delete(rua); } }, [
    el('summary', {}, [el('span', { className: 'seta', textContent: '▾' }), NOME_RUA[rua],
      rua !== 'flop' && caminho[rua === 'turn' ? 'flop' : 'turn'] ? el('small', { className: 'afun', textContent: 'afunilado' }) : null,
      el('small', { textContent: buscando ? `${linhas.length} de ${todas.length} linhas` : `${todas.length} linhas · ${total.toLocaleString('pt-BR')} decisões de primeira ação` })]),
    ...(linhas.length ? grandes.map(linha) : [el('p', { className: 'nota', textContent: buscando ? 'Nenhuma linha desta rua começa assim.' : 'Nenhuma decisão nesta rua com este caminho.' })]),
    pequenas.length ? el('details', { className: 'mda-pequenos', open: buscando || pequenas.some(l => mdaSel?.rua === rua && mdaSel.chave === l.no.chave) },
      [el('summary', { textContent: `mais ${pequenas.length} linhas de situações com menos de ${MINIMO_NO} decisões` }), ...pequenas.map(linha)]) : null,
  ]);
  return box;
}

// Com o all-in junto (o padrão), "B50" soma "B50" e "B50|AI": a bet all-in conta no tamanho dela.
function tamanhosDaLinha(tam) {
  if (separarAI) return [...FAIXAS_MDA(), ...FAIXAS_MDA().map(f => f + '|AI')].filter(k => tam[k]).map(k => [k, tam[k]]);
  const soma = (a, b) => {
    if (!a || !b) return a || b;
    const s = {};
    for (const c of ['n', 'todos foldam', '1 call', '2 calls', '3+ calls', 'aumentado', 'respondidas', 'ev', 'tam']) s[c] = (a[c] ?? 0) + (b[c] ?? 0);
    s.depois = { Fold: a.depois.Fold + b.depois.Fold, Call: a.depois.Call + b.depois.Call, Raise: a.depois.Raise + b.depois.Raise };
    return s;
  };
  return FAIXAS_MDA().map(f => [f, soma(tam[f], tam[f + '|AI'])]).filter(([, d]) => d);
}

// O painel embaixo dos três boxes: bet sizes (Bet/Raise) ou a resposta por tamanho enfrentado (Fold/Call/Raise).
function detalheMda() {
  if (!mdaSel || !mdaDados) return null;
  const no = mdaDados[mdaSel.rua].find(n => n.chave === mdaSel.chave);
  if (!no) return null;
  const acao = mdaSel.acao, rua = mdaSel.rua, seguinte = rua !== 'river';
  const linhaAtual = no.atual + LETRA_ACAO[acao];
  const botaoAfunilar = (faixa, lado) => seguinte ? el('button', { className: 'ver', type: 'button', textContent: `afunilar → ${NOME_RUA[rua === 'flop' ? 'turn' : 'river']}`,
    title: `Mostrar o ${rua === 'flop' ? 'turn' : 'river'} só de quem fez esta linha${faixa ? ` com ${cod(faixa)}` : ''}`,
    onclick: () => afunilar(rua, linhaAtual, faixa, lado) }) : el('span');
  const corpo = el('tbody');
  let cab, nota;
  if (acao === 'Bet' || acao === 'Raise') {
    for (const [k, d] of tamanhosDaLinha(no.tamanhos[acao] ?? {})) {
      const [faixa, ai] = k.split('|');
      const cel = n => el('td', { className: 'num' + (d.n < AMOSTRA_MINIMA ? ' fraca' : ''), title: tituloIC(n, d.n) }, [
        el('b', { textContent: `${pct(n, d.n)}%` }), el('small', { textContent: ` ${n}` })]);
      const dep = d.depois, totalDep = dep.Fold + dep.Call + dep.Raise;
      // como na Resposta ao sizing do Estudo: só as bets que a mesa respondeu, pela bet média da faixa
      const medio = d.respondidas ? d.tam / d.respondidas : 0, precisa = 100 * medio / (1 + medio);
      const ev = d.respondidas ? 100 * d.ev / d.respondidas : 0, fold = pct(d['todos foldam'], d.respondidas);
      const fraca = d.respondidas < AMOSTRA_MINIMA ? ' fraca' : '';
      corpo.append(el('tr', {}, [
        el('th', {}, [el('span', { className: 'tam' }, [el('b', { textContent: cod(faixa) + (ai ? '-AI' : '') }), el('small', { textContent: faixa + (ai ? ' · all-in' : '') })])]),
        el('td', { className: 'num', title: `${d.n} de ${no.n} decisões desta situação` }, [el('b', { textContent: `${fmt(100 * d.n / no.n, 1)}%` }), el('small', { textContent: ` ${d.n}` })]),
        el('td', { className: 'num' + fraca, title: tituloIC(d['todos foldam'], d.respondidas) }, [
          el('b', { className: d.respondidas ? (fold >= precisa ? 'bom' : 'ruim') : '', textContent: d.respondidas ? `${fold}%` : '—' }), el('small', { textContent: ` ${d['todos foldam']}` })]),
        el('td', { className: 'num' + fraca, title: `bet média ${fmt(medio)} do pote: ${fmt(medio)} ÷ (1 + ${fmt(medio)})` }, [
          el('b', { textContent: d.respondidas ? `${Math.round(precisa)}%` : '—' })]),
        el('td', { className: 'num' + fraca, title: d.respondidas ? `${d.respondidas} bets com resposta` : '' }, [
          el('b', { className: ev > 2 ? 'bom' : ev < -2 ? 'ruim' : 'neutro', textContent: d.respondidas ? `${ev >= 0 ? '+' : ''}${fmt(ev, 0)}` : '—' })]),
        cel(d['1 call']), cel(d['2 calls']), cel(d['3+ calls']), cel(d.aumentado),
        el('td', { className: 'num', title: 'Quando levou raise, o que ele fez depois' }, [totalDep
          ? `F ${pct(dep.Fold, totalDep)}% · C ${pct(dep.Call, totalDep)}% · R ${pct(dep.Raise, totalDep)}%` : '—']),
        // faixa feita só de bets all-in (somadas pelo "all-in junto"): ninguém aposta no turn depois, afunilar daria vazio
      el('td', {}, [ai || (!separarAI && !(no.tamanhos[acao] ?? {})[faixa]) ? el('span') : botaoAfunilar(faixa, 'aposta')]),
      ]));
    }
    cab = ['Tamanho', 'Freq.', 'Todos foldam', 'Precisa foldar', 'EV blefe', '1 call', '2 calls', '3+ calls', 'Aumentado', 'Depois do raise (ele)', ''];
    nota = 'Freq. = quantas vezes ele fez esta bet com este tamanho, entre todas as decisões desta situação (como a coluna "Fre" do H2N). '
      + (separarAI ? '"-AI" = all-in, fora da conta do tamanho. ' : 'As bets all-in estão somadas na faixa do tamanho delas (botão "All-in separado" para ver à parte). ')
      + 'Todos foldam fica verde quando passa do "precisa foldar" (bet ÷ (1 + bet)); EV blefe, em % do pote: +1 pote se todos foldam, −a bet se não. '
      + 'Afunilar segue para a rua seguinte só quem fez essa bet e não levou raise.';
  } else {
    const enf = no.enfrentado ?? {};
    for (const f of FAIXAS_MDA().filter(f => enf[f])) {
      const d = enf[f], n = (d.Fold ?? 0) + (d.Call ?? 0) + (d.Raise ?? 0) + (d.Check ?? 0) + (d.Bet ?? 0);
      const cel = (x, cls = '') => el('td', { className: 'num' + (n < AMOSTRA_MINIMA ? ' fraca' : ''), title: tituloIC(x ?? 0, n) }, [
        el('b', { className: cls, textContent: `${pct(x ?? 0, n)}%` }), el('small', { textContent: ` ${x ?? 0}` })]);
      corpo.append(el('tr', {}, [
        el('th', {}, [el('span', { className: 'tam' }, [el('b', { textContent: cod(f) }), el('small', { textContent: f })])]),
        el('td', { className: 'num' }, [el('b', { textContent: String(n) })]),
        cel(d.Fold, acao === 'Fold' ? 'destaque' : ''), cel(d.Call, acao === 'Call' ? 'destaque' : ''), cel(d.Raise, acao === 'Raise' ? 'destaque' : ''),
        el('td', { className: 'num', title: 'média, mão a mão, de bet ÷ (1 + bet)' }, [`${pct(d.precisa, n)}%`]),
        el('td', {}, [acao === 'Call' && d.Call ? botaoAfunilar(f, 'pagou') : el('span')]),
      ]));
    }
    cab = ['Bet enfrentada', 'Decisões', 'Fold', 'Call', 'Raise', 'Precisa foldar', ''];
    nota = 'O que ele fez contra cada tamanho de bet, nesta situação. "Precisa foldar" é o fold em que um blefe contra ele empata. '
      + 'Afunilar (no call) segue para a rua seguinte só quem pagou aquele tamanho.';
  }
  // B - B no turn: qual foi a bet do flop? O tamanho vira filtro da linha (o mesmo "afunilar", sem sair da linha).
  const seletores = no.prefixo.map((lin, i) => {
    const r = RUAS_MDA[i], ult = lin.slice(-1);
    const lado = ult === 'C' ? 'pagou' : ult === 'B' || ult === 'R' ? 'aposta' : null;
    if (!lado) return null;
    const atual = caminho[r]?.linha === lin ? caminho[r].faixa ?? '' : '';
    return el('label', { className: 'mda-sel' + (atual ? ' ativo' : ''),
      title: `Só as mãos em que ${lado === 'pagou' ? 'a bet que ele pagou' : 'a bet dele'} no ${NOME_RUA[r].toLowerCase()} foi deste tamanho` }, [
      `${lado === 'pagou' ? 'bet que ele pagou' : 'bet dele'} no ${NOME_RUA[r].toLowerCase()} (${lin})`,
      el('select', { onchange: e => escolherFaixaAnterior(r, lin, e.target.value, lado) }, [
        el('option', { value: '', textContent: 'todos os tamanhos', selected: !atual }),
        ...opcoes.faixas_h2n.map(f => el('option', { value: f, textContent: `${cod(f)} (${f})`, selected: f === atual }))])]);
  }).filter(Boolean);
  return el('section', { className: 'card mda-detalhe' }, [
    seletores.length ? el('div', { className: 'mda-seletores' }, seletores) : null,
    el('div', { className: 'mda-detalhe-cab' }, [
      el('h3', {}, [`${NOME_RUA[rua]} · ${rotuloLinha(no, acao)}`, el('small', { textContent: ` ${descreverNo(no)} · ${pct(no.acoes[acao], no.n)}% (${no.acoes[acao]} de ${no.n})` })]),
      el('div', {}, [botaoAfunilar(null, 'aposta'),
        el('button', { className: 'ver', type: 'button', textContent: 'fechar', onclick: () => { mdaSel = null; desenharMda(); } })])]),
    corpo.children.length ? el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, cab.map(c => el('th', { textContent: c })))]), corpo])]) : el('p', { className: 'nota', textContent: 'Sem tamanhos para mostrar.' }),
    el('p', { className: 'nota', textContent: nota })]);
}

function desenharMda(rolar = false) {
  if (!mdaDados) return;
  const detalhe = detalheMda();
  $('mda').replaceChildren(barraMda(), el('div', { className: 'mda-grade' }, RUAS_MDA.map(r => colunaMda(r, mdaDados[r]))), ...(detalhe ? [detalhe] : []));
  if (detalhe && rolar) detalhe.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function consultarMda(meu) {
  const r = await (await fetch('/api/mda', { method: 'POST', body: JSON.stringify({ filtros, caminho }) })).json();
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (r.erro) { $('mda').replaceChildren(el('p', { className: 'nota', textContent: 'Erro: ' + r.erro })); return; }
  mdaDados = r;
  if (mdaSel && !mdaDados[mdaSel.rua]?.some(n => n.chave === mdaSel.chave)) mdaSel = null;
  desenharMda();
}

// ------------------------------------------------------------------------- Jogadores (gráfico de resultado, como no MetaLens)
// Lista por número de mãos; o gráfico mão a mão do jogador escolhido: Net, com e sem showdown, e o EV ajustado por all-in.

const LINHAS_GRAFICO = [
  { nome: 'Net', cor: 'var(--g-net)', y: p => p[1] },
  { nome: 'Com showdown', cor: 'var(--g-sd)', y: p => p[2] },
  { nome: 'Sem showdown', cor: 'var(--g-nsd)', y: p => p[1] - p[2] },
  { nome: 'EV all-in', cor: 'var(--g-ev)', y: p => p[3] },
  { nome: 'Net + jackpot', cor: 'var(--g-jp)', y: p => p[1] + p[5], so: s => s.pontos[s.pontos.length - 1][5] !== 0 },
];
// a linha do jackpot só aparece para quem ganhou jackpot
const linhasDe = s => LINHAS_GRAFICO.filter(l => !l.so || l.so(s));
const desligadas = new Set();
let listaJogadores = null, jogadorSel = lerLocal('bp.jogador'), buscaJogador = '', serieAtual = null;
let filtrosJog = lerLocal('bp.filtrosJog') ?? {};  // { n_jogadores: [8, 7], data: { min, max } }
const bb = (v, casas = 1) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${fmt(Math.abs(v), casas)} BB`;
const por100 = (v, maos) => (maos ? 100 * v / maos : 0);
const corValor = v => (v > 0 ? 'bom' : v < 0 ? 'ruim' : '');

function tabelaJogadores() {
  const termo = buscaJogador.trim().toLowerCase();
  const lista = listaJogadores.jogadores.filter(j => !termo || j.nome.toLowerCase().includes(termo));
  const corpo = el('tbody', {}, lista.slice(0, 300).map(j => el('tr', {
    className: 'jogador' + (j.nome === jogadorSel ? ' ativo' : ''), tabIndex: 0,
    onclick: () => escolherJogador(j.nome), onkeydown: e => { if (e.key === 'Enter') escolherJogador(j.nome); },
  }, [
    el('th', { textContent: j.nome }),
    el('td', { className: 'num', textContent: j.maos.toLocaleString('pt-BR') }),
    el('td', { className: 'num' }, [el('b', { className: corValor(j.net), textContent: bb(j.net, 0) })]),
    el('td', { className: 'num' + (j.maos < AMOSTRA_MINIMA ? ' fraca' : ''),
      title: j.ic === null ? 'uma mão só: sem intervalo' : `intervalo de 95%: ${fmt(por100(j.net, j.maos) - j.ic, 0)} a ${fmt(por100(j.net, j.maos) + j.ic, 0)} BB/100` }, [
      el('b', { className: corValor(j.net), textContent: fmt(por100(j.net, j.maos), 1) }),
      el('small', { textContent: j.ic === null ? '' : ` ±${fmt(j.ic, 0)}` })]),
    el('td', { className: 'num' }, [el('span', { className: corValor(j.ev), textContent: fmt(por100(j.ev, j.maos), 1) })]),
  ])));
  return el('div', { className: 'card lista-jogadores' }, [
    el('input', { type: 'search', placeholder: `procurar entre ${listaJogadores.jogadores.length.toLocaleString('pt-BR')} jogadores`,
      value: buscaJogador, ariaLabel: 'Procurar jogador', oninput: e => { buscaJogador = e.target.value; redesenharLista(); } }),
    el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, [['Jogador'], ['Mãos'], ['Net'], ['BB/100', '± a meia largura do intervalo de 95%: com poucas centenas de mãos ela passa de 50 BB/100'],
        ['EV BB/100', 'BB/100 pelo EV ajustado por all-in']]
        .map(([c, d]) => el('th', d ? { textContent: c, title: d } : { textContent: c })))]), corpo])]),
    lista.length > 300 ? el('p', { className: 'nota', textContent: `mostrando 300 de ${lista.length}: procure pelo nome para achar os outros` }) : null,
  ]);
}
function redesenharLista() {
  const velha = document.querySelector('#jogadores .lista-jogadores');
  if (velha) velha.replaceWith(tabelaJogadores());
  document.querySelector('#jogadores .lista-jogadores input')?.focus();
}

async function escolherJogador(nome) {
  jogadorSel = nome;
  gravarLocal('bp.jogador', nome);
  serieAtual = await (await fetch('/api/serie', { method: 'POST', body: JSON.stringify({ nome, filtros: filtrosJog }) })).json();
  desenharJogadores();
}

function mudarFiltrosJog(f) {
  filtrosJog = f;
  gravarLocal('bp.filtrosJog', f);
  listaJogadores = null;
  serieAtual = null;
  consultar();
}

function barraFiltrosJog() {
  const jog = filtrosJog.n_jogadores ?? [];
  const seg = el('div', { className: 'seg', role: 'group', 'aria-label': 'Jogadores na mesa' });
  for (let k = 8; k >= 2; k--) {
    seg.append(el('button', { type: 'button', textContent: String(k), ariaPressed: String(jog.includes(k)), onclick: () => {
      const s = new Set(jog);
      s.has(k) ? s.delete(k) : s.add(k);
      const f = { ...filtrosJog };
      if (s.size) f.n_jogadores = [...s].sort((a, b) => b - a); else delete f.n_jogadores;
      mudarFiltrosJog(f);
    } }));
  }
  const data = (lado, rot) => el('input', { type: 'date', id: `jog-data-${lado}`, value: filtrosJog.data?.[lado] ?? '', 'aria-label': rot,
    min: opcoes.datas?.[0] ?? '', max: opcoes.datas?.[1] ?? '',
    onchange: e => {
      const d = { ...(filtrosJog.data ?? {}), [lado]: e.target.value };
      const f = { ...filtrosJog, data: d };
      if (!d.min && !d.max) delete f.data;
      mudarFiltrosJog(f);
    } });
  const algum = Object.keys(filtrosJog).length > 0;
  return el('div', { className: 'card filtros-jog' }, [
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Jogadores na mesa (marque vários)' }), seg]),
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'De' }), data('min', 'Data inicial')]),
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Até' }), data('max', 'Data final')]),
    algum ? el('button', { className: 'btn', type: 'button', textContent: 'Tirar filtros', onclick: () => mudarFiltrosJog({}) }) : null]);
}

// O OCR pode partir um jogador em dois nicks (um 丶 inicial que o OCR perde): pares a um caractere de distância que nunca
// sentaram na mesma mão. Só junta com a confirmação do dono; "não é" some da lista para sempre.
function cartaoSugestoes() {
  const sug = listaJogadores.sugestoes ?? [];
  if (!sug.length) return null;
  const decidir = async (s, junta) => {
    const r = await (await fetch('/api/juntar', { method: 'POST', body: JSON.stringify({ a: s.a, b: s.b, junta, filtros: filtrosJog }) })).json();
    if (r.erro) return;
    listaJogadores = r;
    serieAtual = null;
    consultar();
  };
  return el('details', { className: 'card' }, [
    el('summary', { textContent: `Possíveis nicks repetidos (${sug.length})` }),
    el('div', { className: 'sugestoes' }, [
      el('p', { className: 'nota', style: 'padding:0', textContent: 'Dois nicks a um caractere de distância que nunca estiveram na mesma mão: pode ser o mesmo jogador lido de dois jeitos. Confira num print antes de juntar.' }),
      ...sug.map(s => el('div', { className: 'sugestao' }, [
        el('span', { textContent: `${s.a} (${s.maos_a}) → ${s.b} (${s.maos_b})` }),
        el('button', { className: 'btn', type: 'button', textContent: 'mesmo jogador', onclick: () => decidir(s, true) }),
        el('button', { className: 'btn', type: 'button', textContent: 'não é', onclick: () => decidir(s, false) })]))])]);
}

const passoRedondo = (faixa, n) => {
  const cru = faixa / n || 1, p = 10 ** Math.floor(Math.log10(cru));
  return [1, 2, 5, 10].map(m => m * p).find(s => s >= cru);
};

function graficoJogador(s, caixa) {
  const pts = s.pontos, ult = pts[pts.length - 1], maos = s.maos;
  const ligadas = linhasDe(s).filter(l => !desligadas.has(l.nome));
  const legenda = el('div', { className: 'legenda' }, linhasDe(s).map(l => el('button', {
    type: 'button', ariaPressed: String(!desligadas.has(l.nome)),
    onclick: () => { if (!desligadas.delete(l.nome)) desligadas.add(l.nome); desenharJogadores(); },
  }, [el('i', { style: `background:${l.cor}` }), l.nome, el('b', { textContent: bb(l.y(ult)) }),
    el('small', { textContent: `${fmt(por100(l.y(ult), maos), 1)} BB/100` })])));
  const W = Math.max(caixa.clientWidth - 30, 300), H = 380, E = 70, D = 12, T = 10, B = 26;
  const ys = pts.flatMap(p => ligadas.map(l => l.y(p)));
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const passo = passoRedondo(hi - lo, 6);
  lo = Math.floor(lo / passo) * passo; hi = Math.max(Math.ceil(hi / passo) * passo, lo + passo);
  const X = i => E + (i / Math.max(maos, 1)) * (W - E - D);
  const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `Resultado de ${maos} mãos de ${s.nome}` });
  for (let k = Math.round(lo / passo); k <= Math.round(hi / passo); k++) {
    g.append(svg('line', { x1: E, x2: W - D, y1: Y(k * passo), y2: Y(k * passo), class: k === 0 ? 'zero' : 'grade' }),
      svg('text', { x: E - 6, y: Y(k * passo) + 4, 'text-anchor': 'end' }, [`${fmt(k * passo, 0)}`]));
  }
  const px = passoRedondo(maos, 6);
  for (let i = 0; i <= maos; i += px) g.append(svg('text', { x: X(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : 'middle' }, [i.toLocaleString('pt-BR')]));
  for (const l of [...ligadas].reverse()) {  // o Net por cima
    const linha = svg('polyline', { fill: 'none', 'stroke-width': 1.6, 'stroke-linejoin': 'round',
      points: pts.map(p => `${X(p[0]).toFixed(1)},${Y(l.y(p)).toFixed(1)}`).join(' ') });
    linha.style.stroke = l.cor;
    g.append(linha);
  }
  const cursor = svg('line', { y1: T, y2: H - B, class: 'cursor', visibility: 'hidden' });
  g.append(cursor);
  const dica = el('div', { className: 'dica', hidden: true });
  g.addEventListener('mousemove', e => {
    const r = g.getBoundingClientRect();
    const i = (((e.clientX - r.left) * (W / r.width) - E) / (W - E - D)) * maos;
    let a = 0, b = pts.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (pts[m][0] < i) a = m; else b = m; }
    const p = Math.abs(pts[a][0] - i) < Math.abs(pts[b][0] - i) ? pts[a] : pts[b];
    for (const k of ['x1', 'x2']) cursor.setAttribute(k, String(X(p[0])));
    cursor.setAttribute('visibility', 'visible');
    dica.replaceChildren(el('div', {}, [el('b', { textContent: `mão ${p[0].toLocaleString('pt-BR')}` }), el('span', { textContent: p[4] ?? '' })]),
      ...ligadas.map(l => el('div', {}, [el('span', { textContent: l.nome, style: `color:${l.cor}` }), el('b', { textContent: bb(l.y(p)) })])));
    dica.hidden = false;
    const bx = caixa.getBoundingClientRect(), x = e.clientX - bx.left;
    dica.style.left = `${x + 230 > bx.width ? x - 240 : x + 16}px`;
    dica.style.top = `${e.clientY - bx.top + 12}px`;
  });
  g.addEventListener('mouseleave', () => { dica.hidden = true; cursor.setAttribute('visibility', 'hidden'); });
  return [legenda, g, dica];
}

function desenharJogadores() {
  if (!listaJogadores) return;
  const caixa = el('div', { className: 'card grafico-jogador' });
  $('jogadores').replaceChildren(barraFiltrosJog(),
    el('div', { className: 'jogadores-grade' }, [el('div', { style: 'display:flex;flex-direction:column;gap:14px;min-width:0' },
      [tabelaJogadores(), cartaoSugestoes()]), caixa]));
  const s = serieAtual;
  if (!s || s.nome !== jogadorSel) return;
  if (!s.maos) { caixa.append(el('p', { className: 'nota', textContent: 'Sem mãos para este jogador.' })); return; }
  const ult = s.pontos[s.pontos.length - 1];
  caixa.append(
    el('div', { className: 'cab-jogador' }, [el('h2', { textContent: s.nome }),
      el('span', { textContent: `${s.maos.toLocaleString('pt-BR')} mãos · ` }),
      el('b', { className: corValor(ult[1]), textContent: `${fmt(por100(ult[1], s.maos), 1)} BB/100` }),
      el('span', { textContent: ` · EV ${fmt(por100(ult[3], s.maos), 1)} BB/100` })]),
    ...graficoJogador(s, caixa),
    el('p', { className: 'nota', textContent: [
      `${s.maos.toLocaleString('pt-BR')} mãos em ordem cronológica (pela hora do HAND ID), em BB de cada mesa`,
      'com showdown = mãos em que ele ficou até o fim com mais alguém (mostrando ou não); sem showdown = Net − com showdown',
      'EV all-in: quando o dinheiro entrou antes do river, ele leva a equity dele em cada pote (todos os boards que faltavam), não o que saiu',
      ult[5] ? `Net + jackpot: soma os ${fmt(ult[5], 1)} BB de jackpot pagos pela casa, que ficam fora do Net (só poker)` : '',
      'mão com seguro ou jackpot entra para quem tem o saldo batendo com o poker pelas cartas (o jackpot é descontado)',
      listaJogadores.fora.seguro_reconstruido ? `${listaJogadores.fora.seguro_reconstruido} saldos de quem o seguro pagou viraram o resultado do poker (perdeu tudo pelas cartas: menos o que investiu)` : '',
      listaJogadores.fora.saldo_nao_confere ? `${listaJogadores.fora.saldo_nao_confere} saldos de seguro ficam fora: ele levou parte do pote e o valor depende do resíduo do WPT` : '',
      listaJogadores.fora.sem_nick ? `${listaJogadores.fora.sem_nick} mãos sem o nick de alguém ficam fora` : '',
    ].filter(Boolean).join(' · ') }));
}

async function consultarJogadores(meu) {
  if (!listaJogadores) listaJogadores = await (await fetch('/api/jogadores', { method: 'POST', body: JSON.stringify({ filtros: filtrosJog }) })).json();
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (!jogadorSel || !listaJogadores.jogadores.some(j => j.nome === jogadorSel)) jogadorSel = listaJogadores.jogadores[0]?.nome;
  if (jogadorSel && serieAtual?.nome !== jogadorSel) return escolherJogador(jogadorSel);
  desenharJogadores();
}
let tempoRedim;
window.addEventListener('resize', () => {
  clearTimeout(tempoRedim);
  tempoRedim = setTimeout(() => { if (vista === 'jogadores') desenharJogadores(); }, 150);
});

// ------------------------------------------------------------------------- selo de confiança e aba Conferir
// O selo do topo resume o que se pode afirmar sobre os dados: a auditoria (invariantes em todas as mãos) e a taxa de
// erro medida conferindo mãos sorteadas contra o print (limite de cima de 95%, Clopper-Pearson).

const pctTeto = t => (t === null || t === undefined ? '' : `${fmt(100 * t, t < 0.1 ? 1 : 0)}%`);

function desenharSelo(s) {
  if (!s) return;
  const problemas = Object.values(s.problemas).reduce((a, b) => a + b, 0);
  const partes = [problemas ? `auditoria: ${problemas} problema${problemas > 1 ? 's' : ''}` : 'auditoria ok'];
  if (!s.leitor) partes.push('leitor ainda não aceito');
  partes.push(s.conferidas ? `${s.conferidas} conferidas · erro ≤ ${pctTeto(s.teto)}` : 'nenhuma mão conferida');
  const titulo = [
    problemas ? 'Checagens que falharam: ' + Object.entries(s.exemplos).map(([k, v]) => `${k} (${s.problemas[k]}): ${v.join(' | ')}`).join(' · ')
      : `Todas as invariantes valem nas ${s.maos.toLocaleString('pt-BR')} mãos (python tracker.py auditar).`,
    s.leitor ? `Leitor aceito: ${s.leitor}.` : 'Nenhuma leitura aceita ainda: rode python tracker.py refazer e depois aceitar.',
    s.conferidas ? `${s.conferidas} mãos sorteadas conferidas no print, ${s.erros} com erro: a taxa real de erro fica abaixo de ${pctTeto(s.teto)} com 95% de confiança.`
      : 'Confira mãos sorteadas na aba Conferir para medir a taxa de erro da leitura.',
    'Clique para conferir.'].join('\n');
  const selo = el('button', { type: 'button', id: 'selo', className: 'selo ' + (problemas ? 'ruim' : s.conferidas && s.leitor ? 'ok' : ''),
    title: titulo, onclick: () => trocarVista('conferir') }, [el('i'), partes.join(' · ')]);
  const velho = $('selo');
  if (velho) velho.replaceWith(selo); else $('info').after(selo);
}

let confModo = 'sorteio', confDados = null;

async function consultarConferir(meu, marcacao = null) {
  const r = await (await fetch(marcacao ? '/api/marcar' : '/api/conferir', { method: 'POST',
    body: JSON.stringify(marcacao ?? { modo: confModo }) })).json();
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (r.erro) { $('conferir').prepend(el('p', { className: 'nota ruim', textContent: 'Erro: ' + r.erro })); return; }
  confDados = r;
  if (marcacao) listaJogadores = null;  // um erro tira a mão do estudo: a aba Jogadores relê
  desenharSelo(r.saude);
  desenharConferir();
}

function marcarConferencia(ok) {
  const m = confDados?.mao;
  if (!m) return;
  const campo = $('conf-campo')?.value, obs = $('conf-obs')?.value;
  if (!ok && !campo) { $('conf-campo').focus(); return; }
  document.body.classList.add('carregando');
  consultarConferir(++pedido, { hand_id: m.hand_id, ok, campo, obs, modo: confModo });
}

const textoCartas = cs => (cs ?? '').split(' ').filter(Boolean).map(c => c.replace('10', 'T')).join(' ');

function desenharConferir() {
  const r = confDados, s = r.saude, m = r.mao;
  const segModo = el('div', { className: 'seg', role: 'group', 'aria-label': 'Modo' }, [
    ['sorteio', 'Sorteio (mede a taxa)'], ['suspeita', `Suspeitas (${s.suspeitas.length})`],
    ['nicks', confModo === 'nicks' && r.restantes !== undefined ? `Nicks repetidos (${r.restantes})` : 'Nicks repetidos']].map(([v, t]) => el('button', {
    type: 'button', textContent: t, ariaPressed: String(confModo === v), onclick: () => { confModo = v; consultar(); } })));
  const placar = el('span', { className: 'placar' }, s.conferidas
    ? [el('b', { textContent: `${s.conferidas}` }), ` sorteadas conferidas · `, el('b', { textContent: `${s.erros}` }), ` com erro · taxa de erro ≤ `,
      el('b', { textContent: pctTeto(s.teto) }), ' (95%)' + (s.conferidas_total > s.conferidas ? ` · mais ${s.conferidas_total - s.conferidas} da fila de suspeitas` : '')]
    : ['Nenhuma mão sorteada conferida ainda. 100 sem erro dizem "erro < 3%"; 300, "< 1%".']);
  const topo = el('section', { className: 'card conf-topo', style: 'padding:12px 16px' }, [segModo, placar]);
  if (confModo === 'nicks' && r.modo !== 'nicks') {  // o JS novo chegou, o Python não: o servidor precisa reiniciar
    $('conferir').replaceChildren(topo, el('section', { className: 'card' }, [el('p', { className: 'nota neutro', textContent:
      'O site está rodando uma versão antiga do servidor, que ainda não conhece este modo. Feche a janela do "Abrir site.bat" e abra de novo.' })]));
    return;
  }
  if (confModo === 'nicks') { $('conferir').replaceChildren(topo, ...conferirNick(r)); return; }
  if (!m) {
    $('conferir').replaceChildren(topo, el('section', { className: 'card' }, [el('p', { className: 'nota', textContent:
      confModo === 'suspeita' ? 'Nenhuma carta duvidosa esperando conferência.' : 'Todas as mãos já foram conferidas.' })]));
    return;
  }
  const jogs = el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Pos', 'Nick', 'Cartas', 'Stack', 'Saldo'].map(c => el('th', { textContent: c })))]),
    el('tbody', {}, m.jogadores.map(j => el('tr', { className: j.cartas && !j.showdown ? 'olhar' : '',
      title: j.cartas && !j.showdown ? 'Estas cartas não decidiram o showdown: nenhuma conta confere, só o seu olho.' : '' }, [
      el('td', { textContent: j.pos + (j.hero ? ' (Hero)' : '') }), el('td', { textContent: j.nome ?? '—' }),
      el('td', { className: 'carta', textContent: textoCartas(j.cartas) || '—' }),
      el('td', { className: 'num', textContent: fmt(j.stack) }),
      el('td', { className: 'num ' + corValor(j.net), textContent: fmt(j.net) })])))]);
  const ruas = el('div', { className: 'rua-linha' }, m.linhas.map(([rua, board, pote, acoes]) => el('div', {}, [
    el('b', { textContent: NOME_RUA[rua] }), el('span', { className: 'carta', textContent: textoCartas(board) }), ` (${fmt(pote)}) `,
    acoes.map(([pos, a]) => `${pos} ${a}`).join(' · ')])));
  const duvida = m.pior_rank > m.limiar;
  const corpo = el('section', { className: 'card conf-mao' }, [
    el('h3', {}, [`HAND ID ${m.hand_id}`, el('small', { className: 'muted', textContent: ` · ${m.data ?? ''} · ${m.n} jogadores · valores em BB (print em ${m.unidade})` })]),
    m.obs ? el('p', { className: 'nota', style: 'padding:0', textContent: `Marcada: ${m.obs}` }) : null,
    duvida ? el('p', { className: 'nota neutro', style: 'padding:0', textContent:
      `Carta duvidosa: o número de alguma carta ficou a ${fmt(m.pior_rank, 3)} do modelo (99% das mãos ficam abaixo de ${fmt(m.limiar, 2)}; o leitor aceita até 0,16). Olhe todas as cartas com calma.` }) : null,
    el('div', {}, [el('b', { textContent: 'Board ' }), el('span', { className: 'carta', textContent: textoCartas(m.board) })]),
    jogs, ruas,
    el('ul', { className: 'checklist' }, [
      el('li', { textContent: 'as cartas marcadas com ● (não decidiram o showdown: só o seu olho confere) e o board;' }),
      el('li', { textContent: 'posição e nick de cada assento;' }),
      el('li', { textContent: 'a ordem e o verbo de cada ação (o "\'" marca all-in).' }),
      el('li', { textContent: 'Valores e saldos a auditoria já confere pela soma e pelas cartas; marque se vir um diferente.' })]),
    el('div', { className: 'conf-acoes' }, [
      el('button', { className: 'btn primario', type: 'button', textContent: 'Tudo certo', onclick: () => marcarConferencia(true) }),
      el('select', { id: 'conf-campo', 'aria-label': 'Campo errado' }, [el('option', { value: '', textContent: 'campo errado…' }),
        ...r.campos.map(c => el('option', { value: c, textContent: c }))]),
      el('input', { id: 'conf-obs', placeholder: 'o que está errado (opcional)', maxLength: 500, 'aria-label': 'Observação' }),
      el('button', { className: 'btn erro', type: 'button', textContent: 'Achei erro', onclick: () => marcarConferencia(false),
        title: 'A mão sai do estudo na hora e entra na taxa de erro' }),
      el('button', { className: 'btn', type: 'button', textContent: 'Pular', onclick: () => consultar(),
        title: 'Outra mão, sem marcar esta' })]),
  ]);
  $('conferir').replaceChildren(topo, el('div', { className: 'conf-grade' }, [
    el('section', { className: 'card conf-print' }, [el('img', { src: `/print/${encodeURIComponent(m.png)}`, alt: `Print da mão ${m.hand_id}` })]),
    corpo]));
}

// Nicks repetidos: dois nicks a um caractere de distância que nunca sentaram juntos. Mostra um print de cada (o
// nick está na posição indicada), o parecer do Claude (que olhou os prints antes) e deixa o dono decidir.
const PARECER = { mesmo: ['bom', 'Mesmo jogador'], diferente: ['ruim', 'Jogadores diferentes'], duvida: ['neutro', 'Na dúvida'] };

async function decidirNick(par, junta) {
  document.body.classList.add('carregando');
  const meu = ++pedido;
  const r = await (await fetch('/api/juntar', { method: 'POST',
    body: JSON.stringify({ a: par.a, b: par.b, junta, modo: 'nicks' }) })).json();
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (r.erro) { $('conferir').prepend(el('p', { className: 'nota ruim', textContent: 'Erro: ' + r.erro })); return; }
  listaJogadores = null;  // a aba Jogadores relê com o nick junto
  confDados = r;
  desenharConferir();
}

function conferirNick(r) {
  const par = r.nick;
  if (!par) return [el('section', { className: 'card' }, [el('p', { className: 'nota', textContent: 'Nenhum par de nicks esperando decisão.' })])];
  const [cls, rot] = PARECER[par.parecer?.veredito] ?? ['', 'sem parecer ainda'];
  const lado = l => el('section', { className: 'card conf-print' }, [
    el('div', { className: 'nota', style: 'padding:8px 12px' }, [el('b', { textContent: par[l] }),
      ` · ${par['maos_' + l]} mão${par['maos_' + l] > 1 ? 's' : ''} · procure o nick na posição ${par.maos[l][0]?.pos ?? '?'}`]),
    ...par.maos[l].slice(0, 1).map(m => el('img', { src: `/print/${encodeURIComponent(m.png)}`, alt: `Print da mão ${m.hand_id}` }))]);
  return [
    el('section', { className: 'card conf-mao' }, [
      el('h3', {}, [`${par.a} → ${par.b}`, el('small', { className: 'muted', textContent: ` · ${par.maos_a} + ${par.maos_b} mãos, nunca na mesma mesa` })]),
      el('p', { style: 'margin:0' }, [el('b', { className: cls, textContent: `Parecer do Claude: ${rot}. ` }), par.parecer?.motivo ?? '']),
      el('p', { className: 'nota', style: 'padding:0', textContent: 'Compare o nick escrito nos dois prints. "Mesmo jogador" junta o da esquerda no da direita na aba Jogadores (dá para desfazer); as stats da população não mudam.' }),
      el('div', { className: 'conf-acoes' }, [
        el('button', { className: 'btn primario', type: 'button', textContent: 'Mesmo jogador (juntar)', onclick: () => decidirNick(par, true) }),
        el('button', { className: 'btn erro', type: 'button', textContent: 'Não é o mesmo', onclick: () => decidirNick(par, false) })])]),
    el('div', { className: 'lado-a-lado nicks-prints' }, [lado('a'), lado('b')])];
}

// Hero × população no topo do Painel: onde o jeito dele jogar mais se afasta do field (só vilões).
function cartaoLeaks(leaks) {
  if (!leaks?.length) return null;
  const linhas = leaks.map(l => {
    const [fh, nh] = l.hero, [fp, np] = l.pop, dif = pct(fh, nh) - pct(fp, np), sig = Math.abs(l.z) >= 2;
    const tr = el('tr', { className: 'clicavel' + (sig ? ' sig' : ''), tabIndex: 0, title: 'Abrir este spot no Estudo, só com as suas decisões' }, [
      el('th', { textContent: `${l.secao} · ${l.nome}` }),
      el('td', { className: 'num' + (nh < AMOSTRA_MINIMA ? ' fraca' : ''), title: tituloIC(fh, nh) }, [el('b', { textContent: `${pct(fh, nh)}%` }), el('small', { textContent: ` ${nh}` })]),
      el('td', { className: 'num', title: tituloIC(fp, np) }, [`${pct(fp, np)}%`]),
      el('td', { className: 'num' + (sig ? ' neutro' : '') }, [`${dif > 0 ? '+' : ''}${dif} pp`]),
      el('td', { className: 'num z', title: '|z| ≥ 2: a diferença dificilmente é acaso' }, [fmt(l.z, 1)]),
      el('td', { className: 'num', title: 'lucro médio por decisão (BB), você × população' }, [l.lucro_hero === null ? '—' : `${fmt(l.lucro_hero, 1)} × ${fmt(l.lucro_pop, 1)}`]),
      el('td', { className: 'num' }, [l.bb === null ? '—' : el('b', { className: corValor(l.bb), textContent: bb(l.bb, 0) })])]);
    tr.onclick = tr.onkeydown = e => {
      if (e.type !== 'click' && e.key !== 'Enter') return;
      filtros = { ...structuredClone(l.base), hero: [1] };
      trocarVista('estudo');
    };
    return tr;
  });
  return el('section', { className: 'card leaks' }, [
    el('h2', {}, ['Você × população', el('small', { className: 'muted', textContent: ' as stats do painel, das que mais custam para as que mais rendem' })]),
    el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Spot', 'Você', 'População', 'Diferença', 'z', 'Lucro/decisão', 'BB no total'].map(c => el('th', { textContent: c })))]),
      el('tbody', {}, linhas)])]),
    el('p', { className: 'nota', textContent: 'População = só os vilões (sem você). BB no total = (seu lucro médio no spot − o da população) × suas decisões: '
      + 'quanto o seu jeito de jogar o spot rendeu a mais ou a menos que o do field. O lucro mistura sorte de carta; as linhas apagadas têm |z| < 2 '
      + '(a diferença de frequência pode ser acaso). Mãos com seguro/jackpot ficam fora do lucro.' })]);
}

// ------------------------------------------------------------------------- consulta e desenho

function quadrosDeSizing(r) {
  const temBets = Object.values(r.grafico).some(g => g.usos);
  const temDefesa = Object.values(r.defesa).some(d => d.n);
  if (temDefesa && !temBets) {
    return [el('div', { className: 'lado-a-lado' }, [cartaoDefesa(r.defesa), cartaoGrafico(pontosDefesa(r.defesa), 'defesa')])];
  }
  const quadros = [el('div', { className: 'lado-a-lado' }, [cartaoResposta(r.grafico), cartaoGrafico(pontosAtaque(r.grafico), 'ataque')])];
  if (temDefesa) quadros.push(cartaoDefesa(r.defesa));
  return quadros;
}

function barraQuadros() {
  const algumAberto = Object.values(abertos).every(v => v !== false) || Object.keys(abertos).length === 0;
  return el('div', { className: 'barra-quadros' }, [el('button', { className: 'btn', id: 'minimizar', type: 'button',
    textContent: algumAberto ? 'Minimizar tudo' : 'Abrir todos os quadros', onclick: minimizarTudo })]);
}

let pedido = 0;
let vista = ['painel', 'mda', 'jogadores', 'conferir'].includes(lerLocal('bp.vista2')) ? lerLocal('bp.vista2') : 'estudo';
let filtroA = lerLocal('bp.filtroA');

async function consultar() {
  if (!opcoes) return;  // trocou de aba durante a carga: o início chama trocarVista(vista) quando as opções chegarem
  const meu = ++pedido;
  montarComando();
  mostrarAtivos();
  document.body.classList.add('carregando');
  if (vista === 'painel') return consultarPainel(meu);
  if (vista === 'mda') return consultarMda(meu);
  if (vista === 'jogadores') return consultarJogadores(meu);
  if (vista === 'conferir') return consultarConferir(meu);
  const [r, a] = await Promise.all([
    fetch('/api/consulta', { method: 'POST', body: JSON.stringify(filtros) }).then(x => x.json()),
    filtroA ? fetch('/api/consulta', { method: 'POST', body: JSON.stringify(filtroA) }).then(x => x.json()) : null]);
  if (meu !== pedido) return;  // chegou uma consulta mais nova enquanto esta voltava
  document.body.classList.remove('carregando');
  if (r.erro) { $('estudo').replaceChildren(el('p', { className: 'nota', textContent: 'Erro: ' + r.erro })); return; }
  if (!r.geral) {
    $('estudo').replaceChildren(barraQuadros(), cartaoMesa(r.mesa), el('section', { className: 'card' }, [
      el('p', { className: 'nota', textContent: 'Nenhuma decisão com estes filtros. Tire algum filtro (× nas pílulas acima).' })]));
    return;
  }
  $('estudo').replaceChildren(
    barraQuadros(),
    cartaoMesa(r.mesa),
    cartaoRelatorio(r, a?.geral),
    ...quadrosDeSizing(r),
    el('div', { className: 'linha-cards' }, [
      cartaoDistribuicao('forca', 'Força da mão', 'categorias do H2N, nesta rua', r.forca, opcoes.forcas,
        'Só aparece quem tem cartas conhecidas: o Hero e quem mostrou no showdown (puxa para mãos fortes).'),
      cartaoDistribuicao('draws', 'Draws', 'flop e turn, entre as decisões com draw', r.draw, opcoes.draws)]),
  );
}

async function consultarPainel(meu) {
  const [r, leaks] = await Promise.all([
    fetch('/api/painel', { method: 'POST', body: JSON.stringify(filtros) }).then(x => x.json()),
    fetch('/api/leaks', { method: 'POST', body: JSON.stringify(filtros) }).then(x => x.json())]);
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (!Array.isArray(r)) { $('painel').replaceChildren(el('p', { className: 'nota', textContent: 'Erro: ' + (r.erro ?? '') })); return; }
  const secoes = {};
  for (const s of r) (secoes[s.secao] ??= []).push(s);
  $('painel').replaceChildren(
    ...(Array.isArray(leaks) && !filtros.hero ? [cartaoLeaks(leaks)].filter(Boolean) : []),
    el('p', { className: 'nota', style: 'padding:0', textContent: 'Stats prontas do field. Os filtros da barra de cima valem para todas. Clique numa linha para abrir o spot no Estudo.' }),
    el('div', { className: 'painel-grade' }, Object.entries(secoes).map(([secao, stats]) => el('section', { className: 'card' }, [
      el('h2', { textContent: secao }),
      el('table', {}, [el('tbody', {}, stats.map(s => {
        const [f, n] = s.v;
        const tr = el('tr', { className: 'clicavel', tabIndex: 0, title: 'Abrir este spot no Estudo' }, [
          el('th', { textContent: s.nome }),
          el('td', { className: 'num' + (n < AMOSTRA_MINIMA ? ' fraca' : ''), title: tituloIC(f, n) }, [
            el('b', { textContent: n ? `${pct(f, n)}%` : '—' })]),
          el('td', { className: 'num', style: 'color:var(--muted)', textContent: n.toLocaleString('pt-BR') })]);
        tr.onclick = tr.onkeydown = e => {
          if (e.type !== 'click' && e.key !== 'Enter') return;
          filtros = { ...filtros, ...structuredClone(s.base) };
          trocarVista('estudo');
        };
        return tr;
      }))])]))));
}

function trocarVista(v) {
  vista = v;
  gravarLocal('bp.vista2', v);
  $('estudo').hidden = v !== 'estudo';
  $('painel').hidden = v !== 'painel';
  $('mda').hidden = v !== 'mda';
  $('jogadores').hidden = v !== 'jogadores';
  $('conferir').hidden = v !== 'conferir';
  $('comando').hidden = v === 'mda' || v === 'jogadores' || v === 'conferir';
  $('ativos').hidden = v === 'jogadores' || v === 'conferir';  // na MDA, rua/situação/linha vêm da árvore; Jogadores tem os seus
  for (const aba of ['estudo', 'painel', 'mda', 'jogadores', 'conferir']) $('aba-' + aba).setAttribute('aria-selected', String(v === aba));
  mudou();
}

function mudou() {
  history.replaceState(null, '', Object.keys(filtros).length ? '#' + encodeURIComponent(JSON.stringify(filtros)) : '#');
  if ($('avancado').classList.contains('aberto')) montarAvancado();
  consultar();
}

// ------------------------------------------------------------------------- gaveta "Mais filtros"

function controleFiltro([col, nome, tipo]) {
  const caixa = el('div', { className: 'filtro' }, [el('label', { textContent: nome })]);
  if (tipo === 'faixa' || tipo === 'datas') {
    const [mn, mx] = tipo === 'datas' ? opcoes.datas ?? [] : opcoes.faixa[col] ?? [];
    const entrada = (lado, chave) => el('input', {
      type: tipo === 'datas' ? 'date' : 'number', step: 'any', min: mn ?? '', max: mx ?? '',
      placeholder: `${lado} ${fmt(chave === 'min' ? mn : mx)}`, value: filtros[col]?.[chave] ?? '', 'aria-label': `${nome} ${lado}`,
      onchange: e => {
        const antes = Array.isArray(filtros[col]) ? {} : (filtros[col] ?? {});
        const f = { ...antes, [chave]: e.target.value };
        if (!f.min && !f.max) delete filtros[col]; else filtros[col] = f;
        mudou();
      },
    });
    caixa.append(el('div', { className: 'faixa' }, [entrada('mín', 'min'), 'até', entrada('máx', 'max')]));
    return caixa;
  }
  const valores = tipo === 'faixas' ? opcoes.faixas : tipo === 'tags' ? opcoes.tags : ordenar(opcoes.lista[col] ?? [], col);
  const chips = el('div', { className: 'chips' });
  const marcados = Array.isArray(filtros[col]) ? filtros[col] : [];  // nos tamanhos pode ser a faixa livre {min, max}
  for (const v of valores) {
    chips.append(el('button', { className: 'chip', type: 'button', textContent: rotulo(col, v), ariaPressed: String(marcados.includes(v)), onclick: () => {
      const atual = new Set(marcados);
      atual.has(v) ? atual.delete(v) : atual.add(v);
      if (atual.size) filtros[col] = [...atual]; else delete filtros[col];
      mudou();
    } }));
  }
  caixa.append(chips);
  if (tipo === 'faixas') caixa.append(faixaLivre(col));
  return caixa;
}

// A barrinha de tamanho: uma faixa livre "de X até Y × pote" no lugar dos chips. Até no máximo = sem teto.
const TETO_BARRA = 3;
function faixaLivre(col) {
  const v = filtros[col];
  const ativa = v && !Array.isArray(v);
  let de = ativa ? Number(v.min || 0) : 0;
  let ate = ativa && v.max !== '' && v.max !== undefined ? Number(v.max) : TETO_BARRA;
  const rotuloFaixa = el('b');
  const mostrar = () => { rotuloFaixa.textContent = `${fmt(de)} até ${ate >= TETO_BARRA ? `${fmt(TETO_BARRA)}+ (sem teto)` : fmt(ate)} × pote`; };
  const aplicar = () => { filtros[col] = { min: de, max: ate >= TETO_BARRA ? '' : ate }; mudou(); };
  const barra = (valor, lado) => el('input', { type: 'range', min: 0, max: TETO_BARRA, step: 0.01, value: valor, 'aria-label': `${DEF[col][1]}: ${lado}`,
    oninput: e => {
      const x = Number(e.target.value);
      if (lado === 'de') de = Math.min(x, ate); else ate = Math.max(x, de);
      e.target.value = lado === 'de' ? de : ate;
      caixaDe.value = de; caixaAte.value = ate >= TETO_BARRA ? '' : ate;
      mostrar();
    }, onchange: aplicar });
  const numero = (valor, lado) => el('input', { type: 'number', min: 0, max: TETO_BARRA, step: 0.01, value: valor,
    placeholder: lado === 'até' ? 'sem teto' : '0', 'aria-label': `${DEF[col][1]}: ${lado} (número)`,
    onchange: e => {
      const x = e.target.value === '' ? (lado === 'de' ? 0 : TETO_BARRA) : Math.max(0, Number(e.target.value));
      if (lado === 'de') de = Math.min(x, ate); else ate = Math.max(x, de);
      aplicar();
    } });
  const caixaDe = numero(de, 'de'), caixaAte = numero(ate >= TETO_BARRA ? '' : ate, 'até');
  mostrar();
  return el('div', { className: 'faixa-livre' + (ativa ? ' ativa' : '') }, [
    el('div', { className: 'faixa-livre-topo' }, [el('span', { textContent: ativa ? 'Faixa livre (ligada): ' : 'Ou uma faixa livre: ' }), rotuloFaixa,
      ativa ? el('button', { className: 'chip', type: 'button', textContent: 'tirar', onclick: () => { delete filtros[col]; mudou(); } }) : null]),
    el('div', { className: 'faixa-livre-barras' }, [el('span', { textContent: 'de' }), barra(de, 'de'), caixaDe]),
    el('div', { className: 'faixa-livre-barras' }, [el('span', { textContent: 'até' }), barra(ate, 'até'), caixaAte]),
  ]);
}

function montarAvancado() {
  $('avancado-corpo').replaceChildren(...CARTOES.map(([titulo, ex, fs]) => el('section', { className: 'cartao-f' }, [
    el('h3', { textContent: titulo }), ex ? el('p', { className: 'ex', textContent: ex }) : null, ...fs.map(controleFiltro)])));
}
function abrirAvancado() { montarAvancado(); $('avancado').classList.add('aberto'); $('fundo').hidden = false; }
function fecharAvancado() { $('avancado').classList.remove('aberto'); $('fundo').hidden = true; }

// ------------------------------------------------------------------------- filtros prontos, salvos, exportar

const PRESETS = {
  'Flop: tamanho da bet quando ninguém apostou': { rua: ['flop'], situacao: ['livre'], _agrupar: 'tamanho' },
  'Flop: contra bet, por tamanho enfrentado': { rua: ['flop'], situacao: ['enfrenta aposta'], _agrupar: 'tamanho_enfrentado' },
  'Flop: check-raise': { rua: ['flop'], situacao: ['enfrenta aposta'], checou_antes: [1] },
  'Turn: c-bet do agressor do flop': { rua: ['turn'], situacao: ['livre'], agressor_anterior: [1] },
  'Turn: probe depois do flop checado': { rua: ['turn'], situacao: ['livre'], rua_anterior_checada: [1] },
  'River: contra bet, por tamanho enfrentado': { rua: ['river'], situacao: ['enfrenta aposta'], _agrupar: 'tamanho_enfrentado' },
  'Linha: B50 no flop e no turn → river': { rua: ['river'], situacao: ['livre'], linha_flop: ['B'], tam_flop: ['0,46–0,66'],
    linha_turn: ['B'], tam_turn: ['0,46–0,66'] },
  'Turn: quem pagou bet pequena (até 0,15) no flop, contra bet': { rua: ['turn'], situacao: ['enfrenta aposta'],
    linha_flop: ['C', 'XC'], enf_flop: { min: 0, max: 0.15 }, _agrupar: 'tamanho_enfrentado' },
  'Por posição (todas as ruas)': { _agrupar: 'pos' },
  'Por força da mão no flop': { rua: ['flop'], _agrupar: 'forca' },
};

function montarListas() {
  const p = $('presets');
  p.replaceChildren(el('option', { value: '', textContent: 'Filtros prontos…' }),
    ...Object.keys(PRESETS).map(n => el('option', { value: n, textContent: n })));
  p.onchange = () => { if (p.value) { filtros = structuredClone(PRESETS[p.value]); p.value = ''; trocarVista('estudo'); } };
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
$('fechar-avancado').onclick = fecharAvancado;
$('fundo').onclick = fecharAvancado;
document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharAvancado(); });
$('aba-estudo').onclick = () => trocarVista('estudo');
$('aba-painel').onclick = () => trocarVista('painel');
$('aba-mda').onclick = () => trocarVista('mda');
$('aba-jogadores').onclick = () => trocarVista('jogadores');
$('aba-conferir').onclick = () => trocarVista('conferir');

// ------------------------------------------------------------------------- início

(async () => {
  opcoes = await (await fetch('/api/opcoes')).json();
  ORDEM.push(...opcoes.forcas, ...opcoes.draws, 'todos foldam', 'pago', 'aumentado');
  $('info').textContent = `${opcoes.maos.toLocaleString('pt-BR')} bomb pots`;
  desenharSelo(opcoes.saude);
  try { filtros = location.hash.length > 1 ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : {}; } catch { filtros = {}; }
  // filtro antigo de jogadores em mín/máx vira a lista que a barra de comando usa
  const j = filtros.n_jogadores;
  if (j && !Array.isArray(j) && j.min && j.max) filtros.n_jogadores = Array.from({ length: j.max - j.min + 1 }, (_, i) => Number(j.max) - i);
  delete filtros.hero;
  $('fixarA').textContent = filtroA ? 'Parar de comparar' : 'Fixar como A';
  montarListas();
  trocarVista(vista);
})();
