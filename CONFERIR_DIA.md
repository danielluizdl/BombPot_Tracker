# Conferência diária (roda sozinha, agendada; `diario.bat`)

Você é o Claude rodando sem ninguém olhando. O dono não vai responder nada nesta sessão: decida pelas regras do
`CLAUDE.md` e deixe para ele, por escrito, só o que for dúvida de verdade. **Não** faça commit, push, `refazer`,
`aceitar`, nem mexa em código (aqui ou no `..\Poker_Replayer`), no banco à mão ou em `.txt`. Mão errada é pior que mão
ausente: o seu trabalho aqui é achar divergência, não corrigir.

## 1. O que entrou hoje

O `diario.bat` já rodou `python tracker.py diario` (copiou os prints novos de `Downloads\Hands BombPot` para
`entrada/`, processou, checou). Leia `diario/<hoje AAAA-MM-DD>.json`:
`novas` (hand ids que entraram), `recusadas` ([png, motivo]), `checa_txt` (problemas no .txt de mão nova),
`auditoria` (violações no banco inteiro), `nicks_pendentes`.

Se não houver arquivo de hoje, o passo do Python falhou: escreva isso no relatório (veja `diario/ultima_execucao.log`)
e pare.

## 2. Nicks

Se `nicks_pendentes` > 0, faça a rotina de nicks do `CLAUDE.md` (passos 1 a 4): `python tracker.py nicks`, olhar cada
imagem de `nicks_pendentes/`, decidir pelas regras de lá (na dúvida, parecer em `pareceres_nicks.json` e deixar o par),
`python tracker.py ensinar`. Para aplicar `nicks.definir_real`, grave um script com a ferramenta Write em `diario/` e
rode com `python`.

## 3. Cada mão nova: o .txt contra o print

Para cada hand id de `novas`:

1. `python tracker.py recortes <id>`: o print em pedaços em `diario/recortes/`. Leia todos (Read). O pedaço 0 tem a
   mesa (stacks finais, cartas, board, pote); os outros, o histórico por rua (ação e valor de cada jogador) e a coluna
   de resultado (+/− de cada um).
2. Leia `hh/maos/<id>.txt` e confira, valor a valor:
   - cabeçalho: print em BB (botão "BB" aceso, valores "N BB") = `($0.10/$0.20 USD)`, 1 BB = $0,20, ante 8 BB = $1,60;
     print em moeda = os valores da tela;
   - assentos: cada nick (rótulo `Player_<id>` é o anônimo de nick cortado, normal), e
     stack do .txt = stack final da mesa − resultado da coluna (o que ele tinha antes da mão);
   - cartas do herói, cartas mostradas, board de cada rua;
   - cada ação, na ordem e com o valor (Bet = aposta; Raise = total na rua; Call = complemento);
   - pote e quem levou (`collected`).
3. Diferenças que NÃO são divergência (quirks do WPT, no `CLAUDE.md`): rake do vencedor até 3,1 BB; stack de quem foi
   all-in ajustado pelo export (perdedor: o que pôs; vencedor: sem o resíduo do rake); na tela em BB, erro de 0,1
   abaixo de 100 BB e até 0,5 a partir de 100 BB; "Raise" all-in sem bet antes = bet; call all-in com o total na rua;
   "Call $0.00" sem aposta = check.
4. Divergência de verdade (ou mão com problema em `checa_txt`): acrescente em `fila_txt.json` (lista JSON; crie se não
   existir; não apague o que já está lá) `{"hand_id": "<id>", "achados": ["<o que o print mostra x o que o .txt diz,
   com rua, jogador e valores>"], "txt_antes": "<o .txt inteiro como está agora>"}`. A mão aparece para o dono na aba
   Conferir, modo .txt. Na dúvida se é divergência: entra na fila, com a dúvida escrita.

Muitas mãos (mais de 60): confira todas as que tiverem achado em `checa_txt`, todas em BB e um sorteio das outras até
60; escreva no relatório quantas ficaram sem olhar.

## 4. Recusadas

Para cada uma de `recusadas`: abra o print em `recusadas/` e diga em uma linha se o motivo bate com o que se vê
(print cortado, não é bomb pot, valor ilegível...). Não crie `.fix.json`: se der para recuperar, escreva a proposta
(campo e valor lido no print) no relatório para o dono decidir.

## 5. Relatório

Escreva `diario/<hoje>.md`, em português, curto, para o dono:
- quantas mãos entraram, repetidas, recusadas (com o motivo e o seu parecer de cada recusada);
- quantas você conferiu contra o print e o resultado: "N conferidas, 0 divergências" ou a lista do que foi para a fila;
- auditoria (`auditoria` vazia = limpa) e nicks (o que decidiu, o que ficou para ele);
- qualquer coisa que travou.
