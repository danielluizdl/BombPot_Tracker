# BombPot_Tracker

Tracker de bomb pots do WPT Global: print -> mão (via `wptparse` do
`..\Poker_Replayer`) -> SQLite -> relatório de população. Plano e decisões em
`PROMPT.md`.

## Mapa

```
tracker.py     PNG -> hands/acoes/jogadores (SQLite) + .txt; processar / vigiar / refazer / aceitar / auditar.
               Cada mao guarda versao_leitor (VERSAO-commit do Replayer, +sujo), sha256 e mtime do PNG e a pior
               distancia de template das cartas (pior_rank/pior_naipe). UNIQUE(png): um print, uma mao. Prints em
               processadas/ = ID_<hand id>.png; print de mao que ja esta no banco e apagado (nao vira mao).
               refazer NUNCA mexe no banco: rele processadas/+recusadas/ para bombpot_novo.db (+hh_novo/) e escreve
               refazer_<versao>.txt com o diff; aceitar audita, copia o banco (bombpot_antes_aceitar.db), troca as 4
               tabelas da leitura numa transacao, move os prints que mudaram de pasta e grava REPLAYER_OK.
               liberadas.deduzidas (`deduzindo`): linha que o print cortou e o pote total prova (desistencia de quem
               ficou fora, saldo de quem so pos o ante; vencedor = pote - o que pos - rake 1 BB), posta no parser
               antes do build_steps do Replayer; vira nota " a mao para " e sobrevive ao refazer.
diario.bat     agendado (tarefa "BombPot conferencia diaria", 23:30): `tracker.py diario` esvazia Downloads\Hands BombPot (move o novo;
               apaga o que ja esta guardado identico, por sha256), processa e checa -> diario/<data_hora>.json; depois `claude -p` segue
               CONFERIR_DIA.md (.txt x print com `tracker.py recortes`, divergencia -> fila_txt.json) -> diario/<data_hora>.md
nicks.py       fiscalizacao dos nicks: grupos, grafia real, ensino do caderno do Replayer (ver abaixo)
auditar.py     invariantes de todas as maos (acao ilegal, cartas repetidas, saldo x cartas, fold = -8 BB, print
               ausente, leitor nao aceito...); informativas: cartas duvidosas, hora estranha, excluidas
decisoes.py    tabela derivada `decisoes`: uma linha por decisao pos-flop, com contexto, forca,
               resposta da mesa, lucro, linhas, texturas e data; mao com erro conferido fica fora (SEM_ERRO)
               + tabela `ruas` (`ruas_da_mao`): por mao e street, a 1a bet (quem, tamanho), o 1o raise em vezes a bet, o
               re-raise em vezes o raise, quantos pagaram,
               se foi do agressor anterior e como terminou -- o filtro do Estudo
forca.py       categorias de forca do H2N + draws + weak (puro, test_forca.py)
checa_txt.py   o .txt (PokerStars) relido como um importador leria: linhas pelas regras do formato, pote, devolucao,
               all-in sem sobra e quem recolhe pelas cartas; test_banco_real exige todo hh/maos/*.txt limpo
               (28/out: 348 de 1.679 nao fechavam -> 0, com o export do Replayer corrigido)
resultados.py  tabela derivada `resultados` (aba Jogadores): net, showdown e EV all-in (equity exata) por nick;
               nick em jogadores.nome (aliases confirmados juntam nicks); mao com seguro/jackpot entra jogador a
               jogador (saldo conferido pelas cartas; jackpot a parte; quem o seguro pagou e perdeu tudo = -investido)
servidor.py    site local (127.0.0.1:8770): Estudo = `linha()` (a historia da mao sobre `ruas`: cada botao com a
               contagem das outras respostas valendo; `maos_da_linha`); painel, exportar;
               aba MDA (`mda()`); Voce x populacao (`leaks()`); aba Conferir (`conferir()`/`marcar()`, taxa de erro
               Clopper-Pearson so das sorteadas); selo (`saude()`); refaz as derivadas por PRAGMA data_version, so se a
               `impressao()` (tabelas lidas + codigo) mudou (tabela `derivadas`); aba Meus leaks = `spots(leaks())`;
               aba Conferir modo .txt (`conferir_txt`/`parecer_txt`): a fila `fila_txt.json` (fora do git) com o achado,
               o .txt de antes e o de agora; o parecer vai para `pareceres_txt` (nao entra na taxa de erro);
               Ver mãos (`maos()`: Estudo ou nó da MDA, 10 por vez, todas até 1.000) e replayer (`mao()`/`quadros()`:
               cada estado da mesa em BB, com os quirks do WPT normalizados; o pop-up mostra o print ao lado)
public/        a tela (HTML/JS puro, tema do DESIGN.md do MetaLens)
PLANO_H2N.md   pesquisa H2N/HM3, debate e prioridades (todas as 7 fatias feitas)
test_banco_real.py  refaz as contas do site direto da tabela acoes (independente) no banco real; pulado sem bombpot.db
```

Dado humano (o refazer nao recria; vai para `conferencias_bombpot.json` em `BOMBPOT_COPIA`): tabelas
`pareceres_txt`, `conferencias` (o que a leitura dizia quando o dono conferiu: mao conferida que muda trava o aceitar) e `aliases`.

Upgrade do Replayer: `python tracker.py refazer` -> ler o refazer_*.txt -> `python tracker.py aceitar`.

## Fiscalização dos nicks (responsabilidade do Claude, delegada pelo dono em 23/out)

`nicks.py`: grupos de nicks (tabela `aliases`, m -> grafia real), grafias conferidas no print (`nicks_conferidos`) e o
ensino do caderno do Replayer (`dados_wpt/jogadores.json`, via `wptparse.jogadores.Caderno`, sem mexer no código de
lá): nick confirmado com o desenho vence bitmap e OCR quando o desenho fica a <= 0,10.

**Em toda sessão neste projeto**, antes do resto:
1. `python tracker.py nicks` -> pares pendentes e uma imagem por par em `nicks_pendentes/` (topo da mesa de cada lado).
2. Olhar cada imagem (Read). Mesmo nick na tela/mesmo avatar/mesma sessão = mesmo; grafias ou avatares diferentes,
   ou duas contas no mesmo minuto em mesas diferentes = diferente. Nome cortado na mesa: ler a coluna de resultado
   do histórico em resolução cheia.
3. Decidir e aplicar (`nicks.definir_real`; "não é" = linha em `aliases` com junta 0). Só marcar `conferido=True`
   quando a grafia real for afirmável no print (traço ambíguo como 丿/ノ, 丶/、, l/I, vv/w: junta sem ensinar).
   Na dúvida, escrever o parecer em `pareceres_nicks.json` e deixar o par para o dono na aba Conferir.
4. `python tracker.py ensinar` e conferir que toda correção ficou dentro do grupo. Contar ao dono o que mudou.

Quirks do WPT:
- aposta all-in sem aposta antes vem escrita como "Raise"; `decisoes` e a linha da mao normalizam para Bet;
- valores: Bet = aposta, Raise = total na rua, Call = complemento; MAS call all-in (e "Raise" all-in por menos)
  vem com o total do jogador na rua (ID_1312645872378032128: bet 110, "Call 299 All-in" = 299 no river);
- o HAND ID e um snowflake: `id >> 22` = ms desde 2016-09-25 08:28:07,268 (hora do print, erro <= 1 s);
  o arquivo do print fica 3,0 a 3,6 h depois (fuso), menos o print de outra conta salvo dias depois;
- "Call $0.00" sem aposta na mesa e check (ID_1318375308628545536, turn e river);
- na unidade BB a tela converte e arredonda: abaixo de 100 BB ja erra 0,1 (ID_1311798473139392512: raise 13,40,
  calls 13,40, saldo -21,30) e a partir de 100 BB mostra sem decimal (ate 0,5 por valor). Em moeda e exata;
- EV do blefe e "precisa foldar" usam o RISCO da agressao (`decisoes.risco`, `ruas.raise_risco`): o que ele poe na hora /
  pote antes dele. Na bet e o tamanho; no raise inclui o call embutido (bet 10 em 100, raise para 30 = 30/110 -> precisa 21%,
  nao o "tamanho" de 20/120). O tamanho do raise (aumento / (pote + call)) so agrupa as faixas;
- -1 BB no saldo de quem GANHOU cabe no rake (ate 3,1 BB): nenhuma checagem pega; no perdedor a conta e exata.

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
