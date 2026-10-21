"""Categorias de força do H2N, caso a caso (escritos à mão)."""

import pytest

from decisoes import cartas
from forca import FRACAS, classificar


@pytest.mark.parametrize("mao, board, teve_draw, esperado", [
    # pares
    ("Ah Kd", "Ac 7s 2h", False, ("TPTK", None)),
    ("Kh Qd", "Kc 7s 2h", False, ("TP2K", None)),        # A seria o melhor kicker, Q é o 2º (K está no board)
    ("As Kd", "Kc 7s 2h", False, ("TPTK", None)),
    ("Kh 5d", "Kc 7s 2h", False, ("TPWK", None)),
    ("8h 7d", "Kc 7s 2h", False, ("Middle Pair", None)),
    ("3h 2d", "Kc 7s 2h", False, ("Low Pair", None)),
    ("Qh Qd", "Jc 7s 2h", False, ("Overpair", None)),
    ("9h 9d", "Jc 7s 2h", False, ("Middle Pair", None)),
    ("5h 5d", "Jc 7s 2h", False, ("Low Pair", None)),
    ("Qh Qd", "Jc Js 2h", False, ("Overpair", None)),    # par de bolso + board pareado: vale o par de bolso
    # fortes
    ("Kh 7d", "Kc 7s 2h", False, ("Two Pairs", None)),
    ("7h 6d", "7c 7s 2h", False, ("Trips", None)),
    ("7h 7d", "7c Ks 2h", False, ("Set", None)),
    ("7h 7d", "7c Ks Kh", False, ("Full+", None)),
    ("9h 8d", "7c 6s 5h", False, ("Straight", None)),
    ("Ah 2h", "Kh 7h 3h", False, ("Flush", None)),
    # draws no flop
    ("Ah 2h", "Kh 7h 3c", False, ("Draw", "Flush draw")),
    ("9h 8d", "7c 6s 2h", False, ("Draw", "OESD")),
    ("9h 8d", "Jc 7s 2h", False, ("Draw", "Gutshot")),
    ("9h 8h", "7h 6h 2c", False, ("Draw", "Combo draw")),
    ("Kh Kd", "Qh Jh 2c", False, ("Overpair", None)),    # draw só da mesa não conta: precisa de carta da mão
    ("Ah Kd", "Qc Jh 2c", False, ("Draw", "Gutshot")),   # AK em QJ: precisa do T
    # sem mão feita no flop
    ("Ah Kd", "9c 7s 2h", False, ("Overcards", None)),
    ("Ah 4d", "Kc 9s 7h", False, ("A-high", None)),
    ("8h 3d", "Kc 10s 6h", False, ("Trash", None)),
    # river
    ("9h 8d", "7c 6s 2h Ks 3d", True, ("Missed Draw", None)),
    ("Ah 4d", "Kc 9s 7h 2s 3d", False, ("A-high", None)),
    ("Qh Jd", "9c 7s 2h 3s 8c", False, ("Missed Overcards", None)),
    ("8h 3d", "Kc 10s 6h 2s 4c", False, ("Missed Trash", None)),
    ("2c 3d", "Ah Kh Qh Jh 10h", False, ("Missed Trash", None)),  # royal na mesa: a mão não joga
])
def test_categoria(mao, board, teve_draw, esperado):
    assert classificar(cartas(mao), cartas(board), teve_draw) == esperado


def test_weak():
    assert {"A-high", "Low Pair", "Missed Draw"} <= FRACAS
    assert not {"Draw", "Middle Pair", "TPWK"} & FRACAS
