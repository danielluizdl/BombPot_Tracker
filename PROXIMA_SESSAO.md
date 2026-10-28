# Próxima sessão: onde paramos (28/out/2026)

Leia antes: `CLAUDE.md` (mapa, quirks do WPT, regras), depois este arquivo. `PROMPT.md` e `PLANO_H2N.md` são o
histórico de decisões. O dono escreve em português, prefere que eu escolha o recomendado e siga, perguntando só
em bifurcação real, e quer **teste real mão a mão** (conferir no print), nunca suposição.

## Pendências (28/out) -- começar por aqui

Estado: tudo commitado e com push nos dois projetos (tracker `8063833`, Replayer `5dc1014`). Banco com 1.692 mãos,
leitor `28-5dc1014` aceito, auditoria limpa, 204 testes, os 1.679 `.txt` passam no `checa_txt`. As 42 mãos com seguro
estão resolvidas (as 19 da fila `.txt` aprovadas pelo dono na aba Conferir e movidas para `Downloads\Hands BombPot`).

1. **78 prints de bomb pot em `Downloads\Hands BombPot` ainda fora do banco.** Copiar para a entrada e processar
   (`python tracker.py processar`), depois a rotina dos nicks e a auditoria.
2. **13 mãos sem `.txt`** (1.692 mãos x 1.679 arquivos em `hh/maos`), de antes de 28/out: descobrir por que o
   `exportar` pula essas (`lotes.texto_da_mao` devolve o motivo) e se dá para gerar sem inventar número.
3. **1 recusada: ID_1319447058810109952** (caixas de ação coladas). A proposta para `wptparse/layout.py::segment` está
   na seção de 24/out abaixo; mexe no Replayer, então pedir autorização ao dono antes.
4. **Rótulo anônimo (`Player_<hash>`) não é estável entre leituras**: no refazer de 28/out o CO de
   ID_1332512999523495936 trocou de hash (mesmo print, mesmo assento). O índice `Anonimos` do Replayer
   (`wptparse/jogadores.py`) acumula exemplares conforme a ordem das mãos. Resolvido juntando os dois rótulos em
   `aliases` (sem ensinar). Se voltar a acontecer em todo refazer, propor ao dono a correção lá no Replayer.
5. **`Downloads\Hands BombPot\Seguro` só tem 3 notas de texto** (LEIA-ME, CONFERENCIA, PENDENTES_2026-10-28), todas
   resolvidas. Perguntar ao dono se pode apagar a pasta.
6. Backup das conferências: depois desta sessão há 19 pareceres `.txt` novos; subir um CSV novo para a pasta do
   Google Drive (ver seção de 23/out), já que `BOMBPOT_COPIA` não está definido nesta máquina.

## Sessão de 23/out: estrutura + confiança dos dados (relatório da mesa gstack: claude.ai/artifact/5aw7XWs6HyzUpYZo1Ek7JN)

Feito (181 testes; nada commitado ainda, o dono decide):
- `.gitignore` cobre `*.db`, `*.db-*`, `refazer_*.txt`, `hh_novo/`, `conferencias_bombpot.json` (repo público).
- `hands`: `versao_leitor`, `sha256`, `mtime`, `pior_rank`; `UNIQUE(png)`; registrar grava o nome FINAL do print.
- `refazer` em banco novo + diff (`refazer_<versao>.txt`) + `aceitar` (audita, copia, troca numa transação).
  Rodado de verdade: 1.538 iguais, 29 mudaram (texto de seguro, 2 nicks anônimos, 4 potes de Fold/Insurance),
  **9 recuperadas** (as "replay soma": call all-in que o Replayer bdf0a4c já lê) e aceito. `REPLAYER_OK` = 28-bdf0a4c.
  As 9 eram derrotas do dLzinN (−245,5 BB): recusar enviesava o Net para cima. Net hoje +5.242,3 BB em 1.573 mãos.
- `auditar.py` + `python tracker.py auditar` (roda no fim do processar e antes do aceitar): banco real limpo.
  Achou 2 quirks novos do WPT (no CLAUDE.md): "Call $0.00" = check; tela em BB erra 0,1 abaixo de 100 BB.
- Site: `PRAGMA data_version` (o refazer/nomes não deixam mais o site velho), uma requisição por vez;
  aba **Conferir** (sorteio mede a taxa, Clopper-Pearson; suspeitas = 15 mãos com número de carta > 0,12);
  selo no topo; **Você × população** no Painel (stat de cartas compara só showdown); Jogadores com filtro de
  mesa/data, BB/100 ± IC e sugestões de nick partido (50; ex. 1/I trocados) com confirmação.
- Descartado com evidência: mexer na tolerância do Replayer (só 2 das 9 "arredondamento" eram arredondamento, e
  as 9 já voltaram pela correção de ontem); medir o naipe pela releitura (trocava ♠ preto por ♣ em 36 mãos certas).

Conferência do dono (23/out, leitor 28-bdf0a4c): **102 sorteadas + 15 suspeitas, 0 erros** -> taxa de erro da
leitura < 2,9% (95%, Clopper-Pearson). Sorteadas por unidade: BB 38, CNY 32, USD 32; só 3 com seguro/jackpot
(esse estrato ainda não tem taxa própria). Erro achado vira teste e a conta recomeça; leitor novo invalida a taxa.

Backup das conferências: Google Drive do dono, pasta privada "BombPot Tracker - backup das conferências"
(`conferencias_bombpot_2026-10-23.csv`: hand_id, veredito, modo, leitor). Esta máquina não tem o Google Drive
sincronizado, então a cópia automática (`conferencias_bombpot.json`) fica ao lado do banco: depois de conferir
mais mãos, subir um CSV novo para essa pasta (ou instalar o Google Drive para desktop e apontar `BOMBPOT_COPIA`).

Nicks (23/out): o dono bateu 52/52 pareceres do Claude e delegou a fiscalização (rotina no CLAUDE.md). 36 grupos
com grafia real; 31 conferidas ensinaram o caderno do Replayer (dados_wpt/jogadores.json, 31 nicks) e corrigiram 91
assentos, todos dentro do grupo. Sem ensinar: 5 grupos com traço ambíguo (丶/、, 丿/ノ, l/I, vv/w, nome cortado).
Próximo passo possível: o mesmo tipo de erro (I/1, l/I, 0/o) em jogador NOVO só some ensinando o dicionário de
caracteres do Replayer -- isso é código/dados de lá: perguntar ao dono antes.

## Sessão de 24/out: recusadas, cartas coloridas e replayer

- 14 recusadas, cada uma com gabarito lido no print x leitura do OCR: **12 entraram** (1.588 mãos), auditoria limpa.
  - 6 tinham uma faixa preta embaixo, fora do export; o Replayer acusava "export cortado". `tracker.sem_faixa_preta`
    pinta só as linhas 100% pretas com a cor do painel antes do `build(img=...)` (PNG intacto; nenhuma das 1.576 aceitas
    tinha faixa).
  - 6 com leitura certa e conferência do Replayer errando (side pot ganho por quem fica negativo; call all-in depois do
    próprio raise vem com o total; stack com prêmio de seguro descontado; all-in por menos no pote). Entraram pela tabela
    `liberadas` (sha256 -> queixas exatas; queixa nova recusa de novo); nota em `hands.notas`.
  - Faltam 2: ID_1319444335783862272 (carta não lida: no print é Q♠ **10♦**; corrigir com
    `dados_wpt/labels/ID_1319444335783862272.fix.json` = {"carta.cima-esquerda[1]": "10d"} depois do sim do dono) e
    ID_1319447058810109952 (caixas de ação coladas: o OCR perde UTG bet 12, UTG+1 call 12, HJ call 12; o .fix.json não
    acrescenta linha: só entra mexendo no Replayer, com autorização).
- Cartas com fundo da cor do naipe; replayer com fichas e valor, pote e botão D.
- Perguntas ao dono no celular: claude.ai/artifact/9ux5jGPZbXvxQ95yirXEJu (db, coleção `respostas`, docs carta /
  colada / novos / liberadas). Sem resposta: segui as opções recomendadas e a página diz isso. **Ler com ArtifactData
  `list`**: se ele discordar de alguma, desfazer.
- Feito em seguida (24/out, madrugada): **1.692 mãos**, auditoria limpa, 193 testes.
  - 10♦ aplicado pelo .fix.json (a mão entrou com a nota "corrigida a mao para 10d").
  - 103 prints de Downloads\Hands BombPot copiados (com a data do arquivo) e processados: 101 ok, 1 repetido, 1 recusado
    (ID_1333370720691216384, seguro: stack do HJ com o prêmio de 0,48 descontado), conferido no print e liberado.
  - Subpastas do Downloads: `Seguro` tinha 1 mão nunca processada (ID_1308590669215768576, conferida e incluída) e 1 que
    não é bomb pot; `Capturas incompletas` (2) sem HAND ID; `NaoBombPot` (20) fora por definição.
  - Nicks: 4 pares novos, todos o mesmo jogador; 2 conferidos e ensinados, 2 juntos sem ensinar (nome cortado na mesa;
    l/I). Ensino corrigiu 5 nomes; as 95 mãos com nome diferente do .txt original ficaram dentro do grupo.
  - `conferencias_bombpot.json` regravado só local (BOMBPOT_COPIA não está definido nesta máquina); o drive tem o CSV de
    23/out.
- **Caixas coladas (ID_1319447058810109952), proposta para o Replayer** (pedir autorização antes): em
  `wptparse/layout.py::segment`, as caixas saem de `_content_runs`, que só separa onde há linha vazia. No flop dessa mão
  as faixas medem 366 e 239 px (3 e 2 caixas; `ROW_H_SIMPLE` = 110). Correção: faixa com altura > ~1,6×ROW_H_SIMPLE é
  cortada nos vales de `mask.sum(axis=1)` (os cantos arredondados afinam a emenda), cada pedaço com altura >= min_h;
  teste com este print e regressão no lote inteiro (refazer deve dar diff só nesta mão).

## O projeto em uma frase

Prints de bomb pot do WPT Global -> `wptparse` (do `..\Poker_Replayer`) -> SQLite (`bombpot.db`, fora do git) ->
site local de estudo da população (`python servidor.py`, 127.0.0.1:8770; ou `Abrir site.bat`).
Acervo hoje: 1.576 mãos (quase todas do dono, nick **dLzinN**), 2.030 nicks.

## O que existe no site (abas)

- **Estudo**: filtros livres estilo H2N sobre a tabela `decisoes` (uma linha por decisão pós-flop), relatório por
  grupo, Resposta ao sizing com EV do blefe, gráfico, Fold por sizing, Força/Draws, mesa de 8 lugares.
  Faixas de tamanho do Estudo: B5 0,01–0,05 · B10 0,06–0,15 · B25 · B40 · B50 0,46–0,66 · B75 · B100 · B110 ·
  B135 · B175 · B200+ (pedido do dono; não trocar).
- **Painel de tendências**: stats prontas.
- **MDA** (árvore de ações estilo perfil do H2N):
  - 3 boxes Flop/Turn/River, **começam minimizados**; cada um é uma lista de linhas "X - B  30%  (13)"
    (freq = a ação dada a situação; situações com < 10 decisões recolhidas em "mais linhas").
  - Clicar numa linha abre **embaixo dos boxes** a tabela: bet sizes (Bet/Raise) com Freq, Todos foldam,
    Precisa foldar, EV blefe, 1/2/3+ calls, Aumentado, o que ele fez depois do raise e "afunilar"; ou, para quem
    enfrenta bet, F/C/R por tamanho enfrentado e precisa foldar.
  - Faixas da MDA = **as do H2N**: B10 0–0,20 · B30 · B50 0,41–0,60 · B70 · B100 0,81–1,05 · B120 · B150 · B210 ·
    B280 · B400+ (do maior para o menor, como no H2N). Rótulos não se repetem com os do Estudo: `where()` escolhe o
    CASE pelo rótulo.
  - Botão **"All-in separado"** (sempre começa em "não"): não = bet all-in soma na faixa do tamanho; sim = linhas -AI.
  - **Procurar linha**: digita "bb"/"B - B", os boxes filtram e aparecem sugestões; clicar/Enter abre a linha.
  - Numa linha do turn/river, seletor **"bet dele no flop" / "bet que ele pagou no flop"** = filtro por tamanho
    da rua anterior (vira `caminho`, com × na barra).
- **Jogadores**: lista por nº de mãos (Net, BB/100, EV BB/100) e o gráfico do MetaLens: Net (verde), Com
  showdown (azul), Sem showdown (vermelho), EV all-in (amarelo, equity exata enumerando os boards) e
  **Net + jackpot** (roxo, só para quem ganhou jackpot).

## Arquivos e tabelas que esta sessão criou/mudou

- `resultados.py` (novo): tabela derivada `resultados` (hand_id, nome, pos, hero, net, sd, ev, jackpot);
  avaliador de 7 cartas e equity (portados do `src/graph.ts` do MetaLens); `investido()`, `potes()`, `poker()`
  (resultado pelas cartas), `bate_com_o_poker()`, `sem_jackpot()`; `jogadores()` e `serie()` para a API.
  `resultados.FORA` = o que ficou fora (hoje: 1 saldo de seguro, `seguro_reconstruido` = 3).
- `jogadores.nome` (coluna nova): nick gravado na leitura com `lotes.nicks_da_mao` (mesma fonte do .txt).
  `python tracker.py nomes` preenche mãos antigas (pelo .txt pelo assento+1; sem .txt, relê o print só p/ nicks).
- `servidor.py`: rotas `/api/mda`, `/api/jogadores`, `/api/serie`; `FAIXAS_H2N`/`CASE_H2N`; `atualizar()` refaz
  `decisoes` e `resultados` quando entram mãos novas (~5 s na primeira carga; o `consultar()` do app espera).
- `decisoes.py`: colunas `linha_atual`, `n_calls`, `prox_acao` (MDA) e o quirk do call all-in.
- Testes: `test_resultados.py` (novo), `test_banco_real.py` (recontagem independente da árvore da MDA nas 3 ruas
  × 9 posições, com EV/bet média), `test_decisoes.py`. Suíte: **142 passando** (`python -m pytest -q`).

## Regras de dados descobertas (valem para qualquer conta nova)

- **Call all-in vem com o TOTAL do jogador na rua**, não o complemento (call normal = complemento; Raise = total;
  "Raise" all-in por menos = call). Prova: ID_1312645872378032128 (bet 110, "Call 299 All-in", saldo −388).
- Fold com a mesa em check existe no WPT (24 casos): na MDA aparece como "F (sem bet)".
- O "resíduo"/rake do WPT: 0 a 3,1% do pote (máx. 3 BB) nas mãos limpas; o Replayer mede ~1 BB fixo.
  O stack inicial deduzido (`final − saldo`) do **vencedor** já traz esse resíduo.
- O WPT arredonda o saldo exibido em BB (até 0,5).
- **Seguro**: quem compra e ganha -> saldo da tela já é poker. Quem compra e perde (seguro pagou) -> o retorno
  entra no saldo; o resultado de poker é −investido se ele perdeu todos os potes (provado pelas cartas +
  conservação). Se ele levou parte do pote (side pot), fica fora (depende do resíduo).
- **Jackpot**: o saldo da tela inclui o prêmio da casa; a leitura grava "X do ganho vieram do jackpot (saldo de
  poker: Y)" em `hands.obs`; o Net usa só o poker, o jackpot vai para `resultados.jackpot`.
- Mão com seguro/jackpot entra **jogador a jogador**: só quem tem o saldo batendo com o poker pelas cartas.
  Resultado: o dLzinN aparece em todas as 1.564 mãos em que está na mesa (as outras 3 são prints de outras contas).
- Números do dLzinN hoje: Net +5.487,8 BB · EV +5.403 · Net+jackpot +5.607,8 (em 1.564 mãos).

## Poker_Replayer (outro repo, commit bdf0a4c)

Com autorização do dono, nesta sessão: `_saldo_real_do_seguro` decide pelas cartas quem perdeu tudo
(`_perdeu_tudo_pelas_cartas`, parâmetro `foldados`); `_amount_paid` usa o valor exibido no call all-in quando ele
é menor que o stack deduzido; `armario.VERSAO` 27 -> 28. Portão: `run.py baseline` com o Python do
`Review_Game\venv` (o do PATH não tem pytest) -> 9 falhas, exatamente as conhecidas. A regra do CLAUDE.md
continua: **mexer no Replayer daqui só perguntando antes.**

## Armadilhas desta máquina

- Python por heredoc no Bash transforma `\n`/`\r` dentro de string em caractere real: escreva scripts com Write.
- Console cp1252: use `PYTHONIOENCODING=utf-8` para imprimir nick CJK.
- O site precisa ser reiniciado para pegar mudança no Python (o JS não: `Cache-Control: no-store`).
- Teste visual: Playwright em 127.0.0.1:8770; espere o carregamento (~5 s) antes de clicar numa aba.
- Dados (bombpot.db, processadas/, recusadas/, hh/, dados_wpt/, entrada/) ficam fora do git: o repo é PÚBLICO.

## Ideias que ficaram no ar (não pedidas ainda)

- Incluir o UTG do side pot com seguro (ID_1317681494711513088) com erro de ~1 BB, se o dono aceitar.
- Na MDA, esconder "afunilar" numa faixa formada só por bets all-in (com o all-in junto ela leva a um turn vazio).
- Filtros da aba Jogadores (por nº de jogadores na mesa, por data) e stats por jogador.
