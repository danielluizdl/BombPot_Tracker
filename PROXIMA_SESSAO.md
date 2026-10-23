# Próxima sessão: onde paramos (22/out/2026)

Leia antes: `CLAUDE.md` (mapa, quirks do WPT, regras), depois este arquivo. `PROMPT.md` e `PLANO_H2N.md` são o
histórico de decisões. O dono escreve em português, prefere que eu escolha o recomendado e siga, perguntando só
em bifurcação real, e quer **teste real mão a mão** (conferir no print), nunca suposição.

## O projeto em uma frase

Prints de bomb pot do WPT Global -> `wptparse` (do `..\Poker_Replayer`) -> SQLite (`bombpot.db`, fora do git) ->
site local de estudo da população (`python servidor.py`, 127.0.0.1:8770; ou `Abrir site.bat`).
Acervo hoje: 1.567 mãos (quase todas do dono, nick **dLzinN**), 1.951 jogadores com nick.

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
