# Catálogo de Filmes — Tom Hanks (Microsserviços, RBAC & Logs de Auditoria com Redis)

Aplicação desenvolvida para a disciplina **ISW055 - Introdução à Computação em Nuvem**, ministrada pelo professor **[@siriani](https://github.com/siriani)** ([github.com/siriani](https://github.com/siriani)).

---

## 📌 Linha do Tempo e Evolução do Projeto

- **Atividade 2 (Monólito)**: 1 container único com catálogo, login, banco e regras no mesmo deploy.
- **Atividade 3 (Serviços Desacoplados)**: Separação em 2 containers (`web` e `auth-service`) com rede interna Docker, roles e recuperação de senha por e-mail com tokens de 30 min via SMTP.
- **Atividade 4 (Autorização RBAC)**: Controle de acesso baseado em papéis com validação estrita no servidor (HTTP 403) e moderação de comentários por administradores.
- **Atividade 5 (Logs e Auditoria com Redis Streams - Atual)**: Centralização de logs de auditoria em um novo microsserviço (`log-service`) com persistência em **Redis Streams** (`XADD` e `XREVRANGE`), rastreando quem fez o quê, quando e de qual IP.

---

## 🏗️ Arquitetura do Sistema (4 Containers)

```
+-------------------------------------------------------------------------+
|                              NAVEGADOR                                  |
|                   (Usuário Comum ou Administrador)                      |
+------------------------------------+------------------------------------+
                                     |
                       [HTTP / HTTPS]| Porta Pública (ex: :8204)
                                     v
+------------------------------------+------------------------------------+
| CONTAINER 1: CATALOG-SERVICE (Ponto de Entrada Público)                 |
| - SSR EJS: Catálogo, Favoritos, Comentários, Painéis Admin              |
| - Dispara logs de eventos para o log-service via HTTP interno          |
| - Rota /admin/logs protegida por RBAC (requireAdmin)                    |
+-------------------+--------------------------------+--------------------+
                    |                                |
   [HTTP Interno]   |                                | [HTTP Interno]
 (http://auth:3001) |                                | (http://log-service:3002)
                    v                                v
+-------------------+---------------+   +------------+--------------------+
| CONTAINER 2: AUTH-SERVICE         |   | CONTAINER 3: LOG-SERVICE           |
| - Login, Cadastro, Roles, Senha   |   | - Endpoints: POST /logs, GET /logs |
| - Dispara logs de eventos         |-->| - Comunica com Redis via Streams   |
+-------------------+---------------+   +------------+--------------------+
                    |                                |
                    v                                v
+-------------------+---------------+   +------------+--------------------+
|     BANCO RELACIONAL: MariaDB     |   |    BANCO DE EVENTOS: REDIS         |
| - usuarios, reset_tokens, etc.    |   | - Redis Streams (audit_stream)     |
+-----------------------------------+   +---------------------------------+
```

---

## 📜 Logs e Auditoria — Por que Redis Streams?

### Por que um microsserviço próprio?
Misturar logs de auditoria no banco relacional da aplicação (MariaDB) acopla responsabilidades que mudam por motivos distintos. Logs de auditoria possuem um padrão de uso com **altíssimo volume de escrita, baixa necessidade de transações ACID complexas e leitura quase exclusiva para consulta/auditoria**. Desacoplar em um serviço próprio (`log-service`) garante que a escrita de logs não onere as tabelas relacionais do sistema.

### Por que Redis Streams?
O Redis é extremamente rápido para escrita em memória com persistência AOF (`--appendonly yes`). O recurso **Redis Streams** foi desenhado especificamente para logs e fluxos de eventos ordenados no tempo:
- **`XADD audit_stream MAXLEN ~ 5000 * ...`**: Grava os eventos no stream gerando automaticamente IDs baseados em timestamp milissegundo, mantendo uma fila limitada em memória.
- **`XREVRANGE audit_stream + - COUNT <limite>`**: Permite ao painel administrativo consultar instantaneamente os eventos mais recentes em ordem cronológica decrescente.

---

## 📋 Eventos Auditados no Sistema

Cada registro de log armazena a estrutura:
`usuario_id`, `usuario_nome`, `usuario_email`, `acao`, `detalhes`, `ip`, `timestamp` e `servico_origem`.

| Evento / Ação | Origem | Descrição |
| :--- | :---: | :--- |
| `CADASTRO_USUARIO` | `auth-service` | Registro de uma nova conta de usuário. |
| `LOGIN_SUCESSO` | `auth-service` | Autenticação bem-sucedida no sistema. |
| `LOGIN_FALHA_SENHA_INCORRETA` | `auth-service` | Tentativa de login com senha incorreta. |
| `LOGIN_FALHA_USUARIO_NAO_ENCONTRADO` | `auth-service` | Tentativa de login com e-mail não existente. |
| `LOGOUT` | `catalogo` | Encerramento voluntário de sessão. |
| `FAVORITAR_FILME` | `catalogo` | Adição de um filme à lista de favoritos. |
| `DESFAVORITAR_FILME` | `catalogo` | Remoção de um filme dos favoritos. |
| `CRIAR_COMENTARIO` | `catalogo` | Publicação de comentário em um filme. |
| `EXCLUIR_COMENTARIO_PROPRIO` | `catalogo` | Autor apagando o próprio comentário. |
| `MODERAR_COMENTARIO_ADMIN` | `catalogo` | Administrador apagando comentário de outro usuário. |
| `ALTERAR_ROLE_SUCESSO` | `auth-service` | Promoção ou rebaixamento de papel de usuário por admin. |
| `ACESSO_NEGADO_403_ADMIN_ROUTE` | `catalogo` | **Tentativa bloqueada (403)**: usuário comum tentando acessar rotas administrativas (`/admin/usuarios`, `/admin/logs`). |
| `ACESSO_NEGADO_403_MODERACAO` | `catalogo` | **Tentativa bloqueada (403)**: usuário comum tentando apagar comentário de outro usuário. |
| `ACESSO_NEGADO_403_ALTERAR_ROLE` | `auth-service` | **Tentativa bloqueada (403)**: chamada não autorizada para alterar papel de usuário. |
| `SOLICITAR_RECUPERACAO_SENHA` | `auth-service` | Geração de token de 30 minutos e envio de e-mail. |
| `REDEFINIR_SENHA_SUCESSO` | `auth-service` | Atualização de senha concluída via token. |

---

## 🔒 Segurança e Isolamento de Rede

- **Apenas o Catálogo (`web`) publica porta para o host**: `${PORT_HOST:-8204}:3000`.
- Os serviços **`auth-service`**, **`log-service`** e **`redis`** **NÃO possuem portas expostas** no `docker-compose.yml`, ficando completamente invisíveis para a internet pública e acessíveis somente através da rede interna compartilhada `app-network` com subnet dedicada `10.82.4.0/24`.
- A consulta aos logs de auditoria (`/admin/logs`) é restrita a Administradores através do middleware RBAC `requireAdmin`. Qualquer usuário comum que tente acessar a rota recebe **HTTP 403 Forbidden** e a tentativa é registrada no log de auditoria.

---

## 🐳 Configuração do `docker-compose.yml`

```yaml
version: '3.8'

services:
  web:
    build: .
    ports:
      - "${PORT_HOST:-${PORT:-8204}}:3000"
    environment:
      - PORT=3000
      - AUTH_SERVICE_URL=http://auth-service:3001
      - LOG_SERVICE_URL=http://log-service:3002
      - SESSION_SECRET=${SESSION_SECRET}
      - TMDB_API_KEY=${TMDB_API_KEY}
      - DB_HOST=${DB_HOST}
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
      - DB_NAME=${DB_NAME}
      - DB_PORT=${DB_PORT:-3306}
    depends_on:
      - auth-service
      - log-service
    networks:
      - app-network
    restart: always

  auth-service:
    build: ./auth-service
    environment:
      - PORT=3001
      - LOG_SERVICE_URL=http://log-service:3002
      - DB_HOST=${DB_HOST}
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
      - DB_NAME=${DB_NAME}
      - DB_PORT=${DB_PORT:-3306}
      - SMTP_HOST=${SMTP_HOST:-sandbox.smtp.mailtrap.io}
      - SMTP_PORT=${SMTP_PORT:-2525}
      - SMTP_USER=${SMTP_USER}
      - SMTP_PASS=${SMTP_PASS}
      - SMTP_FROM=${SMTP_FROM:-"Catálogo Tom Hanks <no-reply@catalogofilmes.com>"}
      - APP_URL=${APP_URL:-http://localhost:8204}
    depends_on:
      - log-service
    networks:
      - app-network
    restart: always

  log-service:
    build: ./log-service
    environment:
      - PORT=3002
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_STREAM_KEY=audit_stream
    depends_on:
      - redis
    networks:
      - app-network
    restart: always

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    networks:
      - app-network
    restart: always

networks:
  app-network:
    driver: bridge
    ipam:
      config:
        - subnet: 10.82.4.0/24
```

---

## 🧪 Demonstração dos Testes de Auditoria

1. **Geração de Eventos com Usuário Comum**:
   - Faça login com um usuário comum.
   - Favorite um filme e adicione um comentário.
   - Tente acessar `/admin/logs` diretamente na barra de endereços do navegador ➔ O acesso será recusado com a tela **`403 Forbidden`**.
2. **Consulta e Auditoria com Administrador**:
   - Faça logout e entre com uma conta `admin`.
   - Clique no botão **`📜 Logs`** no cabeçalho ou acesse `/admin/logs`.
   - Visualize a tabela com todos os eventos registrados em tempo real:
     - O login do usuário comum;
     - O filme favoritado e o comentário criado;
     - O evento de segurança **`ACESSO_NEGADO_403_ADMIN_ROUTE`** com o IP do cliente e a rota tentada!