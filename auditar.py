"""Invariantes de todas as maos do banco: o que precisa valer para a leitura merecer confianca.

    python tracker.py auditar      imprime cada checagem com as maos que falharam; sai com 1 se alguma falhou

Roda tambem no fim de `processar` e antes do `aceitar` (que recusa banco novo com violacao). A maioria das checagens
compara numeros do mesmo print entre si (consistencia); as que cruzam regioes diferentes do print, e por isso pegam
leitura errada que continua consistente, sao: cartas repetidas, saldo x resultado pelas cartas, fold = -8 BB e a hora
do HAND ID x a data do arquivo.

Informativas (aparecem, mas nao contam como violacao): cartas com template duvidoso (vao para a fila de conferencia),
hora estranha (um print salvo dias depois e legitimo) e maos excluidas por erro achado na conferencia.
"""
from __future__ import annotations

import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import decisoes
import resultados as R

RAIZ = Path(__file__).resolve().parent
INFORMATIVAS = ("cartas_duvidosas", "hora_estranha", "excluidas_conferencia")
# Numero da carta: o leitor aceita ate 0,16 (wptparse/cards.py MAX_DIST). A pior carta de cada mao, medida nas 1.576
# maos de 23/out: mediana 0,078, 99% abaixo de 0,12, maximo 0,146. Acima de 0,12 (o 1% mais longe) vai para a fila.
LIMIAR_CARTA = 0.12
# Na unidade BB a tela converte e arredonda cada valor: abaixo de 100 BB ela ja erra 0,1 sozinha (ID_1311798473139392512:
# raise all-in 13,40, calls 13,40 e saldo -21,30, com entrada de 8), e a partir de 100 BB mostra sem decimais
# (270 de 270 acoes, revisao de 22/out): ate 0,5 por valor. Em moeda a tela e exata ao centavo.
BASE_BB, GRANDE, MEIO = 0.1, 100, 0.5
# Hora do HAND ID x data do arquivo: o snowflake esta no fuso de Brasilia, e o print sai 0 a 40 min depois.
HORA_MIN, HORA_MAX = timedelta(hours=2, minutes=59), timedelta(hours=4)


def aceito(raiz: Path) -> str | None:
    arq = raiz / "REPLAYER_OK"
    return arq.read_text(encoding="utf-8").strip() if arq.is_file() else None


def tolerancia(unidade: str, valores: list) -> float:
    """Quanto o saldo pode diferir da conta por causa do arredondamento da tela (so na unidade BB)."""
    if unidade != "BB":
        return 0.02
    return BASE_BB + 0.005 + MEIO * sum(1 for v in valores if v is not None and abs(v) >= GRANDE)


def acoes_ilegais(acoes: list) -> list[str]:
    saida, fold = [], set()  # quem foldou numa rua nao volta nas seguintes
    for rua in ("flop", "turn", "river"):
        apostou, maior = False, 0.0
        for r, p, v, val, ai in acoes:
            if r != rua:
                continue
            if p in fold:
                saida.append(f"{p} age depois do fold ({rua})")
            if v == "Fold":
                fold.add(p)
            elif v == "Bet" and apostou:
                saida.append(f"{p} bet com aposta na mesa ({rua})")
            elif v == "Check" and apostou:
                saida.append(f"{p} check com aposta na mesa ({rua})")
            elif v == "Call" and not apostou and val:  # "Call $0.00" sem aposta e o check do WPT
                saida.append(f"{p} call de {val:g} sem aposta ({rua})")
            elif v == "Raise" and apostou and (val or 0) <= maior and not ai:
                saida.append(f"{p} raise menor que a aposta sem all-in ({rua})")
            if v in ("Bet", "Raise"):
                apostou, maior = True, max(maior, val or 0)
    return saida


def auditar(con: sqlite3.Connection, raiz: Path = RAIZ, pastas: set[str] | None = None,
            leitor_aceito: str | None = None) -> dict[str, list[str]]:
    """nome da checagem -> ['hand_id: detalhe', ...]. pastas: onde o print pode estar (padrao: processadas)."""
    pastas = pastas or {"processadas"}
    leitor_aceito = leitor_aceito or aceito(raiz)
    acoes = defaultdict(list)
    for hid, *r in con.execute("SELECT hand_id, rua, pos, verbo, valor, allin FROM acoes ORDER BY hand_id, ordem"):
        acoes[hid].append(tuple(r))
    jog = defaultdict(dict)
    for hid, pos, net, cs, hero in con.execute("SELECT hand_id, pos, net, cartas, hero FROM jogadores"):
        jog[hid][pos] = (net, cs, hero)
    excluidas = {h for (h,) in con.execute("SELECT hand_id FROM conferencias WHERE ok = 0")}
    out: dict[str, list[str]] = {k: [] for k in (
        "acao_ilegal", "cartas_repetidas", "hero_nao_unico", "n_jogadores", "board_curto", "soma_dos_saldos",
        "saldo_x_cartas", "fold_menos_8", "print_ausente", "leitor_nao_aceito", *INFORMATIVAS)}
    fora = set()
    for hid, n, ante, board, obs, png, unidade, versao, mtime, prk in con.execute(
            "SELECT id, n_jogadores, ante_bb, board, obs, png, unidade, versao_leitor, mtime, pior_rank FROM hands"):
        J, A, board, ante = jog[hid], acoes[hid], board or "", ante or 0.0
        if hid in excluidas:
            out["excluidas_conferencia"].append(hid)
        for problema in acoes_ilegais(A):
            out["acao_ilegal"].append(f"{hid}: {problema}")
        cartas = board.split() + [c for (_, cs, _) in J.values() if cs for c in cs.split()]
        if len(cartas) != len(set(cartas)):
            out["cartas_repetidas"].append(f"{hid}: {' '.join(cartas)}")
        if sum(h for (_, _, h) in J.values()) != 1:
            out["hero_nao_unico"].append(hid)
        if n != len(J):
            out["n_jogadores"].append(f"{hid}: {n} na mao, {len(J)} jogadores lidos")
        ruas = {a[0] for a in A}
        foldaram = {a[1] for a in A if a[2] == "Fold"}
        showdown = len(set(J) - foldaram) >= 2  # mais de um vivo no fim: o board correu ate o river
        if len(board.split()) < (5 if "river" in ruas or showdown else 4 if "turn" in ruas else 3):
            out["board_curto"].append(f"{hid}: {board}")
        if not any((raiz / p / png).is_file() for p in pastas):
            out["print_ausente"].append(f"{hid}: {png}")
        if leitor_aceito and versao != leitor_aceito:
            out["leitor_nao_aceito"].append(f"{hid}: {versao}")
        if (prk or 0) > LIMIAR_CARTA:
            out["cartas_duvidosas"].append(f"{hid}: numero da carta a {prk} do modelo")
        quando = decisoes.data_do_id(hid) and decisoes.ORIGEM_ID + timedelta(milliseconds=int(hid) >> 22)
        if mtime and quando:
            atraso = datetime.strptime(mtime, "%Y-%m-%dT%H:%M:%SZ") - quando
            if not HORA_MIN <= atraso <= HORA_MAX:
                out["hora_estranha"].append(f"{hid}: arquivo {atraso} depois do HAND ID")
        # quem so checou e foldou perdeu exatamente a entrada (8 BB): pega um ante mal lido que escalaria a mao
        # inteira. Cruza a caixa Ante com as linhas de resultado: a BB sai da caixa (lida em 1.567 de 1.567 maos em
        # 23/out); so seria circular se o Replayer caisse na reserva da "menor perda" (hand.py bb_da_mao, fonte 3).
        so_entrada = {p for p in foldaram if all(a[2] in ("Check", "Fold") for a in A if a[1] == p)}
        for p in so_entrada:
            if J[p][0] is None or abs(J[p][0] + ante / n) > 0.02:
                out["fold_menos_8"].append(f"{hid}: {p} so checou/foldou e o saldo e {J[p][0]} (entrada {ante / n:g})")
        if obs:  # seguro/jackpot: o saldo de quem comprou nao e o do poker (resultados.py confere jogador a jogador)
            continue
        nets = [j[0] for j in J.values()]
        tol = tolerancia(unidade, [a[3] for a in A] + nets)
        put = R.investido(n, ante, list(J), A)
        pote = sum(put.values())
        rake = min(R.RAKE_MAX * pote, R.RAKE_TETO)
        soma = sum(x or 0 for x in nets)
        if not -rake - tol <= soma <= tol:
            out["soma_dos_saldos"].append(f"{hid}: soma {soma:.2f}, pote {pote:.2f}")
        esp = R.poker(n, ante, board, A, {p: (j[0], j[1]) for p, j in J.items()})
        if esp is None:
            fora.add(hid)
            continue
        for p, (net, _, _) in J.items():
            e, net = esp[p], net or 0.0
            ok = abs(net - e) <= tol if e < 0 else e - rake - tol <= net <= e + tol
            if not ok:
                out["saldo_x_cartas"].append(f"{hid}: {p} saldo {net:g}, pelas cartas {e:.2f}")
    if fora:  # mao limpa que nao da para conferir pelas cartas: hoje 0; se aparecer, quero ver
        out["saldo_x_cartas"] += [f"{h}: showdown sem as cartas de quem disputa" for h in sorted(fora)]
    return out


def violacoes(resultado: dict[str, list[str]]) -> dict[str, list[str]]:
    return {k: v for k, v in resultado.items() if v and k not in INFORMATIVAS}


def imprimir(resultado: dict[str, list[str]]) -> int:
    ruins = violacoes(resultado)
    for nome, lista in resultado.items():
        marca = "  info" if nome in INFORMATIVAS else ("FALHOU" if lista else "    ok")
        print(f"{marca}  {nome}: {len(lista)}" + "".join(f"\n          {x}" for x in lista[:5])
              + (f"\n          ... mais {len(lista) - 5}" if len(lista) > 5 else ""))
    print("auditoria: " + ("limpa" if not ruins else f"{sum(map(len, ruins.values()))} problemas"))
    return 1 if ruins else 0


if __name__ == "__main__":
    import tracker

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]
    sys.exit(imprimir(auditar(tracker.abrir())))
