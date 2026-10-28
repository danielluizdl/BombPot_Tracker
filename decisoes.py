"""Uma linha por decisao pos-flop, com todo o contexto: a base dos filtros do site.

    python decisoes.py        reconstroi a tabela `decisoes` a partir de hands/acoes/jogadores

Toda pergunta do estudo vira um WHERE nesta tabela ("enfrentando aposta de 0,34-0,45 do
pote, no flop, fora de posicao, o que a populacao faz?"). A tabela e derivada: apaga-la e
rodar de novo da o mesmo resultado, entao nada aqui e fonte de verdade.
"""

from __future__ import annotations

import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import forca as forca_h2n
import tracker  # noqa: F401 - poe o Poker_Replayer no sys.path
from wptparse.avaliador import VALOR

RAIZ = Path(__file__).resolve().parent
RUAS = ("flop", "turn", "river")
FORCAS = forca_h2n.ORDEM
DRAWS = forca_h2n.DRAWS
ACOES = ("Check", "Bet", "Call", "Fold", "Raise")

ESQUEMA = """
DROP TABLE IF EXISTS decisoes;
CREATE TABLE decisoes (
  hand_id TEXT NOT NULL, rua TEXT NOT NULL, ordem INTEGER NOT NULL,
  pos TEXT NOT NULL,            -- posicao da mesa (SB, BB, UTG ... BTN)
  pos_rel TEXT NOT NULL,        -- '1º a agir', 'meio', 'último' entre os vivos da rua
  ordem_rua INTEGER NOT NULL,   -- 1 = primeiro a agir entre os vivos do comeco da rua, 2 = segundo...
  ip INTEGER NOT NULL,          -- 1 = ultimo a agir entre os vivos da rua
  hero INTEGER NOT NULL,
  n_jogadores INTEGER NOT NULL, -- sentados na mao
  n_vivos INTEGER NOT NULL,     -- ainda na mao no comeco da rua
  pote REAL NOT NULL,           -- BB, antes da acao
  spr REAL,                     -- stack efetivo / pote no comeco da rua; NULL em mao marcada
  situacao TEXT NOT NULL,       -- 'livre', 'enfrenta aposta', 'enfrenta raise'
  tamanho_enfrentado REAL,      -- fracao do pote da ultima agressao que ele enfrenta
  decisao_n INTEGER NOT NULL,   -- 1 = primeira vez que age na rua
  checou_antes INTEGER NOT NULL,
  agressor_anterior INTEGER NOT NULL, -- foi o ultimo agressor da rua anterior
  rua_anterior_checada INTEGER,       -- NULL no flop
  acao_anterior TEXT,           -- a ultima acao dele na rua anterior; NULL no flop
  acao TEXT NOT NULL,           -- Check, Bet, Call, Fold, Raise
  tamanho REAL,                 -- Bet: valor / pote; Raise: aumento / pote depois de pagar
  allin INTEGER NOT NULL,
  forca TEXT,                   -- categoria do H2N nesta rua (forca.py), se as cartas sao conhecidas
  draw TEXT,                    -- Flush draw, OESD, Gutshot, Combo draw (flop/turn)
  weak INTEGER,                 -- 1 = categoria "weak" do H2N; NULL sem cartas
  naipes_flop TEXT, flop_pareado INTEGER, flop_conectado INTEGER, flop_alta TEXT,
  board_pareado INTEGER,        -- board ate esta rua tem par
  board_flush INTEGER,          -- 3+ do mesmo naipe ate esta rua
  marcada INTEGER NOT NULL,     -- seguro/jackpot (D6)
  resposta TEXT,                -- so em Bet/Raise: 'todos foldam', 'pago', 'aumentado' (resto da rua)
  data TEXT,                    -- YYYY-MM-DD, do HAND ID (snowflake); NULL se o id nao tem esse formato
  linha_flop TEXT,              -- letras dele no flop (X B C R F), em decisoes do turn/river
  linha_turn TEXT,              -- idem no turn, em decisoes do river
  texturas TEXT,                -- tags nao exclusivas de turn/river: '|turn:overcard|river:brick|'
  lucro REAL,                   -- BB ganhos a partir desta decisao (net + ja investido); NULL em mao marcada
  sd INTEGER NOT NULL,          -- chegou ao showdown
  ganhou INTEGER,               -- terminou a mao com net > 0
  tam_flop REAL,                -- tamanho da ultima aposta/raise DELE no flop (fracao do pote), em decisoes do turn/river
  tam_turn REAL,                -- idem no turn, em decisoes do river
  enf_flop REAL,                -- tamanho da bet/raise que ELE PAGOU no flop (a ultima que pagou), em decisoes do turn/river
  enf_turn REAL,                -- idem no turn, em decisoes do river
  linha_atual TEXT NOT NULL,    -- o que ELE ja fez nesta rua antes desta decisao ('' = primeira vez; 'B' = apostou e
                                -- agora enfrenta raise -> forma BF/BC/BR; 'X' = checou e agora enfrenta bet -> XF/XC/XR)
  n_calls INTEGER,              -- so em Bet/Raise: quantos pagaram antes da proxima agressao
  prox_acao TEXT,               -- so em Bet/Raise que levou raise: o que ele fez depois (Fold, Call, Raise)
  risco REAL,                   -- Bet/Raise: o que ele poe agora / pote antes da acao (na bet = tamanho; no raise inclui
                                -- o call embutido): e o que um blefe arrisca para ganhar o pote; precisa = risco / (1 + risco)
  risco_enfrentado REAL,        -- o risco da ultima bet/raise que ele enfrenta (para o fold que um blefe contra ele precisa)
  PRIMARY KEY (hand_id, ordem)
);
CREATE INDEX decisoes_rua_sit ON decisoes (rua, situacao);
DROP TABLE IF EXISTS ruas;
CREATE TABLE ruas (             -- a historia da mao, uma linha por street jogada (o filtro "linha da mao" do Estudo)
  hand_id TEXT NOT NULL, rua TEXT NOT NULL,
  n_jogadores INTEGER NOT NULL, n_vivos INTEGER NOT NULL, data TEXT,
  acao INTEGER NOT NULL,        -- 1 = alguem apostou nesta street; 0 = todos deram check (fold sem bet nao conta)
  pos1 TEXT,                    -- quem fez a 1a bet
  tam1 REAL,                    -- 1a bet / pote
  allin1 INTEGER,
  mesmo_agressor INTEGER,       -- 1 = a 1a bet e de quem fez a ultima bet/raise da street anterior; NULL sem agressor antes
  aumento INTEGER,              -- 1 = alguem aumentou depois da 1a bet
  pos_raise TEXT,               -- quem deu o 1o raise
  raise_x REAL,                 -- 1o raise (total na street) / 1a bet: 3 = aumentou para 3x a bet
  n_raises INTEGER,
  fim TEXT,                     -- 'levou' = todos foldaram para o ultimo agressor; 'pago' = alguem pagou
  raise_risco REAL,             -- 1o raise: o que ele poe agora / pote antes dele (o que o blefe de raise arrisca)
  n_calls INTEGER,              -- quantos pagaram a ultima bet/raise da street (0 quando todos foldaram)
  reraise_x REAL,               -- 2o raise (total na street) / 1o raise (total): 3 = re-raise para 3x o raise
  reraise_risco REAL,           -- 2o raise: o que ele poe agora / pote antes dele
  PRIMARY KEY (hand_id, rua)
);
"""
COLUNAS_RUAS = 19


def carta(s: str):
    rank, naipe = s[:-1], s[-1:]
    return SimpleNamespace(rank=rank, suit=naipe) if rank in VALOR and naipe in "shdc" else None


def cartas(texto: str | None) -> list:
    cs = [carta(s) for s in (texto or "").split()]
    return cs if cs and all(cs) else []


def forcas_por_rua(hole: list, board: list) -> dict[str, tuple]:
    """rua -> (forca, draw, weak) do jogador; vazio se as cartas ou o board nao foram lidos."""
    saida: dict[str, tuple] = {}
    if len(hole) != 2 or len(board) < 3:
        return saida
    teve_draw = False
    for i, rua in enumerate(RUAS):
        if len(board) < 3 + i:
            break
        cat, draw = forca_h2n.classificar(hole, board[: 3 + i], teve_draw)
        teve_draw = teve_draw or draw is not None
        saida[rua] = (cat, draw, int(cat in forca_h2n.FRACAS))
    return saida


# HAND ID do WPT: os bits acima do 22 sao milissegundos desde esta origem (conferido em 5 prints, erro <= 1 s)
ORIGEM_ID = datetime(2016, 9, 25, 8, 28, 7, 268000)
_CORPO = re.sub(r"--.*", "", ESQUEMA.split("CREATE TABLE decisoes (")[1].split("PRIMARY KEY")[0])
COLUNAS = re.findall(r"(\w+) (?:TEXT|INTEGER|REAL)", _CORPO)
COL = {nome: i for i, nome in enumerate(COLUNAS)}  # nome da coluna -> posicao na linha de linhas_da_mao
COL_RESPOSTA = COL["resposta"]
LETRA = {"Check": "X", "Bet": "B", "Call": "C", "Raise": "R", "Fold": "F"}


def data_do_id(hid: str) -> str | None:
    try:
        quando = ORIGEM_ID + timedelta(milliseconds=int(hid) >> 22)
    except (ValueError, OverflowError):
        return None
    return quando.strftime("%Y-%m-%d") if 2020 <= quando.year <= 2040 else None


def _valores(cs: list) -> set[int]:
    vs = {VALOR[c.rank] for c in cs}
    return vs | {1} if 14 in vs else vs


def _janela_max(cs: list) -> int:
    """Quantos valores distintos do board cabem na melhor janela de 5 (para sequencia)."""
    vs = _valores(cs)
    return max(len(vs & set(range(b, b + 5))) for b in range(1, 11))


def tags_rua(board: list, i_rua: int) -> list[str]:
    """Texturas da carta que caiu no turn (i_rua 1) ou no river (2); nao exclusivas, como no H2N."""
    if len(board) < 3 + i_rua or i_rua == 0:
        return []
    nome = RUAS[i_rua]
    nova, antes = board[2 + i_rua], board[: 2 + i_rua]
    tags = []
    if VALOR[nova.rank] > max(VALOR[c.rank] for c in antes):
        tags.append("overcard")
    if nova.rank in {c.rank for c in antes}:
        tags.append("pareia")
    mesmo_naipe = sum(c.suit == nova.suit for c in antes) + 1
    if mesmo_naipe == 3:
        tags.append("3º do naipe")
    elif mesmo_naipe >= 4:
        tags.append("4º do naipe")
    if _janela_max(antes + [nova]) > _janela_max(antes) and _janela_max(antes + [nova]) >= 3:
        tags.append("4 p/ sequência" if _janela_max(antes + [nova]) >= 4 else "sequência possível")
    return [f"{nome}:{t}" for t in (tags or ["brick"])]


def textura_flop(flop: list) -> tuple:
    if len(flop) < 3:
        return None, None, None, None
    valores = sorted({VALOR[c.rank] for c in flop})
    naipes = {1: "monotone", 2: "two-tone", 3: "rainbow"}[len({c.suit for c in flop})]
    alta = max(VALOR[c.rank] for c in flop)
    alta = "A" if alta == 14 else "K" if alta == 13 else "Q" if alta == 12 else "J" if alta == 11 else "T-"
    # conectado: tres valores distintos dentro de uma janela de 5 (cabe uma sequencia)
    conectado = len(valores) == 3 and (valores[-1] - valores[0] <= 4 or {14, 2, 3, 4, 5} >= set(valores))
    return naipes, int(len(valores) < 3), int(conectado), alta


def linhas_da_mao(hid: str, n: int, ante: float, board: str, acoes: list, jog: dict,
                  marcada: bool) -> list[tuple]:
    """acoes: (rua, pos, verbo, valor, allin, pote_antes) em ordem. jog: pos -> dict."""
    todas = cartas(board)
    flop_tex = textura_flop(todas[:3])
    forcas = {p: forcas_por_rua(cartas(j["cartas"]), todas) for p, j in jog.items()}
    vivos = set(jog)
    investido_mao = {p: ante / n for p in jog}  # a entrada da bomb pot
    saida: list[list] = []
    gasto_antes: list[float] = []  # por linha: o que o jogador ja tinha posto antes da decisao
    data = data_do_id(hid)
    letras: dict[str, dict[str, str]] = {r: defaultdict(str) for r in RUAS}
    tamanhos: dict[str, dict[str, float]] = {r: {} for r in RUAS}  # rua -> jogador -> tamanho da agressao dele
    pagou: dict[str, dict[str, float]] = {r: {} for r in RUAS}  # rua -> jogador -> tamanho da bet que ele pagou
    tam_antes: list[tuple] = []  # por linha: (tam_flop, tam_turn, enf_flop, enf_turn) do jogador ate a rua da decisao
    atual_antes: list[str] = []  # por linha: as letras dele nesta rua antes da decisao
    riscos: list[tuple] = []  # por linha: (risco, risco_enfrentado)
    resposta_extra: dict[int, tuple] = {}  # linha de bet/raise -> (n_calls, prox_acao)
    tags = ["|".join(tags_rua(todas, 1)), "|".join(tags_rua(todas, 1) + tags_rua(todas, 2))]
    agressor_anterior = None
    rua_anterior_checada = None
    ultima_acao: dict[str, str] = {}
    for i_rua, rua in enumerate(RUAS):
        acts = [a for a in acoes if a[0] == rua]
        if not acts:
            break
        board_rua = todas[: 3 + i_rua]
        ordem_vivos = sorted(vivos, key=lambda p: jog[p]["ordem"] or 99)
        pote_inicio = acts[0][5] or 0
        acao_anterior = dict(ultima_acao) if i_rua else {}
        investido: dict[str, float] = defaultdict(float)
        maior = 0.0
        ultima_agressao = None  # fracao do pote da ultima bet/raise
        ultimo_risco = None     # e o risco dela (o que o agressor pos / pote antes dele)
        raises = 0
        agressor = None
        checou: set[str] = set()
        vezes: dict[str, int] = defaultdict(int)
        n_vivos = len(vivos)
        da_rua: list[tuple[int, str, str]] = []  # (linha, verbo, jogador) desta rua, para a resposta
        for _, p, verbo, valor, allin, pote in acts:
            j = jog.get(p)
            if j is None or verbo not in ACOES:  # Insurance/Show Card nao sao decisao de poker
                continue
            if verbo == "Raise" and maior == 0:  # o WPT escreve a aposta all-in como "Raise"
                verbo = "Bet"
            if verbo == "Call" and maior == 0 and not valor:  # "Call $0.00" sem aposta na mesa e check
                verbo = "Check"                              # (ID_1318375308628545536, turn e river)
            por_menos = verbo == "Raise" and (valor or 0) <= maior  # all-in menor que a bet: e call, mas vem "Raise"
            if por_menos:
                verbo = "Call"
            vezes[p] += 1
            situacao = "livre" if maior == 0 else "enfrenta aposta" if raises == 0 else "enfrenta raise"
            spr = None
            if not marcada and j["stack"] and pote_inicio:
                resto = {q: (jog[q]["stack"] or 0) - investido_mao[q] for q in vivos}
                outros = [v for q, v in resto.items() if q != p]
                spr = round(min(resto[p], max(outros)) / pote_inicio, 2) if outros else None
            tamanho = None
            if verbo == "Bet" and pote:
                tamanho = round((valor or 0) / pote, 3)
            elif verbo == "Raise" and pote:
                pagar = maior - investido[p]
                tamanho = round(((valor or 0) - maior) / (pote + pagar), 3)
            risco = tamanho if verbo == "Bet" else \
                round(((valor or 0) - investido[p]) / pote, 3) if verbo == "Raise" and pote else None
            riscos.append((risco, ultimo_risco if situacao != "livre" else None))
            da_rua.append((len(saida), verbo, p))
            atual_antes.append(letras[rua].get(p, ""))
            gasto_antes.append(investido_mao[p] + investido[p])
            saida.append([
                hid, rua, len(saida), p,
                "1º a agir" if p == ordem_vivos[0] else "último" if p == ordem_vivos[-1] else "meio",
                ordem_vivos.index(p) + 1,
                int(p == ordem_vivos[-1]), j["hero"], n, n_vivos, round(pote or 0, 2), spr,
                situacao, ultima_agressao if situacao != "livre" else None,
                vezes[p], int(p in checou), int(p == agressor_anterior),
                rua_anterior_checada, acao_anterior.get(p), verbo, tamanho, int(bool(allin)),
                *forcas[p].get(rua, (None, None, None)),
                *flop_tex,
                int(len({c.rank for c in board_rua}) < len(board_rua)),
                int(max((sum(c.suit == s for c in board_rua) for s in "shdc"), default=0) >= 3),
                int(marcada),
                None, data,
                letras["flop"].get(p) if i_rua >= 1 else None,
                letras["turn"].get(p) if i_rua >= 2 else None,
                f"|{tags[i_rua - 1]}|" if i_rua else None,
            ])
            letras[rua][p] += LETRA[verbo]
            tam_antes.append((tamanhos["flop"].get(p) if i_rua >= 1 else None,
                              tamanhos["turn"].get(p) if i_rua >= 2 else None,
                              pagou["flop"].get(p) if i_rua >= 1 else None,
                              pagou["turn"].get(p) if i_rua >= 2 else None))
            if verbo in ("Bet", "Raise") and tamanho is not None:
                tamanhos[rua][p] = tamanho
            if verbo == "Call" and ultima_agressao is not None:
                pagou[rua][p] = ultima_agressao
            # estado depois da acao
            if verbo == "Bet":
                investido[p] = valor or 0
                maior, ultima_agressao, ultimo_risco, agressor = investido[p], tamanho, risco, p
            elif verbo == "Raise":
                investido[p] = valor or 0
                maior, ultima_agressao, ultimo_risco, agressor = investido[p], tamanho, risco, p
                raises += 1
            elif verbo == "Call":
                # no call normal o valor e o complemento; no call all-in (e no all-in por menos, o "Raise" do WPT)
                # e o total dele na rua: conferido pelo saldo em todas as maos que decidem (ID_1312645872378032128)
                investido[p] = max(investido[p], valor or 0) if por_menos or allin else investido[p] + (valor or 0)
            elif verbo == "Check":
                checou.add(p)
            elif verbo == "Fold":
                vivos.discard(p)
            ultima_acao[p] = verbo
        for k, (linha, verbo, quem) in enumerate(da_rua):
            if verbo in ("Bet", "Raise"):
                seguintes = da_rua[k + 1:]
                depois = [v for _, v, _ in seguintes]
                ate = next((i for i, v in enumerate(depois) if v in ("Bet", "Raise")), len(depois))
                resto = depois[:ate + 1] if ate < len(depois) else depois
                saida[linha][COL_RESPOSTA] = ("aumentado" if "Raise" in resto else "pago" if "Call" in resto
                                    else "todos foldam" if resto else None)
                # depois de levar raise, a proxima acao DELE nesta rua (BF/BC/BR)
                prox = next((v for _, v, q in seguintes[ate + 1:] if q == quem), None) if ate < len(depois) else None
                resposta_extra[linha] = (resto.count("Call"), prox)
        for p, v in investido.items():
            investido_mao[p] += v
        agressor_anterior = agressor if agressor in vivos else None
        rua_anterior_checada = int(maior == 0)
    showdown = len(vivos) >= 2
    for i, (linha, gasto, antes) in enumerate(zip(saida, gasto_antes, tam_antes)):
        net = jog[linha[3]].get("net")
        linha.append(None if marcada or net is None else round(net + gasto, 2))
        linha.append(int(showdown and linha[3] in vivos))
        linha.append(None if marcada or net is None else int(net > 0))  # o saldo da mao marcada traz seguro/jackpot
        linha.extend(antes)
        linha.append(atual_antes[i])
        linha.extend(resposta_extra.get(i, (None, None)))
        linha.extend(riscos[i])
    return [tuple(linha) for linha in saida]


def ruas_da_mao(hid: str, n: int, acoes: list, jog: dict) -> list[tuple]:
    """Uma linha por street jogada: a 1a bet (quem, tamanho), o raise que veio depois (em vezes a 1a bet) e como a
    street terminou. Mesmos quirks do WPT que `linhas_da_mao`: "Raise" sem aposta = Bet; "Call 0" sem aposta = check;
    "Raise" all-in por menos que a bet = call."""
    vivos, data, saida, agressor_antes = set(jog), data_do_id(hid), [], None
    for rua in RUAS:
        acts = [a for a in acoes if a[0] == rua and a[1] in jog and a[2] in ACOES]
        if not acts:
            break
        n_vivos, maior, pos1, tam1, allin1, bet1 = len(vivos), 0.0, None, None, None, None
        n_raises, pos_raise, raise_x, raise_risco, agressor, calls = 0, None, None, None, None, 0
        raise1, reraise_x, reraise_risco = None, None, None
        investido: dict[str, float] = defaultdict(float)
        for _, p, verbo, valor, allin, pote in acts:
            if verbo == "Raise" and maior == 0:
                verbo = "Bet"
            if verbo == "Call" and maior == 0 and not valor:
                verbo = "Check"
            if verbo == "Raise" and (valor or 0) <= maior:
                verbo = "Call"
            if verbo == "Bet":
                pos1, bet1, allin1 = p, valor or 0, allin
                tam1 = round(bet1 / pote, 3) if pote else None
            elif verbo == "Raise":
                n_raises += 1
                if n_raises == 1:
                    pos_raise, raise_x = p, round((valor or 0) / bet1, 2) if bet1 else None
                    raise_risco = round(((valor or 0) - investido[p]) / pote, 3) if pote else None
                    raise1 = valor or 0
                elif n_raises == 2:
                    reraise_x = round((valor or 0) / raise1, 2) if raise1 else None
                    reraise_risco = round(((valor or 0) - investido[p]) / pote, 3) if pote else None
            if verbo in ("Bet", "Raise"):
                maior, agressor, calls = valor or 0, p, 0
                investido[p] = maior
            elif verbo == "Call":
                investido[p] = maior
                calls += 1
            elif verbo == "Fold":
                vivos.discard(p)
        fim = None if pos1 is None else "levou" if len(vivos) == 1 else "pago"
        mesmo = None if pos1 is None or agressor_antes is None else int(pos1 == agressor_antes)
        saida.append((hid, rua, n, n_vivos, data, int(pos1 is not None), pos1, tam1, allin1, mesmo,
                      None if pos1 is None else int(n_raises > 0), pos_raise, raise_x, n_raises if pos1 else None, fim,
                      raise_risco, calls if pos1 else None, reraise_x, reraise_risco))
        agressor_antes = agressor
        if len(vivos) < 2:
            break
    return saida


# mao em que o dono achou erro conferindo o print fica fora do estudo (mao errada e pior que mao ausente)
SEM_ERRO = " WHERE id NOT IN (SELECT hand_id FROM conferencias WHERE ok = 0)"


def reconstruir(con: sqlite3.Connection) -> int:
    acoes = defaultdict(list)
    for hid, *resto in con.execute(
            "SELECT hand_id, rua, pos, verbo, valor, allin, pote_antes FROM acoes ORDER BY hand_id, ordem"):
        acoes[hid].append(tuple(resto))
    jog = defaultdict(dict)
    for hid, pos, stack, net, cs, hero, ordem in con.execute(
            "SELECT hand_id, pos, stack, net, cartas, hero, ordem_flop FROM jogadores"):
        jog[hid][pos] = {"stack": stack, "net": net, "cartas": cs, "hero": hero, "ordem": ordem}
    linhas, ruas = [], []
    for hid, n, ante, board, obs in con.execute(f"SELECT id, n_jogadores, ante_bb, board, obs FROM hands{SEM_ERRO}"):
        linhas += linhas_da_mao(hid, n, ante or 0, board or "", acoes[hid], jog[hid], bool(obs))
        ruas += ruas_da_mao(hid, n, acoes[hid], jog[hid])
    with con:
        con.executescript(ESQUEMA)
        con.executemany(f"INSERT INTO decisoes VALUES ({','.join('?' * len(COLUNAS))})", linhas)
        con.executemany(f"INSERT INTO ruas VALUES ({','.join('?' * COLUNAS_RUAS)})", ruas)
    return len(linhas)


if __name__ == "__main__":
    con = tracker.abrir()
    print(f"{reconstruir(con)} decisoes em {RAIZ / 'bombpot.db'}")
    sys.exit(0)
