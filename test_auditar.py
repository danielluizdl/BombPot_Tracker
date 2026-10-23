"""A auditoria: cada checagem pega o erro que promete (uma mao real limpa, estragada um campo de cada vez)."""
import shutil
from pathlib import Path

import pytest

import auditar
import decisoes
import tracker

TESTS = Path(__file__).parent / "tests"
HID = "1311804268404871168"


@pytest.fixture(scope="module")
def limpo(tmp_path_factory):
    raiz = tmp_path_factory.mktemp("aud")
    (raiz / "entrada").mkdir()
    shutil.copy(TESTS / "ID_1311804268404871168.png", raiz / "entrada" / "a.png")
    con = tracker.abrir(raiz / "t.db")
    assert tracker.processar(raiz / "entrada" / "a.png", con, raiz) == "ok"
    con.close()
    return raiz


@pytest.fixture
def con(limpo, tmp_path):
    shutil.copytree(limpo, tmp_path / "r")
    c = tracker.abrir(tmp_path / "r" / "t.db")
    yield c, tmp_path / "r"
    c.close()


def _falhas(con):
    c, raiz = con
    return auditar.violacoes(auditar.auditar(c, raiz, leitor_aceito=tracker.versao_leitor()))


def test_mao_limpa_passa(con):
    assert _falhas(con) == {}


@pytest.mark.parametrize("sql, checagem", [
    ("UPDATE jogadores SET cartas = 'Kd 8h' WHERE pos = 'CO'", "cartas_repetidas"),       # Kd esta no board
    ("UPDATE jogadores SET net = -7 WHERE pos = 'SB'", "fold_menos_8"),                   # so foldou: perde 8
    # o perdedor tem de bater exato; no vencedor -1 cabe no rake possivel (ate 3,1 BB) e nenhuma checagem pega
    # (aqui CO e UTG+1 dividem o pote com 8-6: os dois "venceram")
    ("UPDATE jogadores SET net = net - 1 WHERE pos = 'MP'", "saldo_x_cartas"),
    ("UPDATE jogadores SET net = net + 10 WHERE pos = 'UTG+1'", "soma_dos_saldos"),
    ("UPDATE jogadores SET hero = 1 WHERE pos = 'CO'", "hero_nao_unico"),
    ("UPDATE hands SET n_jogadores = 7", "n_jogadores"),
    ("UPDATE hands SET board = '2s 9s 7d'", "board_curto"),
    ("UPDATE acoes SET verbo = 'Check' WHERE ordem = 15", "acao_ilegal"),                 # check diante do shove
    ("UPDATE hands SET png = 'sumiu.png'", "print_ausente"),
    ("UPDATE hands SET versao_leitor = '27-abc'", "leitor_nao_aceito"),
])
def test_cada_checagem_pega_o_seu_erro(con, sql, checagem):
    con[0].execute(sql)
    assert checagem in _falhas(con)


def test_call_zero_sem_aposta_e_o_check_do_wpt():  # ID_1318375308628545536, turn e river
    acoes = [("turn", "UTG", "Call", 0.0, 0), ("turn", "HJ", "Check", None, 0)]
    assert auditar.acoes_ilegais(acoes) == []
    assert auditar.acoes_ilegais([("turn", "UTG", "Call", 5.0, 0)]) == ["UTG call de 5 sem aposta (turn)"]


def test_acao_depois_do_fold_em_outra_rua():
    acoes = [("flop", "SB", "Fold", None, 0), ("turn", "SB", "Check", None, 0)]
    assert auditar.acoes_ilegais(acoes) == ["SB age depois do fold (turn)"]


def test_tolerancia_segue_o_arredondamento_da_tela():
    assert auditar.tolerancia("USD", [150.0]) == 0.02         # moeda: exata ao centavo
    assert auditar.tolerancia("BB", [21.3, 13.4]) == pytest.approx(0.105)
    assert auditar.tolerancia("BB", [139, 264, -410]) == pytest.approx(1.605)  # 3 valores sem decimal


def test_carta_duvidosa_e_hora_estranha_sao_informativas(con):
    c, raiz = con
    c.execute("UPDATE hands SET pior_rank = 0.14, mtime = '2020-01-01T00:00:00Z'")
    r = auditar.auditar(c, raiz, leitor_aceito=tracker.versao_leitor())
    assert r["cartas_duvidosas"] and r["hora_estranha"] and auditar.violacoes(r) == {}


def test_mao_com_erro_conferido_sai_do_estudo(con):
    c, raiz = con
    decisoes.reconstruir(c)
    assert c.execute("SELECT count(*) FROM decisoes").fetchone()[0] > 0
    c.execute("INSERT INTO conferencias VALUES (?, 0, 'acao', NULL, '{}', 'v', 'x', 'sorteio')", (HID,))
    assert auditar.auditar(c, raiz)["excluidas_conferencia"] == [HID]
    assert decisoes.reconstruir(c) == 0  # a unica mao saiu; e a tabela vazia nao quebra
    assert c.execute("SELECT count(*) FROM decisoes").fetchone() == (0,)
