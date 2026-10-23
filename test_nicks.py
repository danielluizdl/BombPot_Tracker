"""nicks.py: grafia real do grupo, ensino do caderno do Replayer e o aceitar que nao trava por nick corrigido."""
import json
import shutil
from pathlib import Path

import pytest

import nicks
import resultados
import tracker

TESTS = Path(__file__).parent / "tests"
HID = "1311804268404871168"


@pytest.fixture(scope="module")
def base(tmp_path_factory):
    raiz = tmp_path_factory.mktemp("nk")
    (raiz / "entrada").mkdir()
    shutil.copy(TESTS / "ID_1311804268404871168.png", raiz / "entrada" / "a.png")
    c = tracker.abrir(raiz / "t.db")
    assert tracker.processar(raiz / "entrada" / "a.png", c, raiz) == "ok"
    c.close()
    return raiz


@pytest.fixture
def con(base, tmp_path):
    raiz = tmp_path / "r"
    shutil.copytree(base, raiz)
    c = tracker.abrir(raiz / "t.db")
    yield c, raiz
    c.close()


def test_grafia_real_junta_o_grupo_e_some_das_sugestoes(con):
    c, _ = con
    c.executemany("INSERT INTO aliases VALUES (?,?,1)", [("Bluboo7", "Bluboo1"), ("Bluboo1", "Blubooi")])
    nicks.definir_real(c, {"Bluboo7", "Bluboo1", "Blubooi"}, "BlubooI", conferido=True, fonte="print")
    real = resultados.principais(c)
    assert {real[m] for m in ("Bluboo7", "Bluboo1", "Blubooi")} == {"BlubooI"}
    assert c.execute("SELECT nick FROM nicks_conferidos").fetchall() == [("BlubooI",)]
    # duas grafias do mesmo grupo nao voltam como sugestao
    c.execute("UPDATE jogadores SET nome = 'Bluboo7' WHERE pos = 'SB'")
    c.execute("UPDATE jogadores SET nome = 'Bluboo1' WHERE pos = 'BB'")  # mesma mao: nem seria sugerido; testa o grupo
    assert not any({s["a"], s["b"]} <= {"Bluboo7", "Bluboo1", "Blubooi"} for s in resultados.sugestoes_alias(c))


def test_caderno_aprende_a_grafia_conferida_e_corrige_o_nome(con, tmp_path):
    c, raiz = con
    certo = c.execute("SELECT nome FROM jogadores WHERE hand_id = ? AND pos = 'CO'", (HID,)).fetchone()[0]
    outros = dict(c.execute("SELECT pos, nome FROM jogadores WHERE hand_id = ? AND pos <> 'CO'", (HID,)))
    c.execute("UPDATE jogadores SET nome = 'LidoErrado' WHERE hand_id = ? AND pos = 'CO'", (HID,))  # o OCR errou
    nicks.definir_real(c, {"LidoErrado"}, certo + "X", conferido=True, fonte="print")  # a grafia que o dono leu
    arquivo = tmp_path / "jogadores.json"
    r = nicks.ensinar(c, raiz, arquivo=arquivo, processos=1)
    assert r == {"maos": 1, "nicks": 1, "corrigidos": 1}
    assert c.execute("SELECT nome FROM jogadores WHERE hand_id = ? AND pos = 'CO'", (HID,)).fetchone() == (certo + "X",)
    assert dict(c.execute("SELECT pos, nome FROM jogadores WHERE hand_id = ? AND pos <> 'CO'", (HID,))) == outros
    gravado = json.loads(arquivo.read_text(encoding="utf-8"))["jogadores"]
    assert [(j["nick"], j["confirmado"]) for j in gravado] == [(certo + "X", True)]
    assert nicks.ensinar(c, raiz, arquivo=arquivo, processos=1)["corrigidos"] == 0  # de novo: nada a mudar


def test_grafia_nao_conferida_nao_ensina(con, tmp_path):
    c, raiz = con
    c.execute("UPDATE jogadores SET nome = 'LidoErrado' WHERE hand_id = ? AND pos = 'CO'", (HID,))
    nicks.definir_real(c, {"LidoErrado"}, "Talvez", conferido=False)
    assert nicks.ensinar(c, raiz, arquivo=tmp_path / "j.json", processos=1) == {"maos": 0, "nicks": 0, "corrigidos": 0}
    assert not (tmp_path / "j.json").exists()


def test_nick_corrigido_numa_mao_conferida_nao_trava_o_aceitar(con):
    c, raiz = con
    certo = c.execute("SELECT nome FROM jogadores WHERE hand_id = ? AND pos = 'CO'", (HID,)).fetchone()[0]
    c.execute("UPDATE jogadores SET nome = 'LidoErrado' WHERE hand_id = ? AND pos = 'CO'", (HID,))
    c.execute("INSERT INTO conferencias VALUES (?, 1, NULL, NULL, ?, 'v', 'x', 'sorteio')",
              (HID, json.dumps(tracker.assinatura(c, HID))))  # o dono conferiu com o nick ainda errado
    nicks.definir_real(c, {"LidoErrado"}, certo, conferido=True)
    c.commit()
    contagem = tracker.refazer(c, raiz, processos=1)  # a releitura le o nick certo
    assert contagem["mudou"] == 1 and contagem["conferida_mudou"] == 0
    assert tracker.aceitar(c, raiz).startswith("aceito")
