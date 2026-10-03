# Catálogo de Filmes — Tom Hanks (Microsserviços, RBAC, Redis Streams & MinIO Object Storage)

Aplicação desenvolvida para a disciplina **ISW055 - Introdução à Computação em Nuvem**, ministrada pelo professor **[@siriani](https://github.com/siriani)** ([github.com/siriani](https://github.com/siriani)).

---

## 📌 Linha do Tempo e Evolução do Projeto

- **Atividade 2 (Monólito)**: 1 container único com catálogo, login, banco e regras no mesmo deploy.
- **Atividade 3 (Serviços Desacoplados)**: Separação em 2 containers (`web` e `auth-service`) com rede interna Docker, roles e recuperação de senha por e-mail com tokens de 30 min via SMTP.
- **Atividade 4 (Autorização RBAC)**: Controle de acesso baseado em papéis com validação estrita no servidor (HTTP 403) e moderação de comentários por administradores.
- **Atividade 5 (Logs e Auditoria com Redis Streams)**: Centralização de logs de auditoria em microsserviço dedicado (`log-service`) com persistência em **Redis Streams** (`XADD` e `XREVRANGE`), rastreando quem fez o quê, quando e de qual IP.
- **Atividade 6 (Upload e Perfil de Usuário com MinIO - Atual)**: O catálogo vira uma rede social com perfis públicos (`/perfil/:id`), edição de bio e upload de fotos para Object Storage (**MinIO**), armazenando apenas a referência/chave no **MariaDB** e aplicando isolamento estrito de edição (cada um só edita seu próprio perfil).

---

## 🏗️ Arquitetura do Sistema (5 Containers)

```
+---------------------------------------------------------------------------------+
|                                    NAVEGADOR                                    |
|              (Upload de Foto, Visualização de Perfis, Favoritos, Catálogo)      |
+----------------------------------------+----------------------------------------+
                                         |
                           [HTTP / HTTPS]| Porta Pública (ex: :8204)
                                         v
+----------------------------------------+----------------------------------------+
| CONTAINER 1: CATALOG-SERVICE (Ponto de Entrada Público)                         |
| - SSR EJS: /perfil, /perfil/:id, /home, /admin                                  |
| - Rota POST /perfil/editar com upload de imagem via Multer                      |
| - Envia arquivo binário para MinIO e salva referência no banco                 |
| - Enforcement RBAC: Cada usuário só edita seu próprio perfil                    |
| - Registra logs de auditoria no log-service                                    |
+------------+--------------------+---------------------+-------------------------+
             |                    |                     |
   [HTTP]    |          [HTTP]    |           [S3 API]  |
(auth:3001)  |     (log-service)  |       (minio:9000)  |
             v                    v                     v
+------------+--------+  +--------+------------+  +-----+-------------------------+
| CONTAINER 2:        |  | CONTAINER 3:        |  | CONTAINER 5:                  |
| AUTH-SERVICE        |  | LOG-SERVICE         |  | MINIO OBJECT STORAGE          |
| - Login, Cadastro   |  | - Registro eventos  |  | - Bucket: perfil-fotos        |
| - Reset de Senha    |  | - Redis Streams     |  | - Armazena imagens binárias   |
+------------+--------+  +--------+------------+  +-------------------------------+
             |                    |
             v                    v
+------------+--------+  +--------+------------+
| CONTAINER MariaDB   |  | CONTAINER 4: REDIS  |
| - Colunas: bio,     |  | - audit_stream      |
|   foto_url/key      |  |   (Eventos reais)   |
+---------------------+  +---------------------+
```

---

## 📦 MinIO Object Storage — Por que não guardar imagem no Banco?

### 1. Por que o arquivo não fica no MariaDB?
Guardar arquivos binários em colunas do tipo `BLOB` em bancos relacionais degrada o desempenho:
- Bancos relacionais são otimizados para dados tabulares pequenos, indexação rápida e transações ACID.
- Arquivos binários inflacionam o tamanho das páginas de dados do InnoDB, tornando backups lentos, consumindo memória de cache de forma ineficiente e encarecendo a escala horizontal.
- A arquitetura moderna utiliza **Object Storage (S3 / MinIO)** para guardar os binários, e armazena **apenas a chave/URL da foto (`foto_url`)** no MariaDB.

### 2. Decisão Arquitetural: Bucket com Leitura Pública vs URL Pré-Assinada
- **Nossa Escolha**: **Bucket com Política de Leitura Pública / Proxy via Catálogo (`/uploads/perfil/:key`)**.
- **Justificativa do Trade-off**:
  - Em uma rede social/catálogo público, as fotos de perfil são públicas por natureza e acessadas frequentemente por todos os usuários na listagem de comentários e na página de perfil.
  - O uso de bucket público com rota de proxy otimiza o cache HTTP (`Cache-Control: public`), reduz o overhead computacional de gerar assinaturas criptográficas temporárias para cada requisição e garante disponibilidade contínua sem risco de links expirados.
  - URLs pré-assinadas seriam mais adequadas para documentos confidenciais ou relatórios privados que demandam expiração temporária estrita.

---

## 🛡️ Controle de Acesso e Segurança (Requisito 4)

- **Cada usuário só edita seu próprio perfil**: No endpoint `POST /perfil/editar`, o backend valida a identidade diretamente na sessão do usuário (`req.session.usuario.id`), desconsiderando qualquer ID adulterado no corpo da requisição.
- Se um usuário malicioso tentar forçar a edição do perfil de outra pessoa, o sistema rejeita imediatamente com **HTTP 403 Forbidden** e dispara o evento `ACESSO_NEGADO_403_EDITAR_PERFIL_ALHEIO` para o `log-service`.

---

## 📋 Lista de Eventos de Auditoria

| Evento | Origem | Descrição |
| :--- | :---: | :--- |
| `UPLOAD_FOTO_PERFIL` | `catalogo` | Upload de nova imagem para o MinIO Object Storage. |
| `ATUALIZAR_PERFIL` | `catalogo` | Atualização de biografia e nome do usuário. |
| `ACESSO_NEGADO_403_EDITAR_PERFIL_ALHEIO` | `catalogo` | **Segurança (403)**: Tentativa de editar perfil de outro usuário. |
| `LOGIN_SUCESSO` / `LOGIN_FALHA` | `auth-service` | Eventos de autenticação com dados de IP. |
| `CADASTRO_USUARIO` | `auth-service` | Criação de novas contas. |
| `FAVORITAR_FILME` / `DESFAVORITAR_FILME` | `catalogo` | Ações no catálogo. |
| `CRIAR_COMENTARIO` / `MODERAR_COMENTARIO_ADMIN` | `catalogo` | Comentários e moderação administrativa. |
| `ACESSO_NEGADO_403_ADMIN_ROUTE` | `catalogo` | Tentativa bloqueada de acessar rotas de admin. |

---

## 🐳 Configuração do `docker-compose.yml` (5 Containers)

```yaml
version: '3.8'

services:
  web:
    build: .
    ports:
      - "${PORT_HOST:-${PORT:-8204}}:3000"
    environment:
      - PORT=3000
      - INTERNAL_PORT=3000
      - AUTH_SERVICE_URL=http://auth-service:3001
      - LOG_SERVICE_URL=http://log-service:3002
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - MINIO_ACCESS_KEY=${MINIO_ROOT_USER:-minioadmin}
      - MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD:-minioadmin}
      - MINIO_BUCKET=perfil-fotos
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
      - minio
    networks:
      - app-network
    restart: always

  auth-service:
    build: ./auth-service
    environment:
      - PORT=3001
      - INTERNAL_PORT=3001
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
      - INTERNAL_PORT=3002
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

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=${MINIO_ROOT_USER:-minioadmin}
      - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-minioadmin}
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

## 🧪 Roteiro de Demonstração e Testes

1. **Acessar o Perfil e Fazer Upload**:
   - Faça login no site.
   - Clique em **`👤 Perfil`** no menu superior.
   - Digite uma biografia e selecione uma foto de perfil (JPG/PNG).
   - Clique em **`Salvar Alterações`** ➔ A imagem é salva no MinIO e exibida no avatar em tempo real!
2. **Visualizar Perfil Público e Favoritos**:
   - Acesse `/perfil/:id` para ver o perfil público de outro usuário com seus filmes favoritos.
3. **Testar Proteção RBAC**:
   - Tente enviar um formulário de edição forçando o ID de outro usuário ➔ O servidor recusa com **HTTP 403 Forbidden**.
4. **Verificar os Logs de Auditoria**:
   - Acesse `/admin/logs` com usuário admin e veja os eventos `UPLOAD_FOTO_PERFIL` e `ATUALIZAR_PERFIL` registrados com sucesso!