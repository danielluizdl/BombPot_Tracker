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
    assert sorted(p.name for p in (tmp_path / "processadas").iterdir()) == ["a.png"]
    assert sorted(p.name for p in (tmp_path / "repetidas").iterdir()) == ["ID_1311804268404871168.png"]  # a copia, pelo id
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


def _uma_mao(tmp_path, nome="a.png"):
    con = tracker.abrir(tmp_path / "t.db")
    (tmp_path / "entrada").mkdir(exist_ok=True)
    shutil.copy(GABARITO, tmp_path / "entrada" / nome)
    assert tracker.processar(tmp_path / "entrada" / nome, con, tmp_path) == "ok"
    return con


def test_faixa_preta_do_fim_vira_cor_do_painel_e_a_leitura_nao_muda(tmp_path):
    """Prints com faixa preta embaixo (fora do export do WPT) davam 'export cortado'. Pintar so as linhas 100% pretas
    nao mexe em pixel com conteudo: o gabarito com 2.000 linhas pretas a mais le igual ao original."""
    import numpy as np
    from PIL import Image
    a = np.array(Image.open(GABARITO).convert("RGB"))
    b = np.vstack([a, np.zeros((2000, a.shape[1], 3), dtype=a.dtype)])
    pintado = tracker.sem_faixa_preta(b)
    assert (pintado[:a.shape[0]] == a).all() and (pintado[a.shape[0]:] == tracker.PANEL_BG).all()
    assert tracker.sem_faixa_preta(a) is a  # sem faixa: a mesma imagem
    Image.fromarray(b).save(tmp_path / "preta.png")
    _, hand, r = tracker.ler(tmp_path / "preta.png")
    assert hand is not None and not hand.issues
    _, _, r0 = tracker.ler(GABARITO)
    assert r[1] == r0[1] and r[2] == r0[2]  # mesmas acoes e jogadores


def test_liberada_so_passa_com_as_mesmas_queixas():
    queixa = "SB: replay soma 494 investido, saldo diz 466"
    mao = _mao(issues=[queixa])
    with pytest.raises(tracker.Recusa):
        tracker.linhas(mao, "x.png")
    assert tracker.linhas(mao, "x.png", frozenset({queixa}))[0][-1] is None  # nao vira marcada
    with pytest.raises(tracker.Recusa):  # leitor novo com outra queixa: recusa de novo
        tracker.linhas(_mao(issues=[queixa, "pote do turn: replay 1, imagem 2"]), "x.png", frozenset({queixa}))
    seguro = "mao com seguro: x"
    assert tracker.linhas(_mao(issues=[queixa, seguro]), "x", frozenset({queixa}))[0][-1] == seguro


def test_correcao_a_mao_do_replayer_entra():
    corrigida = "cima-esquerda[1]: carta corrigida a mao para 10d"
    assert tracker.linhas(_mao(issues=[corrigida]), "x.png")[0][-1] is None
    assert tracker.separar_issues([corrigida, "mao com seguro: y", "outra"]) == (["mao com seguro: y"], [corrigida], ["outra"])


def test_mao_guarda_leitor_hash_data_e_distancia_das_cartas(tmp_path):
    con = _uma_mao(tmp_path)
    versao, sha, mtime, rank = con.execute("SELECT versao_leitor, sha256, mtime, pior_rank FROM hands").fetchone()
    assert versao == tracker.versao_leitor() and versao.startswith(f"{tracker.VERSAO}-")
    assert sha == __import__("hashlib").sha256(GABARITO.read_bytes()).hexdigest()
    assert mtime.endswith("Z") and 0 <= rank <= 0.16


def test_print_com_nome_repetido_grava_o_nome_final(tmp_path):
    con = _uma_mao(tmp_path, "x.png")
    # outro print (outra mao) salvo com o mesmo nome: vai para processadas como "x (1).png", e o banco aponta para ele
    shutil.copy(TESTS / "31-19 55-9 bomb.png", tmp_path / "entrada" / "x.png")
    assert tracker.processar(tmp_path / "entrada" / "x.png", con, tmp_path) == "ok"
    assert sorted(p for (p,) in con.execute("SELECT png FROM hands")) == ["x (1).png", "x.png"]
    assert all((tmp_path / "processadas" / p).is_file() for (p,) in con.execute("SELECT png FROM hands"))


def test_o_mesmo_print_nao_vira_duas_maos(tmp_path):
    con = _uma_mao(tmp_path)
    with pytest.raises(__import__("sqlite3").IntegrityError):
        con.execute("INSERT INTO hands (id, png, n_jogadores, lido_em) VALUES ('2', 'a.png', 8, 'x')")


def test_banco_antigo_ganha_as_colunas_novas(tmp_path):
    import sqlite3
    velho = sqlite3.connect(tmp_path / "v.db")
    velho.executescript("CREATE TABLE hands (id TEXT PRIMARY KEY, png TEXT NOT NULL, n_jogadores INTEGER NOT NULL,"
                        " ante_bb REAL, board TEXT, unidade TEXT, lido_em TEXT NOT NULL);"
                        "CREATE TABLE jogadores (hand_id TEXT, pos TEXT, seat INTEGER, stack REAL, net REAL, cartas TEXT,"
                        " hero INTEGER NOT NULL, ordem_flop INTEGER, PRIMARY KEY (hand_id, pos));"
                        "INSERT INTO hands VALUES ('1', 'a.png', 8, 64, '', 'BB', 'x');")
    velho.commit()
    velho.close()
    con = tracker.abrir(tmp_path / "v.db")
    assert [c[1] for c in con.execute("PRAGMA table_info(hands)")] == list(tracker.COLS_HANDS)
    assert "nome" in {c[1] for c in con.execute("PRAGMA table_info(jogadores)")}
    assert con.execute("SELECT png FROM hands").fetchone() == ("a.png",)


def test_banco_com_a_coluna_de_naipe_perde_so_ela(tmp_path):  # a medida de 23/out que nao prestou
    con = _uma_mao(tmp_path)
    con.execute("ALTER TABLE hands ADD COLUMN pior_naipe REAL")
    con.execute("UPDATE hands SET pior_naipe = 1")
    con.commit()
    antes = con.execute(f"SELECT {','.join(tracker.COLS_HANDS)} FROM hands").fetchall()
    con.close()
    con = tracker.abrir(tmp_path / "t.db")
    assert [c[1] for c in con.execute("PRAGMA table_info(hands)")] == list(tracker.COLS_HANDS)
    assert con.execute("SELECT * FROM hands").fetchall() == antes
    with pytest.raises(__import__("sqlite3").IntegrityError):  # o indice do print continua
        con.execute("INSERT INTO hands (id, png, n_jogadores, lido_em) VALUES ('2', ?, 8, 'x')", (antes[0][1],))


def test_refazer_nao_mexe_no_banco_e_escreve_o_diff(tmp_path):
    con = _uma_mao(tmp_path)
    antes = tracker.assinatura(con, "1311804268404871168")
    con.execute("UPDATE acoes SET valor = 99 WHERE hand_id = '1311804268404871168' AND ordem = 6")  # leitura "velha"
    con.commit()
    contagem = tracker.refazer(con, tmp_path, processos=1)
    assert contagem["mudou"] == 1 and contagem["igual"] == 0
    assert con.execute("SELECT valor FROM acoes WHERE ordem = 6").fetchone() == (99,)  # o banco ficou igual
    diff = next(tmp_path.glob("refazer_*.txt")).read_text(encoding="utf-8")
    assert "mudou  1311804268404871168: acoes 6:" in diff and "99" in diff
    assert (tmp_path / "bombpot_novo.db").is_file() and (tmp_path / "processadas" / "a.png").is_file()
    assert tracker.aceitar(con, tmp_path).startswith("aceito")
    assert tracker.assinatura(con, "1311804268404871168") == antes
    assert not (tmp_path / "bombpot_novo.db").exists() and (tmp_path / "bombpot_antes_aceitar.db").is_file()
    assert (tmp_path / "REPLAYER_OK").read_text().strip() == tracker.versao_leitor()
    assert (tmp_path / "hh" / "maos" / "1311804268404871168.txt").is_file()


def test_aceitar_move_a_que_virou_recusa_e_a_que_voltou(tmp_path):
    con = _uma_mao(tmp_path)
    (tmp_path / "recusadas").mkdir(exist_ok=True)
    shutil.copy(TESTS / "31-19 55-9 bomb.png", tmp_path / "recusadas" / "b.png")  # recusada que agora le
    con.execute("INSERT INTO recusas VALUES ('b.png', 'leitor antigo', 'x')")
    (tmp_path / "processadas" / "a.png").write_bytes(b"nao e png")  # o print que agora nao le
    con.commit()
    contagem = tracker.refazer(con, tmp_path, processos=1)
    assert contagem["saiu"] == 1 and contagem["nova"] == 1
    assert tracker.aceitar(con, tmp_path).startswith("aceito")
    assert (tmp_path / "processadas" / "b.png").is_file() and (tmp_path / "recusadas" / "a.png").is_file()
    assert con.execute("SELECT png FROM recusas").fetchall() == [("a.png",)]
    assert not (tmp_path / "hh" / "maos" / "1311804268404871168.txt").exists()


def test_conferencia_sobrevive_ao_aceitar_e_trava_se_a_mao_mudar(tmp_path):
    import json
    con = _uma_mao(tmp_path)
    hid = "1311804268404871168"
    certa = tracker.assinatura(con, hid)
    errada = json.loads(json.dumps(certa))
    errada["acoes"][6][4] = 21.0  # o dono conferiu uma leitura que dizia 21 onde a nova diz 21,5
    con.execute("INSERT INTO conferencias VALUES (?, 1, NULL, NULL, ?, 'v', 'x', 'sorteio')", (hid, json.dumps(errada)))
    con.commit()
    assert tracker.refazer(con, tmp_path, processos=1)["conferida_mudou"] == 1
    msg = tracker.aceitar(con, tmp_path)
    assert msg.startswith("recusado, mao conferida mudou") and "acoes 6" in msg
    con.execute("UPDATE conferencias SET assinatura = ?", (json.dumps(certa),))
    con.commit()
    tracker.refazer(con, tmp_path, processos=1)
    assert tracker.aceitar(con, tmp_path).startswith("aceito")
    assert con.execute("SELECT count(*) FROM conferencias").fetchone() == (1,)


def test_aceitar_recusa_banco_novo_que_falha_na_auditoria(tmp_path):
    con = _uma_mao(tmp_path)
    tracker.refazer(con, tmp_path, processos=1)
    novo = tracker.abrir(tmp_path / "bombpot_novo.db")
    novo.execute("UPDATE jogadores SET cartas = '2s 9s' WHERE hero = 1")  # repete as cartas do board
    novo.commit()
    novo.close()
    msg = tracker.aceitar(con, tmp_path)
    assert msg.startswith("recusado, a auditoria") and "cartas_repetidas" in msg
    assert con.execute("SELECT cartas FROM jogadores WHERE hero = 1").fetchone() == ("Kc 10h",)
