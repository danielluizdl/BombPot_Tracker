"""Confere um .txt (PokerStars) relendo-o como um importador leria: cada linha pelas regras do formato e o dinheiro.

    python checa_txt.py [pasta]     confere todos os .txt (padrao: hh/maos) e lista os que tem problema

Nao olha o print nem o Replayer: e a leitura independente do arquivo. O que ela pega (28/out, nas maos com seguro):
- `bets` com aposta de pe na rua, `raises A to B` com B - A diferente da aposta de pe, ninguem tinha apostado e
  sai `raises` (o certo e `bets`), `calls` que nao completa a aposta sem ser all-in por menos;
- a devolucao (`Uncalled bet`) diferente de maior aposta - segunda;
- `is all-in` com fichas sobrando no stack, ou alguem pondo mais que o stack;
- o pote do resumo diferente do que as linhas poem, `collected` + rake diferente do pote;
- quem recolhe diferente de quem leva pelas cartas mostradas (pote e side pots).
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

from resultados import carta, potes, rank7

TOL = 0.011
NUM = r"[^\d\s]?([\d.,]+)"  # o valor com o simbolo da moeda (ou sem)


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def problemas(texto: str) -> list[str]:
    """O que nao fecha no .txt; lista vazia = o arquivo conta uma mao coerente."""
    erros: list[str] = []
    stack: dict[str, float] = {}
    gasto: dict[str, float] = defaultdict(float)   # o que cada um pos (ja descontada a devolucao)
    bruto: dict[str, float] = defaultdict(float)   # o mesmo antes da devolucao
    recolhe: dict[str, float] = defaultdict(float)
    mostra: dict[str, str] = {}
    desistiu: set[str] = set()
    nivel, rua_put = 0.0, defaultdict(float)
    total = rake = None
    board: list[str] = []
    for linha in texto.splitlines():
        if m := re.match(rf"Seat \d+: (.+?) \({NUM} in chips\)", linha):
            stack[m[1]] = _num(m[2])
            continue
        if m := re.match(rf"(.+?): posts (the ante|small blind|big blind|straddle) {NUM}", linha):
            v = _num(m[3])
            gasto[m[1]] += v
            bruto[m[1]] += v
            if m[2] != "the ante":  # a blind e parte do preflop: o "raises to" ja a inclui
                rua_put[m[1]] += v
                nivel = max(nivel, rua_put[m[1]])
            continue
        if linha.startswith("*** "):
            if any(r in linha for r in ("FLOP", "TURN", "RIVER")):
                nivel, rua_put = 0.0, defaultdict(float)
            if cartas := re.findall(r"\[([^\]]+)\]", linha):
                board = " ".join(cartas).split()
            continue
        allin = "and is all-in" in linha
        if m := re.match(rf"(.+?): bets {NUM}", linha):
            if nivel > TOL:
                erros.append(f"'{linha.strip()}': ja havia aposta de {nivel:.2f} na rua")
            v = _num(m[2])
            gasto[m[1]] += v - rua_put[m[1]]
            bruto[m[1]] += v - rua_put[m[1]]
            rua_put[m[1]] = v
            nivel = max(nivel, v)
        elif m := re.match(rf"(.+?): raises {NUM} to {NUM}", linha):
            a, b = _num(m[2]), _num(m[3])
            if nivel <= TOL:
                erros.append(f"'{linha.strip()}': ninguem tinha apostado na rua (o certo e bets)")
            elif abs((b - a) - nivel) > TOL or b <= nivel + TOL:
                erros.append(f"'{linha.strip()}': a aposta de pe era {nivel:.2f}")
            gasto[m[1]] += b - rua_put[m[1]]
            bruto[m[1]] += b - rua_put[m[1]]
            rua_put[m[1]] = b
            nivel = max(nivel, b)
        elif m := re.match(rf"(.+?): calls {NUM}", linha):
            v, falta = _num(m[2]), nivel - rua_put[m[1]]
            if abs(v - falta) > TOL and not (allin and v < falta):
                erros.append(f"'{linha.strip()}': para pagar faltavam {falta:.2f}")
            gasto[m[1]] += v
            bruto[m[1]] += v
            rua_put[m[1]] += v
        elif m := re.match(rf"Uncalled bet \({NUM}\) returned to (.+)", linha):
            ordem = sorted(rua_put.values(), reverse=True)
            certo = ordem[0] - (ordem[1] if len(ordem) > 1 else 0.0)
            if abs(_num(m[1]) - certo) > TOL:
                erros.append(f"'{linha.strip()}': a parte que ninguem pagou era {certo:.2f}")
            gasto[m[2]] -= _num(m[1])
            rua_put[m[2]] -= _num(m[1])
        elif m := re.match(rf"(.+?) collected {NUM}", linha):
            recolhe[m[1]] += _num(m[2])
        elif m := re.match(r"(.+?): shows \[([^\]]+)\]", linha):
            mostra[m[1]] = m[2]
        elif m := re.match(r"(.+?): folds", linha):
            desistiu.add(m[1])
        elif m := re.match(rf"Total pot {NUM} \| Rake {NUM}", linha):
            total, rake = _num(m[1]), _num(m[2])
        if allin and (m := re.match(r"(.+?): ", linha)) and m[1] in stack:
            sobra = stack[m[1]] - bruto[m[1]]
            if abs(sobra) > TOL:
                erros.append(f"'{linha.strip()}': all-in mas o stack {stack[m[1]]:g} - o que ele pos = {sobra:.2f}")
    for p, v in bruto.items():
        if p in stack and v - stack[p] > TOL:
            erros.append(f"{p} pos {v:.2f}, mais que o stack {stack[p]:g}")
    if total is None:
        return erros + ["sem a linha 'Total pot ... | Rake ...'"]
    soma = sum(gasto.values())
    if abs(soma - total) > TOL:
        erros.append(f"o pote do resumo e {total:g} e as linhas poem {soma:.2f}")
    if abs(sum(recolhe.values()) + (rake or 0) - total) > TOL:
        erros.append(f"recolhido {sum(recolhe.values()):.2f} + rake {rake:g} != pote {total:g}")
    # quem leva pelas cartas: pote principal e side pots, pelo que cada um pos
    vivos = [p for p in stack if p not in desistiu]
    if len(vivos) >= 2 and len(board) == 5 and all(p in mostra for p in vivos):
        b = [carta(c) for c in board]
        forca = {p: rank7([carta(c) for c in mostra[p].split()] + b) for p in vivos}
        leva: dict[str, float] = defaultdict(float)
        for valor, quem in potes(dict(gasto), vivos):
            melhor = max(forca[p] for p in quem)
            ganham = [p for p in quem if forca[p] == melhor]
            for p in ganham:
                leva[p] += valor / len(ganham)
        for p in set(leva) | set(recolhe):
            e, c = leva.get(p, 0.0), recolhe.get(p, 0.0)
            if not e - (rake or 0) - TOL <= c <= e + TOL:
                erros.append(f"{p} recolhe {c:.2f}; pelas cartas levaria {e:.2f}")
    return erros


def main(argv: list[str]) -> int:
    pasta = Path(argv[0]) if argv else Path(__file__).resolve().parent / "hh" / "maos"
    arquivos = sorted(pasta.glob("*.txt"))
    ruins = {a.name: e for a in arquivos if (e := problemas(a.read_text(encoding="utf-8")))}
    for nome, erros in ruins.items():
        print(nome)
        for e in erros:
            print("   ", e)
    print(f"{len(arquivos) - len(ruins)} de {len(arquivos)} .txt fecham; {len(ruins)} com problema")
    return 1 if ruins else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
