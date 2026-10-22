# BombPot_Tracker

Tracker de bomb pots do WPT Global: print -> mão (via `wptparse` do
`..\Poker_Replayer`) -> SQLite -> relatório de população. Plano e decisões em
`PROMPT.md`.

## Mapa

```
tracker.py     PNG -> hands/acoes/jogadores (SQLite) + .txt; processar / vigiar / refazer
decisoes.py    tabela derivada `decisoes`: uma linha por decisao pos-flop, com contexto, forca,
               resposta da mesa, lucro, linhas, texturas e data
forca.py       categorias de forca do H2N + draws + weak (puro, test_forca.py)
resultados.py  tabela derivada `resultados` (aba Jogadores): net, showdown e EV all-in (equity exata) por nick;
               nick em jogadores.nome; mao com seguro/jackpot entra jogador a jogador (saldo conferido pelas
               cartas; jackpot a parte; quem o seguro pagou e perdeu tudo = -investido, regra do Replayer)
servidor.py    site local (127.0.0.1:8770): filtros -> WHERE em `decisoes`; painel, agrupar, exportar;
               aba MDA (`mda()`): arvore de acoes por rua, bet sizes com -AI, afunilar flop -> turn -> river
public/        a tela (HTML/JS puro, tema do DESIGN.md do MetaLens)
PLANO_H2N.md   pesquisa H2N/HM3, debate e prioridades (todas as 7 fatias feitas)
test_banco_real.py  refaz as contas do site direto da tabela acoes (independente) no banco real; pulado sem bombpot.db
```

Quirks do WPT:
- aposta all-in sem aposta antes vem escrita como "Raise"; `decisoes` e a linha da mao normalizam para Bet;
- valores: Bet = aposta, Raise = total na rua, Call = complemento; MAS call all-in (e "Raise" all-in por menos)
  vem com o total do jogador na rua (ID_1312645872378032128: bet 110, "Call 299 All-in" = 299 no river);
- o HAND ID e um snowflake: `id >> 22` = ms desde 2016-09-25 08:28:07,268 (hora do print, erro <= 1 s).

Ao escrever Python por heredoc no Bash desta maquina, `\\r`/`\\n` dentro de string viraram caracteres de
verdade: gravar scripts com a ferramenta Write.

## Regras

- Mão errada é pior que mão ausente. Na dúvida, recusa com motivo; nunca inventar número.
- Não alterar código do `..\Poker_Replayer` daqui. Precisou mudar algo lá: parar e perguntar.
- `POKER_REPLAYER_DADOS` tem de estar definido **antes** do `import wptparse` (o caminho é fixado no import, `wptparse/__init__.py:77`).
- Nada de dependência nova sem perguntar.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
