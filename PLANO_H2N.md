<!-- /autoplan restore point: "C:\\Users\\danie\\.gstack\\projects\\BombPot_Tracker\\unknown-autoplan-restore-20261021-164326.md" -->
## Implementation plan
# Plano: BombPot Tracker tão completo quanto H2N / HM3, adaptado a bomb pot

Data: 2026-10-21. Base atual: 1.567 bomb pots, tabela `decisoes` (23.418 linhas), site local com filtros
livres (servidor.py + public/), caixas Ações / Bet / Raise / Força (7 categorias) / Mãos (abre o print).

## Fontes da pesquisa

- `..\MetaLens_Tracker\docs\H2N_TELAS.md`: sessão guiada no H2N 4.1 (telas, popups, regras do Weak%, faixas
  de sizing, lista de texturas, drill-down, replayer). É a fonte mais rica; foi conferida número a número.
- Web: o H2N tem editor de stats ("Filters"), Expression Stats, relatórios com filtros por ação em cada rua;
  o popup da stat traz Action Profit, Spot Frequency, Next Villain's Actions, sizings, range do showdown e
  lista de mãos ([pokerstrategy](https://www.pokerstrategy.com/forum/postid/2311083/),
  [pokerlistings](https://www.pokerlistings.com/poker-tools/trackers/hand2note),
  [vip-grinders](https://www.vip-grinders.com/?p=144961)). O H2N 4 diz ter corrigido EV em bomb pot. Nenhum
  dos três trackers documenta análise própria de bomb pot: é a nossa vantagem.
- HM3: relatórios por posição/resultado/valor de mão, views prontas (c-bet, river), HUD por perfil
  ([vip-grinders](https://www.vip-grinders.com/holdem-manager-3-review-new-features/)). Sem filtro de textura
  ou sizing por % do pote documentado.

## O que muda em bomb pot (premissas)

1. Não há pré-flop: todo mundo vê o flop com mão aleatória. Range = 100% das mãos; a **força da mão no flop**
   é o eixo principal (no H2N o eixo é o range pré-flop).
2. Multiway quase sempre (média ~7 no flop): fold equity, "alguém paga?" e ordem de ação valem mais que IP/OOP.
3. Pote nasce em 8 BB × n; o SPR do flop varia de <2 a 15+ entre jogadores da mesma mão.
4. Papéis do H2N (PFR/PFC, SRP/3BP/4BP) não existem; o equivalente é **agressor da rua anterior** e a
   **linha** (B, X, C, R por rua).
5. Só conhecemos cartas do Hero (sempre) e de quem mostrou no showdown: a força da população tem viés de
   showdown (o H2N tem o mesmo viés e o assume no Weak%).

## Candidatos (H2N/HM3 -> bomb pot)

| # | Recurso | No H2N/HM3 | Adaptação bomb pot | Custo |
|---|---|---|---|---|
| A | **Força da mão em 17 categorias + draws** | Hand Value do Range: A-high, Missed Overcards/Draw/Trash, Low/Middle Pair, TPWK/TP2K/TPTK, Overpair, Two Pairs, Trips, Set, Straight, Flush, Full+, Chop; draws no flop/turn | Calcular por rua (flop/turn/river) para quem tem cartas; draws: flush draw, OESD, gutshot, combo, backdoor; "missed" no river | M |
| B | **Weak% (blefe no showdown)** | barra verde/branco/rosa/vermelho; Weak = A-high+Missed*+Low Pair(+Chop) | Weak% por sizing e por linha: "quanto a população blefa apostando 0,46–0,66 no river" | P |
| C | **Resposta ao sizing (Next Actions) + EV do blefe** | Fold/Call/Raise por sizing; EV blefe = F×100 − (1−F)×size | Em multiway: % "todos foldam" por faixa de tamanho, e o EV de blefe puro por faixa | M |
| D | **Action Profit / Won / WTSD / W$SD do spot** | cabeçalho do popup | lucro médio (BB) de quem tomou aquela decisão, do ponto da decisão em diante; fora as mãos marcadas | M |
| E | **Texturas de board (não exclusivas) por rua** | FLOP A/K/Q/J/T/9-2 high, paired, monotone, connected; TURN overcard, 3rd/4th flush, 4th straight; RIVER paired top/low, flush/straight completa | colunas novas em `decisoes` + filtros | P |
| F | **Linhas (B-X-B) do jogador** | notação por rua do H2N; telas CONT. AGGR., B-B-B, C-X-B | coluna `linha` (ex.: "X-C | B") e filtro por linha; telas de linha | P |
| G | **"Agrupar por" (relatórios do HM3/H2N)** | abas Positions, Bet Sizing, Flop Board, Stack Sizes | qualquer dimensão vira linhas de uma tabela (pos × ação, textura × fold, SPR × bet) | P |
| H | **Painel de tendências (HUD de estudo)** | perfil com seções FLOP/TURN/RIVER, célula valor+amostra clicável | grade de stats prontas da população e do Hero; clicar abre o filtro | M |
| I | **Amostra e intervalo de confiança** | apaga amostra pequena | IC 95% em cada %, apagar < 30 | P |
| J | **Período (data da mão)** | All Time / últimos N dias | guardar a data do print (`hands.ts`) e filtrar | P |
| K | **Comparar dois filtros (A × B)** | não tem direto | lado a lado: ex. SPR<3 vs SPR>8 | M |
| L | **Lista de mãos estilo H2N (hand line)** | `B51 C51 | 9♠ (68) X X` | linha compacta + print no hover | M |
| M | **Por jogador (seletor, aliases)** | central no H2N | nicks não são confiáveis em BB (PlayerN); só depois de identidade estável | G |
| N | **Gráfico de resultado do Hero (Won, EV)** | Graph | precisa equity de all-in multiway | G |
| O | **Exportar mãos filtradas (.txt)** | export | os `.txt` já existem; juntar os do filtro | P |

Custo: P = pequeno (horas), M = médio, G = grande.

## Proposta de ordem (para o debate)

1. G Agrupar por + I amostra/IC + J período (fundação dos relatórios)
2. A Força 17 categorias + draws, B Weak%
3. E Texturas por rua, F Linhas
4. C Resposta ao sizing + EV do blefe, D Action Profit
5. H Painel de tendências
6. L hand line, K comparar, O exportar
7. Fora por ora: M (por jogador), N (gráfico EV)

## Critério de pronto de cada fatia

- coluna/consulta nova coberta por teste com a mão gabarito (conferida a olho no print);
- site conferido no navegador;
- `pytest` todo verde antes da próxima fatia.
## Review record

Execução: `/autoplan` iniciou (restore point em `~/.gstack/projects/BombPot_Tracker/unknown-autoplan-restore-20261021-164326.md`),
mas o gancho de fase do gstack recusou a leitura da fase CEO ("Native parent project directory is unavailable":
a sessão do VS Code no Windows não entrega `CLAUDE_PROJECT_DIR` no formato que ele valida). As quatro lentes
abaixo foram aplicadas na sessão principal, sem a orquestração do autoplan e sem voz externa (Codex não
instalado). Status honesto: **debate feito, autoplan formal BLOCKED pela ferramenta**.

### Dados que decidem prioridade (consultados no banco, 2026-10-21)

| Fato | Valor |
|---|---|
| Mãos / decisões | 1.567 / 23.418 |
| Mãos que chegam ao turn / river | 937 / 466 |
| Vivos no flop (média, 1ª decisão) | 7,7 |
| Jogadores da população com cartas conhecidas | 1.400 assentos em 644 mãos |
| Decisões da população com força conhecida | flop 1.950 · turn 1.142 · river 732 |
| Decisões do Hero | 3.142 (todas com cartas) |
| HAND ID = horário em ms (snowflake: `id >> 22` + origem 2016-09-25 08:28:07,268) | conferido em 5 prints, erro ≤ 1 s |

### 1. CEO (estratégia e escopo), modo SELECTIVE EXPANSION

- Premissa 1 (range = 100%): mantida, e é o argumento central. Sem pré-flop, o que separa o bom do ruim em
  bomb pot é a força no flop × ação. O que o H2N faz com range pré-flop, aqui é a força.
- Premissa 5 (viés de showdown): confirmada. São 1.950 decisões de flop com força conhecida no agregado, mas um
  corte (ex.: river, raise, 0,46–0,66) cai para dezenas. Força/Weak% sem intervalo de confiança engana: o IC
  passa a ser requisito de A/B, não extra.
- Pergunta-produto: "quais estratégias o field usa" = (a) o que fazem (temos), (b) com que mãos (A+B),
  (c) funciona? (C: o field folda? EV do blefe; D: lucro da linha). A e C são o coração; D completa.
- Data real via HAND ID: custo ~zero e abre período/sessão. Entra.
- Fora (confirmado): M (por jogador: nick não é estável em print BB, e o pedido é população), N (gráfico EV:
  precisa equity multiway, custo alto, só Hero), pré-flop, HUD ao vivo.
- Dream state: escolher um spot e ler numa tela o que o field faz, com que mãos, quanto rende e qual sizing
  explora. Delta hoje: falta "com que mãos" no detalhe do H2N, "rende?" e "explora?".
- Erros: carta sem naipe já vira NULL; HAND ID fora do padrão snowflake → data NULL, nunca inventada.

### 2. Design (UI detectada pelo conteúdo: painel, telas, caixas, lista)

| Dimensão | Hoje | Problema | Decisão |
|---|---|---|---|
| Hierarquia da informação | 6/10 | 5 caixas com o mesmo peso | "Agrupar por" como visão de relatório; destaque da resposta mantido |
| Estados (vazio/carregando/erro) | 6/10 | sem "carregando" | indicador discreto durante a consulta |
| Amostra | 5/10 | só apaga < 30 | IC 95% em cada % |
| Detalhe estilo H2N | 4/10 | força em 7 categorias, sem Weak | categorias do H2N + draws, barra Weak na caixa Força |
| Lista de mãos | 6/10 | colunas soltas | hand line do H2N (P3) |
| Responsivo | 8/10 | ok abaixo de 900 px | manter |
| Acessibilidade | 7/10 | aria-pressed, foco visível | manter; barras com title |

### 3. DX (disparado pelo termo "action"; o produto não é ferramenta de dev: lente = tempo até o 1º insight)

- Atual: dois cliques no `Abrir site.bat` → ~3 s até a tela; 1º insight com 1 clique em "Filtros prontos".
- Lacuna real: reprocessar quando o Replayer melhora (Fase 5 do plano original, não feita): `tracker.py refazer`, P3.
- Testes: `python -m pytest -q` em ~20 s; manter abaixo de 60 s.

### 4. Engenharia

```
PNG → tracker.py → hands/acoes/jogadores ──(1,1 s)──► decisoes.py → decisoes (derivada)
                                                         │  + forca (H2N), draw, weak   (A,B)
                                                         │  + resposta, F do blefe      (C)
                                                         │  + lucro, wtsd, wsd          (D)
                                                         │  + linhas, texturas          (E,F)
                                                         │  + ts (do HAND ID)           (J)
servidor.py  /api/consulta {filtros, agrupar} ──► WHERE + GROUP BY ──► public/app.js (caixas, IC, agrupar)
```

- A: módulo `forca.py` puro (sem banco). Reaproveita `avaliador.melhor_mao` para a categoria feita e acrescenta
  a relação com o board: par baixo/médio/top (TPWK/TP2K/TPTK), overpair, set × trips, two pair; draws no
  flop/turn (flush draw, OESD, gutshot, combo); no river "missed draw/overcards/trash". Teste em tabela com
  casos escritos à mão. Weak = A-high + Missed* + Low Pair (regra do H2N conferida no MetaLens); chop fora.
- C: para cada Bet/Raise, as ações seguintes da rua até a próxima agressão: `todos foldam` / `pago` /
  `aumentado`. EV do blefe puro em % do pote = F·100 − (1−F)·tamanho·100, com F = P(todos foldam).
- D: lucro a partir da decisão = net + investido antes da decisão (o já investido é custo afundado). Mãos
  marcadas ficam fora. WTSD/W$SD por decisão.
- E/F: `linha_flop`, `linha_turn` (B/X/C/R/F por decisão); texturas não exclusivas em coluna de tags.
- G/I: `agrupar` na API com a mesma lista branca; IC de Wilson no navegador.
- Performance: reconstrução O(mãos); ~1,1 s hoje, ok até ~20k mãos.
- Falhas a testar: categoria de força errada (tabela), resposta quando a rua acaba em all-in (gabarito: CO
  shove, UTG+1 call), data de ID fora do padrão (NULL).

<!-- autoplan-accepted:ceo -->
- Força em categorias do H2N + draws + Weak%, com IC visível (A, B, I).
- Resposta ao sizing e EV do blefe (C); lucro da decisão, WTSD, W$SD (D).
- Data real a partir do HAND ID, com filtro de período (J).
- Fora: por jogador (M), gráfico EV (N), pré-flop.
<!-- /autoplan-accepted:ceo -->
<!-- autoplan-accepted:design -->
- "Agrupar por" como visão de relatório (G); barra Weak na caixa Força; indicador de carregando; IC no detalhe.
<!-- /autoplan-accepted:design -->
<!-- autoplan-accepted:dx -->
- `tracker.py refazer` para reprocessar `processadas/` quando o Replayer melhorar (P3).
<!-- /autoplan-accepted:dx -->
<!-- autoplan-accepted:eng -->
- `forca.py` puro com teste em tabela; colunas novas em `decisoes` testadas com a mão gabarito; pytest verde por fatia.
<!-- /autoplan-accepted:eng -->

## Relatório final: prioridades de implementação

| Ordem | Fatia | Itens | Por que agora |
|---|---|---|---|
| 1 | Força H2N + draws + Weak% + IC | A, B, I | coração do bomb pot: com que mãos o field age; IC impede ler ruído |
| 2 | Resposta ao sizing + EV do blefe | C | o field folda? qual sizing explora? |
| 3 | Agrupar por + data real + período | G, J | relatórios do HM3/H2N com um seletor; data de graça pelo ID |
| 4 | Linhas + texturas turn/river | F, E | spots tipo B-X-B e "turn completa flush" |
| 5 | Lucro da decisão, WTSD, W$SD | D | essa linha ganha dinheiro? |
| 6 | Painel de tendências | H | visão rápida do field; cada célula abre o filtro |
| 7 | Hand line, comparar A×B, exportar, refazer | L, K, O, DX | acabamento e manutenção |
| — | Fora | M, N, pré-flop | sem dado confiável ou fora do pedido |

### Estado da implementação (2026-10-21)

| Fatia | Feito | Testes |
|---|---|---|
| 1 Força H2N + draws + Weak% + IC | `forca.py`, colunas forca/draw/weak, caixa Força com barra Weak, IC de Wilson em toda % | test_forca.py (31 casos) |
| 2 Resposta + EV do blefe | coluna `resposta`, caixa "Resposta ao sizing" | gabarito: aumentado/aumentado/pago, EV −0,336 |
| 3 Agrupar por + data + período | `_agrupar` na API, `data` do HAND ID, filtro de período | agrupar, data, injeção recusada |
| 4 Linhas + texturas | `linha_flop`, `linha_turn`, `texturas` (tags), filtros | 8 texturas, linha XC/X |
| 5 Lucro, WTSD, W$SD | colunas `lucro`, `sd`, `ganhou`, caixa Resultado | lucro do call = 106 |
| 6 Painel de tendências | `/api/painel` (23 stats), clique vira filtro | base vence filtro; WTSD 2/7 |
| 7 Hand line, comparar, exportar, refazer | lista estilo H2N, A × atual, `/api/exportar`, `tracker.py refazer` | linha, export, refazer igual/recusada |

Suite: 66 testes, ~20 s. Tudo conferido no navegador.

### Decision Audit Trail

| # | Fase | Decisão | Classe | Princípio | Motivo | Rejeitado |
|---|---|---|---|---|---|---|
| 1 | CEO | IC obrigatório junto da força | Mecânica | P1 | cortes caem para dezenas de amostras | força sem IC |
| 2 | CEO | Data pelo HAND ID | Mecânica | P3 | conferido em 5 prints, custo zero | ler a data da imagem |
| 3 | CEO | M e N fora | Taste | P5 | sem identidade estável; equity multiway cara | incluir já |
| 4 | Eng | Weak sem chop | Taste | P5 | split por mão não é confiável no print | contar chop |
| 5 | Eng | Texturas como tags | Mecânica | P3 | não exclusivas: 1 coluna e filtro "contém" | 15 colunas booleanas |
| 6 | Design | Agrupar por como visão de relatório | Mecânica | P1 | cobre as abas Positions/Board/Stack do H2N | telas fixas por relatório |
