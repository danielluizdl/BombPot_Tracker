"""O site do tracker: filtros livres sobre a tabela `decisoes`, no formato de relatorio do SnapMDA.

    python servidor.py [porta]     reconstroi `decisoes`, sobe em 127.0.0.1 e abre o navegador

So escuta em 127.0.0.1: o banco e os prints nao saem da maquina.
Hero e populacao entram juntos em tudo (pedido do usuario em 2026-10-21); o filtro `hero` continua
existindo para quando a separacao voltar.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import auditar
import decisoes
import resultados
import tracker

RAIZ = Path(__file__).resolve().parent
PUBLIC = RAIZ / "public"

# As faixas de tamanho, em fracao do pote, com o nome curto (B50 = "bet de meio pote", como o usuario fala).
# Cada uma inclui o limite de cima (1,00 cai em 0,86-1,00). O valor do filtro e o rotulo longo.
FAIXAS = [(0.05, "0,01–0,05", "B5"), (0.15, "0,06–0,15", "B10"), (0.33, "0,16–0,33", "B25"), (0.45, "0,34–0,45", "B40"),
          (0.66, "0,46–0,66", "B50"), (0.85, "0,67–0,85", "B75"), (1.00, "0,86–1,00", "B100"),
          (1.20, "1,01–1,20", "B110"), (1.50, "1,21–1,50", "B135"), (2.00, "1,51–2,00", "B175"),
          (None, "2,00+", "B200+")]
# Tamanho vazio (nao apostou / nao pagou) fica sem faixa: sem o primeiro WHEN ele caia no ELSE e virava "2,00+".
def _case(faixas) -> str:
    return "CASE WHEN {col} IS NULL THEN NULL " + " ".join(f"WHEN {{col}} <= {teto} THEN '{nome}'" for teto, nome, _ in faixas if teto) \
        + f" ELSE '{faixas[-1][1]}' END"


CASE_FAIXA = _case(FAIXAS)
# As faixas da aba Bet Sizes do H2N (docs/H2N_TELAS.md do MetaLens), usadas na aba MDA. Os rotulos nao se repetem
# com os de FAIXAS: e pelo rotulo que o filtro sabe qual das duas listas usar.
FAIXAS_H2N = [(0.20, "0,00–0,20", "B10"), (0.40, "0,21–0,40", "B30"), (0.60, "0,41–0,60", "B50"),
              (0.80, "0,61–0,80", "B70"), (1.05, "0,81–1,05", "B100"), (1.30, "1,06–1,30", "B120"),
              (1.70, "1,31–1,70", "B150"), (2.40, "1,71–2,40", "B210"), (3.50, "2,41–3,50", "B280"),
              (None, "3,50+", "B400+")]
CASE_H2N = _case(FAIXAS_H2N)
NOMES_H2N = {nome for _, nome, _ in FAIXAS_H2N}
EV_BLEFE = "CASE WHEN resposta = 'todos foldam' THEN 1.0 ELSE -tamanho END"

# coluna -> tipo do filtro. 'lista' = IN (...), 'faixa' = min/max (ou lista de valores), 'faixas' = faixas
# de tamanho acima, 'tags' = contem qualquer uma das tags (texturas nao exclusivas), 'datas' = periodo.
FILTROS = {
    "hero": "lista", "pos": "lista", "pos_rel": "lista", "ip": "lista", "rua": "lista",
    "situacao": "lista", "decisao_n": "lista", "checou_antes": "lista", "agressor_anterior": "lista",
    "rua_anterior_checada": "lista", "acao_anterior": "lista", "acao": "lista", "allin": "lista",
    "forca": "lista", "draw": "lista", "weak": "lista", "naipes_flop": "lista", "flop_pareado": "lista",
    "flop_conectado": "lista", "flop_alta": "lista", "board_pareado": "lista", "board_flush": "lista",
    "marcada": "lista", "n_jogadores": "faixa", "n_vivos": "faixa", "pote": "faixa", "spr": "faixa",
    "tamanho": "faixas", "tamanho_enfrentado": "faixas",
    "resposta": "lista", "linha_flop": "lista", "linha_turn": "lista", "sd": "lista", "ganhou": "lista",
    "texturas": "tags", "data": "datas", "tam_flop": "faixas", "tam_turn": "faixas", "enf_flop": "faixas", "enf_turn": "faixas",
}
DATA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def expressao(col: str) -> str | None:
    """A coluna como chave de agrupamento (so as da lista branca; faixas viram o nome da faixa)."""
    tipo = FILTROS.get(col)
    if tipo == "lista":
        return col
    if tipo == "faixas":
        return CASE_FAIXA.format(col=col)
    if tipo == "faixa" and col == "n_jogadores":
        return col
    return None


def where(filtros: dict) -> tuple[str, list]:
    """Filtros do site -> WHERE parametrizado. Coluna fora da lista branca e ignorada."""
    partes, params = [], []
    for col, valor in filtros.items():
        tipo = FILTROS.get(col)
        if tipo == "lista" and isinstance(valor, list) and valor:
            partes.append(f"{col} IN ({','.join('?' * len(valor))})")
            params += valor
        elif tipo == "faixa" and isinstance(valor, list) and valor:  # valores soltos: mesas com 8, 7, 6 e 5
            partes.append(f"{col} IN ({','.join('?' * len(valor))})")
            params += [float(v) for v in valor]
        elif tipo in ("faixa", "faixas") and isinstance(valor, dict):  # faixas: a faixa livre da barrinha
            if valor.get("min") not in (None, ""):
                partes.append(f"{col} >= ?")
                params.append(float(valor["min"]))
            if valor.get("max") not in (None, ""):
                partes.append(f"{col} <= ?")
                params.append(float(valor["max"]))
        elif tipo == "faixas" and isinstance(valor, list) and valor:
            case = CASE_H2N if set(valor) <= NOMES_H2N else CASE_FAIXA
            partes.append(f"{case.format(col=col)} IN ({','.join('?' * len(valor))})")
            params += valor
        elif tipo == "tags" and isinstance(valor, list) and valor:
            partes.append("(" + " OR ".join(f"instr({col}, ?) > 0" for _ in valor) + ")")
            params += [f"|{v}|" for v in valor]
        elif tipo == "datas" and isinstance(valor, dict):
            for lado, op in (("min", ">="), ("max", "<=")):
                if DATA_RE.match(str(valor.get(lado) or "")):
                    partes.append(f"{col} {op} ?")
                    params.append(valor[lado])
    return (" WHERE " + " AND ".join(partes)) if partes else "", params


def _e(w: str) -> str:
    return " AND " if w else " WHERE "


def contagem(con, w: str, p: list, expr: str, extra: str = "") -> dict:
    """{valor: n} agrupando pela expressao."""
    return {chave: n for chave, n in con.execute(
        f"SELECT {expr}, count(*) FROM decisoes{w}{extra} GROUP BY 1", p) if chave is not None}


def metricas(con, w: str, p: list, expr: str) -> dict[str, dict]:
    """As colunas do relatorio para cada valor de `expr` (uma linha da grade por valor).

    n/maos: amostra · acoes: frequencia de cada acao · bets: quantas bets em cada faixa de tamanho ·
    weak: [fracas, com cartas conhecidas] · resposta: o que a mesa fez depois das bets (e o EV do blefe) ·
    wsd: [ganhou no showdown, foi ao showdown] (sem as maos marcadas)."""
    linhas: dict[str, dict] = {}

    def linha(chave) -> dict:
        return linhas.setdefault(str(chave), {"chave": str(chave), "n": 0, "maos": 0, "acoes": {}, "bets": {},
                                              "weak": [0, 0], "wsd": [0, 0], "defesa": [0, 0, 0.0],
                                              "resposta": {"todos foldam": 0, "pago": 0, "aumentado": 0,
                                                           "ev": 0.0, "tam": 0.0}})

    for chave, n, maos in con.execute(f"SELECT {expr}, count(*), count(DISTINCT hand_id) FROM decisoes{w} GROUP BY 1", p):
        if chave is not None:
            linha(chave).update(n=n, maos=maos)
    for chave, acao, n in con.execute(f"SELECT {expr}, acao, count(*) FROM decisoes{w} GROUP BY 1, 2", p):
        if chave is not None:
            linha(chave)["acoes"][acao] = n
    for chave, faixa, n in con.execute(
            f"SELECT {expr}, {CASE_FAIXA.format(col='tamanho')}, count(*) FROM decisoes{w}{_e(w)}acao = 'Bet' "
            "AND tamanho IS NOT NULL GROUP BY 1, 2", p):
        if chave is not None:
            linha(chave)["bets"][faixa] = n
    for chave, fracas, conhecidas in con.execute(f"SELECT {expr}, sum(weak), count(weak) FROM decisoes{w} GROUP BY 1", p):
        if chave is not None:
            linha(chave)["weak"] = [fracas or 0, conhecidas]
    for chave, resp, n, ev, tam in con.execute(
            f"SELECT {expr}, resposta, count(*), sum({EV_BLEFE}), sum(tamanho) FROM decisoes{w}{_e(w)}acao = 'Bet' "
            "AND resposta IS NOT NULL AND tamanho IS NOT NULL GROUP BY 1, 2", p):
        if chave is not None:
            r = linha(chave)["resposta"]
            r[resp] = n
            r["ev"] += ev
            r["tam"] += tam
    # Lado de quem enfrenta bet/raise: quantas vezes foldou e quanto "precisava" foldar (soma de t/(1+t) de cada
    # decisao, t = tamanho enfrentado). Fold acima do precisa = overfold: um blefe contra ele da lucro.
    for chave, n, folds, precisa in con.execute(
            f"SELECT {expr}, count(*), sum(CASE WHEN acao = 'Fold' THEN 1 ELSE 0 END), "
            f"sum(tamanho_enfrentado / (1 + tamanho_enfrentado)) FROM decisoes{w}{_e(w)}situacao != 'livre' "
            "AND tamanho_enfrentado IS NOT NULL GROUP BY 1", p):
        if chave is not None:
            linha(chave)["defesa"] = [n, folds, precisa]
    for chave, ganhou, foi in con.execute(
            f"SELECT {expr}, sum(CASE WHEN ganhou = 1 THEN 1 ELSE 0 END), count(*) FROM decisoes{w}{_e(w)}"
            "sd = 1 AND marcada = 0 GROUP BY 1", p):
        if chave is not None:
            linha(chave)["wsd"] = [ganhou, foi]
    return linhas


def grafico(con, w: str, p: list) -> dict[str, dict]:
    """Por faixa de tamanho da bet: quantas vezes foi usada e como a mesa respondeu (o grafico tamanho x fold)."""
    saida: dict[str, dict] = {}
    for faixa, resp, n, ev, tam in con.execute(
            f"SELECT {CASE_FAIXA.format(col='tamanho')}, resposta, count(*), sum({EV_BLEFE}), sum(tamanho) "
            f"FROM decisoes{w}{_e(w)}acao = 'Bet' AND tamanho IS NOT NULL GROUP BY 1, 2", p):
        f = saida.setdefault(faixa, {"usos": 0, "todos foldam": 0, "pago": 0, "aumentado": 0, "ev": 0.0, "tam": 0.0})
        f["usos"] += n
        if resp:
            f[resp] = n
            f["ev"] += ev
            f["tam"] += tam
    return saida


def defesa(con, w: str, p: list) -> dict[str, dict]:
    """Lado de quem ENFRENTA bet/raise, por faixa do tamanho enfrentado: fold/call/raise e quanto precisaria foldar
    (soma de t/(1+t)). E o espelho do grafico(): la a resposta da mesa a quem aposta, aqui a decisao de quem defende."""
    saida: dict[str, dict] = {}
    for faixa, acao, n, precisa in con.execute(
            f"SELECT {CASE_FAIXA.format(col='tamanho_enfrentado')}, acao, count(*), "
            f"sum(tamanho_enfrentado / (1 + tamanho_enfrentado)) FROM decisoes{w}{_e(w)}situacao != 'livre' "
            "AND tamanho_enfrentado IS NOT NULL GROUP BY 1, 2", p):
        f = saida.setdefault(faixa, {"n": 0, "Fold": 0, "Call": 0, "Raise": 0, "precisa": 0.0})
        f["n"] += n
        f["precisa"] += precisa
        if acao in f:
            f[acao] += n
    return saida


def consultar(con: sqlite3.Connection, filtros: dict) -> dict:
    w, p = where(filtros)
    geral = metricas(con, w, p, "'Geral'").get("Geral")
    expr = expressao(filtros["_agrupar"]) if isinstance(filtros.get("_agrupar"), str) else None
    grupos = list(metricas(con, w, p, expr).values()) if expr else []
    return {
        "geral": geral,
        "agrupar": filtros.get("_agrupar") if expr else None,
        "grupos": grupos,
        "grafico": grafico(con, w, p),
        "defesa": defesa(con, w, p),
        "forca": contagem(con, w, p, "forca"),
        "draw": contagem(con, w, p, "draw"),
        "mesa": mesa(con, filtros),
    }


# --- Ver mãos: a lista do filtro (uma decisão por linha, como a lista de mãos do H2N) e o replayer -------------------
MAX_TODAS = 1000  # "ver todas" para aqui: mais que isso o filtro está largo demais para ler mão a mão


def where_mda(corpo: dict) -> tuple[str, list]:
    """O WHERE de um nó da árvore da MDA (a linha clicada), com os filtros de fora e o caminho afunilado; faixa
    (opcional) = a linha de tamanho da tabela embaixo dos boxes ('B50', 'B50|AI' com o all-in separado)."""
    rua = str(corpo.get("rua")) if corpo.get("rua") in ("flop", "turn", "river") else "flop"
    externos = {k: v for k, v in (corpo.get("filtros") or {}).items() if k not in DA_ARVORE}
    prefixo = [str(x) for x in corpo.get("prefixo") or []]
    f = {**externos, **_caminho(corpo.get("caminho") or {}, rua), "rua": [rua], "acao": [str(corpo.get("acao", ""))]}
    for i, r in enumerate(("flop", "turn")[:len(prefixo)]):
        f[f"linha_{r}"] = [prefixo[i]]
    w, p = where(f)
    extra = [f"linha_atual = ?", f"{SITU} = ?"]
    p += [str(corpo.get("atual", "")), "livre" if corpo.get("situ") == "livre" else "enfrenta"]
    faixa = str(corpo.get("faixa") or "")
    if faixa:
        nome, _, ai = faixa.partition("|")
        col = "tamanho" if corpo.get("acao") in ("Bet", "Raise") else "tamanho_enfrentado"
        extra.append(f"{CASE_H2N.format(col=col)} = ?")
        p.append(nome)
        if col == "tamanho" and corpo.get("separar_ai"):
            extra.append("allin = ?")
            p.append(1 if ai else 0)
    return w + _e(w) + " AND ".join(extra), p


def maos(con: sqlite3.Connection, corpo: dict) -> dict:
    """As mãos do filtro do Estudo (corpo.filtros) ou de um nó da MDA (corpo.mda), da mais nova para a mais velha:
    uma linha por decisão, com a linha da mão por rua (linhas_de_mao) e quem decidiu. offset/limite paginam;
    limite 0 = todas (até MAX_TODAS)."""
    w, p = where_mda({**corpo["mda"], "filtros": corpo.get("filtros")}) if isinstance(corpo.get("mda"), dict) \
        else where(corpo.get("filtros") or {})
    total = con.execute(f"SELECT count(*) FROM decisoes{w}", p).fetchone()[0]
    limite = int(corpo.get("limite") or 0) or MAX_TODAS
    offset = max(int(corpo.get("offset") or 0), 0)
    cols = ("hand_id", "ordem", "png", "data", "rua", "pos", "nome", "hero", "acao", "tamanho", "allin", "cartas", "lucro",
            "n_jogadores")
    linhas: list[dict] = [dict(zip(cols, r)) for r in con.execute(
        "SELECT d.hand_id, d.ordem, h.png, d.data, d.rua, d.pos, j.nome, d.hero, d.acao, d.tamanho, d.allin, j.cartas, "
        f"d.lucro, d.n_jogadores FROM (SELECT * FROM decisoes{w}) d JOIN hands h ON h.id = d.hand_id "
        "JOIN jogadores j ON j.hand_id = d.hand_id AND j.pos = d.pos "
        "ORDER BY CAST(d.hand_id AS INTEGER) DESC, d.ordem LIMIT ? OFFSET ?", p + [min(limite, MAX_TODAS), offset])]
    por_mao = linhas_de_mao(con, {m["hand_id"] for m in linhas})
    for m in linhas:
        m["linha"] = por_mao.get(m["hand_id"], [])
    return {"total": total, "offset": offset, "maos": linhas, "max_todas": MAX_TODAS}


NOME_RUA_REPLAY = {"flop": "FLOP", "turn": "TURN", "river": "RIVER"}


def quadros(n: int, ante: float, board: str, acoes: list, jog: dict) -> list[dict]:
    """Cada estado da mesa, do flop ao showdown (o replayer). Valores em BB. acoes: (rua, pos, verbo, valor, allin) na
    ordem; jog: pos -> {stack (inicial), cartas, nome, seat, hero, net}. Normaliza os quirks do WPT como `decisoes`:
    "Raise" sem aposta = Bet; "Raise" all-in por menos e call all-in vêm com o total na rua; "Call 0" sem aposta = check.
    ponytail: a bet que ninguém paga continua no pote até o showdown; o resultado de cada um sai do saldo da mão."""
    cartas = board.split()
    entrada = ante / n if n else 0.0
    assentos = {p: {"pos": p, "nome": j.get("nome") or p, "seat": j.get("seat"), "hero": j.get("hero"),
                    "stack": round((j.get("stack") or 0) - entrada, 2), "aposta": 0.0, "foldou": False,
                    "cartas": j.get("cartas")} for p, j in jog.items()}
    pote, rua, saida = round(ante, 2), None, []

    def foto(texto, ator=None, odds=None, mostra=False, mostrar_board=None):
        vis = cartas[:{"flop": 3, "turn": 4, "river": 5}.get(mostrar_board or rua or "", 0)]
        saida.append({"rua": rua, "board": vis, "pote": round(pote, 2), "ator": ator, "texto": texto, "odds": odds,
                      "assentos": [{**s, "cartas": s["cartas"] if (s["hero"] or mostra) else None,
                                    "aposta": round(s["aposta"], 2), "stack": round(s["stack"], 2)}
                                   for s in assentos.values()]})

    maior = 0.0
    for r, p, verbo, valor, allin in acoes:
        if r != rua:
            rua, maior = r, 0.0
            for s in assentos.values():
                s["aposta"] = 0.0
            foto(NOME_RUA_REPLAY.get(r, r.upper()))
        s = assentos.get(p)
        if s is None:
            continue
        if verbo not in ("Check", "Bet", "Call", "Raise", "Fold"):  # Insurance, Show Card: aparece, não mexe em ficha
            foto(verbo, ator=p)
            continue
        valor = valor or 0.0
        if verbo == "Raise" and maior == 0:
            verbo = "Bet"
        por_menos = verbo == "Raise" and valor <= maior
        if por_menos:
            verbo = "Call"
        if verbo == "Call" and maior == 0 and not valor:
            verbo = "Check"
        devendo = maior - s["aposta"]
        odds = round(100 * devendo / (pote + devendo), 1) if devendo > 0 and verbo in ("Call", "Fold", "Raise") else None
        if verbo in ("Bet", "Raise"):
            poe, s["aposta"], maior = valor - s["aposta"], valor, valor
        elif verbo == "Call":
            novo = max(s["aposta"], valor) if (por_menos or allin) else s["aposta"] + valor
            poe, s["aposta"] = novo - s["aposta"], novo
        else:
            poe = 0.0
        s["stack"] -= poe
        pote += poe
        if verbo == "Fold":
            s["foldou"] = True
        quanto = "" if verbo in ("Check", "Fold") else f" {s['aposta']:g}"
        foto(f"{verbo.upper()}{quanto}{' (all-in)' if allin else ''}", ator=p, odds=odds)
    ordem = ["flop", "turn", "river"]
    if rua in ordem:  # all-in antes do river: o board corre sem ação
        for r in ordem[ordem.index(rua) + 1:len(cartas) - 2]:
            rua = r
            for s in assentos.values():
                s["aposta"] = 0.0
            foto(NOME_RUA_REPLAY[r])
    vivos = [s for s in assentos.values() if not s["foldou"]]
    for s in assentos.values():
        s["aposta"] = 0.0
    foto("SHOWDOWN" if len(vivos) > 1 else "FIM", mostra=len(vivos) > 1)
    saida[-1]["resultado"] = {p: j.get("net") for p, j in jog.items()}
    return saida


def mao(con: sqlite3.Connection, corpo: dict) -> dict:
    """Uma mão para o replayer: cabeçalho, os quadros e o print."""
    hid = str(corpo.get("hand_id", ""))
    linha = con.execute("SELECT id, png, n_jogadores, ante_bb, board, unidade, obs FROM hands WHERE id = ?", (hid,)).fetchone()
    if not linha:
        raise ValueError("mão desconhecida")
    _, png, n, ante, board, unidade, obs = linha
    acoes = con.execute("SELECT rua, pos, verbo, valor, allin FROM acoes WHERE hand_id = ? ORDER BY ordem", (hid,)).fetchall()
    jog = {pos: {"seat": seat, "stack": stack, "net": net, "cartas": cs, "hero": hero, "nome": nome}
           for pos, seat, stack, net, cs, hero, nome in con.execute(
               "SELECT pos, seat, stack, net, cartas, hero, nome FROM jogadores WHERE hand_id = ?", (hid,))}
    return {"hand_id": hid, "png": png, "data": decisoes.data_do_id(hid), "unidade": unidade, "obs": obs,
            "quadros": quadros(n, ante or 0.0, board or "", acoes, jog)}


LETRA = {"Check": "X", "Bet": "B", "Call": "C", "Raise": "R", "Fold": "F"}


def linhas_de_mao(con, ids: set[str]) -> dict[str, list]:
    """A mao em uma linha por rua, como a lista de maos do H2N: [(rua, board, pote, [(pos, 'B21.5'), ...])].

    Valores em BB; o apostrofo marca all-in (B92'), como no H2N."""
    if not ids:
        return {}
    marcas = ",".join("?" * len(ids))
    boards = dict(con.execute(f"SELECT id, board FROM hands WHERE id IN ({marcas})", list(ids)))
    saida: dict[str, list] = {}
    corte = {"flop": slice(0, 3), "turn": slice(3, 4), "river": slice(4, 5)}
    apostou, maior = False, 0.0
    for hid, rua, pos, verbo, valor, allin, pote in con.execute(
            f"SELECT hand_id, rua, pos, verbo, valor, allin, pote_antes FROM acoes "
            f"WHERE hand_id IN ({marcas}) ORDER BY hand_id, ordem", list(ids)):
        if verbo not in LETRA:
            continue
        ruas = saida.setdefault(hid, [])
        if not ruas or ruas[-1][0] != rua:
            ruas.append((rua, " ".join((boards.get(hid) or "").split()[corte[rua]]), pote, []))
            apostou, maior = False, 0.0
        if verbo == "Raise" and not apostou:  # o WPT escreve a aposta all-in como "Raise"
            verbo = "Bet"
        elif verbo == "Raise" and (valor or 0) <= maior:  # all-in menor que a bet: e um call
            verbo = "Call"
        elif verbo == "Call" and not apostou and not valor:  # "Call $0.00" sem aposta na mesa: check
            verbo, valor = "Check", None
        apostou = apostou or verbo in ("Bet", "Raise")
        if verbo in ("Bet", "Raise"):
            maior = valor or 0
        quanto = "" if valor is None else f"{valor:g}"
        ruas[-1][3].append((pos, f"{LETRA[verbo]}{quanto}{chr(39) if allin else ''}"))
    return saida


def mesa(con, filtros: dict) -> dict:
    """O que a mesa desenha: maos por numero de jogadores e acoes por posicao.

    Cada parte ignora o proprio filtro (a contagem por jogadores ignora n_jogadores; os assentos
    ignoram pos), senao escolher 8 jogadores apagaria os outros botoes e escolher o BTN apagaria
    os outros assentos."""
    w, p = where({k: v for k, v in filtros.items() if k != "n_jogadores"})
    por_n = {str(n): m for n, m in con.execute(
        f"SELECT n_jogadores, count(DISTINCT hand_id) FROM decisoes{w} GROUP BY 1", p)}
    w, p = where({k: v for k, v in filtros.items() if k != "pos"})
    por_pos: dict = {}
    for pos, acao, n in con.execute(f"SELECT pos, acao, count(*) FROM decisoes{w} GROUP BY 1, 2", p):
        por_pos.setdefault(pos, {})[acao] = n
    return {"por_n": por_n, "por_pos": por_pos}


GRANDE = ["0,67–0,85", "0,86–1,00", "1,01–1,20", "1,21–1,50", "1,51–2,00", "2,00+"]
# Painel de tendencias (o perfil do H2N): (secao, nome, base, numerador). base e numerador sao filtros do site.
PAINEL = [
    ("Flop", "Aposta quando checaram até ele", {"rua": ["flop"], "situacao": ["livre"], "decisao_n": [1]}, {"acao": ["Bet"]}),
    ("Flop", "Lead do 1º a agir", {"rua": ["flop"], "situacao": ["livre"], "pos_rel": ["1º a agir"]}, {"acao": ["Bet"]}),
    ("Flop", "Aposta do último (todos checaram)", {"rua": ["flop"], "situacao": ["livre"], "ip": [1]}, {"acao": ["Bet"]}),
    ("Flop", "Fold contra aposta", {"rua": ["flop"], "situacao": ["enfrenta aposta"]}, {"acao": ["Fold"]}),
    ("Flop", "Call contra aposta", {"rua": ["flop"], "situacao": ["enfrenta aposta"]}, {"acao": ["Call"]}),
    ("Flop", "Raise contra aposta", {"rua": ["flop"], "situacao": ["enfrenta aposta"]}, {"acao": ["Raise"]}),
    ("Flop", "Check-raise", {"rua": ["flop"], "situacao": ["enfrenta aposta"], "checou_antes": [1]}, {"acao": ["Raise"]}),
    ("Flop", "Fold contra raise", {"rua": ["flop"], "situacao": ["enfrenta raise"]}, {"acao": ["Fold"]}),
    ("Flop", "Bet é all-in", {"rua": ["flop"], "acao": ["Bet"]}, {"allin": [1]}),
    ("Turn", "C-bet do agressor do flop", {"rua": ["turn"], "situacao": ["livre"], "agressor_anterior": [1]}, {"acao": ["Bet"]}),
    ("Turn", "Probe depois do flop checado", {"rua": ["turn"], "situacao": ["livre"], "rua_anterior_checada": [1]}, {"acao": ["Bet"]}),
    ("Turn", "Fold contra aposta", {"rua": ["turn"], "situacao": ["enfrenta aposta"]}, {"acao": ["Fold"]}),
    ("Turn", "Raise contra aposta", {"rua": ["turn"], "situacao": ["enfrenta aposta"]}, {"acao": ["Raise"]}),
    ("Turn", "Check-raise", {"rua": ["turn"], "situacao": ["enfrenta aposta"], "checou_antes": [1]}, {"acao": ["Raise"]}),
    ("River", "Aposta quando checaram até ele", {"rua": ["river"], "situacao": ["livre"], "decisao_n": [1]}, {"acao": ["Bet"]}),
    ("River", "Bet-bet-bet (B, B, bet)", {"rua": ["river"], "situacao": ["livre"], "linha_flop": ["B"], "linha_turn": ["B"]}, {"acao": ["Bet"]}),
    ("River", "Bet-check-bet (B, X, bet)", {"rua": ["river"], "situacao": ["livre"], "linha_flop": ["B"], "linha_turn": ["X"]}, {"acao": ["Bet"]}),
    ("River", "Fold contra aposta", {"rua": ["river"], "situacao": ["enfrenta aposta"]}, {"acao": ["Fold"]}),
    ("River", "Fold contra aposta grande (≥ B75)", {"rua": ["river"], "situacao": ["enfrenta aposta"], "tamanho_enfrentado": GRANDE}, {"acao": ["Fold"]}),
    ("River", "Raise contra aposta", {"rua": ["river"], "situacao": ["enfrenta aposta"]}, {"acao": ["Raise"]}),
    ("River", "Weak% das apostas (blefe no showdown)", {"rua": ["river"], "acao": ["Bet"], "weak": [0, 1]}, {"weak": [1]}),
    ("Showdown", "Foi ao showdown (WTSD)", {"rua": ["flop"], "decisao_n": [1]}, {"sd": [1]}),
    ("Showdown", "Ganhou no showdown (W$SD)", {"rua": ["flop"], "decisao_n": [1], "sd": [1], "marcada": [0]}, {"ganhou": [1]}),
]


def painel(con: sqlite3.Connection, filtros: dict) -> list[dict]:
    """Cada stat do PAINEL sobre os filtros do usuario; a base da stat vence o filtro da mesma coluna."""
    saida = []
    for secao, nome, base, num in PAINEL:
        w, p = where({**filtros, **base})
        cond, pc = where(num)
        feitos, n = con.execute(
            f"SELECT sum(CASE WHEN {cond[len(' WHERE '):]} THEN 1 ELSE 0 END), count(*) FROM decisoes{w}",
            pc + p).fetchone()
        saida.append({"secao": secao, "nome": nome, "base": base, "num": num, "v": [feitos or 0, n]})
    return saida


# --- MDA: a arvore de acoes por rua (o perfil do H2N), com bet sizes em cada no --------------------------------
# Filtros que a propria arvore controla: nao valem como filtro de fora na aba MDA.
DA_ARVORE = {"rua", "situacao", "ip", "linha_flop", "linha_turn", "tam_flop", "tam_turn", "enf_flop", "enf_turn",
             "acao", "tamanho", "tamanho_enfrentado", "decisao_n", "checou_antes", "resposta", "_agrupar"}
SITU = "CASE WHEN situacao = 'livre' THEN 'livre' ELSE 'enfrenta' END"


def _caminho(caminho: dict, ate: str) -> dict:
    """O afunilamento como filtros: na rua `ate`, so quem fez a linha escolhida nas ruas anteriores.

    caminho[rua] = {"linha": "B", "faixa": "0,46–0,66", "lado": "aposta"|"pagou"}: a linha dele naquela rua
    (as letras, ex. "B" = apostou e ninguem aumentou; "XC" = check-call) e, se veio de um tamanho, a faixa da bet
    dele (lado aposta) ou da bet que ele pagou (lado pagou)."""
    filtros: dict = {}
    for rua in {"flop": [], "turn": ["flop"], "river": ["flop", "turn"]}[ate]:  # so as ruas antes de `ate`
        passo = caminho.get(rua) if isinstance(caminho, dict) else None
        if not isinstance(passo, dict) or not passo.get("linha"):
            continue
        filtros[f"linha_{rua}"] = [str(passo["linha"])]
        if passo.get("faixa"):
            filtros[("enf_" if passo.get("lado") == "pagou" else "tam_") + rua] = [str(passo["faixa"])]
    return filtros


def mda(con: sqlite3.Connection, corpo: dict) -> dict:
    """Por rua, os nos da arvore e, em cada no, as acoes; Bet/Raise abertos por tamanho (com all-in a parte) e,
    para quem enfrenta, as acoes por tamanho enfrentado."""
    externos = {k: v for k, v in (corpo.get("filtros") or {}).items() if k not in DA_ARVORE}
    caminho = corpo.get("caminho") or {}
    saida: dict = {}
    for rua in ("flop", "turn", "river"):
        w, p = where({**externos, **_caminho(caminho, rua), "rua": [rua]})
        nos: dict[str, dict] = {}

        def no(lf, lt, atual, situ) -> dict:
            prefixo = [x for x in ((lf,) if rua == "turn" else (lf, lt) if rua == "river" else ()) if x is not None]
            chave = "|".join(prefixo) + "#" + atual + "#" + situ
            return nos.setdefault(chave, {"chave": chave, "prefixo": prefixo, "atual": atual, "situ": situ, "n": 0,
                                          "acoes": {}, "tamanhos": {}, "enfrentado": {}})

        for lf, lt, atual, situ, acao, n in con.execute(
                f"SELECT linha_flop, linha_turn, linha_atual, {SITU}, acao, count(*) FROM decisoes{w} GROUP BY 1, 2, 3, 4, 5", p):
            d = no(lf, lt, atual, situ)
            d["n"] += n
            d["acoes"][acao] = n
        for lf, lt, atual, situ, acao, faixa, allin, n, folds, c1, c2, c3, aum, pf, pc, pr, resp, ev, tam in con.execute(
                f"SELECT linha_flop, linha_turn, linha_atual, {SITU}, acao, {CASE_H2N.format(col='tamanho')}, allin, "
                # CASE e nao sum(x = y): com tudo NULL (ninguem levou raise) o sum devolve NULL em vez de 0
                "count(*), " + ", ".join(f"sum(CASE WHEN {cond} THEN 1 ELSE 0 END)" for cond in (
                    "resposta = 'todos foldam'", "resposta = 'pago' AND n_calls = 1", "resposta = 'pago' AND n_calls = 2",
                    "resposta = 'pago' AND n_calls >= 3", "resposta = 'aumentado'",
                    "prox_acao = 'Fold'", "prox_acao = 'Call'", "prox_acao = 'Raise'", "resposta IS NOT NULL")) + ", "
                # EV do blefe e bet media como na Resposta ao sizing do Estudo: so as bets que a mesa respondeu
                f"sum(CASE WHEN resposta IS NOT NULL THEN {EV_BLEFE} ELSE 0 END), "
                "sum(CASE WHEN resposta IS NOT NULL THEN tamanho ELSE 0 END) "
                f"FROM decisoes{w}{_e(w)}acao IN ('Bet', 'Raise') AND tamanho IS NOT NULL GROUP BY 1, 2, 3, 4, 5, 6, 7", p):
            chave = faixa + ("|AI" if allin else "")
            no(lf, lt, atual, situ)["tamanhos"].setdefault(acao, {})[chave] = {
                "n": n, "todos foldam": folds, "1 call": c1, "2 calls": c2, "3+ calls": c3, "aumentado": aum,
                "depois": {"Fold": pf, "Call": pc, "Raise": pr}, "respondidas": resp, "ev": ev, "tam": tam}
        for lf, lt, atual, situ, faixa, acao, n, precisa in con.execute(
                f"SELECT linha_flop, linha_turn, linha_atual, {SITU}, {CASE_H2N.format(col='tamanho_enfrentado')}, acao, "
                f"count(*), sum(tamanho_enfrentado / (1 + tamanho_enfrentado)) FROM decisoes{w}{_e(w)}situacao != 'livre' "
                "AND tamanho_enfrentado IS NOT NULL GROUP BY 1, 2, 3, 4, 5, 6", p):
            d = no(lf, lt, atual, situ)["enfrentado"].setdefault(faixa, {"precisa": 0.0})
            d[acao] = n
            d["precisa"] += precisa  # soma de bet/(1+bet) mao a mao: dividido pelo n, o fold que empata um blefe
        saida[rua] = sorted(nos.values(), key=lambda d: (-sum(x["n"] for x in nos.values() if x["prefixo"] == d["prefixo"]),
                                                          d["prefixo"], len(d["atual"]), d["situ"] != "livre", d["atual"]))
    return saida


def leaks(con: sqlite3.Connection, filtros: dict) -> list[dict]:
    """Hero x populacao (sem o Hero) em cada stat do painel: a frequencia de cada lado e o lucro medio (BB a partir da
    decisao, sem as maos marcadas). bb = (lucro do Hero - lucro da populacao) x decisoes do Hero: quanto o jeito dele
    jogar o spot rende a mais (ou a menos) que o do field no mesmo spot. Lucro mistura sorte de carta: ver o n e o z."""
    saida = []
    for secao, nome, base, num in PAINEL:
        # stat que depende das cartas (Weak%): do vilao so se sabe no showdown, do Hero sempre. Sem igualar, o Hero
        # "blefa" 39% contra 15% so porque as cartas dele aparecem tambem quando ninguem paga. Os dois lados: so showdown.
        de_cartas = "weak" in base or "weak" in num
        if de_cartas:  # e o lucro ai mede a carta (mao fraca no showdown perde), nao a decisao: fica sem BB
            base = {**base, "sd": [1]}
        lado = {}
        for hero in (1, 0):
            w, p = where({**filtros, **base, "hero": [hero]})
            cond, pc = where(num)
            feitos, n, nl, lucro = con.execute(
                f"SELECT sum(CASE WHEN {cond[len(' WHERE '):]} THEN 1 ELSE 0 END), count(*), count(lucro), sum(lucro) "
                f"FROM decisoes{w}", pc + p).fetchone()
            lado[hero] = (feitos or 0, n, nl, lucro or 0.0)
        (fh, nh, lh, sh), (fp, np_, lp, sp) = lado[1], lado[0]
        if not nh or not np_:
            continue
        ph, pp = fh / nh, fp / np_
        junto = (fh + fp) / (nh + np_)
        erro = (junto * (1 - junto) * (1 / nh + 1 / np_)) ** 0.5
        bb = round((sh / lh - sp / lp) * nh, 1) if lh and lp and not de_cartas else None
        saida.append({"secao": secao, "nome": nome, "base": base, "hero": [fh, nh], "pop": [fp, np_],
                      "z": round((ph - pp) / erro, 2) if erro else 0.0, "bb": bb,
                      "lucro_hero": round(sh / lh, 2) if lh else None, "lucro_pop": round(sp / lp, 2) if lp else None})
    return sorted(saida, key=lambda s: (s["bb"] is None, s["bb"] if s["bb"] is not None else 0))


# --- Conferir: o print ao lado da mao lida; so as maos sorteadas entram na taxa de erro ---------------------------
CAMPOS_ERRO = ("carta", "board", "posição ou nick", "ação ou ordem", "valor", "saldo", "outro")


def teto_erro(erros: int, n: int, confianca: float = 0.95) -> float | None:
    """Limite de cima do intervalo de Clopper-Pearson para a taxa de erro: k erros em n maos sorteadas.
    0 em 100 -> 2,95%; 0 em 300 -> 1,0%."""
    if not n:
        return None
    if erros >= n:
        return 1.0
    alvo = 1 - confianca
    lo, hi = erros / n, 1.0
    for _ in range(60):  # bissecao: P(X <= erros; n, p) = alvo
        p = (lo + hi) / 2
        cdf = sum(math.comb(n, k) * p ** k * (1 - p) ** (n - k) for k in range(erros + 1))
        lo, hi = (p, hi) if cdf > alvo else (lo, p)
    return round(hi, 4)


def saude(con: sqlite3.Connection) -> dict:
    """O selo do topo: auditoria, leitor aceito e a taxa de erro medida na conferencia por sorteio."""
    aud = auditar.auditar(con)
    ruins = auditar.violacoes(aud)
    n, erros = con.execute("SELECT count(*), coalesce(sum(ok = 0), 0) FROM conferencias WHERE modo = 'sorteio'").fetchone()
    total = con.execute("SELECT count(*) FROM conferencias").fetchone()[0]
    feitas = {h for (h,) in con.execute("SELECT hand_id FROM conferencias")}
    return {"problemas": {k: len(v) for k, v in ruins.items()}, "exemplos": {k: v[:3] for k, v in ruins.items()},
            "leitor": auditar.aceito(RAIZ), "conferidas": n, "erros": erros, "teto": teto_erro(erros, n),
            "conferidas_total": total, "maos": con.execute("SELECT count(*) FROM hands").fetchone()[0],
            "suspeitas": [s.split(":")[0] for s in aud["cartas_duvidosas"] if s.split(":")[0] not in feitas]}


def dados_da_mao(con: sqlite3.Connection, hid: str) -> dict | None:
    linha = con.execute("SELECT id, png, board, unidade, obs, n_jogadores, pior_rank FROM hands WHERE id = ?",
                        (hid,)).fetchone()
    if not linha:
        return None
    foldaram = {p for (p,) in con.execute("SELECT DISTINCT pos FROM acoes WHERE hand_id = ? AND verbo = 'Fold'", (hid,))}
    jog = [{"pos": pos, "seat": seat, "nome": nome, "cartas": cs, "stack": stack, "net": net, "hero": hero,
            "showdown": pos not in foldaram}
           for pos, seat, nome, cs, stack, net, hero in con.execute(
               "SELECT pos, seat, nome, cartas, stack, net, hero FROM jogadores WHERE hand_id = ? ORDER BY ordem_flop", (hid,))]
    if sum(j["showdown"] for j in jog) < 2:  # ninguem mostrou: cartas de ninguem decidiram nada
        for j in jog:
            j["showdown"] = False
    return {"hand_id": linha[0], "png": linha[1], "board": linha[2], "unidade": linha[3], "obs": linha[4],
            "n": linha[5], "pior_rank": linha[6], "limiar": auditar.LIMIAR_CARTA, "data": decisoes.data_do_id(hid),
            "jogadores": jog, "linhas": linhas_de_mao(con, {hid}).get(hid, [])}


def pareceres_nicks() -> dict:
    """O parecer do Claude sobre cada par de nicks sugerido ("a|b" -> {veredito, motivo}), escrito depois de olhar
    os prints; so orienta: quem junta e o dono. Fica fora do git (tem nicks de terceiros)."""
    arq = RAIZ / "pareceres_nicks.json"
    try:
        return json.loads(arq.read_text(encoding="utf-8")) if arq.is_file() else {}
    except ValueError:
        return {}


def proximo_nick(con: sqlite3.Connection) -> tuple[dict | None, int]:
    """O proximo par de nicks a decidir, com ate 2 maos de cada um (print e posicao) para olhar o nick no print."""
    sugestoes = resultados.sugestoes_alias(con, limite=1000)
    if not sugestoes:
        return None, 0
    par = dict(sugestoes[0])
    par["maos"] = {lado: [{"hand_id": h, "png": png, "pos": pos} for h, png, pos in con.execute(
        "SELECT j.hand_id, h.png, j.pos FROM jogadores j JOIN hands h ON h.id = j.hand_id WHERE j.nome = ? "
        "ORDER BY j.hand_id LIMIT 2", (par[lado],))] for lado in ("a", "b")}
    par["parecer"] = pareceres_nicks().get(f"{par['a']}|{par['b']}")
    return par, len(sugestoes)


def conferir(con: sqlite3.Connection, corpo: dict) -> dict:
    """A proxima mao a conferir: sorteada entre as nao conferidas, ou a primeira da fila de suspeitas; no modo
    nicks, o proximo par de nicks que podem ser o mesmo jogador."""
    s = Handler.saude_cache or saude(con)
    if corpo.get("modo") == "nicks":
        par, restantes = proximo_nick(con)
        return {"modo": "nicks", "nick": par, "restantes": restantes, "mao": None, "saude": s, "campos": CAMPOS_ERRO}
    modo = "suspeita" if corpo.get("modo") == "suspeita" else "sorteio"
    if modo == "suspeita":
        hid = s["suspeitas"][0] if s["suspeitas"] else None
    else:
        r = con.execute("SELECT id FROM hands WHERE id NOT IN (SELECT hand_id FROM conferencias) "
                        "ORDER BY random() LIMIT 1").fetchone()
        hid = r[0] if r else None
    return {"modo": modo, "mao": dados_da_mao(con, hid) if hid else None, "saude": s, "campos": CAMPOS_ERRO}


def marcar(con: sqlite3.Connection, corpo: dict) -> dict:
    """Grava a conferencia (com o que a leitura dizia) e devolve a proxima. Erro tira a mao do estudo na hora."""
    hid = str(corpo.get("hand_id", ""))
    versao = con.execute("SELECT versao_leitor FROM hands WHERE id = ?", (hid,)).fetchone()
    if not versao:
        raise ValueError("mao desconhecida")
    ok = bool(corpo.get("ok"))
    campo = corpo.get("campo") if not ok else None
    if not ok and campo not in CAMPOS_ERRO:
        raise ValueError("diga qual campo está errado")
    modo = "suspeita" if corpo.get("modo") == "suspeita" else "sorteio"
    with con:
        con.execute("INSERT OR REPLACE INTO conferencias (hand_id, ok, campo, obs, assinatura, versao_leitor, quando, modo) "
                    "VALUES (?,?,?,?,?,?,?,?)", (hid, int(ok), campo, str(corpo.get("obs") or "")[:500] or None,
                                                 json.dumps(tracker.assinatura(con, hid)), versao[0], tracker.agora(), modo))
    if not ok:
        decisoes.reconstruir(con)
        resultados.reconstruir(con)
    copiar_conferencias(con)
    Handler.saude_cache = saude(con)
    return conferir(con, {"modo": modo})


def copiar_conferencias(con: sqlite3.Connection) -> Path:
    """As conferencias sao o unico dado que o refazer nao recria: um JSON delas (e dos aliases) a cada marcacao, na
    pasta BOMBPOT_COPIA (a do drive) ou, sem ela, ao lado do banco (fora do git)."""
    pasta = Path(os.environ.get("BOMBPOT_COPIA") or RAIZ)
    dados = {t: [dict(zip([c[0] for c in cur.description], r)) for r in cur]
             for t in ("conferencias", "aliases", "nicks_conferidos", "liberadas") for cur in [con.execute(f"SELECT * FROM {t}")]}
    arq = pasta / "conferencias_bombpot.json"
    arq.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    return arq


def jogadores(con: sqlite3.Connection, corpo: dict) -> dict:
    """A lista da aba Jogadores e o que ficou fora do grafico (sem nick; saldo que nao confere com o poker)."""
    if not resultados.FORA:
        resultados.reconstruir(con)
    return {"jogadores": resultados.jogadores(con, corpo.get("filtros")), "fora": resultados.FORA,
            "sugestoes": resultados.sugestoes_alias(con)}


def juntar(con: sqlite3.Connection, corpo: dict) -> dict:
    """O dono decidiu se dois nicks sao o mesmo jogador; junta = 1 faz o primeiro virar o segundo no grafico."""
    a, b = str(corpo.get("a", "")), str(corpo.get("b", ""))
    if not a or not b or a == b:
        raise ValueError("dois nicks diferentes")
    with con:
        con.execute("INSERT OR REPLACE INTO aliases VALUES (?,?,?)", (a, b, int(bool(corpo.get("junta")))))
    resultados.reconstruir(con)
    copiar_conferencias(con)
    if corpo.get("modo") == "nicks":  # veio da aba Conferir: devolve o proximo par
        return conferir(con, {"modo": "nicks"})
    return jogadores(con, corpo)


def exportar(con: sqlite3.Connection, filtros: dict, raiz: Path = RAIZ) -> tuple[str, int]:
    """Os .txt (PokerStars, bomb pot no formato do GG) das maos do filtro, num texto so, para o H2N."""
    w, p = where(filtros)
    ids = [i for (i,) in con.execute(f"SELECT DISTINCT hand_id FROM decisoes{w} ORDER BY hand_id", p)]
    textos = [(raiz / "hh" / "maos" / f"{i}.txt") for i in ids]
    partes = [arq.read_text(encoding="utf-8").strip() for arq in textos if arq.is_file()]
    return "\n\n\n".join(partes) + "\n", len(partes)


def opcoes(con: sqlite3.Connection) -> dict:
    lista = {c: [v for (v,) in con.execute(f"SELECT DISTINCT {c} FROM decisoes WHERE {c} IS NOT NULL ORDER BY 1")]
             for c, t in FILTROS.items() if t == "lista"}
    faixa = {c: con.execute(f"SELECT min({c}), max({c}) FROM decisoes").fetchone()
             for c, t in FILTROS.items() if t == "faixa"}
    n_maos = con.execute("SELECT count(*) FROM hands").fetchone()[0]
    tags = sorted({tag for (txt,) in con.execute("SELECT DISTINCT texturas FROM decisoes WHERE texturas IS NOT NULL")
                   for tag in txt.strip("|").split("|") if tag})
    datas = con.execute("SELECT min(data), max(data) FROM decisoes").fetchone()
    return {"lista": lista, "faixa": faixa, "faixas": [nome for _, nome, _ in FAIXAS],
            "codigos": {nome: cod for _, nome, cod in FAIXAS + FAIXAS_H2N}, "tags": tags, "datas": datas,
            "faixas_h2n": [nome for _, nome, _ in FAIXAS_H2N],
            "forcas": decisoes.FORCAS, "draws": decisoes.DRAWS, "maos": n_maos}


# ponytail: uma requisicao por vez; o site e de um usuario so, e assim nenhuma consulta le `decisoes` no meio da
# reconstrucao (a conexao e a mesma para todas as threads)
TRAVA = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    con: sqlite3.Connection
    versao_vista = -1
    saude_cache: dict | None = None  # a auditoria leva ~2 s: refeita so quando o banco muda

    def atualizar(self) -> None:
        """Refaz `decisoes` e `resultados` se outra conexao gravou no banco (vigia, refazer/aceitar, nomes,
        conferencia pelo terminal). PRAGMA data_version muda a cada commit de outra conexao, nao a cada mao nova."""
        v = self.con.execute("PRAGMA data_version").fetchone()[0]
        if v != Handler.versao_vista:
            decisoes.reconstruir(self.con)
            resultados.reconstruir(self.con)
            Handler.saude_cache = saude(self.con)
            Handler.versao_vista = v

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PUBLIC), **kw)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")  # o app.js muda sem trocar de nome
        super().end_headers()

    def _json(self, dados, status=200) -> None:
        corpo = json.dumps(dados, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self) -> None:
        if not self.path.startswith(("/api/", "/print/")):
            return super().do_GET()
        with TRAVA:
            return self._get()

    def do_POST(self) -> None:
        with TRAVA:
            self.atualizar()
            return self._post()

    def _get(self) -> None:
        if self.path == "/api/opcoes":
            self.atualizar()
            return self._json({**opcoes(self.con), "saude": Handler.saude_cache})
        if self.path.startswith("/print/"):
            nome = unquote(self.path[len("/print/"):])
            # so serve print de mao do banco: nada de caminho montado pelo navegador
            if not self.con.execute("SELECT 1 FROM hands WHERE png = ?", (nome,)).fetchone():
                return self._json({"erro": "print desconhecido"}, 404)
            arq = RAIZ / "processadas" / nome
            if not arq.is_file():
                return self._json({"erro": "print nao esta em processadas/"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(arq.read_bytes())
            return None
        return self._json({"erro": "rota desconhecida"}, 404)

    def _post(self) -> None:
        if self.path == "/api/exportar":
            filtros = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            texto, n = exportar(self.con, filtros if isinstance(filtros, dict) else {})
            corpo = texto.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="bombpot_{n}_maos.txt"')
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)
            return None
        rotas = {"/api/consulta": consultar, "/api/painel": painel, "/api/mda": mda, "/api/leaks": leaks,
                 "/api/maos": maos, "/api/mao": mao,
                 "/api/jogadores": jogadores, "/api/juntar": juntar, "/api/conferir": conferir, "/api/marcar": marcar,
                 "/api/serie": lambda con, corpo: resultados.serie(con, str(corpo.get("nome", "")),
                                                                   filtros=corpo.get("filtros"))}
        if self.path not in rotas:
            return self._json({"erro": "rota desconhecida"}, 404)
        try:
            filtros = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            return self._json(rotas[self.path](self.con, filtros if isinstance(filtros, dict) else {}))
        except (ValueError, sqlite3.Error) as exc:
            return self._json({"erro": str(exc)}, 400)

    def log_message(self, format, *args) -> None:  # noqa: A002 - sem uma linha por requisicao no console
        pass


def main(argv: list[str]) -> int:
    porta = int(argv[0]) if argv else 8770
    tracker.abrir().close()  # garante o esquema (e a coluna obs) antes de servir
    # ponytail: uma conexao para todas as threads; ok para um usuario local, um pool se um dia for multiusuario
    Handler.con = sqlite3.connect(RAIZ / "bombpot.db", check_same_thread=False, timeout=30)
    servidor = ThreadingHTTPServer(("127.0.0.1", porta), Handler)
    url = f"http://127.0.0.1:{porta}/"
    print(f"BombPot Tracker em {url} (Ctrl+C para parar)")
    webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
