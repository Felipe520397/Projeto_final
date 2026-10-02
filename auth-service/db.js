const mysql = require('mysql2/promise');
require('dotenv').config();

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

async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    console.log('[Auth-Service DB] Conectado ao banco de dados com sucesso.');

    // 1. Criação da tabela de usuários se não existir
    await connection.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'usuario',
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. Garantir que a coluna 'role' exista caso a tabela já tenha sido criada anteriormente
    try {
      const [columns] = await connection.query(`
        SHOW COLUMNS FROM usuarios LIKE 'role';
      `);
      if (columns.length === 0) {
        await connection.query(`
          ALTER TABLE usuarios ADD COLUMN role VARCHAR(50) NOT NULL DEFAULT 'usuario';
        `);
        console.log('[Auth-Service DB] Coluna "role" adicionada à tabela "usuarios".');
      }
    } catch (colErr) {
      console.warn('[Auth-Service DB] Aviso ao verificar coluna role:', colErr.message);
    }

    // 3. Criação da tabela reset_tokens para recuperação de senha
    await connection.query(`
      CREATE TABLE IF NOT EXISTS reset_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        token VARCHAR(255) NOT NULL UNIQUE,
        usuario_id INT NOT NULL,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expira_em DATETIME NOT NULL,
        usado TINYINT(1) NOT NULL DEFAULT 0,
        INDEX idx_token (token),
        INDEX idx_usuario (usuario_id),
        CONSTRAINT fk_reset_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('[Auth-Service DB] Tabelas "usuarios" e "reset_tokens" inicializadas.');
    connection.release();
  } catch (error) {
    console.error('[Auth-Service DB] Erro ao inicializar banco de dados:', error.message);
  }
}

module.exports = { pool, initDatabase };

