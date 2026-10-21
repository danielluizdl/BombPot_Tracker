"""Motor de filtros: decisoes do gabarito (tests/ID_1311804268404871168.png) conferidas a mao."""

import pytest

import decisoes
import servidor
import tracker
from test_tracker import GABARITO


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    con = tracker.abrir(tmp_path_factory.mktemp("d") / "t.db")
    tracker.gravar_linhas(con, *tracker.linhas(tracker.build(GABARITO, usar_armario=False, gravar=False), "g.png"))
    decisoes.reconstruir(con)
    return con


def linha(con, ordem):
    cur = con.execute("SELECT * FROM decisoes WHERE ordem = ?", (ordem,))
    return dict(zip([c[0] for c in cur.description], cur.fetchone()))


def test_aposta_do_co(con):
    d = linha(con, 6)  # 6 checks, CO aposta 21,5 em 64
    assert (d["pos"], d["situacao"], d["acao"], d["tamanho"]) == ("CO", "livre", "Bet", 0.336)
    assert (d["naipes_flop"], d["flop_alta"], d["flop_conectado"]) == ("two-tone", "T-", 0)  # 2s 9s 7d


def test_check_raise_do_utg1(con):
    d = linha(con, 11)  # raise para 75 contra 21,5: aumento 53,5 / (85,5 + 21,5) = 0,5
    assert (d["situacao"], d["tamanho_enfrentado"], d["checou_antes"], d["decisao_n"]) == ("enfrenta aposta", 0.336, 1, 2)
    # 8c 6h em 2s 9s 7d: sem par, falta o 5 ou o 10 -> OESD (6-7-8-9)
    assert (d["acao"], d["tamanho"], d["spr"], d["forca"], d["draw"], d["weak"]) == ("Raise", 0.5, 1.66, "Draw", "OESD", 0)


def test_btn_e_o_ip(con):
    d = linha(con, 7)
    assert (d["pos"], d["pos_rel"], d["ip"], d["acao"]) == ("BTN", "último", 1, "Fold")


def test_hero_tem_forca_mesmo_foldando(con):
    d = linha(con, 13)
    # Kc 10h em 2s 9s 7d: K e 10 acima do 9, sem par e sem draw -> Overcards (weak)
    assert (d["pos"], d["hero"], d["situacao"], d["forca"], d["weak"]) == ("HJ", 1, "enfrenta raise", "Overcards", 1)


def test_aposta_allin_escrita_como_raise_vira_bet():
    jog = {p: {"stack": 100, "cartas": None, "hero": 0, "ordem": i} for i, p in enumerate(("SB", "BTN"), 1)}
    acoes = [("flop", "SB", "Check", None, 0, 16.0), ("flop", "BTN", "Raise", 92.0, 1, 16.0)]
    d = decisoes.linhas_da_mao("x", 2, 16.0, "", acoes, jog, False)[1]
    assert (d[18], d[11], d[20]) == ("Bet", "livre", 1)  # acao, situacao, allin


def test_consulta_soma_e_faixas(con):
    r = servidor.consultar(con, {"rua": ["flop"], "situacao": ["enfrenta aposta"]})
    assert r["acoes"]["pop"] == {"Fold": 4, "Raise": 1}  # BTN, SB, BB, UTG foldam; UTG+1 raise
    assert r["raise"]["pop"] == {"0,46–0,66": 1}
    assert servidor.consultar(con, {"tamanho": ["0,34–0,45"]})["acoes"]["pop"] == {"Bet": 1}


def test_filtro_fora_da_lista_branca_e_ignorado():
    assert servidor.where({"pos); DROP TABLE hands; --": ["x"]}) == ("", [])
    assert servidor.where({"pote": {"min": "50", "max": ""}}) == (" WHERE pote >= ?", [50.0])


def test_colunas_novas_no_gabarito(con):
    co_bet, utg1_call = linha(con, 6), linha(con, 15)
    assert (co_bet["resposta"], linha(con, 11)["resposta"], linha(con, 14)["resposta"]) == ("aumentado", "aumentado", "pago")
    assert co_bet["data"] == "2026-08-24"  # hora do print: 2026-08-24 05:49:57
    # lucro a partir da decisao = net + ja investido: o call do UTG+1 tinha 8 + 75 dentro e terminou +23
    assert (utg1_call["lucro"], utg1_call["sd"], utg1_call["ganhou"]) == (106.0, 1, 1)
    assert (linha(con, 0)["lucro"], linha(con, 0)["sd"]) == (0.0, 0)  # SB: check e fold, perde so a entrada


def test_data_do_id():
    assert decisoes.data_do_id("1307617141335379968") == "2026-08-12"  # print: 2026-08-12 16:31:48
    assert decisoes.data_do_id("abc") is None and decisoes.data_do_id("12") is None


@pytest.mark.parametrize("board, i_rua, esperado", [
    ("Kc 7s 2h Ad", 1, ["turn:overcard"]),
    ("Kc 7s 2h 7d", 1, ["turn:pareia"]),
    ("Kh 7h 2c 4h", 1, ["turn:3º do naipe"]),
    ("Kh 7h 2h 4h", 1, ["turn:4º do naipe"]),
    ("9c 8s 2h 7d", 1, ["turn:sequência possível"]),
    ("9c 8s 6h 7d", 1, ["turn:4 p/ sequência"]),
    ("Kc 7s 2h 3d", 1, ["turn:brick"]),
    ("Kc 7s 2h 3d Kd", 2, ["river:pareia"]),
])
def test_texturas(board, i_rua, esperado):
    assert decisoes.tags_rua(decisoes.cartas(board), i_rua) == esperado


def test_linha_do_jogador():
    jog = {p: {"stack": 200, "net": 0, "cartas": None, "hero": 0, "ordem": i} for i, p in enumerate(("SB", "BTN"), 1)}
    acoes = [("flop", "SB", "Check", None, 0, 16.0), ("flop", "BTN", "Bet", 8.0, 0, 16.0),
             ("flop", "SB", "Call", 8.0, 0, 24.0), ("turn", "SB", "Check", None, 0, 32.0),
             ("turn", "BTN", "Check", None, 0, 32.0), ("river", "SB", "Bet", 20.0, 0, 32.0)]
    r = decisoes.linhas_da_mao("x", 2, 16.0, "", acoes, jog, False)
    assert (r[3][33], r[5][33], r[5][34]) == ("XC", "XC", "X")  # linha_flop / linha_turn
    assert r[1][decisoes.COL_RESPOSTA] == "pago"


def test_api_resposta_resultado_agrupar(con):
    r = servidor.consultar(con, {"rua": ["flop"], "_agrupar": "situacao"})
    bet = r["resposta"]["Bet"]["pop"]["0,34–0,45"]  # CO 21,5 em 64 = 0,336; a mesa aumentou
    assert (bet["aumentado"], round(bet["ev"], 3)) == (1, -0.336)
    assert r["resultado"]["pop"]["sd"] == 5  # UTG+1 (check, raise, call) e CO (bet, raise) chegam ao showdown
    assert r["agrupado"]["pop"]["enfrenta aposta"] == {"Fold": 4, "Raise": 1, "_weak": [0, 1]}
    assert servidor.consultar(con, {"_agrupar": "x; DROP"})["agrupado"] is None


def test_filtros_de_data_e_textura(con):
    assert servidor.consultar(con, {"data": {"min": "2026-08-24", "max": "2026-08-24"}})["total"]["pop"]["decisoes"] == 14
    assert servidor.consultar(con, {"data": {"min": "2026-08-25"}})["total"] == {}
    assert servidor.where({"texturas": ["river:brick"]}) == (" WHERE (instr(texturas, ?) > 0)", ["|river:brick|"])


def test_painel(con):
    stats = {s["nome"]: s for s in servidor.painel(con, {"rua": ["river"]}) if s["secao"] == "Flop"}
    # a base da stat (rua flop) vence o filtro do usuario na mesma coluna
    assert stats["Fold contra aposta"]["pop"] == [4, 5]   # BTN, SB, BB, UTG foldam; UTG+1 da raise
    assert stats["Check-raise"]["pop"] == [1, 4]          # dos 4 que checaram e enfrentaram a aposta, so o UTG+1
    sd = next(s for s in servidor.painel(con, {}) if s["nome"].startswith("Foi ao showdown"))
    assert (sd["pop"], sd["hero"]) == ([2, 7], [0, 1])    # UTG+1 e CO de 7 na populacao; o Hero foldou


def test_linha_da_mao_e_exportar(con, tmp_path):
    linha = servidor.linhas_de_mao(con, {"1311804268404871168"})["1311804268404871168"]
    assert linha[0][:3] == ("flop", "2s 9s 7d", 64.0)
    assert linha[0][3][-2:] == [("CO", "R96.7'"), ("UTG+1", "C21.7")]
    (tmp_path / "hh" / "maos").mkdir(parents=True)
    (tmp_path / "hh" / "maos" / "1311804268404871168.txt").write_text("PokerStars Hand #1311804268404871168\n", encoding="utf-8")
    texto, n = servidor.exportar(con, {"rua": ["flop"]}, tmp_path)
    assert n == 1 and texto.startswith("PokerStars Hand #1311804268404871168")
    assert servidor.exportar(con, {"rua": ["river"]}, tmp_path) == ("\n", 0)
