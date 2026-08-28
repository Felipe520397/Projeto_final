# Catálogo de Filmes — Tom Hanks (Microsserviço Desacoplado)

Aplicação desenvolvida para a disciplina **ISW055 - Introdução à Computação em Nuvem**, ministrada pelo professor **[@siriani](https://github.com/siriani)** ([github.com/siriani](https://github.com/siriani)).

---

## 📌 Sobre a Atividade 3 — Serviços Desacoplados

Na **Atividade 2**, o sistema rodava como um monólito em um único container (catálogo, login, cadastro, papéis de usuário, favoritos e comentários no mesmo processo).

Nesta **Atividade 3**, a aplicação foi refatorada e desacoplada em **2 microsserviços independentes**:
1. **`web` (Catálogo de Filmes)**: Único container público, responsável pelo catálogo, favoritos, comentários e integração SSR/TMDB.
2. **`auth-service` (Microsserviço de Autenticação)**: Serviço isolado, responsável por login, cadastro, papéis de usuário (*roles*) e recuperação de senha por e-mail com tokens temporários (30 minutos).

```
+-------------------------------------------------------------------------+
|                              NAVEGADOR                                  |
|                            (Usuário Final)                              |
+------------------------------------+------------------------------------+
                                     |
                       [HTTP / HTTPS]| Porta Pública (ex: :8204)
                                     v
+------------------------------------+------------------------------------+
| CONTAINER 1: CATALOG-SERVICE (Ponto de Entrada Público)                 |
| - Renderiza SSR (EJS): Login, Cadastro, Esqueci Senha, Home, Favoritos  |
| - Consome API do TMDB no backend                                        |
| - Gerencia Sessões e Favoritos/Comentários no MariaDB                   |
+------------------------------------+------------------------------------+
                                     |
                                     | Rede Interna Docker (bridge: app-network)
                                     | (http://auth-service:3001)
                                     v
+------------------------------------+------------------------------------+
| CONTAINER 2: AUTH-SERVICE (Sem Porta Pública Exposta)                  |
| - Gerencia Usuários (Login, Cadastro, Roles: usuario / admin)           |
| - Gerencia Tokens de Recuperação de Senha (tabela reset_tokens)         |
| - Validação de expiração (30 minutos) e uso único                       |
| - Integração SMTP (Mailtrap em dev / Brevo em prod)                     |
+------------------+------------------------------------+-----------------+
                   |                                    |
                   v                                    v
+------------------+---------------+   +----------------+-----------------+
|          BANCO DE DADOS          |   |          SMTP EXTERNO            |
|             MariaDB              |   |   Mailtrap (dev) / Brevo (prod)  |
| - usuarios (com role)            |   +----------------------------------+
| - reset_tokens                   |
| - favoritos & comentarios        |
+----------------------------------+
```

---

## 🔒 Segurança e Comunicação por Rede Interna

- **Isolamento de Portas**: O `auth-service` **NÃO possui portas mapeadas para o host** (`ports:` não é declarado para este serviço no `docker-compose.yml`). Ele é acessível estritamente através da rede interna do Docker (`app-network`).
- **Ponto de Entrada Único**: Apenas o container do Catálogo expõe porta para a internet (`${PORT_HOST:-8204}:3000`).
- **Segurança das Chaves**: A chave da API do TMDB e as credenciais SMTP nunca são expostas ao cliente, operando 100% no backend.
- **Senhas com Hash**: Criptografia de senhas utilizando `bcryptjs` (salt rounds = 10).

---

## 👥 Papéis de Usuário (Roles)

O sistema suporta múltiplos níveis de acesso:
- **`usuario` (padrão)**: Acesso padrão ao catálogo, favoritos e comentários.
- **`admin`**: Perfil administrativo com badge destacado no cabeçalho.

Ao realizar login ou cadastro, o `auth-service` responde com o papel do usuário, que é mantido na sessão.

---

## ✉️ Esqueci Minha Senha — Expiração Real e Envio de E-mail

O fluxo de recuperação de senha funciona da seguinte forma:

1. **Solicitação**: O usuário informa seu e-mail no formulário `/esqueci-senha`.
2. **Geração de Token Único**: O `auth-service` gera um token criptográfico aleatório de 32 bytes (64 caracteres hexadecimais).
3. **Persistência com Expiração Real**:
   - Salvo na tabela `reset_tokens`.
   - `expira_em` = `NOW() + 30 minutos`.
   - `usado` = `0` (false).
4. **Envio Real por E-mail**:
   - **Ambiente de Desenvolvimento**: Integrado ao **Mailtrap** (SMTP Sandbox).
   - **Ambiente de Produção**: Compatível com **Brevo** ou qualquer servidor SMTP transacional.
5. **Validação Rigorosa (3 critérios obrigatórios)**:
   Quando o usuário clica no link recebido (`/redefinir-senha?token=...`) e envia a nova senha:
   - ❌ **Token existe?** Se não existir, a operação é rejeitada.
   - ❌ **Não expirou?** Se a data atual ultrapassar `expira_em` (> 30 min), a troca é recusada com aviso de expiração.
   - ❌ **Não foi usado?** Se `usado == 1`, a tentativa de reutilização é bloqueada.
   - ✅ Se todos os critérios forem atendidos, a nova senha é gravada no banco e o token é marcado como `usado = 1`.

---

## 🗄️ Estrutura do Banco de Dados

### Tabela `usuarios`
```sql
CREATE TABLE usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  senha_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'usuario',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabela `reset_tokens`
```sql
CREATE TABLE reset_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(255) NOT NULL UNIQUE,
  usuario_id INT NOT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expira_em DATETIME NOT NULL,
  usado TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);
```

### Tabelas `favoritos` e `comentarios`
Mantêm a persistência e segregação multi-tenant por `usuario_id`.

---

## 🐳 Configuração do `docker-compose.yml`

```yaml
version: '3.8'

services:
  web:
    build: .
    container_name: catalogo-filmes
    ports:
      - "${PORT_HOST:-8204}:3000"
    environment:
      - PORT=3000
      - AUTH_SERVICE_URL=http://auth-service:3001
      - SESSION_SECRET=${SESSION_SECRET}
      - TMDB_API_KEY=${TMDB_API_KEY}
      - DB_HOST=${DB_HOST}
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
      - DB_NAME=${DB_NAME}
      - DB_PORT=${DB_PORT:-3306}
    depends_on:
      - auth-service
    networks:
      - app-network
    restart: always

  auth-service:
    build: ./auth-service
    container_name: auth-service
    # Sem portas publicadas pro host (isolamento de rede)
    environment:
      - PORT=3001
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
    networks:
      - app-network
    restart: always

networks:
  app-network:
    driver: bridge
```

---

## ⚙️ Variáveis de Ambiente (`.env`)

Copie o arquivo `.env.example` para `.env` e preencha com as suas configurações:

```env
# Porta no Host
PORT_HOST=8204
SESSION_SECRET=minha_chave_secreta_segura
TMDB_API_KEY=sua_chave_do_tmdb

# MariaDB
DB_HOST=mariadb_ou_ip
DB_PORT=3306
DB_USER=root
DB_PASSWORD=sua_senha
DB_NAME=filmes_db

# Mailtrap SMTP (Desenvolvimento)
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=seu_user_mailtrap
SMTP_PASS=sua_pass_mailtrap
SMTP_FROM="Catálogo Tom Hanks <no-reply@catalogofilmes.com>"

# URL Pública
APP_URL=http://localhost:8204
```

---

## 🚀 Como Executar o Projeto

1. Clone o repositório:
```bash
git clone <URL_DO_REPOSITORIO>
cd "filmes tom hanks"
```

2. Crie e configure o arquivo `.env`:
```bash
cp .env.example .env
```

3. Suba os containers com o Docker Compose:
```bash
docker compose up -d --build
```

4. Acesse a aplicação no navegador:
```
http://localhost:8204
```

---

## 🧪 Demonstração dos Testes e Validação

1. **Cadastro e Login**:
   - Cadastre uma conta como `usuario` e outra como `admin`.
   - Observe o papel atribuído exibido no badge do cabeçalho da página `/home`.
2. **Recuperação de Senha por E-mail**:
   - Clique em *"Esqueci minha senha"*.
   - Informe o e-mail cadastrado e envie.
   - Abra a caixa de entrada no **Mailtrap** e clique no botão *"Redefinir Minha Senha"*.
   - Digite a nova senha e confirme.
   - Faça login com a nova senha.
3. **Tentativa de Reutilização**:
   - Tente abrir novamente o mesmo link do e-mail ou reenviar o formulário.
   - O sistema rejeita com a mensagem: `⚠️ Este link de recuperação já foi utilizado.`
4. **Tentativa de Uso após Expiração (> 30 min)**:
   - Tokens com mais de 30 minutos desde a criação são rejeitados com a mensagem: `⚠️ Este link de recuperação expirou (ultrapassou o prazo de 30 minutos).`