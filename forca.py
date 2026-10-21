"""Força da mão nas categorias do Hand2Note, e os draws, a partir de cartas e board.

Categorias (as do painel Range do H2N, conferidas no MetaLens: docs/H2N_TELAS.md):
  sem mão feita: Draw, Overcards, A-high, Trash (flop/turn) e Missed Draw, Missed Overcards, A-high,
                 Missed Trash (river)
  pares: Low Pair, Middle Pair, TPWK, TP2K, TPTK, Overpair
  fortes: Two Pairs, Trips, Set, Straight, Flush, Full+

Weak (o "NN% weak" do H2N) = A-high + Overcards/Missed* + Trash + Low Pair. Draw no flop/turn não é weak:
ainda tem equity. Chop fica de fora (o print não diz o split por mão com confiança).

Regras de borda, fixadas aqui e testadas em test_forca.py:
- o que conta é a contribuição das cartas da mão: board que joga sozinho (trinca, sequência ou flush na
  mesa sem as cartas da mão ajudarem) cai em "sem mão feita";
- par de bolso com board pareado é classificado pelo par de bolso (overpair/médio/baixo), não dois pares;
- no river, quem não fez nada: Missed Draw > A-high > Missed Overcards > Missed Trash.
"""

from __future__ import annotations

from collections import Counter

import tracker  # noqa: F401 - poe o Poker_Replayer no sys.path
from wptparse.avaliador import VALOR, melhor_mao

FRACAS = {"A-high", "Overcards", "Trash", "Missed Draw", "Missed Overcards", "Missed Trash", "Low Pair"}
ORDEM = ["Missed Trash", "Trash", "Missed Overcards", "Overcards", "Missed Draw", "Draw", "A-high",
         "Low Pair", "Middle Pair", "TPWK", "TP2K", "TPTK", "Overpair",
         "Two Pairs", "Trips", "Set", "Straight", "Flush", "Full+"]
DRAWS = ["Gutshot", "OESD", "Flush draw", "Combo draw"]


def _v(c) -> int:
    return VALOR[c.rank]


def _draw(hole: list, board: list) -> str | None:
    """Draw que usa ao menos uma carta da mão; None se não há (ou se a mão já está feita)."""
    todas = hole + board
    naipes = Counter(c.suit for c in todas)
    flush_draw = any(n == 4 and any(c.suit == s for c in hole) for s, n in naipes.items())
    valores = {_v(c) for c in todas} | ({1} if any(_v(c) == 14 for c in todas) else set())
    da_mao = {_v(c) for c in hole} | ({1} if any(_v(c) == 14 for c in hole) else set())
    outs: set[int] = set()
    for baixo in range(1, 11):  # janelas A-5 ... T-A
        janela = set(range(baixo, baixo + 5))
        presentes = janela & valores
        if len(presentes) == 4 and presentes & da_mao:
            outs |= janela - presentes
    reta = "OESD" if len(outs) >= 2 else "Gutshot" if outs else None
    if flush_draw and reta:
        return "Combo draw"
    return "Flush draw" if flush_draw else reta


def _joga(hole: list, board: list) -> bool:
    """As cartas da mão melhoram o que o board já tem sozinho? (só o river tem 5 cartas na mesa)"""
    so_board = melhor_mao(board) if len(board) == 5 else None
    return not so_board or melhor_mao(hole + board)[0] > so_board[0]


def classificar(hole: list, board: list, teve_draw: bool = False) -> tuple[str, str | None]:
    """(categoria, draw) para 2 cartas da mão e 3 a 5 do board. teve_draw: houve draw no flop/turn."""
    river = len(board) == 5
    feita = melhor_mao(hole + board)
    cat = feita[0][0] if feita else 0
    b = sorted({_v(c) for c in board}, reverse=True)
    contagem_board = Counter(_v(c) for c in board)
    h1, h2 = sorted((_v(c) for c in hole), reverse=True)

    if cat >= 4 and _joga(hole, board):
        return ("Full+" if cat >= 6 else "Flush" if cat == 5 else "Straight"), None
    draw = None if river else _draw(hole, board)

    if h1 == h2:  # par de bolso
        if contagem_board[h1] >= 1:
            return ("Full+" if contagem_board[h1] >= 2 or max(contagem_board.values()) >= 2 else "Set"), None
        if h1 > b[0]:
            return "Overpair", draw
        return ("Middle Pair" if len(b) > 1 and h1 > b[1] else "Low Pair"), draw

    pares = [h for h in (h1, h2) if contagem_board[h] >= 1]
    if any(contagem_board[h] >= 2 for h in pares):
        return "Trips", draw
    if len(pares) == 2:
        return "Two Pairs", draw
    if pares:
        r = pares[0]
        if r == b[0]:
            kicker = h2 if r == h1 else h1
            melhores = [v for v in range(14, 1, -1) if v != r and contagem_board[v] == 0]
            return ("TPTK" if kicker == melhores[0] else "TP2K" if kicker == melhores[1] else "TPWK"), draw
        return ("Middle Pair" if len(b) > 1 and r == b[1] else "Low Pair"), draw

    # sem mão feita com as cartas da mão
    if river:
        if teve_draw:
            return "Missed Draw", None
        if h1 == 14:
            return "A-high", None
        return ("Missed Overcards" if h2 > b[0] else "Missed Trash"), None
    if draw:
        return "Draw", draw
    if h2 > b[0]:
        return "Overcards", None
    return ("A-high" if h1 == 14 else "Trash"), None
