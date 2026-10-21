# PROMPT — BombPot_Tracker: do zero até o primeiro teste

> Cole este arquivo inteiro numa sessão nova do Claude Code aberta em
> `C:\Users\danie\Documents\Projetos\BombPot_Tracker`. O fluxo de equipe
> usado é o gstack: `/plan-eng-review` trava o plano, a implementação vai em
> fatias, `/review` antes de cada fatia fechar, `/qa` no fim.

---

## 1. O que estamos construindo

Um tracker **só de bomb pots do WPT Global**, estilo Hand2Note, mas olhando o
**conjunto de mãos (a população)** e não jogador por jogador. A pergunta que
ele responde: *quais estratégias o field usa em bomb pot?* (quem aposta no
flop, quanto, com que frequência foldam pra aposta, quando dão check-raise, o
que mostram no showdown, etc.).

O WPT não entrega hand history, só um print por mão. Então o pipeline é:

```
PNG cai em entrada/  ->  wptparse lê  ->  .txt PokerStars (estilo GG bomb pot)
                                      ->  linhas no SQLite (dedupe por HAND ID)
                     ->  PNG vai pra processadas/ (ou recusadas/ com o motivo)
relatório HTML  <-  consultas no SQLite
```

Acervo inicial: **1.601 prints** em `C:\Users\danie\Downloads\Hands BombPot`
(um print = uma mão, valores em BB, Hero = `dLzinN`). Depois entram novos aos
poucos.

## 2. Decisões já tomadas (não reabrir sem motivo novo)

| Tema | Decisão | Por quê |
|---|---|---|
| Stack | **Python + SQLite local** + relatório HTML estático | Uma linguagem só, sem servidor. O MetaLens é TS/D1 e as stats dele são pré-flop e por jogador; as de bomb pot teriam de ser escritas do zero de qualquer forma. |
| Leitura | **Importar `wptparse` do `..\Poker_Replayer`** (`pip install -e` ou `sys.path`), **sem copiar** | Correção de template/nick feita lá chega aqui sozinha. Não se altera código do Replayer a partir deste projeto. |
| Imagens | Depois de lida, a imagem vai pra `processadas/`. A recusada vai pra `recusadas/` | Quando os templates do Replayer melhoram (`run.py bootstrap`), dá pra refazer a mão a partir do PNG. Apagar é decisão manual do usuário. |
| Gatilho | **Vigia a pasta por polling** (stdlib, a cada N s) + o mesmo código roda como comando único | Sem dependência nova. Prints são manuais, não precisa de evento do SO. |
| Dados do Replayer | Rodar com `POKER_REPLAYER_DADOS` apontando pra `BombPot_Tracker\dados_wpt` | Não sujar o armário/`hh/` do Poker_Replayer com 1.600 bomb pots. |

## 3. O que reaproveitar (e de onde)

**Poker_Replayer (`..\Poker_Replayer`), ler `CLAUDE.md` dele antes de tudo.**
As 5 regras de lá valem aqui também, principalmente: *erro sempre explícito,
nunca inventar número; mão errada no banco é pior que mão ausente.*

- `wptparse.hand.build(png)`: imagem -> mão canônica (`Hand`), com `issues`.
- `wptparse.hand.e_bomb_pot` / `selo_bomb_pot`: confirma que é bomb pot.
- `wptparse.lotes.gravar(...)`, `texto_da_mao`, `limite_para_export`,
  `nicks_da_mao`: geram o `.txt` e registram recusas em `recusadas.jsonl`.
- `wptparse.exportps.to_pokerstars` + `NaoExportavel`: bomb pot sai no
  formato GG (antes postados, `*** HOLE CARDS ***` direto pro `*** FLOP ***`).
- `run.py lote` / `lotes.refazer_de`: referência de como reprocessar em massa
  e de como contar recusas por motivo. São ~6 s por mão (1.601 ≈ 2,7 h na
  primeira carga), e por isso processar em paralelo (`multiprocessing`,
  como `wptparse/fila.py` faz) fica para a Fase 4, se doer.

**MetaLens_Tracker (`..\MetaLens_Tracker`): ideias, não código.**

- Dedupe: tabela `hands(site, id)` com PK; mão repetida não conta duas vezes
  (`schema.sql`).
- Contador `[oportunidades, feitos]` por stat (`src/stats.ts`), somado no
  banco. É o formato certo pra frequência de população.
- Progresso de importação idempotente (`scripts/import-local.mjs`: arquivo
  só marca "feito" depois do commit).
- `isWptGame` em `src/rows.ts` **descarta bomb pot de propósito**. Não
  mexer no MetaLens.
- Layout/nomes das telas H2N (`docs/H2N_TELAS.md`) como inspiração do
  relatório.

## 4. Estrutura alvo (mínima)

```
BombPot_Tracker/
  entrada/          <- você joga os PNGs aqui
  processadas/      <- PNG lido com sucesso
  recusadas/        <- PNG que não virou mão (+ motivo no banco)
  hh/               <- um .txt por mão (nome = HAND ID)
  bombpot.db        <- SQLite
  tracker.py        <- CLI: processar | vigiar | relatorio | refazer
  stats.py          <- cálculo das stats a partir da mão
  relatorio.html    <- gerado
  test_tracker.py   <- uma suíte pequena com mãos-gabarito
```

Poucos arquivos. Sem framework web, sem ORM, sem config pra valor que não muda.

## 5. Banco (rascunho, validar no `/plan-eng-review`)

- `hands(id PK, ts, n_jogadores, ante_bb, pote_flop_bb, board, hero_net_bb, txt_path, png_nome, lido_em)`
- `acoes(hand_id, rua, ordem, posicao_rel, jogador, verbo, valor_bb, pct_pote, allin)`: uma linha por ação, base de toda stat.
- `showdown(hand_id, jogador, cartas, net_bb, acao_que_levou)`: o que o field mostra.
- `recusas(png_nome, motivo, quando)`

**Posição relativa** é a chave em bomb pot (não há pré-flop): `1º a agir`,
`meio`, `último (IP)`, mais o número de jogadores no flop.

## 6. Stats de população (primeira versão)

Todas como `feitos / oportunidades`, cortadas por **nº de jogadores no flop**
e **posição relativa**:

1. **Flop**: % check-around; % lead do 1º a agir; % bet quando checaram até ele (por posição); tamanho da aposta em % do pote (faixas 0–25, 25–40, 40–60, 60–80, 80+, all-in).
2. **Contra aposta no flop**: fold / call / raise; % check-raise; tamanho do raise.
3. **Turn e river**: c-bet do agressor do flop; probe/stab quando o flop foi checado; fold contra aposta.
4. **Showdown**: o que aparece por linha de ação (ex.: "raise no flop" mostrou top pair? set? draw?); WTSD e W$SD da população.
5. **Textura do board** (corte extra): monotone, two-tone, rainbow, pareado, conectado.
6. **SPR do flop** (stack efetivo / pote): em bomb pot o pote já nasce grande, e isso muda tudo.
7. **Hero vs. população**: as mesmas linhas pro `dLzinN`, lado a lado. É o único corte por jogador nesta versão.

Fora desta versão: stats por oponente, HUD, gráfico de resultado. Entram
depois, se fizerem falta.

## 7. Passo a passo

### Fase 0: Planejamento (gstack)
1. Ler `..\Poker_Replayer\CLAUDE.md`, `wptparse/hand.py` (`build`, `e_bomb_pot`), `wptparse/lotes.py` (`gravar`, `refazer_de`) e `wptparse/exportps.py`.
2. Rodar `/plan-eng-review` com este arquivo como plano. Travar: esquema do banco, como chamar o `wptparse` sem o Tk, onde fica o limite (SB/BB) já que bomb pot vem com blind zerada (ver `lotes.limite_para_export`), e o que conta como "mão aceita".
3. Saída: `PLAN.md` com as fases abaixo e critérios de aceite.

### Fase 1: Leitura em lote (imagem -> .txt)
1. `tracker.py processar <pasta>`: para cada PNG, `build` -> exporta `.txt` -> move o PNG. Recusa explícita, com motivo.
2. Rodar em **20 imagens** do acervo primeiro. Conferir 5 `.txt` à mão contra o print.
3. **Aceite:** 0 mão com número inventado; toda recusa tem motivo; rodar duas vezes não duplica nada.

### Fase 2: Banco
1. Parsear o `.txt` gerado (ou direto o objeto `Hand`: decidir na Fase 0 qual é a fonte única) e gravar `hands`/`acoes`/`showdown`.
2. Dedupe por HAND ID; transação por mão.
3. **Aceite:** soma de ações por rua fecha com o pote da mão (regra 3 do Replayer); reimportar não muda contagem.

### Fase 3: Stats + relatório
1. `stats.py` com as consultas da seção 6.
2. `tracker.py relatorio` gera `relatorio.html` (tabelas + filtros simples por nº de jogadores e posição).
3. **Aceite:** 3 mãos-gabarito com stats calculadas à mão batem com o relatório (vão no `test_tracker.py`).

### Fase 4: Vigia + carga completa
1. `tracker.py vigiar`: loop de polling em `entrada/`, chamando o mesmo `processar`.
2. Um `.bat` pra abrir o vigia com dois cliques.
3. Carga das 1.601 imagens. Se passar de ~3 h, paralelizar com `multiprocessing`.
4. **Aceite:** jogar 1 PNG novo em `entrada/` e ver a mão no relatório sem fazer mais nada.

### Fase 5: Refazer
1. `tracker.py refazer`: relê `processadas/` quando os templates do Replayer mudarem e mostra quantas mãos saíram diferentes (igual `run.py lote --refazer`).

### Antes de cada fase fechar
- `/review` no diff.
- Rodar `test_tracker.py`.
- Na Fase 4: `/qa` com o fluxo real (PNG na pasta -> relatório).

## 8. Perguntas que a sessão de planejamento deve me fazer (não adivinhar)

- Fonte única pro banco: o `.txt` exportado ou o objeto `Hand` em memória?
- Mão com `issues` mas exportável: entra no banco marcada, ou fica fora?
- Mesas de stakes diferentes misturadas no mesmo relatório (tudo é BB), ou separar?
- Quais 3 mãos do acervo viram gabarito?

## 9. Regras de trabalho

- Mão errada é pior que mão ausente. Na dúvida, recusa com motivo.
- Não alterar código do Poker_Replayer daqui. Se precisar mudar algo lá, parar e perguntar.
- Fatias pequenas, cada uma testável antes da próxima.
- Nada de dependência nova sem perguntar (numpy e pillow já vêm do Replayer).

---

# Eng review (/plan-eng-review, 2026-10-21): alvo = este PROMPT.md

## Scope Challenge

- O que já resolve: leitura = `wptparse.hand.build` (provado no smoke test: 7,6 s, mão `1307617141335379968`, `bomb_pot=True`, `issues=[]`); `.txt` = `lotes.gravar`; Hero = assento 0 (`exportps.py:457`); verbo canônico = `words.canon`. Stats pós-flop: nada reaproveitável (MetaLens é TS e só pré-flop).
- Complexidade: ~5 arquivos propostos (`tracker.py`, `stats.py`, `test_tracker.py`, `.bat`, `CLAUDE.md`), 0 classes/serviços novos. Abaixo do gatilho (8 arquivos / 2 classes): parte B pulada.
- Resultado: **scope accepted as-is**.

## Achados

1. [P1] (9/10) `wptparse/__init__.py:77` `DATA = raiz_dos_dados()`: o caminho de dados é fixado no import. `POKER_REPLAYER_DADOS` tem de ser definido antes do `import wptparse`, senão tudo cai no `data/` do Replayer. Registrado no CLAUDE.md. Sem decisão pendente.
2. [P1] (9/10) `lotes.py:413` "Mao em BB ... ali o limite multiplica *todo* valor do arquivo": print em BB não tem limite, e o `.txt` sai com 0,20/0,40 presumido. Afeta só o `.txt`; o banco não depende disso se for alimentado pelo objeto `Hand`. -> R1.
3. [P2] (9/10) Smoke test: `Hand.steps` tem passos com `verb=None` (marcadores de vez, ex. `2 flop SB None`). As stats precisam filtrar `verb is None` e canonizar com `words.canon`. Sem decisão: é parte de implementar a stat certa.
4. [P2] (8/10) Com os dados redirecionados, o caderno de oponentes e os `.fix.json` do Replayer não são lidos daqui: oponentes saem `Player_<id>`/`PlayerN` no `.txt`. Não afeta stat de população. Sem decisão; anotado em NOT in scope.
5. [P2] (7/10) Mão com `issues` não vazia ainda pode exportar. O plano não diz se entra no banco. -> R2.
6. [P2] (7/10) Vigia por polling pode pegar PNG ainda sendo copiado; o PIL falha e a mão vai pra `recusadas/` por engano. -> R3.
7. [P3] (9/10) Correção de número: 7,6 s × 1.601 ≈ 3,4 h na carga inicial (não 2,7 h). `processar` é retomável (o PNG só sai de `entrada/` depois do commit), então serial é aceitável na primeira versão.
8. [P3] (8/10) Print em BB não diz o stake: separar stakes é impossível nessas mãos. Guardar `unidade` e `bb` quando existirem.

## Decision ledger

### R1: fonte única do banco
Plan baseline: seção 8, "decidir na Fase 0".
Runtime evidence: `Hand` traz valores em BB, posições, `steps`, `players[].hole/net`, `board` (smoke test).
Comparison grid: | Escolha | Atual | A | B | / | fonte do banco | pendente | objeto `Hand` em memória | reparsear o `.txt` |
Question D3: Banco alimentado pelo objeto Hand (recomendado) ou pelo .txt?
State: approved
Actual answer: A) Objeto Hand (AskUserQuestion, 2026-10-21)
Accepted scope: banco alimentado pelo objeto Hand em memória; .txt é só subproduto para o H2N

### R2: mão com issues
Plan baseline: seção 8, pergunta aberta.
Runtime evidence: `build` devolve `issues`; `to_pokerstars` só recusa por `NaoExportavel`.
Comparison grid: | Escolha | Atual | A | B | / | mão com issues | indefinido | recusada (vai pra recusadas/ com as issues) | entra marcada, filtrável |
Question D4: Mão com issues fica fora do banco (recomendado) ou entra marcada?
State: approved
Actual answer: A) Recusar (AskUserQuestion, 2026-10-21)
Accepted scope: mão com issues não vazia vai para recusadas/ com as issues como motivo; não entra no banco nem gera .txt

### R3: arquivo ainda sendo copiado
Plan baseline: Fase 4, polling sem guarda.
Runtime evidence: unknown (nada escrito ainda).
Comparison grid: | Escolha | Atual | A | B | / | guarda de cópia | nenhuma | só lê PNG com tamanho igual em 2 varreduras | sem guarda |
Question D5: Esperar o tamanho do arquivo estabilizar antes de ler (recomendado)?
State: approved
Actual answer: A) Esperar estabilizar (AskUserQuestion, 2026-10-21)
Accepted scope: vigia só lê PNG cujo tamanho foi igual em 2 varreduras seguidas; com teste

### R4: mãos com seguro/jackpot (reabre R2 com evidência nova)
Evidência: carga completa, 124 das 148 recusas eram só seguro (116) ou jackpot (8): ações certas, saldo distorcido. Seguro só existe em all-in, então recusar enviesava "raise é all-in" e showdown.
Question D6: aceitar marcadas?
State: approved
Actual answer: A) Aceitar marcadas (AskUserQuestion, 2026-10-21)
Accepted scope: mão em que TODA issue é de seguro/jackpot entra com `hands.obs`; fica fora de W$SD e SPR; qualquer outra issue continua recusando. Resultado: +117 mãos (7 tinham issue extra e seguem recusadas).

Approval readiness: PASS (R1, R2, R3: respostas de 2026-10-21)

## Seções 1-4

**1. Arquitetura**: achados 1, 2, 4 e 6 acima. Fluxo travado:

```
entrada/*.png --(tamanho estável 2x)--> build(png, usar_armario=False, gravar=False)
   |                                     |
   |                 issues? / não é bomb pot? / sem HAND ID? --> recusadas/ + tabela recusas
   |                                     |
   |                      HAND ID já no banco? --> processadas/ (duplicata, não conta)
   |                                     v
   |                 1 transação SQLite: hands + acoes + showdown  (valores em BB, do Hand)
   |                                     v
   |                 lotes.gravar(hand, raiz=hh/) -> hh/maos/<id>.txt   (subproduto)
   |                                     v
   +-----------------------------> move PNG para processadas/   (só depois do commit)
```
Falha realista: queda no meio. Commit antes de mover = PNG fica em entrada/, releitura cai no dedupe. Coberto.

**2. Qualidade de código**: achado 3 (filtrar `verb is None`, `words.canon`). Sem código compartilhado a extrair: o único código parecido (stats do MetaLens) é TS e pré-flop, contrato incompatível.

**3. Testes** (pytest, já instalado pro Replayer):

```
CODE PATHS                                        USER FLOWS
[+] tracker.processar(png)                        [+] PNG na pasta -> relatório
  ├── [GAP] bomb pot limpa -> banco + .txt          └── [GAP] [→E2E] smoke manual na Fase 4
  ├── [GAP] issues -> recusada (R2)               [+] Rodar processar 2x
  ├── [GAP] não bomb pot -> recusada                └── [GAP] contagem não muda
  ├── [GAP] HAND ID repetido -> não duplica
  └── [GAP] tamanho instável -> espera (R3)
[+] stats.py
  ├── [GAP] 3 mãos-gabarito: stats na mão batem
  └── [GAP] passo verb=None ignorado
COVERAGE: 0/9 (projeto novo) | GAPS: 9 (1 E2E manual)
```
Plano: `test_tracker.py` com uma tabela de casos sobre 3 PNGs reais copiados para `tests/` (o print `31-19 55-9 bomb.png` é o primeiro gabarito: lead UTG+1 6,5 BB, raise MP 32, shove CO 192, todos foldam).
Value: protects=nenhuma mão com issue/duplicada entra no banco; fails_when=guarda de issues ou dedupe removida; why_new=projeto novo; seam=none

**4. Performance**: achado 7. Uma leitura por PNG, um writer SQLite, consultas de stat em `acoes` com índice em `(hand_id)` e `(rua, verbo)`. Sem N+1 relevante em 1.601 mãos.

## Outside voice
Codex não instalado; o fallback nativo precisa de TaskOutput, que esta sessão não tem. Outside voice indisponível, cobertura ausente (não conta como review limpo).

## NOT in scope
- Stats por oponente / caderno de nicks (achado 4).
- Paralelizar a leitura (só se a carga inicial incomodar).
- Separar por stake (impossível em print BB, achado 8).

## Failure modes
- PNG pela metade -> guarda R3. Teste. Erro visível.
- Mão com leitura duvidosa -> R2, recusadas/ com motivo. Teste. Visível.
- Queda entre commit e mover -> dedupe. Teste. Silencioso, mas inofensivo.
- Critical gaps: 0.

## Implementation Tasks
- [x] **T1 (P1, human: ~4h / CC: ~15min)**: tracker.py `processar` + esquema SQLite + recusas (R1, R2). Verify: 20 PNGs, 5 conferidos à mão.
- [x] **T2 (P1, human: ~2h / CC: ~10min)**: test_tracker.py com 3 gabaritos. Verify: `pytest`.
- [x] **T3 (P2, human: ~1d / CC: ~30min)**: stats.py + `relatorio` HTML. Verify: gabaritos batem.
- [ ] **T4 (P2, human: ~1h / CC: ~5min)**: `vigiar` com guarda R3 + .bat. Verify: PNG novo aparece no relatório. (código e .bat prontos; falta o relatório da T3 pro Verify)

Parallelization: Sequential implementation, no parallelization opportunity.

## Completion summary
- Step 0: Scope Challenge: scope accepted as-is
- Architecture Review: 3 issues found
- Code Quality Review: 1 issues found
- Test Review: diagram produced, 9 gaps identified
- Performance Review: 1 issues found
- NOT in scope: written
- What already exists: written (Scope Challenge)
- TODOS.md updates: 0 items proposed to user
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, unavailable (não instalado)
- Parallelization: 1 lane, 0 parallel / 1 sequential
- Lake Score: 2/2 (R2, R3; R1 é escolha de tipo)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex (auto) | Independent 2nd opinion | 1 | unavailable | codex não instalado |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN | 14 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review, unavailable (CLI não instalado), sem achados.
- **VERDICT:** Eng review com achados mapeados em tarefas e todas as decisões respondidas; nenhum review CLEAR. eng review required

NO UNRESOLVED DECISIONS
