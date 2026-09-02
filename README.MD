# Catálogo de Filmes — Tom Hanks (Microsserviço Desacoplado & RBAC)

Aplicação desenvolvida para a disciplina **ISW055 - Introdução à Computação em Nuvem**, ministrada pelo professor **[@siriani](https://github.com/siriani)** ([github.com/siriani](https://github.com/siriani)).

---

## 📌 Evolução do Projeto

- **Atividade 2**: Monólito em 1 container (Catálogo, autenticação, banco e regras no mesmo processo).
- **Atividade 3**: Desacoplamento em 2 containers (`web` e `auth-service`) com comunicação em rede interna Docker, roles e recuperação de senha com tokens de 30 minutos via SMTP (Mailtrap/Brevo/Gmail).
- **Atividade 4 (Atual)**: **Controle de Acesso Baseado em Papel (*Role-Based Access Control* - RBAC)** com enforcement estrito no backend (HTTP 403).

---

## 🛡️ Atividade 4 — Controle de Acesso por Papel (RBAC de Verdade)

### 1. Matriz de Permissões por Papel (Requisito 1)

O sistema possui dois papéis bem definidos (`usuario` e `admin`). As permissões atribuídas a cada papel são:

| Recurso | Ação | Permissão Técnica | Papel `usuario` | Papel `admin` |
| :--- | :--- | :--- | :---: | :---: |
| **Catálogo** | Visualizar lista e detalhes de filmes | `catalogo:visualizar` | ✅ Permitido | ✅ Permitido |
| **Favoritos** | Adicionar ou remover filmes dos favoritos | `favoritos:gerenciar` | ✅ Permitido | ✅ Permitido |
| **Comentários** | Criar novo comentário em um filme | `comentarios:criar` | ✅ Permitido | ✅ Permitido |
| **Comentários** | Excluir o **próprio** comentário | `comentarios:apagar:proprio` | ✅ Permitido | ✅ Permitido |
| **Comentários** | Excluir comentário de **qualquer usuário** (Moderação) | `comentarios:apagar:qualquer` | ❌ **Negado (403)** | ✅ Permitido |
| **Usuários** | Listar todos os usuários do sistema | `usuarios:listar` | ❌ **Negado (403)** | ✅ Permitido |
| **Usuários** | Alterar papel (*role*) de usuários (Promover/Rebaixar) | `usuarios:alterar-role` | ❌ **Negado (403)** | ✅ Permitido |
| **Senha** | Redefinir sua própria senha por e-mail | `senha:redefinir` | ✅ Permitido | ✅ Permitido |

---

### 2. Ações Exclusivas de Administrador (Requisito 2)

Foram implementadas duas ações exclusivas para administradores:
1. **Moderação Global de Comentários (`POST /comentarios/:id/deletar`)**:
   - Um usuário comum só pode apagar comentários criados por ele mesmo (`usuario_id === req.session.usuario.id`).
   - O administrador tem o poder de moderação para apagar comentários de qualquer usuário.
2. **Painel de Gestão de Usuários e Roles (`/admin/usuarios` e `POST /admin/usuarios/:id/role`)**:
   - Acesso exclusivo para administradores visualizarem todos os usuários e promoverem/rebaixarem contas entre `usuario` e `admin`.

---

### 3. Enforcement Estrito no Backend (Requisito 3)

A segurança **não depende apenas de esconder botões na interface**. A validação é sempre executada no servidor:

```javascript
// Exemplo no Catálogo (server.js):
const isOwner = (comentario.usuario_id === req.session.usuario.id);
const isAdmin = (req.session.usuario.role === 'admin');

if (!isOwner && !isAdmin) {
  return res.status(403).render('403', {
    usuario: req.session.usuario,
    mensagem: 'Acesso Negado (HTTP 403): Você não tem permissão para excluir o comentário de outro usuário.'
  });
}
```

Se um usuário com papel `usuario` tentar forçar a chamada de uma rota administrativa via Postman, curl ou DevTools:
- Rota Web: Renderiza a tela estilizada **`403 Forbidden`** com código HTTP 403.
- Rota API no Auth-Service: Retorna JSON `{ success: false, error: 'Acesso negado (HTTP 403)...' }` com status 403.

---

### 4. Análise Arquitetural: Padrão A vs Padrão B (Requisito 5)

#### Qual padrão o projeto utiliza hoje?
O projeto utiliza o **PADRÃO A (Enforcement Centralizado)**.
- O catálogo mantém a sessão do usuário e valida o papel em tempo de execução junto aos dados do microsserviço de autenticação e banco de dados.
- **Vantagem**: Revogação e atualização de permissões **imediatas**. Se um administrador rebaixar um usuário de `admin` para `usuario` no painel, a perda de permissão passa a valer instantaneamente na próxima requisição do usuário.
- **Trade-off**: Requer verificação de estado ou comunicação entre serviços.

#### O que mudaria se o projeto migrasse para o PADRÃO B (Claims no Token JWT)?
- No momento do login, o `auth-service` geraria um token assinado (JWT) contendo as informações do usuário e suas permissões no payload (ex: `{ id, nome, email, role: 'admin' }`).
- O catálogo não precisaria de sessões no servidor nem de chamadas extras ao `auth-service` para verificar o papel: bastaria validar a assinatura criptográfica do JWT usando uma chave secreta compartilhada (`JWT_SECRET`).
- **Vantagem**: Redução de chamadas de rede e maior velocidade de resposta.
- **Trade-off**: Se o papel de um usuário for alterado no banco de dados, o usuário continuará com as permissões antigas até que o token JWT expire e seja renovado.

---

## 🏗️ Arquitetura do Sistema

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
| - SSR EJS: Login, Cadastro, Esqueci Senha, Home, Painel Admin (RBAC)    |
| - Consome API do TMDB no backend                                        |
| - Gerencia Sessões, Favoritos e Comentários (com Moderação)             |
+------------------------------------+------------------------------------+
                                     |
                                     | Rede Interna Docker (bridge: app-network)
                                     | (http://auth-service:3001)
                                     v
+------------------------------------+------------------------------------+
| CONTAINER 2: AUTH-SERVICE (Sem Porta Pública Exposta)                  |
| - Gerencia Usuários e Roles (usuario / admin)                           |
| - Gerencia Tokens de Recuperação de Senha (expiração em 30 min)        |
| - Envio de e-mails via SMTP (Mailtrap / Brevo / Gmail)                  |
+------------------+------------------------------------+-----------------+
                   |                                    |
                   v                                    v
+------------------+---------------+   +----------------+-----------------+
|          BANCO DE DADOS          |   |          SMTP EXTERNO            |
|             MariaDB              |   |  Mailtrap / Brevo / Gmail SMTP   |
| - usuarios (com role)            |   +----------------------------------+
| - reset_tokens                   |
| - favoritos & comentarios        |
+----------------------------------+
```

---

## ⚙️ Variáveis de Ambiente (`.env`)

```env
# Porta no Host
PORT=8204
PORT_HOST=8204
SESSION_SECRET=minha_chave_secreta_segura
TMDB_API_KEY=sua_chave_do_tmdb

# MariaDB
DB_HOST=35.226.64.52
DB_PORT=3306
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_NAME=seu_banco

# Configurações SMTP
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seuemail@gmail.com
SMTP_PASS=sua_senha_de_app
SMTP_FROM="Catálogo Tom Hanks <seuemail@gmail.com>"

# URL Pública
APP_URL=http://35.226.64.52:8204
```

---

## 🧪 Demonstração dos Testes (Requisito 4)

1. **Teste com Usuário Comum (`usuario`)**:
   - Cadastre e faça login com uma conta com papel `usuario`.
   - Adicione um comentário em um filme. Observe que você pode apagar o seu próprio comentário (`🗑️`).
   - Tente apagar o comentário de outro usuário (o botão não existe e chamada direta via POST resulta em **HTTP 403 Forbidden**).
   - Tente acessar `/admin/usuarios` diretamente pela URL ➔ O sistema bloqueia com **HTTP 403 Forbidden**.

2. **Teste com Administrador (`admin`)**:
   - Faça login com uma conta com papel `admin`.
   - Acesse o catálogo: você verá o botão **`🗑️ Excluir (Admin)`** em comentários de qualquer usuário e poderá excluí-los com sucesso.
   - Clique em **`🛡️ Painel Admin`** no cabeçalho: visualize a lista completa de usuários e altere papéis (*Promover a Admin* ou *Rebaixar para Usuário*).