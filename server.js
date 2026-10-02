const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const { initMinioBucket, uploadProfilePhoto, getProfilePhotoStream } = require('./minioClient');

const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Configuração do Multer (Upload em Memória, máx 5MB, somente imagens)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 Megabytes
  },
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (tiposPermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato de arquivo inválido. Apenas imagens (JPEG, PNG, WEBP, GIF) são permitidas.'));
    }
  }
});

// Configuração de Sessão
app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo_padrao_catalogo_filmes',
  resave: false,
  saveUninitialized: false
}));

// URLs dos Microsserviços Internos (Comunicação via Rede Interna Docker)
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
const LOG_SERVICE_URL = process.env.LOG_SERVICE_URL || 'http://log-service:3002';

/**
 * Função Auxiliar: Dispara logs de auditoria para o microsserviço log-service
 */
async function sendAuditLog(req, acao, detalhes = {}) {
  try {
    const user = req.session?.usuario || {};
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    await axios.post(`${LOG_SERVICE_URL}/logs`, {
      usuario_id: user.id || 'anonimo',
      usuario_nome: user.nome || 'Anônimo',
      usuario_email: user.email || '',
      acao,
      detalhes,
      ip: clientIp,
      timestamp: new Date().toISOString(),
      servico_origem: 'catalogo'
    }, { timeout: 2000 });
  } catch (err) {
    console.warn('[Audit Log Warning] Falha ao enviar evento para log-service:', err.message);
  }
}

// Pool de conexão para Favoritos e Comentários do Catálogo
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'filmes_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Inicialização das tabelas do catálogo (favoritos, comentários e migrações de perfil)
async function initCatalogDb() {
  try {
    const conn = await pool.getConnection();
    
    // Tabela de favoritos
    await conn.query(`
      CREATE TABLE IF NOT EXISTS favoritos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        filme_id INT NOT NULL,
        titulo VARCHAR(255),
        poster_path VARCHAR(255),
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_usuario_filme (usuario_id, filme_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de comentários
    await conn.query(`
      CREATE TABLE IF NOT EXISTS comentarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        usuario_nome VARCHAR(255),
        filme_id INT NOT NULL,
        texto TEXT NOT NULL,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Garante que as colunas usuario_nome, bio e foto_url existam
    try {
      const [colsNome] = await conn.query("SHOW COLUMNS FROM comentarios LIKE 'usuario_nome'");
      if (colsNome.length === 0) {
        await conn.query("ALTER TABLE comentarios ADD COLUMN usuario_nome VARCHAR(255) DEFAULT 'Usuário'");
      }

      const [colsBio] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'bio'");
      if (colsBio.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN bio TEXT DEFAULT ''");
      }

      const [colsFoto] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'foto_url'");
      if (colsFoto.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN foto_url VARCHAR(500) DEFAULT ''");
      }
    } catch (colErr) {
      console.warn('[Catalog DB] Aviso ao verificar colunas:', colErr.message);
    }

    conn.release();
    console.log('[Catalog DB] Tabelas do catálogo inicializadas com sucesso.');
  } catch (err) {
    console.warn('[Catalog DB] Aviso ao inicializar banco de dados:', err.message);
  }
}
initCatalogDb();
initMinioBucket();

// Middleware de Autenticação (Quem é você?)
function checkAuth(req, res, next) {
  if (req.session.usuario) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Middleware de Autorização RBAC (O que você pode fazer?)
function requireAdmin(req, res, next) {
  if (!req.session.usuario) {
    return res.redirect('/login');
  }
  
  if (req.session.usuario.role !== 'admin') {
    sendAuditLog(req, 'ACESSO_NEGADO_403_ADMIN_ROUTE', {
      rota_tentada: req.originalUrl,
      papel_usuario: req.session.usuario.role
    });

    return res.status(403).render('403', {
      usuario: req.session.usuario,
      mensagem: 'Acesso Negado (HTTP 403): Esta ação ou página é restrita a Administradores do sistema.'
    });
  }

  next();
}

// ==========================================
// ROTA PÚBLICA DE PROXY DE FOTOS DO MINIO
// ==========================================
app.get('/uploads/perfil/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const stream = await getProfilePhotoStream(key);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.pipe(res);
  } catch (err) {
    res.status(404).send('Foto de perfil não encontrada no Object Storage.');
  }
});

// ==========================================
// ROTAS DE AUTENTICAÇÃO E CATÁLOGO
// ==========================================

app.get('/', (req, res) => {
  if (req.session.usuario) {
    res.redirect('/home');
  } else {
    res.redirect('/login');
  }
});

// LOGIN
app.get('/login', (req, res) => {
  res.render('login', { erro: null, sucesso: null });
});

app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/login`, { email, senha });

    if (response.data && response.data.success) {
      req.session.usuario = response.data.user;
      return res.redirect('/home');
    }

    res.render('login', { erro: 'Credenciais inválidas.', sucesso: null });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao conectar ao serviço de autenticação.';
    res.render('login', { erro: msgErro, sucesso: null });
  }
});

// CADASTRO
app.get('/cadastro', (req, res) => {
  res.render('cadastro', { erro: null });
});

app.post('/cadastro', async (req, res) => {
  const { nome, email, senha, role } = req.body;
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/register`, { nome, email, senha, role });

    if (response.data && response.data.success) {
      req.session.usuario = response.data.user;
      return res.redirect('/home');
    }

    res.render('cadastro', { erro: 'Não foi possível realizar o cadastro.' });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao conectar ao serviço de autenticação.';
    res.render('cadastro', { erro: msgErro });
  }
});

// ESQUECI MINHA SENHA
app.get('/esqueci-senha', (req, res) => {
  res.render('esqueci-senha', { erro: null, sucesso: null });
});

app.post('/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  const appUrl = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/forgot-password`, { email, appUrl });
    res.render('esqueci-senha', { erro: null, sucesso: response.data.message });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao processar solicitação de recuperação de senha.';
    res.render('esqueci-senha', { erro: msgErro, sucesso: null });
  }
});

// REDEFINIR SENHA
app.get('/redefinir-senha', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.render('redefinir-senha', {
      valid: false,
      erro: 'Token de recuperação não fornecido.',
      token: ''
    });
  }

  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/auth/validate-token/${token}`);

    res.render('redefinir-senha', {
      valid: true,
      erro: null,
      token,
      email: response.data.email,
      nome: response.data.nome
    });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Link de recuperação inválido ou expirado.';
    res.render('redefinir-senha', {
      valid: false,
      erro: msgErro,
      token: ''
    });
  }
});

app.post('/redefinir-senha', async (req, res) => {
  const { token, novaSenha, confirmarSenha } = req.body;

  if (novaSenha !== confirmarSenha) {
    return res.render('redefinir-senha', {
      valid: true,
      erro: 'As senhas digitadas não coincidem.',
      token
    });
  }

  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/reset-password`, {
      token,
      novaSenha
    });

    res.render('login', {
      erro: null,
      sucesso: response.data.message || 'Senha redefinida com sucesso! Acesse sua conta com a nova senha.'
    });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao redefinir senha.';
    res.render('redefinir-senha', {
      valid: false,
      erro: msgErro,
      token
    });
  }
});

// HOME (CATÁLOGO DE FILMES)
app.get('/home', checkAuth, async (req, res) => {
  try {
    let favoritos = [];
    try {
      const [rows] = await pool.query(
        'SELECT filme_id FROM favoritos WHERE usuario_id = ?',
        [req.session.usuario.id]
      );
      favoritos = rows;
    } catch (dbErr) {
      console.log('Aviso favoritos:', dbErr.message);
    }
    const favMap = new Set(favoritos.map(f => f.filme_id));

    const commMap = {};
    try {
      const [comentarios] = await pool.query(
        'SELECT id, usuario_id, usuario_nome, filme_id, texto, criado_em FROM comentarios ORDER BY criado_em ASC'
      );
      comentarios.forEach(c => {
        if (!commMap[c.filme_id]) {
          commMap[c.filme_id] = [];
        }
        commMap[c.filme_id].push({
          id: c.id,
          usuario_id: c.usuario_id,
          usuario_nome: c.usuario_nome || 'Usuário',
          texto: c.texto,
          criado_em: c.criado_em
        });
      });
    } catch (dbErr) {
      console.log('Aviso comentarios:', dbErr.message);
    }

    let filmes = [];
    if (process.env.TMDB_API_KEY) {
      try {
        const response = await axios.get(`https://api.themoviedb.org/3/person/31/movie_credits`, {
          params: { 
            api_key: process.env.TMDB_API_KEY, 
            language: 'pt-BR' 
          }
        });
        const rawFilmes = response.data.cast || [];
        filmes = rawFilmes.map(f => ({
          id: f.id,
          title: f.title || f.name || 'Título Indisponível',
          poster_path: f.poster_path ? `https://image.tmdb.org/t/p/w500${f.poster_path}` : null,
          overview: f.overview || ''
        }));
      } catch (tmdbErr) {
        console.error('Erro ao buscar TMDB:', tmdbErr.message);
      }
    }

    res.render('index', { usuario: req.session.usuario, filmes, favMap, commMap });
  } catch (error) {
    console.error('Erro na Home:', error.message);
    res.render('index', { usuario: req.session.usuario, filmes: [], favMap: new Set(), commMap: {} });
  }
});

// Adicionar Favorito
app.post('/favoritar', checkAuth, async (req, res) => {
  const { filme_id, titulo, poster_path } = req.body;
  try {
    await pool.query(
      'INSERT IGNORE INTO favoritos (usuario_id, filme_id, titulo, poster_path) VALUES (?, ?, ?, ?)',
      [req.session.usuario.id, filme_id, titulo, poster_path]
    );

    sendAuditLog(req, 'FAVORITAR_FILME', { filme_id, titulo });
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao favoritar:', error);
    res.redirect('/home');
  }
});

// Remover Favorito
app.post('/desfavoritar', checkAuth, async (req, res) => {
  const { filme_id } = req.body;
  try {
    await pool.query(
      'DELETE FROM favoritos WHERE usuario_id = ? AND filme_id = ?',
      [req.session.usuario.id, filme_id]
    );

    sendAuditLog(req, 'DESFAVORITAR_FILME', { filme_id });
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao desfavoritar:', error);
    res.redirect('/home');
  }
});

// Adicionar Comentário
app.post('/comentar', checkAuth, async (req, res) => {
  const { filme_id, texto } = req.body;
  try {
    if (texto && texto.trim() !== '') {
      await pool.query(
        'INSERT INTO comentarios (usuario_id, usuario_nome, filme_id, texto) VALUES (?, ?, ?, ?)',
        [req.session.usuario.id, req.session.usuario.nome, filme_id, texto.trim()]
      );

      sendAuditLog(req, 'CRIAR_COMENTARIO', {
        filme_id,
        texto_resumo: texto.trim().substring(0, 40)
      });
    }
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao comentar:', error);
    res.redirect('/home');
  }
});

// Excluir Comentário (RBAC)
app.post('/comentarios/:id/deletar', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT * FROM comentarios WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.redirect('/home');
    }

    const comentario = rows[0];
    const isOwner = (comentario.usuario_id === req.session.usuario.id);
    const isAdmin = (req.session.usuario.role === 'admin');

    if (!isOwner && !isAdmin) {
      sendAuditLog(req, 'ACESSO_NEGADO_403_MODERACAO', {
        comentario_id: id,
        autor_comentario_id: comentario.usuario_id,
        autor_comentario_nome: comentario.usuario_nome
      });

      return res.status(403).render('403', {
        usuario: req.session.usuario,
        mensagem: 'Acesso Negado (HTTP 403): Você não tem permissão para excluir o comentário de outro usuário.'
      });
    }

    await pool.query('DELETE FROM comentarios WHERE id = ?', [id]);

    if (isAdmin && !isOwner) {
      sendAuditLog(req, 'MODERAR_COMENTARIO_ADMIN', {
        comentario_id: id,
        autor_original: comentario.usuario_nome,
        filme_id: comentario.filme_id,
        texto_resumo: comentario.texto.substring(0, 30)
      });
    } else {
      sendAuditLog(req, 'EXCLUIR_COMENTARIO_PROPRIO', {
        comentario_id: id,
        filme_id: comentario.filme_id
      });
    }

    res.redirect(req.headers.referer || '/home');
  } catch (error) {
    console.error('Erro ao deletar comentário:', error);
    res.redirect('/home');
  }
});

// ==========================================
// ROTAS DE PERFIL E UPLOAD MINIO (ATIVIDADE 6)
// ==========================================

// Visualizar Próprio Perfil
app.get('/perfil', checkAuth, async (req, res) => {
  try {
    const [userRows] = await pool.query(
      'SELECT id, nome, email, role, bio, foto_url, criado_em FROM usuarios WHERE id = ?',
      [req.session.usuario.id]
    );

    if (userRows.length === 0) {
      return res.redirect('/login');
    }

    const perfilUsuario = userRows[0];

    const [favoritos] = await pool.query(
      'SELECT filme_id, titulo, poster_path, criado_em FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC',
      [req.session.usuario.id]
    );

    res.render('perfil', {
      usuario: req.session.usuario,
      perfilUsuario,
      favoritos,
      isOwner: true,
      sucesso: req.query.sucesso || null,
      erro: req.query.erro || null
    });
  } catch (error) {
    console.error('Erro ao carregar perfil:', error);
    res.redirect('/home');
  }
});

// Visualizar Perfil Público de Outro Usuário
app.get('/perfil/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const [userRows] = await pool.query(
      'SELECT id, nome, email, role, bio, foto_url, criado_em FROM usuarios WHERE id = ?',
      [id]
    );

    if (userRows.length === 0) {
      return res.status(404).send('Usuário não encontrado.');
    }

    const perfilUsuario = userRows[0];
    const isOwner = (req.session.usuario.id == id);

    const [favoritos] = await pool.query(
      'SELECT filme_id, titulo, poster_path, criado_em FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC',
      [id]
    );

    res.render('perfil', {
      usuario: req.session.usuario,
      perfilUsuario,
      favoritos,
      isOwner,
      sucesso: req.query.sucesso || null,
      erro: req.query.erro || null
    });
  } catch (error) {
    console.error('Erro ao carregar perfil público:', error);
    res.redirect('/home');
  }
});

// Editar Perfil com Upload de Imagem para MinIO (Requisito 4: Proteção RBAC)
app.post('/perfil/editar', checkAuth, (req, res, next) => {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      return res.redirect(`/perfil?erro=${encodeURIComponent(err.message)}`);
    }
    next();
  });
}, async (req, res) => {
  const loggedUserId = req.session.usuario.id;
  const { nome, bio, usuario_id } = req.body;

  // Enforcement de RBAC: Um usuário NUNCA pode editar perfil de outro
  if (usuario_id && String(usuario_id) !== String(loggedUserId)) {
    sendAuditLog(req, 'ACESSO_NEGADO_403_EDITAR_PERFIL_ALHEIO', {
      usuario_alvo_id: usuario_id,
      usuario_tentativa_id: loggedUserId
    });

    return res.status(403).render('403', {
      usuario: req.session.usuario,
      mensagem: 'Acesso Negado (HTTP 403): Você não tem permissão para editar o perfil de outro usuário.'
    });
  }

  try {
    let fotoUrlFinal = null;

    // Se houver upload de arquivo, envia para o MinIO Object Storage
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.png';
      const fileName = `avatar-${loggedUserId}-${Date.now()}${ext}`;

      // Upload do binário para o MinIO
      await uploadProfilePhoto(fileName, req.file.buffer, req.file.mimetype);
      
      // Chave / URL da imagem que será salva como referência no banco
      fotoUrlFinal = `/uploads/perfil/${fileName}`;

      sendAuditLog(req, 'UPLOAD_FOTO_PERFIL', {
        arquivo: fileName,
        tamanho_bytes: req.file.size,
        mimetype: req.file.mimetype,
        storage: 'MinIO'
      });
    }

    const nomeFinal = (nome && nome.trim() !== '') ? nome.trim() : req.session.usuario.nome;
    const bioFinal = bio !== undefined ? bio.trim() : '';

    if (fotoUrlFinal) {
      await pool.query(
        'UPDATE usuarios SET nome = ?, bio = ?, foto_url = ? WHERE id = ?',
        [nomeFinal, bioFinal, fotoUrlFinal, loggedUserId]
      );
      req.session.usuario.foto_url = fotoUrlFinal;
    } else {
      await pool.query(
        'UPDATE usuarios SET nome = ?, bio = ? WHERE id = ?',
        [nomeFinal, bioFinal, loggedUserId]
      );
    }

    req.session.usuario.nome = nomeFinal;

    sendAuditLog(req, 'ATUALIZAR_PERFIL', {
      nome: nomeFinal,
      bio_atualizada: bioFinal !== '',
      foto_atualizada: Boolean(fotoUrlFinal)
    });

    res.redirect('/perfil?sucesso=Perfil atualizado com sucesso!');
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.redirect(`/perfil?erro=${encodeURIComponent('Erro ao salvar alterações no perfil.')}`);
  }
});

// ==========================================
// ROTAS ADMINISTRATIVAS (EXCLUSIVAS PARA ADMIN)
// ==========================================

app.get('/admin', requireAdmin, (req, res) => res.redirect('/admin/usuarios'));

app.get('/admin/usuarios', requireAdmin, async (req, res) => {
  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/auth/users`);
    const usuarios = response.data.users || [];

    let todosComentarios = [];
    try {
      const [rows] = await pool.query(
        'SELECT id, usuario_id, usuario_nome, filme_id, texto, criado_em FROM comentarios ORDER BY criado_em DESC'
      );
      todosComentarios = rows;
    } catch (cErr) {
      console.warn('[Admin] Aviso ao buscar comentários:', cErr.message);
    }

    res.render('admin-usuarios', {
      usuario: req.session.usuario,
      usuarios,
      comentarios: todosComentarios,
      sucesso: req.query.sucesso || null,
      erro: req.query.erro || null
    });
  } catch (error) {
    console.error('Erro ao carregar painel de usuários:', error.message);
    res.render('admin-usuarios', {
      usuario: req.session.usuario,
      usuarios: [],
      comentarios: [],
      sucesso: null,
      erro: 'Não foi possível carregar os dados do serviço de autenticação.'
    });
  }
});

// Alterar Papel de Usuário
app.post('/admin/usuarios/:id/role', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/users/${id}/role`, {
      role,
      requesterRole: req.session.usuario.role
    });

    res.redirect(`/admin/usuarios?sucesso=${encodeURIComponent(response.data.message || 'Papel alterado com sucesso!')}`);
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao alterar papel do usuário.';
    res.redirect(`/admin/usuarios?erro=${encodeURIComponent(msgErro)}`);
  }
});

// Painel de Logs de Auditoria (Redis Streams)
app.get('/admin/logs', requireAdmin, async (req, res) => {
  try {
    const response = await axios.get(`${LOG_SERVICE_URL}/logs`, {
      params: {
        limit: 100,
        acao: req.query.acao || undefined
      }
    });

    res.render('admin-logs', {
      usuario: req.session.usuario,
      logs: response.data.logs || [],
      filtroAcao: req.query.acao || ''
    });
  } catch (error) {
    console.error('Erro ao consultar logs do log-service:', error.message);
    res.render('admin-logs', {
      usuario: req.session.usuario,
      logs: [],
      filtroAcao: req.query.acao || ''
    });
  }
});

// LOGOUT
app.get('/logout', (req, res) => {
  if (req.session.usuario) {
    sendAuditLog(req, 'LOGOUT', { email: req.session.usuario.email });
  }
  req.session.destroy();
  res.redirect('/login');
});

const PORT = process.env.INTERNAL_PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`>>> [CATÁLOGO] SERVIDOR RODANDO INTERNAMENTE NA PORTA ${PORT} <<<`);
  console.log(`>>> [CATÁLOGO] Microsserviço de Auth conectado em: ${AUTH_SERVICE_URL} <<<`);
  console.log(`>>> [CATÁLOGO] Microsserviço de Logs conectado em: ${LOG_SERVICE_URL} <<<`);
});