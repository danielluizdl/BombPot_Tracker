@echo off
rem Rodada diaria (Agendador de Tarefas, "BombPot conferencia diaria"): processa os prints novos e o Claude
rem confere cada .txt contra o print (CONFERIR_DIA.md). Relatorio em diario\<data>.md.
cd /d "%~dp0"
if not exist diario mkdir diario
set PYTHONIOENCODING=utf-8
"%USERPROFILE%\Documents\Projetos\Review_Game\venv\Scripts\python.exe" tracker.py diario > diario\ultima_execucao.log 2>&1
call "%APPDATA%\npm\claude.cmd" -p "Leia CONFERIR_DIA.md e faca a conferencia diaria de hoje, do comeco ao fim." ^
  --allowedTools Read Write Edit Glob Grep "Bash(python:*)" ^
  --disallowedTools "Bash(git:*)" "Bash(rm:*)" ^
  >> diario\ultima_execucao.log 2>&1
