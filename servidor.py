"""O site do tracker: filtros livres sobre a tabela `decisoes`, estilo H2N.

    python servidor.py [porta]     reconstroi `decisoes`, sobe em 127.0.0.1 e abre o navegador

So escuta em 127.0.0.1: o banco e os prints nao saem da maquina.
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import decisoes
import tracker

RAIZ = Path(__file__).resolve().parent
PUBLIC = RAIZ / "public"

# As faixas de tamanho, em fracao do pote. Cada uma inclui o limite de cima (1,00 cai em 0,86-1,00).
FAIXAS = [(0.15, "0,01–0,15"), (0.33, "0,16–0,33"), (0.45, "0,34–0,45"), (0.66, "0,46–0,66"),
          (0.85, "0,67–0,85"), (1.00, "0,86–1,00"), (1.20, "1,01–1,20"), (1.50, "1,21–1,50"),
          (2.00, "1,51–2,00"), (None, "2,00+")]
CASE_FAIXA = "CASE " + " ".join(f"WHEN {{col}} <= {teto} THEN '{nome}'" for teto, nome in FAIXAS if teto) \
    + f" ELSE '{FAIXAS[-1][1]}' END"

# coluna -> tipo do filtro. 'lista' = IN (...), 'faixa' = min/max, 'faixas' = faixas de tamanho acima,
# 'tags' = contem qualquer uma das tags (texturas nao exclusivas), 'datas' = periodo YYYY-MM-DD.
FILTROS = {
    "hero": "lista", "pos": "lista", "pos_rel": "lista", "ip": "lista", "rua": "lista",
    "situacao": "lista", "decisao_n": "lista", "checou_antes": "lista", "agressor_anterior": "lista",
    "rua_anterior_checada": "lista", "acao_anterior": "lista", "acao": "lista", "allin": "lista",
    "forca": "lista", "draw": "lista", "weak": "lista", "naipes_flop": "lista", "flop_pareado": "lista", "flop_conectado": "lista",
    "flop_alta": "lista", "board_pareado": "lista", "board_flush": "lista", "marcada": "lista",
    "n_jogadores": "faixa", "n_vivos": "faixa", "pote": "faixa", "spr": "faixa",
    "tamanho": "faixas", "tamanho_enfrentado": "faixas",
    "resposta": "lista", "linha_flop": "lista", "linha_turn": "lista", "sd": "lista", "ganhou": "lista",
    "texturas": "tags", "data": "datas",
}
DATA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def expressao(col: str) -> str | None:
    """A coluna como chave de agrupamento (so as da lista branca; faixas viram o nome da faixa)."""
    tipo = FILTROS.get(col)
    if tipo == "lista":
        return col
    if tipo == "faixas":
        return CASE_FAIXA.format(col=col)
    return None


def where(filtros: dict) -> tuple[str, list]:
    """Filtros do site -> WHERE parametrizado. Coluna fora da lista branca e ignorada."""
    partes, params = [], []
    for col, valor in filtros.items():
        tipo = FILTROS.get(col)
        if tipo == "lista" and isinstance(valor, list) and valor:
            partes.append(f"{col} IN ({','.join('?' * len(valor))})")
            params += valor
        elif tipo == "faixa" and isinstance(valor, dict):
            if valor.get("min") not in (None, ""):
                partes.append(f"{col} >= ?")
                params.append(float(valor["min"]))
            if valor.get("max") not in (None, ""):
                partes.append(f"{col} <= ?")
                params.append(float(valor["max"]))
        elif tipo == "faixas" and isinstance(valor, list) and valor:
            partes.append(f"{CASE_FAIXA.format(col=col)} IN ({','.join('?' * len(valor))})")
            params += valor
        elif tipo == "tags" and isinstance(valor, list) and valor:
            partes.append("(" + " OR ".join(f"instr({col}, ?) > 0" for _ in valor) + ")")
            params += [f"|{v}|" for v in valor]
        elif tipo == "datas" and isinstance(valor, dict):
            for lado, op in (("min", ">="), ("max", "<=")):
                if DATA_RE.match(str(valor.get(lado) or "")):
                    partes.append(f"{col} {op} ?")
                    params.append(valor[lado])
    return (" WHERE " + " AND ".join(partes)) if partes else "", params


def contagem(con, sql_where: str, params: list, expr: str, extra: str = "") -> dict:
    """{'pop': {valor: n}, 'hero': {valor: n}} agrupando pela expressao."""
    sql = f"SELECT hero, {expr}, count(*) FROM decisoes{sql_where}{extra} GROUP BY 1, 2"
    saida: dict = {"pop": {}, "hero": {}}
    for hero, chave, n in con.execute(sql, params):
        if chave is not None:
            saida["hero" if hero else "pop"][chave] = n
    return saida


def consultar(con: sqlite3.Connection, filtros: dict) -> dict:
    w, p = where(filtros)
    e = " AND " if w else " WHERE "
    total = {("hero" if h else "pop"): (n, m) for h, n, m in con.execute(
        f"SELECT hero, count(*), count(DISTINCT hand_id) FROM decisoes{w} GROUP BY hero", p)}
    maos = [dict(zip(("hand_id", "png", "rua", "pos", "hero", "situacao", "acao", "tamanho", "allin", "forca",
                      "cartas", "data"), r))
            for r in con.execute(
                "SELECT d.hand_id, h.png, d.rua, d.pos, d.hero, d.situacao, d.acao, d.tamanho, d.allin, d.forca, "
                "j.cartas, d.data "
                f"FROM (SELECT * FROM decisoes{w}) d JOIN hands h ON h.id = d.hand_id "
                "JOIN jogadores j ON j.hand_id = d.hand_id AND j.pos = d.pos "
                "ORDER BY d.hand_id DESC, d.ordem LIMIT 300", p)]
    linhas = linhas_de_mao(con, {m["hand_id"] for m in maos})
    for m in maos:
        m["linha"] = linhas.get(m["hand_id"], [])
    return {
        "total": {k: {"decisoes": v[0], "maos": v[1]} for k, v in total.items()},
        "acoes": contagem(con, w, p, "acao"),
        "bet": contagem(con, w, p, CASE_FAIXA.format(col="tamanho"), f"{e}acao = 'Bet'"),
        "raise": contagem(con, w, p, CASE_FAIXA.format(col="tamanho"), f"{e}acao = 'Raise'"),
        "allin": contagem(con, w, p, "acao", f"{e}allin = 1"),
        "forca": contagem(con, w, p, "forca"),
        "draw": contagem(con, w, p, "draw"),
        "weak": contagem(con, w, p, "weak"),
        "resposta": resposta(con, w, p, e),
        "resultado": resultado(con, w, p),
        "agrupado": agrupar(con, w, p, filtros.get("_agrupar")),
        "maos": maos,
    }


LETRA = {"Check": "X", "Bet": "B", "Call": "C", "Raise": "R", "Fold": "F"}


def linhas_de_mao(con, ids: set[str]) -> dict[str, list]:
    """A mao em uma linha por rua, como a lista de maos do H2N: [(rua, board, pote, [(pos, 'B21.5'), ...])].

    Valores em BB; o apostrofo marca all-in (B92'), como no H2N."""
    if not ids:
        return {}
    marcas = ",".join("?" * len(ids))
    boards = dict(con.execute(f"SELECT id, board FROM hands WHERE id IN ({marcas})", list(ids)))
    saida: dict[str, list] = {}
    corte = {"flop": slice(0, 3), "turn": slice(3, 4), "river": slice(4, 5)}
    apostou = False
    for hid, rua, pos, verbo, valor, allin, pote in con.execute(
            f"SELECT hand_id, rua, pos, verbo, valor, allin, pote_antes FROM acoes "
            f"WHERE hand_id IN ({marcas}) ORDER BY hand_id, ordem", list(ids)):
        if verbo not in LETRA:
            continue
        ruas = saida.setdefault(hid, [])
        if not ruas or ruas[-1][0] != rua:
            ruas.append((rua, " ".join((boards.get(hid) or "").split()[corte[rua]]), pote, []))
            apostou = False
        if verbo == "Raise" and not apostou:  # o WPT escreve a aposta all-in como "Raise"
            verbo = "Bet"
        apostou = apostou or verbo in ("Bet", "Raise")
        quanto = "" if valor is None else f"{valor:g}"
        ruas[-1][3].append((pos, f"{LETRA[verbo]}{quanto}{chr(39) if allin else ''}"))
    return saida


def resposta(con, w: str, p: list, e: str) -> dict:
    """Bet/Raise por faixa: como a mesa respondeu e o EV do blefe puro (% do pote).

    EV de um blefe que nunca ganha quando pago: +1 pote se todos foldam, -tamanho se nao (H2N: F*100-(1-F)*size)."""
    saida: dict = {}
    sql = (f"SELECT acao, hero, {CASE_FAIXA.format(col='tamanho')}, resposta, count(*), "
           "sum(CASE WHEN resposta = 'todos foldam' THEN 1.0 ELSE -tamanho END) "
           f"FROM decisoes{w}{e}acao IN ('Bet', 'Raise') AND resposta IS NOT NULL AND tamanho IS NOT NULL "
           "GROUP BY 1, 2, 3, 4")
    for acao, hero, faixa, resp, n, ev in con.execute(sql, p):
        celula = saida.setdefault(acao, {}).setdefault("hero" if hero else "pop", {}).setdefault(faixa, {"ev": 0.0})
        celula[resp] = n
        celula["ev"] += ev
    return saida


def resultado(con, w: str, p: list) -> dict:
    """Lucro medio (BB) a partir da decisao, WTSD e W$SD, por quem."""
    sql = ("SELECT hero, count(lucro), avg(lucro), count(*), sum(sd), "
           "sum(CASE WHEN sd = 1 AND marcada = 0 THEN 1 ELSE 0 END), "
           f"sum(CASE WHEN sd = 1 AND marcada = 0 AND ganhou = 1 THEN 1 ELSE 0 END) FROM decisoes{w} GROUP BY hero")
    return {("hero" if h else "pop"): {"n_lucro": nl, "lucro": lucro, "n": n, "sd": sd, "n_wsd": nw, "wsd": ws}
            for h, nl, lucro, n, sd, nw, ws in con.execute(sql, p)}


def agrupar(con, w: str, p: list, col) -> dict | None:
    """'Agrupar por' (as abas de relatorio do H2N/HM3): valor -> acoes e weak, por quem."""
    expr = expressao(col) if isinstance(col, str) else None
    if not expr:
        return None
    saida: dict = {"coluna": col, "pop": {}, "hero": {}}
    for hero, chave, acao, n in con.execute(
            f"SELECT hero, {expr}, acao, count(*) FROM decisoes{w} GROUP BY 1, 2, 3", p):
        if chave is not None:
            saida["hero" if hero else "pop"].setdefault(str(chave), {})[acao] = n
    for hero, chave, fracas, conhecidas in con.execute(
            f"SELECT hero, {expr}, sum(weak), count(weak) FROM decisoes{w} GROUP BY 1, 2", p):
        if chave is not None and conhecidas:
            saida["hero" if hero else "pop"].setdefault(str(chave), {})["_weak"] = [fracas, conhecidas]
    return saida


GRANDE = ["0,67–0,85", "0,86–1,00", "1,01–1,20", "1,21–1,50", "1,51–2,00", "2,00+"]
# Painel de tendencias (o perfil do H2N): (secao, nome, base, numerador). base e numerador sao filtros do site.
PAINEL = [
    ("Flop", "Aposta quando checaram até ele", {"rua": ["flop"], "situacao": ["livre"], "decisao_n": [1]}, {"acao": ["Bet"]}),
    ("Flop", "Lead do 1º a agir", {"rua": ["flop"], "situacao": ["livre"], "pos_rel": ["1º a agir"]}, {"acao": ["Bet"]}),
    ("Flop", "Aposta do último (todos checaram)", {"rua": ["flop"], "situacao": ["livre"], "ip": [1]}, {"acao": ["Bet"]}),
    ("Flop", "Fold contra aposta", {"rua": ["flop"], "situacao": ["enfrenta aposta"]}, {"acao": ["Fold"]}),
    ("Flop", "Call contra aposta", {"rua": ["flop"], "situacao": ["enfrenta aposta"]}, {"acao": ["Call"]}),
    ("Flop", "Raise contra aposta", {"rua": ["flop"], "situacao": ["enfrenta aposta"]}, {"acao": ["Raise"]}),
    ("Flop", "Check-raise", {"rua": ["flop"], "situacao": ["enfrenta aposta"], "checou_antes": [1]}, {"acao": ["Raise"]}),
    ("Flop", "Fold contra raise", {"rua": ["flop"], "situacao": ["enfrenta raise"]}, {"acao": ["Fold"]}),
    ("Flop", "Bet é all-in", {"rua": ["flop"], "acao": ["Bet"]}, {"allin": [1]}),
    ("Turn", "C-bet do agressor do flop", {"rua": ["turn"], "situacao": ["livre"], "agressor_anterior": [1]}, {"acao": ["Bet"]}),
    ("Turn", "Probe depois do flop checado", {"rua": ["turn"], "situacao": ["livre"], "rua_anterior_checada": [1]}, {"acao": ["Bet"]}),
    ("Turn", "Fold contra aposta", {"rua": ["turn"], "situacao": ["enfrenta aposta"]}, {"acao": ["Fold"]}),
    ("Turn", "Raise contra aposta", {"rua": ["turn"], "situacao": ["enfrenta aposta"]}, {"acao": ["Raise"]}),
    ("Turn", "Check-raise", {"rua": ["turn"], "situacao": ["enfrenta aposta"], "checou_antes": [1]}, {"acao": ["Raise"]}),
    ("River", "Aposta quando checaram até ele", {"rua": ["river"], "situacao": ["livre"], "decisao_n": [1]}, {"acao": ["Bet"]}),
    ("River", "Bet-bet-bet (B, B, bet)", {"rua": ["river"], "situacao": ["livre"], "linha_flop": ["B"], "linha_turn": ["B"]}, {"acao": ["Bet"]}),
    ("River", "Bet-check-bet (B, X, bet)", {"rua": ["river"], "situacao": ["livre"], "linha_flop": ["B"], "linha_turn": ["X"]}, {"acao": ["Bet"]}),
    ("River", "Fold contra aposta", {"rua": ["river"], "situacao": ["enfrenta aposta"]}, {"acao": ["Fold"]}),
    ("River", "Fold contra aposta grande (≥ 0,67)", {"rua": ["river"], "situacao": ["enfrenta aposta"], "tamanho_enfrentado": GRANDE}, {"acao": ["Fold"]}),
    ("River", "Raise contra aposta", {"rua": ["river"], "situacao": ["enfrenta aposta"]}, {"acao": ["Raise"]}),
    ("River", "Weak% das apostas (blefe no showdown)", {"rua": ["river"], "acao": ["Bet"], "weak": [0, 1]}, {"weak": [1]}),
    ("Showdown", "Foi ao showdown (WTSD)", {"rua": ["flop"], "decisao_n": [1]}, {"sd": [1]}),
    ("Showdown", "Ganhou no showdown (W$SD)", {"rua": ["flop"], "decisao_n": [1], "sd": [1], "marcada": [0]}, {"ganhou": [1]}),
]


def painel(con: sqlite3.Connection, filtros: dict) -> list[dict]:
    """Cada stat do PAINEL sobre os filtros do usuario; a base da stat vence o filtro da mesma coluna."""
    saida = []
    for secao, nome, base, num in PAINEL:
        w, p = where({**filtros, **base})
        cond, pc = where(num)
        cel = {"secao": secao, "nome": nome, "base": base, "num": num}
        for hero, n, feitos in con.execute(
                f"SELECT hero, count(*), sum(CASE WHEN {cond[len(' WHERE '):]} THEN 1 ELSE 0 END) "
                f"FROM decisoes{w} GROUP BY hero", pc + p):
            cel["hero" if hero else "pop"] = [feitos or 0, n]
        saida.append(cel)
    return saida


def exportar(con: sqlite3.Connection, filtros: dict, raiz: Path = RAIZ) -> tuple[str, int]:
    """Os .txt (PokerStars, bomb pot no formato do GG) das maos do filtro, num texto so, para o H2N."""
    w, p = where(filtros)
    ids = [i for (i,) in con.execute(f"SELECT DISTINCT hand_id FROM decisoes{w} ORDER BY hand_id", p)]
    textos = [(raiz / "hh" / "maos" / f"{i}.txt") for i in ids]
    partes = [arq.read_text(encoding="utf-8").strip() for arq in textos if arq.is_file()]
    return "\n\n\n".join(partes) + "\n", len(partes)


def opcoes(con: sqlite3.Connection) -> dict:
    lista = {c: [v for (v,) in con.execute(f"SELECT DISTINCT {c} FROM decisoes WHERE {c} IS NOT NULL ORDER BY 1")]
             for c, t in FILTROS.items() if t == "lista"}
    faixa = {c: con.execute(f"SELECT min({c}), max({c}) FROM decisoes").fetchone()
             for c, t in FILTROS.items() if t == "faixa"}
    n_maos = con.execute("SELECT count(*) FROM hands").fetchone()[0]
    tags = sorted({tag for (txt,) in con.execute("SELECT DISTINCT texturas FROM decisoes WHERE texturas IS NOT NULL")
                   for tag in txt.strip("|").split("|") if tag})
    datas = con.execute("SELECT min(data), max(data) FROM decisoes").fetchone()
    return {"lista": lista, "faixa": faixa, "faixas": [nome for _, nome in FAIXAS], "tags": tags, "datas": datas,
            "forcas": decisoes.FORCAS, "draws": decisoes.DRAWS, "maos": n_maos}


class Handler(SimpleHTTPRequestHandler):
    con: sqlite3.Connection
    maos_vistas = -1

    def atualizar(self) -> None:
        """O vigia pode ter gravado maos com o site aberto: ~1 s para refazer `decisoes`."""
        n = self.con.execute("SELECT count(*) FROM hands").fetchone()[0]
        if n != Handler.maos_vistas:
            decisoes.reconstruir(self.con)
            Handler.maos_vistas = n

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PUBLIC), **kw)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")  # o app.js muda sem trocar de nome
        super().end_headers()

    def _json(self, dados, status=200) -> None:
        corpo = json.dumps(dados, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self) -> None:
        if self.path == "/api/opcoes":
            self.atualizar()
            return self._json(opcoes(self.con))
        if self.path.startswith("/print/"):
            nome = unquote(self.path[len("/print/"):])
            # so serve print de mao do banco: nada de caminho montado pelo navegador
            if not self.con.execute("SELECT 1 FROM hands WHERE png = ?", (nome,)).fetchone():
                return self._json({"erro": "print desconhecido"}, 404)
            arq = RAIZ / "processadas" / nome
            if not arq.is_file():
                return self._json({"erro": "print nao esta em processadas/"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(arq.read_bytes())
            return None
        return super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/exportar":
            filtros = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            texto, n = exportar(self.con, filtros if isinstance(filtros, dict) else {})
            corpo = texto.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="bombpot_{n}_maos.txt"')
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)
            return None
        rotas = {"/api/consulta": consultar, "/api/painel": painel}
        if self.path not in rotas:
            return self._json({"erro": "rota desconhecida"}, 404)
        try:
            filtros = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            return self._json(rotas[self.path](self.con, filtros if isinstance(filtros, dict) else {}))
        except (ValueError, sqlite3.Error) as exc:
            return self._json({"erro": str(exc)}, 400)

    def log_message(self, format, *args) -> None:  # noqa: A002 - sem uma linha por requisicao no console
        pass


def main(argv: list[str]) -> int:
    porta = int(argv[0]) if argv else 8770
    tracker.abrir().close()  # garante o esquema (e a coluna obs) antes de servir
    # ponytail: uma conexao para todas as threads; ok para um usuario local, um pool se um dia for multiusuario
    Handler.con = sqlite3.connect(RAIZ / "bombpot.db", check_same_thread=False)
    servidor = ThreadingHTTPServer(("127.0.0.1", porta), Handler)
    url = f"http://127.0.0.1:{porta}/"
    print(f"BombPot Tracker em {url} (Ctrl+C para parar)")
    webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
