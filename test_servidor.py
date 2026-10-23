"""Rotas novas do site: conferir/marcar (taxa de erro), selo, Hero x populacao, filtros e aliases da aba Jogadores."""
import json
import shutil
from pathlib import Path

import pytest

import decisoes
import resultados
import servidor
import tracker

TESTS = Path(__file__).parent / "tests"


@pytest.fixture(scope="module")
def base(tmp_path_factory):
    raiz = tmp_path_factory.mktemp("srv")
    (raiz / "entrada").mkdir()
    shutil.copy(TESTS / "ID_1311804268404871168.png", raiz / "entrada" / "a.png")
    shutil.copy(TESTS / "31-19 55-9 bomb.png", raiz / "entrada" / "b.png")
    c = tracker.abrir(raiz / "t.db")
    assert tracker.processar_pasta(raiz / "entrada", c, raiz, processos=1) == {"ok": 2}
    decisoes.reconstruir(c)
    resultados.reconstruir(c)
    c.close()
    return raiz


@pytest.fixture
def con(base, tmp_path, monkeypatch):
    raiz = tmp_path / "r"
    shutil.copytree(base, raiz)
    c = tracker.abrir(raiz / "t.db")
    monkeypatch.setattr(servidor, "RAIZ", raiz)
    monkeypatch.setenv("BOMBPOT_COPIA", str(raiz))
    servidor.Handler.saude_cache = None
    yield c
    c.close()


def test_teto_de_erro_clopper_pearson():
    assert servidor.teto_erro(0, 0) is None
    assert servidor.teto_erro(0, 100) == pytest.approx(0.0295, abs=1e-4)  # "regra de tres": 3/n
    assert servidor.teto_erro(0, 300) == pytest.approx(0.0099, abs=1e-4)
    assert servidor.teto_erro(1, 300) == pytest.approx(0.0157, abs=1e-4)
    assert servidor.teto_erro(0, 9) == pytest.approx(0.2831, abs=1e-4)   # as 9 maos do QA


def test_conferir_sorteia_marca_e_mede(con, tmp_path):
    tmp_path = tmp_path / "r"
    r = servidor.conferir(con, {})
    assert r["modo"] == "sorteio" and r["saude"]["conferidas"] == 0
    primeira = r["mao"]["hand_id"]
    assert r["mao"]["png"] in ("a.png", "b.png") and r["mao"]["linhas"]
    r = servidor.marcar(con, {"hand_id": primeira, "ok": True})
    assert r["saude"]["conferidas"] == 1 and r["saude"]["erros"] == 0 and r["saude"]["teto"] == 0.95
    segunda = r["mao"]["hand_id"]
    assert segunda != primeira  # so sorteia mao nao conferida
    with pytest.raises(ValueError):
        servidor.marcar(con, {"hand_id": segunda, "ok": False})  # erro sem dizer o campo
    antes = con.execute("SELECT count(DISTINCT hand_id) FROM decisoes").fetchone()[0]
    r = servidor.marcar(con, {"hand_id": segunda, "ok": False, "campo": "carta", "obs": "Kd era Kh"})
    assert r["mao"] is None and (r["saude"]["conferidas"], r["saude"]["erros"]) == (2, 1)
    assert con.execute("SELECT count(DISTINCT hand_id) FROM decisoes").fetchone()[0] == antes - 1  # saiu do estudo
    assert segunda not in {h for (h,) in con.execute("SELECT hand_id FROM resultados")}
    copia = json.loads((tmp_path / "conferencias_bombpot.json").read_text(encoding="utf-8"))
    assert {c["hand_id"] for c in copia["conferencias"]} == {primeira, segunda}
    gravada = json.loads(copia["conferencias"][0]["assinatura"])
    assert gravada == tracker.assinatura(con, copia["conferencias"][0]["hand_id"])  # o que a leitura dizia


def test_mao_da_fila_de_suspeitas_nao_entra_na_taxa(con):
    con.execute("UPDATE hands SET pior_rank = 0.13 WHERE png = 'a.png'")
    con.commit()
    s = servidor.saude(con)
    assert len(s["suspeitas"]) == 1
    servidor.Handler.saude_cache = s
    r = servidor.conferir(con, {"modo": "suspeita"})
    assert r["mao"]["png"] == "a.png"
    r = servidor.marcar(con, {"hand_id": r["mao"]["hand_id"], "ok": True, "modo": "suspeita"})
    assert r["saude"]["conferidas"] == 0 and r["saude"]["conferidas_total"] == 1 and r["saude"]["suspeitas"] == []


def test_carta_que_nao_decidiu_o_showdown_e_marcada(con):
    m = servidor.dados_da_mao(con, "1311804268404871168")
    por_pos = {j["pos"]: j for j in m["jogadores"]}
    assert por_pos["HJ"]["cartas"] and not por_pos["HJ"]["showdown"]  # Hero foldou: so o olho confere
    assert por_pos["CO"]["showdown"] and por_pos["UTG+1"]["showdown"]


def test_hero_x_populacao(con):
    leaks = servidor.leaks(con, {})
    assert leaks and all(set(l) >= {"hero", "pop", "z", "bb"} for l in leaks)
    for l in leaks:  # cada lado e a stat do painel com hero = 1 ou 0
        if "weak" in l["base"]:  # stat de cartas: os dois lados so no showdown (as do vilao so aparecem la)
            assert l["base"]["sd"] == [1] and l["bb"] is None
            continue
        stat = next(s for s in servidor.painel(con, {"hero": [0]}) if (s["secao"], s["nome"]) == (l["secao"], l["nome"]))
        assert l["pop"] == stat["v"]
        assert l["hero"] == next(s["v"] for s in servidor.painel(con, {"hero": [1]}) if s["nome"] == l["nome"] and s["secao"] == l["secao"])


def test_jogadores_filtra_por_mesa_e_data_e_mostra_o_intervalo(con):
    todos = resultados.jogadores(con)
    assert sum(j["maos"] for j in todos) == con.execute("SELECT count(*) FROM resultados").fetchone()[0]
    assert all(j["ic"] is None for j in todos if j["maos"] == 1)
    oito = resultados.jogadores(con, {"n_jogadores": [8]})
    assert sum(j["maos"] for j in oito) == con.execute("SELECT count(*) FROM resultados WHERE n = 8").fetchone()[0]
    assert resultados.jogadores(con, {"data": {"min": "2099-01-01"}}) == []
    assert resultados.jogadores(con, {"data": {"min": "x; DROP TABLE hands"}}) == todos  # data invalida e ignorada


def test_ic_do_bb100():
    import sqlite3
    c = sqlite3.connect(":memory:")
    c.executescript(resultados.ESQUEMA)
    c.executemany("INSERT INTO resultados VALUES (?, 'x', ?, 0, ?, 0, NULL, 0, 8, NULL)",
                  [(str(i), str(i), v) for i, v in enumerate([10.0, -10.0, 10.0, -10.0])])
    j = resultados.jogadores(c)[0]
    # desvio por mao 11,55; 1,96 x 11,55 / raiz(4) x 100 = 1131,6
    assert j["net"] == 0 and j["ic"] == pytest.approx(1131.6, abs=0.1)


def test_aliases_juntam_so_com_confirmacao(con):
    nomes = [n for (n,) in con.execute("SELECT nome FROM jogadores WHERE nome IS NOT NULL AND length(nome) >= 3 LIMIT 2")]
    a, b = nomes
    antes = {j["nome"]: j["maos"] for j in resultados.jogadores(con)}
    r = servidor.juntar(con, {"a": a, "b": b, "junta": True})
    depois = {j["nome"]: j["maos"] for j in r["jogadores"]}
    assert a not in depois and depois[b] == antes[a] + antes[b]
    servidor.juntar(con, {"a": a, "b": b, "junta": False})  # o dono voltou atras
    assert {j["nome"]: j["maos"] for j in resultados.jogadores(con)} == antes
    with pytest.raises(ValueError):
        servidor.juntar(con, {"a": a, "b": a, "junta": True})


def test_sugestoes_de_nick_partido(con):
    con.execute("UPDATE jogadores SET nome = 'zzTesteA' WHERE hand_id = '1311804268404871168' AND pos = 'BB'")
    con.execute("UPDATE jogadores SET nome = 'zzTesteB' WHERE hand_id <> '1311804268404871168' AND pos = 'BB'")
    par = {"zzTesteA", "zzTesteB"}
    assert any({s["a"], s["b"]} == par for s in resultados.sugestoes_alias(con))
    con.execute("UPDATE jogadores SET nome = 'zzTesteB' WHERE hand_id = '1311804268404871168' AND pos = 'SB'")
    assert not any({s["a"], s["b"]} == par for s in resultados.sugestoes_alias(con))  # sentaram juntos: nao e
    con.execute("UPDATE jogadores SET nome = 'outro' WHERE hand_id = '1311804268404871168' AND pos = 'SB'")
    con.execute("INSERT INTO aliases VALUES ('zzTesteA', 'zzTesteB', 0)")
    assert not any({s["a"], s["b"]} == par for s in resultados.sugestoes_alias(con))  # o dono ja disse que nao


def test_principais_seguem_a_cadeia(con):
    con.executemany("INSERT INTO aliases VALUES (?,?,1)", [("a", "b"), ("b", "c"), ("x", "y")])
    con.execute("INSERT INTO aliases VALUES ('y', 'x', 1)")  # ciclo nao trava
    p = resultados.principais(con)
    assert p["a"] == "c" and p["b"] == "c" and p["x"] in ("x", "y")
