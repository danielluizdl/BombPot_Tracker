"""BombPot_Tracker: print de bomb pot do WPT -> SQLite (+ .txt para o H2N).

    python tracker.py processar [pasta]   le os PNGs da pasta (padrao: entrada/)
    python tracker.py vigiar [segundos]   fica lendo entrada/ a cada N segundos
    python tracker.py refazer             rele processadas/ e recusadas/ para bombpot_novo.db e escreve o diff
    python tracker.py aceitar             audita o bombpot_novo.db e, se limpo, troca as maos do banco por ele
    python tracker.py auditar             confere as invariantes de todas as maos (auditar.py)
    python tracker.py nomes               preenche o nick das maos lidas antes da coluna `nome` existir
    python tracker.py nicks               pares de nicks que podem ser o mesmo jogador, com imagens (nicks.py)
    python tracker.py ensinar             ensina ao caderno do Replayer a grafia conferida dos nicks (nicks.py)

Le em BOMBPOT_PROCESSOS processos (padrao 3); so o processo principal grava.

Decisoes (PROMPT.md, eng review): o banco sai do objeto Hand, em BB (R1);
mao com issues e recusada (R2); o vigia so le PNG de tamanho estavel (R3).
Cada mao guarda com que leitor foi lida (versao + commit do Replayer), o hash do print e a pior distancia de
template do numero das cartas; o refazer nunca mexe no banco: grava um banco novo e o diff, e so o aceitar troca.
"""

from __future__ import annotations

import functools
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

RAIZ = Path(__file__).resolve().parent
REPLAYER = Path(os.environ.get("POKER_REPLAYER", str(RAIZ.parent / "Poker_Replayer")))
# Antes do import: o wptparse fixa a pasta de dados no import (__init__.py:77),
# e sem isto as maos daqui iriam parar no armario do Poker_Replayer.
os.environ.setdefault("POKER_REPLAYER_DADOS", str(RAIZ / "dados_wpt"))
sys.path.insert(0, str(REPLAYER))

from wptparse import dicionarios, lotes  # noqa: E402
from wptparse.armario import VERSAO  # noqa: E402
from wptparse.cards import read_rank  # noqa: E402
from wptparse.hand import build  # noqa: E402
from wptparse.layout import PANEL_BG  # noqa: E402
from wptparse.words import canon  # noqa: E402

RUAS = ("flop", "turn", "river")

ESQUEMA = """
CREATE TABLE IF NOT EXISTS hands (
  id TEXT PRIMARY KEY, png TEXT NOT NULL, n_jogadores INTEGER NOT NULL,
  ante_bb REAL, board TEXT, unidade TEXT, lido_em TEXT NOT NULL,
  obs TEXT,  -- NULL = leitura limpa; senao, seguro/jackpot (D6): acoes certas, saldo/stack nao
  versao_leitor TEXT,  -- armario.VERSAO-commit do Replayer (+sujo); NULL = lida antes de existir a coluna
  sha256 TEXT,         -- do PNG: amarra a mao a uma imagem exata
  mtime TEXT,          -- data do arquivo na leitura (UTC): cruza com a hora do HAND ID
  pior_rank REAL,      -- maior distancia de template entre os numeros das cartas (0 = identico; o leitor aceita ate 0,16)
  notas TEXT           -- correcao a mao (.fix.json) ou liberacao conferida no print; NULL = leitura sem ajuda
);
-- o mesmo print nao vira duas maos (o refazer apagava pelo id novo e deixava a antiga)
CREATE UNIQUE INDEX IF NOT EXISTS hands_png ON hands (png);
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
-- nome: o nick, da mesma fonte que o .txt usa (lotes.nicks_da_mao: digitado, bitmap, OCR ou anonimo estavel)
CREATE TABLE IF NOT EXISTS jogadores (
  hand_id TEXT NOT NULL REFERENCES hands(id), pos TEXT NOT NULL, seat INTEGER,
  stack REAL, net REAL, cartas TEXT, hero INTEGER NOT NULL, ordem_flop INTEGER, nome TEXT,
  PRIMARY KEY (hand_id, pos)
);
CREATE TABLE IF NOT EXISTS recusas (png TEXT PRIMARY KEY, motivo TEXT NOT NULL, quando TEXT NOT NULL);
-- o unico dado humano do banco: o refazer/aceitar nunca mexem aqui. assinatura = o que a leitura dizia quando o dono
-- conferiu (JSON de assinatura()); se uma leitura nova mudar a mao, a diferenca aparece campo a campo.
-- modo: 'sorteio' (mao aleatoria: so estas entram na taxa de erro) ou 'suspeita' (fila das cartas duvidosas)
CREATE TABLE IF NOT EXISTS conferencias (
  hand_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, campo TEXT, obs TEXT,
  assinatura TEXT NOT NULL, versao_leitor TEXT, quando TEXT NOT NULL, modo TEXT NOT NULL DEFAULT 'sorteio'
);
-- tambem dado humano: dois nicks que o dono confirmou serem (junta = 1) ou nao (0) o mesmo jogador; a -> b
CREATE TABLE IF NOT EXISTS aliases (a TEXT NOT NULL, b TEXT NOT NULL, junta INTEGER NOT NULL, PRIMARY KEY (a, b));
-- grafia de nick conferida no print (nicks.py): so estas ensinam o caderno do Replayer
CREATE TABLE IF NOT EXISTS nicks_conferidos (nick TEXT PRIMARY KEY, fonte TEXT, quando TEXT NOT NULL);
-- print recusado so pela conferencia do Replayer, com a leitura conferida campo a campo no print: issues = as
-- queixas daquele momento (uma por linha); leitor que reclamar de outra coisa recusa de novo
CREATE TABLE IF NOT EXISTS liberadas (sha256 TEXT PRIMARY KEY, png TEXT NOT NULL, issues TEXT NOT NULL,
  motivo TEXT NOT NULL, quem TEXT NOT NULL, quando TEXT NOT NULL);
-- parecer do dono sobre a transcricao da mao para o .txt (aba Conferir, modo .txt): a leitura certa e o arquivo errado
-- sao coisas diferentes, entao isto nao entra na taxa de erro nem tira a mao do estudo
CREATE TABLE IF NOT EXISTS pareceres_txt (hand_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, obs TEXT, quando TEXT NOT NULL);
"""
# colunas que bancos antigos nao tem (o CREATE TABLE IF NOT EXISTS nao as acrescenta)
COLUNAS_NOVAS = {"hands": ("obs TEXT", "versao_leitor TEXT", "sha256 TEXT", "mtime TEXT", "pior_rank REAL", "notas TEXT"),
                 "jogadores": ("nome TEXT",),
                 "conferencias": ("modo TEXT NOT NULL DEFAULT 'sorteio'",)}
COLS_HANDS = ("id", "png", "n_jogadores", "ante_bb", "board", "unidade", "lido_em", "obs",
              "versao_leitor", "sha256", "mtime", "pior_rank", "notas")


class Recusa(Exception):
    """A mao nao entra no banco; a mensagem e o motivo gravado."""


def agora() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def abrir(banco: Path = RAIZ / "bombpot.db") -> sqlite3.Connection:
    # 30 s esperando a trava: o site reconstroi as tabelas derivadas enquanto o vigia grava
    con = sqlite3.connect(banco, timeout=30)
    for tabela, colunas in COLUNAS_NOVAS.items():  # antes do ESQUEMA: o indice novo usa coluna que pode faltar
        if con.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (tabela,)).fetchone():
            tem = {c[1] for c in con.execute(f"PRAGMA table_info({tabela})")}
            for col in colunas:
                if col.split()[0] not in tem:
                    con.execute(f"ALTER TABLE {tabela} ADD COLUMN {col}")
    con.executescript(ESQUEMA)
    if "pior_naipe" in {c[1] for c in con.execute("PRAGMA table_info(hands)")}:
        _tirar_pior_naipe(con)
    return con


def _tirar_pior_naipe(con: sqlite3.Connection) -> None:
    """A medida do naipe (23/out) nao prestou (ver distancia_rank). DROP COLUMN falha com os comentarios do CREATE
    TABLE, entao a tabela e recriada com as colunas de hoje, numa transacao."""
    cols = ",".join(COLS_HANDS)
    criar = re.sub(r"--[^\n]*", "", ESQUEMA).split("CREATE TABLE IF NOT EXISTS hands")[1].split(";")[0]
    # BEGIN explicito: o sqlite3 do Python so abre transacao sozinho antes de INSERT/UPDATE/DELETE, e um RENAME
    # gravado sem o CREATE seguinte deixaria o banco sem a tabela hands
    con.execute("BEGIN")
    try:
        con.execute("DROP INDEX IF EXISTS hands_png")
        con.execute("ALTER TABLE hands RENAME TO hands_velha")
        con.execute("CREATE TABLE hands" + criar)
        con.execute(f"INSERT INTO hands ({cols}) SELECT {cols} FROM hands_velha")
        con.execute("DROP TABLE hands_velha")
        con.execute("CREATE UNIQUE INDEX hands_png ON hands (png)")
    except sqlite3.Error:
        con.rollback()
        raise
    con.commit()


@functools.cache
def versao_leitor() -> str:
    """Com que leitor a mao foi lida: armario.VERSAO nem sempre sobe quando o codigo muda, entao vai junto o commit
    do Replayer, e '+sujo' se houver mudanca nao commitada nele (essa leitura nao se reproduz)."""
    def git(*args) -> str:
        try:
            return subprocess.run(["git", "-C", str(REPLAYER), *args], capture_output=True, text=True,
                                  timeout=10).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    commit = git("rev-parse", "--short", "HEAD") or "semgit"
    sujo = "+sujo" if git("status", "--porcelain", "--untracked-files=no") else ""
    return f"{VERSAO}-{commit}{sujo}"


@functools.cache
def _templates():
    return dicionarios.ranks()


def distancia_rank(hand) -> float | None:
    """A maior distancia de template entre os numeros das cartas lidas: o leitor e o mesmo recorte, entao e a distancia
    dele (wptparse/table.py chama read_rank igual). O naipe nao da para medir assim: o leitor decide pela cor num
    recorte mais largo, e a releitura no recorte da carta trocou ♠ preto por ♣ em 36 maos, todas certas no print."""
    rs = _templates()
    pior = None
    for c in list(hand.board) + [c for p in hand.players for c in p.hole]:
        img = getattr(c, "image", None)
        if img is not None and c.rank:
            pior = max(pior or 0.0, round(read_rank(rs, img)[1], 3))
    return pior


def proveniencia(png: Path, hand) -> tuple:
    """As colunas de hands depois de obs: versao do leitor, sha256 e data do PNG, distancia do numero das cartas."""
    mtime = datetime.fromtimestamp(png.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (versao_leitor(), hashlib.sha256(png.read_bytes()).hexdigest(), mtime, distancia_rank(hand))


def gravar_linhas(con: sqlite3.Connection, mao: tuple, acoes: list, jogadores: list) -> None:
    mao = tuple(mao) + (None,) * (len(COLS_HANDS) - len(mao))  # mao sem proveniencia (testes, banco antigo)
    con.execute(f"INSERT INTO hands ({','.join(COLS_HANDS)}) VALUES ({','.join('?' * len(COLS_HANDS))})", mao)
    con.executemany("INSERT INTO acoes VALUES (?,?,?,?,?,?,?,?)", acoes)
    con.executemany("INSERT INTO jogadores VALUES (?,?,?,?,?,?,?,?,?)", jogadores)


def so_dinheiro(issue: str) -> bool:
    """Queixa sobre o saldo, nao sobre a leitura: o seguro ou o jackpot mexeram no dinheiro (D6)."""
    return "seguro" in issue or "jackpot" in issue


def humana(issue: str) -> bool:
    """Campo corrigido a mao no .fix.json do Replayer (wptparse/fixes.py): verdade lida no print por uma pessoa."""
    return " a mao para " in issue


def separar_issues(issues: list[str]) -> tuple[list[str], list[str], list[str]]:
    """(dinheiro: seguro/jackpot, humanas: correcoes a mao, outras: o resto, que recusa)."""
    dinheiro = [i for i in issues if so_dinheiro(i)]
    humanas = [i for i in issues if humana(i) and not so_dinheiro(i)]
    return dinheiro, humanas, [i for i in issues if i not in dinheiro and i not in humanas]


def linhas(hand, png_nome: str, liberadas: frozenset = frozenset()) -> tuple[tuple, list[tuple], list[tuple]]:
    """A mao como linhas de hands/acoes/jogadores, em BB. Levanta Recusa.

    liberadas: queixas que alguem ja conferiu no print e mostrou serem da conferencia do Replayer, nao da leitura
    (tabela liberadas, por sha256 do PNG). So passa se TODA queixa que recusaria estiver nesse conjunto: uma queixa
    nova (leitor novo, outro defeito) recusa de novo."""
    if not hand.hand_id:
        raise Recusa("sem HAND ID")
    if not hand.bomb_pot:
        raise Recusa("nao e bomb pot")
    dinheiro, _, outras = separar_issues(list(hand.issues))
    if outras and not set(outras) <= liberadas:
        raise Recusa("issues: " + "; ".join(hand.issues))
    obs = "; ".join(dinheiro) or None
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

    nomes = lotes.nicks_da_mao(hand, gravar_trilha=False)  # nunca levanta; sem nick, None
    jogadores = []
    for p in hand.players:
        lidas = len(p.hole) == 2 and all(c.rank and c.suit for c in p.hole)
        jogadores.append((hand.hand_id, p.pos, p.seat, bb(p.start_stack), bb(p.net),
                          " ".join(map(str, p.hole)) if lidas else None,
                          int(p.seat == 0), ordem_flop.get(p.pos), nomes.get(p.pos)))

    mao = (hand.hand_id, png_nome, len(hand.players), bb(hand.ante),
           " ".join(map(str, hand.board)), hand.unidade, agora(), obs)
    return mao, acoes, jogadores


def destino_livre(png: Path, pasta: Path) -> Path:
    """Onde o PNG vai parar na pasta: o mesmo nome, ou 'nome (1).png' se ja houver um (o mesmo print salvo de novo)."""
    if png.parent.resolve() == pasta.resolve():  # relendo recusadas/ e recusada de novo: fica onde esta
        return png
    destino, n = pasta / png.name, 1
    while destino.exists():
        destino = pasta / f"{png.stem} ({n}){png.suffix}"
        n += 1
    return destino


def mover(png: Path, destino: Path) -> None:
    destino.parent.mkdir(exist_ok=True)
    if png != destino:
        png.replace(destino)


def sem_faixa_preta(img: np.ndarray) -> np.ndarray:
    """Pinta da cor do painel as linhas 100% pretas do fim da imagem (copia).

    Alguns prints vem com uma faixa preta embaixo, de fora do export do WPT. O Replayer procura no fim a faixa vazia
    na cor do painel que todo export inteiro tem (layout.is_truncated) e, achando preto, acusa "export cortado" --
    e numa delas a ultima caixa de resultado esta desenhada por cima do preto. As linhas pintadas nao tem informacao
    nenhuma (so preto); nenhum pixel com conteudo muda, e o arquivo original fica intacto."""
    mx = img.reshape(img.shape[0], -1).max(axis=1)
    n = 0
    while n < len(mx) and mx[-1 - n] <= 8:
        n += 1
    if not n or n == len(mx):
        return img
    img = img.copy()
    img[len(mx) - n:] = PANEL_BG
    return img


def ler(png: Path, liberadas: dict | None = None) -> tuple[Path, object, object]:
    """A parte cara, que roda nos processos filhos: (png, hand, linhas) ou (png, None, motivo).
    liberadas: sha256 do PNG -> queixas do Replayer ja conferidas no print (ver linhas)."""
    try:
        img = sem_faixa_preta(np.array(Image.open(png).convert("RGB")))
        hand = build(png, img=img, usar_armario=False, gravar=False)
        sha = hashlib.sha256(png.read_bytes()).hexdigest()
        livres = (liberadas or {}).get(sha, frozenset())
        mao, acoes, jogadores = linhas(hand, png.name, livres)
        _, humanas, outras = separar_issues(list(hand.issues))
        # o export recusa o que nao fecha (fichas, campo faltando): vale para o banco tambem, menos na mao marcada
        # (D6), onde o que nao fecha e justamente o saldo do seguro, e na liberada, que ja foi conferida no print
        _, motivo, _ = lotes.texto_da_mao(hand)
        if motivo and not mao[-1] and not outras:
            raise Recusa(f"export: {motivo}")
        notas = "; ".join(humanas + (["liberada (conferida no print): " + "; ".join(outras)] if outras else [])) or None
        resultado = (mao + proveniencia(png, hand) + (notas,), acoes, jogadores)
    except Recusa as exc:
        return png, None, str(exc)
    except Exception as exc:  # noqa: BLE001 - imagem ilegivel nao pode parar o lote
        return png, None, f"erro de leitura: {exc}"
    return png, hand, resultado


def registrar(png: Path, hand, resultado, con: sqlite3.Connection, raiz: Path = RAIZ) -> str:
    """Grava e move; so o processo principal escreve. Devolve 'ok', 'repetida' ou o motivo."""
    if hand is None:
        destino = destino_livre(png, raiz / "recusadas")
        with con:
            con.execute("INSERT OR REPLACE INTO recusas VALUES (?,?,?)", (destino.name, resultado, agora()))
        mover(png, destino)
        return resultado
    mao, acoes, jogadores = resultado
    if con.execute("SELECT 1 FROM hands WHERE id = ?", (mao[0],)).fetchone():
        # o mesmo print salvo de novo: fica em repetidas/ (processadas/ tem um print por mao, a contagem bate com o app)
        mover(png, destino_livre(png.with_name(f"ID_{mao[0]}.png"), raiz / "repetidas"))
        return "repetida"
    destino = destino_livre(png, raiz / "processadas")
    with con:  # o banco guarda o nome com que o PNG fica em processadas/ (o /print/ do site procura por ele)
        gravar_linhas(con, (mao[0], destino.name, *mao[2:]), acoes, jogadores)
        con.execute("DELETE FROM recusas WHERE png = ?", (png.name,))
    lotes.gravar(hand, raiz=raiz / "hh")  # subproduto para o H2N; nunca levanta
    # so depois do commit: uma queda aqui deixa o PNG em entrada/ e a releitura cai no dedupe
    mover(png, destino)
    return "ok"


def liberadas(con: sqlite3.Connection) -> dict[str, frozenset]:
    """sha256 do PNG -> as queixas do Replayer ja conferidas no print (tabela liberadas)."""
    return {sha: frozenset(i for i in txt.split("\n") if i) for sha, txt in con.execute("SELECT sha256, issues FROM liberadas")}


def processar(png: Path, con: sqlite3.Connection, raiz: Path = RAIZ) -> str:
    """Le um PNG, grava e move. Devolve 'ok', 'repetida' ou o motivo da recusa."""
    return registrar(*ler(png, liberadas(con)), con, raiz)


# 3 de 4 nucleos fisicos: medido nesta maquina, deixa um livre para o resto do PC
PROCESSOS = int(os.environ.get("BOMBPOT_PROCESSOS", 3))


def processar_pasta(pasta: Path, con: sqlite3.Connection, raiz: Path = RAIZ,
                    pngs: list[Path] | None = None, processos: int = PROCESSOS) -> dict[str, int]:
    pngs = sorted(pasta.glob("*.png")) if pngs is None else pngs
    contagem: dict[str, int] = {}
    pool = Pool(min(processos, len(pngs))) if processos > 1 and len(pngs) > 1 else None
    try:
        leitor = functools.partial(ler, liberadas=liberadas(con))
        lidas = pool.imap(leitor, pngs) if pool else map(leitor, pngs)
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


TABELAS_DA_LEITURA = ("hands", "acoes", "jogadores", "recusas")  # o que o refazer refaz; conferencias fica


def refazer(con: sqlite3.Connection, raiz: Path = RAIZ, processos: int = PROCESSOS) -> dict[str, int]:
    """Rele processadas/ e recusadas/ (o Replayer melhorou?) para bombpot_novo.db e escreve refazer_<versao>.txt
    com o que mudou mao a mao. Nao toca no banco nem move arquivo: quem troca e o `aceitar`, depois de auditar.

    O print continua com o nome que tem na pasta; a mao que mudou de pasta (recusada que agora le, ou o
    contrario) e movida no aceitar."""
    novo_db = raiz / "bombpot_novo.db"
    novo_db.unlink(missing_ok=True)
    hh_novo = raiz / "hh_novo"
    shutil.rmtree(hh_novo, ignore_errors=True)
    novo = abrir(novo_db)
    pngs = sorted((raiz / "processadas").glob("*.png")) + sorted((raiz / "recusadas").glob("*.png"))
    lidas_n = {"maos": 0, "recusadas": 0, "repetidas": 0, "nome_nas_duas_pastas": 0}
    pool = Pool(min(processos, len(pngs))) if processos > 1 and len(pngs) > 1 else None
    try:
        leitor = functools.partial(ler, liberadas=liberadas(con))
        for i, (png, hand, resultado) in enumerate(pool.imap(leitor, pngs) if pool else map(leitor, pngs), 1):
            with novo:
                if hand is None:
                    novo.execute("INSERT OR REPLACE INTO recusas VALUES (?,?,?)", (png.name, resultado, agora()))
                    lidas_n["recusadas"] += 1
                elif novo.execute("SELECT 1 FROM hands WHERE id = ?", (resultado[0][0],)).fetchone():
                    lidas_n["repetidas"] += 1  # o mesmo print salvo duas vezes: vale o primeiro na ordem
                elif novo.execute("SELECT 1 FROM hands WHERE png = ?", (png.name,)).fetchone():
                    lidas_n["nome_nas_duas_pastas"] += 1  # outro print com o mesmo nome em processadas/: fica fora
                else:
                    mao, acoes, jogadores = resultado
                    gravar_linhas(novo, (mao[0], png.name, *mao[2:]), acoes, jogadores)
                    lotes.gravar(hand, raiz=hh_novo)
                    lidas_n["maos"] += 1
            print(f"\r  {i}/{len(pngs)}  {lidas_n}", end="", flush=True)
    finally:
        if pool:
            pool.terminate()
    print()
    contagem, linhas_diff = comparar(con, novo)
    arq = raiz / f"refazer_{versao_leitor()}.txt"
    arq.write_text("\n".join([f"refazer {agora()}  leitor {versao_leitor()}", json.dumps(contagem), ""] + linhas_diff)
                   + "\n", encoding="utf-8")
    novo.close()
    print(f"diff em {arq.name}; confira e rode `python tracker.py aceitar`")
    return contagem


def assinatura(con: sqlite3.Connection, hand_id: str) -> dict:
    """O que a leitura afirma sobre a mao (sem hora, versao nem hash): o que o refazer e a conferencia comparam."""
    return {"mao": [list(r) for r in con.execute(
                "SELECT n_jogadores, ante_bb, board, unidade, obs FROM hands WHERE id = ?", (hand_id,))],
            "acoes": [list(r) for r in con.execute(
                "SELECT ordem, rua, pos, verbo, valor, allin, pote_antes FROM acoes WHERE hand_id = ? ORDER BY ordem",
                (hand_id,))],
            "jogadores": [list(r) for r in con.execute(
                "SELECT pos, seat, stack, net, cartas, hero, ordem_flop, nome FROM jogadores WHERE hand_id = ? "
                "ORDER BY pos", (hand_id,))]}


def diferencas(antes: dict, depois: dict) -> list[str]:
    """As partes da assinatura que mudaram, legiveis: 'board: 2s 9s 7d -> 2s 9s 7h', 'acao 7: ... -> ...'."""
    saida = []
    for k, (a, d) in enumerate(zip(antes["mao"][0], depois["mao"][0]) if antes["mao"] and depois["mao"] else []):
        if a != d:
            saida.append(f"{('n_jogadores', 'ante_bb', 'board', 'unidade', 'obs')[k]}: {a} -> {d}")
    for nome in ("acoes", "jogadores"):
        a, d = antes[nome], depois[nome]
        for k in range(max(len(a), len(d))):
            if k >= len(a) or k >= len(d) or a[k] != d[k]:
                saida.append(f"{nome} {k}: {a[k] if k < len(a) else '-'} -> {d[k] if k < len(d) else '-'}")
    return saida


def _nicks_do_grupo(assin: dict, real_de: dict[str, str]) -> dict:
    """A assinatura com cada nick trocado pela grafia real do grupo (aliases confirmados): corrigir o nick de uma mao
    conferida (nicks.py) nao e a leitura piorar, e nao pode travar o aceitar."""
    return {**assin, "jogadores": [r[:7] + [real_de.get(r[7], r[7])] for r in assin["jogadores"]]}


def comparar(con: sqlite3.Connection, novo: sqlite3.Connection) -> tuple[dict[str, int], list[str]]:
    """Banco atual x banco do refazer, mao a mao. Alertas primeiro: mao conferida que mudou, print cujo HAND ID
    mudou (era o caso em que o refazer antigo deixava duas maos para um print)."""
    velho_png = dict(con.execute("SELECT png, id FROM hands"))
    novo_png = dict(novo.execute("SELECT png, id FROM hands"))
    novo_rec = dict(novo.execute("SELECT png, motivo FROM recusas"))
    velho_ids, novo_ids = set(velho_png.values()), set(novo_png.values())
    conferidas = dict(con.execute("SELECT hand_id, assinatura FROM conferencias WHERE ok = 1"))
    import resultados  # aqui: resultados importa decisoes, que importa tracker
    real_de = resultados.principais(con)
    contagem: dict[str, int] = dict.fromkeys(("igual", "mudou", "nova", "saiu", "id_mudou", "conferida_mudou"), 0)
    alertas, linhas_ = [], []
    for png, hid in sorted(velho_png.items()):
        if png in novo_png and novo_png[png] != hid:
            contagem["id_mudou"] += 1
            alertas.append(f"ALERTA id mudou  {png}: {hid} -> {novo_png[png]}")
    for hid in sorted(velho_ids | novo_ids):
        if hid not in novo_ids:
            png = next(p for p, h in velho_png.items() if h == hid)
            contagem["saiu"] += 1
            linhas_.append(f"saiu   {hid}  ({png}: {novo_rec.get(png, 'print nao relido')})")
            if hid in conferidas:
                contagem["conferida_mudou"] += 1
                alertas.append(f"ALERTA conferida saiu  {hid}")
            continue
        depois = assinatura(novo, hid)
        if hid not in velho_ids:
            contagem["nova"] += 1
            linhas_.append(f"nova   {hid}")
            continue
        antes = assinatura(con, hid)
        if json.dumps(antes) == json.dumps(depois):
            contagem["igual"] += 1
        else:
            contagem["mudou"] += 1
            linhas_.append(f"mudou  {hid}: " + "; ".join(diferencas(antes, depois)))
        if hid in conferidas and json.dumps(_nicks_do_grupo(json.loads(conferidas[hid]), real_de)) \
                != json.dumps(_nicks_do_grupo(depois, real_de)):
            contagem["conferida_mudou"] += 1
            alertas.append(f"ALERTA conferida mudou  {hid}: "
                           + "; ".join(diferencas(json.loads(conferidas[hid]), depois)))
    return contagem, alertas + linhas_


def aceitar(con: sqlite3.Connection, raiz: Path = RAIZ) -> str:
    """Troca as maos do banco pelas do bombpot_novo.db, se ele passar na auditoria e nenhuma mao conferida mudar.

    Antes faz uma copia do banco (bombpot_antes_aceitar.db). Troca as quatro tabelas da leitura numa transacao so
    (conferencias fica); depois move os prints que mudaram de pasta e os .txt do H2N."""
    import auditar  # aqui e nao no topo: auditar importa tracker

    novo_db = raiz / "bombpot_novo.db"
    if not novo_db.is_file():
        return "nada a aceitar: rode `python tracker.py refazer` antes"
    novo = abrir(novo_db)
    problemas = auditar.violacoes(auditar.auditar(novo, raiz, pastas={"processadas", "recusadas"},
                                                  leitor_aceito=versao_leitor()))
    contagem, alertas = comparar(con, novo)
    novo.close()
    if problemas:
        return "recusado, a auditoria do banco novo achou: " + "; ".join(f"{k} ({len(v)})" for k, v in problemas.items())
    if contagem["conferida_mudou"]:
        return "recusado, mao conferida mudou (veja o refazer_*.txt): " + "; ".join(a for a in alertas if "conferida" in a)
    with sqlite3.connect(raiz / "bombpot_antes_aceitar.db") as copia:
        con.backup(copia)
    con.execute("ATTACH DATABASE ? AS novo", (str(novo_db),))
    try:
        with con:
            for tabela in TABELAS_DA_LEITURA:
                cols = ",".join(c[1] for c in con.execute(f"PRAGMA novo.table_info({tabela})"))
                con.execute(f"DELETE FROM main.{tabela}")
                con.execute(f"INSERT INTO main.{tabela} ({cols}) SELECT {cols} FROM novo.{tabela}")
    finally:
        con.execute("DETACH DATABASE novo")
    # ponytail: os arquivos andam depois do commit; uma queda aqui deixa print na pasta errada (o auditar acusa)
    for (png,) in con.execute("SELECT png FROM hands").fetchall():
        if not (raiz / "processadas" / png).exists() and (raiz / "recusadas" / png).exists():
            mover(raiz / "recusadas" / png, raiz / "processadas" / png)
    for (png,) in con.execute("SELECT png FROM recusas").fetchall():
        if not (raiz / "recusadas" / png).exists() and (raiz / "processadas" / png).exists():
            mover(raiz / "processadas" / png, raiz / "recusadas" / png)
    ids = {i for (i,) in con.execute("SELECT id FROM hands")}
    maos_txt = raiz / "hh" / "maos"
    maos_txt.mkdir(parents=True, exist_ok=True)
    for txt in maos_txt.glob("*.txt"):
        if txt.stem not in ids:
            txt.unlink()
    for txt in (raiz / "hh_novo" / "maos").glob("*.txt"):
        txt.replace(maos_txt / txt.name)
    shutil.rmtree(raiz / "hh_novo", ignore_errors=True)
    novo_db.unlink()
    (raiz / "REPLAYER_OK").write_text(versao_leitor() + "\n", encoding="utf-8")
    return f"aceito: {json.dumps(contagem)}; leitor {versao_leitor()} gravado em REPLAYER_OK"


SEAT_TXT = re.compile(r"^Seat (\d+): (.+) \([^()]*in chips\)", re.M)


def preencher_nomes(con: sqlite3.Connection, raiz: Path = RAIZ) -> dict[str, int]:
    """O nick das maos lidas antes da coluna `nome`: do .txt da mao (o assento la e o seat + 1); a mao sem .txt
    (marcada, o export nao grava) rele o print so para os nicks, com a mesma funcao que escreve o .txt."""
    contagem = {"txt": 0, "print": 0, "sem": 0}
    faltam = [h for (h,) in con.execute("SELECT DISTINCT hand_id FROM jogadores WHERE nome IS NULL")]
    for hid in faltam:
        arq = raiz / "hh" / "maos" / f"{hid}.txt"
        if arq.is_file():
            cab = arq.read_text(encoding="utf-8").split("*** HOLE CARDS ***")[0]
            por_seat = {int(s) - 1: nome for s, nome in SEAT_TXT.findall(cab)}
            linhas = [(por_seat.get(seat), hid, pos) for pos, seat in
                      con.execute("SELECT pos, seat FROM jogadores WHERE hand_id = ?", (hid,))]
            contagem["txt"] += 1
        else:
            png = con.execute("SELECT png FROM hands WHERE id = ?", (hid,)).fetchone()[0]
            arq = raiz / "processadas" / png
            if not arq.is_file():
                contagem["sem"] += 1
                continue
            nomes = lotes.nicks_da_mao(build(arq, usar_armario=False, gravar=False), gravar_trilha=False)
            linhas = [(nomes.get(pos), hid, pos) for (pos,) in con.execute("SELECT pos FROM jogadores WHERE hand_id = ?", (hid,))]
            contagem["print"] += 1
        with con:
            con.executemany("UPDATE jogadores SET nome = ? WHERE hand_id = ? AND pos = ?", linhas)
    return contagem


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
        import auditar
        return auditar.imprimir(auditar.auditar(con))
    elif cmd == "refazer":
        print(refazer(con))
    elif cmd == "aceitar":
        print(aceitar(con))
    elif cmd == "auditar":
        import auditar
        return auditar.imprimir(auditar.auditar(con))
    elif cmd == "nicks":
        import nicks
        pares = nicks.pendentes(con)
        print(f"{len(pares)} pares de nicks pendentes; imagens em nicks_pendentes/")
        for s in pares:
            print(f"  {s['i']:02d}  {s['a']} ({s['maos_a']}) -> {s['b']} ({s['maos_b']})")
    elif cmd == "ensinar":
        import nicks
        print(nicks.ensinar(con))
    elif cmd == "nomes":
        print(preencher_nomes(con))
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
