"""Tabela derivada `resultados`: uma linha por jogador por mao, para o grafico da aba Jogadores.

Net (BB), se foi ao showdown e o EV ajustado por all-in, como o grafico do H2N / MetaLens (src/graph.ts de la,
portado). Bomb pot nao tem pre-flop: o all-in mais cedo e no flop, faltam no maximo 2 cartas e a equity sai exata,
enumerando todos os boards (no maximo 990), sem sorteio.

O nick e jogadores.nome (a mesma fonte do .txt: digitado, bitmap, OCR ou anonimo estavel). Mao sem o nick de
alguem fica fora: sem nick nao ha de quem e o resultado. Mao marcada (seguro/jackpot) entra jogador a jogador: so
quem tem o saldo batendo com o poker pelas cartas.
"""
from __future__ import annotations

import re
import sqlite3
import sys
from collections import defaultdict
from itertools import combinations
from pathlib import Path

import decisoes

RAIZ = Path(__file__).resolve().parent
ESQUEMA = """
DROP TABLE IF EXISTS resultados;
CREATE TABLE resultados (
  hand_id TEXT NOT NULL, nome TEXT NOT NULL, pos TEXT NOT NULL, hero INTEGER NOT NULL,
  net REAL NOT NULL,     -- BB
  sd INTEGER NOT NULL,   -- ficou ate o fim com mais alguem (mostrou ou nao)
  ev REAL,               -- all-in ajustado; = net sem all-in; NULL = all-in sem as cartas de alguem (grafico usa net)
  jackpot REAL NOT NULL, -- BB pagos pela casa nesta mao (fora do net, que e so poker); 0 sem jackpot
  PRIMARY KEY (hand_id, pos)
);
CREATE INDEX resultados_nome ON resultados (nome);
"""

# ---------- avaliador de 7 cartas: maior = melhor (o rank7 do MetaLens) ----------
RANKS, SUITS = "23456789TJQKA", "cdhs"


def carta(s: str) -> int:
    """'Kh', '10c' (o WPT escreve o dez com dois digitos) -> rank * 4 + naipe."""
    rank = "T" if s[:-1] == "10" else s[:-1].upper()
    return RANKS.index(rank) * 4 + SUITS.index(s[-1].lower())


def _straight(m: int) -> int:
    ext = (m << 1) | ((m >> 12) & 1)  # o as tambem joga baixo
    for t in range(13, 3, -1):
        if (ext >> (t - 4)) & 31 == 31:
            return t - 1
    return -1


def _top(m: int, n: int) -> int:
    out = 0
    for r in range(12, -1, -1):
        if n and m & (1 << r):
            out, n = (out << 4) | r, n - 1
    return out


def rank7(cs) -> int:
    cnt, sm, todos = [0] * 13, [0] * 4, 0
    for c in cs:
        r = c >> 2
        cnt[r] += 1
        sm[c & 3] |= 1 << r
        todos |= 1 << r
    for m in sm:
        if bin(m).count("1") >= 5:  # com 7 cartas, flush exclui quadra e full
            t = _straight(m)
            return (8 << 20) | t if t >= 0 else (5 << 20) | _top(m, 5)
    quadra = trinca = trinca2 = par = par2 = -1
    for r in range(12, -1, -1):
        k = cnt[r]
        if k == 4:
            quadra = r
        elif k == 3:
            if trinca < 0:
                trinca = r
            else:
                trinca2 = r
        elif k == 2:
            if par < 0:
                par = r
            elif par2 < 0:
                par2 = r
    if quadra >= 0:
        return (7 << 20) | (quadra << 4) | _top(todos & ~(1 << quadra), 1)
    if trinca >= 0 and (trinca2 >= 0 or par >= 0):
        return (6 << 20) | (trinca << 4) | max(trinca2, par)
    t = _straight(todos)
    if t >= 0:
        return (4 << 20) | t
    if trinca >= 0:
        return (3 << 20) | (trinca << 8) | _top(todos & ~(1 << trinca), 2)
    if par2 >= 0:
        return (2 << 20) | (par << 8) | (par2 << 4) | _top(todos & ~(1 << par) & ~(1 << par2), 1)
    if par >= 0:
        return (1 << 20) | (par << 12) | _top(todos & ~(1 << par), 3)
    return _top(todos, 5)


def equity(potes: list[tuple[float, list[str]]], hole: dict[str, list[int]], board: list[int]) -> dict[str, float]:
    """Quanto cada um leva, em media, de cada pote, sobre todos os boards que faltam (enumeracao exata)."""
    usadas = set(board) | {c for cs in hole.values() for c in cs}
    baralho = [c for c in range(52) if c not in usadas]
    ganho, runs = dict.fromkeys(hole, 0.0), 0
    for resto in combinations(baralho, 5 - len(board)):
        b = board + list(resto)
        score = {p: rank7(cs + b) for p, cs in hole.items()}
        for valor, elegiveis in potes:
            melhor = max(score[p] for p in elegiveis)
            ganhadores = [p for p in elegiveis if score[p] == melhor]
            for p in ganhadores:
                ganho[p] += valor / len(ganhadores)
        runs += 1
    return {p: g / runs for p, g in ganho.items()}


# ---------- a mao ----------
def investido(n: int, ante: float, pos: list[str], acoes: list) -> dict[str, float]:
    """Quanto cada um pos na mao (BB), com as normalizacoes do WPT de `decisoes` e a bet nao paga devolvida."""
    put = dict.fromkeys(pos, ante / n)  # a entrada da bomb pot
    for rua in ("flop", "turn", "river"):
        rua_ac = [a for a in acoes if a[0] == rua]
        street, maior, apostou = defaultdict(float), 0.0, False
        for _, p, verbo, valor, allin in rua_ac:
            valor = valor or 0.0
            if verbo == "Raise" and not apostou:  # all-in sem bet antes: o WPT escreve Raise
                verbo = "Bet"
            if (verbo == "Raise" and valor <= maior) or (verbo == "Call" and allin):  # all-in por menos / call all-in:
                street[p] = max(street[p], valor)                                    # o WPT escreve o total na rua
            elif verbo in ("Bet", "Raise"):  # Raise = total na rua
                street[p], maior, apostou = valor, valor, True
            elif verbo == "Call":  # Call normal = so o complemento
                street[p] += valor
        for p, v in street.items():
            put[p] += v
    # a bet que ninguem pagou volta: o maior so arrisca ate o segundo maior
    ordem = sorted(put.values(), reverse=True)
    if len(ordem) >= 2 and ordem[0] > ordem[1]:
        topo = max(put, key=lambda p: put[p])
        put[topo] = ordem[1]
    return put


def potes(put: dict[str, float], vivos: list[str]) -> list[tuple[float, list[str]]]:
    """Pote principal e side pots: (valor, quem disputa). O dinheiro de quem foldou entra ate o nivel que ele pos."""
    saida, antes = [], 0.0
    for nivel in sorted({put[p] for p in vivos}):
        saida.append((sum(min(x, nivel) - min(x, antes) for x in put.values()), [p for p in vivos if put[p] >= nivel]))
        antes = nivel
    return saida


def poker(n: int, ante: float, board: str, acoes: list, jog: dict) -> dict[str, float] | None:
    """pos -> o que o poker deu pelas cartas e o board, antes do rake (ganho dos potes - o que pos).

    None quando nao da para saber: showdown sem as cartas de quem disputa, ou board incompleto."""
    put = investido(n, ante, list(jog), acoes)
    foldaram = {a[1] for a in acoes if a[2] == "Fold"}
    vivos = [p for p in jog if p not in foldaram]
    ganho = dict.fromkeys(jog, 0.0)
    if len(vivos) == 1:
        ganho[vivos[0]] = sum(put.values())
    else:
        if any(not jog[p][1] for p in vivos) or len(board.split()) < 5:
            return None
        b = [carta(c) for c in board.split()]
        score = {p: rank7([carta(c) for c in jog[p][1].split()] + b) for p in vivos}
        for valor, elegiveis in potes(put, vivos):
            melhor = max(score[p] for p in elegiveis)
            ganhadores = [p for p in elegiveis if score[p] == melhor]
            for p in ganhadores:
                ganho[p] += valor / len(ganhadores)
    return {p: ganho[p] - put[p] for p in jog}


# Rake medido nas maos limpas: 0 a 3,1% do pote (no maximo 3 BB); o WPT arredonda o saldo em BB (ate 0,5).
RAKE_MAX, ARREDONDA = 0.035, 0.5
# O residuo que o WPT tira do pote (medido no Replayer: 0 a 2,10 BB em 485 maos); igual ao RESIDUO_MAX de la.
RESIDUO_MAX = 2.5


def bate_com_o_poker(net: float, esperado: float, pote: float) -> bool:
    """O saldo e o do poker? Quem perdeu perde o que pos; quem ganhou leva o pote menos o rake."""
    if esperado < 0:
        return abs(net - esperado) <= ARREDONDA
    return esperado - RAKE_MAX * pote - ARREDONDA <= net <= esperado + ARREDONDA


JACKPOT = re.compile(r"(\S+): (?:[^\d\s]+ )?([\d.,]+)(?: BB)? do ganho vieram do jackpot da casa, nao do poker "
                     r"\(saldo de poker: (?:[^\d\s]+ )?([\d.,]+)")


def _numero(s: str) -> float:
    return float(s.replace(".", "").replace(",", ".")) if "," in s else float(s)


def sem_jackpot(obs: str | None) -> dict[str, float]:
    """pos -> fracao do saldo que e poker, nas maos em que a leitura registrou o jackpot pago pela casa."""
    saida = {}
    for pos, jackpot, poker_ in JACKPOT.findall(obs or ""):
        j, p = _numero(jackpot), _numero(poker_)
        saida[pos] = p / (p + j)
    return saida


def resultados_da_mao(n: int, ante: float, board: str, acoes: list, jog: dict,
                      rake: float | None = None) -> dict[str, tuple[float, int, float | None]]:
    """pos -> (net, sd, ev). jog: pos -> (net, cartas). rake: None = o que falta na soma dos saldos (mao limpa)."""
    foldaram = {p for _, p, verbo, _, _ in acoes if verbo == "Fold"}
    vivos = [p for p in jog if p not in foldaram]
    sd = len(vivos) >= 2
    net = {p: jog[p][0] or 0.0 for p in jog}
    ev: dict[str, float | None] = dict(net)
    cartas_board = board.split()
    ruas_com_acao = [a[0] for a in acoes if a[2] in ("Check", "Bet", "Call", "Raise", "Fold")]
    ultima = max((("flop", "turn", "river").index(r) for r in ruas_com_acao), default=0)
    if sd and ultima < 2 and len(cartas_board) == 5:  # all-in antes do river: ninguem mais podia apostar
        if any(not jog[p][1] for p in vivos):
            for p in vivos:
                ev[p] = None
        else:
            put = investido(n, ante, list(jog), acoes)
            total = sum(put.values())
            if rake is None:
                rake = -sum(net.values())
            hole = {p: [carta(c) for c in jog[p][1].split()] for p in vivos}
            parte = equity([(v * (1 - rake / total), e) for v, e in potes(put, vivos)], hole,
                           [carta(c) for c in cartas_board[:3 + ultima]])
            for p in vivos:
                ev[p] = round(parte[p] - put[p], 2)
    return {p: (net[p], int(sd and p not in foldaram), ev[p]) for p in jog}


def reconstruir(con: sqlite3.Connection) -> dict:
    acoes = defaultdict(list)
    for hid, *resto in con.execute("SELECT hand_id, rua, pos, verbo, valor, allin FROM acoes ORDER BY hand_id, ordem"):
        acoes[hid].append(tuple(resto))
    jog = defaultdict(dict)
    for hid, pos, nome, net, cs, hero in con.execute("SELECT hand_id, pos, nome, net, cartas, hero FROM jogadores"):
        jog[hid][pos] = (nome, net, cs, hero)
    linhas, fora = [], {"sem_nick": 0, "saldo_nao_confere": 0, "seguro_reconstruido": 0}
    for hid, n, ante, board, obs in con.execute("SELECT id, n_jogadores, ante_bb, board, obs FROM hands"):
        if any(not j[0] for j in jog[hid].values()):
            fora["sem_nick"] += 1
            continue
        jackpot = {}
        if not obs:
            res = resultados_da_mao(n, ante or 0, board or "", acoes[hid], {p: (j[1], j[2]) for p, j in jog[hid].items()})
            confere = set(res)
        else:
            # mao com seguro/jackpot: o saldo de quem comprou o seguro ou levou o jackpot nao e o do poker. Entra
            # cada jogador cujo saldo bate com o poker pelas cartas; o do jackpot, pelo saldo de poker que a leitura
            # registrou (e conferido do mesmo jeito). Quem nao bate fica fora.
            fracao = sem_jackpot(obs)
            jackpot = {p: round(j[1] * (1 - f), 2) for p, f in fracao.items() for j in [jog[hid][p]]}
            nets = {p: round(j[1] * fracao.get(p, 1.0), 2) for p, j in jog[hid].items()}
            cartas = {p: (nets[p], j[2]) for p, j in jog[hid].items()}
            esperado = poker(n, ante or 0, board or "", acoes[hid], cartas)
            put = investido(n, ante or 0, list(cartas), acoes[hid])
            pote = sum(put.values())
            confere = {p for p in nets if esperado is not None and bate_com_o_poker(nets[p], esperado[p], pote)}
            # A regra do Replayer (wptparse/hand.py, _saldo_real_do_seguro) para quem o seguro pagou: se ele nao
            # levou nada do pote, o saldo de poker e menos o que investiu -- exato, sem depender do residuo. La
            # quem levou o pote sai do stack (e erra quando o seguro pagou mais do que o premio); aqui sai das
            # cartas, e a conservacao confirma: os saldos limpos explicam o pote inteiro, menos o residuo.
            # Quem levou parte do pote (side pot, pote dividido) continua fora: o valor depende do residuo.
            if esperado is not None:
                perdeu_tudo = {p for p in nets if p not in confere and esperado[p] <= -put[p] + 0.005}
                sobra = pote - sum(nets[p] + put[p] for p in confere)
                if perdeu_tudo and len(confere | perdeu_tudo) == len(nets) and 0 <= sobra <= RESIDUO_MAX:
                    for p in perdeu_tudo:
                        nets[p] = round(-put[p], 2)
                        cartas[p] = (nets[p], cartas[p][1])
                    confere |= perdeu_tudo
                    fora["seguro_reconstruido"] += len(perdeu_tudo)
            # o rake: o que os ganhadores conferidos deixaram de levar (sem ganhador conferido, 0)
            rake = sum(esperado[p] - nets[p] for p in confere if esperado[p] > 0) if esperado else 0.0
            res = resultados_da_mao(n, ante or 0, board or "", acoes[hid], cartas, rake=max(rake, 0.0))
            fora["saldo_nao_confere"] += len(res) - len(confere)
        for p, (net, sd, ev) in res.items():
            if p in confere:
                linhas.append((hid, jog[hid][p][0], p, jog[hid][p][3], net, sd, ev, jackpot.get(p, 0.0)))
    with con:
        con.executescript(ESQUEMA)
        con.executemany("INSERT INTO resultados VALUES (?,?,?,?,?,?,?,?)", linhas)
    FORA.clear()
    FORA.update(fora)
    return {"linhas": len(linhas), **fora}


FORA: dict[str, int] = {}  # o que a ultima reconstrucao deixou fora, para o rodape do grafico


def jogadores(con: sqlite3.Connection) -> list[dict]:
    """Todos os nicks, de quem tem mais maos para quem tem menos (como no MetaLens)."""
    return [{"nome": nome, "maos": maos, "net": round(net, 2), "ev": round(ev, 2), "sd": round(sd, 2), "jackpot": round(jp, 2)}
            for nome, maos, net, ev, sd, jp in con.execute(
                "SELECT nome, count(*), sum(net), sum(coalesce(ev, net)), sum(CASE WHEN sd THEN net ELSE 0 END), sum(jackpot) "
                "FROM resultados GROUP BY nome ORDER BY 2 DESC, 1")]


def serie(con: sqlite3.Connection, nome: str, maximo: int = 1000) -> dict:
    """A serie do grafico: [mao n, net, showdown, ev, data, jackpot] acumulados; sem showdown = net - showdown.

    Mais de 2*maximo maos: por bloco fica o ponto mais baixo e o mais alto do net (picos e vales sobrevivem)."""
    pontos, net, sd, ev, jp, sem_cartas = [[0, 0.0, 0.0, 0.0, None, 0.0]], 0.0, 0.0, 0.0, 0.0, 0
    for i, (hid, n, s, e, j) in enumerate(con.execute(
            "SELECT hand_id, net, sd, ev, jackpot FROM resultados WHERE nome = ? ORDER BY CAST(hand_id AS INTEGER)", (nome,)), 1):
        net += n
        jp += j
        sd += n if s else 0
        sem_cartas += e is None
        ev += n if e is None else e
        pontos.append([i, round(net, 2), round(sd, 2), round(ev, 2), decisoes.data_do_id(hid), round(jp, 2)])
    if len(pontos) > 2 * maximo:
        tam, menos = -(-len(pontos) // maximo), []
        for b in range(0, len(pontos), tam):
            bloco = pontos[b:b + tam]
            lo, hi = min(bloco, key=lambda p: p[1]), max(bloco, key=lambda p: p[1])
            menos += [lo] if lo is hi else sorted([lo, hi], key=lambda p: p[0])
        pontos = ([pontos[0]] if menos[0] is not pontos[0] else []) + menos + \
            ([pontos[-1]] if menos[-1] is not pontos[-1] else [])
    return {"nome": nome, "maos": len(pontos) and pontos[-1][0], "sem_cartas": sem_cartas, "pontos": pontos}


if __name__ == "__main__":
    import tracker

    print(reconstruir(tracker.abrir()))
    sys.exit(0)
