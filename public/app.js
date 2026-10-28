// BombPot Tracker: o Estudo filtra a história da mão (POST /api/linha); MDA, Meus leaks, Jogadores e Conferir têm os seus.
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

const PALAVRA = { X: 'check', B: 'bet', C: 'call', R: 'raise', F: 'fold' };
const linhaEmPalavras = v => String(v).split('').map(l => PALAVRA[l] ?? l).join('-');
const ACOES = ['Check', 'Bet', 'Call', 'Raise', 'Fold'];
const ou = xs => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} ou ${xs[xs.length - 1]}` : xs[0]);

let opcoes = null;
let filtros = lerLocal('bp.filtros') ?? {};  // os filtros da MDA (posição e mesa) e do painel
const cod = faixa => opcoes?.codigos?.[faixa] ?? faixa;  // "0,46–0,66" -> "B50"

// As pílulas da MDA (a posição e a mesa escolhidas na barra dela).
const DEF = { pos: ['pos', 'Posição'], n_jogadores: ['n_jogadores', 'Jogadores na mesa'] };
function mostrarAtivos() {
  const ativos = Object.entries(filtros).filter(([c, v]) => DEF[c] && Array.isArray(v) && v.length);
  $('ativos').replaceChildren(...(ativos.length ? ativos.map(([col, v]) => el('span', { className: 'pilula' }, [
    `${DEF[col][1]}: ${v.join(', ')}`,
    el('button', { type: 'button', textContent: '×', title: 'Tirar este filtro', onclick: () => { delete filtros[col]; mudou(); } })]))
    : [el('span', { className: 'vazio', textContent: 'Todas as posições e mesas.' })]));
}

// ------------------------------------------------------------------------- Estudo: a linha da mão
// O filtro é a história da mão, street por street: em que street a action começou, quem fez a 1ª bet, de que tamanho,
// se alguém aumentou (e de quanto) e como a street terminou. Cada botão mostra quantas mãos têm aquela resposta com as
// outras respostas valendo (POST /api/linha); depois da 1ª street com action aparecem as seguintes.

const AGE = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN'];
const LUGARES = [[50, 94], [14, 80], [4, 46], [17, 11], [50, 4], [83, 11], [96, 46], [86, 80]];
const LETRA_ACAO = { Check: 'X', Bet: 'B', Call: 'C', Raise: 'R', Fold: 'F' };
let linhaSel = {};  // { inicio, recorte: { n_jogadores, data }, ruas: { flop: { acao, pos, mesmo, tam, aumento, raise_x, fim } } }
let linhaDados = null;
const AJUDA = {
  inicio: 'A 1ª street em que alguém apostou. Flop = a action começou no flop. Turn = todos deram check no flop e a action '
    + 'começou no turn. River = check no flop e no turn. Sem action = check até o showdown, ninguém apostou. As streets antes da '
    + 'escolhida ficam fora do filtro (foram todas em check).',
  acao: 'Nesta street alguém apostou, ou todos deram check?',
  pos: 'Posição de quem fez a 1ª bet nesta street (opcional: sem marcar nenhuma, vale qualquer posição; dá para marcar várias).',
  mesmo: 'A 1ª bet desta street foi de quem fez a última bet/raise da street anterior (c-bet, barrel) ou de outro jogador?',
  tam: 'Tamanho da 1ª bet, em fração do pote, nas mesmas faixas da MDA (as do H2N): B50 = 0,41–0,60 do pote. Marque um ou mais, ou use a faixa livre.',
  aumento: 'Depois da 1ª bet, alguém deu raise nesta street? Não = só houve call ou fold.',
  raise_x: 'Tamanho do 1º raise em vezes a 1ª bet: bet de 10 e raise para 30 = 3x.',
  reraise: 'Depois do raise, alguém aumentou de novo (re-raise / 3-bet)? Vale quem fez a 1ª bet, quem pagou no meio ou outro jogador.',
  reraise_x: 'Tamanho do re-raise em vezes o raise: raise para 30 e re-raise para 90 = 3x.',
  fim: 'Opcional. Todos foldaram = quem apostou por último levou o pote e a mão acabou. 1 call / 2+ calls = quantos pagaram a '
    + 'última bet/raise da street (a mão seguiu, ou foi ao showdown).',
};
const passoDe = rua => ((linhaSel.ruas ??= {})[rua] ??= {});

function mudarLinha(f) { f(); limparLinha(); mudou(); }
// Tira o que deixou de fazer sentido: streets antes do início, perguntas de bet numa street em check, o tamanho do
// raise quando "não aumentaram".
function limparLinha() {
  const ruas = linhaSel.ruas ?? {}, i0 = RUAS_MDA.indexOf(linhaSel.inicio);
  for (const [rua, p] of Object.entries(ruas)) {
    const i = RUAS_MDA.indexOf(rua);
    if (linhaSel.inicio === 'nenhuma' || (i0 >= 0 && i < i0)) { delete ruas[rua]; continue; }
    if (i === i0) delete p.acao;  // a 1ª street com action já teve action
    if (p.acao === 'check') for (const k of Object.keys(p)) if (k !== 'acao') delete p[k];
    // sem "levou raise" marcado, as perguntas do raise somem: nada pode ficar filtrando escondido
    if (p.aumento?.[0] !== 1) { delete p.raise_x; delete p.reraise; delete p.reraise_x; }
    if (p.reraise?.[0] !== 1) delete p.reraise_x;
    if (Array.isArray(p.tam)) p.tam = p.tam.filter(f => opcoes.faixas_h2n.includes(f));
    for (const k of Object.keys(p)) if (p[k] === undefined || (Array.isArray(p[k]) && !p[k].length)) delete p[k];
    if (!Object.keys(p).length) delete ruas[rua];
  }
  if (linhaSel.ruas && !Object.keys(linhaSel.ruas).length) delete linhaSel.ruas;
  if (linhaSel.inicio === undefined) delete linhaSel.inicio;
}
const alternar = (rua, q, v, unico) => mudarLinha(() => {
  const p = passoDe(rua), atual = Array.isArray(p[q]) ? p[q] : [];
  p[q] = unico ? (atual.length === 1 && atual[0] === v ? [] : [v]) : atual.includes(v) ? atual.filter(x => x !== v) : [...atual, v];
});

// Um botão de resposta com quantas mãos têm essa resposta (cinza e desligado quando nenhuma).
function opcao(txt, n, ativo, onclick, total) {
  return el('button', { type: 'button', ariaPressed: String(ativo), disabled: !n && !ativo, onclick,
    title: total ? `${n.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} mãos (${pct(n, total)}%)` : '' },
  [...[].concat(txt), el('small', { textContent: ` ${n.toLocaleString('pt-BR')}` })]);  // txt: texto ou [texto, elementos]
}
function pergunta(num, titulo, ajuda, botoes, extra = null) {
  return el('div', { className: 'pergunta' }, [
    el('div', { className: 'pergunta-tit' }, [num ? el('b', { textContent: num }) : null, titulo,
      el('span', { className: 'ajuda', tabIndex: 0, role: 'note', title: ajuda, ariaLabel: ajuda, textContent: '?' })]),
    el('div', { className: 'seg' }, botoes), extra]);
}
const faixaTxt = (v, unidade) => `${fmt(v.min || 0)} a ${v.max === '' || v.max == null ? 'sem teto' : fmt(v.max)} ${unidade}`;

// A barrinha: uma faixa livre "de X até Y" no lugar dos botões. Até o teto = sem teto.
function faixaLivre(v, teto, unidade, aplicar) {
  const ativa = v && !Array.isArray(v), passo = teto > 5 ? 0.1 : 0.01;
  let de = ativa ? Number(v.min || 0) : 0;
  let ate = ativa && v.max !== '' && v.max != null ? Number(v.max) : teto;
  const rot = el('b');
  const mostrar = () => { rot.textContent = `${fmt(de)} até ${ate >= teto ? `${fmt(teto)}+ (sem teto)` : fmt(ate)} ${unidade}`; };
  const enviar = () => aplicar({ min: de, max: ate >= teto ? '' : ate });
  const barra = (valor, lado) => el('input', { type: 'range', min: 0, max: teto, step: passo, value: valor, 'aria-label': `faixa livre: ${lado}`,
    oninput: e => {
      const x = Number(e.target.value);
      if (lado === 'de') de = Math.min(x, ate); else ate = Math.max(x, de);
      e.target.value = lado === 'de' ? de : ate;
      caixaDe.value = de; caixaAte.value = ate >= teto ? '' : ate;
      mostrar();
    }, onchange: enviar });
  const numero = (valor, lado) => el('input', { type: 'number', min: 0, max: teto, step: passo, value: valor,
    placeholder: lado === 'até' ? 'sem teto' : '0', 'aria-label': `faixa livre: ${lado} (número)`,
    onchange: e => {
      const x = e.target.value === '' ? (lado === 'de' ? 0 : teto) : Math.max(0, Number(e.target.value));
      if (lado === 'de') de = Math.min(x, ate); else ate = Math.max(x, de);
      enviar();
    } });
  const caixaDe = numero(de, 'de'), caixaAte = numero(ate >= teto ? '' : ate, 'até');
  mostrar();
  return el('div', { className: 'faixa-livre' + (ativa ? ' ativa' : '') }, [
    el('div', { className: 'faixa-livre-topo' }, [el('span', { textContent: ativa ? 'Faixa livre (ligada): ' : 'Ou uma faixa livre: ' }), rot,
      ativa ? el('button', { className: 'chip', type: 'button', textContent: 'tirar', onclick: () => aplicar(undefined) }) : null]),
    el('div', { className: 'faixa-livre-barras' }, [el('span', { textContent: 'de' }), barra(de, 'de'), caixaDe]),
    el('div', { className: 'faixa-livre-barras' }, [el('span', { textContent: 'até' }), barra(ate, 'até'), caixaAte]),
  ]);
}

function cartaoInicio() {
  const c = linhaDados.inicio, total = Object.values(c).reduce((a, b) => a + b, 0), rec = linhaSel.recorte ?? {};
  const mesa = [8, 7, 6, 5, 4, 3, 2].map(k => el('button', { type: 'button', textContent: String(k), ariaPressed: String(!!rec.n_jogadores?.includes(k)),
    title: `mesas com ${k} jogadores`, onclick: () => mudarLinha(() => {
      const r = (linhaSel.recorte ??= {}), s = new Set(r.n_jogadores ?? []);
      s.has(k) ? s.delete(k) : s.add(k);
      if (s.size) r.n_jogadores = [...s].sort((a, b) => b - a); else delete r.n_jogadores;
      if (!Object.keys(r).length) delete linhaSel.recorte;
    }) }));
  const data = (lado, rot) => el('input', { type: 'date', value: rec.data?.[lado] ?? '', 'aria-label': rot,
    min: opcoes.datas?.[0] ?? '', max: opcoes.datas?.[1] ?? '', onchange: e => mudarLinha(() => {
      const r = (linhaSel.recorte ??= {});
      r.data = { ...(r.data ?? {}), [lado]: e.target.value };
      if (!r.data.min && !r.data.max) delete r.data;
      if (!Object.keys(r).length) delete linhaSel.recorte;
    }) });
  return el('section', { className: 'card perguntas' }, [
    pergunta('1', 'Primeira street com action', AJUDA.inicio,
      [['flop', 'Flop'], ['turn', 'Turn'], ['river', 'River'], ['nenhuma', 'Sem action']].map(([v, t]) => opcao(t, c[v] ?? 0, linhaSel.inicio === v,
        () => mudarLinha(() => { linhaSel.inicio = linhaSel.inicio === v ? undefined : v; }), total))),
    el('div', { className: 'recorte' }, [
      el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Jogadores na mesa (opcional)' }), el('div', { className: 'seg' }, mesa)]),
      el('div', { className: 'grupo-cmd cmd-datas' }, [el('span', { textContent: 'Período (opcional)' }),
        el('div', { className: 'faixa' }, [data('min', 'Data inicial'), data('max', 'Data final')])]),
      el('button', { className: 'btn', type: 'button', textContent: 'Limpar tudo', onclick: () => { linhaSel = {}; mudou(); } })])]);
}

function cartaoRua(rua) {
  const d = linhaDados.ruas[rua], c = d.contagens, p = linhaSel.ruas?.[rua] ?? {};
  const chegaram = (c.acao.sim ?? 0) + (c.acao.check ?? 0), inicio = linhaSel.inicio === rua;
  const lista = (q, valores, unico, rot = v => v) => {
    const total = Object.values(c[q]).reduce((a, b) => a + b, 0);
    return valores.map(v => opcao(rot(v), c[q][String(v)] ?? 0, Array.isArray(p[q]) && p[q].includes(v), () => alternar(rua, q, v, unico), total));
  };
  const blocos = [];
  if (!inicio) {
    blocos.push(pergunta('', 'Teve action nesta street?', AJUDA.acao, [['sim', 'Sim, alguém apostou'], ['check', 'Não, todos deram check']].map(([v, t]) =>
      opcao(t, c.acao[v] ?? 0, p.acao === v, () => mudarLinha(() => { passoDe(rua).acao = p.acao === v ? undefined : v; }), chegaram))));
  }
  if (p.acao !== 'check') {
    const marcado = (q, v) => Array.isArray(p[q]) && p[q].includes(v);
    blocos.push(pergunta('2', 'Quem fez a 1ª bet?', AJUDA.pos, lista('pos', AGE.filter(x => c.pos[x] || marcado('pos', x)), false)));
    if (rua !== 'flop' && Object.keys(c.mesmo).length) {
      blocos.push(pergunta('', 'A 1ª bet foi do agressor da street anterior?', AJUDA.mesmo,
        lista('mesmo', [1, 0], true, v => (v ? 'Sim, o mesmo jogador' : 'Não, outro jogador'))));
    }
    blocos.push(pergunta('3', 'Tamanho da 1ª bet', AJUDA.tam, lista('tam', opcoes.faixas_h2n.filter(f => c.tam[f] || marcado('tam', f)), false,
      f => [`${cod(f)} `, el('span', { className: 'intervalo', textContent: f })]),
      faixaLivre(p.tam, 3, '× pote', v => mudarLinha(() => { passoDe(rua).tam = v; }))));
    blocos.push(quadroResposta(d));  // o overfold contra a 1ª bet, logo abaixo do tamanho dela
    blocos.push(pergunta('4', 'Alguém aumentou depois da 1ª bet?', AJUDA.aumento,
      lista('aumento', [1, 0], true, v => (v ? 'Sim, levou raise' : 'Não, só call ou fold'))));
    if (p.aumento?.[0] === 1) {
      blocos.push(pergunta('', 'Tamanho do raise (vezes a 1ª bet)', AJUDA.raise_x,
        lista('raise_x', linhaDados.faixas_x.filter(f => c.raise_x[f] || marcado('raise_x', f)), false),
        faixaLivre(p.raise_x, 20, '× a 1ª bet', v => mudarLinha(() => { passoDe(rua).raise_x = v; }))));
      // o overfold contra o raise: todos os tamanhos de raise, ou só os escolhidos
      blocos.push(tabelaResposta(d.resposta_raise, RESPOSTA_RAISE));
      // a continuação: alguém aumentou depois do raise?
      blocos.push(pergunta('', 'Alguém aumentou depois do raise? (re-raise)', AJUDA.reraise,
        lista('reraise', [1, 0], true, v => (v ? 'Sim, levou re-raise' : 'Não, só call ou fold'))));
      if (p.reraise?.[0] === 1) {
        blocos.push(pergunta('', 'Tamanho do re-raise (vezes o raise)', AJUDA.reraise_x,
          lista('reraise_x', linhaDados.faixas_x2.filter(f => c.reraise_x[f] || marcado('reraise_x', f)), false),
          faixaLivre(p.reraise_x, 10, '× o raise', v => mudarLinha(() => { passoDe(rua).reraise_x = v; }))));
        blocos.push(tabelaResposta(d.resposta_reraise, RESPOSTA_RERAISE));
      }
    }
    blocos.push(pergunta('5', 'Como a street terminou?', AJUDA.fim,
      lista('fim', ['levou', '1', '2+'], false, v => ({ levou: 'Todos foldaram (a mão acabou)', 1: '1 call', '2+': '2+ calls' })[v])));
  }
  return el('section', { className: 'card perguntas' }, [
    el('h2', {}, [NOME_RUA[rua], el('small', { textContent: `${chegaram.toLocaleString('pt-BR')} mãos chegaram ao ${rua} com o resto da linha` })]),
    ...blocos]);
}

// O que a mesa fez depois da 1ª bet (ou do 1º raise), com a linha até esta street valendo: todos foldaram, 1 call,
// 2+ calls, mais uma agressão, o fold que um blefe precisa (risco ÷ (1 + risco)) e o EV do blefe em % do pote.
// A 1ª bet pode ser vista por tamanho, por posição de quem apostou ou na grade posição × tamanho; toda tabela tem o Total.
const RESPOSTA_BET = { titulo: 'O que a mesa fez depois da 1ª bet', faixas: () => opcoes.faixas_h2n, cab: 'Tamanho',
  rot: f => [el('b', { textContent: cod(f) }), el('small', { textContent: f })], mais: 'Raise',
  nota: 'Por tamanho mostra todos os tamanhos (a posição escolhida vale).' };
const RESPOSTA_POS = { ...RESPOSTA_BET, faixas: () => AGE, cab: 'Quem apostou', rot: f => [el('b', { textContent: f })],
  nota: 'Por posição mostra todas as posições de quem fez a 1ª bet (o tamanho escolhido vale).' };
const RESPOSTA_RAISE = { titulo: 'O que a mesa fez depois do raise, por tamanho do raise (vezes a 1ª bet)', faixas: () => linhaDados.faixas_x,
  cab: 'Tamanho', rot: f => [el('b', { textContent: f })], mais: 'Re-raise',
  nota: 'Todos foldaram = todos, inclusive quem fez a 1ª bet, largaram para quem deu o raise. Precisa foldar e EV usam o que o '
    + 'raise arrisca: tudo o que ele põe na hora (o call embutido + o aumento) ÷ o pote antes dele. Ex.: bet 10 num pote de 100, '
    + 'raise para 30 = arrisca 30 para ganhar 110, precisa de 21% de fold.' };
const RESPOSTA_RERAISE = { titulo: 'O que a mesa fez depois do re-raise, por tamanho do re-raise (vezes o raise)',
  faixas: () => linhaDados.faixas_x2, cab: 'Tamanho', rot: f => [el('b', { textContent: f })], mais: '4-bet',
  nota: 'Todos foldaram = todos largaram para quem deu o re-raise. Precisa foldar e EV usam o que o re-raise arrisca (tudo o '
    + 'que ele põe na hora ÷ o pote antes dele).' };
const CAMPOS_RESP = ['n', 'todos foldam', '1 call', '2+ calls', 'aumentado', 'ev', 'tam'];
const somaResp = ds => Object.fromEntries(CAMPOS_RESP.map(k => [k, ds.reduce((a, d) => a + (d[k] ?? 0), 0)]));
const contaResp = d => {  // fold, precisa e EV em %, e se a amostra é pequena
  const medio = d.tam / d.n;
  return { fold: pct(d['todos foldam'], d.n), precisa: 100 * medio / (1 + medio), ev: 100 * d.ev / d.n, fraca: d.n < AMOSTRA_MINIMA };
};
const corEv = ev => (ev > 2 ? 'bom' : ev < -2 ? 'ruim' : 'neutro');
const txtEv = ev => `${ev >= 0 ? '+' : ''}${fmt(ev, 0)}%`;
let vistaResposta = lerLocal('bp.vistaResposta') ?? 'tam';

function linhaResposta(d, rotulo, classe = '') {
  const { fold, precisa, ev, fraca } = contaResp(d), f = fraca ? ' fraca' : '';
  const num = (n, cls = '') => el('td', { className: 'num' + f, title: tituloIC(n, d.n) }, [el('b', { className: cls, textContent: `${pct(n, d.n)}%` })]);
  return el('tr', { className: classe }, [
    el('th', {}, [el('span', { className: 'tam' }, rotulo)]),
    el('td', { className: 'num' + f, textContent: String(d.n) }),
    num(d['todos foldam'], fold >= precisa ? 'bom' : 'ruim'), num(d['1 call']), num(d['2+ calls']), num(d.aumentado),
    el('td', { className: 'num' + f, textContent: `${Math.round(precisa)}%` }),
    el('td', { className: 'num' + f }, [el('b', { className: corEv(ev), textContent: txtEv(ev) })])]);
}

function caixaResposta(titulo, controles, conteudo, nota) {
  return el('details', { className: 'explica resposta-linha', open: true }, [
    el('summary', { textContent: titulo }), controles, conteudo,
    el('p', { className: 'nota', style: 'padding:4px 0 0', textContent: `${nota ? nota + ' ' : ''}Números em cinza: menos de 30 mãos.` })]);
}

function tabelaResposta(resp, tipo, controles = null) {
  const chaves = tipo.faixas().filter(f => resp[f]);
  if (!chaves.length) return null;
  const linhas = [linhaResposta(somaResp(chaves.map(f => resp[f])), [el('b', { textContent: 'Total' })], 'geral'),
    ...chaves.map(f => linhaResposta(resp[f], tipo.rot(f)))];
  return caixaResposta(tipo.titulo, controles, el('div', { className: 'rolar' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, [[tipo.cab], ['Mãos'], ['Todos foldaram', 'Verde quando passa do "precisa foldar": o blefe deu lucro.'],
      ['1 call', 'Um jogador pagou e ninguém aumentou.'], ['2+ calls', 'Dois ou mais pagaram e ninguém aumentou.'], [tipo.mais],
      ['Precisa foldar', 'Fold que um blefe precisa para empatar: risco ÷ (1 + risco).'],
      ['EV blefe', 'Em % do pote: +1 pote se todos foldaram, −o que arriscou se não.']]
      .map(([t, dd]) => el('th', dd ? { textContent: t, title: dd } : { textContent: t })))]),
    el('tbody', {}, linhas)])]), tipo.nota);
}

// A grade posição × tamanho: em cada casa o fold de todos (verde quando passa do que o blefe precisa) e, embaixo, quantas
// mãos e o EV. A última coluna e a última linha são os totais da posição e do tamanho.
function gradeResposta(resp, controles) {
  const casa = (pos, f) => resp[`${pos}|${f}`];
  const pos = AGE.filter(p => opcoes.faixas_h2n.some(f => casa(p, f))), faixas = opcoes.faixas_h2n.filter(f => pos.some(p => casa(p, f)));
  if (!pos.length) return null;
  const cel = d => {
    if (!d) return el('td', { className: 'num fraca', textContent: '—' });
    const { fold, precisa, ev, fraca } = contaResp(d);
    return el('td', { className: 'num casa' + (fraca ? ' fraca' : ''),
      title: `${d.n} mãos · todos foldaram ${fold}% (precisa ${Math.round(precisa)}%) · EV do blefe ${txtEv(ev)}` }, [
      el('b', { className: fold >= precisa ? 'bom' : 'ruim', textContent: `${fold}%` }),
      el('small', { textContent: `${d.n} · ${txtEv(ev)}` })]);
  };
  const linha = (rot, ds, cls = '') => el('tr', { className: cls }, [el('th', {}, [rot]), ...ds.map(cel)]);
  const total = ds => (ds.some(Boolean) ? somaResp(ds.filter(Boolean)) : null);
  return caixaResposta('O que a mesa fez depois da 1ª bet', controles, el('div', { className: 'rolar' }, [el('table', { className: 'grade-resp' }, [
    el('thead', {}, [el('tr', {}, [el('th', { textContent: 'Quem apostou ↓ · tamanho →' }),
      ...faixas.map(f => el('th', {}, [cod(f), el('small', { className: 'intervalo-th', textContent: f })])), el('th', { textContent: 'Total' })])]),
    el('tbody', {}, [
      ...pos.map(p => linha(p, [...faixas.map(f => casa(p, f)), total(faixas.map(f => casa(p, f)))])),
      linha('Total', [...faixas.map(f => total(pos.map(p => casa(p, f)))), total(pos.flatMap(p => faixas.map(f => casa(p, f))))], 'geral')])])]),
    'Em cada casa: todos foldaram (verde quando passa do que o blefe precisa), mãos e EV do blefe. Passe a seta para ver o "precisa".');
}

function quadroResposta(d) {
  const controles = el('div', { className: 'seg vistas-resp' }, [['tam', 'Por tamanho'], ['pos', 'Por posição'], ['pos_tam', 'Posição × tamanho']]
    .map(([v, t]) => el('button', { type: 'button', textContent: t, ariaPressed: String(vistaResposta === v),
      onclick: () => { vistaResposta = v; gravarLocal('bp.vistaResposta', v); desenharLinha(); } })));
  if (vistaResposta === 'pos_tam') return gradeResposta(d.resposta_pos_tam, controles);
  return vistaResposta === 'pos' ? tabelaResposta(d.resposta_pos, RESPOSTA_POS, controles) : tabelaResposta(d.resposta, RESPOSTA_BET, controles);
}

function fraseLinha() {
  const L = linhaSel, partes = [];
  if (L.inicio === 'nenhuma') partes.push('ninguém apostou, check até o showdown');
  else if (L.inicio === 'flop') partes.push('a action começou no flop');
  else if (L.inicio) partes.push(`todos deram check até o ${L.inicio}, onde a action começou`);
  for (const rua of RUAS_MDA) {
    const p = L.ruas?.[rua];
    if (!p) continue;
    if (p.acao === 'check') { partes.push(`no ${rua}, todos deram check`); continue; }
    const t = [p.pos?.length ? `${ou(p.pos)} fez a 1ª bet` : 'alguém fez a 1ª bet'];
    if (p.mesmo?.length) t.push(p.mesmo[0] ? '(o agressor da street anterior)' : '(outro que não o agressor anterior)');
    if (Array.isArray(p.tam) && p.tam.length) t.push(`de ${ou(p.tam.map(f => `${cod(f)} (${f})`))}`); else if (p.tam) t.push(`de ${faixaTxt(p.tam, '× pote')}`);
    if (p.aumento?.length) {
      t.push(p.aumento[0] ? 'e levou raise' : 'sem raise');
      if (p.raise_x) t.push(Array.isArray(p.raise_x) ? `de ${ou(p.raise_x)}` : `de ${faixaTxt(p.raise_x, '× a bet')}`);
      if (p.reraise?.length) t.push(p.reraise[0] ? 'e re-raise' : 'sem re-raise');
      if (p.reraise_x) t.push(Array.isArray(p.reraise_x) ? `de ${ou(p.reraise_x)}` : `de ${faixaTxt(p.reraise_x, '× o raise')}`);
    }
    if (p.fim?.length) t.push(`— ${ou(p.fim.map(v => ({ levou: 'todos foldaram', 1: '1 call', '2+': '2+ calls' })[v]))}`);
    partes.push(`no ${rua}, ${t.join(' ')}`);
  }
  const rec = L.recorte ?? {};
  if (rec.n_jogadores?.length) partes.push(`mesas de ${ou(rec.n_jogadores.map(String))} jogadores`);
  if (rec.data?.min || rec.data?.max) partes.push(rec.data.min && rec.data.max ? `de ${rec.data.min} a ${rec.data.max}` : rec.data.min ? `a partir de ${rec.data.min}` : `até ${rec.data.max}`);
  return partes.length ? `Mãos em que ${partes.join(' · ')}:` : 'Todas as mãos. Comece pela pergunta 1:';
}

function desenharLinha() {
  const i0 = RUAS_MDA.indexOf(linhaSel.inicio);
  const ruas = linhaSel.inicio === 'nenhuma' ? [] : RUAS_MDA.filter((r, i) => i >= Math.max(i0, 0)
    && ((linhaDados.ruas[r].contagens.acao.sim ?? 0) + (linhaDados.ruas[r].contagens.acao.check ?? 0) > 0 || linhaSel.ruas?.[r]));
  $('estudo').replaceChildren(
    el('p', { className: 'frase-linha' }, [fraseLinha(), el('b', { textContent: ` ${linhaDados.total.toLocaleString('pt-BR')} mãos` })]),
    cartaoInicio(),
    ...ruas.map(cartaoRua),
    el('section', { className: 'card' }, [el('h2', {}, ['Mãos desta linha',
      el('small', { textContent: 'uma por mão, a partir da 1ª bet da última street escolhida; ▶ reproduz a mesa' })]),
    el('div', { style: 'padding:12px 16px' }, [painelMaos({ linha: linhaSel }, `Ver mãos (${linhaDados.total.toLocaleString('pt-BR')})`)])]));
}

// ------------------------------------------------------------------------- MDA (árvore de ações, estilo H2N)
// Colunas FLOP / TURN / RIVER com os nós da árvore; clicar numa ação abre os bet sizes; "afunilar" leva a linha
// escolhida para a rua seguinte. Posição e mesa vêm da barra da própria MDA.

const RUAS_MDA = ['flop', 'turn', 'river'];
const NOME_RUA = { flop: 'Flop', turn: 'Turn', river: 'River' };
const MINIMO_NO = 10;  // nós com menos decisões ficam recolhidos em "mais linhas"
const FAIXAS_MDA = () => [...opcoes.faixas_h2n].reverse();  // as faixas do H2N, da maior para a menor
let caminho = lerLocal('bp.caminho') ?? {};
let mdaSel = null;  // { rua, chave, acao }
let mdaDados = null;
const ruasAbertas = new Set(['flop']);  // o flop começa aberto; turn e river, minimizados
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
// o tamanho de um passo do caminho: uma faixa ou várias (o conjunto delas); o caminho salvo antigo tinha uma só
const faixasDe = passo => (Array.isArray(passo?.faixa) ? passo.faixa : passo?.faixa ? [passo.faixa] : []);
// marca/desmarca um tamanho da rua anterior (null = todos os tamanhos)
function alternarFaixaAnterior(rua, linha, faixa, lado) {
  const atual = caminho[rua]?.linha === linha ? faixasDe(caminho[rua]) : [];
  const nova = faixa === null ? [] : atual.includes(faixa) ? atual.filter(f => f !== faixa) : [...atual, faixa];
  const c = { ...caminho };
  if (nova.length) c[rua] = { linha, faixa: nova, lado }; else delete c[rua];
  caminho = c;
  salvarCaminho();
  consultar();
}
// volta ao começo: sem caminho, sem busca, sem linha aberta, com o flop aberto
function voltarAoFlop() {
  caminho = {};
  salvarCaminho();
  buscaLinha = '';
  mdaSel = null;
  ruasAbertas.add('flop');
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
  caminho = { ...caminho, [rua]: { linha, faixa: faixa ? [faixa] : null, lado } };
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
    `${NOME_RUA[rua]}: ${letrasEmPalavras(v.linha)}${faixasDe(v).length ? ` ${v.lado === 'pagou' ? 'pagando' : ''} ${faixasDe(v).map(f => `${cod(f)} (${f})`).join(' + ')}` : ''}`,
    el('button', { type: 'button', textContent: '×', title: 'Tirar este passo', onclick: () => tirarCaminho(rua) })]));
  return el('div', { className: 'mda-barra' }, [
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Posição' }), segPos]),
    el('div', { className: 'grupo-cmd' }, [el('span', { textContent: 'Jogadores na mesa (marque vários)' }), segJog]),
    caixaBusca(),
    el('div', { className: 'grupo-cmd caminho' }, [el('span', { textContent: 'Caminho (afunilar)' }),
      el('div', { className: 'chips' }, passos.length ? passos : [el('span', { className: 'vazio', textContent: 'clique numa ação e em "afunilar" para seguir a linha na rua seguinte' })])]),
    el('div', { className: 'fim' }, [
      Object.keys(caminho).length || normLinha(buscaLinha) || mdaSel ? el('button', { className: 'btn', type: 'button', textContent: '↺ voltar ao flop',
        title: 'Tira o caminho afunilado, a busca e a linha aberta', onclick: voltarAoFlop }) : null,
      el('button', { className: 'btn' + (separarAI ? ' primario' : ''), type: 'button', ariaPressed: String(separarAI),
        textContent: `All-in separado: ${separarAI ? 'sim' : 'não'}`,
        title: separarAI ? 'Ligado: as bets all-in aparecem nas linhas -AI e saem da conta do tamanho delas. Clique para juntar.'
          : 'Desligado: cada bet all-in soma na faixa do tamanho dela (a amostra de all-in costuma ser pequena). Clique para mostrar à parte.',
        onclick: () => { separarAI = !separarAI; desenharMda(); } })]),
  ]);
}

// Cada rua é um box com uma lista de linhas, como no perfil do H2N: "X - B  25%  (276)" = depois do flop em check,
// quantas vezes ele foi o primeiro a apostar no turn. Só o flop começa aberto; clicar numa linha abre os bet
// sizes dela no painel preso no pé da tela.
function colunaMda(rua, nos) {
  const todas = nos.flatMap(no => ACOES.filter(a => no.acoes[a]).map(a => ({ no, a })));
  const linhas = todas.filter(({ no, a }) => casaBusca(rotuloLinha(no, a)));
  const buscando = !!normLinha(buscaLinha);
  const linha = ({ no, a }) => {
    const n = no.acoes[a], ativa = mdaSel && mdaSel.rua === rua && mdaSel.chave === no.chave && mdaSel.acao === a;
    return el('button', { type: 'button', className: 'mda-linha' + (ativa ? ' aberta' : ''), ariaPressed: String(!!ativa),
      title: `${descreverNo(no)} · ${a}: ${tituloIC(n, no.n)} · clique para ${ativa ? 'fechar' : 'ver os tamanhos (abre no pé da tela)'}`,
      onclick: () => { if (ativa) { mdaSel = null; desenharMda(); } else escolherLinha({ rua, no, a }); } }, [
      el('span', { className: 'rot', textContent: rotuloLinha(no, a) }),
      // situação com menos de 30 decisões: o % sai do negrito (100% de 1 mão não é destaque)
      no.n < AMOSTRA_MINIMA ? el('span', { className: 'fraca', textContent: `${pct(n, no.n)}%` }) : el('b', { textContent: `${pct(n, no.n)}%` }),
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
    const linhaBet = (k, d) => {  // k = "faixa" ou "faixa|AI"; null = o Total (todas as faixas)
      const [faixa, ai] = (k ?? '').split('|');
      const cel = n => el('td', { className: 'num' + (d.n < AMOSTRA_MINIMA ? ' fraca' : ''), title: tituloIC(n, d.n) }, [
        el('b', { textContent: `${pct(n, d.n)}%` }), el('small', { textContent: ` ${n}` })]);
      const dep = d.depois, totalDep = dep.Fold + dep.Call + dep.Raise;
      // como na Resposta ao sizing do Estudo: só as bets que a mesa respondeu, pela bet média da faixa
      const medio = d.respondidas ? d.tam / d.respondidas : 0, precisa = 100 * medio / (1 + medio);
      const ev = d.respondidas ? 100 * d.ev / d.respondidas : 0, fold = pct(d['todos foldam'], d.respondidas);
      const fraca = d.respondidas < AMOSTRA_MINIMA ? ' fraca' : '';
      corpo.append(el('tr', { className: k ? '' : 'geral' }, [
        el('th', {}, [el('span', { className: 'tam' }, k ? [el('b', { textContent: cod(faixa) + (ai ? '-AI' : '') }), el('small', { textContent: faixa + (ai ? ' · all-in' : '') })]
          : [el('b', { textContent: 'Total' }), el('small', { textContent: 'todos os tamanhos' })])]),
        el('td', { className: 'num', title: `${d.n} de ${no.n} decisões desta situação` }, [el('b', { textContent: `${fmt(100 * d.n / no.n, 1)}%` }), el('small', { textContent: ` ${d.n}` })]),
        el('td', { className: 'num' + fraca, title: tituloIC(d['todos foldam'], d.respondidas) }, [
          el('b', { className: d.respondidas ? (fold >= precisa ? 'bom' : 'ruim') : '', textContent: d.respondidas ? `${fold}%` : '—' }), el('small', { textContent: ` ${d['todos foldam']}` })]),
        el('td', { className: 'num' + fraca, title: `bet média ${fmt(medio)} do pote: ${fmt(medio)} ÷ (1 + ${fmt(medio)})` }, [
          el('b', { textContent: d.respondidas ? `${Math.round(precisa)}%` : '—' })]),
        el('td', { className: 'num' + fraca, title: d.respondidas ? `${d.respondidas} bets com resposta` : '' }, [
          el('b', { className: ev > 2 ? 'bom' : ev < -2 ? 'ruim' : 'neutro', textContent: d.respondidas ? `${ev >= 0 ? '+' : ''}${fmt(ev, 0)}` : '—' })]),
        cel(d['1 call']), cel(d['2 calls']), cel(d['3+ calls']), cel(d.aumentado),
        el('td', { className: 'num', title: 'Quando levou raise, o que o apostador fez depois' }, [totalDep
          ? `F ${pct(dep.Fold, totalDep)}% · C ${pct(dep.Call, totalDep)}% · R ${pct(dep.Raise, totalDep)}%` : '—']),
        // faixa feita só de bets all-in (somadas pelo "all-in junto"): ninguém aposta no turn depois, afunilar daria vazio
      el('td', {}, [ai || (k && !separarAI && !(no.tamanhos[acao] ?? {})[faixa]) ? el('span') : botaoAfunilar(k ? faixa : null, 'aposta'),
        el('button', { className: 'ver', type: 'button', textContent: 'mãos', title: k ? `As mãos com ${cod(faixa)}${ai ? ' all-in' : ''}` : 'Todas as mãos desta linha',
          onclick: () => verMaosMda(k) })]),
      ]));
    };
    const tams = tamanhosDaLinha(no.tamanhos[acao] ?? {});
    if (tams.length > 1) {  // o conjunto de todas as bets desta linha
      const t = { depois: { Fold: 0, Call: 0, Raise: 0 } };
      for (const [, d] of tams) {
        for (const c of ['n', 'todos foldam', '1 call', '2 calls', '3+ calls', 'aumentado', 'respondidas', 'ev', 'tam']) t[c] = (t[c] ?? 0) + (d[c] ?? 0);
        for (const a of ['Fold', 'Call', 'Raise']) t.depois[a] += d.depois[a];
      }
      linhaBet(null, t);
    }
    for (const [k, d] of tams) linhaBet(k, d);
    cab = ['Tamanho', 'Freq.', 'Todos foldam', 'Precisa foldar', 'EV blefe', '1 call', '2 calls', '3+ calls', 'Aumentado', 'Depois do raise (o apostador)', ''];
    nota = 'Freq. = quantas vezes o jogador fez esta bet com este tamanho, entre todas as decisões desta situação (como a coluna "Fre" do H2N). '
      + (separarAI ? '"-AI" = all-in, fora da conta do tamanho. ' : 'As bets all-in estão somadas na faixa do tamanho delas (botão "All-in separado" para ver à parte). ')
      + 'Todos foldam fica verde quando passa do "precisa foldar" (bet ÷ (1 + bet)); EV blefe, em % do pote: +1 pote se todos foldam, −a bet se não. '
      + 'Afunilar segue para a rua seguinte só quem fez essa bet e não levou raise.';
  } else {
    const enf = no.enfrentado ?? {};
    const faixasEnf = FAIXAS_MDA().filter(f => enf[f]);
    const linhaEnf = f => {  // f = a faixa enfrentada; null = o Total
      const d = f ? enf[f] : faixasEnf.reduce((t, x) => {
        for (const [c, v] of Object.entries(enf[x])) t[c] = (t[c] ?? 0) + v;
        return t;
      }, {});
      const n = (d.Fold ?? 0) + (d.Call ?? 0) + (d.Raise ?? 0) + (d.Check ?? 0) + (d.Bet ?? 0);
      const cel = (x, cls = '') => el('td', { className: 'num' + (n < AMOSTRA_MINIMA ? ' fraca' : ''), title: tituloIC(x ?? 0, n) }, [
        el('b', { className: cls, textContent: `${pct(x ?? 0, n)}%` }), el('small', { textContent: ` ${x ?? 0}` })]);
      corpo.append(el('tr', { className: f ? '' : 'geral' }, [
        el('th', {}, [el('span', { className: 'tam' }, f ? [el('b', { textContent: cod(f) }), el('small', { textContent: f })]
          : [el('b', { textContent: 'Total' }), el('small', { textContent: 'todos os tamanhos' })])]),
        el('td', { className: 'num' }, [el('b', { textContent: String(n) })]),
        cel(d.Fold, acao === 'Fold' ? 'destaque' : ''), cel(d.Call, acao === 'Call' ? 'destaque' : ''), cel(d.Raise, acao === 'Raise' ? 'destaque' : ''),
        el('td', { className: 'num', title: 'média, mão a mão, de bet ÷ (1 + bet)' }, [`${pct(d.precisa, n)}%`]),
        el('td', {}, [acao === 'Call' && d.Call ? botaoAfunilar(f, 'pagou') : el('span'),
          el('button', { className: 'ver', type: 'button', textContent: 'mãos', title: f ? `As mãos contra ${cod(f)}` : 'Todas as mãos desta linha', onclick: () => verMaosMda(f) })]),
      ]));
    };
    if (faixasEnf.length > 1) linhaEnf(null);
    faixasEnf.forEach(linhaEnf);
    cab = ['Bet enfrentada', 'Decisões', 'Fold', 'Call', 'Raise', 'Precisa foldar', ''];
    nota = 'O que o jogador fez contra cada tamanho de bet, nesta situação. "Precisa foldar" é o fold em que um blefe empata. '
      + 'Afunilar (no call) segue para a rua seguinte só quem pagou aquele tamanho.';
  }
  // B - B no turn: qual foi a bet do flop? O tamanho vira filtro da linha (o mesmo "afunilar", sem sair da linha).
  const seletores = no.prefixo.map((lin, i) => {
    const r = RUAS_MDA[i], ult = lin.slice(-1);
    const lado = ult === 'C' ? 'pagou' : ult === 'B' || ult === 'R' ? 'aposta' : null;
    if (!lado) return null;
    const atual = caminho[r]?.linha === lin ? faixasDe(caminho[r]) : [];
    return el('div', { className: 'mda-sel' + (atual.length ? ' ativo' : ''),
      title: `Só as mãos em que ${lado === 'pagou' ? 'a bet que o jogador pagou' : 'a bet que o jogador fez'} no ${NOME_RUA[r].toLowerCase()} foi de um destes tamanhos (marque vários para ver o conjunto)` }, [
      el('span', { textContent: `${lado === 'pagou' ? 'bet que pagou' : 'bet que fez'} no ${NOME_RUA[r].toLowerCase()} (${lin}):` }),
      el('div', { className: 'chips' }, [
        el('button', { className: 'chip', type: 'button', textContent: 'todos', ariaPressed: String(!atual.length), onclick: () => alternarFaixaAnterior(r, lin, null, lado) }),
        ...opcoes.faixas_h2n.map(f => el('button', { className: 'chip', type: 'button', ariaPressed: String(atual.includes(f)),
          onclick: () => alternarFaixaAnterior(r, lin, f, lado) }, [`${cod(f)} `, el('small', { textContent: f })]))])]);
  }).filter(Boolean);
  return el('section', { className: 'card mda-detalhe' }, [
    seletores.length ? el('div', { className: 'mda-seletores' }, seletores) : null,
    el('div', { className: 'mda-detalhe-cab' }, [
      el('h3', {}, [`${NOME_RUA[rua]} · ${rotuloLinha(no, acao)}`, el('small', { textContent: ` ${descreverNo(no)} · ${pct(no.acoes[acao], no.n)}% (${no.acoes[acao]} de ${no.n})` })]),
      el('div', {}, [el('button', { className: 'ver', type: 'button', textContent: 'ver mãos', title: 'As mãos desta linha (todos os tamanhos)',
        onclick: () => verMaosMda(null) }), botaoAfunilar(null, 'aposta'),
        el('button', { className: 'ver', type: 'button', textContent: 'fechar', onclick: () => { mdaSel = null; desenharMda(); } })])]),
    corpo.children.length ? el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, cab.map(c => el('th', { textContent: c })))]), corpo])]) : el('p', { className: 'nota', textContent: 'Sem tamanhos para mostrar.' }),
    el('p', { className: 'nota', textContent: nota }),
    el('div', { id: 'mda-maos', className: 'mda-maos' })]);
}

// As mãos da linha aberta embaixo dos boxes (todos os tamanhos, ou só uma faixa da tabela), com o replayer.
function verMaosMda(faixa) {
  const no = mdaDados?.[mdaSel?.rua]?.find(n => n.chave === mdaSel.chave);
  const alvo = $('mda-maos');
  if (!no || !alvo) return;
  const [nome, ai] = String(faixa ?? '').split('|');
  alvo.replaceChildren(
    el('h4', { textContent: `Mãos · ${NOME_RUA[mdaSel.rua]} · ${rotuloLinha(no, mdaSel.acao)}${faixa ? ` · ${cod(nome)}${ai ? ' all-in' : ''}` : ''}` }),
    painelMaos({ filtros, mda: { rua: mdaSel.rua, prefixo: no.prefixo, atual: no.atual, situ: no.situ, acao: mdaSel.acao,
      caminho, faixa, separar_ai: separarAI } }, '', true));
  alvo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function desenharMda(rolar = false) {
  if (!mdaDados) return;
  const detalhe = detalheMda();
  $('mda').replaceChildren(barraMda(), legendaMda(), el('div', { className: 'mda-grade' }, RUAS_MDA.map(r => colunaMda(r, mdaDados[r]))), ...(detalhe ? [detalhe] : []));
  // o detalhe fica preso na parte de baixo da tela (sticky): aparece na hora do clique, sem rolar a página
  if (detalhe && rolar) detalhe.scrollTop = 0;
}

function legendaMda() {
  return el('p', { className: 'nota mda-legenda' }, [
    ...Object.entries(LETRA_ACAO).map(([a, l]) => el('span', {}, [el('b', { textContent: l }), ` ${a.toLowerCase()}`])),
    el('span', {}, [el('b', { textContent: '-AI' }), ' all-in']),
    el('span', {}, [el('b', { textContent: ' - ' }), ' separa as ruas (X - B = checou no flop, apostou no turn)']),
    el('span', { textContent: '% cinza = situação com menos de 30 decisões' })]);
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
let listaJogadores = null, jogadorSel = lerLocal('bp.jogador'), buscaJogador = '', serieAtual = null, mostrarPoucos = false;
let filtrosJog = lerLocal('bp.filtrosJog') ?? {};  // { n_jogadores: [8, 7], data: { min, max } }
const bb = (v, casas = 1) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${fmt(Math.abs(v), casas)} BB`;
const por100 = (v, maos) => (maos ? 100 * v / maos : 0);
const corValor = v => (v > 0 ? 'bom' : v < 0 ? 'ruim' : '');

function tabelaJogadores() {
  const termo = buscaJogador.trim().toLowerCase();
  // com menos de 30 mãos o BB/100 ainda é ruído: fora da lista, a não ser que procure pelo nome ou peça
  const poucos = listaJogadores.jogadores.filter(j => j.maos < AMOSTRA_MINIMA).length;
  const lista = listaJogadores.jogadores.filter(j => (termo ? j.nome.toLowerCase().includes(termo)
    : mostrarPoucos || j.maos >= AMOSTRA_MINIMA || j.nome === jogadorSel));
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
    !termo && poucos ? el('label', { className: 'nota', style: 'display:flex;gap:6px;align-items:center;padding:6px 0 0' }, [
      el('input', { type: 'checkbox', checked: mostrarPoucos, onchange: e => { mostrarPoucos = e.target.checked; redesenharLista(); } }),
      `mostrar os ${poucos.toLocaleString('pt-BR')} com menos de ${AMOSTRA_MINIMA} mãos`]) : null,
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
      'com showdown = mãos em que o jogador ficou até o fim com mais alguém (mostrando ou não); sem showdown = Net − com showdown',
      'EV all-in: quando o dinheiro entrou antes do river, o jogador leva a própria equity em cada pote (todos os boards que faltavam), não o que saiu',
      ult[5] ? `Net + jackpot: soma os ${fmt(ult[5], 1)} BB de jackpot pagos pela casa, que ficam fora do Net (só poker)` : '',
      'mão com seguro ou jackpot entra para quem tem o saldo batendo com o poker pelas cartas (o jackpot é descontado)',
      listaJogadores.fora.seguro_reconstruido ? `${listaJogadores.fora.seguro_reconstruido} saldos de quem o seguro pagou viraram o resultado do poker (perdeu tudo pelas cartas: menos o que investiu)` : '',
      listaJogadores.fora.saldo_nao_confere ? `${listaJogadores.fora.saldo_nao_confere} saldos de seguro ficam fora: o jogador levou parte do pote e o valor depende do resíduo do WPT` : '',
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


function desenharConferir() {
  const r = confDados, s = r.saude, m = r.mao;
  const segModo = el('div', { className: 'seg', role: 'group', 'aria-label': 'Modo' }, [
    ['sorteio', 'Sorteio (mede a taxa)'], ['suspeita', `Suspeitas (${s.suspeitas.length})`],
    ['nicks', confModo === 'nicks' && r.restantes !== undefined ? `Nicks repetidos (${r.restantes})` : 'Nicks repetidos'],
    ['txt', confModo === 'txt' && r.restantes !== undefined ? `Transcrição .txt (${r.restantes})` : 'Transcrição .txt']].map(([v, t]) => el('button', {
    type: 'button', textContent: t, ariaPressed: String(confModo === v), onclick: () => { confModo = v; consultar(); } })));
  const placar = el('span', { className: 'placar' }, s.conferidas
    ? [el('b', { textContent: `${s.conferidas}` }), ` sorteadas conferidas · `, el('b', { textContent: `${s.erros}` }), ` com erro · taxa de erro ≤ `,
      el('b', { textContent: pctTeto(s.teto) }), ' (95%)' + (s.conferidas_total > s.conferidas ? ` · mais ${s.conferidas_total - s.conferidas} da fila de suspeitas` : '')]
    : ['Nenhuma mão sorteada conferida ainda. 100 sem erro dizem "erro < 3%"; 300, "< 1%".']);
  const topo = el('section', { className: 'card conf-topo', style: 'padding:12px 16px' }, [segModo, placar]);
  if ((confModo === 'nicks' || confModo === 'txt') && r.modo !== confModo) {  // o JS novo chegou, o Python não: o servidor precisa reiniciar
    $('conferir').replaceChildren(topo, el('section', { className: 'card' }, [el('p', { className: 'nota neutro', textContent:
      'O site está rodando uma versão antiga do servidor, que ainda não conhece este modo. Feche a janela do "Abrir site.bat" e abra de novo.' })]));
    return;
  }
  if (confModo === 'nicks') { $('conferir').replaceChildren(topo, ...conferirNick(r)); return; }
  if (confModo === 'txt') { $('conferir').replaceChildren(topo, ...conferirTxt(r)); return; }
  if (!m) {
    $('conferir').replaceChildren(topo, el('section', { className: 'card' }, [el('p', { className: 'nota', textContent:
      confModo === 'suspeita' ? 'Nenhuma suspeita esperando conferência.' : 'Todas as mãos já foram conferidas.' })]));
    return;
  }
  const jogs = tabelaLeitura(m), ruas = ruasLeitura(m);
  const duvida = m.pior_rank > m.limiar;
  const corpo = el('section', { className: 'card conf-mao' }, [
    el('h3', {}, [`HAND ID ${m.hand_id}`, el('small', { className: 'muted', textContent: ` · ${m.data ?? ''} · ${m.n} jogadores · valores em BB (print em ${m.unidade})` })]),
    m.obs ? el('p', { className: 'nota', style: 'padding:0', textContent: `Marcada: ${m.obs}` }) : null,
    duvida ? el('p', { className: 'nota neutro', style: 'padding:0', textContent:
      `Carta duvidosa: o número de alguma carta ficou a ${fmt(m.pior_rank, 3)} do modelo (99% das mãos ficam abaixo de ${fmt(m.limiar, 2)}; o leitor aceita até 0,16). Olhe todas as cartas com calma.` }) : null,
    el('div', {}, [el('b', { textContent: 'Board ' }), el('span', { className: 'carta' }, cartasEl(m.board))]),
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
  $('conferir').replaceChildren(topo, el('div', { className: 'conf-grade' + (printLargo ? ' largo' : '') }, [
    el('div', { className: 'conf-lado' }, [barraPrint(m.png), el('section', { className: 'card conf-print' }, [
      el('img', { src: `/print/${encodeURIComponent(m.png)}`, alt: `Print da mão ${m.hand_id}` })])]),
    corpo]));
}

// A leitura da mão como o banco a guarda (em BB): jogadores e a linha de cada rua.
function tabelaLeitura(m) {
  return el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Pos', 'Nick', 'Cartas', 'Stack', 'Saldo'].map(c => el('th', { textContent: c })))]),
    el('tbody', {}, m.jogadores.map(j => el('tr', { className: j.cartas && !j.showdown ? 'olhar' : '',
      title: j.cartas && !j.showdown ? 'Estas cartas não decidiram o showdown: nenhuma conta confere, só o seu olho.' : '' }, [
      el('td', { textContent: j.pos + (j.hero ? ' (Hero)' : '') }), el('td', { textContent: j.nome ?? '—' }),
      el('td', { className: 'carta' }, j.cartas ? cartasEl(j.cartas) : ['—']),
      el('td', { className: 'num', textContent: fmt(j.stack) }),
      el('td', { className: 'num ' + corValor(j.net), textContent: fmt(j.net) })])))]);
}
function ruasLeitura(m) {
  return el('div', { className: 'rua-linha' }, m.linhas.map(([rua, board, pote, acoes]) => el('div', {}, [
    el('b', { textContent: NOME_RUA[rua] }), el('span', { className: 'carta' }, cartasEl(board)), ` (${fmt(pote)}) `,
    acoes.map(([pos, a]) => `${pos} ${a}`).join(' · ')])));
}

// Transcrição .txt: as mãos cujo .txt (o hand history que vai para o H2N) o Claude achou errado. Ao lado do print:
// a leitura, o que estava errado, o que a checagem independente (checa_txt.py) acha no .txt de agora, os dois .txt e o
// parecer do dono. A leitura certa e o arquivo errado são coisas diferentes: o parecer não entra na taxa de erro.
async function parecerTxt(ok) {
  const m = confDados?.mao, obs = $('txt-obs')?.value.trim();
  if (!m) return;
  if (!ok && !obs) { $('txt-obs').focus(); return; }
  document.body.classList.add('carregando');
  const meu = ++pedido;
  const r = await (await fetch('/api/parecer_txt', { method: 'POST', body: JSON.stringify({ hand_id: m.hand_id, ok, obs }) })).json();
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (r.erro) { $('conferir').prepend(el('p', { className: 'nota ruim', textContent: 'Erro: ' + r.erro })); return; }
  confDados = r;
  desenharConferir();
}

function conferirTxt(r) {
  const m = r.mao, t = r.txt;
  if (!m) {
    return [el('section', { className: 'card' }, [el('p', { className: 'nota', textContent:
      r.total ? `As ${r.total} mãos da fila do .txt já têm parecer.` : 'Nenhuma mão na fila do .txt.' })])];
  }
  const limpo = !t.problemas_agora.length;
  const lista = itens => el('ul', { className: 'checklist txt-achados' }, itens.map(i => el('li', { textContent: i })));
  const pre = texto => el('pre', { className: 'txt-mao' }, [texto ?? '(sem .txt)']);
  const corpo = el('section', { className: 'card conf-mao' }, [
    el('h3', {}, [`HAND ID ${m.hand_id}`, el('small', { className: 'muted', textContent:
      ` · ${r.total - r.restantes + 1} de ${r.total} · ${m.data ?? ''} · leitura em BB (print em ${m.unidade}) · o .txt sai em dinheiro` })]),
    m.obs ? el('p', { className: 'nota', style: 'padding:0', textContent: `Seguro/jackpot: ${m.obs}` }) : null,
    el('div', {}, [el('b', { textContent: 'Board ' }), el('span', { className: 'carta' }, cartasEl(m.board))]),
    tabelaLeitura(m), ruasLeitura(m),
    el('h4', { textContent: 'O que eu achei errado no .txt (antes de corrigir o Replayer)' }), lista(t.achados),
    el('h4', { textContent: 'Depois da correção' }),
    limpo ? el('p', { className: 'nota bom', style: 'padding:0', textContent:
      'A checagem independente não acha mais nada: as linhas seguem as regras do PokerStars, o pote fecha e quem recolhe é quem leva pelas cartas.' })
      : lista(t.problemas_agora.map(p => `Ainda: ${p}`)),
    el('details', { className: 'explica', open: true }, [el('summary', { textContent: 'O .txt de agora (o que vai para o H2N)' }), pre(t.agora)]),
    el('details', { className: 'explica' }, [el('summary', { textContent: 'O .txt de antes' }), pre(t.antes)]),
    el('ul', { className: 'checklist' }, [
      el('li', { textContent: 'compare o .txt de agora com o print: cada ação, cada valor (o print em BB vira dinheiro no .txt) e quem recolhe;' }),
      el('li', { textContent: 'o seguro não entra no .txt: o segurado aparece com o resultado do poker, não com o da tela.' })]),
    el('div', { className: 'conf-acoes' }, [
      el('button', { className: 'btn primario', type: 'button', textContent: 'O .txt está certo', onclick: () => parecerTxt(true) }),
      el('input', { id: 'txt-obs', placeholder: 'o que está errado (obrigatório em "tem erro")', maxLength: 1000, 'aria-label': 'Parecer', style: 'flex:1 1 260px' }),
      el('button', { className: 'btn erro', type: 'button', textContent: 'Tem erro', onclick: () => parecerTxt(false) })]),
  ]);
  return [el('div', { className: 'conf-grade' + (printLargo ? ' largo' : '') }, [
    el('div', { className: 'conf-lado' }, [barraPrint(m.png), el('section', { className: 'card conf-print' }, [
      el('img', { src: `/print/${encodeURIComponent(m.png)}`, alt: `Print da mão ${m.hand_id}` })])]),
    corpo])];
}

// O print é alto (mesa + histórico): rola dentro do quadro; "ampliar" dá metade da tela a ele; o link abre em tamanho real.
let printLargo = lerLocal('bp.printLargo') ?? false;
function barraPrint(png) {
  return el('div', { className: 'conf-barra-print' }, [
    el('span', { className: 'nota', style: 'padding:0', textContent: 'role o print para ver o histórico inteiro' }),
    el('button', { className: 'btn', type: 'button', textContent: printLargo ? 'reduzir' : 'ampliar',
      onclick: () => { printLargo = !printLargo; gravarLocal('bp.printLargo', printLargo); desenharConferir(); } }),
    el('a', { className: 'btn', href: `/print/${encodeURIComponent(png)}`, target: '_blank', rel: 'noopener', textContent: 'tamanho real ↗' })]);
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

// Hero × população no topo do Painel: onde o jeito dele jogar mais se afasta do field (só vilões). Uma linha por spot:
// Fold/Call/Raise contra a mesma aposta ficam juntos (o BB no total é do spot, não da ação).
function cartaoLeaks(spots) {
  if (!spots?.length) return null;
  const linhas = spots.map(l => {
    // uma linha de texto por ação do spot, na mesma ordem em todas as colunas
    const col = (f, cls = s => '') => l.stats.map(s => el('div', { className: cls(s) }, [s.acao ? el('small', { textContent: `${s.acao} ` }) : null, ...f(s)]));
    const dif = s => pct(s.hero[0], s.hero[1]) - pct(s.pop[0], s.pop[1]);
    const nh = l.stats[0].hero[1];
    return el('tr', { className: l.sig ? 'sig' : '' }, [
      el('th', {}, [`${l.secao} · ${l.nome}`, el('small', { className: 'muted', textContent: ` ${nh} suas` })]),
      el('td', { className: 'num' + (nh < AMOSTRA_MINIMA ? ' fraca' : '') }, col(s => [el('b', { title: tituloIC(...s.hero), textContent: `${pct(...s.hero)}%` })])),
      el('td', { className: 'num' }, col(s => [el('span', { title: tituloIC(...s.pop), textContent: `${pct(...s.pop)}%` })])),
      el('td', { className: 'num' }, col(s => [`${dif(s) > 0 ? '+' : ''}${dif(s)} pp`], s => (Math.abs(s.z) >= 2 && l.sig ? 'neutro' : ''))),
      el('td', { className: 'num z', title: '|z| ≥ 2: a diferença dificilmente é acaso' }, col(s => [fmt(s.z, 1)])),
      el('td', { className: 'num', title: 'lucro médio por decisão (BB), você × população' }, [l.lucro_hero === null ? '—' : `${fmt(l.lucro_hero, 1)} × ${fmt(l.lucro_pop, 1)}`]),
      el('td', { className: 'num' }, [l.bb === null ? '—' : el('b', { className: corValor(l.bb), textContent: bb(l.bb, 0) })])]);
  });
  return el('section', { className: 'card leaks' }, [
    el('h2', {}, ['Você × população', el('small', { className: 'muted', textContent: ` primeiro os ${spots.filter(s => s.sig).length} spots em que a diferença não é acaso, do que mais custa para o que mais rende` })]),
    el('div', { className: 'rolar' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Spot', 'Você', 'População', 'Diferença', 'z', 'Lucro/decisão', 'BB no total'].map(c => el('th', { textContent: c })))]),
      el('tbody', {}, linhas)])]),
    el('p', { className: 'nota', textContent: 'População = só os vilões (sem você). BB no total = (seu lucro médio no spot − o da população) × suas decisões: '
      + 'quanto o seu jeito de jogar o spot rendeu a mais ou a menos que o do field, uma vez por spot (Fold, Call e Raise contra a mesma aposta '
      + 'dividem o mesmo número). O lucro mistura sorte de carta; as linhas apagadas têm |z| < 2 em todas as ações ou menos de 30 decisões suas '
      + '(a diferença pode ser acaso). Mãos com seguro/jackpot ficam fora do lucro.' })]);
}

// ------------------------------------------------------------------------- Ver mãos + replayer
// "Ver mãos" do filtro (Estudo) ou da linha da MDA: 10 por vez, "mais 10" ou "ver todas"; uma decisão por linha, no
// resumo do H2N (cartas dele, board e pote por rua, as ações); o ▶ abre a mesa num pop-up, ação por ação.

const NAIPE = { c: '♣', d: '♦', h: '♥', s: '♠' };
const cartaEl = c => el('span', { className: `pc n-${c.slice(-1)}`, textContent: `${c.slice(0, -1).replace('10', 'T')}${NAIPE[c.slice(-1)] ?? ''}` });
const cartasEl = txt => (txt ?? '').split(' ').filter(Boolean).map(cartaEl);
const POR_PAGINA = 10;
// uma pilha de 1 a 3 fichas, maior quanto mais BB (só o desenho; o valor vai escrito ao lado)
const pilhaFichas = v => el('span', { className: 'ficha-pilha', ariaHidden: 'true' },
  Array.from({ length: v >= 50 ? 3 : v >= 10 ? 2 : 1 }, () => el('i')));

function painelMaos(corpo, rotulo = 'Ver mãos', ja = false) {
  const caixa = el('div', { className: 'ver-maos' });
  let carregadas = [], total = null;
  const buscar = async limite => {
    caixa.classList.add('carregando-maos');
    const r = await (await fetch('/api/maos', { method: 'POST', body: JSON.stringify({ ...corpo, offset: carregadas.length, limite }) })).json();
    caixa.classList.remove('carregando-maos');
    if (r.erro) { caixa.replaceChildren(el('p', { className: 'nota ruim', textContent: 'Erro: ' + r.erro })); return; }
    carregadas = carregadas.concat(r.maos);
    total = r.total;
    desenhar(r.max_todas);
  };
  const desenhar = maxTodas => {
    const falta = total - carregadas.length;
    caixa.replaceChildren(
      el('div', { className: 'lista-maos' }, carregadas.map((m, i) => linhaMao(m, () => abrirReplayer(carregadas, i)))),
      el('div', { className: 'maos-rodape' }, [
        el('span', { className: 'nota', style: 'padding:0', textContent: `${carregadas.length} de ${total.toLocaleString('pt-BR')} ${corpo.linha ? (total === 1 ? 'mão' : 'mãos') : total === 1 ? 'decisão' : 'decisões'} · ▶ abre a mesa` }),
        falta > 0 ? el('button', { className: 'btn', type: 'button', textContent: `mais ${Math.min(POR_PAGINA, falta)}`, onclick: () => buscar(POR_PAGINA) }) : null,
        falta > 0 ? el('button', { className: 'btn', type: 'button', textContent: total > maxTodas ? `ver as ${maxTodas.toLocaleString('pt-BR')} mais recentes` : `ver todas (${total.toLocaleString('pt-BR')})`,
          onclick: () => buscar(0) }) : null]));
  };
  if (ja) buscar(POR_PAGINA);
  else caixa.append(el('button', { className: 'btn primario', type: 'button', textContent: rotulo, onclick: () => buscar(POR_PAGINA) }));
  return caixa;
}

function linhaMao(m, tocar) {
  const ruas = m.linha.map(([rua, board, pote, acoes]) => el('span', { className: 'seg-mao' }, [
    ...cartasEl(board), el('small', { textContent: `(${fmt(pote, 1)})` }),
    ...acoes.map(([pos, a]) => el('span', { className: 'ac' + (pos === m.pos ? ' eu' : '') + (/^[BR]/.test(a) ? ' agr' : ''),
      title: pos, textContent: pos === m.pos ? a : `${pos} ${a}` }))]));
  return el('div', { className: 'linha-mao' }, [
    el('button', { className: 'play', type: 'button', textContent: '▶', title: 'reproduzir a mão', ariaLabel: `reproduzir a mão ${m.hand_id}`, onclick: tocar }),
    el('span', { className: 'quem', title: m.nome ?? '' }, [el('b', { textContent: m.pos }), ` ${m.nome ?? ''}`]),
    el('span', { className: 'mao-cartas' }, m.cartas ? cartasEl(m.cartas) : [el('span', { className: 'muted', textContent: '—' })]),
    el('span', { className: 'ruas' }, ruas),
    el('span', { className: 'num ' + (m.lucro == null ? '' : corValor(m.lucro)), title: 'BB ganhos a partir desta decisão (vazio em mão com seguro/jackpot)',
      textContent: m.lucro == null ? '—' : bb(m.lucro) }),
    el('span', { className: 'muted', textContent: m.data ?? '' })]);
}

async function abrirReplayer(lista, inicio) {
  document.getElementById('replayer')?.remove();
  let i = inicio, dados = null, k = 0, verPrint = false;
  const fundo = el('div', { id: 'replayer', className: 'rp-fundo', role: 'dialog', ariaModal: 'true', ariaLabel: 'replayer da mão' });
  const caixa = el('div', { className: 'rp-caixa' });
  fundo.append(caixa);
  const fechar = () => { fundo.remove(); document.removeEventListener('keydown', teclas); };
  fundo.addEventListener('click', e => { if (e.target === fundo) fechar(); });
  const teclas = e => {
    if (e.key === 'Escape') fechar(); else if (e.key === 'ArrowRight') passo(1); else if (e.key === 'ArrowLeft') passo(-1);
    else if (e.key === 'ArrowUp') { e.preventDefault(); outra(-1); } else if (e.key === 'ArrowDown') { e.preventDefault(); outra(1); }
  };
  const passo = d => { if (!dados) return; k = Math.max(0, Math.min(dados.quadros.length - 1, k + d)); desenhar(); };
  const rua = r => { const j = dados.quadros.findIndex(f => f.rua === r); if (j >= 0) { k = j; desenhar(); } };
  const outra = async d => { const n = i + d; if (n < 0 || n >= lista.length) return; i = n; await carregar(); };
  const carregar = async () => {
    caixa.replaceChildren(el('p', { className: 'nota', textContent: 'carregando a mão…' }));
    const m = lista[i];
    dados = await (await fetch('/api/mao', { method: 'POST', body: JSON.stringify({ hand_id: m.hand_id }) })).json();
    if (dados.erro) { caixa.replaceChildren(el('p', { className: 'nota ruim', textContent: 'Erro: ' + dados.erro })); return; }
    // começa sempre no flop, antes da primeira ação (o SB; heads-up, o BB); quem decidiu fica destacado (.foco)
    k = 0;
    desenhar();
  };
  function desenhar() {
    const f = dados.quadros[k], m = lista[i];
    const mesa = el('div', { className: 'rp-mesa' }, [
      el('div', { className: 'rp-feltro' }, [
        el('div', { className: 'rp-board' }, f.board.map(cartaEl)),
        el('div', { className: 'rp-pote-fichas' }, [pilhaFichas(f.pote), el('div', { className: 'rp-pote num', textContent: `Pote: ${fmt(f.pote, 2)} BB` })]),
        f.odds != null ? el('div', { className: 'rp-odds', textContent: `pot odds ${fmt(f.odds, 1)}%` }) : null]),
      ...f.assentos.map(s => {
        const [x, y] = LUGARES[((s.seat ?? 0) % 8 + 8) % 8];
        const res = f.resultado?.[s.pos];
        return el('div', { className: 'rp-assento' + (s.foldou ? ' foldou' : '') + (f.ator === s.pos ? ' vez' : '') + (s.pos === m.pos ? ' foco' : ''),
          style: `left:${x}%;top:${y}%` }, [
          el('div', { className: 'rp-cartas' }, s.cartas ? cartasEl(s.cartas) : []),
          el('div', { className: 'rp-placa' }, [el('b', { textContent: s.nome }), el('span', { className: 'num', textContent: `${fmt(s.stack, 2)} BB` }),
            el('small', { textContent: s.pos + (s.hero ? ' · Hero' : '') })]),
          f.ator === s.pos ? el('div', { className: 'rp-fala', textContent: f.texto }) : null,
          res != null ? el('div', { className: 'rp-res num ' + corValor(res), textContent: bb(res) }) : null]);
      }),
      // as fichas apostadas na rua: entre o assento e o centro da mesa, com o valor
      ...f.assentos.filter(s => s.aposta).map(s => {
        const [x, y] = LUGARES[((s.seat ?? 0) % 8 + 8) % 8];
        return el('div', { className: 'rp-fichas', style: `left:${x + (50 - x) * 0.42}%;top:${y + (50 - y) * 0.42}%` },
          [pilhaFichas(s.aposta), el('b', { textContent: fmt(s.aposta, 2) })]);
      }),
      // o botão do dealer, ao lado do BTN
      ...f.assentos.filter(s => s.pos === 'BTN').map(s => {
        const [x, y] = LUGARES[((s.seat ?? 0) % 8 + 8) % 8];
        return el('div', { className: 'rp-dealer', title: 'botão do dealer', textContent: 'D', style: `left:${x + (50 - x) * 0.36 + 5}%;top:${y + (50 - y) * 0.36}%` });
      })]);
    const ruas = ['flop', 'turn', 'river'];
    caixa.replaceChildren(
      el('div', { className: 'rp-cab' }, [
        el('b', { textContent: `HAND ID ${dados.hand_id}` }),
        el('span', { className: 'muted', textContent: ` · ${dados.data ?? ''} · mão ${i + 1} de ${lista.length} · ${f.ator ? '' : f.texto}` }),
        dados.obs ? el('span', { className: 'neutro', title: dados.obs, textContent: ' · seguro/jackpot' }) : null,
        el('span', { className: 'rp-dir' }, [
          el('button', { className: 'btn' + (verPrint ? ' primario' : ''), type: 'button', textContent: verPrint ? 'Esconder o print' : 'Ver o print',
            onclick: () => { verPrint = !verPrint; desenhar(); } }),
          el('button', { className: 'btn', type: 'button', textContent: '✕', ariaLabel: 'fechar', onclick: fechar })])]),
      el('div', { className: 'rp-corpo' + (verPrint ? ' com-print' : '') }, [mesa,
        verPrint ? el('div', { className: 'rp-print' }, [el('img', { src: `/print/${encodeURIComponent(dados.png)}`, alt: `Print da mão ${dados.hand_id}` })]) : null]),
      el('div', { className: 'rp-ctl' }, [
        el('button', { className: 'btn', type: 'button', textContent: '◀', title: 'ação anterior (←)', disabled: k === 0, onclick: () => passo(-1) }),
        el('button', { className: 'btn', type: 'button', textContent: '▶', title: 'próxima ação (→)', disabled: k === dados.quadros.length - 1, onclick: () => passo(1) }),
        el('div', { className: 'seg' }, ruas.map(r => el('button', { type: 'button', textContent: NOME_RUA[r], ariaPressed: String(f.rua === r),
          disabled: !dados.quadros.some(q => q.rua === r), onclick: () => rua(r) }))),
        el('button', { className: 'btn', type: 'button', textContent: 'fim', onclick: () => { k = dados.quadros.length - 1; desenhar(); } }),
        el('span', { className: 'rp-dir' }, [
          el('button', { className: 'btn', type: 'button', textContent: '▲ mão anterior', disabled: i === 0, onclick: () => outra(-1) }),
          el('button', { className: 'btn', type: 'button', textContent: 'próxima mão ▼', disabled: i === lista.length - 1, onclick: () => outra(1) })])]));
  }
  document.addEventListener('keydown', teclas);
  document.body.append(fundo);
  await carregar();
}

// ------------------------------------------------------------------------- consulta e desenho

let pedido = 0;
let vista = ['painel', 'mda', 'jogadores', 'conferir'].includes(lerLocal('bp.vista2')) ? lerLocal('bp.vista2') : 'estudo';
let filtrosPainel = lerLocal('bp.filtrosPainel') ?? {};  // { data: { min, max } }

async function consultar() {
  if (!opcoes) return;  // trocou de aba durante a carga: o início chama trocarVista(vista) quando as opções chegarem
  const meu = ++pedido;
  if (vista === 'mda') mostrarAtivos();
  document.body.classList.add('carregando');
  if (vista === 'painel') return consultarPainel(meu);
  if (vista === 'mda') return consultarMda(meu);
  if (vista === 'jogadores') return consultarJogadores(meu);
  if (vista === 'conferir') return consultarConferir(meu);
  const r = await fetch('/api/linha', { method: 'POST', body: JSON.stringify({ linha: linhaSel }) }).then(x => x.json());
  if (meu !== pedido) return;  // chegou uma consulta mais nova enquanto esta voltava
  document.body.classList.remove('carregando');
  if (r.erro) { $('estudo').replaceChildren(el('p', { className: 'nota', textContent: 'Erro: ' + r.erro })); return; }
  linhaDados = r;
  desenharLinha();
}

function barraPainel() {
  const data = (lado, rot) => el('input', { type: 'date', value: filtrosPainel.data?.[lado] ?? '', 'aria-label': rot,
    min: opcoes.datas?.[0] ?? '', max: opcoes.datas?.[1] ?? '', onchange: e => {
      const d = { ...(filtrosPainel.data ?? {}), [lado]: e.target.value };
      filtrosPainel = d.min || d.max ? { data: d } : {};
      gravarLocal('bp.filtrosPainel', filtrosPainel);
      consultar();
    } });
  return el('div', { className: 'grupo-cmd cmd-datas' }, [el('span', { textContent: 'Período (opcional): ver se um leak corrigido sumiu' }),
    el('div', { className: 'faixa' }, [data('min', 'Data inicial'), data('max', 'Data final')])]);
}

async function consultarPainel(meu) {
  const corpo = JSON.stringify(filtrosPainel);
  const [r, leaks] = await Promise.all([
    fetch('/api/painel', { method: 'POST', body: corpo }).then(x => x.json()),
    fetch('/api/leaks', { method: 'POST', body: corpo }).then(x => x.json())]);
  if (meu !== pedido) return;
  document.body.classList.remove('carregando');
  if (!Array.isArray(r)) { $('painel').replaceChildren(el('p', { className: 'nota', textContent: 'Erro: ' + (r.erro ?? '') })); return; }
  const secoes = {};
  for (const s of r) (secoes[s.secao] ??= []).push(s);
  $('painel').replaceChildren(
    barraPainel(),
    ...(Array.isArray(leaks) ? [cartaoLeaks(leaks)].filter(Boolean) : []),
    el('p', { className: 'nota', style: 'padding:0', textContent: 'Stats prontas do field (você incluído).' }),
    el('div', { className: 'painel-grade' }, Object.entries(secoes).map(([secao, stats]) => el('section', { className: 'card' }, [
      el('h2', { textContent: secao }),
      el('table', {}, [el('tbody', {}, stats.map(s => {
        const [f, n] = s.v;
        return el('tr', {}, [
          el('th', { textContent: s.nome }),
          el('td', { className: 'num' + (n < AMOSTRA_MINIMA ? ' fraca' : ''), title: tituloIC(f, n) }, [
            el('b', { textContent: n ? `${pct(f, n)}%` : '—' })]),
          el('td', { className: 'num', style: 'color:var(--muted)', textContent: n.toLocaleString('pt-BR') })]);
      }))])]))));
}

function trocarVista(v) {
  vista = v;
  gravarLocal('bp.vista2', v);
  for (const aba of ['estudo', 'painel', 'mda', 'jogadores', 'conferir']) {
    $(aba).hidden = v !== aba;
    $('aba-' + aba).setAttribute('aria-selected', String(v === aba));
  }
  $('ferramentas').hidden = v !== 'estudo';  // salvar e exportar agem sobre a linha do Estudo
  $('ativos').hidden = v !== 'mda';          // as pílulas da posição e da mesa escolhidas na MDA
  mudou();
}

function mudou() {
  history.replaceState(null, '', vista === 'estudo' && Object.keys(linhaSel).length ? '#' + encodeURIComponent(JSON.stringify({ linha: linhaSel })) : '#');
  gravarLocal('bp.filtros', filtros);
  consultar();
}

// ------------------------------------------------------------------------- linhas salvas, exportar

function montarListas() {
  const s = $('salvos');
  const salvos = lerLocal('bp.linhas') ?? {};
  s.replaceChildren(el('option', { value: '', textContent: 'Minhas linhas…' }),
    ...Object.keys(salvos).map(n => el('option', { value: n, textContent: n })));
  s.onchange = () => { if (s.value) { linhaSel = structuredClone(salvos[s.value]); limparLinha(); s.value = ''; trocarVista('estudo'); } };
}

$('salvar').onclick = () => {
  const nome = prompt('Nome da linha:');
  if (!nome) return;
  const salvos = lerLocal('bp.linhas') ?? {};
  salvos[nome] = linhaSel;
  gravarLocal('bp.linhas', salvos);
  montarListas();
};
$('exportar').onclick = async () => {
  const res = await fetch('/api/exportar', { method: 'POST', body: JSON.stringify({ linha: linhaSel }) });
  const nome = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'bombpot.txt';
  const link = el('a', { href: URL.createObjectURL(await res.blob()), download: nome });
  link.click();
  URL.revokeObjectURL(link.href);
};
$('aba-estudo').onclick = () => trocarVista('estudo');
$('aba-painel').onclick = () => trocarVista('painel');
$('aba-mda').onclick = () => trocarVista('mda');
$('aba-jogadores').onclick = () => trocarVista('jogadores');
$('aba-conferir').onclick = () => trocarVista('conferir');

// ------------------------------------------------------------------------- início

(async () => {
  opcoes = await (await fetch('/api/opcoes')).json();
  $('info').textContent = `${opcoes.maos.toLocaleString('pt-BR')} bomb pots`;
  desenharSelo(opcoes.saude);
  try { linhaSel = JSON.parse(decodeURIComponent(location.hash.slice(1))).linha ?? {}; } catch { linhaSel = {}; }
  limparLinha();  // link antigo: tira o que não existe mais
  montarListas();
  trocarVista(vista);
})();
