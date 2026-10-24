"""Resultados por jogador (aba Jogadores): avaliador, equity, quanto cada um pos, EV ajustado e o banco real."""
import sqlite3
from collections import defaultdict
from pathlib import Path

import pytest

import resultados as r

BANCO = Path(__file__).resolve().parent / "bombpot.db"
h = lambda s: [r.carta(c) for c in s.split()]  # noqa: E731


def test_rank7_escada_e_dez_com_dois_digitos():
    escada = ["Ah Kd 9c 7s 5h 3d 2c", "Ah Ad 9c 7s 5h 3d 2c", "Ah Ad 9c 9s 5h 3d 2c", "Ah Ad Ac 7s 5h 3d 2c",
              "Ah Kd Qc Js 10h 3d 2c", "Ah Kh 9h 7h 5h 3d 2c", "Ah Ad Ac 7s 7h 3d 2c", "Ah Ad Ac As 5h 3d 2c",
              "Ah Kh Qh Jh 10h 3d 2c"]
    for fraca, forte in zip(escada, escada[1:]):
        assert r.rank7(h(forte)) > r.rank7(h(fraca)), forte
    assert r.rank7(h("Ah 2d 3c 4s 5h Kd Qc")) < r.rank7(h("6h 2d 3c 4s 5h Kd Qc"))  # roda < seis alto
    assert r.carta("10c") == r.carta("Tc") == 8 * 4 + 0


def test_equity_exata_no_flop():
    """AhAs x KhKs em Kd 7c 2s: o AA so ganha com runner-runner, 85 de 990 pares de turn e river (gabarito do MetaLens)."""
    e = r.equity([(100.0, ["A", "K"])], {"A": h("Ah As"), "K": h("Kh Ks")}, h("Kd 7c 2s"))
    assert e["A"] == pytest.approx(100 * 85 / 990) and e["A"] + e["K"] == pytest.approx(100)


def test_investido_com_normalizacoes_do_wpt_e_bet_devolvida():
    # SB: all-in sem bet antes (WPT escreve Raise) de 30; BTN aumenta para 80; SB nao tem mais nada
    acoes = [("flop", "SB", "Raise", 30.0, 1), ("flop", "BTN", "Raise", 80.0, 0)]
    put = r.investido(2, 20.0, ["SB", "BTN"], acoes)
    assert put == {"SB": 40.0, "BTN": 40.0}  # 10 de entrada + 30; os 50 a mais do BTN voltam
    # all-in por menos escrito como Raise: e call, e o investido nao soma
    acoes = [("flop", "BB", "Bet", 16.0, 0), ("flop", "UTG+1", "Raise", 9.0, 1), ("flop", "HJ", "Call", 16.0, 0)]
    put = r.investido(3, 24.0, ["BB", "UTG+1", "HJ"], acoes)
    assert put == {"BB": 24.0, "UTG+1": 17.0, "HJ": 24.0}


def test_allin_no_flop_ev_e_a_parte_da_equity():
    """Bomb pot HU de 20 (10 cada): SB aposta 40, BTN all-in 100, SB paga; o pote de 220 paga 2 de rake ao KK."""
    acoes = [("flop", "SB", "Bet", 40.0, 0), ("flop", "BTN", "Raise", 100.0, 1), ("flop", "SB", "Call", 60.0, 0)]
    jog = {"SB": (-110.0, "Ah As"), "BTN": (108.0, "Kh Ks")}
    res = r.resultados_da_mao(2, 20.0, "Kd 7c 2s 9h 3c", acoes, jog)
    assert res["SB"][:2] == (-110.0, 1) and res["BTN"][:2] == (108.0, 1)
    assert res["SB"][2] == pytest.approx(round(218 * 85 / 990 - 110, 2))
    assert res["SB"][2] + res["BTN"][2] == pytest.approx(-2, abs=0.02)  # soma zero, menos o rake


def test_sem_allin_ev_e_o_net_e_quem_folda_nao_vai_ao_showdown():
    acoes = [("flop", "SB", "Bet", 10.0, 0), ("flop", "BB", "Fold", None, 0), ("flop", "BTN", "Call", 10.0, 0),
             ("turn", "SB", "Check", None, 0), ("turn", "BTN", "Check", None, 0),
             ("river", "SB", "Check", None, 0), ("river", "BTN", "Check", None, 0)]
    jog = {"SB": (-20.0, "Ah As"), "BB": (-10.0, None), "BTN": (29.0, "Kh Ks")}
    res = r.resultados_da_mao(3, 30.0, "Kd 7c 2s 9h 3c", acoes, jog)
    assert res == {"SB": (-20.0, 1, -20.0), "BB": (-10.0, 0, -10.0), "BTN": (29.0, 1, 29.0)}


def test_side_pot_multiway():
    """BTN all-in curto de 20 no flop; SB e BB vao all-in por 100: o BTN so disputa o pote principal."""
    acoes = [("flop", "SB", "Bet", 100.0, 1), ("flop", "BB", "Call", 100.0, 1), ("flop", "BTN", "Raise", 20.0, 1)]
    jog = {"SB": (-110.0, "Qh Qs"), "BB": (-110.0, "Jh Js"), "BTN": (220.0, "Ah Ad")}
    res = r.resultados_da_mao(3, 30.0, "2c 7d 9s 4h 3c", acoes, jog)
    evs = {p: v[2] for p, v in res.items()}
    assert sum(evs.values()) == pytest.approx(0, abs=0.02)
    assert evs["BTN"] < 90 - 30 and evs["SB"] > evs["BB"]  # o BTN leva no maximo o principal (3 x 30) menos o que pos


real = pytest.mark.skipif(not BANCO.is_file(), reason="sem bombpot.db nesta máquina")


@pytest.fixture(scope="module")
def con():
    import tracker

    c = tracker.abrir(BANCO)
    r.reconstruir(c)
    return c


def test_call_allin_vem_com_o_total_da_rua():
    """ID_1312645872378032128, river: SB bet 110, UTG all-in 1.157, SB "Call 299 All-in" -> -388 = 8 + 37,5 + 43,5 + 299.

    No call all-in o WPT escreve o total dele na rua (299), nao o complemento (189)."""
    acoes = [("flop", "SB", "Bet", 37.5, 0), ("flop", "UTG", "Call", 37.5, 0),
             ("turn", "SB", "Bet", 43.5, 0), ("turn", "UTG", "Call", 43.5, 0),
             ("river", "SB", "Bet", 110.0, 0), ("river", "UTG", "Raise", 1157.0, 1), ("river", "SB", "Call", 299.0, 1)]
    put = r.investido(7, 56.0, ["SB", "UTG", "BB"], acoes)
    assert put["SB"] == 388.0 and put["UTG"] == 388.0  # os 858 a mais do UTG voltam


@real
def test_banco_real_quem_perde_perdeu_o_que_pos(con):
    """Prova o `investido` contra o saldo do print em toda mao limpa: quem foldou perdeu o que pos (o WPT arredonda o
    saldo em BB: ate 0,5); ninguem perde mais do que pos; quem foi ate o fim pode ter recuperado parte (pote dividido,
    side pot)."""
    acoes = defaultdict(list)
    for hid, *resto in con.execute("SELECT hand_id, rua, pos, verbo, valor, allin FROM acoes ORDER BY hand_id, ordem"):
        acoes[hid].append(tuple(resto))
    erradas = []
    for hid, n, ante in con.execute("SELECT id, n_jogadores, ante_bb FROM hands WHERE obs IS NULL"):
        nets = dict(con.execute("SELECT pos, net FROM jogadores WHERE hand_id = ?", (hid,)))
        put = r.investido(n, ante, list(nets), acoes[hid])
        foldaram = {a[1] for a in acoes[hid] if a[2] == "Fold"}
        for p, v in nets.items():
            if (p in foldaram and abs(-v - put[p]) > 0.5) or -v > put[p] + 0.5:
                erradas.append((hid, p, v, put[p]))
    assert erradas == []


@real
def test_banco_real_ev_soma_o_mesmo_que_o_net_e_bate_sem_allin(con):
    por_mao = con.execute("SELECT r.hand_id, sum(net), sum(ev), sum(ev != net), h.obs IS NOT NULL, count(*) = h.n_jogadores "
                          "FROM resultados r JOIN hands h ON h.id = r.hand_id GROUP BY 1").fetchall()
    # o EV so redistribui o pote; na mao marcada o rake e estimado pelos ganhadores (saldo arredondado: ate 0,5)
    assert all(abs(net - ev) < 0.05 for _, net, ev, _, marcada, _ in por_mao if not marcada)
    assert all(abs(net - ev) <= 0.55 for _, net, ev, _, marcada, inteira in por_mao if marcada and inteira)
    allin = {linha[0] for linha in por_mao if linha[3]}
    assert len(allin) > 50
    # mao sem all-in antes do river: EV = net em todo mundo
    sem_allin = con.execute("SELECT count(*) FROM resultados WHERE ev != net AND hand_id IN (SELECT hand_id FROM acoes "
                            "WHERE rua = 'river' AND verbo IN ('Check','Bet','Call','Raise','Fold'))").fetchone()[0]
    assert sem_allin == 0


@real
def test_banco_real_jogadores_e_serie(con):
    js = r.jogadores(con)
    assert [j["maos"] for j in js] == sorted((j["maos"] for j in js), reverse=True)
    total = con.execute("SELECT count(*) FROM resultados").fetchone()[0]
    assert sum(j["maos"] for j in js) == total
    topo = js[0]
    s = r.serie(con, topo["nome"])
    ultimo = s["pontos"][-1]
    assert s["maos"] == topo["maos"] and ultimo[0] == topo["maos"]
    assert (ultimo[1], ultimo[2], ultimo[3]) == pytest.approx((topo["net"], topo["sd"], topo["ev"]), abs=0.05)
    assert len(s["pontos"]) <= 2 * 1000 + 2


def test_serie_reduzida_guarda_pico_vale_e_fim():
    c = sqlite3.connect(":memory:")
    c.executescript(r.ESQUEMA)
    nets = [(-1) ** (i // 7) * (i % 5) for i in range(5000)]
    c.executemany("INSERT INTO resultados VALUES (?,?,?,?,?,?,?,?,?,?)",
                  [(str(10 ** 18 + i), "x", "SB", 0, v, 0, v, 0.0, 8, None) for i, v in enumerate(nets)])
    s = r.serie(c, "x", maximo=100)
    acumulado = [0.0]
    for v in nets:
        acumulado.append(acumulado[-1] + v)
    assert len(s["pontos"]) <= 202 and s["pontos"][-1][1] == pytest.approx(acumulado[-1])
    assert min(p[1] for p in s["pontos"]) == pytest.approx(min(acumulado))
    assert max(p[1] for p in s["pontos"]) == pytest.approx(max(acumulado))


def test_jackpot_vira_saldo_de_poker():
    """O texto que a leitura grava na mao marcada: a parte do saldo que e poker."""
    obs = "SB: $ 24,00 do ganho vieram do jackpot da casa, nao do poker (saldo de poker: $ 38,32)"
    assert r.sem_jackpot(obs) == {"SB": pytest.approx(38.32 / 62.32)}
    assert r.sem_jackpot("BB: 126 BB do ganho vieram do jackpot da casa, nao do poker (saldo de poker: 200 BB)") == \
        {"BB": pytest.approx(200 / 326)}
    assert r.sem_jackpot("mao com seguro: o valor pago nao esta no log") == {}


def test_bate_com_o_poker():
    assert r.bate_com_o_poker(-110.0, -110.0, 220) and not r.bate_com_o_poker(-0.5, -80.5, 200)  # seguro pago
    assert r.bate_com_o_poker(108.0, 110.0, 220) and not r.bate_com_o_poker(150.0, 110.0, 220)
    # pote grande: 3,5% de 400 seriam 14 BB; o rake medido nunca passa de 3,1 BB
    assert r.bate_com_o_poker(397.0, 400.0, 400) and not r.bate_com_o_poker(390.0, 400.0, 400)


@real
def test_banco_real_dlzinn_em_toda_mao_em_que_esta(con):
    """Toda mao com o dLzinN na mesa entra para ele, inclusive as com seguro/jackpot (o seguro foi sempre de outro)."""
    na_mesa = con.execute("SELECT count(DISTINCT hand_id) FROM jogadores WHERE nome = 'dLzinN'").fetchone()[0]
    assert con.execute("SELECT count(*) FROM resultados WHERE nome = 'dLzinN'").fetchone()[0] == na_mesa > 1500
    # o jackpot dele (ID_1317652969606176768): saldo 311,6 BB na tela, $24 de jackpot, saldo de poker $38,32
    net = con.execute("SELECT net FROM resultados WHERE hand_id = '1317652969606176768' AND nome = 'dLzinN'").fetchone()[0]
    assert net == pytest.approx(311.6 * 38.32 / 62.32, abs=0.01)
    assert con.execute("SELECT count(*) FROM jogadores WHERE nome IS NULL").fetchone()[0] == 0


@real
def test_banco_real_jackpot_de_todos(con):
    """Os jackpots da casa (9 em 24/out; cresce com os prints novos): o net fica so com o poker, e net + jackpot e
    o saldo da tela."""
    linhas = con.execute("SELECT r.nome, r.net, r.jackpot, j.net FROM resultados r JOIN jogadores j "
                         "ON j.hand_id = r.hand_id AND j.pos = r.pos WHERE r.jackpot != 0").fetchall()
    assert len(linhas) >= 9
    assert all(net + jp == pytest.approx(tela, abs=0.02) for _, net, jp, tela in linhas)
    dl = r.serie(con, "dLzinN")["pontos"][-1]
    assert dl[5] == pytest.approx(120.0)  # o jackpot de $24 a $0,20 o BB


@real
def test_banco_real_seguro_pago_vira_o_resultado_do_poker(con):
    """Regra do Replayer para quem o seguro pagou e perdeu tudo (o saldo e menos o que investiu), com as cartas
    dizendo quem perdeu. ID_1325667294087127040: CO (J7) all-in contra a roda do BB; a tela mostra -16,5 (o seguro
    devolveu 84,5) e o poker foi -101. Quem levou parte do pote (UTG em ID_1317681494711513088, side pot) fica fora."""
    def net(hid, pos):
        linha = con.execute("SELECT net FROM resultados WHERE hand_id = ? AND pos = ?", (hid, pos)).fetchone()
        return linha and linha[0]
    assert net("1325667294087127040", "CO") == -101.0
    assert net("1318036774774321152", "HJ") == -80.5
    assert net("1320577398652190720", "SB") == -71.0 and net("1320577398652190720", "MP") == 174.5
    assert net("1317681494711513088", "UTG") is None
    # desde o leitor 28-bdf0a4c (aceito em 23/out) o proprio Replayer grava o saldo de poker de quem o seguro pagou:
    # os tres saldos acima ja vem da leitura e o resultados.py nao reconstroi mais nenhum
    assert r.FORA["seguro_reconstruido"] == 0 and r.FORA["saldo_nao_confere"] == 1
