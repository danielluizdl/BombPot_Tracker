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


def test_call_zero_sem_aposta_vira_check():  # ID_1318375308628545536: "Call $0.00" no turn e no river
    jog = {p: {"stack": 100, "cartas": None, "hero": 0, "ordem": i} for i, p in enumerate(("UTG", "HJ"), 1)}
    acoes = [("flop", "UTG", "Check", None, 0, 64.0), ("flop", "HJ", "Check", None, 0, 64.0),
             ("turn", "UTG", "Call", 0.0, 0, 64.0), ("turn", "HJ", "Bet", 10.0, 0, 64.0)]
    d = decisoes.linhas_da_mao("x", 2, 64.0, "", acoes, jog, False)
    assert (d[2][18], d[2][11], d[3][11]) == ("Check", "livre", "livre")  # e o HJ continua apostando "livre"


def test_mao_marcada_nao_usa_o_saldo_da_tela():  # o saldo com seguro/jackpot nao e o do poker
    jog = {p: {"stack": 100, "cartas": None, "hero": 0, "ordem": i, "net": n}
           for i, (p, n) in enumerate((("SB", 50.0), ("BTN", -50.0)), 1)}
    acoes = [("flop", "SB", "Bet", 42.0, 0, 16.0), ("flop", "BTN", "Call", 42.0, 0, 58.0)]
    for d in decisoes.linhas_da_mao("x", 2, 16.0, "", acoes, jog, True):
        col = dict(zip(decisoes.COLUNAS, d))
        assert (col["lucro"], col["spr"], col["ganhou"], col["marcada"]) == (None, None, None, 1)


def test_site_refaz_as_derivadas_quando_outra_conexao_grava(tmp_path):
    """O refazer/aceitar e o `nomes` mudam maos sem mudar a contagem: o site contava so as maos e ficava velho."""
    banco = tmp_path / "t.db"
    con = tracker.abrir(banco)
    tracker.gravar_linhas(con, *tracker.linhas(tracker.build(GABARITO, usar_armario=False, gravar=False), "g.png"))
    con.commit()
    site = servidor.Handler.__new__(servidor.Handler)  # so o atualizar(), sem servidor de verdade
    site.con = con
    servidor.Handler.versao_vista = -1
    site.atualizar()
    antes = con.execute("SELECT count(*) FROM decisoes").fetchone()[0]
    outra = tracker.abrir(banco)  # o terminal, com o site aberto
    outra.execute("DELETE FROM acoes WHERE ordem >= 10")
    outra.commit()
    site.atualizar()
    assert con.execute("SELECT count(*) FROM decisoes").fetchone()[0] == 10 < antes
    assert con.execute("SELECT count(*) FROM hands").fetchone() == (1,)  # a mesma contagem de maos


def test_consulta_soma_e_faixas(con):
    r = servidor.consultar(con, {"rua": ["flop"], "situacao": ["enfrenta aposta"]})
    # Hero e populacao juntos: BTN, SB, BB, UTG foldam e o UTG+1 da raise (o HJ/Hero nao enfrentou so a aposta)
    assert r["geral"]["acoes"] == {"Fold": 4, "Raise": 1}
    assert servidor.consultar(con, {"tamanho": ["0,34–0,45"]})["geral"]["acoes"] == {"Bet": 1}


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
    resp = r["geral"]["resposta"]  # a unica bet do flop: CO 21,5 em 64 = 0,336, e a mesa aumentou
    assert (resp["aumentado"], round(resp["ev"], 3), round(resp["tam"], 3)) == (1, -0.336, 0.336)
    assert r["grafico"]["0,34–0,45"]["usos"] == 1 and r["grafico"]["0,34–0,45"]["aumentado"] == 1
    # W$SD: UTG+1 (check, raise, call) e CO (bet, raise) chegam ao showdown e ganham (split +23)
    assert r["geral"]["wsd"] == [5, 5]
    grupos = {g["chave"]: g for g in r["grupos"]}
    assert grupos["enfrenta aposta"]["acoes"] == {"Fold": 4, "Raise": 1}
    assert grupos["enfrenta raise"]["n"] == 4 and grupos["livre"]["bets"] == {"0,34–0,45": 1}
    assert servidor.consultar(con, {"_agrupar": "x; DROP"})["grupos"] == []


def test_filtros_de_data_e_textura(con):
    # 16 decisoes no gabarito: 14 da populacao + 2 do Hero, agora somadas
    assert servidor.consultar(con, {"data": {"min": "2026-08-24", "max": "2026-08-24"}})["geral"]["n"] == 16
    assert servidor.consultar(con, {"data": {"min": "2026-08-25"}})["geral"] is None
    assert servidor.where({"texturas": ["river:brick"]}) == (" WHERE (instr(texturas, ?) > 0)", ["|river:brick|"])


def test_painel(con):
    stats = {s["nome"]: s for s in servidor.painel(con, {"rua": ["river"]}) if s["secao"] == "Flop"}
    # a base da stat (rua flop) vence o filtro do usuario na mesma coluna
    assert stats["Fold contra aposta"]["v"] == [4, 5]   # BTN, SB, BB, UTG foldam; UTG+1 da raise
    assert stats["Check-raise"]["v"] == [1, 4]          # dos 4 que checaram e enfrentaram a aposta, so o UTG+1
    sd = next(s for s in servidor.painel(con, {}) if s["nome"].startswith("Foi ao showdown"))
    assert sd["v"] == [2, 8]                            # UTG+1 e CO, de 8 jogadores (Hero junto)


def test_linha_da_mao_e_exportar(con, tmp_path):
    linha = servidor.linhas_de_mao(con, {"1311804268404871168"})["1311804268404871168"]
    assert linha[0][:3] == ("flop", "2s 9s 7d", 64.0)
    assert linha[0][3][-2:] == [("CO", "R96.7'"), ("UTG+1", "C21.7")]
    (tmp_path / "hh" / "maos").mkdir(parents=True)
    (tmp_path / "hh" / "maos" / "1311804268404871168.txt").write_text("PokerStars Hand #1311804268404871168\n", encoding="utf-8")
    texto, n = servidor.exportar(con, {"rua": ["flop"]}, tmp_path)
    assert n == 1 and texto.startswith("PokerStars Hand #1311804268404871168")
    assert servidor.exportar(con, {"rua": ["river"]}, tmp_path) == ("\n", 0)


def test_mesa_ignora_o_proprio_filtro(con):
    m = servidor.consultar(con, {"n_jogadores": {"min": 7, "max": 7}, "pos": ["BTN"], "rua": ["flop"]})["mesa"]
    # a contagem por jogadores ignora o filtro de 7, mas respeita o de posicao (BTN agiu no flop desta mao)
    assert m["por_n"] == {"8": 1}
    # os assentos ignoram o filtro de posicao, mas respeitam o de 7 jogadores: a mao tem 8, entao nada
    assert m["por_pos"] == {}
    m = servidor.consultar(con, {"pos": ["BTN"], "rua": ["flop"]})["mesa"]
    assert m["por_pos"]["SB"] == {"Check": 1, "Fold": 1} and m["por_pos"]["BTN"] == {"Fold": 1}
    assert m["por_pos"]["HJ"] == {"Check": 1, "Fold": 1}  # o HJ e o Hero: agora entra junto


def test_varias_quantidades_de_jogadores():
    assert servidor.where({"n_jogadores": [8, 7, 6, 5]}) == (" WHERE n_jogadores IN (?,?,?,?)", [8.0, 7.0, 6.0, 5.0])
    assert servidor.where({"n_jogadores": {"min": 5, "max": 8}}) == (" WHERE n_jogadores >= ? AND n_jogadores <= ?", [5.0, 8.0])


def test_resposta_guarda_o_tamanho_para_o_empate(con):
    g = servidor.consultar(con, {"rua": ["flop"]})["grafico"]["0,34–0,45"]
    assert round(g["tam"], 3) == 0.336  # empate do blefe = 0,336 / 1,336 = 25% de fold


def test_codigos_das_faixas(con):
    o = servidor.opcoes(con)
    assert o["codigos"]["0,46–0,66"] == "B50" and o["codigos"]["2,00+"] == "B200+"
    assert len(o["faixas"]) == 11 and o["codigos"]["0,01–0,05"] == "B5"
    # as do H2N (aba MDA) vem a parte, com rotulos que nao se repetem: os codigos somam as duas listas
    assert len(o["faixas_h2n"]) == 10 and len(o["codigos"]) == 21
    assert o["codigos"]["0,61–0,80"] == "B70" and o["codigos"]["0,00–0,20"] == "B10" and o["codigos"]["3,50+"] == "B400+"
    # o filtro escolhe o CASE pela lista do rotulo
    assert servidor.where({"tam_flop": ["0,41–0,60"]})[0] == f" WHERE {servidor.CASE_H2N.format(col='tam_flop')} IN (?)"
    assert servidor.where({"tam_flop": ["0,46–0,66"]})[0] == f" WHERE {servidor.CASE_FAIXA.format(col='tam_flop')} IN (?)"


def test_tamanho_da_linha_nas_ruas_anteriores():
    jog = {p: {"stack": 500, "net": 0, "cartas": None, "hero": 0, "ordem": i} for i, p in enumerate(("SB", "BTN"), 1)}
    acoes = [("flop", "SB", "Bet", 2.0, 0, 20.0), ("flop", "BTN", "Call", 2.0, 0, 22.0),     # SB: B 0,10 no flop
             ("turn", "SB", "Bet", 12.0, 0, 24.0), ("turn", "BTN", "Call", 12.0, 0, 36.0),   # SB: B 0,50 no turn
             ("river", "SB", "Bet", 30.0, 0, 48.0), ("river", "BTN", "Fold", None, 0, 78.0)]
    r = decisoes.linhas_da_mao("x", 2, 20.0, "", acoes, jog, False)
    river_sb = r[4]
    C = decisoes.COL
    assert (river_sb[C["tam_flop"]], river_sb[C["tam_turn"]], river_sb[C["tamanho"]]) == (0.1, 0.5, 0.625)
    assert (r[2][C["tam_flop"]], r[2][C["tam_turn"]]) == (0.1, None)  # no turn so o flop ja aconteceu
    assert (r[1][C["tam_flop"]], r[1][C["tam_turn"]]) == (None, None)  # o BTN so pagou
    # e do lado de quem pagou: o BTN pagou 0,10 no flop e 0,50 no turn, e no river enfrenta 0,625
    assert r[5][C["pos"]] == "BTN" and (r[5][C["enf_flop"]], r[5][C["enf_turn"]]) == (0.1, 0.5)
    assert (r[5][C["tamanho_enfrentado"]], r[5][C["acao"]]) == (0.625, "Fold")
    assert (r[3][C["enf_flop"]], r[3][C["enf_turn"]]) == (0.1, None)  # no turn, o BTN ja tinha pago 0,10 no flop
    w, p = servidor.where({"tam_flop": ["0,06–0,15"], "tam_turn": ["0,46–0,66"]})
    assert w.count("CASE") == 2 and p == ["0,06–0,15", "0,46–0,66"]


def test_faixa_livre_de_tamanho(con):
    assert servidor.where({"tamanho": {"min": 0.7, "max": 1.1}}) == (" WHERE tamanho >= ? AND tamanho <= ?", [0.7, 1.1])
    assert servidor.where({"tam_flop": {"min": "0.75", "max": ""}}) == (" WHERE tam_flop >= ?", [0.75])  # sem teto
    # a bet do CO no gabarito e 0,336: entra em 0,30-0,40 e sai em 0,34-0,40
    assert servidor.consultar(con, {"tamanho": {"min": 0.3, "max": 0.4}})["geral"]["acoes"] == {"Bet": 1}
    assert servidor.consultar(con, {"tamanho": {"min": 0.34, "max": 0.4}})["geral"] is None


def test_fold_contra_bet_e_quanto_precisava(con):
    d = servidor.consultar(con, {"rua": ["flop"]})["geral"]["defesa"]
    # enfrentando bet (0,336): BTN, SB, BB, UTG foldam, UTG+1 raise; enfrentando raise (0,5): MP, HJ foldam, CO raise;
    # o UTG+1 paga o shove (0,101). 9 decisoes, 6 folds.
    precisa = 5 * 0.336 / 1.336 + 3 * 0.5 / 1.5 + 0.101 / 1.101
    assert d[:2] == [9, 6] and d[2] == pytest.approx(precisa, abs=1e-6)


def test_allin_por_menos_escrito_como_raise_vira_call():
    """Caso real (ID_1328192555300286464): BB aposta 16, UTG+1 tem 17 e vai all-in por 9: o WPT escreve "Raise"."""
    jog = {p: {"stack": s, "net": 0, "cartas": None, "hero": 0, "ordem": i}
           for i, (p, s) in enumerate((("BB", 431), ("UTG+1", 17), ("HJ", 100)), 1)}
    acoes = [("flop", "BB", "Bet", 16.0, 0, 64.0), ("flop", "UTG+1", "Raise", 9.0, 1, 80.0),
             ("flop", "HJ", "Call", 16.0, 0, 89.0), ("turn", "HJ", "Check", None, 0, 105.0)]
    r = decisoes.linhas_da_mao("x", 3, 24.0, "", acoes, jog, False)
    utg1, hj, hj_turn = r[1], r[2], r[3]
    assert (utg1[18], utg1[19], utg1[11]) == ("Call", None, "enfrenta aposta")  # acao, tamanho, situacao
    assert (hj[11], hj[12]) == ("enfrenta aposta", 0.25)  # o HJ ainda enfrenta a bet de 16 em 64, nao um "raise"
    assert hj_turn[decisoes.COL["enf_flop"]] == 0.25  # e o tamanho que ele pagou no flop e 0,25, nao negativo
    assert r[0][decisoes.COL_RESPOSTA] == "pago"


def test_defesa_por_faixa_do_tamanho_enfrentado(con):
    d = servidor.consultar(con, {"rua": ["flop"]})["defesa"]
    # contra a bet de 0,336 (B40): 4 folds e o raise do UTG+1; contra o raise de 0,5 (B50): MP e HJ foldam, CO raise;
    # contra o shove do CO (0,101 = B10): o UTG+1 paga
    assert {k: (v["n"], v["Fold"], v["Call"], v["Raise"]) for k, v in d.items()} == {
        "0,34–0,45": (5, 4, 0, 1), "0,46–0,66": (3, 2, 0, 1), "0,06–0,15": (1, 0, 1, 0)}
    assert d["0,46–0,66"]["precisa"] == pytest.approx(3 * 0.5 / 1.5)


def test_linha_na_rua_quantos_pagaram_e_o_que_fez_depois_do_raise(con):
    """Gabarito, flop: 6 checks, CO bet 21,5; BTN/SB/BB/UTG fold; UTG+1 raise 75; MP/HJ fold; CO shove; UTG+1 call."""
    co_bet, utg1_raise, co_shove, utg1_call = linha(con, 6), linha(con, 11), linha(con, 14), linha(con, 15)
    assert (co_bet["linha_atual"], co_bet["n_calls"], co_bet["prox_acao"]) == ("", 0, "Raise")  # levou raise e deu shove
    assert (utg1_raise["linha_atual"], utg1_raise["n_calls"], utg1_raise["prox_acao"]) == ("X", 0, "Call")  # check-raise
    assert (co_shove["linha_atual"], co_shove["n_calls"], co_shove["prox_acao"]) == ("B", 1, None)  # o shove foi pago
    assert utg1_call["linha_atual"] == "XR" and linha(con, 7)["linha_atual"] == ""  # o BTN foldou sem ter agido


def test_mda_flop_do_gabarito(con):
    flop = {(n["atual"], n["situ"]): n for n in servidor.mda(con, {"filtros": {}})["flop"]}
    assert flop[("", "livre")]["acoes"] == {"Check": 6, "Bet": 1}          # 6 checks e a bet do CO
    assert flop[("", "enfrenta")]["acoes"] == {"Fold": 1}                  # o BTN, que ainda nao tinha agido
    assert flop[("X", "enfrenta")]["acoes"] == {"Fold": 5, "Raise": 1}     # checou e enfrenta: 5 folds e o check-raise
    assert flop[("B", "enfrenta")]["acoes"] == {"Raise": 1}                # o CO apostou, levou raise e deu shove
    assert flop[("XR", "enfrenta")]["acoes"] == {"Call": 1}                # o UTG+1 paga o shove
    bet = flop[("", "livre")]["tamanhos"]["Bet"]["0,21–0,40"]            # CO 21,5 em 64 = 0,336: B30 do H2N
    assert (bet["n"], bet["aumentado"], bet["depois"]["Raise"]) == (1, 1, 1)
    # levou raise: o blefe perdeu a bet (EV -0,336 pote); precisa foldar = 0,336 / 1,336
    assert (bet["respondidas"], bet["ev"], bet["tam"]) == (1, pytest.approx(-0.336), pytest.approx(0.336))
    shove = flop[("B", "enfrenta")]["tamanhos"]["Raise"]["0,00–0,20|AI"]  # aumento 0,101, all-in, pago por 1
    assert (shove["n"], shove["1 call"]) == (1, 1)
    # checaram e enfrentam: SB, BB, UTG foldam e UTG+1 da raise contra 0,336; MP e HJ foldam contra o raise de 0,5
    enf = flop[("X", "enfrenta")]["enfrentado"]
    assert enf == {"0,21–0,40": {"Fold": 3, "Raise": 1, "precisa": pytest.approx(4 * 0.336 / 1.336)},
                   "0,41–0,60": {"Fold": 2, "precisa": pytest.approx(2 * 0.5 / 1.5)}}
    # so o BTN: as acoes dele no flop
    btn = servidor.mda(con, {"filtros": {"pos": ["BTN"]}})["flop"]
    assert [(n["atual"], n["situ"], n["acoes"]) for n in btn] == [("", "enfrenta", {"Fold": 1})]


def test_mda_caminho_vira_filtro():
    c = {"flop": {"linha": "B", "faixa": "0,46–0,66", "lado": "aposta"}, "turn": {"linha": "XC", "faixa": "0,67–0,85", "lado": "pagou"}}
    assert servidor._caminho(c, "flop") == {}
    assert servidor._caminho(c, "turn") == {"linha_flop": ["B"], "tam_flop": ["0,46–0,66"]}
    assert servidor._caminho(c, "river") == {"linha_flop": ["B"], "tam_flop": ["0,46–0,66"],
                                             "linha_turn": ["XC"], "enf_turn": ["0,67–0,85"]}
