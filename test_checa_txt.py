"""checa_txt: a leitura independente do .txt pega os defeitos achados nas maos com seguro (28/out)."""
import checa_txt

CABECA = """PokerStars Hand #1: Hold'em No Limit ($0.20/$0.40 USD) - 2026/10/28 10:00:00 UTC
Table 'T' 8-max Seat #3 is the button
Seat 1: P1 ($100 in chips)
Seat 2: P2 ($50.80 in chips)
Seat 3: P3 ($124.40 in chips)
P1: posts the ante $3.20
P2: posts the ante $3.20
P3: posts the ante $3.20
*** HOLE CARDS ***
*** FLOP *** [4s 6d 4c]
P1: checks
P2: bets $16.88
"""
FIM = """*** TURN *** [4s 6d 4c] [9d]
*** RIVER *** [4s 6d 4c 9d] [Ad]
*** SHOW DOWN ***
P2: shows [9c 6h]
P3: shows [Ks 4h]
P3 collected ${col} from pot
*** SUMMARY ***
Total pot $104.80 | Rake $0.40
"""
# P3 vai all-in de 121,20; P2 so tem 47,60 na rua e paga all-in por menos; voltam 73,60 ao P3
CERTO = CABECA + """P3: raises $104.32 to $121.20 and is all-in
P1: folds
P2: calls $30.72 and is all-in
Uncalled bet ($73.60) returned to P3
""" + FIM.format(col="104.40")


def test_mao_coerente_passa():
    assert checa_txt.problemas(CERTO) == []


def test_allin_por_menos_escrito_como_raise_de_zero():
    texto = CERTO.replace("P2: calls $30.72 and is all-in", "P2: raises $0 to $47.60 and is all-in")
    assert any("raises $0 to $47.60" in e and "aposta de pe era 121.20" in e for e in checa_txt.problemas(texto))


def test_devolucao_errada_e_pote_que_nao_fecha():
    texto = CERTO.replace("Uncalled bet ($73.60)", "Uncalled bet ($70.00)")
    erros = checa_txt.problemas(texto)
    assert any("ninguem pagou era 73.60" in e for e in erros)
    assert any("o pote do resumo e 104.8" in e for e in erros)


def test_quem_recolhe_tem_de_ser_quem_leva_pelas_cartas():
    texto = CERTO.replace("P3 collected", "P2 collected")  # P3 tem trinca de 4; P2, dois pares
    assert any("P2 recolhe 104.40; pelas cartas levaria 0.00" in e for e in checa_txt.problemas(texto))


def test_bet_escrita_como_raise_e_allin_com_sobra():
    texto = CERTO.replace("P2: bets $16.88", "P2: raises $16.80 to $16.88")
    assert any("ninguem tinha apostado" in e for e in checa_txt.problemas(texto))
    sobra = CERTO.replace("Seat 3: P3 ($124.40 in chips)", "Seat 3: P3 ($124.80 in chips)")
    assert any("all-in mas o stack 124.8" in e for e in checa_txt.problemas(sobra))
