"""Fiscalizacao dos nicks: quem e o mesmo jogador, a grafia real e o ensino do caderno do Replayer.

    python tracker.py nicks       pares de nicks pendentes + uma imagem por par em nicks_pendentes/ (para conferir)
    python tracker.py ensinar     ensina ao caderno a grafia real de cada nick conferido e corrige o nome nas maos

O OCR do Replayer erra nick de um jeito previsivel (I/1, l/I, 0/o, ideograma perdido ou trocado). A defesa que ja
existe la e o caderno (`wptparse.jogadores.Caderno`, primeira das quatro fontes de `lotes.nicks_da_mao`): um nick
confirmado com o desenho dele vence bitmap e OCR quando o desenho de agora fica a <= 0,10 de um exemplar guardado.
Daqui so se usa a interface publica dele, e o arquivo fica na pasta de dados deste projeto (dados_wpt/jogadores.json):
o codigo do Replayer nao muda. So entra no caderno a grafia que alguem conferiu no print (tabela nicks_conferidos).
"""
from __future__ import annotations

import json
import sqlite3
from multiprocessing import Pool
from pathlib import Path
from types import SimpleNamespace

import resultados
import tracker
from wptparse import jogadores as caderno_rp  # noqa: E402 - tracker ja pos o Replayer no sys.path

RAIZ = tracker.RAIZ


def definir_real(con: sqlite3.Connection, membros: set[str], real: str, conferido: bool, fonte: str = "") -> None:
    """Todos os nicks do grupo passam a apontar para a grafia real (aliases m -> real). conferido: a grafia foi lida
    no print com certeza, e entao pode ensinar o caderno."""
    with con:
        for m in membros | {real}:
            con.execute("DELETE FROM aliases WHERE junta = 1 AND (a = ? OR b = ?)", (m, m))
        con.executemany("INSERT OR REPLACE INTO aliases VALUES (?,?,1)", [(m, real) for m in membros if m != real])
        if conferido:
            con.execute("INSERT OR REPLACE INTO nicks_conferidos VALUES (?,?,?)", (real, fonte, tracker.agora()))


def _recortes(args: tuple[str, str]) -> tuple[str, list]:
    """Processo filho: le o print e devolve (hand_id, [(pos, recorte do nick)]) de todos os assentos."""
    hid, png = args
    try:
        hand = tracker.build(Path(png), usar_armario=False, gravar=False)
    except Exception:  # noqa: BLE001 - print ilegivel: fica sem ensinar, nao derruba o lote
        return hid, []
    return hid, [(p.pos, p.name) for p in hand.players if getattr(p, "name", None) is not None]


def ensinar(con: sqlite3.Connection, raiz: Path = RAIZ, arquivo: Path | None = None,
            processos: int = tracker.PROCESSOS) -> dict[str, int]:
    """Para cada nick conferido: os recortes dele em todas as maos do grupo viram exemplares confirmados no caderno.
    Depois, o caderno ensinado relê os assentos dessas maos e corrige jogadores.nome onde ele afirma outro nome."""
    real_de = resultados.principais(con)
    conferidos = {n for (n,) in con.execute("SELECT nick FROM nicks_conferidos")}
    alvo = {}  # hand_id -> {pos: nick real}
    for hid, pos, nome in con.execute("SELECT hand_id, pos, nome FROM jogadores WHERE nome IS NOT NULL"):
        real = real_de.get(nome, nome)
        if real in conferidos:
            alvo.setdefault(hid, {})[pos] = real
    if not alvo:
        return {"maos": 0, "nicks": 0, "corrigidos": 0}
    pngs = dict(con.execute(f"SELECT id, png FROM hands WHERE id IN ({','.join('?' * len(alvo))})", list(alvo)))
    tarefas = [(h, str(raiz / "processadas" / pngs[h])) for h in alvo if h in pngs]
    with Pool(min(processos, len(tarefas))) if processos > 1 and len(tarefas) > 1 else _SemPool() as pool:
        lidos = dict(pool.map(_recortes, tarefas))
    cad = caderno_rp.Caderno(arquivo)
    por_nick = {j.nick: j for j in cad.jogadores if j.nick and j.confirmado}
    for hid, posicoes in alvo.items():
        for pos, crop in lidos.get(hid, []):
            real = posicoes.get(pos)
            if real is None:
                continue
            j = por_nick.get(real)
            if j is None:
                j = cad.novo(crop)
                if j is None:
                    continue
                j.nick, j.confirmado = real, True
                por_nick[real] = j
            else:
                cad.aprende(j, crop)
    cad.grava()
    # o caderno recem-ensinado relê os assentos: e o que a proxima leitura (processar/refazer) vai fazer
    cad = caderno_rp.Caderno(arquivo)
    corrigidos = []
    for hid, assentos in lidos.items():
        achados = cad.nicks_dos([SimpleNamespace(pos=pos, name=crop) for pos, crop in assentos])
        for pos, nick in achados.items():
            corrigidos.append((nick, hid, pos))
    with con:
        antes = con.total_changes
        con.executemany("UPDATE jogadores SET nome = ? WHERE hand_id = ? AND pos = ? AND nome IS NOT ?",
                        [(n, h, p, n) for n, h, p in corrigidos])
        mudou = con.total_changes - antes
    return {"maos": len(lidos), "nicks": len(por_nick), "corrigidos": mudou}


class _SemPool:
    """Pool de um processo so (testes, uma mao): mesma interface do multiprocessing.Pool."""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    @staticmethod
    def map(f, xs):
        return list(map(f, xs))


def pendentes(con: sqlite3.Connection, pasta: Path = RAIZ / "nicks_pendentes") -> list[dict]:
    """Os pares de nicks ainda sem decisao, com uma imagem por par (o topo da mesa de um print de cada lado, onde
    ficam os nomes) para quem fiscaliza olhar. Grava indice.json na mesma pasta."""
    from PIL import Image, ImageDraw, ImageFont

    pasta.mkdir(exist_ok=True)
    for velho in pasta.glob("*.png"):
        velho.unlink()
    try:
        fonte = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 22)
    except OSError:
        fonte = ImageFont.load_default()
    pares = resultados.sugestoes_alias(con, limite=1000)
    for i, s in enumerate(pares):
        partes = []
        for lado in ("a", "b"):
            hid, png, pos = con.execute(
                "SELECT j.hand_id, h.png, j.pos FROM jogadores j JOIN hands h ON h.id = j.hand_id WHERE j.nome = ? "
                "ORDER BY j.hand_id LIMIT 1", (s[lado],)).fetchone()
            im = Image.open(RAIZ / "processadas" / png).convert("RGB")
            topo = im.crop((0, 0, im.width, int(im.width * 0.62)))  # a mesa: altura proporcional a largura
            topo = topo.resize((760, int(760 * topo.height / topo.width)))
            cab = Image.new("RGB", (760, 34), (30, 30, 30))
            ImageDraw.Draw(cab).text((8, 3), f"{lado.upper()}: {s[lado]}  ({pos}, mao {hid})", font=fonte,
                                     fill=(255, 255, 0))
            partes += [cab, topo]
        junto = Image.new("RGB", (760, sum(p.height for p in partes)))
        y = 0
        for p in partes:
            junto.paste(p, (0, y))
            y += p.height
        junto.save(pasta / f"{i:02d}.png")
        s["i"] = i
    (pasta / "indice.json").write_text(json.dumps(pares, ensure_ascii=False, indent=1), encoding="utf-8")
    return pares
