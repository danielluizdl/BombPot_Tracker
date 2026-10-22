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
  const ativos = Object.entries(filtros).filter(([c]) => c !== '_agrupar' && DEF[c]);
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
let vista = lerLocal('bp.vista2') === 'painel' ? 'painel' : 'estudo';
let filtroA = lerLocal('bp.filtroA');

async function consultar() {
  const meu = ++pedido;
  montarComando();
  mostrarAtivos();
  document.body.classList.add('carregando');
  if (vista === 'painel') return consultarPainel(meu);
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
  const r = await (await fetch('/api/painel', { method: 'POST', body: JSON.stringify(filtros) })).json();
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (!Array.isArray(r)) { $('painel').replaceChildren(el('p', { className: 'nota', textContent: 'Erro: ' + (r.erro ?? '') })); return; }
  const secoes = {};
  for (const s of r) (secoes[s.secao] ??= []).push(s);
  $('painel').replaceChildren(
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
  $('aba-estudo').setAttribute('aria-selected', String(v === 'estudo'));
  $('aba-painel').setAttribute('aria-selected', String(v === 'painel'));
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

// ------------------------------------------------------------------------- início

(async () => {
  opcoes = await (await fetch('/api/opcoes')).json();
  ORDEM.push(...opcoes.forcas, ...opcoes.draws, 'todos foldam', 'pago', 'aumentado');
  $('info').textContent = `${opcoes.maos.toLocaleString('pt-BR')} bomb pots`;
  try { filtros = location.hash.length > 1 ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : {}; } catch { filtros = {}; }
  // filtro antigo de jogadores em mín/máx vira a lista que a barra de comando usa
  const j = filtros.n_jogadores;
  if (j && !Array.isArray(j) && j.min && j.max) filtros.n_jogadores = Array.from({ length: j.max - j.min + 1 }, (_, i) => Number(j.max) - i);
  delete filtros.hero;
  $('fixarA').textContent = filtroA ? 'Parar de comparar' : 'Fixar como A';
  montarListas();
  trocarVista(vista);
})();
