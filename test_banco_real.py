"""Conferência no banco real, mão a mão: refaz as contas do site direto da tabela `acoes` (o que o print
diz) com um código independente de decisoes.py, e compara com o que o servidor mostra.

Pulado quando não há bombpot.db (o banco fica fora do repositório)."""

from collections import Counter, defaultdict
from pathlib import Path

import pytest

import servidor
import tracker

BANCO = Path(__file__).parent / "bombpot.db"
pytestmark = pytest.mark.skipif(not BANCO.is_file(), reason="sem bombpot.db nesta máquina")
VERBOS = {"Check", "Bet", "Call", "Raise", "Fold"}
TETOS = [(0.05, "0,01–0,05"), (0.15, "0,06–0,15"), (0.33, "0,16–0,33"), (0.45, "0,34–0,45"), (0.66, "0,46–0,66"),
         (0.85, "0,67–0,85"), (1.00, "0,86–1,00"), (1.20, "1,01–1,20"), (1.50, "1,21–1,50"), (2.00, "1,51–2,00")]


def faixa(tam: float) -> str:
    return next((nome for teto, nome in TETOS if tam <= teto), "2,00+")


@pytest.fixture(scope="module")
def con():
    c = tracker.abrir(BANCO)
    import decisoes
    decisoes.reconstruir(c)
    return c


@pytest.fixture(scope="module")
def recontagem(con):
    """Por rua: contagem das ações e, por faixa, as bets com a resposta da mesa. Só a tabela `acoes`."""
    por_mao = defaultdict(list)
    for hid, rua, pos, verbo, valor, allin, pote in con.execute(
            "SELECT hand_id, rua, pos, verbo, valor, allin, pote_antes FROM acoes ORDER BY hand_id, ordem"):
        por_mao[(hid, rua)].append((verbo, valor, pote))
    acoes = defaultdict(Counter)                      # rua -> verbo -> n
    bets = defaultdict(lambda: defaultdict(lambda: {"usos": 0, "todos foldam": 0, "pago": 0, "aumentado": 0,
                                                     "ev": 0.0, "tam": 0.0}))  # rua -> faixa -> ...
    for (hid, rua), lista in por_mao.items():
        lista = [(v, val, pote) for v, val, pote in lista if v in VERBOS]  # Insurance e afins não são decisão
        # 1ª passada: o verbo de verdade (o WPT escreve bet all-in e call all-in por menos como "Raise")
        apostou, maior = False, 0.0
        for i, (verbo, valor, pote) in enumerate(lista):
            if verbo == "Raise" and not apostou:
                verbo = "Bet"
            elif verbo == "Raise" and (valor or 0) <= maior:
                verbo = "Call"
            if verbo in ("Bet", "Raise"):
                apostou, maior = True, valor or 0
            lista[i] = (verbo, valor, pote)
        # 2ª passada: as contas
        for i, (verbo, valor, pote) in enumerate(lista):
            acoes[rua][verbo] += 1
            if verbo == "Bet" and pote:
                tam = round((valor or 0) / pote, 3)
                depois = []
                for v2, _, _ in lista[i + 1:]:
                    depois.append(v2)
                    if v2 in ("Bet", "Raise"):
                        break
                resp = "aumentado" if "Raise" in depois else "pago" if "Call" in depois else \
                    "todos foldam" if depois else None
                b = bets[rua][faixa(tam)]
                b["usos"] += 1
                if resp:
                    b[resp] += 1
                    b["ev"] += 1.0 if resp == "todos foldam" else -tam
                    b["tam"] += tam
    return acoes, bets


@pytest.mark.parametrize("rua", [None, "flop", "turn", "river"])
def test_acoes_batem(con, recontagem, rua):
    acoes, _ = recontagem
    esperado = sum(acoes.values(), Counter()) if rua is None else acoes[rua]
    site = servidor.consultar(con, {"rua": [rua]} if rua else {})["geral"]["acoes"]
    assert site == dict(esperado)


@pytest.mark.parametrize("rua", [None, "flop", "turn", "river"])
def test_resposta_ao_sizing_bate_faixa_a_faixa(con, recontagem, rua):
    _, bets = recontagem
    esperado: dict = defaultdict(lambda: {"usos": 0, "todos foldam": 0, "pago": 0, "aumentado": 0, "ev": 0.0, "tam": 0.0})
    for r, faixas in bets.items():
        if rua in (None, r):
            for f, d in faixas.items():
                for k, v in d.items():
                    esperado[f][k] += v
    site = servidor.consultar(con, {"rua": [rua]} if rua else {})["grafico"]
    assert set(site) == set(esperado)
    for f, d in esperado.items():
        s = site[f]
        assert (s["usos"], s["todos foldam"], s["pago"], s["aumentado"]) == \
               (d["usos"], d["todos foldam"], d["pago"], d["aumentado"]), f
        assert s["ev"] == pytest.approx(d["ev"], abs=1e-6) and s["tam"] == pytest.approx(d["tam"], abs=1e-6), f


def test_primeira_faixa_dividida_em_b5_e_b10(con):
    g = servidor.consultar(con, {})["grafico"]
    assert "0,01–0,15" not in g
    n5, n10 = con.execute("SELECT sum(tamanho <= 0.05), sum(tamanho > 0.05 AND tamanho <= 0.15) FROM decisoes "
                          "WHERE acao = 'Bet'").fetchone()
    assert (g["0,01–0,05"]["usos"], g["0,06–0,15"]["usos"]) == (n5, n10)


def test_mesa_soma_o_geral(con):
    r = servidor.consultar(con, {"rua": ["flop"]})
    assentos = sum(sum(a.values()) for a in r["mesa"]["por_pos"].values())
    assert assentos == r["geral"]["n"]
    assert sum(r["mesa"]["por_n"].values()) == r["geral"]["maos"]


def test_faixa_livre_bate_com_a_conta_direta(con):
    # o caso da conversa: turn, ninguem apostou, B5/B10 pago no flop, bet >= 0,75 (sem teto)
    f = {"rua": ["turn"], "situacao": ["livre"], "linha_flop": ["B"], "tam_flop": {"min": 0.01, "max": 0.15},
         "tamanho": {"min": 0.75, "max": ""}}
    r = servidor.consultar(con, f)["geral"]["resposta"]
    n, fold = con.execute("SELECT count(*), sum(resposta = 'todos foldam') FROM decisoes WHERE rua = 'turn' "
                          "AND situacao = 'livre' AND linha_flop = 'B' AND tam_flop >= 0.01 AND tam_flop <= 0.15 "
                          "AND acao = 'Bet' AND tamanho >= 0.75 AND resposta IS NOT NULL").fetchone()
    assert (r["todos foldam"] + r["pago"] + r["aumentado"], r["todos foldam"]) == (n, fold)
    # e a faixa livre 0,01-0,15 no flop e o mesmo que marcar B5 + B10
    chips = dict(f, tam_flop=["0,01–0,05", "0,06–0,15"])
    assert servidor.consultar(con, chips)["geral"] == servidor.consultar(con, f)["geral"]


def test_tamanho_que_ele_pagou_no_flop(con):
    """Flops com uma bet só e nenhum raise: quem pagou, pagou essa bet. Conferido contra a tabela acoes."""
    unica = {}
    for hid, verbos, valor, pote in con.execute(
            "SELECT hand_id, group_concat(verbo), max(CASE WHEN verbo = 'Bet' THEN valor END), "
            "max(CASE WHEN verbo = 'Bet' THEN pote_antes END) FROM acoes WHERE rua = 'flop' GROUP BY hand_id"):
        lista = verbos.split(",")
        if lista.count("Bet") == 1 and "Raise" not in lista:
            unica[hid] = round(valor / pote, 3)
    conferidas = 0
    for hid, pos, enf in con.execute(
            "SELECT DISTINCT hand_id, pos, enf_flop FROM decisoes WHERE rua = 'turn' AND linha_flop IN ('C', 'XC')"):
        if hid in unica:
            assert enf == unica[hid], (hid, pos)
            conferidas += 1
    assert conferidas > 100  # amostra de verdade, não um caso solto


@pytest.mark.parametrize("col", ["tamanho", "tamanho_enfrentado", "tam_flop", "tam_turn", "enf_flop", "enf_turn"])
def test_tamanho_vazio_nao_cai_na_ultima_faixa(con, col):
    """Regressao: com o chip B200+ marcado, decisoes sem tamanho (quem nao apostou/pagou) entravam no filtro."""
    w, p = servidor.where({col: ["2,00+"]})
    pelo_filtro = con.execute(f"SELECT count(*) FROM decisoes{w}", p).fetchone()[0]
    direto = con.execute(f"SELECT count(*) FROM decisoes WHERE {col} > 2.0").fetchone()[0]
    assert pelo_filtro == direto
    todas = servidor.opcoes(con)["faixas"]
    w, p = servidor.where({col: todas})
    assert con.execute(f"SELECT count(*) FROM decisoes{w}", p).fetchone()[0] == \
        con.execute(f"SELECT count(*) FROM decisoes WHERE {col} IS NOT NULL").fetchone()[0]
    grupos = {g["chave"] for g in servidor.consultar(con, {"_agrupar": col})["grupos"]}
    assert "None" not in grupos and grupos <= set(todas)


def test_overfold_no_turn_de_quem_pagou_bet_pequena(con):
    """O caso da conversa, conferido contra SQL direto: pagou ate 0,15 no flop, enfrenta bet no turn."""
    f = {"rua": ["turn"], "situacao": ["enfrenta aposta"], "linha_flop": ["C", "XC"], "enf_flop": {"min": 0, "max": 0.15}}
    n, folds, precisa = servidor.consultar(con, f)["geral"]["defesa"]
    dn, dfolds, dprecisa = con.execute(
        "SELECT count(*), sum(acao = 'Fold'), sum(tamanho_enfrentado / (1 + tamanho_enfrentado)) FROM decisoes "
        "WHERE rua = 'turn' AND situacao = 'enfrenta aposta' AND linha_flop IN ('C', 'XC') "
        "AND enf_flop >= 0 AND enf_flop <= 0.15").fetchone()
    assert (n, folds) == (dn, dfolds) and precisa == pytest.approx(dprecisa)
    assert folds / n > precisa / n  # e e overfold de verdade


def test_fold_por_sizing_bate_com_sql_direto(con):
    f = {"rua": ["turn"], "situacao": ["enfrenta aposta"], "linha_flop": ["C", "XC"], "enf_flop": {"min": 0, "max": 0.15}}
    r = servidor.consultar(con, f)
    d = r["defesa"]
    assert sum(v["n"] for v in d.values()) == r["geral"]["defesa"][0] == 205
    assert sum(v["Fold"] for v in d.values()) == r["geral"]["defesa"][1]
    n, folds = con.execute(
        "SELECT count(*), sum(acao = 'Fold') FROM decisoes WHERE rua = 'turn' AND situacao = 'enfrenta aposta' "
        "AND linha_flop IN ('C', 'XC') AND enf_flop >= 0 AND enf_flop <= 0.15 "
        "AND tamanho_enfrentado > 0.66 AND tamanho_enfrentado <= 0.85").fetchone()
    assert (d["0,67–0,85"]["n"], d["0,67–0,85"]["Fold"]) == (n, folds)
