"""Gabaritos conferidos a olho contra o print (tests/*.png). Rodar: python -m pytest -q"""

import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

import tracker

TESTS = Path(__file__).parent / "tests"
GABARITO = TESTS / "ID_1311804268404871168.png"  # check-around ate o CO, raise, shove, call


@pytest.fixture(scope="module")
def mao():
    return tracker.build(GABARITO, usar_armario=False, gravar=False)


def test_gabarito_vira_linhas_em_bb(mao):
    h, acoes, jogadores = tracker.linhas(mao, GABARITO.name)
    assert h[0] == "1311804268404871168" and h[2:5] == (8, 64.0, "2s 9s 7d Kd 2c")
    # passos sem verbo (marcador de vez) nao viram acao: 16 acoes no print
    assert len(acoes) == 16
    assert [a[3:8] for a in acoes[6:]] == [
        ("CO", "Bet", 21.5, 0, 64.0), ("BTN", "Fold", None, 0, 85.5),
        ("SB", "Fold", None, 0, 85.5), ("BB", "Fold", None, 0, 85.5),
        ("UTG", "Fold", None, 0, 85.5), ("UTG+1", "Raise", 75.0, 0, 85.5),
        ("MP", "Fold", None, 0, 160.5), ("HJ", "Fold", None, 0, 160.5),
        ("CO", "Raise", 96.7, 1, 160.5), ("UTG+1", "Call", 21.7, 0, 235.7),
    ]
    por_pos = {j[1]: j for j in jogadores}
    assert por_pos["HJ"][5:8] == ("Kc 10h", 1, 6)  # Hero = assento 0
    assert por_pos["CO"][3:6] == (106.0, 23.0, "8h 6c")
    assert por_pos["SB"][7] == 1 and por_pos["BTN"][7] == 8


def _mao(**kw):
    base = dict(hand_id="1", bomb_pot=True, issues=[], unidade="BB", bb=None,
                steps=[], players=[], ante=8.0, board=[])
    return SimpleNamespace(**{**base, **kw})


@pytest.mark.parametrize("kw, motivo", [
    (dict(hand_id=None), "sem HAND ID"),
    (dict(bomb_pot=False), "nao e bomb pot"),
    (dict(issues=["saldo nao fecha"]), "issues: saldo nao fecha"),  # R2
    (dict(issues=["mao com seguro", "rank de carta nao lido"]), "issues: mao com seguro; rank"),  # D6 so vale sozinha
    (dict(unidade="USD", bb=None), "valores em USD sem BB conhecida"),
])
def test_recusas(kw, motivo):
    with pytest.raises(tracker.Recusa, match=motivo):
        tracker.linhas(_mao(**kw), "x.png")


def test_seguro_e_jackpot_entram_marcados():  # D6
    h, _, _ = tracker.linhas(_mao(issues=["mao com seguro: x", "SB: 59 BB do ganho vieram do jackpot da casa"]), "x")
    assert h[-1] == "mao com seguro: x; SB: 59 BB do ganho vieram do jackpot da casa"
    assert tracker.linhas(_mao(), "x")[0][-1] is None


def test_moeda_vira_bb():
    h, _, _ = tracker.linhas(_mao(unidade="USD", bb=0.5, ante=28.0), "x.png")
    assert h[3] == 56.0


def test_processar_grava_move_e_nao_duplica(tmp_path):
    con = tracker.abrir(tmp_path / "t.db")
    (tmp_path / "entrada").mkdir()
    a = tmp_path / "entrada" / "a.png"
    b = tmp_path / "entrada" / "b.png"  # o mesmo print salvo de novo com outro nome
    shutil.copy(GABARITO, a)
    shutil.copy(GABARITO, b)
    assert tracker.processar(a, con, tmp_path) == "ok"
    assert tracker.processar(b, con, tmp_path) == "repetida"
    assert con.execute("SELECT count(*) FROM hands").fetchone() == (1,)
    assert con.execute("SELECT count(*) FROM acoes").fetchone() == (16,)
    assert (tmp_path / "hh" / "maos" / "1311804268404871168.txt").is_file()
    assert sorted(p.name for p in (tmp_path / "processadas").iterdir()) == ["a.png", "b.png"]
    assert not any((tmp_path / "entrada").iterdir())


def test_imagem_ilegivel_vai_para_recusadas(tmp_path):
    con = tracker.abrir(tmp_path / "t.db")
    ruim = tmp_path / "ruim.png"
    ruim.write_bytes(b"nao e png")
    assert tracker.processar(ruim, con, tmp_path).startswith("erro de leitura")
    assert (tmp_path / "recusadas" / "ruim.png").is_file()
    assert con.execute("SELECT count(*) FROM recusas").fetchone() == (1,)


def test_vigia_so_le_arquivo_de_tamanho_estavel(tmp_path):  # R3
    vistos = {}
    png = tmp_path / "a.png"
    png.write_bytes(b"12")
    assert tracker.estaveis(tmp_path, vistos) == []  # primeira vez que aparece
    png.write_bytes(b"1234")
    assert tracker.estaveis(tmp_path, vistos) == []  # ainda crescendo
    assert tracker.estaveis(tmp_path, vistos) == [png]


def test_lote_em_paralelo_da_o_mesmo_resultado(tmp_path):
    con = tracker.abrir(tmp_path / "t.db")
    pasta = tmp_path / "entrada"
    pasta.mkdir()
    for nome in ("a.png", "b.png"):
        shutil.copy(GABARITO, pasta / nome)
    shutil.copy(TESTS / "31-19 55-9 bomb.png", pasta / "c.png")
    assert tracker.processar_pasta(pasta, con, tmp_path, processos=2) == {"ok": 2, "repetida": 1}
    assert con.execute("SELECT count(*) FROM acoes").fetchone() == (16 + 13,)  # 13 acoes no print de c.png


def test_refazer_troca_igual_e_tira_a_que_virou_recusa(tmp_path):
    con = tracker.abrir(tmp_path / "t.db")
    (tmp_path / "entrada").mkdir()
    shutil.copy(GABARITO, tmp_path / "entrada" / "a.png")
    assert tracker.processar(tmp_path / "entrada" / "a.png", con, tmp_path) == "ok"
    assert tracker.refazer(con, tmp_path, processos=1) == {"igual": 1, "mudou": 0, "recusada": 0}
    # o mesmo arquivo trocado por lixo: a leitura nova recusa, e a mao sai do banco
    (tmp_path / "processadas" / "a.png").write_bytes(b"nao e png")
    con.execute("UPDATE hands SET png = 'a.png'")
    assert tracker.refazer(con, tmp_path, processos=1)["recusada"] == 1
    assert con.execute("SELECT count(*) FROM hands").fetchone() == (0,)
    assert (tmp_path / "recusadas" / "a.png").is_file()
