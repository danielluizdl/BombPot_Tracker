"""BombPot_Tracker: print de bomb pot do WPT -> SQLite (+ .txt para o H2N).

    python tracker.py processar [pasta]   le os PNGs da pasta (padrao: entrada/)
    python tracker.py vigiar [segundos]   fica lendo entrada/ a cada N segundos
    python tracker.py refazer             rele processadas/ (quando o Poker_Replayer melhorar)

Le em BOMBPOT_PROCESSOS processos (padrao 3); so o processo principal grava.

Decisoes (PROMPT.md, eng review): o banco sai do objeto Hand, em BB (R1);
mao com issues e recusada (R2); o vigia so le PNG de tamanho estavel (R3).
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from multiprocessing import Pool
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
# Antes do import: o wptparse fixa a pasta de dados no import (__init__.py:77),
# e sem isto as maos daqui iriam parar no armario do Poker_Replayer.
os.environ.setdefault("POKER_REPLAYER_DADOS", str(RAIZ / "dados_wpt"))
sys.path.insert(0, os.environ.get("POKER_REPLAYER", str(RAIZ.parent / "Poker_Replayer")))

from wptparse import lotes  # noqa: E402
from wptparse.hand import build  # noqa: E402
from wptparse.words import canon  # noqa: E402

RUAS = ("flop", "turn", "river")

ESQUEMA = """
CREATE TABLE IF NOT EXISTS hands (
  id TEXT PRIMARY KEY, png TEXT NOT NULL, n_jogadores INTEGER NOT NULL,
  ante_bb REAL, board TEXT, unidade TEXT, lido_em TEXT NOT NULL,
  obs TEXT  -- NULL = leitura limpa; senao, seguro/jackpot (D6): acoes certas, saldo/stack nao
);
-- uma linha por acao pos-flop; valores em BB, pote_antes = pote antes da acao.
-- valor como o WPT escreve: Bet = aposta, Raise = total na rua, Call = so o complemento
CREATE TABLE IF NOT EXISTS acoes (
  hand_id TEXT NOT NULL REFERENCES hands(id), ordem INTEGER NOT NULL,
  rua TEXT NOT NULL, pos TEXT NOT NULL, verbo TEXT NOT NULL,
  valor REAL, allin INTEGER NOT NULL, pote_antes REAL NOT NULL,
  PRIMARY KEY (hand_id, ordem)
);
CREATE INDEX IF NOT EXISTS acoes_rua_verbo ON acoes (rua, verbo);
-- ordem_flop: 1 = primeiro a agir no flop; cartas so quando as duas foram lidas
CREATE TABLE IF NOT EXISTS jogadores (
  hand_id TEXT NOT NULL REFERENCES hands(id), pos TEXT NOT NULL, seat INTEGER,
  stack REAL, net REAL, cartas TEXT, hero INTEGER NOT NULL, ordem_flop INTEGER,
  PRIMARY KEY (hand_id, pos)
);
CREATE TABLE IF NOT EXISTS recusas (png TEXT PRIMARY KEY, motivo TEXT NOT NULL, quando TEXT NOT NULL);
"""


class Recusa(Exception):
    """A mao nao entra no banco; a mensagem e o motivo gravado."""


def agora() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def abrir(banco: Path = RAIZ / "bombpot.db") -> sqlite3.Connection:
    con = sqlite3.connect(banco)
    con.executescript(ESQUEMA)
    if "obs" not in [c[1] for c in con.execute("PRAGMA table_info(hands)")]:  # banco anterior a D6
        con.execute("ALTER TABLE hands ADD COLUMN obs TEXT")
    return con


def gravar_linhas(con: sqlite3.Connection, mao: tuple, acoes: list, jogadores: list) -> None:
    con.execute("INSERT INTO hands VALUES (?,?,?,?,?,?,?,?)", mao)
    con.executemany("INSERT INTO acoes VALUES (?,?,?,?,?,?,?,?)", acoes)
    con.executemany("INSERT INTO jogadores VALUES (?,?,?,?,?,?,?,?)", jogadores)


def so_dinheiro(issue: str) -> bool:
    """Queixa sobre o saldo, nao sobre a leitura: o seguro ou o jackpot mexeram no dinheiro (D6)."""
    return "seguro" in issue or "jackpot" in issue


def linhas(hand, png_nome: str) -> tuple[tuple, list[tuple], list[tuple]]:
    """A mao como linhas de hands/acoes/jogadores, em BB. Levanta Recusa."""
    if not hand.hand_id:
        raise Recusa("sem HAND ID")
    if not hand.bomb_pot:
        raise Recusa("nao e bomb pot")
    if hand.issues and not all(map(so_dinheiro, hand.issues)):
        raise Recusa("issues: " + "; ".join(hand.issues))
    obs = "; ".join(hand.issues) or None
    if hand.unidade == "BB":
        fator = 1.0
    elif hand.bb:
        fator = 1 / hand.bb
    else:
        raise Recusa(f"valores em {hand.unidade} sem BB conhecida")

    def bb(v):
        return None if v is None else round(v * fator, 2)

    acoes: list[tuple] = []
    ordem_flop: dict[str, int] = {}
    pote_antes = 0.0
    for s in hand.steps:
        verbo = canon(s.verb)
        # passo sem verbo e marcador de vez ou recolhimento do pote, nao acao
        if s.pos and verbo and s.street in RUAS:
            if s.street == "flop":
                ordem_flop.setdefault(s.pos, len(ordem_flop) + 1)
            acoes.append((hand.hand_id, len(acoes), s.street, s.pos, verbo,
                          bb(s.amount), int(s.all_in), bb(pote_antes)))
        pote_antes = s.pot

    jogadores = []
    for p in hand.players:
        lidas = len(p.hole) == 2 and all(c.rank and c.suit for c in p.hole)
        jogadores.append((hand.hand_id, p.pos, p.seat, bb(p.start_stack), bb(p.net),
                          " ".join(map(str, p.hole)) if lidas else None,
                          int(p.seat == 0), ordem_flop.get(p.pos)))

    mao = (hand.hand_id, png_nome, len(hand.players), bb(hand.ante),
           " ".join(map(str, hand.board)), hand.unidade, agora(), obs)
    return mao, acoes, jogadores


def mover(png: Path, pasta: Path) -> None:
    pasta.mkdir(exist_ok=True)
    if png.parent.resolve() == pasta.resolve():  # relendo recusadas/ e recusada de novo: fica onde esta
        return
    destino = pasta / png.name
    n = 1
    while destino.exists():  # o mesmo print salvo duas vezes com o mesmo nome
        destino = pasta / f"{png.stem} ({n}){png.suffix}"
        n += 1
    png.replace(destino)


def ler(png: Path) -> tuple[Path, object, object]:
    """A parte cara, que roda nos processos filhos: (png, hand, linhas) ou (png, None, motivo)."""
    try:
        hand = build(png, usar_armario=False, gravar=False)
        resultado = linhas(hand, png.name)
        # o export recusa o que nao fecha (fichas, campo faltando): vale para o banco tambem,
        # menos na mao marcada (D6), onde o que nao fecha e justamente o saldo do seguro
        _, motivo, _ = lotes.texto_da_mao(hand)
        if motivo and not resultado[0][-1]:
            raise Recusa(f"export: {motivo}")
    except Recusa as exc:
        return png, None, str(exc)
    except Exception as exc:  # noqa: BLE001 - imagem ilegivel nao pode parar o lote
        return png, None, f"erro de leitura: {exc}"
    return png, hand, resultado


def registrar(png: Path, hand, resultado, con: sqlite3.Connection, raiz: Path = RAIZ) -> str:
    """Grava e move; so o processo principal escreve. Devolve 'ok', 'repetida' ou o motivo."""
    if hand is None:
        with con:
            con.execute("INSERT OR REPLACE INTO recusas VALUES (?,?,?)", (png.name, resultado, agora()))
        mover(png, raiz / "recusadas")
        return resultado
    mao, acoes, jogadores = resultado
    if con.execute("SELECT 1 FROM hands WHERE id = ?", (mao[0],)).fetchone():
        mover(png, raiz / "processadas")
        return "repetida"
    with con:
        gravar_linhas(con, mao, acoes, jogadores)
        con.execute("DELETE FROM recusas WHERE png = ?", (png.name,))
    lotes.gravar(hand, raiz=raiz / "hh")  # subproduto para o H2N; nunca levanta
    # so depois do commit: uma queda aqui deixa o PNG em entrada/ e a releitura cai no dedupe
    mover(png, raiz / "processadas")
    return "ok"


def processar(png: Path, con: sqlite3.Connection, raiz: Path = RAIZ) -> str:
    """Le um PNG, grava e move. Devolve 'ok', 'repetida' ou o motivo da recusa."""
    return registrar(*ler(png), con, raiz)


# 3 de 4 nucleos fisicos: medido nesta maquina, deixa um livre para o resto do PC
PROCESSOS = int(os.environ.get("BOMBPOT_PROCESSOS", 3))


def processar_pasta(pasta: Path, con: sqlite3.Connection, raiz: Path = RAIZ,
                    pngs: list[Path] | None = None, processos: int = PROCESSOS) -> dict[str, int]:
    pngs = sorted(pasta.glob("*.png")) if pngs is None else pngs
    contagem: dict[str, int] = {}
    pool = Pool(min(processos, len(pngs))) if processos > 1 and len(pngs) > 1 else None
    try:
        lidas = pool.imap(ler, pngs) if pool else map(ler, pngs)
        for i, (png, hand, resultado) in enumerate(lidas, 1):
            r = registrar(png, hand, resultado, con, raiz)
            chave = r if r in ("ok", "repetida") else "recusada"
            contagem[chave] = contagem.get(chave, 0) + 1
            print(f"  {i}/{len(pngs)}  {chave:<9} {png.name}" + ("" if chave != "recusada" else f"  ({r})"),
                  flush=True)
    finally:
        if pool:
            pool.terminate()
    return contagem


def refazer(con: sqlite3.Connection, raiz: Path = RAIZ, processos: int = PROCESSOS) -> dict[str, int]:
    """Rele processadas/ (o Replayer melhorou?) e troca as maos no banco pela leitura nova.

    A mao que agora e recusada sai do banco e vai para recusadas/ com o motivo: mao errada no banco
    e pior que mao ausente."""
    pngs = sorted((raiz / "processadas").glob("*.png"))
    contagem = {"igual": 0, "mudou": 0, "recusada": 0}
    pool = Pool(min(processos, len(pngs))) if processos > 1 and len(pngs) > 1 else None
    try:
        for i, (png, hand, resultado) in enumerate(pool.imap(ler, pngs) if pool else map(ler, pngs), 1):
            antigo = con.execute("SELECT id FROM hands WHERE png = ?", (png.name,)).fetchone()
            if hand is None:
                if antigo:
                    apagar_mao(con, antigo[0])
                registrar(png, None, resultado, con, raiz)
                contagem["recusada"] += 1
            else:
                mao, acoes, jogadores = resultado
                antes = _assinatura(con, mao[0])
                apagar_mao(con, mao[0])
                with con:
                    gravar_linhas(con, mao, acoes, jogadores)
                lotes.gravar(hand, raiz=raiz / "hh")
                contagem["igual" if _assinatura(con, mao[0]) == antes else "mudou"] += 1
            print(f"\r  {i}/{len(pngs)}  {contagem}", end="", flush=True)
    finally:
        if pool:
            pool.terminate()
    print()
    return contagem


def apagar_mao(con: sqlite3.Connection, hand_id: str) -> None:
    with con:
        for tabela in ("acoes", "jogadores"):
            con.execute(f"DELETE FROM {tabela} WHERE hand_id = ?", (hand_id,))
        con.execute("DELETE FROM hands WHERE id = ?", (hand_id,))


def _assinatura(con: sqlite3.Connection, hand_id: str) -> tuple:
    """O que a leitura afirma sobre a mao (sem a hora da leitura): para dizer se refazer mudou algo."""
    return (con.execute("SELECT n_jogadores, ante_bb, board, unidade, obs FROM hands WHERE id = ?", (hand_id,)).fetchall(),
            con.execute("SELECT * FROM acoes WHERE hand_id = ? ORDER BY ordem", (hand_id,)).fetchall(),
            con.execute("SELECT * FROM jogadores WHERE hand_id = ? ORDER BY pos", (hand_id,)).fetchall())


def estaveis(pasta: Path, vistos: dict[Path, int]) -> list[Path]:
    """PNGs com o mesmo tamanho da varredura anterior: os que ja terminaram de copiar (R3)."""
    atual = {p: p.stat().st_size for p in pasta.glob("*.png")}
    prontos = sorted(p for p, t in atual.items() if vistos.get(p) == t)
    vistos.clear()
    vistos.update(atual)
    return prontos


def vigiar(segundos: float, con: sqlite3.Connection, raiz: Path = RAIZ) -> None:
    entrada = raiz / "entrada"
    entrada.mkdir(exist_ok=True)
    print(f"vigiando {entrada} a cada {segundos:g}s (Ctrl+C para parar)")
    vistos: dict[Path, int] = {}
    while True:
        prontos = estaveis(entrada, vistos)
        if prontos:
            print(processar_pasta(entrada, con, raiz, prontos))
        time.sleep(segundos)


def main(argv: list[str]) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue] - console cp1252 x nome de arquivo
    cmd = argv[0] if argv else "processar"
    con = abrir()
    if cmd == "processar":
        pasta = Path(argv[1]) if len(argv) > 1 else RAIZ / "entrada"
        print(processar_pasta(pasta, con))
    elif cmd == "refazer":
        print(refazer(con))
    elif cmd == "vigiar":
        try:
            vigiar(float(argv[1]) if len(argv) > 1 else 5, con)
        except KeyboardInterrupt:
            pass
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
