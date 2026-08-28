const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Configuração de Sessão
app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo_padrao_catalogo_filmes',
  resave: false,
  saveUninitialized: false
}));

// URL do Microsserviço de Autenticação (Comunicação via Rede Interna Docker)
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';

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

// Inicialização das tabelas do catálogo (favoritos e comentários)
async function initCatalogDb() {
  try {
    const conn = await pool.getConnection();
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

    await conn.query(`
      CREATE TABLE IF NOT EXISTS comentarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        filme_id INT NOT NULL,
        texto TEXT NOT NULL,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    conn.release();
    console.log('[Catalog DB] Tabelas "favoritos" e "comentarios" prontas.');
  } catch (err) {
    console.warn('[Catalog DB] Aviso ao inicializar tabelas do catálogo:', err.message);
  }
}
initCatalogDb();

// Middleware de verificação de autenticação
function checkAuth(req, res, next) {
  if (req.session.usuario) {
    next();
  } else {
    res.redirect('/login');
  }
}

// ==========================================
// ROTAS DO CATÁLOGO E AUTENTICAÇÃO
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
    // Comunicação com o Microsserviço de Autenticação
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/login`, { email, senha });

    if (response.data && response.data.success) {
      req.session.usuario = response.data.user; // Armazena { id, nome, email, role }
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
    // Comunicação com o Microsserviço de Autenticação
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/register`, { nome, email, senha, role });

    if (response.data && response.data.success) {
      req.session.usuario = response.data.user; // Armazena { id, nome, email, role }
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
    // Valida o token no microsserviço (checa existência, validade < 30min e uso único)
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
    // 1. Busca favoritos do usuário logado
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

    // 2. Busca comentários do usuário logado
    const commMap = {};
    try {
      const [comentarios] = await pool.query(
        'SELECT filme_id, texto FROM comentarios WHERE usuario_id = ?',
        [req.session.usuario.id]
      );
      comentarios.forEach(c => {
        if (!commMap[c.filme_id]) {
          commMap[c.filme_id] = [];
        }
        commMap[c.filme_id].push(c.texto);
      });
    } catch (dbErr) {
      console.log('Aviso comentarios:', dbErr.message);
    }

    // 3. Busca filmes do TMDB no backend (sem expor chave ao cliente)
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
        'INSERT INTO comentarios (usuario_id, filme_id, texto) VALUES (?, ?, ?)',
        [req.session.usuario.id, filme_id, texto]
      );
    }
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao comentar:', error);
    res.redirect('/home');
  }
});

// LOGOUT
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`>>> [CATÁLOGO] SERVIDOR RODANDO EM http://localhost:${PORT} <<<`);
  console.log(`>>> [CATÁLOGO] Microsserviço de Auth conectado em: ${AUTH_SERVICE_URL} <<<`);
});